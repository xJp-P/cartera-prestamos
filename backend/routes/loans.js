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
    ClientError, hoyStr,
  } = ctx;
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
          tasaMensual,plazoMeses,modalidad,fechaInicio,diaPago,estado,notas,frecuencia,fechaDevolucion,comprasUSD,gananciaFija)
        VALUES (@id,@nombre,@cedula,@telefono,@moneda,@montoOrigen,@trmAcordada,@montoCOP,
          @tasaMensual,@plazoMeses,@modalidad,@fechaInicio,@diaPago,@estado,@notas,@frecuencia,@fechaDevolucion,@comprasUSD,@gananciaFija)
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
      const interesesPerdidos = Math.round(allPays
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
