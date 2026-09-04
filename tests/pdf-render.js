// tests/pdf-render.js — BASELINE DE REGRESION DE LOS GENERADORES DE PDF.
//
// Que hace: ejecuta los generadores REALES de `public/js/pdf/` (via cargarFrontend,
// que los evalua en un contexto `vm`) alimentados con datos REALES de una COPIA de la BD
// de produccion, captura el HTML que emiten por `window.electronAPI.printPDF` y comprueba
// que la ESTRUCTURA del documento no cambio.
//
// Que NO hace: no valida correccion financiera (de eso se ocupa props-dominio.js). Aca la
// pregunta es "¿el refactor movio el documento sin que nos enteremos?".
//
// Como se ejecuta:
//   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron tests/pdf-render.js
//
// ── Tres decisiones de diseno que conviene entender antes de tocar este archivo ──────────
//
// 1. RELOJ CONGELADO. Los 5 generadores leen `new Date()` (fecha de emision, dias de
//    atraso, hero de la factura). Sin congelarlo, la huella cambiaria sola cada dia y el
//    golden master seria inservible. Se sustituye el `Date` del sandbox por una subclase
//    que devuelve un instante fijo cuando se construye sin argumentos. `new Date(iso)`
//    sigue funcionando igual.
//
// 2. EL GOLDEN NO GUARDA DATOS DE PRODUCCION. El repo es PUBLICO. Los importes y el
//    nombre de archivo (que lleva el nombre del deudor) se guardan como DIGESTO sha1, no
//    en claro; las etiquetas de seccion se normalizan reemplazando digitos por '#'. Lo que
//    queda en `tests/golden/` son literales del codigo y conteos, nunca plata ni personas.
//
// 3. LA BD DE PRODUCCION SE MUEVE. Si el usuario cobra una cuota, la huella de VALORES
//    cambia legitimamente. Por eso el golden guarda ademas un hash de la ENTRADA:
//      - entrada igual  -> se comparan estructura Y valores (comparacion fuerte);
//      - entrada distinta -> se compara solo la estructura (que es codigo, no datos) y los
//        valores se re-establecen, avisando en pantalla. Asi el paso del tiempo no produce
//        rojos falsos, pero un cambio de estructura sigue saltando.
//    Independiente del golden, cada caso se genera DOS VECES y se exige huella identica:
//    ese aserto vale aunque el golden se acabe de crear.
//
// ── Tres reglas que hacen que el golden no se pueda "ganar" borrandolo ────────────────────
// (agregadas tras la verificacion adversarial; cada una cierra un verde falso REPRODUCIDO)
//
// A. NUNCA se re-establece una linea base cuya comparacion acaba de FALLAR. Antes, la rama
//    de datos-cambiados reescribia el archivo con la huella NUEVA aunque la estructura
//    hubiera fallado: el fallo se reportaba una vez y la corrida siguiente salia verde con la
//    regresion ya absorbida. Verificado: renombrar una cabecera del cronograma daba rojo en
//    la 1a corrida y verde en la 2a.
//
// B. CREAR una linea base es un ACTO EXPLICITO (`PDF_GOLDEN_INIT=1`). Sin eso, un golden que
//    falta o esta corrupto es un FALLO, no un aviso: antes, `rm tests/golden/*` era la forma
//    mas rapida de poner la suite en verde (21 casos "creados", 0 comparados, exit 0).
//    Las lineas base SI se commitean —el comentario original afirmaba lo contrario, pero los
//    ficheros `pdf-*.json` estan trackeados—, de modo que un clone limpio compara desde la
//    primera corrida en vez de auto-establecerse en vacio. Al agregar un caso hay que crear
//    su linea base con PDF_GOLDEN_INIT=1 y commitearla junto al caso.
//
// C. La huella incluye un DIGESTO DEL TEXTO COMPLETO del documento. La extraccion por lista
//    de clases (`CLASES_ETIQUETA`) es un allowlist: todo lo que no este en la lista solo
//    estaba cubierto por el conteo de bytes. Verificado: cambiar el texto de un badge
//    ("Pagado" -> "PAGADO") o del hero de la factura por otro del MISMO largo pasaba con
//    246/246 OK.

const fs   = require('fs');
const path = require('path');
const crypto = require('crypto');

const LIB = path.join(__dirname, 'lib');
const { Reporter }        = require(path.join(LIB, 'report'));
const { copiaDeProduccion } = require(path.join(LIB, 'db'));
const { cargarFrontend }  = require(path.join(LIB, 'load-frontend'));
const { REPO }            = require(path.join(LIB, 'paths'));

const GOLDEN = path.join(__dirname, 'golden');
const R = new Reporter('pdf-render');

// Establecer lineas base tiene que ser un acto deliberado (regla B de la cabecera).
const INIT_GOLDEN = process.env.PDF_GOLDEN_INIT === '1';
const COMO_INICIAR =
  'Para establecer la linea base a proposito:\n' +
  '  PDF_GOLDEN_INIT=1 ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron tests/pdf-render.js';

// Salida dura para las condiciones que invalidan la suite entera. PROHIBIDO EL VERDE EN
// VACIO: si no se pudo afirmar nada, esto sale con codigo != 0 y dice por que.
function abortar(motivo) {
  console.log('\n########################################################################');
  console.log('ABORTADO — la suite no pudo afirmar nada:');
  console.log(String(motivo).split('\n').map(l => '  ' + l).join('\n'));
  console.log('########################################################################');
  process.exit(2);
}

// ── Carga de datos reales (COPIA de la BD; nunca la productiva) ──────────────────────────

let loans, pays, config;
try {
  const Database = require(path.join(REPO, 'node_modules', 'better-sqlite3'));
  const ruta = copiaDeProduccion('pdf-render');
  const db = new Database(ruta, { readonly: true });
  loans  = db.prepare('SELECT * FROM loans').all();
  pays   = db.prepare('SELECT * FROM payments').all();
  config = {};
  for (const r of db.prepare('SELECT * FROM config').all()) config[r.key] = r.value;
  db.close();
} catch (e) {
  abortar('No se pudo abrir la copia de la BD de produccion.\n' +
          'Recorda que better-sqlite3 esta compilado para el ABI de Electron:\n' +
          '  ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron tests/pdf-render.js\n' +
          (e && e.stack ? e.stack : e));
}
if (!loans || !loans.length || !pays || !pays.length) {
  abortar(`La BD copiada no trae datos (loans=${loans && loans.length}, payments=${pays && pays.length}).`);
}

// ── Carga del frontend real + reloj congelado ────────────────────────────────────────────

let FE;
try { FE = cargarFrontend({ silenciarConsola: true }); }
catch (e) { abortar('cargarFrontend() fallo:\n' + (e && e.stack ? e.stack : e)); }

const S   = FE.simbolos;
const CAP = FE.captura;

const GENERADORES = ['generateCronogramaPDF', 'generateReportePrestamosPDF',
                     'generateRecibo', 'generateFacturaCobro', 'generateReciboAbono',
                     'generateEstadoLiquidacion', 'generateReciboCobro',
                     'generatePropuestaAbono'];
const faltantes = GENERADORES.filter(n => typeof S[n] !== 'function');
if (faltantes.length) {
  abortar('El frontend no expone estos generadores como funciones top-level: ' + faltantes.join(', ') +
          '\nSi el refactor los movio a un modulo, hay que actualizar tests/lib/load-frontend.js.');
}

// Reloj de referencia del arnes. Fijo a proposito (ver nota 1 de la cabecera).
const RelojReal = Date;
const INSTANTE_FIJO = new RelojReal(2026, 6, 31, 12, 0, 0);   // 31-jul-2026 12:00 local
class DateCongelado extends RelojReal {
  constructor(...args) { if (args.length === 0) super(INSTANTE_FIJO.getTime()); else super(...args); }
  static now() { return INSTANTE_FIJO.getTime(); }
}
FE.sandbox.Date = DateCongelado;

// generateRecibo / generateFacturaCobro / generateReciboAbono NO reciben el tema por
// parametro: lo leen de `document.documentElement`. Los otros dos si lo reciben.
function ponerTema(t) { FE.sandbox.document.documentElement.setAttribute('data-theme', t); }

// ── Datos de los casos ───────────────────────────────────────────────────────────────────

const L = id => loans.find(x => x.id === id);
const cuota = (loanId, n, arr) => (arr || pays).find(p => p.prestamoId === loanId && p.cuotaN === n);

// Un PAGO PARCIAL EN VUELO (partialPaid > 0 sobre una cuota que sigue Pendiente) es el caso
// que el sprint v2.3.0 acaba de arreglar y el que mas facil se rompe en un refactor. Hoy la
// BD de produccion no tiene ninguno vivo (las 32 filas con partialPaid > 0 ya estan Pagadas),
// asi que se inyecta sobre una cuota REAL, en memoria y sobre una copia profunda del array:
// la BD no se toca y los demas casos no se contaminan.
const paysParcial = JSON.parse(JSON.stringify(pays));
const LOAN_PARCIAL = '17795544041379obc';                       // Nicolas Duarte, C+I COP
const cuotaParcial = cuota(LOAN_PARCIAL, 3, paysParcial);
if (!cuotaParcial) {
  abortar(`No se encontro la cuota 3 del prestamo ${LOAN_PARCIAL} para inyectar el parcial en vuelo.\n` +
          'Los datos de produccion cambiaron: elegi otra cuota Pendiente de un Capital + Intereses.');
}
cuotaParcial.partialPaid      = 300000;                         // interes del periodo: 209.459
cuotaParcial.montoCOPRecibido = 300000;                         // -> 90.541 imputados a capital
cuotaParcial.recibos          = '[{"fecha":"2026-07-28","cop":300000}]';

