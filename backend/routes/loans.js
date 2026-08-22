// backend/routes/loans.js — prestamos: CRUD + abono, reestructurar, cierre y cambio de dia.
//
// Extraido de `server.js` en la Etapa 2 (A5) del refactor. Codigo VERBATIM
// (unica sustitucion: `app.X` -> `router.X`). Es el router mas grande y el que
// concentra las reglas financieras mas delicadas de la app.
//
// LO QUE NO SE TOCA, POR MUY REPETIDO QUE PAREZCA:
//
// 1. Hay 6 copias identicas de `originalCOP` y 4 variantes de `saldoReal` que son
//    DELIBERADAMENTE DISTINTAS entre si. Unificarlas reabre los Bugs #21, #35 y
//    #36. En concreto:
//      - /recalculate y PUT /loans restan Pagadas Y Mora (Bug #21: la mora es
//        deuda independiente ya amortizada aparte, simetrico con regularConsumed);
//      - /abono es modalidad-aware via `esSingleCuota`, porque en Prestamo y Pago
//        Unico el `abonoCapital` de una fila En Mora es el SALDO VIVO, no capital
//        pagado (Bug #28);
//      - y convive con `capitalPendienteLiq`, que NO resta la mora, porque al
//        liquidar esas cuotas se pagan (Bug #35).
//    Un refactor "ordenado" tiende justo a fusionarlas. No se fusionan.
//
// 2. La frontera FASE 1 / FASE 2 de `/abono` no se parte. `compute()` declara ~29
//    locales y su `aplicar()` captura ~10 por closure. Ese cruce es el mecanismo
//    que garantiza "4xx => BD intacta": todo se valida y se computa en memoria
//    antes de la primera escritura.
//
// 3. La liquidacion persiste `abonoCapital = saldoReal` (capital pendiente NO en
//    mora), nunca el `monto` completo: las cuotas En Mora aportan su propio
//    capital al marcarse Pagadas, y usar el total lo contaria dos veces.
//
// 4. `DELETE /api/loans/:id` esta FUERA del journal por decision de negocio, pero
//    invalida las entradas de undo previas de ese prestamo dentro de la MISMA
//    transaccion (Bug #41): si no, quedarian reversibles apuntando a un agregado
//    que ya no existe, y deshacerlas RESUCITARIA el prestamo borrado.
//
// 5. La guarda de `/cambiar-dia-pago` que se salta los ids ya Pagados (Bug #38) y
//    la regla "nunca adelantar el cobro" con `fechaBaseCronograma` (v1.16.1).

const express = require('express');

// Predicados de clasificacion de filas de `payments` (core/ids.js): unica fuente
// de verdad de que es un abono. Antes cada sitio repetia el literal indexOf('-ab-').
const { esAbono } = require('../core/ids');

