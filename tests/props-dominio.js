// tests/props-dominio.js — PRUEBAS DE PROPIEDADES sobre los helpers de dominio REALES.
//
// Que es esto: no verifica "casos de ejemplo", verifica INVARIANTES. Cada seccion toma el
// helper REAL extraido de `public/index.html` (via cargarFrontend, que lo EJECUTA en un
// contexto vm) y lo corre contra las 157 filas de `payments` y los 26 `loans` de una COPIA
// de la BD de produccion, comprobando propiedades que deben valer para TODA fila.
//
// Por que importa: la doctrina de la Fase 1-3 (imputacion en cascada interes -> capital,
// ledger `recibos` con fallback excluyente, los DOS saldos) no esta expresada en ningun
// tipo ni en ninguna firma. Vive en comentarios. Este archivo la convierte en algo que
// falla si alguien la rompe durante el refactor.
//
// ANTI-VERDE-EN-VACIO (regla 4 del blueprint): no basta con "0 violaciones". Una propiedad
// sobre 0 filas es un verde mentiroso. Por eso cada seccion:
//   (a) cuenta cuantas filas/eventos EVALUO y lo imprime;
//   (b) asserta un PISO de cobertura -> si la fuente de datos se vacia, la suite falla;
//   (c) cuando la propiedad NO tiene testigos en produccion, se construyen CASOS DERIVADOS
//       a partir de filas reales (seccion 3) en vez de dejar el assert vacio.
//
// Dos invariantes resultaron VACUOS sobre la cartera real y se documentan como tales:
//   - La cascada interes -> capital: los 79 eventos de caja de produccion cubren siempre el
//     interes completo de su cuota, asi que NINGUNO ejerce la rama "capital debe ser 0".
//   - La resta de parciales en curso en computeLiquidacion: las 32 filas con partialPaid>0
//     estan TODAS en estado Pagado, asi que `partialPend` es 0 en los 12 activos.
// Ambos se cubren con casos derivados (secciones 3 y 7b) que perturban filas reales
// imitando lo que escribe `POST /payments/:id/partial`.
//
// Correr:
//   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron tests/props-dominio.js

const path = require('path');
const { Reporter }          = require('./lib/report');
const { copiaDeProduccion } = require('./lib/db');
const { cargarFrontend }    = require('./lib/load-frontend');
const { REPO }              = require('./lib/paths');

const R = new Reporter('props-dominio');

// ── Tolerancias, explicitas y justificadas ───────────────────────────────────
//
// TOL_IDENTIDAD = 0 (EXACTO). No es optimismo: `imputarCobros` calcula
// `ajuste = cop - interes - capital` sobre enteros (cop viene de Math.round, interes y
// capital son Math.min de enteros), asi que la identidad es aritmetica entera y cualquier
// desvio de 1 peso es un bug real, no ruido. Aceptar 0.5 aqui seria tapar justo la clase
// de fallo que el helper existe para impedir.
const TOL_IDENTIDAD = 0;
//
// TOL_REDONDEO = 5 pesos. Absorbe el residuo legacy del Bug #43 (buildSchedule calculaba a
// 2 decimales y persistia enteros): medido sobre la cartera real son 1-3 pesos en 4
// prestamos. Se usa SOLO donde se compara la composicion del motor contra si misma
// (`abonoCapital` vs `cuotaTotal - interesPeriodo`), NUNCA para la identidad de caja.
const TOL_REDONDEO = 5;

// Pisos de cobertura. Son floors, no igualdades: la BD del usuario crece con el uso y una
// igualdad exacta convertiria cada cobro nuevo en un falso rojo. Si la cifra real cae por
// DEBAJO del piso, la suite falla: significa que el test dejo de estar mirando datos.
const PISO = {
  payments: 100, loans: 20, eventos: 40, conLedger: 10, conFallback: 30,
  saldadasConEventos: 40, loansConFlujo: 15, filasFlujo: 40, activos: 5,
  // Interes Diario: el credito sintetico de tests/fixture/credito-diario.js. Es un PISO
  // y no un "si existe, comprueba" A PROPOSITO — sin el, toda la seccion 8 daria VERDE EN
  // VACIO, que es peor que fallar: pareceria que los invariantes del corte estan
  // protegidos cuando en realidad no se evaluo ni una fila.
  loansDiarios: 1, cortes: 2,
};