// Un parcial sobre una cuota PENDIENTE no alcanza: el Reporte de Activos descuenta lo abonado
// con helpers PROPIOS (`saldoMora` / `saldoMoraUSD`, Bugs #42 y #45) que solo corren sobre las
// sub-filas de cuotas EN MORA. Sin un parcial ahi, esa rama no se ejercita y una regresion que
// vuelva a cobrarle al deudor lo que ya pago pasa desapercibida (verificado: neutralizar
// `saldoMora` daba 246/246 OK). Se inyectan dos, para cubrir las dos monedas:
//   - COP: Ana Restrepo, modalidad Intereses (cuota de puro interes).
//   - USD: Elena Vargas, Capital + Intereses, con `montoUSDRecibido` para que `saldoMoraUSD` mida
//     dolares contra dolares en vez de reconvertir los COP (doctrina del Bug #23).
const moraParcialCOP = cuota('1773655076017', 4, paysParcial);
const moraParcialUSD = cuota('1782151590658w66y', 2, paysParcial);
if (!moraParcialCOP || !moraParcialUSD) {
  abortar('No se encontraron las cuotas En Mora sobre las que se inyecta el parcial\n' +
          '(1773655076017-4 en COP, 1782151590658w66y-2 en USD). Los datos de produccion\n' +
          'cambiaron: elegi otras dos cuotas En Mora, una COP y una USD.');
}
moraParcialCOP.partialPaid      = 120000;                       // cuota 300.000 -> faltan 180.000
moraParcialCOP.montoCOPRecibido = 120000;
moraParcialCOP.recibos          = '[{"fecha":"2026-07-26","cop":120000}]';

moraParcialUSD.partialPaid      = 700000;                       // cuota 1.472.407 COP / USD 400
moraParcialUSD.montoCOPRecibido = 700000;
moraParcialUSD.montoUSDRecibido = 190;                          // -> saldoMoraUSD = 400 - 190
moraParcialUSD.recibos          = '[{"fecha":"2026-07-27","cop":700000}]';

// Replica de `_snapshotAbono` (funcion interna de App, no accesible desde aca). Devuelve el
// estado PREVIO al abono, que es lo que el recibo imprime como "Saldo anterior".
function snapshotPrevio(loan, arrPays, monto) {
  const lp = arrPays.filter(p => p.prestamoId === loan.id);
  const esUSD = loan.moneda === 'USD', trm = loan.trmAcordada || 1;
  const orig = esUSD ? Math.round(loan.montoOrigen * trm) : Math.round(loan.montoOrigen);
  const capPag = lp.filter(p => p.estadoPago === 'Pagado').reduce((s, p) => s + p.abonoCapital, 0);
  const pend = lp.filter(p => p.id.indexOf('-ab-') === -1 && p.estadoPago === 'Pendiente')
                 .sort((a, b) => a.cuotaN - b.cuotaN);
  return {
    saldo:     Math.max(0, orig - capPag) + monto,
    saldoCaja: S.saldoConCaja(loan, lp) + monto,
    cuota:     pend.length ? pend[0].cuotaTotal : 0,
    cuotas:    pend.length,
    intereses: pend.reduce((s, p) => s + p.interesPeriodo, 0),
    plazo:     loan.plazoMeses,
  };
}

// Arma el argumento `cobro` del Recibo de Cobro usando el planificador REAL. Se cobra toda
// la mora mas una parte del capital amortizable, que es el caso que obliga al documento a
// explicar los dos tipos de movimiento. En USD la caja se aparta a proposito de la
// obligacion (TRM del dia por debajo de la pactada) para que el recibo declare ambas.
// Variante del anterior con el override `incluirInteresMes` activo. Existe porque el
// documento cambia de forma: aparece un paso "por adelantado" y un rubro propio, y el
// recibo NO debe llamar "vencida" a una cuota que aun no vence. En la prueba real que
// destapo el defecto, un cobro del 3 de sept declaraba atrasada una cuota del 19.
function cobroConInteresMes(loan, arrPays) {
  const esUSD = loan.moneda === 'USD';
  const cob = S.cobrableTotal(loan, arrPays);
  if (!(cob.interesMes > 0)) {
    abortar('cobroConInteresMes(' + loan.id + '): el credito no tiene interes del mes por cobrar. ' +
            'Sin eso este caso no ejercita nada: elegi otro prestamo.');
  }
  const objetivo = Math.round(cob.mora + cob.interesMes + Math.max(100000, cob.abonable * 0.2));
  const plan = S.planCascada(loan, arrPays, esUSD
    ? { obligacionUSD: Math.round(objetivo / loan.trmAcordada * 100) / 100,
        cajaCOP: Math.round(objetivo * 0.96), obligacionCOP: 0 }
    : { obligacionCOP: objetivo, cajaCOP: objetivo, obligacionUSD: 0 },
    { incluirInteresMes: true });
  if (!plan.ok || !plan.pasos.some(p => p.esInteresMes)) {
    abortar('cobroConInteresMes(' + loan.id + '): el plan no incluyo el paso del interes del mes (' +
            (plan.error || 'sin error') + ').');
  }
  const lp = arrPays.filter(p => p.prestamoId === loan.id);
  const pend = lp.filter(p => p.id.indexOf('-ab-') === -1 && p.estadoPago === 'Pendiente')
                 .sort((a, b) => a.cuotaN - b.cuotaN);
  return {
    fecha: '2026-07-20', pasos: plan.pasos, observaciones: 'Cobro con interes del mes',
    pre: { saldoCaja: S.saldoConCaja(loan, lp), cuota: pend.length ? pend[0].cuotaTotal : 0 },
  };
}

// La Propuesta de Abono necesita, ademas del plan, la PROYECCION que el modal dibuja:
// el preview del cronograma y el total por pagar. Se arma con los mismos helpers
// (`previewRecalculo`, `filasPreview`, `proyeccionCobro`), que es lo que el modal usa.
function propuestaDe(loan, arrPays) {
  const cob = S.cobrableTotal(loan, arrPays);
  const esUSD = loan.moneda === 'USD';
  const objetivo = Math.round(cob.mora + Math.max(100000, cob.abonable * 0.3));
  const plan = S.planCascada(loan, arrPays, esUSD
    ? { obligacionUSD: Math.round(objetivo / loan.trmAcordada * 100) / 100,
        cajaCOP: Math.round(objetivo * 0.97), obligacionCOP: 0 }
    : { obligacionCOP: objetivo, cajaCOP: objetivo, obligacionUSD: 0 }, {});
  if (!plan.ok || !plan.pasos.some(p => p.tipo === 'abono')) {
    abortar('propuestaDe(' + loan.id + '): el plan no produjo abono (' + (plan.error || 'sin error') +
            '). Sin abono no hay cronograma proyectado y el caso no probaria nada.');
  }
  const lp = arrPays.filter(p => p.prestamoId === loan.id);
  const pend = lp.filter(p => p.id.indexOf('-ab-') === -1 && p.estadoPago === 'Pendiente')
                 .sort((a, b) => a.cuotaN - b.cuotaN);
  const nAct = Math.max(0, (+loan.plazoMeses || 0) - plan.ctx.regularConsumed);
  const r = S._tasaPeriodo((+loan.tasaMensual || 0) / 100, loan.frecuencia || 'Mensual');
  const pv = S.previewRecalculo(plan.saldoTrasCascada, r, nAct, 'mantener', null);
  const filas = S.filasPreview(plan.saldoTrasCascada, r, pv.nCuotas, false, pv.cuota);
  filas.forEach((f, i) => { f.cuotaN = plan.ctx.regularConsumed + 1 + i;
                            f.fecha = pend[i] ? pend[i].fechaPago : null; });
  const proy = S.proyeccionCobro(loan, arrPays, plan, filas, pend);
  return {
    fecha: '2026-07-20', plan,
    cajaCOP: esUSD ? Math.round(objetivo * 0.97) : objetivo,
    proyeccion: { filas, n: pv.nCuotas, saldado: false,
                  totalAntes: proy.totalAntes, totalDespues: proy.totalDespues,
                  abonadoProxima: proy.abonadoProxima,
                  cuotaAntes: pend.length ? Math.round(pend[0].cuotaTotal) : 0 },
  };
}