module.exports = function crearRutasLoans(ctx) {
  const {
    db, logAction, insPayment, runPayment, insertSchedule, mutacionAtomica,
    snapshotCobros, restaurarCobros, abortarSiHuerfanos,
    buildSchedule, buildScheduleFixedPMT, getPayDate, tasaPeriodo, cuotasHastaHoy,
    MODALIDAD_DIARIA, devengoDiario,
    ClientError, hoyStr,
  } = ctx;

  // Cortes de un credito abierto, en orden cronologico. Es la unica lectura que
  // `devengoDiario` necesita, y se centraliza para que ninguna ruta invente su
  // propio filtro (que es como nacio el Bug #28).
  const cortesDe = (loanId) => db
    .prepare("SELECT * FROM payments WHERE prestamoId = ? AND id LIKE '%-ct-%' ORDER BY fechaPago, cuotaN")
    .all(loanId);
  const router = express.Router();

  // ── API: Loans ────────────────────────────────────────────────────────────
  router.get('/api/loans', (_req, res) => {
    res.json(db.prepare('SELECT * FROM loans ORDER BY createdAt').all());
  });

  router.post('/api/loans', (req, res) => {
    const loan = { fechaDevolucion: '', comprasUSD: '', gananciaFija: 0, ...req.body, id: Date.now().toString() + Math.random().toString(36).slice(2,6) };
    // Si comprasUSD viene como array/objeto, serializar a JSON
    if (loan.comprasUSD && typeof loan.comprasUSD !== 'string') loan.comprasUSD = JSON.stringify(loan.comprasUSD);
    // v1.10.0: gananciaFija solo aplica para modalidad Pago Unico — forzar 0 en el resto
    if (loan.modalidad !== 'Pago Unico') loan.gananciaFija = 0;
    else loan.gananciaFija = Math.round(+loan.gananciaFija || 0);
    // ── Interes Diario: sembrar el cache del devengo ──────────────────────────
    // El credito abierto nace SIN cortes, asi que el tramo abierto corre desde
    // `fechaInicio` y no hay interes arrastrado. Se guarda la FECHA, nunca NULL:
    // un lector que olvidara el fallback pasaria null a `diasEntre`, que devuelve 0
    // sin quejarse — interes cero en silencio. Con una fecha valida ese camino no existe.
    // Esto es lo que hace que la creacion RETROACTIVA funcione sola: si `fechaInicio`
    // es de hace 15 dias, el primer devengo ya trae esos 15 dias.
    if (loan.modalidad === MODALIDAD_DIARIA) {
      loan.fechaUltimoCorte = loan.fechaInicio;
      loan.interesAcumuladoPend = 0;
      // Un credito abierto no tiene plazo. Se normaliza al centinela para que ninguna
      // ruta lo confunda con un cronograma de N meses.
      loan.plazoMeses = 0;
    } else {
      loan.fechaUltimoCorte = null;
      loan.interesAcumuladoPend = 0;
    }
    // FASE 1 — computar el cronograma ANTES de la primera escritura. El motor rechaza las
    // modalidades que no reconoce (ver MODALIDADES_CONOCIDAS en core/engine.js), y hasta ahora
    // ese rechazo llegaba DESPUES del INSERT: la transaccion lo revertia, si, pero el cliente
    // recibia un 500 en vez de un 4xx que le dijera que la modalidad no existe. `buildSchedule`
    // es puro, asi que adelantarlo no tiene ningun efecto colateral.
    // (Esto NO cierra el defecto #1 del backlog: un cuerpo incompleto —sin `cedula`, p.ej.—
    // sigue reventando en el driver de SQLite mas abajo. Eso es validacion de payload, otro
    // trabajo; aqui solo se arregla la ruta de la modalidad.)
    let schedule;
    try {
      schedule = buildSchedule(loan);
    } catch (e) {
      if (e instanceof ClientError) return res.status(400).json({ error: e.message });
      throw e;
    }
    // ATOMICO: el INSERT del prestamo y la generacion de su cronograma van en UNA transaccion.
    // Antes iban sueltos: un fallo entre ambos creaba un prestamo sin cuotas. Este endpoint NO
    // se journaliza (fuera del alcance acordado del undo), pero la atomicidad si es exigible.
    db.transaction(() => {
      db.prepare(`
        INSERT INTO loans(id,nombre,cedula,telefono,moneda,montoOrigen,trmAcordada,montoCOP,
          tasaMensual,plazoMeses,modalidad,fechaInicio,diaPago,estado,notas,frecuencia,fechaDevolucion,comprasUSD,gananciaFija,
          fechaUltimoCorte,interesAcumuladoPend)
        VALUES (@id,@nombre,@cedula,@telefono,@moneda,@montoOrigen,@trmAcordada,@montoCOP,
          @tasaMensual,@plazoMeses,@modalidad,@fechaInicio,@diaPago,@estado,@notas,@frecuencia,@fechaDevolucion,@comprasUSD,@gananciaFija,
          @fechaUltimoCorte,@interesAcumuladoPend)
      `).run(loan);
      insertSchedule(schedule);
    })();
    var detalleLog = (loan.moneda === 'USD' ? 'USD $' + loan.montoOrigen : '$' + Math.round(loan.montoCOP).toLocaleString()) + ' (' + loan.modalidad + ')';
    if (loan.modalidad === 'Pago Unico' && loan.gananciaFija > 0) {
      detalleLog += ' [ganancia $' + Math.round(loan.gananciaFija).toLocaleString('es-CO') + ']';
    }
    logAction.run('prestamo', 'Nuevo prestamo: ' + loan.nombre + ' por ' + detalleLog);
    res.status(201).json(loan);
  });

  router.put('/api/loans/:id', (req, res) => {
    const loan = { fechaDevolucion: '', comprasUSD: '', gananciaFija: 0, ...req.body, id: req.params.id };
    if (loan.comprasUSD && typeof loan.comprasUSD !== 'string') loan.comprasUSD = JSON.stringify(loan.comprasUSD);
    // v1.10.0: gananciaFija solo aplica para modalidad Pago Unico — forzar 0 en el resto
    if (loan.modalidad !== 'Pago Unico') loan.gananciaFija = 0;
    else loan.gananciaFija = Math.round(+loan.gananciaFija || 0);
    // ATOMICO desde "La Bestia": antes el UPDATE de loans, el DELETE de Pendientes y el
    // insertSchedule iban sueltos (3 escrituras sin transaccion) -> un fallo intermedio dejaba
    // el prestamo editado con el cronograma a medio borrar. Ahora todo va en una sola tx.
    // El UPDATE se movio al final (a `aplicar`): ningun computo posterior lee `payments` de la
    // BD despues del DELETE, y el cronograma se calcula desde el `loan` del body, no de la BD.
    return mutacionAtomica(req, res, { accion: 'edicion', endpoint: 'PUT /api/loans/:id', scopeTipo: 'loan', scopeId: req.params.id }, () => {

    // v1.9.0 FIX: solo borrar Pendientes regulares. Cuotas Pagadas y En Mora se preservan
    // intactas (deuda historica/causada). Esto garantiza que un edit nunca afecta cuotas
    // ya pactadas con el deudor.
    const prev = db.prepare('SELECT * FROM payments WHERE prestamoId = ?').all(loan.id);
    const prevAbonos = prev.filter(p => esAbono(p));
    const prevRegulares = prev.filter(p => !esAbono(p));
    const prevPagadasYMora = prevRegulares.filter(p => p.estadoPago === 'Pagado' || p.estadoPago === 'En Mora');
    const prevPendientes = prevRegulares.filter(p => p.estadoPago === 'Pendiente');

    // Snapshot de lo cobrado sobre las Pendientes (parcial + ledger `recibos` + observaciones)
    const partialMapEdit = snapshotCobros(prevPendientes);

    // (El borrado de Pendientes se aplica en la fase de escritura, mas abajo.)

    // Saldo actual considerando abonos previos (montoCOP es el del request, pero defendemos
    // contra valores incorrectos restando los abonos confirmados).
    const totalAbonado = prevAbonos.filter(p => p.estadoPago === 'Pagado')
      .reduce((s, p) => s + p.abonoCapital, 0);
    // capital ya consumido por cuotas Pagadas regulares (no abonos)
    // v1.12.x FIX (bug de mora): incluir el capital de las cuotas EN MORA (deuda independiente)
    // para que saldoActual sea simetrico con regularConsumedEdit (que cuenta Pagadas + Mora).
    const capPorCuotasPagadas = prevPagadasYMora.reduce((s, p) => s + p.abonoCapital, 0);
    const originalCOPEdit = loan.moneda === 'USD' ? Math.round(loan.montoOrigen * loan.trmAcordada) : Math.round(loan.montoOrigen);
    const saldoActual = Math.max(0, originalCOPEdit - totalAbonado - capPorCuotasPagadas);
    const regularConsumedEdit = prevPagadasYMora.length;
    const nextRegularNEdit = regularConsumedEdit + 1;
    const cuotaFijaEdit = Math.round(+loan.cuotaFijaPactada || 0);
    const indefinidoEdit = loan.modalidad === 'Intereses';

    let schedule = [];
    if (saldoActual > 0) {
      if (cuotaFijaEdit > 0 && loan.modalidad === 'Capital + Intereses') {
        try {
          schedule = buildScheduleFixedPMT({ ...loan, montoCOP: saldoActual }, nextRegularNEdit, saldoActual, cuotaFijaEdit);
        } catch (e) {
          const remaining = Math.max(0, (loan.plazoMeses || 12) - regularConsumedEdit);
          if (remaining > 0) schedule = buildSchedule({ ...loan, montoCOP: saldoActual }, nextRegularNEdit, saldoActual, remaining);
        }
      } else if (loan.modalidad === 'Prestamo') {
        if (regularConsumedEdit === 0) schedule = buildSchedule({ ...loan, montoCOP: saldoActual });
      } else if (loan.modalidad === 'Pago Unico') {
        // v1.10.0: igual que Prestamo — solo regenera si no se consumio la cuota unica
        if (regularConsumedEdit === 0) schedule = buildSchedule({ ...loan, montoCOP: saldoActual });
      } else {
        const remaining = indefinidoEdit
          ? Math.max(0, cuotasHastaHoy(loan.fechaInicio, nextRegularNEdit, 3, loan.frecuencia || 'Mensual'))
          : Math.max(0, (loan.plazoMeses || 12) - regularConsumedEdit);
        if (remaining > 0) schedule = buildSchedule({ ...loan, montoCOP: saldoActual }, nextRegularNEdit, saldoActual, remaining);
      }
    }

    // Aplicar extra del prorrateo + restaurar partialPaid
    const extraLoanEdit = Math.round(+loan.proximaCuotaExtra || 0);
    const extraNEdit = +loan.proximaCuotaExtraN || 0;
    // Bug #44: si el cronograma nuevo NO incluye una cuota que llevaba dinero encima, el
    // parcial no tiene donde restaurarse y se perderia en silencio. Aqui es alcanzable
    // porque un edit puede ACORTAR `plazoMeses` o fijar una cuota mas alta, dejando fuera
    // cuotaN que si existian. Era una de las 2 rutas de las 5 que no lo comprobaba.
    // Estamos dentro de `mutacionAtomica` y en FASE 1: lanzar aqui da 4xx con la BD intacta.
    abortarSiHuerfanos(schedule, partialMapEdit);
    restaurarCobros(schedule, partialMapEdit);
    schedule.forEach(p => {
      if (extraLoanEdit !== 0 && p.cuotaN === extraNEdit) {
        p.interesPeriodo = Math.round(p.interesPeriodo + extraLoanEdit);
        p.cuotaTotal = Math.round(p.cuotaTotal + extraLoanEdit);
        p.extraConsolidado = extraLoanEdit;
        if (!p.observaciones) p.observaciones = 'Cuota transitoria por cambio de fecha de pago (' + (extraLoanEdit >= 0 ? '+$' : '-$') + Math.abs(extraLoanEdit).toLocaleString('es-CO') + ')';
      }
    });

    return {
      descripcion: 'Editaste prestamo de ' + loan.nombre,
      payload: loan,
      aplicar: () => {
        db.prepare(`
          UPDATE loans SET nombre=@nombre, cedula=@cedula, telefono=@telefono, moneda=@moneda,
            montoOrigen=@montoOrigen, trmAcordada=@trmAcordada, montoCOP=@montoCOP,
            tasaMensual=@tasaMensual, plazoMeses=@plazoMeses, modalidad=@modalidad,
            fechaInicio=@fechaInicio, diaPago=@diaPago, estado=@estado, notas=@notas, frecuencia=@frecuencia, fechaDevolucion=@fechaDevolucion, comprasUSD=@comprasUSD, gananciaFija=@gananciaFija
          WHERE id=@id
        `).run(loan);
        // Borrar SOLO Pendientes — Pagadas, Mora y abonos quedan intactos
        prevPendientes.forEach(p => {
          db.prepare('DELETE FROM payments WHERE id = ?').run(p.id);
        });
        if (schedule.length > 0) insertSchedule(schedule);
      }
    };
    });
  });

  router.delete('/api/loans/:id', (req, res) => {
    const loan = db.prepare('SELECT nombre, montoCOP FROM loans WHERE id = ?').get(req.params.id);
    // ATOMICO: los dos DELETE van juntos (antes sueltos -> podian dejar cuotas huerfanas sin su
    // prestamo). NO se journaliza: eliminar un prestamo es deliberado y ya tiene su confirmacion.
    db.transaction(() => {
      db.prepare('DELETE FROM payments WHERE prestamoId = ?').run(req.params.id);
      db.prepare('DELETE FROM loans WHERE id = ?').run(req.params.id);
      // v2.1.2 — UNDOS HUERFANOS. Como este endpoint NO esta journalizado, nada "tapa" en el LIFO
      // a las entradas previas de este prestamo: seguian 'disponible' y el Historial mostraba su
      // boton Deshacer activo apuntando a un agregado que ya no existe. Al intentarlo, el restore
      // RESUCITARIA el prestamo borrado (el snapshot lo contiene entero), contradiciendo una
      // eliminacion deliberada. Se invalidan dentro de la MISMA transaccion del borrado.
      // No se borran: el journal es append-only, asi que quedan como 'invalidado' (la UI no
      // ofrece boton para ese estado y POST /api/undo/:id lo rechaza).
      db.prepare("UPDATE undo_journal SET estado = 'invalidado' WHERE scope_tipo = 'loan' AND scope_id = ? AND estado = 'disponible'").run(req.params.id);
    })();
    if (loan) logAction.run('eliminacion', 'Eliminaste prestamo de ' + loan.nombre);
    res.json({ ok: true });
  });

  // ── API: Abono a Capital ──────────────────────────────────────────────────
  // ATOMICO (v1.9.0): toda validacion + buildSchedule(FixedPMT) ocurre ANTES de cualquier
  // escritura. Si algo falla, se retorna 400 sin tocar la BD. Las escrituras se aplican
  // dentro de una transaccion SQLite (all-or-nothing).
  router.post('/api/loans/:id/abono', (req, res) => {
    const { monto, fecha, observaciones, montoUSD, liquidar, recalcMode, recalcValor, intExtra, montoCOPRecibido } = req.body;
    const loan = db.prepare('SELECT * FROM loans WHERE id = ?').get(req.params.id);
    if (!loan) return res.status(404).json({ error: 'No encontrado' });

    // v2.1 "La Bestia" — el endpoint delega en mutacionAtomica: la FASE 1 (compute)
    // valida y computa; la FASE 2 (aplicar) se ejecuta dentro de la transaccion del
    // helper junto al INSERT del journal de undo. Las validaciones lanzan ClientError.
    return mutacionAtomica(req, res, { accion: 'abono', endpoint: 'POST /api/loans/:id/abono', scopeTipo: 'loan', scopeId: req.params.id }, () => {
    // Un credito abierto NO se abona por aqui. Esta ruta crea una fila '-ab-', y
    // `devengoDiario` solo mira los cortes ('-ct-'): el capital bajaria en la formula
    // canonica de saldo mientras el devengo seguiria corriendo sobre la base VIEJA.
    // Serian dos verdades distintas sobre el mismo credito, en silencio y creciendo
    // cada dia. La ruta correcta es POST /api/loans/:id/corte, que registra el abono
    // Y el interes en el mismo evento.
    if (loan.modalidad === MODALIDAD_DIARIA) {
      throw new ClientError('Este credito es de ' + MODALIDAD_DIARIA + ': los abonos se registran como un CORTE (POST /api/loans/:id/corte), que baja el capital y liquida el interes devengado en el mismo movimiento.');
    }
    // ── FASE 1: LECTURA + VALIDACION (sin escrituras) ────────────────────────
    const allPays = db.prepare('SELECT * FROM payments WHERE prestamoId = ? ORDER BY cuotaN').all(req.params.id);

    const originalCOP = loan.moneda === 'USD' ? Math.round(loan.montoOrigen * loan.trmAcordada) : Math.round(loan.montoOrigen);
    // Regla canonica de abono: id con '-ab-'. Las modalidades de cuota unica (Prestamo, Pago Unico)
    // NO aportan su capital a todoCapPagado: su abonoCapital ES el saldo vivo (no capital pagado);
    // restarlo colapsaria saldoReal a 0 y rechazaria el abono (bug corregido en el sprint heuristica).
    const esSingleCuota = loan.modalidad === 'Prestamo' || loan.modalidad === 'Pago Unico';
    // v1.12.x FIX (bug de mora): en modalidades que amortizan (Capital + Intereses, Intereses) el
    // capital de las cuotas EN MORA tambien esta "consumido" (deuda independiente) -> restarlo,
    // simetrico con regularConsumed. En Prestamo/Pago Unico se excluye por !esSingleCuota.
    const todoCapPagado = allPays.filter(p =>
      p.estadoPago === 'Pagado' ||
      (p.estadoPago === 'En Mora' && !esSingleCuota)
    ).reduce((s, p) => s + p.abonoCapital, 0);
    const saldoReal = Math.max(0, originalCOP - todoCapPagado);
    // ── CAPITAL PENDIENTE PARA LIQUIDACION (regla de negocio v1.19.0) ──
    // NO resta el capital de las cuotas En Mora: siguen debiendose, el cliente las paga HOY al
    // liquidar. Es distinto de saldoReal, que SI resta el capital En Mora para el RECALCULO
    // (Bug #21, deuda independiente amortizada aparte). Solo cuenta Pagadas (incluye abonos '-ab-').
    // Identidad: capitalPendienteLiq = saldoReal + capitalEnMora (para C+I); en Prestamo/Pago Unico
    // (esSingleCuota) coinciden porque su mora no aporta a todoCapPagado.
    const capPagadasSolo = allPays.filter(p => p.estadoPago === 'Pagado').reduce((s, p) => s + p.abonoCapital, 0);
    const capitalPendienteLiq = Math.max(0, originalCOP - capPagadasSolo);
    const montoNum = +monto || 0;
    const intExtraNum = Math.max(0, Math.round(+intExtra || 0)); // interes del proximo mes al liquidar (checkbox)
    // v2.0.0 — CAJA REAL del abono. En prestamos USD el capital se descuenta a la TRM PACTADA
    // (monto = montoUSD x trmAcordada), pero los COP que entran por caja dependen de la TRM del
    // dia. Sin este dato el desfase cambiario de un abono era invisible: montoCOPRecibido se
    // derivaba del propio capital y siempre cuadraba a la fuerza. Opcional: si no llega (prestamos
    // COP y la ruta de liquidacion) se conserva el comportamiento anterior.
    const copRecibidoNum = Math.max(0, Math.round(+montoCOPRecibido || 0));
    if (montoNum <= 0) throw new ClientError('El monto del abono debe ser mayor a 0');
    // Validacion bifurcada: al LIQUIDAR se acepta cubrir todo el capital pendiente (incluida la mora),
    // por eso se valida contra capitalPendienteLiq y NO contra saldoReal (que rebotaba el cobro de un
    // C+I con mora — showstopper). En un abono normal se mantiene la validacion contra saldoReal.
    if (liquidar) {
      if (montoNum > capitalPendienteLiq + 1) {
        throw new ClientError('El monto supera el capital pendiente ($' + capitalPendienteLiq.toLocaleString('es-CO') + ')');
      }
    } else if (Math.round(saldoReal - montoNum) < 0) {
      // v2.0.0 — defense-in-depth. El AbonoModal ya topa el monto en saldoAbonable (espejo exacto
      // de saldoReal), asi que esta rama solo se alcanza saltandose el frontend. El mensaje explica
      // POR QUE el tope es menor que el capital total y a que herramienta acudir, en vez del
      // criptico "El abono supera el saldo actual".
      const capMoraMsg = Math.max(0, capitalPendienteLiq - saldoReal);
      throw new ClientError('El abono supera el capital amortizable ($' + Math.round(saldoReal).toLocaleString('es-CO') + ').' +
        (capMoraMsg > 0
          ? ' Los $' + Math.round(capMoraMsg).toLocaleString('es-CO') + ' restantes son capital de cuotas En Mora: se cobran liquidando la deuda o pagando esas cuotas desde la seccion Pagos.'
          : ''));
    }
    // En liquidacion el prestamo se salda por completo -> nuevoSaldo 0 (no hay recalculo de pendientes).
    const nuevoSaldo = liquidar ? 0 : Math.round(saldoReal - montoNum);

    // Un registro de abono se identifica por la regla canonica: id con '-ab-'.
    const regularConsumed = allPays.filter(p =>
      (p.estadoPago === 'Pagado' || p.estadoPago === 'En Mora') &&
      !esAbono(p)
    ).length;
    const maxExistingN = allPays.reduce((max, p) => Math.max(max, p.cuotaN), 0);

    const indefinido = loan.modalidad === 'Intereses';
    const esCapInt = loan.modalidad === 'Capital + Intereses';
    const remainingDefault = indefinido ? 3 : Math.max(0, (loan.plazoMeses || 12) - regularConsumed);
    const nextRegularN = regularConsumed + 1;
    const updatedLoan = Object.assign({}, loan, { montoCOP: nuevoSaldo });

    // Pre-computar TODO el cronograma nuevo (si aplica) ANTES de tocar BD.
    let nuevasCuotas = [];
    let nuevoPlazoMeses = null;     // null = no actualizar plazoMeses
    let nuevaCuotaFija = null;      // null = no actualizar; 0 = limpiar; >0 = persistir
    let logRecalc = '';

    if (nuevoSaldo > 0) {
      if (esCapInt && recalcMode === 'modificarPlazo') {
        const nuevoN = parseInt(recalcValor, 10);
        if (!nuevoN || nuevoN < 1) throw new ClientError('Numero de cuotas invalido. Debe ser >= 1.');
        nuevasCuotas = buildSchedule(updatedLoan, nextRegularN, nuevoSaldo, nuevoN);
        nuevoPlazoMeses = regularConsumed + nuevoN;
        nuevaCuotaFija = 0; // limpiar (el usuario cambio de opinion)
        logRecalc = ' — plazo ajustado a ' + nuevoN + ' cuota' + (nuevoN > 1 ? 's' : '') + ' restantes (total: ' + nuevoPlazoMeses + ')';
      } else if (esCapInt && recalcMode === 'fijarCuota') {
        const cuotaDeseada = +recalcValor || 0;
        if (cuotaDeseada <= 0) throw new ClientError('Cuota invalida. Debe ser > 0.');
        const r = tasaPeriodo((loan.tasaMensual || 0) / 100, loan.frecuencia || 'Mensual');
        const interesPrimerPeriodo = nuevoSaldo * r;
        if (cuotaDeseada <= interesPrimerPeriodo) {
          throw new ClientError('La cuota debe ser mayor a $' + Math.round(interesPrimerPeriodo).toLocaleString('es-CO') +
            ' (intereses del primer periodo). Con $' + Math.round(cuotaDeseada).toLocaleString('es-CO') +
            ' nunca se saldaria la deuda.');
        }
        try {
          nuevasCuotas = buildScheduleFixedPMT(updatedLoan, nextRegularN, nuevoSaldo, cuotaDeseada);
        } catch (e) {
          throw new ClientError(e.message);
        }
        nuevoPlazoMeses = regularConsumed + nuevasCuotas.length;
        nuevaCuotaFija = Math.round(cuotaDeseada);
        logRecalc = ' — cuota fija $' + Math.round(cuotaDeseada).toLocaleString('es-CO') + ' x ' + nuevasCuotas.length + ' cuotas (total: ' + nuevoPlazoMeses + ')';
      } else {
        // Opcion 1 (default): mantener plazo, baja la cuota
        if (loan.cuotaFijaPactada && +loan.cuotaFijaPactada > 0) nuevaCuotaFija = 0; // limpia (cambio de opinion)
        if (remainingDefault > 0) {
          nuevasCuotas = buildSchedule(updatedLoan, nextRegularN, nuevoSaldo, remainingDefault);
        }
      }
    }

    // DURABILIDAD DE LO COBRADO: abajo se borran TODAS las cuotas Pendientes y se regeneran.
    // Si alguna llevaba un pago parcial encima, sin esto el registro del dinero se destruye
    // (el cliente pago y el sistema lo olvida). Se restaura sobre el cronograma en memoria,
    // antes de escribir. La guarda de huerfanos NO aplica cuando el prestamo queda saldado:
    // ahi el cronograma vacio es correcto y el parcial ya se conto en la liquidacion.
    const cobrosPrevAb = snapshotCobros(allPays.filter(p => !esAbono(p) && p.estadoPago === 'Pendiente'));
    if (nuevoSaldo > 0) abortarSiHuerfanos(nuevasCuotas, cobrosPrevAb);
    restaurarCobros(nuevasCuotas, cobrosPrevAb);

    // ── FASE 2: ESCRITURA — la ejecuta mutacionAtomica dentro de UNA transaccion,
    // junto al INSERT del journal de undo y el activity_log. Todo o nada.
    let logBase = 'Registraste abono de $' + Math.round(montoNum).toLocaleString() + ' a ' + loan.nombre + (nuevoSaldo <= 0 ? ' (SALDADO)' : ' — saldo: $' + Math.round(nuevoSaldo).toLocaleString());
    if (recalcMode === 'modificarPlazo' || recalcMode === 'fijarCuota') logBase += ' [recalc: ' + recalcMode + ']';
    return {
      descripcion: logBase,
      // El abono (y la liquidacion) generan Recibo de Abono / Paz y Salvo automaticamente.
      afectaCaja: true,
      payload: { ok: true, nuevoSaldo: Math.max(0, nuevoSaldo) },
      aplicar: () => {
      const abonoId = req.params.id + '-ab-' + Date.now();
      const fechaAbono = fecha || hoyStr();
      // Solo borrar cuotas PENDIENTES; las cuotas En Mora permanecen intactas (deuda independiente)
      db.prepare("DELETE FROM payments WHERE prestamoId = ? AND estadoPago = 'Pendiente'").run(req.params.id);

      // Para Prestamo: actualizar cuotaTotal de cuotas En Mora al nuevo saldo
      // v1.10.0 fix housekeeping: tambien actualizar saldoInicial y abonoCapital para
      // que la cuota refleje correctamente el estado tras el abono. Sin este fix los
      // valores quedaban con el monto original e inflaban marginalmente el KPI de
      // "capital recuperado" cuando se pagaba la cuota en mora.
      if (loan.modalidad === 'Prestamo') {
        const moraRegulares = allPays.filter(p => p.estadoPago === 'En Mora' && !esAbono(p));
        const ns = Math.max(0, nuevoSaldo);
        moraRegulares.forEach(p => {
          db.prepare('UPDATE payments SET saldoInicial = ?, abonoCapital = ?, cuotaTotal = ?, saldoFinal = ? WHERE id = ?')
            .run(ns, ns, ns, 0, p.id);
        });
      }
      // v1.10.0 — Pago Unico: igual que Prestamo pero conservando la ganancia pactada
      // (cuotaTotal = capital restante + ganancia; abonoCapital solo el capital)
      if (loan.modalidad === 'Pago Unico') {
        const gPU2 = Math.round(+loan.gananciaFija || 0);
        const moraRegularesPU = allPays.filter(p => p.estadoPago === 'En Mora' && !esAbono(p));
        const nsPU = Math.max(0, nuevoSaldo);
        moraRegularesPU.forEach(p => {
          db.prepare('UPDATE payments SET saldoInicial = ?, abonoCapital = ?, cuotaTotal = ?, saldoFinal = ? WHERE id = ?')
            .run(nsPU, nsPU, nsPU + gPU2, 0, p.id);
        });
      }

      // Registrar el abono como cuota especial.
      // v1.19.0 — al LIQUIDAR el abono captura SOLO el capital pendiente NO en mora (= saldoReal):
      // el capital de las cuotas En Mora ya queda contabilizado al marcarlas Pagadas abajo. Sin esto
      // el capital se contaria DOBLE (abono por el total + cuotas mora con su propio capital) y
      // "capital recuperado" superaria el monto prestado. En single-cuota (Prestamo/Pago Unico)
      // saldoReal == montoNum, asi que no cambia. El interes del proximo mes (intExtra, opcional) se
      // registra como interesPeriodo del abono para que cuente como ingreso real.
      const abonoCapReg = liquidar ? Math.round(saldoReal) : Math.round(montoNum);
      const abonoInt = liquidar ? intExtraNum : 0;
      // En liquidacion con saldoReal 0 y sin interes extra (todo el capital estaba en la mora) no hay
      // nada que registrar en un abono aparte -> se omite la fila (las cuotas mora ya lo capturan).
      const crearAbono = !liquidar || abonoCapReg > 0 || abonoInt > 0;
      if (crearAbono) {
        runPayment({
          id: abonoId,
          prestamoId: req.params.id,
          nombreCliente: loan.nombre,
          cuotaN: maxExistingN + 1,
          fechaPago: fechaAbono,
          saldoInicial: saldoReal,
          interesPeriodo: abonoInt,
          abonoCapital: abonoCapReg,
          cuotaTotal: abonoCapReg + abonoInt,
          saldoFinal: Math.max(0, nuevoSaldo),
          estadoPago: 'Pagado',
          fechaRecaudo: fechaAbono,
          observaciones: observaciones || 'Abono a capital',
          // v2.0.0 — caja real si el frontend la envia (USD: COP efectivamente recibidos, que
          // difieren del capital a TRM pactada); si no, el valor derivado de siempre.
          montoCOPRecibido: copRecibidoNum > 0 ? copRecibidoNum : (abonoCapReg + abonoInt),
          montoUSDRecibido: montoUSD ? Math.round(montoUSD * 100) / 100 : 0,
          partialPaid: 0,
          extraConsolidado: 0
        });
        db.prepare("UPDATE payments SET paidAt = datetime('now','localtime') WHERE id = ?").run(abonoId);
      }

      if (nuevoSaldo <= 0) {
        // Capital saldado
        if (liquidar) {
          // Las cuotas En Mora se saldan: Pagado + montoCOPRecibido = su cuotaTotal (capital + interes
          // de esa cuota), asi el efectivo recibido cuadra y el interes de mora cuenta como cobrado.
          db.prepare("UPDATE payments SET estadoPago = 'Pagado', fechaRecaudo = ?, montoCOPRecibido = cuotaTotal, paidAt = datetime('now','localtime') WHERE prestamoId = ? AND estadoPago = 'En Mora'").run(fechaAbono, req.params.id);
          db.prepare("UPDATE loans SET montoCOP = 0, estado = 'Finalizado', cuotaFijaPactada = 0 WHERE id = ?").run(req.params.id);
        } else {
          const moraRestante = db.prepare("SELECT COUNT(*) as c FROM payments WHERE prestamoId = ? AND estadoPago = 'En Mora'").get(req.params.id);
          if (moraRestante.c === 0) {
            db.prepare("UPDATE loans SET montoCOP = 0, estado = 'Finalizado', cuotaFijaPactada = 0 WHERE id = ?").run(req.params.id);
          } else {
            db.prepare("UPDATE loans SET montoCOP = 0 WHERE id = ?").run(req.params.id);
          }
        }
      } else {
        db.prepare('UPDATE loans SET montoCOP = ? WHERE id = ?').run(nuevoSaldo, req.params.id);
        if (nuevasCuotas.length > 0) insertSchedule(nuevasCuotas);
        if (nuevoPlazoMeses !== null) {
          db.prepare('UPDATE loans SET plazoMeses = ? WHERE id = ?').run(nuevoPlazoMeses, req.params.id);
        }
        if (nuevaCuotaFija !== null) {
          db.prepare('UPDATE loans SET cuotaFijaPactada = ? WHERE id = ?').run(nuevaCuotaFija, req.params.id);
        }
      }
      }
      };
    });
  });

  // ── API: Reestructurar Prestamo (sin abono) ──────────────────────────────
  // Permite recalcular el cronograma de cuotas FUTURAS sin necesidad de hacer un abono.
  // SOLO para modalidad Capital + Intereses. Cuotas Pagadas y En Mora NO se tocan.
  // Atomico: valida + computa todo antes de cualquier escritura.
  router.post('/api/loans/:id/reestructurar', (req, res) => {
    const { recalcMode, recalcValor } = req.body;
    const loan = db.prepare('SELECT * FROM loans WHERE id = ?').get(req.params.id);
    if (!loan) return res.status(404).json({ error: 'No encontrado' });
    return mutacionAtomica(req, res, { accion: 'reestructuracion', endpoint: 'POST /api/loans/:id/reestructurar', scopeTipo: 'loan', scopeId: req.params.id }, () => {
    if (loan.estado !== 'Activo') throw new ClientError('Solo se pueden reestructurar prestamos activos');
    if (loan.modalidad !== 'Capital + Intereses') throw new ClientError('La reestructuracion solo aplica para prestamos de Capital + Intereses');
    if (recalcMode !== 'modificarPlazo' && recalcMode !== 'fijarCuota') {
      throw new ClientError('Modo de recalculo invalido. Debe ser "modificarPlazo" o "fijarCuota".');
    }

    // ── FASE 1: LECTURA + VALIDACION (sin escrituras) ────────────────────────
    const allPays = db.prepare('SELECT * FROM payments WHERE prestamoId = ? ORDER BY cuotaN').all(req.params.id);

    const originalCOP = loan.moneda === 'USD' ? Math.round(loan.montoOrigen * loan.trmAcordada) : Math.round(loan.montoOrigen);
    // v1.12.x FIX (bug de mora): incluir el capital de las cuotas EN MORA (deuda independiente),
    // simetrico con regularConsumed (cuenta Pagadas + Mora). Regla canonica '-ab-' (endpoint
    // gated a Capital + Intereses, asi que Prestamo/Pago Unico no llegan aqui).
    const todoCapPagado = allPays.filter(p =>
      p.estadoPago === 'Pagado' ||
      (p.estadoPago === 'En Mora' && !esAbono(p))
    ).reduce((s, p) => s + p.abonoCapital, 0);
    const saldoReal = Math.max(0, originalCOP - todoCapPagado);
    if (saldoReal <= 0) throw new ClientError('El prestamo no tiene saldo de capital pendiente para reestructurar');

    const regularConsumed = allPays.filter(p =>
      (p.estadoPago === 'Pagado' || p.estadoPago === 'En Mora') &&
      !esAbono(p)
    ).length;
    const nextRegularN = regularConsumed + 1;
    const updatedLoan = Object.assign({}, loan, { montoCOP: saldoReal });

    let nuevasCuotas = [];
    let nuevoPlazoMeses;
    let nuevaCuotaFija; // 0 = limpiar, >0 = persistir
    let logRecalc;

    if (recalcMode === 'modificarPlazo') {
      const nuevoN = parseInt(recalcValor, 10);
      if (!nuevoN || nuevoN < 1) throw new ClientError('Numero de cuotas invalido. Debe ser >= 1.');
      nuevasCuotas = buildSchedule(updatedLoan, nextRegularN, saldoReal, nuevoN);
      nuevoPlazoMeses = regularConsumed + nuevoN;
      nuevaCuotaFija = 0;
      logRecalc = ' — plazo ajustado a ' + nuevoN + ' cuota' + (nuevoN > 1 ? 's' : '') + ' restantes (total: ' + nuevoPlazoMeses + ')';
    } else {
      // fijarCuota
      const cuotaDeseada = +recalcValor || 0;
      if (cuotaDeseada <= 0) throw new ClientError('Cuota invalida. Debe ser > 0.');
      const r = tasaPeriodo((loan.tasaMensual || 0) / 100, loan.frecuencia || 'Mensual');
      const interesPrimerPeriodo = saldoReal * r;
      if (cuotaDeseada <= interesPrimerPeriodo) {
        throw new ClientError('La cuota debe ser mayor a $' + Math.round(interesPrimerPeriodo).toLocaleString('es-CO') +
          ' (intereses del primer periodo). Con $' + Math.round(cuotaDeseada).toLocaleString('es-CO') +
          ' nunca se saldaria la deuda.');
      }
      try {
        nuevasCuotas = buildScheduleFixedPMT(updatedLoan, nextRegularN, saldoReal, cuotaDeseada);
      } catch (e) {
        throw new ClientError(e.message);
      }
      nuevoPlazoMeses = regularConsumed + nuevasCuotas.length;
      nuevaCuotaFija = Math.round(cuotaDeseada);
      logRecalc = ' — cuota fija $' + Math.round(cuotaDeseada).toLocaleString('es-CO') + ' x ' + nuevasCuotas.length + ' cuotas (total: ' + nuevoPlazoMeses + ')';
    }

    // DURABILIDAD DE LO COBRADO (ver /abono): las Pendientes se borran y se regeneran; sin este
    // snapshot un pago parcial en curso desapareceria. Aqui el plazo PUEDE acortarse, asi que la
    // guarda de huerfanos es especialmente pertinente: si la cuota que llevaba dinero ya no
    // existe en el cronograma nuevo, se aborta con 4xx y la BD queda intacta.
    const cobrosPrevRe = snapshotCobros(allPays.filter(p => !esAbono(p) && p.estadoPago === 'Pendiente'));
    abortarSiHuerfanos(nuevasCuotas, cobrosPrevRe);
    restaurarCobros(nuevasCuotas, cobrosPrevRe);

    // ── FASE 2: ESCRITURA — la ejecuta mutacionAtomica dentro de UNA transaccion.
    return {
      descripcion: 'Reestructuraste ' + loan.nombre + logRecalc,
      payload: { ok: true, nuevasCuotas: nuevasCuotas.length, nuevoPlazoMeses, cuotaFijaPactada: nuevaCuotaFija },
      aplicar: () => {
        // Borrar cuotas Pendientes (regulares, no abonos). Mora y Pagadas intactas.
        db.prepare("DELETE FROM payments WHERE prestamoId = ? AND estadoPago = 'Pendiente' AND id NOT LIKE '%-ab-%'").run(req.params.id);
        insertSchedule(nuevasCuotas);
        db.prepare('UPDATE loans SET plazoMeses = ?, cuotaFijaPactada = ? WHERE id = ?').run(nuevoPlazoMeses, nuevaCuotaFija, req.params.id);
      }
    };
    });
  });

  // ── API: Cierre Forzoso ───────────────────────────────────────────────────
  // Marca el préstamo como 'Cancelado' (cierre con pérdidas), guarda snapshot
  // de capital pendiente + intereses en mora, y borra las cuotas restantes.
  // ── API: CORTE de un credito de interes diario ────────────────────────────
  // El unico evento economico de un credito abierto. Materializa UNA fila '-ct-'
  // con lo que el cliente entrego: intereses devengados y/o abono a capital.
  //
  // Es el equivalente de /abono + PUT /payments para esta modalidad, y sustituye a
  // los dos: /abono crea filas '-ab-' que `devengoDiario` NO mira, asi que usarlo
  // aqui bajaria el capital sin que el motor se enterara — el devengo seguiria
  // corriendo sobre la base vieja. Por eso /abono lo rechaza explicitamente.
  //
  // Atomico via `mutacionAtomica`: FASE 1 valida y computa TODO (lanzando
  // ClientError -> 4xx con la BD intacta), FASE 2 escribe dentro de la transaccion
  // junto al journal de undo.
  router.post('/api/loans/:id/corte', (req, res) => {
    const { fecha, interesPagado, abonoCapital, observaciones, montoCOPRecibido, montoUSDRecibido } = req.body;
    const loan = db.prepare('SELECT * FROM loans WHERE id = ?').get(req.params.id);
    if (!loan) return res.status(404).json({ error: 'No encontrado' });
    // `accion` describe el evento en el journal; `logTipo` es lo que ve el Historial.
    // Se reusa 'pago' A PROPOSITO: `tipo` alimenta tipoIcon/tipoColor/tipoLabel del
    // frontend, que solo conoce 10 valores — meter uno nuevo aqui lo dejaria sin
    // icono ni color hasta la etapa de UI. Y un corte ES un cobro.
    return mutacionAtomica(req, res, { accion: 'corte', logTipo: 'pago', endpoint: 'POST /api/loans/:id/corte', scopeTipo: 'loan', scopeId: req.params.id }, () => {
      // ── FASE 1: LECTURA + VALIDACION + COMPUTO (sin escrituras) ─────────────
      if (loan.modalidad !== MODALIDAD_DIARIA) {
        throw new ClientError('Los cortes solo aplican a creditos de ' + MODALIDAD_DIARIA + ' (este es ' + loan.modalidad + ').');
      }
      if (loan.estado !== 'Activo') throw new ClientError('Solo se pueden registrar cortes en creditos activos');

      const fechaCorte = fecha || hoyStr();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(fechaCorte))) throw new ClientError('Fecha invalida: se espera YYYY-MM-DD');
      if (fechaCorte > hoyStr()) throw new ClientError('No se puede registrar un corte con fecha futura: devengaria intereses aun no causados');
      if (fechaCorte < loan.fechaInicio) throw new ClientError('El corte no puede ser anterior al inicio del credito (' + loan.fechaInicio + ')');

      const cortes = cortesDe(req.params.id);
      const ultimaFecha = cortes.length ? cortes[cortes.length - 1].fechaPago : loan.fechaInicio;
      // Se permite el MISMO dia (tramo de 0 dias, sin interes: es el caso de dos
      // movimientos en una jornada), pero nunca antes: retroceder partiria los tramos
      // y haria que un periodo ya liquidado se recalculara sobre otra base.
      if (fechaCorte < ultimaFecha) {
        throw new ClientError('El corte no puede ser anterior al ultimo registrado (' + ultimaFecha + ')');
      }

      const dev = devengoDiario(loan, cortes, fechaCorte);
      const intPagado = Math.round(+interesPagado || 0);
      const abonoCap  = Math.round(+abonoCapital  || 0);
      if (intPagado < 0 || abonoCap < 0) throw new ClientError('Los montos no pueden ser negativos');
      if (intPagado === 0 && abonoCap === 0) {
        throw new ClientError('El corte debe registrar algo: intereses, abono a capital, o ambos');
      }
      // Cobrar mas interes del devengado no es un pago anticipado: no hay periodo
      // futuro que cubrir en un credito sin cronograma. Se rechaza en vez de dejar
      // que `devengoDiario` lo clampe a 0 y el excedente desaparezca sin rastro.
      if (intPagado > dev.interesPendiente) {
        throw new ClientError('El interes cobrado ($' + intPagado.toLocaleString('es-CO') + ') supera el devengado a la fecha ($' +
          dev.interesPendiente.toLocaleString('es-CO') + ' al ' + fechaCorte + ').');
      }
      if (abonoCap > dev.capitalVivo) {
        throw new ClientError('El abono ($' + abonoCap.toLocaleString('es-CO') + ') supera el capital vivo ($' +
          dev.capitalVivo.toLocaleString('es-CO') + ').');
      }

      const n = cortes.reduce((m, c) => Math.max(m, c.cuotaN), 0) + 1;
      const total = intPagado + abonoCap;
      // Caja REAL. En COP coincide con la composicion; en USD puede diferir por la TRM
      // del dia (misma doctrina del Bug #37: el capital se mide a TRM pactada, la caja
      // es lo que de verdad entro). Si el cliente no la envia, se deriva.
      const cajaCOP = Math.round(+montoCOPRecibido) > 0 ? Math.round(+montoCOPRecibido) : total;
      const filaCorte = {
        id: `${loan.id}-ct-${n}`,
        prestamoId: loan.id,
        nombreCliente: loan.nombre,
        cuotaN: n,
        fechaPago: fechaCorte,
        saldoInicial: dev.capitalVivo,
        interesPeriodo: intPagado,
        abonoCapital: abonoCap,
        cuotaTotal: total,
        saldoFinal: Math.max(0, dev.capitalVivo - abonoCap),
        // Un corte nace 'Pagado' y no vuelve a cambiar (invariante I1). Es lo que lo
        // deja fuera de las 4 copias de la auto-mora, que filtran por 'Pendiente'.
        estadoPago: 'Pagado',
        fechaRecaudo: fechaCorte,
        observaciones: observaciones || '',
        montoCOPRecibido: cajaCOP,
        montoUSDRecibido: montoUSDRecibido ? Math.round(+montoUSDRecibido * 100) / 100 : 0,
        // partialPaid = cuotaTotal: el corte esta saldado por definicion. Sin esto,
        // `pendCuota` lo mostraria como si se debiera entero.
        partialPaid: total,
        extraConsolidado: 0,
        // Ledger SIEMPRE escrito (invariante I5): asi `cobrosDe` usa el ledger y nunca
        // el fallback, y el evento entra en "Cobros del Mes" con su fecha real.
        recibos: JSON.stringify([{ fecha: fechaCorte, cop: cajaCOP }]),
      };

      // Estado DESPUES del corte, derivado del mismo motor (no una cuenta aparte).
      const devPost = devengoDiario(loan, cortes.concat([filaCorte]), fechaCorte);
      // ── CIERRE ESTRICTO ─────────────────────────────────────────────────────
      // Un credito abierto solo se salda si NO queda capital NI interes devengado.
      // Con capital 0 pero interes pendiente el credito sigue vivo: ese interes se
      // debe y hay que poder cobrarlo. Y con interes 0 pero capital vivo, obviamente.
      const saldado = devPost.capitalVivo === 0 && devPost.interesPendiente === 0;

      const partes = [];
      if (intPagado > 0) partes.push('intereses $' + intPagado.toLocaleString('es-CO'));
      if (abonoCap  > 0) partes.push('abono a capital $' + abonoCap.toLocaleString('es-CO'));

      return {
        descripcion: 'Corte de interes diario: ' + loan.nombre + ' — ' + partes.join(' + ') +
          ' (' + fechaCorte + ')' + (saldado ? ' — credito SALDADO' : ''),
        afectaCaja: true,   // siempre entra dinero: el corte no existe sin movimiento
        payload: {
          ok: true,
          corte: { id: filaCorte.id, n: n, fecha: fechaCorte, interesPagado: intPagado, abonoCapital: abonoCap, total: total },
          antes:   { capitalVivo: dev.capitalVivo,     interesPendiente: dev.interesPendiente,     diasDevengados: dev.diasDesdeUltimoCorte },
          despues: { capitalVivo: devPost.capitalVivo, interesPendiente: devPost.interesPendiente },
          saldado: saldado,
        },
        aplicar: () => {
          runPayment(filaCorte);
          db.prepare("UPDATE payments SET paidAt = datetime('now','localtime') WHERE id = ?").run(filaCorte.id);
          // El cache queda derivado del motor, nunca calculado aqui: una sola formula.
          db.prepare('UPDATE loans SET montoCOP = ?, fechaUltimoCorte = ?, interesAcumuladoPend = ? WHERE id = ?')
            .run(devPost.capitalVivo, devPost.cache.fechaUltimoCorte, devPost.cache.interesAcumuladoPend, loan.id);
          if (saldado) {
            db.prepare("UPDATE loans SET estado = 'Finalizado' WHERE id = ? AND estado = 'Activo'").run(loan.id);
          }
        },
      };
    });
  });

  router.post('/api/loans/:id/force-close', (req, res) => {
    const loan = db.prepare('SELECT * FROM loans WHERE id = ?').get(req.params.id);
    if (!loan) return res.status(404).json({ error: 'No encontrado' });
    // ATOMICO desde "La Bestia": antes el DELETE y el UPDATE iban sueltos (sin transaccion),
    // asi que un fallo entre ambos dejaba el cronograma borrado con el prestamo aun Activo.
    return mutacionAtomica(req, res, { accion: 'cierre', endpoint: 'POST /api/loans/:id/force-close', scopeTipo: 'loan', scopeId: req.params.id }, () => {
      if (loan.estado !== 'Activo') throw new ClientError('Solo se pueden cerrar préstamos activos');

      const allPays = db.prepare('SELECT * FROM payments WHERE prestamoId = ?').all(req.params.id);
      const originalCOP = loan.moneda === 'USD' ? Math.round(loan.montoOrigen * loan.trmAcordada) : Math.round(loan.montoOrigen);
      const todoCapPagado = allPays.filter(p => p.estadoPago === 'Pagado').reduce((s, p) => s + p.abonoCapital, 0);
      const capitalPerdido = Math.max(0, Math.round(originalCOP - todoCapPagado));
      // Intereses que se dan por perdidos. En las 4 modalidades con cronograma son los
      // de las cuotas En Mora. Un credito abierto NO TIENE cuotas En Mora —su interes
      // vive devengado, no materializado—, asi que por esa via el cierre forzoso
      // reportaria $0 de interes perdido y la "Perdida total" de Rendimiento saldria
      // corta justo en lo que el producto genera. Se toma del motor.
      const interesesPerdidos = loan.modalidad === MODALIDAD_DIARIA
        ? devengoDiario(loan, cortesDe(req.params.id), hoyStr()).interesPendiente
        : Math.round(allPays
            .filter(p => p.estadoPago === 'En Mora' && !esAbono(p))
            .reduce((s, p) => s + p.interesPeriodo, 0));
      const totalPerdido = capitalPerdido + interesesPerdidos;

      return {
        descripcion: 'Cerraste a la fuerza el préstamo de ' + loan.nombre + ' — pérdida: $' + totalPerdido.toLocaleString() + ' (capital $' + capitalPerdido.toLocaleString() + ' + intereses mora $' + interesesPerdidos.toLocaleString() + ')',
        payload: { ok: true, capitalPerdido: capitalPerdido, interesesPerdidos: interesesPerdidos, totalPerdido: totalPerdido },
        aplicar: () => {
          db.prepare("DELETE FROM payments WHERE prestamoId = ? AND estadoPago IN ('Pendiente', 'En Mora')").run(req.params.id);
          db.prepare("UPDATE loans SET estado = 'Cancelado', capitalPerdido = ?, interesesPerdidos = ?, montoCOP = 0, cuotaFijaPactada = 0 WHERE id = ?")
            .run(capitalPerdido, interesesPerdidos, req.params.id);
        }
      };
    });
  });

  // ── API: Condonar intereses ───────────────────────────────────────────────
  // "Devuelveme el capital y te perdono los intereses". Hasta ahora ese acuerdo no
  // tenia herramienta y los tres caminos disponibles mentian de formas distintas:
  //   - Liquidar    -> FABRICA CAJA: registra como recibido el interes que se perdono
  //                    (medido: $4.800.000 declarados por $3.000.000 que entraron),
  //                    inflando "Cobros del Mes" y "Ganancias" a la vez.
  //   - Abono puro  -> deja las cuotas En Mora vivas: el credito nunca cierra.
  //   - Abono + cierre forzoso -> da los numeros exactos, pero marca 'Cancelado', que
  //                    Rendimiento pinta como "Perdida total" aunque se haya recuperado
  //                    el 100% del capital.
  //
  // LA IDEA: esto MODIFICA LA OBLIGACION, no registra un pago. Pone `interesPeriodo`
  // en 0 y baja `cuotaTotal` al capital de las cuotas En Mora. Despues de eso el motor
  // existente funciona SIN casos especiales: el deudor paga el capital por la via
  // normal (el cobro en cascada) y el credito cierra como 'Finalizado' por la rama de
  // /abono, no por un cierre forzoso. Por eso `afectaCaja: false` y por eso este
  // endpoint NO cierra nada por su cuenta (salvo que ya no quede nada que deber).
  //
  // SOLO LAS CUOTAS EN MORA. Las Pendientes las REGENERA `/recalculate` con el interes
  // de vuelta, asi que condonarlas no sobreviviria al siguiente arranque. Las En Mora
  // son las unicas que las 5 rutas que regeneran preservan, y por eso son el unico
  // sitio donde una condonacion es DURABLE. Condonar interes futuro es otro mecanismo
  // (bajar la tasa) y otro sprint.
  //
  // Excluye `Prestamo` (0%: no hay nada que condonar) y `Pago Unico`, cuya ganancia
  // pactada vive ADEMAS en la columna `loans.gananciaFija`: anular el `interesPeriodo`
  // de la cuota dejaria las dos fuentes contradiciendose.
  router.post('/api/loans/:id/condonar-intereses', (req, res) => {
    const { cuotas, observaciones } = req.body;
    const loan = db.prepare('SELECT * FROM loans WHERE id = ?').get(req.params.id);
    if (!loan) return res.status(404).json({ error: 'No encontrado' });
    // `accion` = 'condonacion' tambien como logTipo: el Historial lo pinta con icono y
    // color propios. No se reusa 'pago' (como hizo /corte) porque esto NO es un cobro —
    // confundirlos es justo el error que el endpoint viene a eliminar.
    return mutacionAtomica(req, res, { accion: 'condonacion', endpoint: 'POST /api/loans/:id/condonar-intereses', scopeTipo: 'loan', scopeId: req.params.id }, () => {
      // ── FASE 1: LECTURA + VALIDACION + COMPUTO (sin escrituras) ─────────────
      if (loan.estado !== 'Activo') {
        throw new ClientError('Solo se pueden condonar intereses en creditos activos (este esta ' + loan.estado + ').');
      }
      const PERMITIDAS = ['Intereses', 'Capital + Intereses', MODALIDAD_DIARIA];
      if (PERMITIDAS.indexOf(loan.modalidad) === -1) {
        throw new ClientError('La condonacion de intereses no aplica a la modalidad ' + loan.modalidad +
          (loan.modalidad === 'Prestamo'
            ? ': es un prestamo al 0%, no genera intereses.'
            : ': la ganancia pactada vive en el propio prestamo, no en el interes de la cuota.'));
      }
      const fecha = hoyStr();
      const nota = String(observaciones || '').trim();

      // ── RAMA CREDITO ABIERTO ────────────────────────────────────────────────
      // No hay cuotas que tocar: el interes de un credito abierto no esta
      // materializado en ninguna fila. Vive en `interesAcumuladoPend` (el arrastre)
      // MAS lo que corre desde `fechaUltimoCorte`. Hay que apagar los dos: poner el
      // arrastre en 0 y adelantar la fecha del ultimo corte, o el devengo del tramo
      // abierto reaparece al instante y la condonacion no habria servido de nada.
      if (loan.modalidad === MODALIDAD_DIARIA) {
        const dev = devengoDiario(loan, cortesDe(req.params.id), fecha);
        if (dev.interesPendiente <= 0) {
          throw new ClientError('Este credito no tiene interes devengado pendiente: no hay nada que condonar.');
        }
        const condonado = Math.round(dev.interesPendiente);
        // Cierre estricto de la modalidad: sin capital vivo Y sin devengo, el credito
        // se salda. Tras condonar el devengo queda en 0, asi que basta con el capital.
        const saldado = dev.capitalVivo === 0;
        return {
          descripcion: 'Condonaste $' + condonado.toLocaleString('es-CO') + ' de intereses a ' + loan.nombre +
            ' — interes devengado a la fecha' + (saldado ? ' — credito SALDADO' : '') + (nota ? ' (' + nota + ')' : ''),
          afectaCaja: false,   // no entro ni salio dinero: se redujo la deuda
          payload: { ok: true, condonado: condonado, cuotas: [], saldado: saldado, modalidad: loan.modalidad },
          aplicar: () => {
            db.prepare('UPDATE loans SET interesAcumuladoPend = 0, fechaUltimoCorte = ?, interesesCondonados = COALESCE(interesesCondonados, 0) + ? WHERE id = ?')
              .run(fecha, condonado, req.params.id);
            if (saldado) {
              db.prepare("UPDATE loans SET estado = 'Finalizado', montoCOP = 0 WHERE id = ? AND estado = 'Activo'").run(req.params.id);
            }
          },
        };
      }

      // ── RAMA CON CRONOGRAMA (Intereses / Capital + Intereses) ───────────────
      const mora = db.prepare("SELECT * FROM payments WHERE prestamoId = ? AND estadoPago = 'En Mora' ORDER BY cuotaN")
        .all(req.params.id).filter(p => !esAbono(p));
      if (!mora.length) throw new ClientError('Este credito no tiene cuotas en mora: no hay intereses que condonar.');

      // Seleccion por cuota. Sin lista (o vacia) = todas las cuotas En Mora. Se valida
      // contra el conjunto real en vez de confiar en el cliente: un id de otra cuota
      // —o de otro prestamo— tiene que rebotar con la BD intacta, no colarse.
      const pedidas = Array.isArray(cuotas) ? cuotas.map(String) : null;
      let seleccion = mora;
      if (pedidas && pedidas.length) {
        const porId = new Map(mora.map(p => [String(p.id), p]));
        const ajenas = pedidas.filter(id => !porId.has(id));
        if (ajenas.length) {
          throw new ClientError('Estas cuotas no estan En Mora en este credito: ' + ajenas.join(', ') +
            '. Solo se pueden condonar intereses de cuotas vencidas.');
        }
        seleccion = pedidas.map(id => porId.get(id));
      }

      const condonado = Math.round(seleccion.reduce((s, p) => s + (p.interesPeriodo || 0), 0));
      if (condonado <= 0) {
        throw new ClientError('Las cuotas seleccionadas no tienen intereses: no hay nada que condonar.');
      }

      // Una cuota con MAS dinero encima del que va a costar tras condonar dejaria un
      // sobrante sin donde vivir: `imputarCobros` lo mandaria a `ajuste`, que significa
      // efecto cambiario o residuo de redondeo, no "plata de mas". Se rechaza en vez de
      // tragarselo en silencio; el usuario decide que hacer con ese parcial primero.
      const excedidas = seleccion.filter(p => Math.round(p.partialPaid || 0) > Math.round(p.abonoCapital || 0));
      if (excedidas.length) {
        const c = excedidas[0];
        throw new ClientError('La cuota #' + c.cuotaN + ' ya tiene abonado $' + Math.round(c.partialPaid).toLocaleString('es-CO') +
          ', mas que el capital que quedaria debiendo tras condonar ($' + Math.round(c.abonoCapital).toLocaleString('es-CO') +
          '). Cobrala o revierte ese abono antes de condonar sus intereses.');
      }

      const filas = seleccion.map(p => {
        const capital = Math.round(p.abonoCapital || 0);
        // Tras condonar, la cuota cuesta exactamente su capital. En `Intereses` la mora
        // es puro interes (capital 0), asi que queda en cero: no hay nada que cobrar y
        // su estado terminal es 'Pagado'. Lo mismo si el parcial ya cubria ese capital.
        const cubierta = Math.round(p.partialPaid || 0) >= capital;
        return {
          id: p.id, cuotaN: p.cuotaN, interes: Math.round(p.interesPeriodo || 0),
          capital: capital, saldada: capital <= 0 || cubierta,
        };
      });

      const totalCapital = filas.reduce((s, f) => s + f.capital, 0);
      const nSaldadas = filas.filter(f => f.saldada).length;

      return {
        descripcion: 'Condonaste $' + condonado.toLocaleString('es-CO') + ' de intereses a ' + loan.nombre +
          ' — ' + filas.length + ' cuota' + (filas.length === 1 ? '' : 's') + ' vencida' + (filas.length === 1 ? '' : 's') +
          (totalCapital > 0 ? ' (sigue debiendo $' + totalCapital.toLocaleString('es-CO') + ' de capital)' : '') +
          (nota ? ' (' + nota + ')' : ''),
        afectaCaja: false,   // no entro ni salio dinero: se redujo la deuda
        payload: {
          ok: true, condonado: condonado, modalidad: loan.modalidad,
          cuotas: filas.map(f => ({ id: f.id, cuotaN: f.cuotaN, condonado: f.interes, capitalRestante: f.capital })),
          capitalEnMora: totalCapital, saldadas: nSaldadas,
        },
        aplicar: () => {
          const upd = db.prepare(
            'UPDATE payments SET interesPeriodo = 0, cuotaTotal = ?, estadoPago = ?, observaciones = ? WHERE id = ?');
          filas.forEach(f => {
            const previa = seleccion.find(p => p.id === f.id).observaciones || '';
            const marca = 'Intereses condonados: $' + f.interes.toLocaleString('es-CO') + ' (' + fecha + ')' +
              (nota ? ' — ' + nota : '');
            upd.run(f.capital, f.saldada ? 'Pagado' : 'En Mora',
              previa ? (previa + ' | ' + marca) : marca, f.id);
          });
          // Una fila saldada por condonacion NO produjo caja. Se le limpia el ledger y
          // se le deja `fechaRecaudo` en NULL A PROPOSITO: `cobrosDe` cae al fallback
          // solo si hay `fechaRecaudo`, asi que sin ella no emite ningun evento. Con
          // ella emitiria uno de $0 que ensuciaria "Transacciones del Mes" — y si algun
          // dia `cuotaTotal` no fuera 0, el fallback `montoCOPRecibido || cuotaTotal`
          // declararia como ingreso la cuota entera (el `0` es falsy).
          const limpiar = db.prepare("UPDATE payments SET recibos = '[]', montoCOPRecibido = 0, montoUSDRecibido = 0, fechaRecaudo = NULL, paidAt = NULL WHERE id = ?");
          filas.filter(f => f.saldada && f.capital <= 0).forEach(f => limpiar.run(f.id));

          db.prepare('UPDATE loans SET interesesCondonados = COALESCE(interesesCondonados, 0) + ? WHERE id = ?')
            .run(condonado, req.params.id);

          // Auto-finalizacion, releida DESPUES de escribir (dentro de la transaccion).
          // Sin esto un credito cuyo capital ya estaba pagado quedaria 'Activo' sin nada
          // que deber — y en modalidad Intereses `autoExtendSoloIntereses` seguiria
          // generando cuotas de $0 en cada GET /api/payments.
          const post = db.prepare('SELECT * FROM payments WHERE prestamoId = ?').all(req.params.id);
          const origCOP = loan.moneda === 'USD'
            ? Math.round(loan.montoOrigen * loan.trmAcordada) : Math.round(loan.montoOrigen);
          const capPagado = post.filter(p => p.estadoPago === 'Pagado').reduce((s, p) => s + (p.abonoCapital || 0), 0);
          const quedaMora = post.some(p => p.estadoPago === 'En Mora');
          const quedaPend = post.some(p => p.estadoPago === 'Pendiente' && !esAbono(p));
          if (Math.round(origCOP - capPagado) <= 0 && !quedaMora && !quedaPend) {
            db.prepare("UPDATE loans SET estado = 'Finalizado', montoCOP = 0, cuotaFijaPactada = 0 WHERE id = ? AND estado = 'Activo'")
              .run(req.params.id);
          }
        },
      };
    });
  });

  // ── API: Cambiar día de pago (con prorrateo) ──────────────────────────────
  // Cambia loan.diaPago y regenera el cronograma. La PRIMERA cuota regenerada es
  // TRANSITORIA: su interes se prorratea a los DIAS REALES de su periodo (desde la
  // ultima cuota PAGADA — o fechaInicio — hasta la nueva fecha), NO un mes completo.
  // Las cuotas siguientes reanudan el ciclo normal de un mes. La mora previa se
  // consolida aparte. Solo aplica a Intereses / Capital + Intereses en frecuencia
  // Mensual. Atomico: valida + computa TODO antes de la primera escritura.
  router.post('/api/loans/:id/cambiar-dia-pago', (req, res) => {
    const { nuevoDia } = req.body;
    const loan = db.prepare('SELECT * FROM loans WHERE id = ?').get(req.params.id);
    if (!loan) return res.status(404).json({ error: 'No encontrado' });
    const freq = loan.frecuencia || 'Mensual';
    const nuevoDiaInt = parseInt(nuevoDia, 10);
    return mutacionAtomica(req, res, { accion: 'cambio-fecha', endpoint: 'POST /api/loans/:id/cambiar-dia-pago', scopeTipo: 'loan', scopeId: req.params.id }, () => {
    if (loan.estado !== 'Activo') throw new ClientError('Solo se puede cambiar la fecha de prestamos activos');
    // WHITELIST, no blacklist. Antes esto rechazaba nombrando a 'Prestamo' y 'Pago Unico',
    // de modo que TODA modalidad futura entraba por defecto: el credito abierto —que no
    // tiene cuotas ni dia de pago— alcanzaba el endpoint, se le borraba la mora, se le
    // recalculaba un cronograma mensual y se le persistia `diaPago`/`fechaBaseCronograma`.
    // Una lista de exclusion hay que acordarse de ampliarla; una de admision falla sola.
    if (loan.modalidad !== 'Intereses' && loan.modalidad !== 'Capital + Intereses') {
      throw new ClientError('No aplica para prestamos sin cuotas periodicas mensuales (modalidad: ' + loan.modalidad + ')');
    }
    if (freq !== 'Mensual') throw new ClientError('Cambiar el dia de pago solo aplica a prestamos de frecuencia Mensual');
    if (!nuevoDiaInt || nuevoDiaInt < 1 || nuevoDiaInt > 31) throw new ClientError('Dia invalido');
    if (nuevoDiaInt === loan.diaPago) throw new ClientError('El nuevo dia debe ser distinto al actual');

    // ── FASE 1: LECTURA + VALIDACION + COMPUTO (sin escrituras) ───────────────
    const allPays = db.prepare('SELECT * FROM payments WHERE prestamoId = ? ORDER BY cuotaN').all(req.params.id);
    const regularesTodas = allPays.filter(p => !esAbono(p)); // regla canonica '-ab-'

    // Mora a consolidar: intereses de las cuotas En Mora regulares -> se suman a la 1a cuota nueva
    const morasRegulares = regularesTodas.filter(p => p.estadoPago === 'En Mora');
    const moraCount = morasRegulares.length;
    const moraConsolidada = Math.round(morasRegulares.reduce((s, p) => s + p.interesPeriodo, 0));

    // Punto de partida: cuotas ya PAGADAS (las En Mora se borran; su capital vuelve al residual y
    // se re-amortiza, simetrico con regularConsumed = solo Pagadas — misma doctrina que hoy).
    const pagadasRegulares = regularesTodas.filter(p => p.estadoPago === 'Pagado');
    const regularConsumed = pagadasRegulares.length;
    const nextRegularN = regularConsumed + 1;

    // Saldo actual (capital pendiente). Solo Pagadas -> simetrico con regularConsumed.
    const originalCOP = loan.moneda === 'USD' ? Math.round(loan.montoOrigen * loan.trmAcordada) : Math.round(loan.montoOrigen);
    const todoCapPagado = pagadasRegulares.reduce((s, p) => s + p.abonoCapital, 0);
    const saldoActual = Math.max(0, originalCOP - todoCapPagado);
    if (saldoActual <= 0) throw new ClientError('El prestamo no tiene saldo pendiente');

    // CUOTA TRANSITORIA: prorratear el interes de la 1a cuota a los DIAS REALES de su periodo.
    // Referencia = fechaPago de la ultima cuota PAGADA (o fechaInicio si aun no hay pagos).
    // diasReales = nuevaFecha - referencia. La mora ya cubre su propio periodo (se suma aparte).
    const lastSettledDate = pagadasRegulares.length > 0
      ? pagadasRegulares.map(p => p.fechaPago).sort().slice(-1)[0]
      : loan.fechaInicio;
    // Regla "NUNCA ADELANTAR EL COBRO": si el nuevo dia dejaria la 1a cuota ANTES de la que ya
    // estaba agendada (mismo mes, dia menor), se rueda la base del cronograma +1 mes -> el pago
    // queda PROYECTADO HACIA ADELANTE (aplazamiento). Se persiste en fechaBaseCronograma para que
    // el salto sobreviva a /recalculate y PUT /loans (buildSchedule usa esa base para las fechas).
    const baseActual = loan.fechaBaseCronograma || loan.fechaInicio;
    const origNextDate = getPayDate(baseActual, nextRegularN, loan.diaPago, freq);   // fecha ya agendada
    const naiveDate    = getPayDate(baseActual, nextRegularN, nuevoDiaInt, freq);
    let baseCron = baseActual;
    if (naiveDate < origNextDate) {
      const b = new Date(baseActual + 'T12:00:00');
      b.setDate(1);                    // evita overflow de mes antes de sumar
      b.setMonth(b.getMonth() + 1);
      baseCron = b.toISOString().split('T')[0];
    }
    const firstNewDate = getPayDate(baseCron, nextRegularN, nuevoDiaInt, freq);
    const MS_DIA = 24 * 60 * 60 * 1000;
    const rawDias = Math.round((new Date(firstNewDate + 'T12:00:00') - new Date(lastSettledDate + 'T12:00:00')) / MS_DIA);
    const diasReales = Math.max(1, rawDias);
    const interesProrrateado = Math.round(saldoActual * (loan.tasaMensual / 100) * diasReales / 30);

    // Regenerar cronograma con el nuevo dia y convertir la primera cuota en transitoria.
    const loanConNuevoDia = Object.assign({}, loan, { diaPago: nuevoDiaInt, fechaBaseCronograma: baseCron });
    const indefinido = loan.modalidad === 'Intereses';
    const remaining = indefinido ? 3 : Math.max(1, (loan.plazoMeses || 12) - regularConsumed);
    let nuevasCuotas = buildSchedule(loanConNuevoDia, nextRegularN, saldoActual, remaining);

    // ── GUARDA DEFENSIVA: NUNCA sobrescribir una cuota ya PAGADA ───────────────
    // Este endpoint tiene una asimetria propia: BORRA las cuotas En Mora pero cuenta como
    // consumidas SOLO las Pagadas (regularConsumed, arriba). Si las Pagadas no son contiguas
    // —estado normal cuando el deudor abona el mes corriente y arrastra cuotas viejas— entonces
    // nextRegularN queda POR DEBAJO del cuotaN de una Pagada existente, y como los ids son
    // deterministas (`${loanId}-${cuotaN}`) e insPayment es INSERT OR REPLACE, la fila Pagada
    // se reemplazaba EN SILENCIO por una Pendiente nueva: se perdian estadoPago, fechaRecaudo,
    // montoCOPRecibido, paidAt y el ledger `recibos`, y el capital de esa cuota dejaba de contar
    // en la formula canonica de saldo -> la deuda del cliente SUBIA sola.
    // (Defecto preexistente detectado en la auditoria adversarial de la Fase 1 de undo; reproducido
    //  sobre la BD real: un pago de $265.000 destruido y el saldo inflado en $162.761.)
    // Se saltan esos ids. Mismo patron defensivo que autoExtendSoloIntereses, que ya comprueba
    // la existencia antes de insertar. NO cambia la doctrina financiera del prorrateo: el filtro
    // se aplica ANTES de marcar la cuota transitoria, de modo que la transitoria siempre recae
    // sobre una fila que si se va a insertar.
    const idsPagadas = new Set(pagadasRegulares.map(p => p.id));
    const cuotasProtegidas = nuevasCuotas.filter(p => idsPagadas.has(p.id)).map(p => p.cuotaN);
    if (cuotasProtegidas.length > 0) {
      nuevasCuotas = nuevasCuotas.filter(p => !idsPagadas.has(p.id));
    }

    // DURABILIDAD DE LO COBRADO (ver /abono): este endpoint borra Pendientes Y En Mora, asi que
    // el snapshot cubre ambas. Restaurar ANTES de marcar la transitoria es deliberado: asi la
    // etiqueta "Cuota transitoria..." (que se escribe justo abajo) prevalece sobre la observacion
    // vieja en vez de ser pisada por ella. El parcial de una cuota En Mora viaja al mismo cuotaN,
    // que es coherente: la transitoria absorbe precisamente el interes de esa mora.
    const cobrosPrevFecha = snapshotCobros(regularesTodas.filter(p => p.estadoPago === 'Pendiente' || p.estadoPago === 'En Mora'));
    abortarSiHuerfanos(nuevasCuotas, cobrosPrevFecha);
    restaurarCobros(nuevasCuotas, cobrosPrevFecha);

    let netAdj = 0;
    if (nuevasCuotas.length > 0) {
      const primera = nuevasCuotas[0];
      const fullInt = primera.interesPeriodo;          // interes de mes completo que calculo buildSchedule
      const deltaInt = fullInt - interesProrrateado;   // reduccion por periodo corto (negativo si el periodo es > 1 mes)
      // Ajuste NETO con signo = (prorrateo + mora) - full. Se persiste para sobrevivir a /recalculate y PUT /loans.
      netAdj = Math.round(moraConsolidada - deltaInt);
      // interesPeriodo = interes prorrateado + mora; cuotaTotal baja el delta y suma la mora.
      // abonoCapital y saldoFinal quedan INTACTOS -> amortizacion (Capital + Intereses) preservada.
      primera.interesPeriodo = Math.round(interesProrrateado + moraConsolidada);
      primera.cuotaTotal = Math.round(primera.cuotaTotal - deltaInt + moraConsolidada);
      primera.extraConsolidado = netAdj;
      primera.observaciones = 'Cuota transitoria: interes de ' + diasReales + ' dias prorrateado'
        + (moraConsolidada > 0 ? ' + mora consolidada $' + moraConsolidada.toLocaleString('es-CO') : '');
    }

    // ── FASE 2: ESCRITURA — la ejecuta mutacionAtomica dentro de UNA transaccion.
    const logMsg = 'Cambiaste dia de pago de ' + loan.nombre + ' del ' + loan.diaPago + ' al ' + nuevoDiaInt
      + ' - 1a cuota transitoria de ' + diasReales + ' dias (interes $' + interesProrrateado.toLocaleString('es-CO') + ')'
      + (moraCount > 0 ? ' + ' + moraCount + ' cuota' + (moraCount > 1 ? 's' : '') + ' en mora ($' + moraConsolidada.toLocaleString('es-CO') + ')' : '');

    return {
      descripcion: logMsg,
      payload: {
        ok: true,
        nuevoDia: nuevoDiaInt,
        primeraCuota: nuevasCuotas[0] || null,
        // Radiografia de la cuota transitoria para el modal: capital (amortizacion normal, intacta),
        // interes prorrateado (solo dias reales) y total. capitalCuota = abonoCapital de la 1a cuota.
        capitalCuota: nuevasCuotas.length > 0 ? nuevasCuotas[0].abonoCapital : 0,
        cuotaTotalTransitoria: nuevasCuotas.length > 0 ? nuevasCuotas[0].cuotaTotal : 0,
        cuotasRecurrentes: nuevasCuotas.length > 1 ? nuevasCuotas[1].cuotaTotal : (nuevasCuotas[0] ? nuevasCuotas[0].cuotaTotal - netAdj : 0),
        moraConsolidada: moraConsolidada,
        prorrateo: interesProrrateado,
        diasReales: diasReales,
        moraCount: moraCount,
        // Cuotas ya Pagadas que la guarda defensiva protegio de ser sobrescritas (normalmente []).
        cuotasProtegidas: cuotasProtegidas
      },
      aplicar: () => {
        // Borrar Pendientes + En Mora regulares (preserva Pagadas y abonos '-ab-')
        db.prepare("DELETE FROM payments WHERE prestamoId = ? AND estadoPago IN ('Pendiente','En Mora') AND id NOT LIKE '%-ab-%'").run(req.params.id);
        db.prepare('UPDATE loans SET diaPago = ?, fechaBaseCronograma = ? WHERE id = ?').run(nuevoDiaInt, baseCron, req.params.id);
        // Persistir el ajuste NETO con signo (proximaCuotaExtra) para reproducir la cuota transitoria
        // al regenerar. /recalculate y PUT /loans aplican `+= extra` con guard `!== 0`.
        db.prepare('UPDATE loans SET proximaCuotaExtra = ?, proximaCuotaExtraN = ? WHERE id = ?')
          .run(netAdj, nuevasCuotas.length > 0 ? nuevasCuotas[0].cuotaN : 0, req.params.id);
        if (nuevasCuotas.length > 0) insertSchedule(nuevasCuotas);
      }
    };
    });
  });

  return router;
};