function main() {
  // ── Carga ────────────────────────────────────────────────────────────────
  R.seccion('0. Carga del instrumental (guardas anti-vacio)');

  const dbPath = copiaDeProduccion('props');
  // better-sqlite3 esta compilado para el ABI de Electron; por eso esto corre bajo
  // ELECTRON_RUN_AS_NODE. Se abre READONLY sobre la COPIA: doble red de seguridad.
  const Database = require(path.join(REPO, 'node_modules', 'better-sqlite3'));
  const db = new Database(dbPath, { readonly: true });

  const loans = db.prepare('SELECT * FROM loans').all();
  const pays  = db.prepare('SELECT * FROM payments').all();
  const byLoan = {};
  loans.forEach(function (l) { byLoan[String(l.id)] = l; });
  const paysDe = function (l) {
    return pays.filter(function (p) { return String(p.prestamoId) === String(l.id); });
  };

  const { simbolos, meta } = cargarFrontend({ silenciarConsola: true });
  const H = {};
  const NECESARIOS = ['cobrosDe', 'imputarCobros', 'saldoConCaja', 'pendienteDeCuota',
                      'pendCuota', 'flujoCajaDe', 'computeLiquidacion',
                      // Predicados de clasificacion (core/ids.js). Se exigen aqui para que
                      // la seccion 8 no pueda "pasar" por no haberlos encontrado.
                      'esAbono', 'esCorte', 'esCuotaRegular',
                      // Espejo del motor de devengo (Etapa 4). Se exigen aqui para que la
                      // comprobacion de equivalencia no pueda "pasar" por no encontrarlos.
                      'devengoDiario', 'estadoDiario', 'esDiario', 'progresoCapital'];
  const faltantes = [];
  NECESARIOS.forEach(function (n) {
    if (typeof simbolos[n] === 'function') H[n] = simbolos[n];
    else faltantes.push(n);
  });

  console.log(`   frontend: ${meta.origen} lineas ${meta.lineas}, ${meta.nSimbolos} simbolos top-level`);
  console.log(`   BD copia: loans=${loans.length}  payments=${pays.length}`);

  R.check(`los ${NECESARIOS.length} helpers de dominio se cargaron como funciones`,
    faltantes.length === 0, faltantes.length ? `faltan: ${faltantes.join(', ')}` : undefined);
  // Si falta un helper no tiene sentido seguir: todo lo demas seria verde en vacio.
  if (faltantes.length) return R.finalizar();

  R.check(`la BD trae al menos ${PISO.payments} payments (real: ${pays.length})`, pays.length >= PISO.payments);
  R.check(`la BD trae al menos ${PISO.loans} loans (real: ${loans.length})`, loans.length >= PISO.loans);
  if (pays.length === 0 || loans.length === 0) return R.finalizar();

  // Helper local: parsea el ledger crudo tal como lo hace produccion.
  const ledgerDe = function (p) {
    let arr = null;
    try { arr = JSON.parse(p.recibos || 'null'); } catch (_) { arr = null; }
    return Array.isArray(arr) && arr.length ? arr : null;
  };
  const esAbono = function (p) { return String(p.id).indexOf('-ab-') !== -1; };
  const origCOPDe = function (l) {
    return l.moneda === 'USD' ? Math.round(l.montoOrigen * l.trmAcordada) : Math.round(l.montoOrigen);
  };
  // Formatea una lista de violaciones para el detalle del fallo, sin volcar 157 filas.
  const muestra = function (arr, n) {
    return JSON.stringify(arr.slice(0, n || 6), null, 2) + (arr.length > (n || 6) ? `\n… y ${arr.length - (n || 6)} mas` : '');
  };

  // ══════════════════════════════════════════════════════════════════════════
  R.seccion('1. cobrosDe(p) — eventos de caja: ledger O fallback, NUNCA ambos');
  // ══════════════════════════════════════════════════════════════════════════
  {
    const malFormato = [], copInvalido = [], ledgerNoFiel = [], fallbackNoFiel = [], dobleConteo = [];
    let conLedger = 0, conFallback = 0, sinEventos = 0, totalEventos = 0, observables = 0;
    const RE_FECHA = /^\d{4}-\d{2}-\d{2}$/;

    pays.forEach(function (p) {
      const ev = H.cobrosDe(p);
      if (!Array.isArray(ev)) { malFormato.push({ id: p.id, motivo: 'no devolvio array' }); return; }
      totalEventos += ev.length;

      ev.forEach(function (e) {
        if (!e || typeof e.fecha !== 'string' || !RE_FECHA.test(e.fecha) ||
            isNaN(new Date(e.fecha + 'T12:00:00').getTime())) {
          malFormato.push({ id: p.id, fecha: e && e.fecha });
        }
        if (!Number.isFinite(e && e.cop) || e.cop < 0) copInvalido.push({ id: p.id, cop: e && e.cop });
      });

      const led = ledgerDe(p);
      if (led) {
        conLedger++;
        // EXCLUSIVIDAD: el resultado debe ser EXACTAMENTE el ledger (filtrado a cop>0),
        // nunca el ledger MAS el evento de fallback.
        const esperado = led.filter(function (r) { return r && r.fecha && (+r.cop) > 0; })
                            .map(function (r) { return { fecha: String(r.fecha), cop: Math.round(+r.cop) }; });
        if (JSON.stringify(ev) !== JSON.stringify(esperado)) {
          ledgerNoFiel.push({ id: p.id, obtenido: ev, esperado: esperado });
        }
        // Doble conteo OBSERVABLE: esta fila tambien califica para el fallback
        // (Pagado + fechaRecaudo). Si el helper sumara ambas fuentes se veria aqui.
        if (p.estadoPago === 'Pagado' && p.fechaRecaudo) {
          observables++;
          const sumLedger = esperado.reduce(function (s, e) { return s + e.cop; }, 0);
          const fallback  = Math.round(p.montoCOPRecibido || p.cuotaTotal);
          const sumReal   = ev.reduce(function (s, e) { return s + e.cop; }, 0);
          if (sumReal !== sumLedger || ev.length !== esperado.length) {
            dobleConteo.push({ id: p.id, sumReal, sumLedger, fallback, nEv: ev.length, nLedger: esperado.length });
          }
        }
      } else if (ev.length) {
        conFallback++;
        // FALLBACK: exactamente un evento, en fechaRecaudo, por montoCOPRecibido||cuotaTotal.
        const okUno = ev.length === 1;
        const okFec = okUno && ev[0].fecha === p.fechaRecaudo;
        const okCop = okUno && ev[0].cop === Math.round(p.montoCOPRecibido || p.cuotaTotal);
        if (!okUno || !okFec || !okCop) fallbackNoFiel.push({ id: p.id, ev, fechaRecaudo: p.fechaRecaudo });
      } else {
        sinEventos++;
      }
    });

    console.log(`   filas: ${pays.length} | con ledger: ${conLedger} | por fallback: ${conFallback} | sin caja: ${sinEventos}`);
    console.log(`   eventos de caja emitidos: ${totalEventos} | filas donde el doble conteo seria observable: ${observables}`);

    R.check(`toda fecha con formato YYYY-MM-DD valido (${totalEventos} eventos)`, malFormato.length === 0, muestra(malFormato));
    R.check(`todo cop finito y >= 0 (${totalEventos} eventos)`, copInvalido.length === 0, muestra(copInvalido));
    R.check(`las ${conLedger} filas con ledger devuelven EXACTAMENTE el ledger`, ledgerNoFiel.length === 0, muestra(ledgerNoFiel, 3));
    R.check(`las ${conFallback} filas sin ledger devuelven 1 evento en fechaRecaudo`, fallbackNoFiel.length === 0, muestra(fallbackNoFiel, 3));
    R.check(`SIN DOBLE CONTEO en las ${observables} filas con ledger que ademas califican para fallback`,
      dobleConteo.length === 0, muestra(dobleConteo, 3));
    R.check(`cobertura: >= ${PISO.conLedger} filas con ledger (real: ${conLedger})`, conLedger >= PISO.conLedger);
    R.check(`cobertura: >= ${PISO.conFallback} filas por fallback (real: ${conFallback})`, conFallback >= PISO.conFallback);
    R.check(`cobertura: >= ${PISO.eventos} eventos de caja evaluados (real: ${totalEventos})`, totalEventos >= PISO.eventos);

    // ── CASOS DERIVADOS: bordes del contrato que produccion NO ejerce ──────────
    // Medido sobre la cartera: 0 filas con un evento de ledger en cop <= 0 y 0 filas
    // NO-Pagadas que arrastren fechaRecaudo. Sin estos casos, dos regresiones tipicas de
    // refactor pasan inadvertidas (ambas verificadas con mutacion sobre el codigo real):
    // aflojar el filtro `(+r.cop)>0` a `>=0`, y quitar el gate `estadoPago==='Pagado'` del
    // fallback — que emitiria caja por una cuota En Mora y la contaria como cobrada.
    const baseLed = pays.find(function (p) { return ledgerDe(p); });
    const basePag = pays.find(function (p) { return p.estadoPago === 'Pagado' && p.fechaRecaudo && !ledgerDe(p); });
    R.check('existen filas reales como base de los bordes de cobrosDe', !!baseLed && !!basePag,
      `conLedger=${!!baseLed} conFallback=${!!basePag}`);

    if (baseLed && basePag) {
      const conCero = Object.assign({}, baseLed, { recibos: JSON.stringify([
        { fecha: '2026-06-01', cop: 0 }, { fecha: '2026-06-02', cop: 12345 }, { fecha: '2026-06-03', cop: -500 },
      ]) });
      R.eq('un evento de ledger en cop 0 (o negativo) NO se emite',
        H.cobrosDe(conCero), [{ fecha: '2026-06-02', cop: 12345 }]);

      R.eq('el fallback EXIGE estadoPago Pagado: una fila En Mora con fechaRecaudo no emite caja',
        H.cobrosDe(Object.assign({}, basePag, { estadoPago: 'En Mora' })), []);
      R.eq('idem con una fila Pendiente que arrastra fechaRecaudo',
        H.cobrosDe(Object.assign({}, basePag, { estadoPago: 'Pendiente' })), []);
      R.eq('sin fechaRecaudo tampoco hay fallback',
        H.cobrosDe(Object.assign({}, basePag, { fechaRecaudo: null })), []);
      // Todos los cop del ledger real ya son enteros, asi que perder el Math.round no se nota
      // sobre la cartera; pero un cop fraccionario se propaga a TODOS los KPIs de caja.
      R.eq('el cop del ledger se redondea a pesos enteros',
        H.cobrosDe(Object.assign({}, baseLed, { recibos: JSON.stringify([{ fecha: '2026-06-02', cop: 12345.6 }]) })),
        [{ fecha: '2026-06-02', cop: 12346 }]);

      // El ledger manda aunque la fila NO este Pagada: asi es como vive un parcial en curso
      // (/partial escribe partialPaid + recibos y NO toca estadoPago — Bug #39).
      R.eq('una fila NO pagada CON ledger si emite sus eventos (parcial en curso)',
        H.cobrosDe(Object.assign({}, basePag, { estadoPago: 'Pendiente',
          recibos: JSON.stringify([{ fecha: '2026-06-05', cop: 7777 }]) })),
        [{ fecha: '2026-06-05', cop: 7777 }]);
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  R.seccion('2. imputarCobros(pay) — NUCLEO: cascada interes -> capital');
  // ══════════════════════════════════════════════════════════════════════════

  // Base de capital tal como la documenta el helper: se ancla a `abonoCapital` (misma base
  // que la formula canonica de saldo) y solo cae a la reconciliacion `cuotaTotal - interes`
  // cuando la columna viene en 0 con cuota viva (capital fantasma legacy, Bugs #30/#34).
  const capBaseDe = function (p) {
    const intTot = Math.round(p.interesPeriodo || 0);
    let cap = Math.round(p.abonoCapital || 0);
    const reconc = Math.round(p.cuotaTotal || 0) - intTot;
    if (cap <= 0 && reconc > 0) cap = reconc;
    return cap < 0 ? 0 : cap;
  };

  // Verificador de propiedades reutilizable: se aplica a las filas REALES (seccion 2) y a
  // los CASOS DERIVADOS (seccion 3). Devuelve la lista de invariantes violados.
  const propiedadesImputacion = function (p, etiqueta) {
    const v = [];
    const imp = H.imputarCobros(p);
    const intTot = Math.round(p.interesPeriodo || 0);
    const capTot = capBaseDe(p);
    let ci = 0, cc = 0, ccop = 0;

    imp.eventos.forEach(function (e, i) {
      // (1) IDENTIDAD POR EVENTO — exacta.
      if (Math.abs(e.cop - e.interes - e.capital - e.ajuste) > TOL_IDENTIDAD) {
        v.push({ id: p.id, etiqueta, inv: 'identidad', i, e });
      }
      if (e.interes < 0 || e.capital < 0) v.push({ id: p.id, etiqueta, inv: 'rubro negativo', i, e });

      const ciPrev = ci, ccPrev = cc, ccopPrev = ccop;
      ci += e.interes; cc += e.capital; ccop += e.cop;

      // (2) CASCADA: mientras el interes acumulado no cubra interesPeriodo, capital = 0.
      if (ci < intTot && cc !== 0) {
        v.push({ id: p.id, etiqueta, inv: 'cascada', i, ciAcum: ci, intTot, ccAcum: cc });
      }
      // (5) MONOTONIA: los acumulados nunca decrecen.
      if (ci < ciPrev || cc < ccPrev || ccop < ccopPrev) {
        v.push({ id: p.id, etiqueta, inv: 'monotonia', i });
      }
    });

    // (3) NO SOBRE-IMPUTA.
    if (imp.totales.interes > intTot) v.push({ id: p.id, etiqueta, inv: 'interes > interesPeriodo', t: imp.totales.interes, intTot });
    if (imp.totales.capital > capTot) v.push({ id: p.id, etiqueta, inv: 'capital > base de capital', t: imp.totales.capital, capTot });
    // Forma estricta del enunciado, valida donde la columna del motor es utilizable.
    if (Math.round(p.abonoCapital || 0) > 0 && imp.totales.capital > Math.round(p.abonoCapital)) {
      v.push({ id: p.id, etiqueta, inv: 'capital > abonoCapital', t: imp.totales.capital, ac: p.abonoCapital });
    }
    // Coherencia de totales con los eventos.
    if (imp.totales.interes !== ci || imp.totales.capital !== cc || imp.totales.cobrado !== ccop) {
      v.push({ id: p.id, etiqueta, inv: 'totales != suma de eventos' });
    }
    return { violaciones: v, imp, intTot, capTot };
  };

  {
    const viol = [], reconcMal = [], pagadasSinEventos = [], ajusteRaro = [], sinLedgerMal = [];
    let filasConEventos = 0, eventosEval = 0, saldadasConEventos = 0, conAjuste = 0, usaronFallbackCap = 0;
    let cajaSuperaParcial = 0;

    pays.forEach(function (p) {
      const r = propiedadesImputacion(p, 'real');
      viol.push.apply(viol, r.violaciones);
      if (r.imp.eventos.length) { filasConEventos++; eventosEval += r.imp.eventos.length; }

      // `sinLedger` = dinero en partialPaid que NINGUN evento representa (filas legacy previas
      // al ledger v1.11.4). Es un MAXIMO CON 0: en las 19 filas con ledger la caja supera al
      // partialPaid, asi que sin el clamp saldria negativo y el consumidor lo leeria como
      // "falta registrar plata" al reves. Nadie lo verificaba.
      if (!(r.imp.sinLedger >= 0)) sinLedgerMal.push({ id: p.id, sinLedger: r.imp.sinLedger });
      if (r.imp.totales.cobrado > Math.round(p.partialPaid || 0)) cajaSuperaParcial++;
      if (Math.round(p.abonoCapital || 0) <= 0 && r.capTot > 0 && r.imp.eventos.length) usaronFallbackCap++;

      // (4) RECONCILIACION EN CUOTAS SALDADAS.
      if (p.estadoPago === 'Pagado') {
        if (!r.imp.eventos.length) {
          // Una cuota Pagada sin ningun evento de caja haria que saldoConCaja QUEDE POR
          // ENCIMA del saldo del motor (seccion 3): el capital cobrado no se veria.
          pagadasSinEventos.push({ id: p.id, fechaRecaudo: p.fechaRecaudo, recibos: p.recibos });
        } else {
          saldadasConEventos++;
          if (r.imp.totales.interes !== r.intTot || r.imp.totales.capital !== r.capTot) {
            reconcMal.push({ id: p.id, int: r.imp.totales.interes, intTot: r.intTot,
                             cap: r.imp.totales.capital, capTot: r.capTot });
          }
        }
      }

      // Taxonomia del `ajuste`: el helper documenta DOS origenes legitimos — el efecto
      // cambiario en USD y el residuo de redondeo del Bug #43 en COP. Un hueco grande en
      // un prestamo COP no tiene explicacion y seria un bug.
      r.imp.eventos.forEach(function (e) {
        if (e.ajuste === 0) return;
        conAjuste++;
        const l = byLoan[String(p.prestamoId)];
        if (Math.abs(e.ajuste) > TOL_REDONDEO && !(l && l.moneda === 'USD')) {
          ajusteRaro.push({ id: p.id, ajuste: e.ajuste, moneda: l && l.moneda });
        }
      });
    });

    console.log(`   filas evaluadas: ${pays.length} | con eventos: ${filasConEventos} | eventos imputados: ${eventosEval}`);
    console.log(`   saldadas con eventos: ${saldadasConEventos} | eventos con ajuste!=0: ${conAjuste} | filas que usaron el fallback de capital: ${usaronFallbackCap}`);

    const porInv = function (nombre) { return viol.filter(function (x) { return x.inv === nombre; }); };
    R.check(`(1) identidad interes+capital+ajuste === cop en los ${eventosEval} eventos (tolerancia ${TOL_IDENTIDAD}, exacta)`,
      porInv('identidad').length === 0, muestra(porInv('identidad')));
    R.check('(2) cascada: capital = 0 mientras el interes acumulado no cubra interesPeriodo',
      porInv('cascada').length === 0, muestra(porInv('cascada')));
    R.check('(3a) el interes imputado nunca supera interesPeriodo',
      porInv('interes > interesPeriodo').length === 0, muestra(porInv('interes > interesPeriodo')));
    R.check('(3b) el capital imputado nunca supera la base de capital de la cuota',
      porInv('capital > base de capital').length === 0, muestra(porInv('capital > base de capital')));
    R.check('(3c) el capital imputado nunca supera abonoCapital (filas con abonoCapital > 0)',
      porInv('capital > abonoCapital').length === 0, muestra(porInv('capital > abonoCapital')));
    R.check(`(4) las ${saldadasConEventos} cuotas Pagadas reconcilian EXACTO con interesPeriodo/abonoCapital`,
      reconcMal.length === 0, muestra(reconcMal));
    R.check('(5) los acumulados de interes/capital/cobrado nunca decrecen',
      porInv('monotonia').length === 0, muestra(porInv('monotonia')));
    R.check('los totales devueltos coinciden con la suma de los eventos',
      porInv('totales != suma de eventos').length === 0, muestra(porInv('totales != suma de eventos')));
    R.check('ningun rubro imputado es negativo',
      porInv('rubro negativo').length === 0, muestra(porInv('rubro negativo')));
    R.check('toda cuota Pagada tiene al menos un evento de caja (premisa de saldoConCaja <= motor)',
      pagadasSinEventos.length === 0, muestra(pagadasSinEventos));
    R.check(`taxonomia del ajuste: todo hueco > ${TOL_REDONDEO} pesos ocurre en un prestamo USD (efecto TRM)`,
      ajusteRaro.length === 0, muestra(ajusteRaro));
    R.check(`sinLedger nunca negativo (${cajaSuperaParcial} filas donde la caja supera a partialPaid)`,
      sinLedgerMal.length === 0, muestra(sinLedgerMal));
    R.check('cobertura: hay filas donde la caja supera a partialPaid (el clamp de sinLedger muerde)',
      cajaSuperaParcial >= 5, `real: ${cajaSuperaParcial}`);
    R.check(`cobertura: >= ${PISO.saldadasConEventos} cuotas saldadas evaluadas (real: ${saldadasConEventos})`,
      saldadasConEventos >= PISO.saldadasConEventos);
    R.check(`cobertura: >= ${PISO.eventos} eventos imputados (real: ${eventosEval})`, eventosEval >= PISO.eventos);
  }

  // ══════════════════════════════════════════════════════════════════════════
  R.seccion('3. imputarCobros — CASOS DERIVADOS (la cascada no tiene testigos en produccion)');
  // ══════════════════════════════════════════════════════════════════════════
  //
  // HONESTIDAD DEL ARNES: sobre la cartera real, los 79 eventos de caja cubren SIEMPRE el
  // interes completo de su cuota, asi que la rama "capital debe seguir en 0" de la cascada
  // NUNCA se ejecuta. Un assert sobre 0 testigos es exactamente el verde en vacio que este
  // instrumental existe para evitar. Aqui se construyen parciales a partir de una fila REAL,
  // imitando lo que escribe `POST /payments/:id/partial` (partialPaid + ledger `recibos`,
  // sin tocar estadoPago), y se corre el MISMO verificador de propiedades.
  {
    const base = pays.find(function (p) {
      return p.estadoPago === 'Pagado' && !esAbono(p) &&
             Math.round(p.interesPeriodo) > 1000 && Math.round(p.abonoCapital) > 1000;
    });
    R.check('existe una fila real usable como base de los casos derivados', !!base,
      'se necesita una cuota Pagada, no-abono, con interes y capital > 1000');

    if (base) {
      const intTot = Math.round(base.interesPeriodo);
      const cuota  = Math.round(base.cuotaTotal);
      console.log(`   base real: ${base.id}  interes=${intTot}  capital=${Math.round(base.abonoCapital)}  cuota=${cuota}`);

      // Un parcial en curso que NO alcanza a cubrir el interes del periodo.
      const mitad = Math.floor(intTot / 2);
      const d1 = Object.assign({}, base, {
        estadoPago: 'Pendiente', fechaRecaudo: null, montoCOPRecibido: 0, paidAt: null,
        partialPaid: mitad, recibos: JSON.stringify([{ fecha: '2026-07-10', cop: mitad }]),
      });
      // Tres parciales que juntos completan la cuota (la cascada cruza el limite del interes
      // DENTRO del tercer evento).
      const d2 = Object.assign({}, base, {
        estadoPago: 'Pendiente', fechaRecaudo: null, montoCOPRecibido: 0, paidAt: null,
        partialPaid: cuota, recibos: JSON.stringify([
          { fecha: '2026-07-10', cop: mitad },
          { fecha: '2026-07-20', cop: mitad },
          { fecha: '2026-07-25', cop: cuota - 2 * mitad },
        ]),
      });
      // El mismo escalonado pero con la cuota ya SALDADA: ejerce el anclaje del remanente
      // de composicion al ultimo evento.
      const d3 = Object.assign({}, d2, { estadoPago: 'Pagado', fechaRecaudo: '2026-07-25' });

      const derivados = [['parcial < interes', d1], ['3 parciales que completan', d2], ['escalonado ya saldado', d3]];
      let violD = [], eventosD = 0, testigosCascada = 0;

      derivados.forEach(function (par) {
        const r = propiedadesImputacion(par[1], par[0]);
        violD = violD.concat(r.violaciones);
        eventosD += r.imp.eventos.length;
        // Testigo de cascada: evento con capital 0 porque el interes aun no se cubrio.
        let ci = 0;
        r.imp.eventos.forEach(function (e) { ci += e.interes; if (ci < r.intTot && e.capital === 0) testigosCascada++; });
      });

      const i1 = H.imputarCobros(d1).totales;
      const i2 = H.imputarCobros(d2).totales;

      console.log(`   derivados: ${derivados.length} | eventos generados: ${eventosD} | testigos reales de la cascada: ${testigosCascada}`);

      R.check(`los ${derivados.length} casos derivados cumplen TODAS las propiedades de la seccion 2`,
        violD.length === 0, muestra(violD));
      R.check('un parcial menor al interes imputa 100% a interes y 0 a capital',
        i1.interes === mitad && i1.capital === 0 && i1.cobrado === mitad,
        JSON.stringify(i1));
      R.eq('tres parciales que completan la cuota reconcilian el interes del motor', i2.interes, intTot);
      R.check('tres parciales que completan la cuota reconcilian el capital del motor',
        Math.abs(i2.capital - capBaseDe(d2)) <= TOL_IDENTIDAD,
        `capital=${i2.capital} base=${capBaseDe(d2)}`);
      R.check('los casos derivados SI ejercen la rama de cascada que produccion no cubre',
        testigosCascada >= 2, `testigos: ${testigosCascada}`);
      R.check('un parcial en curso NO se cuenta como cuota saldada (sigue habiendo pendiente)',
        H.pendienteDeCuota(d1).interes > 0, JSON.stringify(H.pendienteDeCuota(d1)));

      // ── ANCLAJE DEL REMANENTE: al ULTIMO evento, no al primero ────────────────
      // Cuando la caja no alcanza a cubrir interes+capital (tipico en USD con la TRM a la baja)
      // la cuota saldada ancla el faltante al ultimo evento, y el desfase queda visible como
      // `ajuste` en la fecha en que realmente se cerro. Anclarlo al primero fecharia el efecto
      // cambiario ANTES de que ocurriera. Produccion no tiene ninguna saldada multi-evento con
      // remanente, asi que sin este caso el anclaje no se distingue de cualquier otro.
      const CAJA = 2 * Math.floor(intTot / 2 * 1.2);
      const d4 = Object.assign({}, base, {
        estadoPago: 'Pagado', fechaRecaudo: '2026-07-20', montoCOPRecibido: CAJA, paidAt: null, partialPaid: 0,
        recibos: JSON.stringify([{ fecha: '2026-07-10', cop: CAJA / 2 }, { fecha: '2026-07-20', cop: CAJA / 2 }]),
      });
      const i4 = H.imputarCobros(d4);
      const rem = (intTot + capBaseDe(d4)) - CAJA;
      R.check('el caso derivado del anclaje deja un remanente real que cubrir', rem > 0, `rem=${rem}`);
      R.eq('la cuota saldada reconcilia el INTERES del motor aunque la caja no alcance', i4.totales.interes, intTot);
      R.eq('...y el CAPITAL del motor', i4.totales.capital, capBaseDe(d4));
      R.eq('el remanente se ancla al ULTIMO evento (el ajuste negativo cae alli, no antes)',
        i4.eventos.map(function (e) { return e.ajuste; }), [0, -rem]);

      // ── CAPITAL FANTASMA LEGACY (Bugs #30/#34) ────────────────────────────────
      // Filas historicas de modalidad `Prestamo` con abonoCapital 0 y cuota viva. Hoy quedan 0
      // en la BD (la migracion de v1.18.2 las saneo), asi que el fallback del helper no tiene
      // testigos: quitarlo pasa inadvertido y esas filas dejarian de amortizar capital.
      const dFant = Object.assign({}, base, {
        estadoPago: 'Pagado', fechaRecaudo: '2026-07-20', montoCOPRecibido: cuota, paidAt: null,
        partialPaid: 0, interesPeriodo: 0, abonoCapital: 0, recibos: '[]',
      });
      const iFant = H.imputarCobros(dFant);
      R.eq('con abonoCapital 0 y cuota viva, el capital se reconcilia desde cuotaTotal',
        iFant.totales.capital, cuota);
      R.eq('y no queda nada colgando en ajuste', iFant.totales.ajuste, 0);
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  R.seccion('4. saldoConCaja(loan, pays) — el saldo que se MUESTRA');
  // ══════════════════════════════════════════════════════════════════════════
  {
    const negativos = [], sobreOriginal = [], sobreMotor = [], finNoCero = [], canonMal = [];
    let evaluados = 0, finalizadosTodoPagado = 0, bajaronPorCaja = 0, evaluadosUSD = 0;

    loans.forEach(function (l) {
      const lp = paysDe(l);
      const sc = H.saldoConCaja(l, pays);
      const orig = origCOPDe(l);
      evaluados++;
      if (l.moneda === 'USD') evaluadosUSD++;

      // FORMULA CANONICA DEL CAPITAL ORIGINAL, fijada donde no puede esconderse. El helper la
      // reimplementa por dentro (USD -> round(montoOrigen*trmAcordada)); si alguien la rompe,
      // los asserts de arriba NO lo ven: un origCOP demasiado chico hace que el saldo se cape
      // en 0 y siga cumpliendo "no negativo", "<= original" y "<= motor". Sin pays no hay caja
      // que aplicar, asi que el helper tiene que devolver el capital original exacto.
      const solo = H.saldoConCaja(l, []);
      if (solo !== orig) canonMal.push({ id: l.id, nombre: l.nombre, moneda: l.moneda,
                                         obtenido: solo, canonico: orig });

      if (!(sc >= 0)) negativos.push({ id: l.id, nombre: l.nombre, sc });
      if (sc > orig) sobreOriginal.push({ id: l.id, nombre: l.nombre, sc, orig });

      // Saldo del MOTOR: originalCOP - suma abonoCapital de Pagadas. Gobierna decisiones
      // (techo del abono, liquidacion, recalculo del PMT) y NO se mueve por un parcial.
      // Aplicar caja solo puede BAJAR el saldo mostrado o dejarlo igual: nunca subirlo.
      const motor = Math.max(0, orig - lp.filter(function (p) { return p.estadoPago === 'Pagado'; })
                                          .reduce(function (s, p) { return s + p.abonoCapital; }, 0));
      if (sc > motor) sobreMotor.push({ id: l.id, nombre: l.nombre, saldoConCaja: sc, motor, delta: sc - motor });
      if (sc < motor) bajaronPorCaja++;

      // Finalizado con todas las cuotas regulares Pagadas -> el saldo mostrado debe ser 0.
      const regs = lp.filter(function (p) { return !esAbono(p); });
      const todoPagado = regs.length > 0 && regs.every(function (p) { return p.estadoPago === 'Pagado'; });
      if (l.estado === 'Finalizado' && todoPagado) {
        finalizadosTodoPagado++;
        if (sc !== 0) finNoCero.push({ id: l.id, nombre: l.nombre, sc });
      }
    });

    console.log(`   prestamos evaluados: ${evaluados} | finalizados con todo pagado: ${finalizadosTodoPagado} | con saldo por debajo del motor: ${bajaronPorCaja}`);

    R.check(`nunca negativo (${evaluados} prestamos)`, negativos.length === 0, muestra(negativos));
    R.check('nunca mayor que el capital original canonico', sobreOriginal.length === 0, muestra(sobreOriginal));
    R.check('SIEMPRE <= el saldo del MOTOR (aplicar caja solo puede bajarlo)',
      sobreMotor.length === 0, muestra(sobreMotor));
    R.check(`los ${finalizadosTodoPagado} finalizados con todo pagado quedan en 0`, finNoCero.length === 0, muestra(finNoCero));
    R.check(`sin caja que aplicar devuelve el capital original CANONICO (${evaluadosUSD} de ${evaluados} en USD)`,
      canonMal.length === 0, muestra(canonMal));
    R.check(`cobertura: >= ${PISO.loans} prestamos evaluados (real: ${evaluados})`, evaluados >= PISO.loans);
    R.check(`cobertura: hay prestamos USD donde la conversion por TRM se ejerce (real: ${evaluadosUSD})`,
      evaluadosUSD >= 1);
    R.check('cobertura: hay al menos 1 finalizado con todo pagado que verificar', finalizadosTodoPagado >= 1);

    // ── CLAMP: el capital imputado nunca puede producir un saldo negativo ───────
    // Sobre la cartera real el capital imputado JAMAS supera al original, asi que quitar el
    // `Math.max(0, ...)` sobrevive a toda la seccion. Se fuerza el borde encogiendo el capital
    // original de un prestamo real y dejandole su caja verdadera.
    const conCap = loans.find(function (l) {
      return paysDe(l).reduce(function (s, p) { return s + H.imputarCobros(p).totales.capital; }, 0) > 100000;
    });
    R.check('existe un prestamo con capital imputado suficiente para probar el clamp', !!conCap);
    if (conCap) {
      const enano = Object.assign({}, conCap, { moneda: 'COP', montoOrigen: 1000, trmAcordada: 1 });
      R.eq('el saldo se capa en 0 cuando el capital cobrado supera al original',
        H.saldoConCaja(enano, pays), 0);
    }

    // ── CASO DERIVADO: sin parciales en curso, saldoConCaja == motor SIEMPRE ────
    // Los asserts de arriba pasan igual si alguien reemplaza el helper por la formula del
    // motor: sobre esta cartera las dos cifras coinciden en los 26 prestamos (0 con saldo
    // por debajo del motor). Lo verifico con mutacion: un helper que reste `partialPaid`
    // CRUDO —el bug exacto que la doctrina prohibe— sobrevive a la seccion entera.
    // Aqui se inyecta un parcial en curso sobre una cuota real y se fija la diferencia:
    // solo el CAPITAL imputado baja el saldo; el interes cobrado NO lo mueve.
    const cand = loans.find(function (l) {
      return l.estado === 'Activo' && paysDe(l).some(function (p) {
        return p.estadoPago !== 'Pagado' && !esAbono(p) &&
               Math.round(p.interesPeriodo) > 0 && capBaseDe(p) > 1000;
      });
    });
    R.check('existe un activo real con cuota pendiente para derivar el parcial en curso', !!cand);

    if (cand) {
      const objetivo = paysDe(cand).find(function (p) {
        return p.estadoPago !== 'Pagado' && !esAbono(p) &&
               Math.round(p.interesPeriodo) > 0 && capBaseDe(p) > 1000;
      });
      const intTot = Math.round(objetivo.interesPeriodo);
      const motor = H.saldoConCaja(cand, pays); // sin parciales == saldo del motor
      const conParcial = function (monto) {
        const mut = pays.map(function (p) {
          return p.id === objetivo.id
            ? Object.assign({}, p, { partialPaid: monto, recibos: JSON.stringify([{ fecha: '2026-07-15', cop: monto }]) })
            : p;
        });
        return H.saldoConCaja(cand, mut);
      };
      const EXTRA = 50000;
      const soloInteres = conParcial(intTot);
      const masCapital  = conParcial(intTot + EXTRA);
      console.log(`   derivado: ${cand.nombre} cuota ${objetivo.id} interes=${intTot} | saldo base ${motor} | parcial solo-interes ${soloInteres} | +${EXTRA} de capital ${masCapital}`);

      R.eq('un parcial que solo cubre el INTERES no mueve el saldo (cascada)', soloInteres, motor);
      R.eq('un parcial que ademas cubre capital baja el saldo exactamente ese capital', masCapital, motor - EXTRA);
      R.check('el saldo con caja queda por DEBAJO del motor cuando hay capital imputado',
        masCapital < motor, `motor=${motor} conCaja=${masCapital}`);
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  R.seccion('5. pendienteDeCuota(pay) / pendCuota(p) — lo que AUN se debe');
  // ══════════════════════════════════════════════════════════════════════════
  {
    const neg = [], sumaMayor = [], saldadaConResiduo = [], pcFuera = [], pcIdentidad = [], intMayorCuota = [];
    let evaluados = 0, conParcial = 0, residuoTolerado = 0;

    pays.forEach(function (p) {
      evaluados++;
      const q = H.pendienteDeCuota(p);
      const cuota = Math.round(p.cuotaTotal || 0);
      const intTot = Math.round(p.interesPeriodo || 0);

      if (q.interes < 0 || q.capital < 0) neg.push({ id: p.id, q });
      if (q.interes + q.capital > cuota + TOL_IDENTIDAD) sumaMayor.push({ id: p.id, q, cuota });
      if (intTot > cuota) intMayorCuota.push({ id: p.id, intTot, cuota });

      // Una cuota saldada no debe seguir exigiendo nada. El unico residuo aceptable es el
      // legacy del Bug #43: `abonoCapital` persistido difiere de `cuotaTotal - interes` en
      // 1-3 pesos. Se tolera con TOL_REDONDEO y se CUENTA, no se esconde.
      if (p.estadoPago === 'Pagado') {
        const resto = q.interes + q.capital;
        if (resto > 0) {
          if (resto <= TOL_REDONDEO) { residuoTolerado++; saldadaConResiduo.push({ id: p.id, resto }); }
          else neg.push({ id: p.id, inv: 'saldada sigue debiendo', resto });
        }
      }

      // pendCuota: caja bruta, sin imputacion.
      const pc = H.pendCuota(p);
      const pp = Math.round(p.partialPaid || 0);
      if (pc < 0 || pc > cuota) pcFuera.push({ id: p.id, pc, cuota });
      if (Math.abs(pc - Math.max(0, cuota - pp)) > TOL_IDENTIDAD) pcIdentidad.push({ id: p.id, pc, cuota, pp });
      if (pp > 0) conParcial++;
    });

    console.log(`   filas evaluadas: ${evaluados} | con partialPaid > 0: ${conParcial} | saldadas con residuo legacy tolerado: ${residuoTolerado}`);
    if (saldadaConResiduo.length) {
      console.log(`   residuo Bug #43 (<= ${TOL_REDONDEO} pesos) en: ` +
        saldadaConResiduo.map(function (x) { return `${x.id}(${x.resto})`; }).join(', '));
    }

    R.check(`pendienteDeCuota nunca negativo (${evaluados} filas)`, neg.length === 0, muestra(neg));
    R.check('pendienteDeCuota nunca suma mas que cuotaTotal', sumaMayor.length === 0, muestra(sumaMayor));
    R.check('ninguna fila tiene interesPeriodo > cuotaTotal (premisa del reparto)',
      intMayorCuota.length === 0, muestra(intMayorCuota));
    R.check(`pendCuota dentro de [0, cuotaTotal] (${evaluados} filas)`, pcFuera.length === 0, muestra(pcFuera));
    R.check('pendCuota === max(0, cuotaTotal - partialPaid) — coherente con partialPaid',
      pcIdentidad.length === 0, muestra(pcIdentidad));
    R.check(`cobertura: >= 10 filas con partialPaid > 0 (real: ${conParcial})`, conParcial >= 10);

    // ── CASO DERIVADO: sobrepago ───────────────────────────────────────────────
    // Ninguna de las 157 filas tiene partialPaid > cuotaTotal, asi que el `Math.max(0, ...)`
    // de pendCuota nunca se ejerce y quitarlo sobrevive a la seccion entera. Un pendiente
    // negativo se propagaria a las facturas prospectivas como un cobro en negativo.
    const baseP = pays.find(function (p) { return Math.round(p.cuotaTotal || 0) > 10000; });
    R.check('existe una fila real con cuota > 10.000 para probar el clamp de pendCuota', !!baseP);
    if (baseP) {
      R.eq('pendCuota se capa en 0 ante un sobrepago',
        H.pendCuota(Object.assign({}, baseP, { partialPaid: baseP.cuotaTotal + 250000 })), 0);
      R.eq('pendCuota resta exactamente el parcial cuando NO hay sobrepago',
        H.pendCuota(Object.assign({}, baseP, { partialPaid: 1000 })), baseP.cuotaTotal - 1000);
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  R.seccion('6. flujoCajaDe(loan, pays) — reconstruccion del dinero real');
  // ══════════════════════════════════════════════════════════════════════════
  {
    const desorden = [], saldoSube = [], saldoFuera = [], ingresoMal = [], secuenciaMal = [], totalesMal = [];
    const coherenciaMal = [], saldoMal = [], origMal = [], inferidoMal = [];
    let loansConFlujo = 0, filas = 0, filasNDistintoCuotaN = 0, filasAbono = 0, filasMultiEvento = 0;
    let filasInferidas = 0;
    // Un cobro es RECONSTRUIDO cuando no hay ledger NI montoCOPRecibido: cobrosDe cae a
    // cuotaTotal, asi que la fecha es real pero el monto es una suposicion (caja previa a
    // v1.11.4). Es lo que el panel de Flujo de Caja marca con `*`.
    const esInferida = function (p) {
      let tl = false;
      try { const a = JSON.parse(p.recibos || '[]'); tl = Array.isArray(a) && a.length > 0; } catch (_) {}
      return !tl && !(p.montoCOPRecibido > 0);
    };
    // Firma de un evento, para comparar flujoCajaDe contra imputarCobros como multiconjunto.
    const firma = function (e) { return [e.cop, e.interes, e.capital, e.ajuste].join('|'); };

    loans.forEach(function (l) {
      const f = H.flujoCajaDe(l, pays);
      if (!f.eventos.length) return;
      loansConFlujo++; filas += f.eventos.length;

      const orig = origCOPDe(l);
      // El capital original que el flujo expone tiene que ser el CANONICO: es el punto de
      // partida del saldo que camina, y los asserts de rango lo usan como techo. Si el helper
      // lo calcula mal (p.ej. USD sin TRM), el saldo se capa en 0 y todo lo demas "cumple".
      if (f.origCOP !== orig) origMal.push({ id: l.id, nombre: l.nombre, obtenido: f.origCOP, canonico: orig });

      let prevFecha = '', prevSaldo = Infinity, accCap = 0;
      f.eventos.forEach(function (e, i) {
        if (e.fecha < prevFecha) desorden.push({ id: l.id, i, fecha: e.fecha, previa: prevFecha });
        prevFecha = e.fecha;
        if (e.saldo > prevSaldo) saldoSube.push({ id: l.id, i, saldo: e.saldo, previo: prevSaldo });
        prevSaldo = e.saldo;
        if (e.saldo < 0 || e.saldo > orig) saldoFuera.push({ id: l.id, i, saldo: e.saldo, orig });

        // IDENTIDAD DEL SALDO, evento a evento: el saldo baja con CADA peso de capital que
        // entra, no de golpe en el evento que salda la cuota (doctrina de la Fase 2). Los
        // asserts de "no sube" y "dentro de rango" NO lo capturan: un helper que solo
        // descuente en el ultimo evento de una cuota los cumple igual y deja el saldo alto.
        accCap += e.capital;
        const espSaldo = Math.max(0, orig - accCap);
        if (e.saldo !== espSaldo) saldoMal.push({ id: l.id, nombre: l.nombre, i, saldo: e.saldo, esperado: espSaldo });

        // `#` es la secuencia del EVENTO DE CAJA, no cuotaN (un abono guarda cuotaN=maxN+1).
        if (e.n !== i + 1) secuenciaMal.push({ id: l.id, i, n: e.n });
        if (e.n !== e.cuotaN) filasNDistintoCuotaN++;
        if (e.esAbono) filasAbono++;
        if (e.nEv > 1) filasMultiEvento++;
      });

      // La marca de fidelidad `*` no la verificaba nadie: invertirla presenta cifras
      // reconstruidas como registro exacto de caja (y al reves) sin romper ninguna otra
      // propiedad. Se contrasta contra la regla, calculada aparte desde las filas crudas.
      const infEsp = paysDe(l).reduce(function (s, p) {
        return s + (esInferida(p) ? H.cobrosDe(p).length : 0);
      }, 0);
      if (f.inferidos !== infEsp) inferidoMal.push({ id: l.id, nombre: l.nombre, obtenido: f.inferidos, esperado: infEsp });
      filasInferidas += infEsp;

      // El total de INGRESO reconcilia con la suma cruda de cobrosDe del prestamo.
      const sumCobros = paysDe(l).reduce(function (s, p) {
        return s + H.cobrosDe(p).reduce(function (a, e) { return a + e.cop; }, 0);
      }, 0);
      if (f.totales.ingreso !== sumCobros) ingresoMal.push({ id: l.id, nombre: l.nombre, ingreso: f.totales.ingreso, sumCobros });
      // Y la identidad de rubros se mantiene agregada.
      if (Math.abs(f.totales.interes + f.totales.capital + f.totales.ajuste - f.totales.ingreso) > TOL_IDENTIDAD) {
        totalesMal.push({ id: l.id, t: f.totales });
      }

      // COHERENCIA CON imputarCobros: el flujo no puede re-repartir nada por su cuenta.
      // Este es el assert que ataja el bug pre-Fase 2 (volcar la composicion COMPLETA de la
      // cuota en el evento que la salda, de modo que una fila de $50.000 declaraba $450.000
      // de rubros). Verificado con mutacion: sin esto, ese mutante sobrevive a toda la
      // seccion, porque duplicar el capital no desordena las fechas ni hace subir el saldo.
      const esperados = [];
      paysDe(l).forEach(function (p) {
        H.imputarCobros(p).eventos.forEach(function (e) { esperados.push(firma(e)); });
      });
      const obtenidos = f.eventos.map(firma);
      if (JSON.stringify(esperados.slice().sort()) !== JSON.stringify(obtenidos.slice().sort())) {
        coherenciaMal.push({ id: l.id, nombre: l.nombre, esperados: esperados.slice(0, 5), obtenidos: obtenidos.slice(0, 5) });
      }
    });

    console.log(`   prestamos con flujo: ${loansConFlujo} | filas de flujo: ${filas} | filas donde # != cuotaN: ${filasNDistintoCuotaN} | abonos: ${filasAbono}`);

    R.check(`filas ordenadas por fecha real de recaudo (${filas} filas)`, desorden.length === 0, muestra(desorden));
    R.check('el SALDO nunca sube evento a evento', saldoSube.length === 0, muestra(saldoSube));
    R.check('el SALDO se mantiene dentro de [0, capital original]', saldoFuera.length === 0, muestra(saldoFuera));
    R.check(`el total de INGRESO reconcilia con la suma de cobrosDe (${loansConFlujo} prestamos)`,
      ingresoMal.length === 0, muestra(ingresoMal));
    R.check('interes + capital + ajuste === ingreso a nivel de prestamo', totalesMal.length === 0, muestra(totalesMal));
    R.check(`cada fila reproduce EXACTO el reparto de imputarCobros (${filas} filas, sin re-repartir)`,
      coherenciaMal.length === 0, muestra(coherenciaMal, 3));
    R.check('toda fila trae un # de secuencia de caja correlativo (1..N)', secuenciaMal.length === 0, muestra(secuenciaMal));
    R.check(`el # es secuencia de CAJA y no cuotaN (difiere en ${filasNDistintoCuotaN} filas reales)`,
      filasNDistintoCuotaN > 0, 'si coincidieran siempre, la propiedad no estaria demostrada');
    R.check(`el SALDO de cada fila === max(0, capital original - capital imputado acumulado) (${filas} filas)`,
      saldoMal.length === 0, muestra(saldoMal, 4));
    R.check(`el capital original del flujo es el CANONICO (${loansConFlujo} prestamos)`,
      origMal.length === 0, muestra(origMal));
    R.check(`la marca de cobro RECONSTRUIDO coincide con la regla (${filasInferidas} de ${filas} filas)`,
      inferidoMal.length === 0, muestra(inferidoMal));
    R.check(`cobertura: hay filas inferidas Y filas reales (inferidas: ${filasInferidas}/${filas})`,
      filasInferidas > 0 && filasInferidas < filas,
      'con todas iguales, invertir la marca no seria observable');
    R.check(`cobertura: >= ${PISO.loansConFlujo} prestamos con flujo (real: ${loansConFlujo})`, loansConFlujo >= PISO.loansConFlujo);
    R.check(`cobertura: >= ${PISO.filasFlujo} filas de flujo (real: ${filas})`, filas >= PISO.filasFlujo);
    R.check(`cobertura: hay filas de cuotas con MAS DE UN evento de caja (real: ${filasMultiEvento})`,
      filasMultiEvento >= 2, 'sin ellas, "el saldo baja evento a evento" no se distingue de "baja al saldar"');

    // ── CASO DERIVADO: desempate por paidAt ────────────────────────────────────
    // Hay dias con varios cobros del mismo prestamo (Diego Marin 31-mar, Carla Ossa 18-jul),
    // pero su orden de insercion ya coincide con el de paidAt, asi que quitar el desempate
    // no se nota: `Array.sort` es estable. Se fuerza el conflicto invirtiendo las horas.
    const lDoble = loans.find(function (l) { return paysDe(l).filter(function (p) { return !esAbono(p); }).length >= 2; });
    R.check('existe un prestamo con >= 2 cuotas regulares para probar el desempate', !!lDoble);
    if (lDoble) {
      const dos = paysDe(lDoble).filter(function (p) { return !esAbono(p); }).slice(0, 2);
      const MISMO = '2026-06-01';
      // El PRIMERO del array se registro MAS TARDE -> el desempate por paidAt debe invertirlos.
      const a = Object.assign({}, dos[0], { estadoPago: 'Pagado', fechaRecaudo: MISMO, recibos: '[]',
                                            montoCOPRecibido: 111111, paidAt: '2026-06-01 15:00:00' });
      const b = Object.assign({}, dos[1], { estadoPago: 'Pagado', fechaRecaudo: MISMO, recibos: '[]',
                                            montoCOPRecibido: 222222, paidAt: '2026-06-01 09:00:00' });
      const ord = H.flujoCajaDe(lDoble, [a, b]).eventos.map(function (e) { return e.cop; });
      R.eq('dos cobros del mismo dia se ordenan por paidAt, no por orden de insercion',
        ord, [222222, 111111]);
    }

    // ── CASO DERIVADO: un parcial EN CURSO debe aparecer como fila de caja ──────
    // Es el Bug #39: la tarjeta "Transacciones del Mes" filtraba por estadoPago==='Pagado'
    // y el dinero de un parcial en vuelo no existia para la app. Produccion no tiene hoy
    // ningun parcial en curso, asi que sin este caso la propiedad no se ejerce.
    // El candidato debe tener CAPITAL en la cuota: en modalidad `Intereses` la cuota es
    // 100% interes (abonoCapital = 0), asi que un excedente no tiene capital donde
    // imputarse y cae —correctamente— en `ajuste`. Exigirle capital ahi seria un assert mal
    // planteado, no un bug del helper.
    const EXCEDENTE = 25000;
    const aptaFlujo = function (p) {
      return p.estadoPago !== 'Pagado' && !esAbono(p) &&
             Math.round(p.interesPeriodo) > 0 && capBaseDe(p) > EXCEDENTE;
    };
    const candF = loans.find(function (l) {
      return l.estado === 'Activo' && paysDe(l).some(aptaFlujo);
    });
    R.check('existe un activo real con capital en la cuota para derivar el parcial del flujo', !!candF);

    if (candF) {
      const obj = paysDe(candF).find(aptaFlujo);
      const MONTO = Math.round(obj.interesPeriodo) + EXCEDENTE;
      const mut = pays.map(function (p) {
        return p.id === obj.id
          ? Object.assign({}, p, { partialPaid: MONTO, recibos: JSON.stringify([{ fecha: '2026-07-15', cop: MONTO }]) })
          : p;
      });
      const antes = H.flujoCajaDe(candF, pays);
      const desp  = H.flujoCajaDe(candF, mut);
      const nueva = desp.eventos.find(function (e) { return e.cop === MONTO && e.parcialEnCurso; });
      console.log(`   derivado flujo: ${candF.nombre} | filas ${antes.eventos.length} -> ${desp.eventos.length} | ingreso ${antes.totales.ingreso} -> ${desp.totales.ingreso}`);

      R.eq('el parcial en curso agrega exactamente una fila de caja', desp.eventos.length, antes.eventos.length + 1);
      R.check('esa fila queda marcada como parcial en curso (no como cuota saldada)', !!nueva, 'no se encontro la fila del parcial');
      R.eq('el ingreso total sube exactamente el monto del parcial', desp.totales.ingreso - antes.totales.ingreso, MONTO);
      if (nueva) {
        R.eq('la fila del parcial imputa el interes del periodo primero', nueva.interes, Math.round(obj.interesPeriodo));
        R.eq('y el excedente va a capital', nueva.capital, EXCEDENTE);
      }
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  R.seccion('7. computeLiquidacion(loan, pays, opts) — valor de liquidacion');
  // ══════════════════════════════════════════════════════════════════════════
  const activos = loans.filter(function (l) { return l.estado === 'Activo'; });
  {
    const neg = [], formulaMal = [], proxMal = [], capMal = [], moraMal = [];
    let evaluados = 0, conMora = 0, conProxMes = 0, conMoraYPendiente = 0;

    activos.forEach(function (l) {
      const lp = paysDe(l);
      const a = H.computeLiquidacion(l, lp, {});
      const b = H.computeLiquidacion(l, lp, { incluyeProxMes: true });
      evaluados++;
      if (a.moraCount > 0) conMora++;

      // CONTRASTE CONTRA LA BD, no contra el propio helper. El assert de la formula usa
      // `a.intMora`, asi que es auto-consistente: si el helper metiera en la mora tambien las
      // cuotas Pendientes, el total subiria y la formula seguiria "cuadrando". Solo En Mora, y
      // solo cuotas regulares por la regla canonica `-ab-`.
      const moraDB = lp.filter(function (p) { return !esAbono(p) && p.estadoPago === 'En Mora'; });
      const intMoraDB = moraDB.reduce(function (s, p) { return s + p.interesPeriodo; }, 0);
      if (a.moraCount !== moraDB.length || Math.round(a.intMora) !== Math.round(intMoraDB)) {
        moraMal.push({ id: l.id, nombre: l.nombre, moraCount: a.moraCount, esperado: moraDB.length,
                       intMora: a.intMora, intMoraDB: intMoraDB });
      }
      // El desglose "N cuotas a $W/mes" que se le muestra al deudor en el modal de liquidacion
      // tampoco lo verificaba nadie. $W es exacto si todas las cuotas en mora valen igual, y
      // promedio MARCADO COMO TAL si varian (C+I multi-mora).
      const ints = moraDB.map(function (p) { return Math.round(p.interesPeriodo); });
      const unifEsp = ints.length > 0 && ints.every(function (v) { return v === ints[0]; });
      const vmEsp = ints.length === 0 ? 0 : (unifEsp ? ints[0] : Math.round(intMoraDB / ints.length));
      if (a.moraUniforme !== unifEsp || a.moraValorMes !== vmEsp) {
        moraMal.push({ id: l.id, nombre: l.nombre, inv: 'valor por mes',
                       uniforme: a.moraUniforme, unifEsp, valorMes: a.moraValorMes, vmEsp });
      }
      // Un prestamo con mora Y pendientes a la vez es lo que hace observable la confusion.
      if (moraDB.length > 0 && lp.some(function (p) {
        return !esAbono(p) && p.estadoPago !== 'Pagado' && p.estadoPago !== 'En Mora';
      })) conMoraYPendiente++;

      if (a.total < 0 || b.total < 0) neg.push({ id: l.id, nombre: l.nombre, a: a.total, b: b.total });

      // El total es exactamente la regla de negocio documentada, con los parciales
      // restados UNA sola vez.
      // `interesDevengado` es el termino que aporta el credito abierto: su interes no
      // vive en ninguna fila En Mora, asi que `intMora` sale 0 y sin este sumando la
      // liquidacion regalaria la renta entera del producto. En las otras 4 modalidades
      // vale 0, de modo que la propiedad de siempre queda intacta.
      const esperado = Math.max(0, a.capitalPendiente + a.intMora + a.interesDevengado - a.partialPend);
      if (a.total !== esperado) {
        formulaMal.push({ id: l.id, nombre: l.nombre, total: a.total, esperado,
                          cap: a.capitalPendiente, intMora: a.intMora,
                          devengado: a.interesDevengado, partialPend: a.partialPend });
      }
      // Capital pendiente = origCOP - capital de Pagadas (la mora NO resta capital).
      const capEsp = Math.max(0, origCOPDe(l) - lp.filter(function (p) { return p.estadoPago === 'Pagado'; })
                                                  .reduce(function (s, p) { return s + p.abonoCapital; }, 0));
      if (a.capitalPendiente !== capEsp) capMal.push({ id: l.id, cp: a.capitalPendiente, capEsp });

      // Con el checkbox del interes del proximo mes, el total sube EXACTAMENTE ese interes.
      if (a.aplicaInteres) {
        conProxMes++;
        if (b.total - a.total !== b.intProxMes || b.intExtra !== b.intProxMes) {
          proxMal.push({ id: l.id, nombre: l.nombre, delta: b.total - a.total, intProxMes: b.intProxMes });
        }
      } else if (b.total !== a.total) {
        proxMal.push({ id: l.id, nombre: l.nombre, inv: 'subio sin aplicar interes', delta: b.total - a.total });
      }
    });

    console.log(`   activos evaluados: ${evaluados} | con cuotas en mora: ${conMora} | con interes de proximo mes aplicable: ${conProxMes}`);

    R.check(`el total nunca es negativo (${evaluados} activos)`, neg.length === 0, muestra(neg));
    R.check('total === capitalPendiente + intMora + interesDevengado - partialPend (parciales restados UNA vez)',
      formulaMal.length === 0, muestra(formulaMal));
    R.check('capitalPendiente = origCOP - capital de Pagadas (la mora no resta capital)',
      capMal.length === 0, muestra(capMal));
    R.check(`con incluyeProxMes el total sube exactamente intProxMes (${conProxMes} prestamos)`,
      proxMal.length === 0, muestra(proxMal));
    R.check(`intMora/moraCount contrastados contra la BD: SOLO cuotas regulares En Mora (${conMora} con mora)`,
      moraMal.length === 0, muestra(moraMal));
    R.check(`cobertura: >= ${PISO.activos} activos evaluados (real: ${evaluados})`, evaluados >= PISO.activos);
    R.check('cobertura: hay al menos 1 activo con interes de proximo mes aplicable', conProxMes >= 1);
    R.check(`cobertura: hay activos con mora Y pendientes a la vez (real: ${conMoraYPendiente})`,
      conMoraYPendiente >= 1, 'sin ellos, confundir "En Mora" con "no Pagado" no seria observable');
  }

  // ══════════════════════════════════════════════════════════════════════════
  R.seccion('7b. computeLiquidacion — CASOS DERIVADOS (regla canonica -ab- y tasa 0)');
  // ══════════════════════════════════════════════════════════════════════════
  //
  // Los 4 abonos de la cartera tienen interesPeriodo = 0 y abonoCapital > 0, que es justo el
  // perfil donde la regla canonica (`-ab-`) y la heuristica fragil erradicada en v1.14.0
  // (`interesPeriodo===0 && abonoCapital>0`) COINCIDEN. Por eso reemplazar una por la otra
  // sobrevive a toda la seccion 7. Se construyen las dos filas donde divergen — ambas son
  // formas que la app YA produce: un abono de liquidacion (interes > 0, capital 0, desde
  // v1.19.0) y una cuota regular de modalidad 0% (`Prestamo`/`Pago Unico`, interes 0).
  {
    const base = activos.find(function (l) { return paysDe(l).some(function (p) { return !esAbono(p); }); });
    R.check('existe un activo real como base de los derivados de liquidacion', !!base);

    if (base) {
      const lp = paysDe(base);
      const reg = lp.find(function (p) { return !esAbono(p); });
      const a0 = H.computeLiquidacion(base, lp, {});
      console.log(`   base: ${base.nombre} (${base.modalidad}) | total ${a0.total} | intMora ${a0.intMora} | partialPend ${a0.partialPend}`);

      // (a) Una fila `-ab-` NUNCA es cuota regular, aunque traiga interes y figure En Mora.
      const abFalso = Object.assign({}, reg, {
        id: String(base.id) + '-ab-9999999999999', estadoPago: 'En Mora',
        interesPeriodo: 777777, abonoCapital: 0, partialPaid: 0,
      });
      const conAb = H.computeLiquidacion(base, lp.concat([abFalso]), {});
      R.eq('una fila -ab- En Mora con interes NO entra en intMora (regla canonica)', conAb.intMora, a0.intMora);
      R.eq('ni en moraCount', conAb.moraCount, a0.moraCount);
      R.eq('ni mueve el total de liquidacion', conAb.total, a0.total);

      // (b) Una cuota REGULAR de modalidad 0% SI es regular: su parcial resta del total.
      const PARC = 33000;
      const cuota0 = Object.assign({}, reg, {
        id: String(base.id) + '-9001', cuotaN: 9001, estadoPago: 'Pendiente',
        interesPeriodo: 0, abonoCapital: 500000, cuotaTotal: 500000, partialPaid: PARC,
      });
      const con0 = H.computeLiquidacion(base, lp.concat([cuota0]), {});
      R.eq('una cuota regular 0% (perfil Prestamo) con parcial SI cuenta en partialPend',
        con0.partialPend - a0.partialPend, PARC);
      R.eq('y el total baja exactamente ese parcial', a0.total - con0.total, PARC);

      // (c) Tasa 0: no hay interes de proximo mes que ofrecer. Ningun activo real tiene
      // tasaMensual 0 fuera de las modalidades de cuota unica, asi que aflojar el `> 0` a
      // `>= 0` no se nota sobre la cartera.
      const sinTasa = Object.assign({}, base, { modalidad: 'Intereses', tasaMensual: 0 });
      const t0 = H.computeLiquidacion(sinTasa, lp, { incluyeProxMes: true });
      R.check('con tasaMensual 0 NO aplica el interes del proximo mes',
        t0.aplicaInteres === false && t0.intProxMes === 0 && t0.intExtra === 0,
        JSON.stringify({ aplica: t0.aplicaInteres, intProxMes: t0.intProxMes, intExtra: t0.intExtra }));
      R.eq('y el total con el checkbox activo no se mueve',
        t0.total, H.computeLiquidacion(sinTasa, lp, {}).total);

      // (d) Clamp de capitalPendiente. Sobre la cartera real el capital cobrado nunca supera
      // al prestado, asi que quitar el `Math.max(0, ...)` sobrevive: se fuerza encogiendo el
      // capital original de un prestamo que SI tiene capital pagado.
      const conCap = loans.find(function (l) {
        return paysDe(l).filter(function (p) { return p.estadoPago === 'Pagado'; })
                        .reduce(function (s, p) { return s + p.abonoCapital; }, 0) > 100000;
      });
      R.check('existe un prestamo con capital pagado para probar el clamp de capitalPendiente', !!conCap);
      if (conCap) {
        const enano = Object.assign({}, conCap, { moneda: 'COP', montoOrigen: 1000, trmAcordada: 1 });
        const e0 = H.computeLiquidacion(enano, paysDe(conCap), {});
        R.eq('capitalPendiente se capa en 0, nunca negativo', e0.capitalPendiente, 0);
        R.check('y el total tampoco se va a negativo', e0.total >= 0, `total=${e0.total}`);
      }
    }
  }

  // ── 7c. CASO DERIVADO: la resta del parcial tampoco tiene testigos ──────────
  R.seccion('7c. computeLiquidacion — CASO DERIVADO (parcial en curso)');
  //
  // Las 32 filas con partialPaid > 0 de la cartera estan TODAS en estado Pagado, y
  // computeLiquidacion solo suma `partialPaid` de cuotas NO pagadas -> `partialPend` es 0
  // en los 12 activos y la resta jamas se ejerce. Se deriva de un activo real una cuota
  // pendiente con parcial en curso.
  {
    const cand = activos.find(function (l) {
      return paysDe(l).some(function (p) { return p.estadoPago !== 'Pagado' && !esAbono(p); });
    });
    R.check('existe un activo real con cuota pendiente para derivar el caso', !!cand);

    if (cand) {
      const lp = paysDe(cand);
      const pend = lp.find(function (p) { return p.estadoPago !== 'Pagado' && !esAbono(p); });
      const PARCIAL = 100000;
      const lpParcial = lp.map(function (p) {
        return p.id === pend.id ? Object.assign({}, p, { partialPaid: PARCIAL }) : p;
      });

      const sin = H.computeLiquidacion(cand, lp, {});
      const con = H.computeLiquidacion(cand, lpParcial, {});
      console.log(`   base: ${cand.nombre} (${cand.modalidad}) cuota ${pend.id} | total sin parcial: ${sin.total} | con parcial de ${PARCIAL}: ${con.total}`);

      R.eq('el parcial en curso se refleja en partialPend', con.partialPend, PARCIAL);
      R.eq('el total baja EXACTAMENTE el parcial (restado una sola vez)', sin.total - con.total, PARCIAL);
      R.check('el capital pendiente NO se mueve por un parcial (no re-amortiza)',
        con.capitalPendiente === sin.capitalPendiente,
        `sin=${sin.capitalPendiente} con=${con.capitalPendiente}`);
      // Un parcial absurdamente grande no puede producir un valor de liquidacion negativo.
      const lpEnorme = lp.map(function (p) {
        return p.id === pend.id ? Object.assign({}, p, { partialPaid: sin.total + 5000000 }) : p;
      });
      R.check('un parcial mayor que la deuda deja el total en 0, nunca negativo',
        H.computeLiquidacion(cand, lpEnorme, {}).total === 0);
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  R.seccion('8. Interes Diario — invariantes de la fila de CORTE y espejo de predicados');
  // El corte es el TERCER tipo de fila de `payments` (id `${loanId}-ct-${n}`), y toda la
  // seguridad de la modalidad cuelga de que esas filas cumplan una forma exacta. Aqui se
  // verifican los invariantes que NO dependen de que la feature exista todavia: la forma
  // del dato y la equivalencia de las dos mitades del espejo de predicados.
  {
    // Oraculo INDEPENDIENTE: el test no reutiliza el predicado de produccion para decidir
    // que es un corte. Si lo hiciera, un bug en el predicado se ocultaria a si mismo.
    const esCorteTest = function (p) { return String(p.id).indexOf('-ct-') !== -1; };
    const diarios = loans.filter(function (l) { return l.modalidad === 'Interes Diario'; });
    const cortes  = pays.filter(esCorteTest);

    R.check(`la BD trae al menos ${PISO.loansDiarios} credito Interes Diario (real: ${diarios.length})`,
      diarios.length >= PISO.loansDiarios,
      diarios.length ? undefined : 'falta el credito sintetico: regeneralo con tests/fixture/credito-diario.js');
    R.check(`la BD trae al menos ${PISO.cortes} filas de corte (real: ${cortes.length})`,
      cortes.length >= PISO.cortes);

    if (cortes.length) {
      // I1 — nace 'Pagado' y NUNCA cambia. Es lo que apaga por construccion las 4 copias de
      // la auto-mora (que filtran estadoPago='Pendiente') y los DELETE de las 5 rutas que
      // regeneran. Si un corte apareciera como Pendiente, la auto-mora lo marcaria En Mora
      // y contaminaria el KPI de mora, computeLiquidacion y el Reporte de Activos.
      const noPagado = cortes.filter(function (p) { return p.estadoPago !== 'Pagado'; });
      R.check(`(I1) las ${cortes.length} filas de corte estan en 'Pagado'`,
        noPagado.length === 0, muestra(noPagado.map(function (p) { return { id: p.id, estadoPago: p.estadoPago }; })));

      // I2 — composicion exacta en pesos enteros, sin tolerancia.
      const desc = cortes.filter(function (p) {
        return Math.round(p.cuotaTotal) !== Math.round(p.interesPeriodo) + Math.round(p.abonoCapital);
      });
      R.check('(I2) cuotaTotal === interesPeriodo + abonoCapital, EXACTO',
        desc.length === 0, muestra(desc.map(function (p) {
          return { id: p.id, cuotaTotal: p.cuotaTotal, interes: p.interesPeriodo, capital: p.abonoCapital };
        })));
      const noEnteros = cortes.filter(function (p) {
        return !Number.isInteger(p.cuotaTotal) || !Number.isInteger(p.interesPeriodo) || !Number.isInteger(p.abonoCapital);
      });
      R.check('(I2b) los tres rubros son pesos ENTEROS', noEnteros.length === 0, muestra(noEnteros));

      // I6 — EL INVARIANTE MAS PELIGROSO DE LA MODALIDAD.
      // En un corte de solo-interes (abonoCapital = 0) hace falta ADEMAS que
      // cuotaTotal === interesPeriodo exacto. Si difieren aunque sea en un peso, el fallback
      // `if (capTotal <= 0 && reconc > 0) capTotal = reconc` de imputarCobros reclasifica
      // TODO el interes cobrado como CAPITAL: saldoConCaja se desploma y la deuda se paga
      // sola con intereses. Por eso no basta con I2 y se comprueba aparte.
      const soloInteres = cortes.filter(function (p) { return Math.round(p.abonoCapital) === 0; });
      const i6 = soloInteres.filter(function (p) {
        return Math.round(p.cuotaTotal) !== Math.round(p.interesPeriodo);
      });
      R.check(`(I6) en los ${soloInteres.length} cortes de solo-interes, cuotaTotal === interesPeriodo`,
        i6.length === 0, muestra(i6));
      R.check('cobertura: existe al menos un corte de SOLO INTERES (el borde de I6)',
        soloInteres.length >= 1);

      // Y la consecuencia observable de I6, medida con el helper REAL: el dinero de un
      // corte de solo-interes se imputa 100% a interes y 0 a capital.
      const malImputados = soloInteres.filter(function (p) {
        const t = H.imputarCobros(p).totales;
        return t.capital !== 0 || t.interes !== Math.round(p.interesPeriodo);
      });
      R.check('un corte de solo-interes imputa 100% a INTERES y 0 a CAPITAL (imputarCobros real)',
        malImputados.length === 0, muestra(malImputados.map(function (p) {
          return { id: p.id, totales: H.imputarCobros(p).totales };
        })));

      // I5 — ledger siempre escrito -> cobrosDe usa el ledger y nunca el fallback.
      const sinLedger = cortes.filter(function (p) { return !ledgerDe(p); });
      R.check('(I5) toda fila de corte trae ledger `recibos` no vacio', sinLedger.length === 0,
        muestra(sinLedger.map(function (p) { return { id: p.id, recibos: p.recibos }; })));

      // Los tres tipos de fila son MUTUAMENTE EXCLUYENTES: ningun id es a la vez abono y
      // corte, y ningun corte se cuela como cuota regular.
      const ambiguos = pays.filter(function (p) { return esAbono(p) && esCorteTest(p); });
      R.check('ningun id es a la vez abono y corte', ambiguos.length === 0, muestra(ambiguos));
    }

    // Cero cronograma: un credito de Interes Diario no tiene NI UNA fila de cuota regular.
    // Es la propiedad que sostiene el `return []` de buildSchedule; si aparece una, alguna
    // ruta de regeneracion le fabrico un cronograma frances (el `else` catch-all del motor).
    diarios.forEach(function (l) {
      const suyas = paysDe(l);
      const regulares = suyas.filter(function (p) { return !esAbono(p) && !esCorteTest(p); });
      R.check(`el credito diario ${l.id} no tiene cuotas de cronograma (${suyas.length} filas, todas cortes)`,
        regulares.length === 0, muestra(regulares.map(function (p) { return { id: p.id, cuotaN: p.cuotaN }; })));

      // saldoConCaja con el helper REAL: capital prestado menos el capital imputado.
      const esperado = origCOPDe(l) - suyas.reduce(function (s, p) { return s + Math.round(p.abonoCapital); }, 0);
      R.check(`saldoConCaja del credito diario == origCOP - capital de los cortes (${esperado})`,
        H.saldoConCaja(l, suyas) === esperado,
        `real=${H.saldoConCaja(l, suyas)} esperado=${esperado}`);
    });

    // ── Espejo de predicados: backend vs frontend ─────────────────────────────
    // `backend/core/ids.js` y `public/js/core/ids.js` son la MISMA regla de negocio escrita
    // dos veces (CommonJS vs modulo ES, sin bundler). Si divergen, el backend y la pantalla
    // clasifican distinto la misma fila: la clase de falla del Bug #45. En vez de comparar
    // texto, se comparan COMPORTAMIENTOS sobre todos los ids reales de la BD mas los bordes.
    const idsBack = require(path.join(REPO, 'backend', 'core', 'ids.js'));
    const casos = pays.map(function (p) { return p.id; })
      .concat(['x-ab-1', 'x-ct-1', 'x-1', '', null, undefined, 'ab-ct-mezcla', 'L-ct-99', 'L-ab-99']);
    const divergen = casos.filter(function (id) {
      const fila = { id: id };
      return idsBack.esAbono(fila)        !== H.esAbono(fila)
          || idsBack.esCorte(fila)        !== H.esCorte(fila)
          || idsBack.esCuotaRegular(fila) !== H.esCuotaRegular(fila);
    });
    R.check(`backend y frontend clasifican IGUAL los ${casos.length} ids probados (espejo de core/ids.js)`,
      divergen.length === 0, muestra(divergen));

    // Y la relacion entre los tres predicados no puede romperse.
    const incoherentes = casos.filter(function (id) {
      const f = { id: id };
      return H.esCuotaRegular(f) !== (!H.esAbono(f) && !H.esCorte(f));
    });
    R.check('esCuotaRegular === !esAbono && !esCorte, para todo id',
      incoherentes.length === 0, muestra(incoherentes));

    // ── ESPEJO DEL MOTOR DE DEVENGO: backend vs frontend ─────────────────────
    // `devengoDiario` esta escrito DOS VECES (CommonJS en backend/core/engine.js y
    // modulo ES en public/js/core/dominio.js) porque el proyecto no tiene bundler.
    // Si las dos mitades divergen, el servidor y la pantalla dirian cifras distintas
    // sobre lo que un cliente debe HOY — la clase de falla del Bug #45, pero sobre el
    // numero central del producto. No se comparan textos: se ejecutan las dos sobre el
    // mismo espacio de casos y se exige igualdad EXACTA de todo el desglose.
    const motorBack = require(path.join(REPO, 'backend', 'core', 'engine.js'));
    const casosDev = [];
    const inicios = ['2026-01-15', '2026-02-28', '2026-06-30', '2026-12-01'];
    const tasasD  = [0, 2.5, 3, 12];
    const montosD = [1, 350000, 1000000, 9999999];
    const hastasD = ['2026-03-01', '2026-07-15', '2027-01-31', '2028-02-29'];
    inicios.forEach(fi => tasasD.forEach(ta => montosD.forEach(mo => hastasD.forEach(ha => {
      [0, 1, 3].forEach(nc => {
        const loanD = { id: 'M', nombre: 'X', moneda: 'COP', montoOrigen: mo, trmAcordada: 1,
                        tasaMensual: ta, modalidad: 'Interes Diario', fechaInicio: fi, plazoMeses: 0 };
        const cortesD = [];
        for (let k = 1; k <= nc; k++) {
          cortesD.push({ id: 'M-ct-' + k, prestamoId: 'M', cuotaN: k,
            fechaPago: motorBack.sumarDias(fi, k * 17),
            interesPeriodo: Math.round(mo * 0.001 * k), abonoCapital: Math.round(mo / (nc + 2)),
            cuotaTotal: 0, estadoPago: 'Pagado' });
        }
        casosDev.push([loanD, cortesD, ha]);
      });
    }))));
    const divergenDev = casosDev.filter(function (c) {
      return JSON.stringify(motorBack.devengoDiario(c[0], c[1], c[2]))
          !== JSON.stringify(H.devengoDiario(c[0], c[1], c[2]));
    });
    R.check(`backend y frontend calculan el MISMO devengo en los ${casosDev.length} casos probados`,
      divergenDev.length === 0,
      divergenDev.length ? muestra(divergenDev.slice(0, 2).map(function (c) {
        return { caso: { inicio: c[0].fechaInicio, tasa: c[0].tasaMensual, monto: c[0].montoOrigen, cortes: c[1].length, hasta: c[2] },
                 back: motorBack.devengoDiario(c[0], c[1], c[2]),
                 front: H.devengoDiario(c[0], c[1], c[2]) };
      }), 2) : undefined);
    R.check('ANTI-VACIO: el espejo se probo sobre un espacio significativo', casosDev.length >= 100);

    // ── El progreso de un credito abierto NO puede darlo por saldado ─────────
    // Es el defecto medido en la app real: la barra marcaba 100% con capital vivo,
    // porque todo corte nace 'Pagado' y las formulas cuota-a-cuota daban cobrado ==
    // esperado. `progresoCapital` mide el CAPITAL devuelto, que es lo unico que
    // avanza hacia el cierre.
    diarios.forEach(function (l) {
      const suyas = paysDe(l);
      const pct = H.progresoCapital(l, suyas);
      const abonado = suyas.reduce(function (s, p) { return s + Math.round(p.abonoCapital || 0); }, 0);
      const orig = origCOPDe(l);
      R.eq(`progresoCapital del credito diario == capital devuelto / prestado (${abonado}/${orig})`,
        pct, Math.min(100, Math.round(abonado / orig * 100)));
      R.check('y NO marca 100% mientras quede capital vivo',
        !(abonado < orig && pct === 100), `abonado=${abonado} orig=${orig} pct=${pct}`);
      R.check('cobertura: el credito del fixture tiene capital vivo (si no, el aserto anterior es vacio)',
        abonado < orig, `abonado=${abonado} orig=${orig}`);
    });

    // ── computeLiquidacion no puede regalar el interes devengado ─────────────
    // Sin la rama de Interes Diario, `intMora` sale 0 (no hay cuotas En Mora) y la
    // liquidacion se quedaria en el capital pelado: se perderia la renta entera.
    diarios.forEach(function (l) {
      const suyas = paysDe(l);
      const hasta = '2026-08-30';   // fecha FIJA: el valor depende del dia
      const dev = H.estadoDiario(l, suyas, hasta);
      const liq = H.computeLiquidacion(l, suyas, { hasta: hasta });
      R.check('la liquidacion marca el credito como diario', liq.esDiario === true);
      R.eq('capital pendiente == capital vivo del motor', liq.capitalPendiente, dev.capitalVivo);
      R.eq('el interes devengado entra en la liquidacion', liq.interesDevengado, dev.interesPendiente);
      R.eq('TOTAL == capital vivo + interes devengado', liq.total, dev.capitalVivo + dev.interesPendiente);
      R.check('cobertura: hay interes devengado que perder (si no, el aserto es vacio)',
        dev.interesPendiente > 0, `devengado=${dev.interesPendiente}`);
    });
  }

  db.close();
  return R.finalizar();
}

// Cualquier fallo de infraestructura (BD ausente, frontend que no ejecuta) tiene que salir
// con exit != 0: un arnes que no pudo afirmar nada NO es un arnes verde.
let code;
try {
  code = main();
} catch (e) {
  console.error('\n[props-dominio] ABORTADO — el arnes no pudo ejecutarse:');
  console.error(e && e.stack ? e.stack : e);
  code = 2;
}
process.exit(code);