// Variante con el interes del mes adelantado: es la UNICA forma de que la cuota proyectada
// quede con dinero encima, que es lo que dispara la sub-linea de la tabla. Sin este caso, esa
// rama no la ejercitaba nadie (verificado: la suite quedaba verde con la sub-linea intacta).
function propuestaConInteresMes(loan, arrPays, modo, valor) {
  const cob = S.cobrableTotal(loan, arrPays);
  if (!(cob.interesMes > 0 && cob.abonable > 0)) {
    abortar('propuestaConInteresMes(' + loan.id + '): el credito no tiene interes del mes y ' +
            'capital amortizable a la vez. Sin las dos cosas no hay abono NI sub-linea.');
  }
  const esUSD = loan.moneda === 'USD';
  const objetivo = Math.round(cob.mora + cob.interesMes + Math.max(100000, cob.abonable * 0.25));
  const plan = S.planCascada(loan, arrPays, esUSD
    ? { obligacionUSD: Math.round(objetivo / loan.trmAcordada * 100) / 100,
        cajaCOP: Math.round(objetivo * 0.97), obligacionCOP: 0 }
    : { obligacionCOP: objetivo, cajaCOP: objetivo, obligacionUSD: 0 },
    { incluirInteresMes: true });
  if (!plan.ok || !plan.pasos.some(p => p.esInteresMes) || !plan.pasos.some(p => p.tipo === 'abono')) {
    abortar('propuestaConInteresMes(' + loan.id + '): el plan necesita el paso del interes del ' +
            'mes Y un abono (' + (plan.error || 'sin error') + ').');
  }
  const lp = arrPays.filter(p => p.prestamoId === loan.id);
  const pend = lp.filter(p => p.id.indexOf('-ab-') === -1 && p.estadoPago === 'Pendiente')
                 .sort((a, b) => a.cuotaN - b.cuotaN);
  const nAct = Math.max(0, (+loan.plazoMeses || 0) - plan.ctx.regularConsumed);
  const r = S._tasaPeriodo((+loan.tasaMensual || 0) / 100, loan.frecuencia || 'Mensual');
  const pv = S.previewRecalculo(plan.saldoTrasCascada, r, nAct, modo || 'mantener',
                                (modo === 'modificarPlazo' || modo === 'fijarCuota') ? valor : null);
  const filas = S.filasPreview(plan.saldoTrasCascada, r, pv.nCuotas, false, pv.cuota);
  filas.forEach((f, i) => { f.cuotaN = plan.ctx.regularConsumed + 1 + i;
                            f.fecha = pend[i] ? pend[i].fechaPago : null; });
  const proy = S.proyeccionCobro(loan, arrPays, plan, filas, pend);
  if (!(Math.round(proy.abonadoProxima || 0) > 0)) {
    abortar('propuestaConInteresMes(' + loan.id + '): la proxima cuota no quedo con abono ' +
            'encima, que es justo lo que este caso viene a fijar.');
  }
  return {
    fecha: '2026-07-20', plan,
    cajaCOP: esUSD ? Math.round(objetivo * 0.97) : objetivo,
    proyeccion: { filas, n: pv.nCuotas, saldado: false,
                  totalAntes: proy.totalAntes, totalDespues: proy.totalDespues,
                  abonadoProxima: proy.abonadoProxima, moraTras: proy.moraTras,
                  cuotaAntes: pend.length ? Math.round(pend[0].cuotaTotal) : 0 },
  };
}

function cobroDe(loan, arrPays) {
  const esUSD = loan.moneda === 'USD';
  const cob = S.cobrableTotal(loan, arrPays);
  const objetivo = Math.round(cob.mora + Math.min(cob.abonable, Math.max(100000, cob.abonable * 0.2)));
  const plan = S.planCascada(loan, arrPays, esUSD
    ? { obligacionUSD: Math.round(objetivo / loan.trmAcordada * 100) / 100,
        cajaCOP: Math.round(objetivo * 0.96), obligacionCOP: 0 }
    : { obligacionCOP: objetivo, cajaCOP: objetivo, obligacionUSD: 0 });
  if (!plan.ok || !plan.pasos.length) {
    abortar('cobroDe(' + loan.id + '): planCascada no produjo pasos (' + (plan.error || 'sin error') + '). ' +
            'Los datos del fixture cambiaron: elegi otro prestamo para el caso del Recibo de Cobro.');
  }
  const lp = arrPays.filter(p => p.prestamoId === loan.id);
  const pend = lp.filter(p => p.id.indexOf('-ab-') === -1 && p.estadoPago === 'Pendiente')
                 .sort((a, b) => a.cuotaN - b.cuotaN);
  return {
    fecha: '2026-07-20', pasos: plan.pasos, observaciones: 'Cobro de prueba',
    pre: { saldoCaja: S.saldoConCaja(loan, lp), cuota: pend.length ? pend[0].cuotaTotal : 0 },
  };
}

// ── Definicion de los casos ──────────────────────────────────────────────────────────────
//
// `celdas`: cuantas celdas debe tener CADA <tr> del documento (contando colspan).
//           null = el documento no lleva tablas y no debe haber ningun <tr>.
// `contiene`: literales que DEBEN aparecer. Son la prueba de que el caso ejercito de verdad
//           la rama que dice ejercitar (un caso "USD" que no imprime dolares no cubre nada).

// Estado para el caso HERO: UNA sola cuota viva con un parcial encima que ya cubrio su
// interes. Se construye sobre una copia profunda (la BD y los demas casos no se tocan)
// marcando como Pagadas todas las cuotas regulares menos la ultima.
const LOAN_HERO = '1782151590658w66y';
const paysHero = JSON.parse(JSON.stringify(pays));
(function () {
  const reg = paysHero.filter(p => p.prestamoId === LOAN_HERO && p.id.indexOf('-ab-') === -1)
                      .sort((a, b) => a.cuotaN - b.cuotaN);
  if (reg.length < 2) {
    abortar(`El prestamo ${LOAN_HERO} ya no tiene 2+ cuotas regulares para armar el caso HERO.`);
  }
  const ultima = reg[reg.length - 1];
  reg.slice(0, -1).forEach(p => {
    p.estadoPago = 'Pagado';
    p.partialPaid = p.cuotaTotal;
    p.fechaRecaudo = p.fechaPago;
    p.montoCOPRecibido = p.cuotaTotal;
    p.recibos = JSON.stringify([{ fecha: p.fechaPago, cop: Math.round(p.cuotaTotal) }]);
  });
  // El parcial tiene que SUPERAR el interes del periodo: por debajo, `imputarCobros` no
  // llega a capital, el saldo no se mueve y la identidad que dispara el hero no se cumple.
  const abono = Math.round(ultima.interesPeriodo * 1.4);
  ultima.estadoPago = 'Pendiente';
  ultima.partialPaid = abono;
  ultima.montoCOPRecibido = abono;
  ultima.fechaRecaudo = null;
  ultima.recibos = JSON.stringify([{ fecha: '2026-07-28', cop: abono }]);
})();

const CASOS = [
  // ── generateCronogramaPDF — 4 modalidades, COP y USD, mora, abono, parcial ────────────
  { nombre: 'crono-capint-cop-abono', gen: 'generateCronogramaPDF', tema: 'light', celdas: 7,
    entrada: () => ({ loanId: '1776205975507jkph', tema: 'light', dark: false }),
    ejecutar: () => S.generateCronogramaPDF(L('1776205975507jkph'), pays, false),
    contiene: ['badge-abono', 'ABONOS', 'Capital + Intereses', 'Valor de liquidacion'] },

  { nombre: 'crono-capint-usd-mora', gen: 'generateCronogramaPDF', tema: 'dark', celdas: 7,
    entrada: () => ({ loanId: '1782151590658w66y', tema: 'dark', dark: true }),
    ejecutar: () => S.generateCronogramaPDF(L('1782151590658w66y'), pays, true),
    contiene: ['badge-mora', 'USD $', '#0d1117'] },

  { nombre: 'crono-intereses-cop-mora', gen: 'generateCronogramaPDF', tema: 'light', celdas: 7,
    entrada: () => ({ loanId: '1773655076017', tema: 'light', dark: false }),
    ejecutar: () => S.generateCronogramaPDF(L('1773655076017'), pays, false),
    contiene: ['INTERESES PAGADOS', 'plazo indefinido'] },

  { nombre: 'crono-prestamo-cop', gen: 'generateCronogramaPDF', tema: 'light', celdas: 7,
    entrada: () => ({ loanId: '1782442889816wjhf', tema: 'light', dark: false }),
    ejecutar: () => S.generateCronogramaPDF(L('1782442889816wjhf'), pays, false),
    contiene: ['>Prestamo</span>'] },

  { nombre: 'crono-pagounico-usd', gen: 'generateCronogramaPDF', tema: 'dark', celdas: 7,
    entrada: () => ({ loanId: '1784667444678qsmr', tema: 'dark', dark: true }),
    ejecutar: () => S.generateCronogramaPDF(L('1784667444678qsmr'), pays, true),
    contiene: ['ganancia pactada', 'Pago Unico'] },

  { nombre: 'crono-capint-cop-parcial', gen: 'generateCronogramaPDF', tema: 'light', celdas: 7,
    entrada: () => ({ loanId: LOAN_PARCIAL, parcial: true, tema: 'light', dark: false }),
    ejecutar: () => S.generateCronogramaPDF(L(LOAN_PARCIAL), paysParcial, false),
    contiene: ['badge-parcial', 'Abonado'] },

  // ── generateReportePrestamosPDF — cartera completa, ambos temas ───────────────────────
  { nombre: 'reporte-activos-claro', gen: 'generateReportePrestamosPDF', tema: 'light', celdas: 8,
    entrada: () => ({ todos: true, tema: 'light', dark: false }),
    ejecutar: () => S.generateReportePrestamosPDF(loans, pays, false),
    contiene: ['Capital total en la calle', 'Referencia de estados', 'mora-sub'] },

  // Este caso es el unico que ejercita `saldoMora`/`saldoMoraUSD`: los parciales inyectados
  // sobre cuotas EN MORA hacen que las sub-filas rojas anoten "abonado X de Y" y que tanto el
  // total vencido como su equivalente en dolares descuenten lo ya recibido.
  { nombre: 'reporte-activos-oscuro-parcial', gen: 'generateReportePrestamosPDF', tema: 'dark', celdas: 8,
    entrada: () => ({ todos: true, parcial: true, tema: 'dark', dark: true }),
    ejecutar: () => S.generateReportePrestamosPDF(loans, paysParcial, true),
    contiene: ['Capital total en la calle', '#0d1117', 'abonado ', 'Incluye USD'] },

  // ── generateRecibo — pago completo, parcial y USD ─────────────────────────────────────
  // Se cobra una cuota PENDIENTE, no una ya Pagada: el recibo se emite ANTES de persistir
  // (por eso `allPays` es el estado previo y la imputacion parte de lo que la cuota debia).
  // Sobre una cuota ya saldada, `pendienteDeCuota` da 0 y las filas de interes y capital
  // se suprimen — util como caso limite, pero no representa el flujo real.
  { nombre: 'recibo-pago-completo-cop', gen: 'generateRecibo', tema: 'light', celdas: null,
    entrada: () => ({ loanId: '1776205975507jkph', cuotaN: 4, cop: 393610, usd: 0, tema: 'light' }),
    ejecutar: () => S.generateRecibo(cuota('1776205975507jkph', 4), L('1776205975507jkph'),
                                     393610, 0, pays, { fechaRecaudo: '2026-08-14' }),
    contiene: ['Recibo de Pago', 'Abono a capital', 'Intereses', 'pago puntual'] },

  { nombre: 'recibo-parcial-cop', gen: 'generateRecibo', tema: 'light', celdas: null,
    entrada: () => ({ loanId: LOAN_PARCIAL, cuotaN: 3, cop: 100000, previo: 300000, parcial: true, tema: 'light' }),
    ejecutar: () => S.generateRecibo(cuota(LOAN_PARCIAL, 3, paysParcial), L(LOAN_PARCIAL),
                                     100000, 0, paysParcial,
                                     { fechaRecaudo: '2026-07-31', yaAbonadoPrev: 300000 }),
    contiene: ['Recibo de Abono Parcial', 'Restante por pagar', 'Abonado previamente'] },

  // Cuota USD En Mora cobrada con MENOS pesos de los proyectados (TRM del dia por debajo de
  // la pactada): los dolares cubren la cuota, asi que NO es un pago parcial (doctrina del
  // Bug #23). Es el escenario bimonetario que mas facil se rompe.
  { nombre: 'recibo-usd-oscuro', gen: 'generateRecibo', tema: 'dark', celdas: null,
    entrada: () => ({ loanId: '1782151590658w66y', cuotaN: 2, cop: 1272258, usd: 400, tema: 'dark' }),
    ejecutar: () => S.generateRecibo(cuota('1782151590658w66y', 2), L('1782151590658w66y'),
                                     1272258, 400, pays, { fechaRecaudo: '2026-07-31' }),
    contiene: ['USD $400.00', 'Pago completo', 'Intereses', 'Abono a capital', '#0d1117'] },

  // ── generateFacturaCobro — mora / hoy / proximo, USD, transitoria y parcial ───────────
  { nombre: 'factura-mora-cop', gen: 'generateFacturaCobro', tema: 'light', celdas: null,
    entrada: () => ({ loanId: '1773655076017', cuotaN: 4, tema: 'light' }),
    ejecutar: () => S.generateFacturaCobro(cuota('1773655076017', 4), L('1773655076017'),
                                           pays, config.datos_pago, {}),
    contiene: ['Aviso de mora', 'Como pagar', 'FC-'] },

  { nombre: 'factura-usd-mora', gen: 'generateFacturaCobro', tema: 'dark', celdas: null,
    entrada: () => ({ loanId: '1782151590658w66y', cuotaN: 2, tema: 'dark' }),
    ejecutar: () => S.generateFacturaCobro(cuota('1782151590658w66y', 2), L('1782151590658w66y'),
                                           pays, config.datos_pago, {}),
    contiene: ['Aviso de mora', 'USD $', '#0d1117'] },

  { nombre: 'factura-hoy-pagounico', gen: 'generateFacturaCobro', tema: 'light', celdas: null,
    entrada: () => ({ loanId: '1783874778375ziu4', cuotaN: 1, tema: 'light' }),
    ejecutar: () => S.generateFacturaCobro(cuota('1783874778375ziu4', 1), L('1783874778375ziu4'),
                                           pays, config.datos_pago, {}),
    contiene: ['Recordatorio', 'HOY'] },

  { nombre: 'factura-transitoria-proxima', gen: 'generateFacturaCobro', tema: 'light', celdas: null,
    entrada: () => ({ loanId: '1782872189716p6cz', cuotaN: 1, tema: 'light' }),
    ejecutar: () => S.generateFacturaCobro(cuota('1782872189716p6cz', 1), L('1782872189716p6cz'),
                                           pays, config.datos_pago, {}),
    contiene: ['Aviso de proximo vencimiento', 'Cuota Transitoria', 'Interes prorrateado'] },

  { nombre: 'factura-parcial-cop', gen: 'generateFacturaCobro', tema: 'light', celdas: null,
    entrada: () => ({ loanId: LOAN_PARCIAL, cuotaN: 3, parcial: true, tema: 'light' }),
    ejecutar: () => S.generateFacturaCobro(cuota(LOAN_PARCIAL, 3, paysParcial), L(LOAN_PARCIAL),
                                           paysParcial, config.datos_pago, {}),
    contiene: ['Desglose de lo que falta', 'Ya abonaste', 'Total pendiente'] },

  // ── generateReciboAbono — variantes completa / corta / paz y salvo ────────────────────
  { nombre: 'abono-capint-cop-mantener', gen: 'generateReciboAbono', tema: 'light', celdas: 6,
    entrada: () => ({ loanId: '1776205975507jkph', monto: 560000, mode: 'mantener', tema: 'light' }),
    ejecutar: () => S.generateReciboAbono(L('1776205975507jkph'), pays, {
      monto: 560000, fecha: '2026-07-18', recalcMode: 'mantener',
      pre: snapshotPrevio(L('1776205975507jkph'), pays, 560000) }),
    contiene: ['Impacto del abono', 'Cronograma actualizado', 'Recalculo aplicado', 'AB-'] },

  { nombre: 'abono-capint-usd-modificarplazo', gen: 'generateReciboAbono', tema: 'dark', celdas: 6,
    entrada: () => ({ loanId: '1782151590658w66y', monto: 1000000, usd: 271.66, mode: 'modificarPlazo', tema: 'dark' }),
    ejecutar: () => S.generateReciboAbono(L('1782151590658w66y'), pays, {
      monto: 1000000, montoUSD: 271.66, fecha: '2026-07-20', recalcMode: 'modificarPlazo',
      pre: snapshotPrevio(L('1782151590658w66y'), pays, 1000000) }),
    contiene: ['Plazo restante', 'USD $', '#0d1117'] },

  { nombre: 'abono-corta-intereses-cop', gen: 'generateReciboAbono', tema: 'light', celdas: null,
    entrada: () => ({ loanId: '1773656070840', monto: 100000, mode: 'mantener', tema: 'light' }),
    ejecutar: () => S.generateReciboAbono(L('1773656070840'), pays, {
      monto: 100000, fecha: '2026-07-20', recalcMode: 'mantener',
      pre: snapshotPrevio(L('1773656070840'), pays, 100000) }),
    contiene: ['Resumen', 'Nuevo saldo pendiente'] },

  // ── generateReciboCobro — comprobante consolidado del cobro en cascada ────────────────
  // v2.9.6: estos casos declaraban `celdas: null` porque el bloque 4 era un RESUMEN sin
  // tabla. Ya no: el documento incluye "Lo que queda por pagar", cuota por cuota, con lo
  // ya abonado en cada una. El resumen solo no alcanzaba — en una prueba real convivian
  // "saldo de capital USD 117.65" y "valor de la cuota USD 157.79" con UNA cuota
  // pendiente, sin forma de ver que la diferencia era el interes que el cliente acababa
  // de adelantar sobre esa misma cuota. El Paz y Salvo sigue en `null`: alli no hay
  // bloque 4 porque no queda credito.
  // Los pasos se construyen con `planCascada` REAL sobre los datos del fixture: escribirlos
  // a mano fijaria una forma que podria dejar de ser la que el orquestador produce, y este
  // documento existe precisamente para describir esa forma.
  //
  // v2.9.6: la PRIMERA tarjeta del bloque 4 es "Total por pagar" — la misma cifra con la
  // que abre la Propuesta de Abono. Antes cada papel de la misma operacion lideraba con
  // algo distinto en el mismo lugar visual (total alla, saldo de capital aca) y parecian
  // contradecirse. Que las dos tarjetas convivan es lo que se fija aqui; que su cifra
  // COINCIDA con la de la propuesta lo fija la seccion J de `cascada-cobro`.
  { nombre: 'cobro-cascada-usd-oscuro', gen: 'generateReciboCobro', tema: 'dark', celdas: 5,
    entrada: () => ({ loanId: '1782151590658w66y', cascada: true, tema: 'dark', dark: true }),
    ejecutar: () => S.generateReciboCobro(L('1782151590658w66y'), pays,
      cobroDe(L('1782151590658w66y'), pays)),
    // Con mora viva el rotulo de la cuota NO puede prometer un proximo pago: hay plata
    // vencida que se debe ANTES de esa fecha. Se degrada a "Proxima cuota" y el pie rojo
    // sigue anunciando lo vencido.
    contiene: ['Recibo de Cobro', 'Como se aplico tu pago', 'rc-paso', 'Total aplicado',
               'Caja registrada en pesos', 'USD $', 'RC-', '#0d1117',
               'Total por pagar', 'capital + intereses',
               'Proxima cuota', 'A PAGAR', 'cuotas vencidas'],
    noContiene: ['A pagar el'] },

  // v2.9.6 — el override `incluirInteresMes`. Lo que este caso fija, y que fallaba:
  //   - el paso se rotula "Interes del mes", NO "Cuota #N vencida";
  //   - dice "aun no vence", no "vencia el";
  //   - el rubro es "Interes del mes en curso", separado de "Intereses vencidos";
  //   - y el bloque "Lo que queda por pagar" detalla la cuota con lo ya abonado.
  // ── generatePropuestaAbono — el papel que se manda ANTES de cobrar ────────────────────
  // Lo que este caso fija: que el documento NO se presente como comprobante. Un papel con
  // el membrete de la app y cifras exactas que dijera "recibido" seria un registro falso
  // de dinero que nunca entro.
  { nombre: 'propuesta-usd-oscuro', gen: 'generatePropuestaAbono', tema: 'dark', celdas: 6,
    entrada: () => ({ loanId: '1782151590658w66y', propuesta: true, tema: 'dark', dark: true }),
    ejecutar: () => S.generatePropuestaAbono(L('1782151590658w66y'), pays,
      propuestaDe(L('1782151590658w66y'), pays)),
    contiene: ['Propuesta de Abono', 'Si abonas', 'Asi se aplicaria tu pago',
               'Asi quedaria tu credito', 'Total por pagar', 'Cronograma que quedaria',
               'no un comprobante', 'PA-', '#0d1117'],
    noContiene: ['TOTAL RECIBIDO', 'Total recibido', 'certifica el dinero', 'Recibido el'] },

  { nombre: 'propuesta-cop-claro', gen: 'generatePropuestaAbono', tema: 'light', celdas: 6,
    entrada: () => ({ loanId: '1773655076017', propuesta: true, tema: 'light', dark: false }),
    ejecutar: () => S.generatePropuestaAbono(L('1773655076017'), pays,
      propuestaDe(L('1773655076017'), pays)),
    // En `Intereses` la Propuesta ya no titula un total: sus cuotas son de puro interes y
    // el capital vence fuera del cronograma. Este caso llego a emitir "Quedaria un solo
    // pago de 2.310.000" sobre un capital de 3.000.000, el mismo defecto que el recibo
    // cierra con su gate. Es inalcanzable desde la UI (el preview solo existe en C+I) pero
    // este arnes SI lo alcanza, asi que el gate vive en el generador y se fija aqui.
    contiene: ['Propuesta de Abono', 'Si abonas', 'A pagar el', 'no un comprobante'],
    noContiene: ['TOTAL RECIBIDO', 'certifica el dinero', 'Total por pagar',
                 'Quedaria un solo pago'] },

  // La fila que YA TRAE DINERO ADENTRO lo dice en una sub-linea. Sin ella, el encabezado
  // anunciaba "a pagar 144.59" y la primera fila mostraba "500.00" para la MISMA fecha, sin
  // nada que las uniera: el lector concluia que el papel se contradice. `VALOR CUOTA` sigue
  // siendo la cuota entera porque es lo que sostiene la identidad con INTERES y ABONO A
  // CAPITAL; el neto va aparte. Y el titular ya no repite la resta: la explica la tabla.
  { nombre: 'propuesta-con-interes-adelantado', gen: 'generatePropuestaAbono', tema: 'light', celdas: 6,
    entrada: () => ({ loanId: '1782151590658w66y', propuesta: true, interesMes: true, tema: 'light', dark: false }),
    ejecutar: () => S.generatePropuestaAbono(L('1782151590658w66y'), pays,
      propuestaConInteresMes(L('1782151590658w66y'), pays)),
    contiene: ['pa-ab', 'esta cuota quedaria con', 'a pagar', 'Cronograma que quedaria',
               'POR ADELANTADO', 'no un comprobante'],
    // El titular no vuelve a explicar la resta que la sub-linea ya explico.
    // 'ya abonado' es la frase exacta que llevaba el titular; 'menos' a secas seria un
    // aserto fragil, esa palabra puede aparecer en cualquier copy futuro sin ser el defecto.
    noContiene: ['ya abonado'] },

  // El HERO de la Propuesta: con UNA sola cuota proyectada el total y el proximo pago son
  // el mismo numero y las tarjetas colapsan en una. Su titular NO repite la resta —la
  // explica la sub-linea de la fila, que aqui tambien esta— y solo lleva la fecha.
  { nombre: 'propuesta-hero-un-solo-pago', gen: 'generatePropuestaAbono', tema: 'light', celdas: 6,
    entrada: () => ({ loanId: '1782151590658w66y', propuesta: true, hero: true, tema: 'light', dark: false }),
    ejecutar: () => S.generatePropuestaAbono(L('1782151590658w66y'), pays,
      propuestaConInteresMes(L('1782151590658w66y'), pays, 'modificarPlazo', 1)),
    contiene: ['pa-hero', 'Quedaria un solo pago', 'esta cuota quedaria con', 'a pagar'],
    // Lo que el titular dejo de decir, porque la tabla ya lo dice.
    noContiene: ['ya abonado', 'Total por pagar', 'Cuotas restantes'] },

  { nombre: 'cobro-con-interes-del-mes', gen: 'generateReciboCobro', tema: 'dark', celdas: 5,
    entrada: () => ({ loanId: '1782151590658w66y', cascada: 'interesMes', tema: 'dark', dark: true }),
    ejecutar: () => S.generateReciboCobro(L('1782151590658w66y'), pays,
      cobroConInteresMes(L('1782151590658w66y'), pays)),
    contiene: ['Interes del mes', 'POR ADELANTADO', 'aun no vence',
               'Interes del mes en curso', 'Lo que queda por pagar',
               'YA ABONADO', 'TOTAL POR PAGAR', 'Total por pagar', 'capital + intereses'],
    // En este escenario el dinero salda TODA la mora, asi que ningun paso puede quedar
    // debiendo. Si "queda debiendo" reaparece es el paso del interes del mes imprimiendo
    // su `restanteCuota`, que es una cifra PREVIA al abono y por tanto ya falsa cuando el
    // abono regenera el cronograma (medido: decia USD 243.38 debiendo USD 117.65).
    noContiene: ['queda debiendo'] },

  { nombre: 'cobro-cascada-cop-intereses', gen: 'generateReciboCobro', tema: 'light', celdas: 5,
    entrada: () => ({ loanId: '1773655076017', cascada: true, tema: 'light', dark: false }),
    ejecutar: () => S.generateReciboCobro(L('1773655076017'), pays,
      cobroDe(L('1773655076017'), pays)),
    contiene: ['Recibo de Cobro', 'Intereses vencidos', 'Como se imputa el pago',
               'Tu credito despues de este pago',
               // La tabla SI totaliza lo que lista...
               'TOTAL POR PAGAR'],
    // ...pero la TARJETA no se dibuja en modalidad `Intereses`: sus cuotas son de puro
    // interes y el capital vence al final, fuera del cronograma. El titular diria
    // "Total por pagar 2.700.000" bajo un "Saldo de capital 3.000.000" — menos deuda de
    // la que hay. Este es el credito con el que se midio.
    noContiene: ['Total por pagar', 'capital + intereses'] },

  // Un cobro de UN solo paso: sin mora, la cascada degenera en un abono. Aqui la nota que
  // explica el orden de imputacion no debe aparecer (no hay nada que repartir).
  { nombre: 'cobro-un-solo-paso', gen: 'generateReciboCobro', tema: 'light', celdas: 5,
    entrada: () => ({ loanId: '17795544041379obc', cascada: true, unPaso: true, tema: 'light', dark: false }),
    ejecutar: () => S.generateReciboCobro(L('17795544041379obc'), pays,
      cobroDe(L('17795544041379obc'), pays)),
    // Sin mora, el rotulo si puede comprometer la fecha del proximo giro.
    contiene: ['Abono extraordinario a capital', 'Saldo de capital', 'Total por pagar',
               'A pagar el', 'A PAGAR'],
    noContiene: ['Proxima cuota'] },

  // El colapso a UNA sola tarjeta. Con una cuota viva y un parcial que ya cubrio su
  // interes, el total por pagar, el saldo de capital y el proximo pago son EL MISMO
  // numero. No es casualidad, es una identidad:
  //   total        = cuota - abonado
  //   saldoConCaja = capital - (abonado - interes) = capital + interes - abonado = total
  // Tres tarjetas repitiendo la cifra se leen como un error del documento, asi que se
  // reemplazan por una sola que dice lo unico que el cliente necesita: cuanto gira y
  // cuando. El fixture no tiene un credito en ese estado; se construye en memoria.
  { nombre: 'cobro-hero-un-solo-pago', gen: 'generateReciboCobro', tema: 'light', celdas: 5,
    entrada: () => ({ loanId: LOAN_HERO, hero: true, tema: 'light', dark: false }),
    ejecutar: () => S.generateReciboCobro(L(LOAN_HERO), paysHero, cobroDe(L(LOAN_HERO), paysHero)),
    // `rc-hero` es el aserto que de verdad importa: si la identidad dejara de cumplirse,
    // el documento volveria a las tres tarjetas y este caso se pondria rojo sin ambiguedad.
    contiene: ['rc-hero', 'Tu proximo pago', 'A PAGAR', '&minus;'],
    // El titular quedo con el monto y la fecha: la resta la desglosa la tabla en sus
    // columnas VALOR CUOTA / YA ABONADO / A PAGAR. Mismo criterio que en la Propuesta.
    noContiene: ['Total por pagar', 'Saldo de capital', 'Cuotas pendientes', 'ya abonado'] },

  // Variante PAZ Y SALVO. Es la unica que se alimenta de un paso sintetico: pdf-render no
  // escribe en la BD, asi que ningun cobro sobre un prestamo activo puede dejarlo en cero
  // dentro de este arnes. Se usa un prestamo YA saldado del fixture, que es el estado en el
  // que el generador entra a esa variante.
  { nombre: 'cobro-paz-y-salvo', gen: 'generateReciboCobro', tema: 'light', celdas: null,
    entrada: () => ({ loanId: '1773652420812', cascada: true, sintetico: true, tema: 'light', dark: false }),
    ejecutar: () => S.generateReciboCobro(L('1773652420812'), pays, {
      fecha: '2026-07-20', pre: { saldoCaja: 200000, cuota: 0 },
      pasos: [{ tipo: 'abono', obligacionCOP: 200000, obligacionUSD: 0,
                interes: 0, capital: 200000, cajaCOP: 200000 }] }),
    contiene: ['PAZ Y SALVO', 'Paz y Salvo', 'cancelada la totalidad'],
    // La tarjeta "Total por pagar" vive DENTRO del `if (!esPazYSalvo)`. Sacarla de ahi
    // dejaria un Paz y Salvo anunciando deuda: el documento se contradiria a si mismo.
    noContiene: ['Total por pagar', 'Lo que queda por pagar'] },

  { nombre: 'abono-paz-y-salvo', gen: 'generateReciboAbono', tema: 'light', celdas: null,
    entrada: () => ({ loanId: '1773652420812', monto: 200000, mode: 'mantener', tema: 'light' }),
    ejecutar: () => S.generateReciboAbono(L('1773652420812'), pays, {
      monto: 200000, fecha: '2026-07-20', recalcMode: 'mantener',
      pre: snapshotPrevio(L('1773652420812'), pays, 200000) }),
    contiene: ['PAZ Y SALVO', 'Paz y Salvo'] },

  { nombre: 'abono-capint-parcial-fijarcuota', gen: 'generateReciboAbono', tema: 'light', celdas: 6,
    entrada: () => ({ loanId: LOAN_PARCIAL, monto: 400000, mode: 'fijarCuota', parcial: true, tema: 'light' }),
    ejecutar: () => S.generateReciboAbono(L(LOAN_PARCIAL), paysParcial, {
      monto: 400000, fecha: '2026-07-30', recalcMode: 'fijarCuota',
      pre: snapshotPrevio(L(LOAN_PARCIAL), paysParcial, 400000) }),
    contiene: ['Nueva cuota fija', 'ya abonado', 'TOTAL A PAGAR'] },

  // ── generateEstadoLiquidacion — desglose + respaldo, con y sin el mes opcional ────────
  // `hasta` se pasa SIEMPRE fijo: el valor de liquidacion depende del dia, asi que sin
  // anclarlo el golden caducaria cada 24 h (por eso el generador lo recibe por parametro).
  { nombre: 'liq-capint-cop-con-mes', gen: 'generateEstadoLiquidacion', tema: 'light', celdas: 8,
    entrada: () => ({ loanId: '1776205975507jkph', incluye: true, tema: 'light' }),
    ejecutar: () => S.generateEstadoLiquidacion(L('1776205975507jkph'), pays, config.datos_pago,
      { incluyeProxMes: true, hasta: '2026-07-31' }),
    // Cobrando el mes en curso, el deudor queda cubierto HASTA el proximo vencimiento:
    // decir "solo por hoy" lo presionaria con un vencimiento que no existe.
    contiene: ['Estado de Liquidacion', 'Total a liquidar hoy', 'Interes del mes en curso',
               'valido hasta', 'Incluye el interes de este periodo', 'LQ-'] },

  // Control del mismo prestamo SIN el mes opcional: el bloque no aparece y el
  // disclaimer cambia de razon (vence la proxima cuota) sin cambiar de fecha.
  { nombre: 'liq-capint-cop-sin-mes', gen: 'generateEstadoLiquidacion', tema: 'light', celdas: 8,
    entrada: () => ({ loanId: '1776205975507jkph', incluye: false, tema: 'light' }),
    ejecutar: () => S.generateEstadoLiquidacion(L('1776205975507jkph'), pays, config.datos_pago,
      { incluyeProxMes: false, hasta: '2026-07-31' }),
    contiene: ['Total a liquidar hoy', 'Respaldo', 'valido hasta', 'vence la proxima cuota'] },

  { nombre: 'liq-intereses-cop-mora', gen: 'generateEstadoLiquidacion', tema: 'light', celdas: 8,
    entrada: () => ({ loanId: '1773655076017', incluye: true, tema: 'light' }),
    ejecutar: () => S.generateEstadoLiquidacion(L('1773655076017'), pays, config.datos_pago,
      { incluyeProxMes: true, hasta: '2026-07-31' }),
    contiene: ['Intereses atrasados', 'Total a liquidar hoy'] },

  { nombre: 'liq-capint-usd-oscuro', gen: 'generateEstadoLiquidacion', tema: 'dark', celdas: 8,
    entrada: () => ({ loanId: '1782151590658w66y', incluye: true, tema: 'dark' }),
    ejecutar: () => S.generateEstadoLiquidacion(L('1782151590658w66y'), pays, config.datos_pago,
      { incluyeProxMes: true, hasta: '2026-07-31' }),
    contiene: ['USD $', '#0d1117', 'Total a liquidar hoy'] },

  // Rama propia del credito abierto: sin bloque de mora, con el devengo explicado en dias.
  { nombre: 'liq-diario-cop', gen: 'generateEstadoLiquidacion', tema: 'light', celdas: 5,
    entrada: () => ({ loanId: 'fixture-diario-01', incluye: false, tema: 'light' }),
    ejecutar: () => S.generateEstadoLiquidacion(L('fixture-diario-01'), pays, config.datos_pago,
      { incluyeProxMes: false, hasta: '2026-07-31' }),
    // El credito abierto SI caduca cada dia: aqui el disclaimer debe seguir siendo el
    // estricto. Es el control de que la rama nueva no se lo comio.
    contiene: ['Interes acumulado', 'por dia', 'Corte', 'valido unicamente para el'] },

  // El parcial en vuelo TIENE que restarse del total y anunciarse en el respaldo.
  { nombre: 'liq-capint-parcial', gen: 'generateEstadoLiquidacion', tema: 'light', celdas: 8,
    entrada: () => ({ loanId: LOAN_PARCIAL, incluye: false, parcial: true, tema: 'light' }),
    ejecutar: () => S.generateEstadoLiquidacion(L(LOAN_PARCIAL), paysParcial, config.datos_pago,
      { incluyeProxMes: false, hasta: '2026-07-31' }),
    contiene: ['Abonos parciales ya recibidos', 'ya estan descontados'] },
];

// ── Extraccion de la huella ──────────────────────────────────────────────────────────────

const TOKENS_PROHIBIDOS = ['undefined', 'NaN', '[object Object]', 'Infinity'];

// Importes tal como los formatean fmt/fmtUSD: "$ 3.445.494" (espacio duro U+00A0 de Intl)
// y "USD $1,326.89".
const RE_MONTO = /(?:USD[\s ]*)?\$[\s ]*\d[\d.,]*/g;

// Clases cuyo contenido es una ETIQUETA del documento (literal del codigo, nunca un dato del
// cliente). Deliberadamente NO se incluyen `.value`, `.rc-val`, `.ab-val`, `.rc-deudor-name`
// ni `.ab-name`: ahi viven los importes y los nombres de las personas.
const CLASES_ETIQUETA = ['section-title', 'label', 'rc-stitle', 'rc-lab', 'rc-doc-type',
                         'rc-hero-label', 'rc-total-label', 'rc-tdate-lab', 'ab-st', 'ab-lab',
                         'ab-cl', 'ab-tl', 'ab-type', 'ab-liq-q', 'ab-paz-t'];

const MESES = 'enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre|ene|feb|mar|abr|may|jun|jul|ago|sept|sep|oct|nov|dic';

function sinTags(s) {
  return String(s).replace(/<[^>]*>/g, ' ').replace(/&[a-zA-Z]+;/g, ' ').replace(/\s+/g, ' ').trim();
}

// Normaliza una etiqueta: fuera digitos y nombres de mes. Cumple dos funciones — deja la
// huella inmune al paso del tiempo, y garantiza que no se filtre ningun dato a `tests/golden/`.
function normEtiqueta(s) {
  return sinTags(s)
    .replace(/\d+/g, '#')
    .replace(new RegExp('\\b(' + MESES + ')\\b', 'gi'), 'M')
    .replace(/\s+/g, ' ').trim();
}

function todos(re, txt) {
  const out = []; let m;
  while ((m = re.exec(txt)) !== null) out.push(sinTags(m[1]));
  return out;
}

function etiquetasDe(html) {
  const halladas = [];
  for (const clase of CLASES_ETIQUETA) {
    // El contenido de estas clases es texto plano (a lo sumo con una entidad), asi que un
    // cierre no-goloso basta; el limite de 400 caracteres evita que un fallo de cierre se
    // trague medio documento.
    const re = new RegExp('<[a-z0-9]+[^>]*class="' + clase + '"[^>]*>([\\s\\S]{0,400}?)</[a-z0-9]+>', 'g');
    let m;
    while ((m = re.exec(html)) !== null) halladas.push([m.index, normEtiqueta(m[1])]);
  }
  // Orden documental: asi la huella tambien detecta que una seccion se haya movido de sitio.
  return halladas.sort((a, b) => a[0] - b[0]).map(x => x[1]);
}

function celdasDeFila(tr) {
  let n = 0, m;
  const re = /<(?:th|td)\b([^>]*)>/g;
  while ((m = re.exec(tr)) !== null) {
    const cs = /colspan="(\d+)"/.exec(m[1]);
    n += cs ? +cs[1] : 1;
  }
  return n;
}

function sha1(s) { return crypto.createHash('sha1').update(String(s), 'utf8').digest('hex'); }

// Valores distintos del atributo `class` presentes en el documento. Son literales del codigo
// (`badge badge-mora`, `rc-hero-label`, `tran-sub`...), asi que renombrar, agregar o dejar de
// emitir una clase se ve aca aunque el texto y los importes no se muevan. Va en `valores` y no
// en `estructura` porque QUE clases aparecen depende en parte de los datos (que prestamos estan
// en mora, si hay un abono intercalado...).
function clasesDe(html) {
  const s = new Set(); let m;
  const re = /class="([^"]*)"/g;
  while ((m = re.exec(html)) !== null) s.add(m[1]);
  return [...s].sort();
}

function huellaDe(html, fname) {
  const sinCss  = html.replace(/<style[\s\S]*?<\/style>/gi, '');
  const trs     = html.match(/<tr[^>]*>[\s\S]*?<\/tr>/g) || [];
  const celdas  = trs.map(celdasDeFila);
  const montos  = sinCss.match(RE_MONTO) || [];
  return {
    estructura: {
      docTitle:  sinTags((/<title>([\s\S]*?)<\/title>/i.exec(html) || [, ''])[1]),
      h1:        todos(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, sinCss),
      cabeceras: todos(/<th[^>]*>([\s\S]*?)<\/th>/gi, sinCss),
      etiquetas: etiquetasDe(sinCss),
    },
    valores: {
      bytes:       html.length,
      nFilas:      trs.length,
      nCeldas:     celdas.reduce((a, b) => a + b, 0),
      celdasPorTr: celdas,
      nMontos:     montos.length,
      // Digesto, NO los importes: el repo es publico (ver nota 2 de la cabecera).
      hashMontos:  sha1(montos.join('|')),
      hashFname:   sha1(String(fname)),
      // Regla C: digesto del TEXTO COMPLETO (sin tags, digitos -> '#', meses -> 'M').
      // `etiquetasDe` es un allowlist de clases; todo lo que queda fuera —el texto de los
      // badges, los mensajes del hero, las notas al pie— solo estaba cubierto por `bytes`, que
      // no ve un cambio de palabra del mismo largo. Esto lo ve. Sigue siendo un sha1: no se
      // filtra ni un importe ni un nombre a `tests/golden/`.
      hashTexto:   sha1(normEtiqueta(sinCss)),
      clases:      clasesDe(sinCss),
    },
    // Solo para el diagnostico en pantalla; no se guarda en el golden.
    _montos: montos,
  };
}

// ── Protocolo del golden master ──────────────────────────────────────────────────────────

function rutaGolden(caso) { return path.join(GOLDEN, 'pdf-' + caso + '.json'); }

function leerGolden(caso) {
  const f = rutaGolden(caso);
  if (!fs.existsSync(f)) return null;
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); }
  catch (e) { return { _corrupto: String(e.message) }; }
}

function escribirGolden(caso, obj) {
  if (!fs.existsSync(GOLDEN)) fs.mkdirSync(GOLDEN, { recursive: true });
  fs.writeFileSync(rutaGolden(caso), JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

// ── Corrida ──────────────────────────────────────────────────────────────────────────────

// Ejecuta un caso y devuelve { html, fname } o lanza si no emitio exactamente un PDF.
function generar(caso) {
  ponerTema(caso.tema);
  CAP.pdfs.length = 0;
  caso.ejecutar();
  if (CAP.pdfs.length !== 1) {
    throw new Error(`emitio ${CAP.pdfs.length} documento(s) por electronAPI.printPDF, se esperaba 1`);
  }
  return CAP.pdfs[0];
}

console.log('[pdf-render] frontend: ' + FE.meta.origen + ' (lineas ' + FE.meta.lineas + ', ' +
            FE.meta.nSimbolos + ' simbolos)  ·  BD: ' + loans.length + ' loans / ' + pays.length + ' payments');
console.log('[pdf-render] reloj congelado en ' + INSTANTE_FIJO.toISOString() + ' (huella estable)');

const generadoresVistos = new Set();
const bytesPorCaso = [];
let nCreados = 0, nEstrictos = 0, nRebaseline = 0, nCasosOK = 0, nSinBase = 0, nDriftRoto = 0;

for (const caso of CASOS) {
  R.seccion(caso.nombre + '  [' + caso.gen + ' · tema ' + caso.tema + ']');

  let salida1, salida2;
  try {
    salida1 = generar(caso);
    salida2 = generar(caso);        // segunda corrida: la huella debe ser identica
  } catch (e) {
    R.check('el generador produjo un PDF', false, String(e && e.message ? e.message : e));
    continue;
  }
  generadoresVistos.add(caso.gen);
  nCasosOK++;

  const html = salida1.html, fname = salida1.fname;
  bytesPorCaso.push({ caso: caso.nombre, bytes: html.length });

  // 1 — el documento existe y esta completo
  R.check('emitio exactamente 1 documento', true);
  R.check('abre con <!DOCTYPE html>', html.slice(0, 15) === '<!DOCTYPE html>', html.slice(0, 40));
  R.check('cierra con </body></html>', html.trim().endsWith('</body></html>'), JSON.stringify(html.slice(-40)));
  R.check('tamano razonable (>1500 bytes)', html.length > 1500, 'bytes=' + html.length);

  // 2 — ningun rastro de valor perdido en el camino (la regresion tipica de un refactor)
  const sucios = TOKENS_PROHIBIDOS.filter(t => html.indexOf(t) !== -1);
  R.check('sin undefined/NaN/[object Object]/Infinity', sucios.length === 0,
          sucios.length ? ('aparecen: ' + sucios.join(', ')) : undefined);

  // 3 — nombre de archivo
  R.check('fname no vacio y sin undefined',
          typeof fname === 'string' && fname.trim().length > 0 &&
          fname.indexOf('undefined') === -1 && fname.indexOf('NaN') === -1,
          JSON.stringify(fname));

  // 4 — conteo de columnas
  const trs = html.match(/<tr[^>]*>[\s\S]*?<\/tr>/g) || [];
  if (caso.celdas === null) {
    R.check('documento sin tablas (0 <tr>)', trs.length === 0, 'trs=' + trs.length);
  } else {
    const mal = trs.map((t, i) => [i, celdasDeFila(t)]).filter(x => x[1] !== caso.celdas);
    R.check(`las ${trs.length} filas tienen ${caso.celdas} celdas (colspan incluido)`,
            trs.length > 0 && mal.length === 0,
            mal.length ? ('filas fuera de rango: ' + JSON.stringify(mal)) : 'no hay ninguna fila');
  }

  // 4b — las 7 columnas universales del cronograma, por nombre y en orden
  if (caso.gen === 'generateCronogramaPDF') {
    const ths = todos(/<th[^>]*>([\s\S]*?)<\/th>/gi, html);
    R.eq('7 columnas universales del cronograma', ths,
         ['#', 'Vence', 'Interes', 'Abono a capital', 'Valor cuota', 'Saldo', 'Estado']);
  }

  // 5 — el caso ejercito de verdad la rama que dice ejercitar
  const ausentes = (caso.contiene || []).filter(t => html.indexOf(t) === -1);
  R.check('contiene los marcadores de su escenario', ausentes.length === 0,
          ausentes.length ? ('faltan: ' + JSON.stringify(ausentes)) : undefined);

  // 5b — marcadores que NO deben aparecer. El golden fija la forma, pero no dice nada
  // sobre un texto que seria INCORRECTO emitir: un recibo que llame "vencida" a una
  // cuota que aun no vence tiene la misma estructura que uno correcto.
  if (caso.noContiene && caso.noContiene.length) {
    const presentes = caso.noContiene.filter(t => html.indexOf(t) !== -1);
    R.check('no dice lo que no debe decir', presentes.length === 0,
            presentes.length ? ('aparecen y no deberian: ' + JSON.stringify(presentes)) : undefined);
  }

  // 6 — determinismo: dos corridas seguidas, misma huella
  const h1 = huellaDe(salida1.html, salida1.fname);
  const h2 = huellaDe(salida2.html, salida2.fname);
  delete h1._montos; const montosVivos = h2._montos; delete h2._montos;
  R.eq('dos corridas seguidas dan la misma huella',
       { e: h1.estructura, v: h1.valores }, { e: h2.estructura, v: h2.valores });

  // 7 — golden master
  const entradaHash = sha1(JSON.stringify(caso.entrada()) + '|' +
                           JSON.stringify(loans) + '|' +
                           JSON.stringify(caso.entrada().parcial ? paysParcial : pays));
  // `version` es el formato de la HUELLA. Si cambia lo que se mide (una clave nueva en
  // `valores`), una linea base vieja no es comparable: se declara ausente en vez de fallar con
  // un diff ilegible o, peor, de compararse a medias.
  const VERSION_HUELLA = 2;
  const actual = { version: VERSION_HUELLA, caso: caso.nombre, generador: caso.gen, tema: caso.tema,
                   entradaHash, estructura: h1.estructura, valores: h1.valores };
  let prev = leerGolden(caso.nombre);
  if (prev && !prev._corrupto && prev.version !== VERSION_HUELLA) {
    prev = { _corrupto: 'formato de huella v' + prev.version + ', el arnes usa v' + VERSION_HUELLA };
  }

  if (!prev || prev._corrupto) {
    // Regla B: sin linea base no se compara NADA. Eso no puede ser un aviso verde, porque
    // convierte `rm tests/golden/*` en la via rapida para acallar la suite.
    const motivo = prev && prev._corrupto
      ? 'esta CORRUPTA (' + prev._corrupto + ')'
      : 'no existe';
    if (INIT_GOLDEN) {
      escribirGolden(caso.nombre, actual);
      nCreados++;
      console.log('  linea base ESTABLECIDA (' + motivo + ') en tests/golden/pdf-' + caso.nombre + '.json');
    } else {
      nSinBase++;
      R.check('golden · hay una linea base contra la cual comparar', false,
              'La linea base de "' + caso.nombre + '" ' + motivo + ', asi que este caso no\n' +
              'comparo ni estructura ni valores.\n' + COMO_INICIAR);
    }
  } else if (prev.entradaHash === entradaHash) {
    nEstrictos++;
    R.eq('golden · estructura del documento', actual.estructura, prev.estructura);
    const okValores = R.eq('golden · valores (filas, celdas, importes, texto, bytes)', actual.valores, prev.valores);
    if (!okValores) {
      console.log('        importes de esta corrida (' + montosVivos.length + '): ' +
                  montosVivos.slice(0, 12).join(' ') + (montosVivos.length > 12 ? ' ...' : ''));
    }
  } else {
    // Los datos de produccion se movieron (un cobro, un abono...). La estructura —que sale
    // del codigo, no de la BD— se sigue exigiendo; los valores se re-establecen.
    const ok = R.eq('golden · estructura del documento (datos cambiados)', actual.estructura, prev.estructura);
    if (ok) {
      nRebaseline++;
      escribirGolden(caso.nombre, actual);
      console.log('  AVISO  los datos de produccion cambiaron desde la ultima linea base:' +
                  ' se re-establecieron los VALORES de pdf-' + caso.nombre + '.json.');
    } else {
      // Regla A: NO se reescribe. Si se reescribiera, la huella nueva (con la regresion
      // adentro) pasaria a ser la referencia y la corrida siguiente saldria verde — el fallo
      // se reportaria UNA vez y se absorberia para siempre. Reproducido antes de esta guarda.
      nDriftRoto++;
      console.log('  la linea base NO se re-establecio: la estructura cambio y eso no lo explican');
      console.log('  los datos. Revisa el codigo. Si de verdad fue un cambio buscado, rehace la');
      console.log('  linea base a mano:');
      console.log('        ' + COMO_INICIAR.split('\n')[1].trim() +
                  '   (tras borrar tests/golden/pdf-' + caso.nombre + '.json)');
    }
  }
}

// ── Guardas anti "verde en vacio" ────────────────────────────────────────────────────────

R.seccion('cobertura de la suite');
R.check('se ejercitaron al menos 8 casos', nCasosOK >= 8, 'casos con salida: ' + nCasosOK + ' de ' + CASOS.length);
R.check('los ' + CASOS.length + ' casos definidos produjeron documento', nCasosOK === CASOS.length,
        'con salida: ' + nCasosOK + ' / definidos: ' + CASOS.length);
// El conteo se DERIVA de la lista (leccion del Bug #48: un numero escrito a mano en el
// titulo se desincroniza y la suite acaba mintiendo sobre su propia cobertura).
R.eq('los ' + GENERADORES.length + ' generadores fueron ejercitados',
     GENERADORES.filter(g => generadoresVistos.has(g)).sort(), GENERADORES.slice().sort());

// Cobertura declarada en el encargo: las 5 modalidades, ambas monedas, mora, parcial, 2 temas.
const modsCubiertas = new Set();
const monedas = new Set();
for (const c of CASOS) {
  const e = c.entrada();
  if (!e.loanId) continue;
  const l = L(e.loanId);
  if (l) { modsCubiertas.add(l.modalidad); monedas.add(l.moneda); }
}
// 'Interes Diario' entra aqui con el Estado de Liquidacion: es el primer caso de
// pdf-render que ejercita la 5a modalidad (los 2 generadores propios del credito
// abierto, generateEstadoCuentaDiario y generateReciboCorte, siguen sin cubrir).
const MODALIDADES = ['Capital + Intereses', 'Interes Diario', 'Intereses', 'Pago Unico', 'Prestamo'];
R.eq('las ' + MODALIDADES.length + ' modalidades estan cubiertas', [...modsCubiertas].sort(), MODALIDADES);
R.eq('COP y USD cubiertos', [...monedas].sort(), ['COP', 'USD']);
R.eq('temas claro y oscuro cubiertos', [...new Set(CASOS.map(c => c.tema))].sort(), ['dark', 'light']);
R.check('hay un caso con pago PARCIAL en vuelo', CASOS.some(c => c.entrada().parcial === true));
R.check('el parcial inyectado sigue Pendiente (parcial en vuelo, no cuota saldada)',
        cuotaParcial.estadoPago === 'Pendiente' && cuotaParcial.partialPaid > 0 &&
        cuotaParcial.partialPaid < cuotaParcial.cuotaTotal,
        JSON.stringify({ estado: cuotaParcial.estadoPago, partial: cuotaParcial.partialPaid, cuota: cuotaParcial.cuotaTotal }));
R.check('hay al menos un caso con cuotas En Mora',
        pays.some(p => p.estadoPago === 'En Mora' && p.id.indexOf('-ab-') === -1));
// Sin esto, la rama `saldoMora`/`saldoMoraUSD` del Reporte (Bugs #42 y #45) queda sin cubrir:
// son los unicos consumidores de `partialPaid` sobre una cuota EN MORA.
R.check('hay un parcial en vuelo sobre una cuota EN MORA (COP y USD)',
        moraParcialCOP.estadoPago === 'En Mora' && moraParcialCOP.partialPaid > 0 &&
        moraParcialCOP.partialPaid < moraParcialCOP.cuotaTotal &&
        moraParcialUSD.estadoPago === 'En Mora' && moraParcialUSD.partialPaid > 0 &&
        moraParcialUSD.partialPaid < moraParcialUSD.cuotaTotal &&
        moraParcialUSD.montoUSDRecibido > 0,
        JSON.stringify({ cop: { e: moraParcialCOP.estadoPago, p: moraParcialCOP.partialPaid },
                         usd: { e: moraParcialUSD.estadoPago, p: moraParcialUSD.partialPaid,
                                usd: moraParcialUSD.montoUSDRecibido } }));

// ── Resumen ──────────────────────────────────────────────────────────────────────────────

console.log('\n-- tamano de cada documento (bytes)');
for (const b of bytesPorCaso) console.log('   ' + String(b.bytes).padStart(6) + '  ' + b.caso);
console.log('   ' + String(bytesPorCaso.reduce((s, b) => s + b.bytes, 0)).padStart(6) + '  TOTAL (' + bytesPorCaso.length + ' documentos)');
console.log('\n-- golden master: ' + nEstrictos + ' comparados en estricto · ' +
            nRebaseline + ' re-establecidos por cambio de datos · ' + nCreados + ' creados · ' +
            nSinBase + ' SIN linea base · ' + nDriftRoto + ' con estructura rota (no re-establecidos)');

if (nCasosOK < 8) {
  abortar(`Solo ${nCasosOK} casos produjeron documento (minimo exigido: 8). La suite no cubre nada.`);
}
if (R.ok + R.fallos === 0) {
  abortar('La suite no ejecuto ni un solo aserto.');
}
// Ultima red contra el verde en vacio del golden: una corrida donde NINGUN caso llego a
// compararse contra una linea base no vale como baseline, por muchos asertos genericos que
// haya sumado. En modo INIT eso es lo esperado y se dice sin disfrazarlo de exito.
if (nEstrictos + nRebaseline + nDriftRoto === 0) {
  if (INIT_GOLDEN) {
    console.log('\nMODO INIT: se establecieron ' + nCreados + ' lineas base y NO se comparo ninguna.\n' +
                'Corre la suite otra vez SIN PDF_GOLDEN_INIT para que el baseline valga.');
    process.exit(R.fallos === 0 ? 3 : 1);
  }
  abortar('Ningun caso se comparo contra una linea base: la capa de golden no afirmo nada.\n' + COMO_INICIAR);
}

process.exit(R.finalizar());
