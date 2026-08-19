#!/usr/bin/env node
// tests/e2e-api.js — GOLDEN MASTER end-to-end de los 25 endpoints del backend REAL.
//
// COMO SE CORRE (better-sqlite3 esta compilado para el ABI de Electron):
//   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron tests/e2e-api.js
//   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron tests/e2e-api.js --actualizar
//
// QUE HACE
//   FASE A  golden master de LECTURA: snapshot normalizado de cada GET en tests/golden/*.json.
//   FASE B  escritura: camino feliz + rechazo por endpoint mutador, con la doctrina
//           "4xx => BD intacta" verificada por hash del contenido COMPLETO de la BD.
//   FASE C  round-trip de deshacer: el agregado vuelve BYTE-IDENTICO + candado LIFO (409).
//   FASE D  sensibilidad a regresiones: FABRICA el estado peligroso que la BD real no ofrece,
//           porque varias reglas solo son observables sobre datos que las violan. Ver el
//           comentario de faseRegresiones() para la lista de mutaciones que pasaban en verde
//           antes de existir esta fase.
//
// ── COMO SE VALIDA ESTE ARCHIVO A SI MISMO ──────────────────────────────────
// Con MUTACION del backend real (editar backend/server.js, correr, revertir). Una suite que
// no falla ante una regresion inyectada no sirve. Estado medido: 15 mutaciones representativas
// (doctrina financiera + candados del undo + contratos de los GET) => 15 detectadas.
// La 16a (redondear el PMT a 2 decimales antes del Math.round a pesos) es un MUTANTE
// EQUIVALENTE: no cambia ningun valor persistido, asi que no hay nada que detectar.
//
// NUNCA toca la BD productiva: cada fase corre sobre su propia copia (tests/lib/db.js).
//
// ── NORMALIZACION (por que el golden es estable) ─────────────────────────────
//   1. Timestamps con hora ("YYYY-MM-DD HH:MM:SS") -> "<TS>".  Cubre createdAt,
//      paidAt, activity_log.fecha, undo_journal.created_at/undone_at, fecha_creacion.
//      Las fechas SIN hora (fechaPago, fechaRecaudo, fecha_pago...) son dato de
//      negocio y se conservan tal cual.
//   2. IDs generados por genId() DENTRO de esta corrida -> "<ID>" (y el sufijo
//      "-ab-<ts>" -> "-ab-<TS>"). Se detectan porque sus 13 digitos iniciales son un
//      Date.now() de las ultimas 2 horas; los ids de produccion son de meses atras y
//      se conservan (si no, se perderia la relacion prestamo <-> cuotas).
//   3. SENSIBILIDAD A LA FECHA DE HOY. El arranque corre auto-mora
//      (Pendiente -> En Mora cuando fechaPago < hoy), asi que estadoPago cambia solo
//      con el paso del tiempo. Se normaliza todo estado != 'Pagado' a "<PEND_AUTO>"
//      y, aparte, se AFIRMA EN VIVO la regla (toda cuota vencida no pagada esta En
//      Mora). El golden queda estable entre dias y la regla igual queda blindada.
//   4. AUTO-EXTEND de la modalidad 'Intereses': GET /api/payments genera cuotas
//      futuras segun la fecha de hoy, asi que su numero crece con el tiempo. Esas
//      filas (Intereses + no pagadas + fechaPago > hoy) salen del cuerpo del golden y
//      se resumen como el contrato observable ">=3 pendientes futuras" por prestamo.

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

const { Reporter }          = require('./lib/report');
const { copiaDeProduccion } = require('./lib/db');
const createApp             = require('../backend/server');
const Database              = require('better-sqlite3');

const R          = new Reporter('e2e-api');
const GOLDEN_DIR = path.join(__dirname, 'golden');
const ACTUALIZAR = process.argv.indexOf('--actualizar') !== -1 || process.env.ACTUALIZAR_GOLDEN === '1';
const T0         = Date.now();
const HALLAZGOS  = [];   // posibles bugs de produccion: se reportan, NO se corrigen ni tumban la suite

// ── Registro de cobertura (anti-vacio) ───────────────────────────────────────
const ENDPOINTS = [
  'GET /vendor/react.js', 'GET /vendor/react-dom.js',
  'GET /api/loans', 'POST /api/loans', 'PUT /api/loans/:id', 'DELETE /api/loans/:id',
  'GET /api/payments', 'PUT /api/payments/:id', 'POST /api/payments/:id/partial',
  'POST /api/loans/:id/abono', 'POST /api/loans/:id/reestructurar',
  'POST /api/loans/:id/force-close', 'POST /api/loans/:id/cambiar-dia-pago',
  'POST /api/loans/:id/corte',
  'POST /api/recalculate', 'GET /api/config', 'PUT /api/config', 'GET /api/activity',
  'GET /api/undo', 'POST /api/undo/:id',
  'GET /api/debts', 'GET /api/debts/:id', 'POST /api/debts',
  'POST /api/debts/:id/pay', 'PUT /api/debts/:id', 'DELETE /api/debts/:id'
];
const tocados = new Set();
function marcar(k) {
  if (ENDPOINTS.indexOf(k) === -1) throw new Error('endpoint desconocido en el registro: ' + k);
  tocados.add(k);
}

// ── Utilidades ───────────────────────────────────────────────────────────────
function hoyStr() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
const sha = s => crypto.createHash('sha256').update(s).digest('hex');

function arrancar(dbPath) {
  return new Promise((resolve, reject) => {
    let app;
    try { app = createApp(dbPath); } catch (e) { return reject(e); }
    const srv = app.listen(0, '127.0.0.1', () => {
      resolve({ srv, base: 'http://127.0.0.1:' + srv.address().port, dbPath });
    });
    srv.on('error', reject);
  });
}
function cerrar(s) {
  return new Promise(resolve => { if (!s || !s.srv) return resolve(); s.srv.close(() => resolve()); });
}

// Cliente HTTP minimo. Devuelve SIEMPRE {status, json, text} (no lanza por 4xx/5xx).
async function pedir(S, metodo, ruta, cuerpo) {
  const opts = { method: metodo, headers: {} };
  if (cuerpo !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(cuerpo);
  }
  const r    = await fetch(S.base + ruta, opts);
  const txt  = await r.text();
  let json = null;
  try { json = JSON.parse(txt); } catch (_) {}
  return { status: r.status, json, text: txt, tipo: r.headers.get('content-type') || '' };
}

// ── Estado COMPLETO de la BD (base de "4xx => BD intacta") ───────────────────
const TABLAS = ['loans', 'payments', 'config', 'activity_log', 'mis_deudas', 'pagos_deudas', 'undo_journal'];
function volcarBD(ruta) {
  const d = new Database(ruta, { readonly: true });
  const out = {};
  for (const t of TABLAS) {
    try {
      out[t] = d.prepare('SELECT * FROM ' + t).all()
        .map(r => JSON.stringify(r, Object.keys(r).sort()))
        .sort();
    } catch (_) { out[t] = null; }
  }
  d.close();
  return out;
}
const hashBD = ruta => sha(JSON.stringify(volcarBD(ruta)));

function conDb(ruta, fn) {
  const d = new Database(ruta, { readonly: true });
  try { return fn(d); } finally { d.close(); }
}
// Escritura directa sobre la COPIA (nunca sobre produccion: la ruta viene de lib/db.js).
// Solo se usa en FASE D, para fabricar el estado peligroso que la BD real no ofrece.
function conDbW(ruta, fn) {
  const d = new Database(ruta);
  try { return fn(d); } finally { d.close(); }
}
// Agregado de un prestamo tal como lo snapshotea el journal de undo.
function agregadoLoan(ruta, id) {
  return conDb(ruta, d => ({
    loan: d.prepare('SELECT * FROM loans WHERE id = ?').get(id) || null,
    payments: d.prepare('SELECT * FROM payments WHERE prestamoId = ? ORDER BY id').all(id)
  }));
}
function agregadoDebt(ruta, id) {
  return conDb(ruta, d => ({
    deuda: d.prepare('SELECT * FROM mis_deudas WHERE id = ?').get(id) || null,
    pagos: d.prepare('SELECT * FROM pagos_deudas WHERE deuda_id = ? ORDER BY id').all(id)
  }));
}

// ── Normalizacion ────────────────────────────────────────────────────────────
const RE_TS      = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}/;
const VENTANA_MS = 2 * 60 * 60 * 1000;   // "generado en esta corrida"

function esIdDeEstaCorrida(v) {
  if (typeof v !== 'string') return false;
  const s = v.indexOf('uj-') === 0 ? v.slice(3) : v;
  const m = /^(\d{13})[a-z0-9]{0,8}$/.exec(s);
  if (!m) return false;
  const t = +m[1];
  return t > T0 - VENTANA_MS && t < T0 + VENTANA_MS;
}
function normalizarValor(v) {
  if (typeof v !== 'string') return v;
  if (RE_TS.test(v)) return '<TS>';
  if (esIdDeEstaCorrida(v)) return '<ID>';
  const m = /^(.*)-ab-(\d{13})$/.exec(v);
  if (m && esIdDeEstaCorrida(m[2])) return m[1] + '-ab-<TS>';
  return v;
}
function normalizar(v) {
  if (Array.isArray(v)) return v.map(normalizar);
  if (v && typeof v === 'object') {
    const o = {};
    for (const k of Object.keys(v).sort()) o[k] = normalizar(v[k]);
    return o;
  }
  return normalizarValor(v);
}

// ── Golden master ────────────────────────────────────────────────────────────
function aplanar(v, pref, out) {
  if (Array.isArray(v)) { v.forEach((x, i) => aplanar(x, pref + '[' + i + ']', out)); return out; }
  if (v && typeof v === 'object') { Object.keys(v).forEach(k => aplanar(v[k], pref ? pref + '.' + k : k, out)); return out; }
  out[pref] = v;
  return out;
}
function diferencias(esperado, actual, max) {
  const a = aplanar(esperado, '', {}), b = aplanar(actual, '', {});
  const claves = Array.from(new Set(Object.keys(a).concat(Object.keys(b)))).sort();
  const out = [];
  for (const k of claves) {
    if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) {
      out.push(k + ':  golden=' + JSON.stringify(a[k]) + '   actual=' + JSON.stringify(b[k]));
      if (out.length >= max) { out.push('... (' + (claves.length) + ' claves comparadas; diff truncado)'); break; }
    }
  }
  return out;
}
let goldenCreados = 0, goldenComparados = 0;
function golden(nombre, datos) {
  if (!fs.existsSync(GOLDEN_DIR)) fs.mkdirSync(GOLDEN_DIR, { recursive: true });
  const archivo = path.join(GOLDEN_DIR, nombre + '.json');
  const norm    = normalizar(datos);
  const texto   = JSON.stringify(norm, null, 2);

  if (!fs.existsSync(archivo) || ACTUALIZAR) {
    const nuevo = !fs.existsSync(archivo);
    fs.writeFileSync(archivo, texto, 'utf8');
    goldenCreados++;
    console.log('  BASELINE ' + (nuevo ? 'creado' : 'actualizado') + ': tests/golden/' + nombre + '.json');
    // Se afirma igual que el snapshot no viene vacio.
    R.check('golden ' + nombre + ' — snapshot no vacio (baseline ' + (nuevo ? 'creado' : 'actualizado') + ')',
      texto.length > 20 && texto !== '{}' && texto !== '[]', 'contenido: ' + texto.slice(0, 200));
    // ANTI-VACIO: crear un baseline que faltaba NO es comparar. Si esto pasara en silencio,
    // borrar tests/golden/ desarmaria toda la capa de lectura y la suite seguiria en verde
    // afirmando NADA sobre el contenido de los GET (verificado: pasaba 227/227 sin baselines).
    // Con --actualizar es una decision deliberada del que corre y no se penaliza.
    if (nuevo && !ACTUALIZAR) {
      R.check('golden ' + nombre + ' — habia un baseline contra el cual comparar', false,
        'NO existia tests/golden/' + nombre + '.json: se acaba de crear, asi que esta corrida\n' +
        'no comparo nada para este GET. Si es el arranque inicial (o el cambio es intencional),\n' +
        'correr a proposito con --actualizar y volver a correr sin el flag.');
    }
    return;
  }
  goldenComparados++;
  let previo;
  try { previo = JSON.parse(fs.readFileSync(archivo, 'utf8')); }
  catch (e) { return R.check('golden ' + nombre + ' — baseline legible', false, String(e.message)); }
  // Comparar SIEMPRE en forma compacta: `texto` esta indentado para que el archivo sea
  // legible/diffeable en git, y compararlo contra el JSON compacto del baseline daba un
  // falso negativo con diff vacio.
  const igual = JSON.stringify(previo) === JSON.stringify(norm);
  R.check('golden ' + nombre + ' — identico al baseline', igual,
    igual ? undefined : diferencias(previo, norm, 10).join('\n') +
      '\n(si el cambio es intencional: correr con --actualizar)');
}

// ═════════════════════════════════════════════════════════════════════════════
// FASE A — GOLDEN MASTER DE LECTURA
// ═════════════════════════════════════════════════════════════════════════════
async function faseLectura() {
  R.seccion('FASE A — golden master de lectura (8 GET)');
  const S = await arrancar(copiaDeProduccion('e2e-lectura'));
  try {
    // vendor ---------------------------------------------------------------
    const vendor = {};
    for (const ruta of ['/vendor/react.js', '/vendor/react-dom.js']) {
      const r = await pedir(S, 'GET', ruta);
      marcar('GET ' + ruta);
      R.check('GET ' + ruta + ' responde 200', r.status === 200, 'status=' + r.status);
      // react.production.min.js pesa ~10 KB; react-dom ~130 KB. El piso solo descarta
      // que se este sirviendo una pagina de error en vez del bundle.
      R.check('GET ' + ruta + ' entrega el bundle UMD de React',
        r.text.length > 8000 && /React/.test(r.text) && !/<html/i.test(r.text), 'bytes=' + r.text.length);
      vendor[ruta] = { status: r.status, bytes: r.text.length, sha256: sha(r.text) };
    }
    golden('GET_vendor', vendor);

    // loans ----------------------------------------------------------------
    const rLoans = await pedir(S, 'GET', '/api/loans');
    marcar('GET /api/loans');
    R.check('GET /api/loans responde 200', rLoans.status === 200, 'status=' + rLoans.status);
    const loans = rLoans.json || [];
    R.check('GET /api/loans devuelve prestamos reales', Array.isArray(loans) && loans.length >= 20, 'n=' + loans.length);
    golden('GET_api_loans', loans);

    const modalidadDe = {};
    loans.forEach(l => { modalidadDe[l.id] = l.modalidad; });

    // payments -------------------------------------------------------------
    const rPays = await pedir(S, 'GET', '/api/payments');
    marcar('GET /api/payments');
    R.check('GET /api/payments responde 200', rPays.status === 200, 'status=' + rPays.status);
    const pays = rPays.json || [];
    R.check('GET /api/payments devuelve el cronograma completo', Array.isArray(pays) && pays.length >= 140, 'n=' + pays.length);

    // Idempotencia real: el 2o GET (auto-mora + auto-extend ya aplicados) es identico.
    const rPays2 = await pedir(S, 'GET', '/api/payments');
    R.eq('GET /api/payments es idempotente (2a llamada identica)',
      JSON.stringify(rPays2.json), JSON.stringify(pays));

    // El ORDEN es parte del contrato observable (ORDER BY fechaPago, nombreCliente) y el golden
    // no lo ve, porque normaliza ordenando por id. Sin este assert, invertir el ORDER BY del
    // endpoint pasaba desapercibido (verificado con mutacion).
    const desordenadas = pays.filter((p, i) => {
      if (i === 0) return false;
      const a = pays[i - 1];
      return a.fechaPago > p.fechaPago ||
        (a.fechaPago === p.fechaPago && String(a.nombreCliente) > String(p.nombreCliente));
    });
    R.check('GET /api/payments respeta ORDER BY fechaPago, nombreCliente',
      desordenadas.length === 0,
      desordenadas.slice(0, 3).map(p => p.fechaPago + ' ' + p.nombreCliente).join('\n'));

    const hoy = hoyStr();
    // (3) Regla de auto-mora afirmada EN VIVO (lo que el golden normaliza).
    const vencidasMalMarcadas = pays.filter(p =>
      p.estadoPago !== 'Pagado' && p.fechaPago < hoy && p.estadoPago !== 'En Mora');
    R.check('auto-mora: toda cuota vencida y no pagada quedo En Mora',
      vencidasMalMarcadas.length === 0,
      vencidasMalMarcadas.slice(0, 5).map(p => p.id + ' ' + p.fechaPago + ' ' + p.estadoPago).join('\n'));
    R.check('auto-mora: la muestra no es vacia (hay cuotas vencidas en la BD real)',
      pays.filter(p => p.estadoPago === 'En Mora').length > 0,
      'cuotas En Mora=' + pays.filter(p => p.estadoPago === 'En Mora').length);

    // (4) Contrato del auto-extend de 'Intereses'.
    const loansInt = loans.filter(l => l.modalidad === 'Intereses' && l.estado === 'Activo');
    R.check('hay prestamos Intereses activos para probar el auto-extend', loansInt.length > 0, 'n=' + loansInt.length);
    const resumenAutoExtend = {};
    loansInt.forEach(l => {
      const fut = pays.filter(p => p.prestamoId === l.id && p.estadoPago !== 'Pagado' && p.fechaPago > hoy).length;
      resumenAutoExtend[l.id] = fut >= 3 ? '>=3' : String(fut);
      R.check('auto-extend: ' + l.nombre + ' (Intereses) mantiene >=3 cuotas futuras', fut >= 3, 'futuras=' + fut);
    });

    // Doctrina: los abonos se identifican SOLO por '-ab-'.
    const abonos = pays.filter(p => p.id.indexOf('-ab-') !== -1);
    R.check('la BD real tiene abonos a capital identificables por "-ab-"', abonos.length >= 3, 'n=' + abonos.length);
    R.check('todo abono "-ab-" esta Pagado', abonos.every(p => p.estadoPago === 'Pagado'),
      abonos.filter(p => p.estadoPago !== 'Pagado').map(p => p.id).join(','));

    // Cuerpo del golden: sin la cola auto-extendible; estado normalizado.
    // El filtro NO puede depender de `hoy`: excluia solo las cuotas de 'Intereses' aun
    // FUTURAS, asi que cada vez que una cruzaba su vencimiento entraba al golden y la
    // linea base caducaba sola (medido: una fila nueva a los 10 dias, sin tocar codigo).
    // Se excluyen TODAS las no Pagadas de esa modalidad, que es lo que el comentario ya
    // decia: su numero es intrinsecamente dependiente del calendario y su resumen vive
    // aparte en `autoExtend`.
    const cuerpo = pays
      .filter(p => !(modalidadDe[p.prestamoId] === 'Intereses' && p.estadoPago !== 'Pagado'))
      .map(p => Object.assign({}, p, { estadoPago: p.estadoPago === 'Pagado' ? 'Pagado' : '<PEND_AUTO>' }))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    golden('GET_api_payments', { filas: cuerpo, autoExtend: resumenAutoExtend });

    // config ---------------------------------------------------------------
    const rCfg = await pedir(S, 'GET', '/api/config');
    marcar('GET /api/config');
    R.check('GET /api/config responde 200', rCfg.status === 200, 'status=' + rCfg.status);
    R.check('GET /api/config trae la TRM', rCfg.json && typeof rCfg.json.trm === 'string', JSON.stringify(rCfg.json));
    golden('GET_api_config', rCfg.json);

    // activity -------------------------------------------------------------
    const rAct = await pedir(S, 'GET', '/api/activity');
    marcar('GET /api/activity');
    R.check('GET /api/activity responde 200', rAct.status === 200, 'status=' + rAct.status);
    R.check('GET /api/activity devuelve 100 filas (LIMIT 100)', (rAct.json || []).length === 100, 'n=' + (rAct.json || []).length);
    R.check('GET /api/activity viene ordenado por id DESC',
      (rAct.json || []).every((r, i, a) => i === 0 || a[i - 1].id > r.id));
    golden('GET_api_activity', rAct.json);

    // undo -----------------------------------------------------------------
    const rUndo = await pedir(S, 'GET', '/api/undo');
    marcar('GET /api/undo');
    R.check('GET /api/undo responde 200', rUndo.status === 200, 'status=' + rUndo.status);
    R.check('GET /api/undo trae el journal real', (rUndo.json || []).length >= 1, 'n=' + (rUndo.json || []).length);
    const conScope = rUndo.json && rUndo.json[0]
      ? await pedir(S, 'GET', '/api/undo?scopeTipo=' + rUndo.json[0].scope_tipo + '&scopeId=' + encodeURIComponent(rUndo.json[0].scope_id))
      : { json: [] };
    R.check('GET /api/undo?scope filtra por agregado',
      (conScope.json || []).length > 0 && (conScope.json || []).every(e => e.scope_id === rUndo.json[0].scope_id),
      JSON.stringify((conScope.json || []).map(e => e.scope_id)));
    golden('GET_api_undo', { todas: rUndo.json, filtrada: conScope.json });

    // debts ----------------------------------------------------------------
    const rDebts = await pedir(S, 'GET', '/api/debts');
    marcar('GET /api/debts');
    R.check('GET /api/debts responde 200', rDebts.status === 200, 'status=' + rDebts.status);
    const debts = rDebts.json || [];
    R.check('GET /api/debts devuelve las deudas reales', debts.length >= 5, 'n=' + debts.length);
    R.check('GET /api/debts agrega total_cargos/total_abonos por deuda',
      debts.every(d => typeof d.total_cargos === 'number' && typeof d.total_abonos === 'number'));
    R.check('GET /api/debts ordena Activas antes que Pagadas',
      debts.every((d, i, a) => i === 0 || a[i - 1].estado <= d.estado),
      debts.map(d => d.estado).join(','));
    golden('GET_api_debts', debts);

    const detalles = {};
    for (const d of debts) {
      const rd = await pedir(S, 'GET', '/api/debts/' + d.id);
      marcar('GET /api/debts/:id');
      if (rd.status !== 200) R.check('GET /api/debts/' + d.id + ' responde 200', false, 'status=' + rd.status);
      detalles[d.id] = rd.json;
    }
    R.check('GET /api/debts/:id devolvio el detalle de las ' + debts.length + ' deudas',
      Object.keys(detalles).length === debts.length);
    R.check('GET /api/debts/:id incluye el ledger de movimientos',
      Object.values(detalles).every(x => x && Array.isArray(x.pagos)));
    const conLedger = Object.values(detalles).filter(x => x.pagos.length > 0).length;
    R.check('al menos una deuda real tiene movimientos en el ledger', conLedger > 0, 'deudas con ledger=' + conLedger);
    const r404 = await pedir(S, 'GET', '/api/debts/no-existe-jamas');
    R.check('GET /api/debts/:id inexistente responde 404', r404.status === 404, 'status=' + r404.status);
    golden('GET_api_debts_id', detalles);

    return { loans, pays, debts };
  } finally { await cerrar(S); }
}

// ═════════════════════════════════════════════════════════════════════════════
// FASE B — ESCRITURA: camino feliz + rechazo + "4xx => BD intacta"
// ═════════════════════════════════════════════════════════════════════════════
async function faseEscritura() {
  R.seccion('FASE B — escritura: camino feliz, rechazo y "4xx => BD intacta"');
  const S = await arrancar(copiaDeProduccion('e2e-escritura'));
  const DB = S.dbPath;
  try {
    const loans = (await pedir(S, 'GET', '/api/loans')).json;
    const pays0 = (await pedir(S, 'GET', '/api/payments')).json;

    // Reparto de prestamos: cada endpoint destructivo trabaja sobre uno distinto.
    const usados = new Set();
    const paysDe = id => pays0.filter(p => p.prestamoId === id);
    function tomar(pred, etiqueta) {
      const l = loans.find(x => !usados.has(x.id) && pred(x));
      if (!l) throw new Error('ANTI-VACIO: no hay ningun prestamo que sirva para "' + etiqueta + '"');
      usados.add(l.id);
      return l;
    }
    const activoCI  = l => l.estado === 'Activo' && l.modalidad === 'Capital + Intereses';
    const sinParcial = l => paysDe(l.id).every(p => p.estadoPago === 'Pagado' || !(p.partialPaid > 0));
    const conPend   = l => paysDe(l.id).some(p => p.estadoPago === 'Pendiente');

    const lAbono   = tomar(l => activoCI(l) && conPend(l) && sinParcial(l), 'abono a capital');
    const lReest   = tomar(l => activoCI(l) && conPend(l) && sinParcial(l), 'reestructurar');
    const lFecha   = tomar(l => activoCI(l) && (l.frecuencia || 'Mensual') === 'Mensual' && sinParcial(l), 'cambiar dia de pago');
    const lPago    = tomar(l => l.estado === 'Activo' && conPend(l), 'PUT /payments');
    const lParcial = tomar(l => l.estado === 'Activo' && conPend(l), 'pago parcial');
    const lEdit    = tomar(l => l.estado === 'Activo' && l.modalidad === 'Intereses', 'PUT /loans');
    const lLiq     = tomar(l => l.estado === 'Activo' && (l.modalidad === 'Pago Unico' || l.modalidad === 'Prestamo'), 'liquidacion');
    const lCierre  = tomar(l => l.estado === 'Activo' && conPend(l), 'cierre forzoso');
    R.check('reparto de prestamos: 8 objetivos distintos elegidos de la BD real', usados.size === 8,
      Array.from(usados).join(','));

    // Helper: ejerce un rechazo y verifica que la BD quedo intacta.
    // `silenciar` tapa el volcado de pila del manejador de errores de Express en las rutas
    // que revientan con 500 (ver HALLAZGOS): es ruido esperado que enterraba los FAIL reales.
    async function rechazo(clave, desc, metodo, ruta, cuerpo, statusEsperado, silenciar) {
      const antes = hashBD(DB);
      const errOrig = console.error;
      if (silenciar) console.error = () => {};
      let r;
      try { r = await pedir(S, metodo, ruta, cuerpo); }
      finally { console.error = errOrig; }
      const despues = hashBD(DB);
      marcar(clave);
      if (statusEsperado === '4xx') {
        R.check(desc + ' -> 4xx', r.status >= 400 && r.status < 500, 'status=' + r.status + ' body=' + r.text.slice(0, 200));
      } else if (statusEsperado === 'error') {
        R.check(desc + ' -> rechazado', r.status >= 400, 'status=' + r.status);
      } else {
        R.check(desc + ' -> ' + statusEsperado, r.status === statusEsperado, 'status=' + r.status + ' body=' + r.text.slice(0, 200));
      }
      R.check(desc + ' -> BD INTACTA', antes === despues, 'hash antes=' + antes.slice(0, 12) + ' despues=' + despues.slice(0, 12));
      return r;
    }
    // Helper: toda mutacion journalizada debe devolver undoId.
    function exigirUndoId(r, desc) {
      R.check(desc + ' devuelve undoId (journal)', !!(r.json && r.json.undoId), JSON.stringify(r.json).slice(0, 200));
      return r.json && r.json.undoId;
    }

    // ── PUT /api/config ────────────────────────────────────────────────────
    R.seccion('PUT /api/config');
    const rCfg = await pedir(S, 'PUT', '/api/config', { datos_pago: 'PRUEBA E2E', trm: '4321' });
    marcar('PUT /api/config');
    R.check('PUT /api/config responde 200', rCfg.status === 200 && rCfg.json.ok === true, JSON.stringify(rCfg.json));
    const cfg = (await pedir(S, 'GET', '/api/config')).json;
    R.eq('PUT /api/config persiste las claves', [cfg.datos_pago, cfg.trm], ['PRUEBA E2E', '4321']);
    await rechazo('PUT /api/config', 'PUT /api/config con cuerpo vacio (no-op)', 'PUT', '/api/config', {}, 200);

    // ── POST /api/loans ────────────────────────────────────────────────────
    R.seccion('POST /api/loans + PUT + DELETE');
    const nuevo = {
      nombre: 'ZZ Prueba E2E', cedula: '123', telefono: '300', moneda: 'COP',
      montoOrigen: 1200000, trmAcordada: 4100, montoCOP: 1200000, tasaMensual: 10,
      plazoMeses: 6, modalidad: 'Capital + Intereses', fechaInicio: hoyStr(),
      diaPago: 10, estado: 'Activo', notas: '', frecuencia: 'Mensual'
    };
    const rNew = await pedir(S, 'POST', '/api/loans', nuevo);
    marcar('POST /api/loans');
    R.check('POST /api/loans responde 201', rNew.status === 201, 'status=' + rNew.status + ' ' + rNew.text.slice(0, 200));
    const idNuevo = rNew.json && rNew.json.id;
    R.check('POST /api/loans devuelve el prestamo con id', !!idNuevo, JSON.stringify(rNew.json).slice(0, 200));
    const cuotasNuevo = conDb(DB, d => d.prepare('SELECT * FROM payments WHERE prestamoId = ? ORDER BY cuotaN').all(idNuevo));
    R.eq('POST /api/loans genera el cronograma completo (6 cuotas)', cuotasNuevo.length, 6);
    // Doctrina del motor (Bug #43): aritmetica en pesos enteros.
    const sumaCap = cuotasNuevo.reduce((s, p) => s + p.abonoCapital, 0);
    R.eq('motor: suma de abonoCapital == capital prestado, EXACTO', sumaCap, 1200000);
    R.check('motor: interes + capital == cuota en cada fila',
      cuotasNuevo.every(p => Math.round(p.interesPeriodo + p.abonoCapital) === Math.round(p.cuotaTotal)),
      cuotasNuevo.map(p => p.cuotaN + ': ' + p.interesPeriodo + '+' + p.abonoCapital + '<>' + p.cuotaTotal).join('\n'));
    R.check('motor: todas las cuotas persisten pesos enteros',
      cuotasNuevo.every(p => Number.isInteger(p.interesPeriodo) && Number.isInteger(p.abonoCapital) && Number.isInteger(p.cuotaTotal)));
    await rechazo('POST /api/loans', 'POST /api/loans con cuerpo vacio', 'POST', '/api/loans', {}, 'error', true);

    // ── PUT /api/loans/:id (sobre el recien creado) ────────────────────────
    const editado = Object.assign({}, nuevo, { id: idNuevo, notas: 'editado por e2e' });
    const rEd = await pedir(S, 'PUT', '/api/loans/' + idNuevo, editado);
    marcar('PUT /api/loans/:id');
    R.check('PUT /api/loans/:id responde 200', rEd.status === 200, 'status=' + rEd.status);
    const undoEd = exigirUndoId(rEd, 'PUT /api/loans/:id');
    R.eq('PUT /api/loans/:id persiste el cambio',
      conDb(DB, d => d.prepare('SELECT notas FROM loans WHERE id=?').get(idNuevo).notas), 'editado por e2e');
    await rechazo('PUT /api/loans/:id', 'PUT /api/loans/:id con cuerpo vacio', 'PUT', '/api/loans/' + idNuevo, {}, 'error', true);

    // PUT sobre un Intereses real: preserva Pagadas, solo regenera Pendientes.
    const pagadasAntes = conDb(DB, d => d.prepare("SELECT id,estadoPago,montoCOPRecibido,paidAt FROM payments WHERE prestamoId=? AND estadoPago='Pagado' ORDER BY id").all(lEdit.id));
    const cuerpoEdit = Object.assign({}, lEdit, { notas: 'nota e2e' });
    const rEd2 = await pedir(S, 'PUT', '/api/loans/' + lEdit.id, cuerpoEdit);
    R.check('PUT /api/loans/:id sobre prestamo real responde 200', rEd2.status === 200, 'status=' + rEd2.status);
    const pagadasDespues = conDb(DB, d => d.prepare("SELECT id,estadoPago,montoCOPRecibido,paidAt FROM payments WHERE prestamoId=? AND estadoPago='Pagado' ORDER BY id").all(lEdit.id));
    R.check('PUT /api/loans/:id NO toca las cuotas Pagadas (doctrina v1.9.0)',
      JSON.stringify(pagadasAntes) === JSON.stringify(pagadasDespues),
      'antes=' + pagadasAntes.length + ' despues=' + pagadasDespues.length);
    R.check('PUT /api/loans/:id habia cuotas Pagadas que preservar (no es un test vacio)', pagadasAntes.length > 0, 'n=' + pagadasAntes.length);

    // ── DELETE /api/loans/:id ──────────────────────────────────────────────
    const rDel = await pedir(S, 'DELETE', '/api/loans/' + idNuevo);
    marcar('DELETE /api/loans/:id');
    R.check('DELETE /api/loans/:id responde 200', rDel.status === 200, 'status=' + rDel.status);
    R.eq('DELETE /api/loans/:id borra el prestamo',
      conDb(DB, d => d.prepare('SELECT count(*) c FROM loans WHERE id=?').get(idNuevo).c), 0);
    R.eq('DELETE /api/loans/:id borra sus cuotas (sin huerfanas)',
      conDb(DB, d => d.prepare('SELECT count(*) c FROM payments WHERE prestamoId=?').get(idNuevo).c), 0);
    // Bug #41: los undos del prestamo borrado quedan 'invalidado', no 'disponible'.
    const estadoUndoEd = conDb(DB, d => d.prepare('SELECT estado FROM undo_journal WHERE id=?').get(undoEd));
    R.eq('DELETE /api/loans/:id invalida los undos huerfanos (Bug #41)', estadoUndoEd && estadoUndoEd.estado, 'invalidado');
    const rUndoInv = await pedir(S, 'POST', '/api/undo/' + undoEd);
    marcar('POST /api/undo/:id');
    R.check('POST /api/undo/:id sobre entrada invalidada -> 400', rUndoInv.status === 400, 'status=' + rUndoInv.status);
    await rechazo('DELETE /api/loans/:id', 'DELETE /api/loans/:id inexistente (no-op)', 'DELETE', '/api/loans/no-existe', undefined, 200);

    // ── PUT /api/payments/:id ──────────────────────────────────────────────
    R.seccion('PUT /api/payments/:id');
    const cuotaPago = paysDe(lPago.id).filter(p => p.estadoPago === 'Pendiente').sort((a, b) => a.cuotaN - b.cuotaN)[0];
    if (!cuotaPago) throw new Error('ANTI-VACIO: el prestamo elegido para PUT /payments no tiene cuota Pendiente');
    R.check('hay una cuota Pendiente real para cobrar', cuotaPago.cuotaTotal > 0, lPago.id);
    const rPay = await pedir(S, 'PUT', '/api/payments/' + cuotaPago.id, {
      estadoPago: 'Pagado', fechaRecaudo: hoyStr(), observaciones: 'e2e',
      montoCOPRecibido: cuotaPago.cuotaTotal, montoUSDRecibido: 0
    });
    marcar('PUT /api/payments/:id');
    R.check('PUT /api/payments/:id responde 200', rPay.status === 200, 'status=' + rPay.status);
    exigirUndoId(rPay, 'PUT /api/payments/:id');
    const filaPag = conDb(DB, d => d.prepare('SELECT * FROM payments WHERE id=?').get(cuotaPago.id));
    R.eq('PUT /api/payments/:id marca Pagado', filaPag.estadoPago, 'Pagado');
    R.eq('PUT /api/payments/:id fija partialPaid = cuotaTotal', filaPag.partialPaid, cuotaPago.cuotaTotal);
    R.check('PUT /api/payments/:id sella paidAt', !!filaPag.paidAt, String(filaPag.paidAt));
    R.eq('PUT /api/payments/:id agrega el evento al ledger `recibos`',
      JSON.parse(filaPag.recibos), [{ fecha: hoyStr(), cop: Math.round(cuotaPago.cuotaTotal) }]);
    // Revertir: limpia ledger y partialPaid.
    const rRev = await pedir(S, 'PUT', '/api/payments/' + cuotaPago.id, { estadoPago: 'Pendiente' });
    R.check('PUT /api/payments/:id revierte a Pendiente', rRev.status === 200, 'status=' + rRev.status);
    const filaRev = conDb(DB, d => d.prepare('SELECT * FROM payments WHERE id=?').get(cuotaPago.id));
    R.eq('revertir limpia el ledger `recibos`', filaRev.recibos, '[]');
    R.eq('revertir limpia partialPaid', filaRev.partialPaid, 0);
    R.eq('revertir limpia paidAt', filaRev.paidAt, null);
    await rechazo('PUT /api/payments/:id', 'PUT /api/payments/:id inexistente', 'PUT', '/api/payments/no-existe', { estadoPago: 'Pagado' }, 404);

    // ── POST /api/payments/:id/partial ─────────────────────────────────────
    R.seccion('POST /api/payments/:id/partial');
    const cuotaPar = paysDe(lParcial.id).filter(p => p.estadoPago === 'Pendiente').sort((a, b) => a.cuotaN - b.cuotaN)[0];
    if (!cuotaPar) throw new Error('ANTI-VACIO: el prestamo elegido para el parcial no tiene cuota Pendiente');
    // El monto sale del RESTANTE real (cuotaTotal - partialPaid) para no completar la cuota
    // por accidente ni pasarse del tope: aqui se quiere ejercer el parcial "en curso".
    const restantePar = cuotaPar.cuotaTotal - (cuotaPar.partialPaid || 0);
    R.check('la cuota elegida tiene saldo por cobrar', restantePar > 4, 'restante=' + restantePar);
    const montoPar = Math.max(1, Math.round(restantePar / 4));
    const rPar = await pedir(S, 'POST', '/api/payments/' + cuotaPar.id + '/partial',
      { monto: montoPar, fecha: hoyStr(), observaciones: 'parcial e2e' });
    marcar('POST /api/payments/:id/partial');
    R.check('POST /partial responde 200', rPar.status === 200, 'status=' + rPar.status + ' ' + rPar.text.slice(0, 200));
    exigirUndoId(rPar, 'POST /partial');
    R.eq('POST /partial informa que la cuota NO se completo', rPar.json.completa, false);
    R.eq('POST /partial acumula en partialPaid', rPar.json.partialPaid, montoPar);
    const filaPar = conDb(DB, d => d.prepare('SELECT * FROM payments WHERE id=?').get(cuotaPar.id));
    R.eq('POST /partial deja la cuota sin marcar como Pagada', filaPar.estadoPago, cuotaPar.estadoPago);
    R.eq('POST /partial registra el evento de caja en `recibos`',
      JSON.parse(filaPar.recibos), [{ fecha: hoyStr(), cop: montoPar }]);
    await rechazo('POST /api/payments/:id/partial', 'POST /partial con monto mayor al restante', 'POST',
      '/api/payments/' + cuotaPar.id + '/partial', { monto: cuotaPar.cuotaTotal * 10 }, '4xx');
    await rechazo('POST /api/payments/:id/partial', 'POST /partial con monto 0', 'POST',
      '/api/payments/' + cuotaPar.id + '/partial', { monto: 0 }, '4xx');
    const unAbono = pays0.find(p => p.id.indexOf('-ab-') !== -1);
    if (!unAbono) throw new Error('ANTI-VACIO: la BD no tiene ningun abono "-ab-" para probar el bloqueo del parcial');
    await rechazo('POST /api/payments/:id/partial', 'POST /partial sobre un abono a capital', 'POST',
      '/api/payments/' + unAbono.id + '/partial', { monto: 100 }, '4xx');

    // ── POST /api/loans/:id/abono ──────────────────────────────────────────
    R.seccion('POST /api/loans/:id/abono');
    const saldoAntesAb = conDb(DB, d => d.prepare('SELECT montoCOP FROM loans WHERE id=?').get(lAbono.id).montoCOP);
    const rAb = await pedir(S, 'POST', '/api/loans/' + lAbono.id + '/abono',
      { monto: 50000, fecha: hoyStr(), observaciones: 'abono e2e', recalcMode: 'mantener' });
    marcar('POST /api/loans/:id/abono');
    R.check('POST /abono responde 200', rAb.status === 200, 'status=' + rAb.status + ' ' + rAb.text.slice(0, 250));
    exigirUndoId(rAb, 'POST /abono');
    const abFila = conDb(DB, d => d.prepare("SELECT * FROM payments WHERE prestamoId=? AND id LIKE '%-ab-%' ORDER BY cuotaN DESC").all(lAbono.id))[0];
    R.check('POST /abono crea la fila "-ab-" del abono', !!abFila && abFila.abonoCapital === 50000,
      JSON.stringify(abFila && { id: abFila.id, cap: abFila.abonoCapital }));
    R.eq('POST /abono marca el abono como Pagado', abFila.estadoPago, 'Pagado');
    const saldoDespuesAb = conDb(DB, d => d.prepare('SELECT montoCOP FROM loans WHERE id=?').get(lAbono.id).montoCOP);
    R.check('POST /abono reduce el saldo del prestamo', saldoDespuesAb < saldoAntesAb,
      'antes=' + saldoAntesAb + ' despues=' + saldoDespuesAb);
    R.eq('POST /abono responde con el nuevo saldo', rAb.json.nuevoSaldo, saldoDespuesAb);
    await rechazo('POST /api/loans/:id/abono', 'POST /abono con monto 0', 'POST',
      '/api/loans/' + lAbono.id + '/abono', { monto: 0 }, '4xx');
    await rechazo('POST /api/loans/:id/abono', 'POST /abono que supera el capital amortizable', 'POST',
      '/api/loans/' + lAbono.id + '/abono', { monto: 999999999 }, '4xx');
    await rechazo('POST /api/loans/:id/abono', 'POST /abono con recalcMode fijarCuota imposible', 'POST',
      '/api/loans/' + lAbono.id + '/abono', { monto: 1000, recalcMode: 'fijarCuota', recalcValor: 1 }, '4xx');
    await rechazo('POST /api/loans/:id/abono', 'POST /abono sobre prestamo inexistente', 'POST',
      '/api/loans/no-existe/abono', { monto: 1000 }, 404);

    // Ruta `liquidar` (v1.19.0): valida contra el capital pendiente, no contra saldoReal.
    const paysLiq = conDb(DB, d => d.prepare('SELECT * FROM payments WHERE prestamoId=?').all(lLiq.id));
    const origLiq = lLiq.moneda === 'USD' ? Math.round(lLiq.montoOrigen * lLiq.trmAcordada) : Math.round(lLiq.montoOrigen);
    const capPagadas = paysLiq.filter(p => p.estadoPago === 'Pagado').reduce((s, p) => s + p.abonoCapital, 0);
    const capPendienteLiq = Math.max(0, origLiq - capPagadas);
    R.check('el prestamo de liquidacion tiene capital pendiente real', capPendienteLiq > 0, 'cap=' + capPendienteLiq);
    const rLiq = await pedir(S, 'POST', '/api/loans/' + lLiq.id + '/abono',
      { monto: capPendienteLiq, fecha: hoyStr(), liquidar: true, observaciones: 'liquidacion e2e' });
    R.check('POST /abono?liquidar responde 200', rLiq.status === 200, 'status=' + rLiq.status + ' ' + rLiq.text.slice(0, 250));
    const loanLiq = conDb(DB, d => d.prepare('SELECT * FROM loans WHERE id=?').get(lLiq.id));
    R.eq('liquidar deja el prestamo Finalizado', loanLiq.estado, 'Finalizado');
    R.eq('liquidar deja montoCOP en 0', loanLiq.montoCOP, 0);
    R.eq('liquidar no deja cuotas Pendientes',
      conDb(DB, d => d.prepare("SELECT count(*) c FROM payments WHERE prestamoId=? AND estadoPago IN ('Pendiente','En Mora')").get(lLiq.id).c), 0);
    const capRecuperado = conDb(DB, d => d.prepare("SELECT COALESCE(SUM(abonoCapital),0) s FROM payments WHERE prestamoId=? AND estadoPago='Pagado'").get(lLiq.id).s);
    R.eq('liquidar NO cuenta el capital dos veces (capital recuperado == prestado)', Math.round(capRecuperado), origLiq);

    // ── POST /api/loans/:id/reestructurar ──────────────────────────────────
    R.seccion('POST /api/loans/:id/reestructurar');
    const rRe = await pedir(S, 'POST', '/api/loans/' + lReest.id + '/reestructurar',
      { recalcMode: 'modificarPlazo', recalcValor: 4 });
    marcar('POST /api/loans/:id/reestructurar');
    R.check('POST /reestructurar responde 200', rRe.status === 200, 'status=' + rRe.status + ' ' + rRe.text.slice(0, 250));
    exigirUndoId(rRe, 'POST /reestructurar');
    R.eq('POST /reestructurar genera las 4 cuotas pedidas', rRe.json.nuevasCuotas, 4);
    R.eq('POST /reestructurar limpia cuotaFijaPactada en modificarPlazo',
      conDb(DB, d => d.prepare('SELECT cuotaFijaPactada FROM loans WHERE id=?').get(lReest.id).cuotaFijaPactada), 0);
    R.eq('POST /reestructurar deja exactamente 4 cuotas Pendientes',
      conDb(DB, d => d.prepare("SELECT count(*) c FROM payments WHERE prestamoId=? AND estadoPago='Pendiente' AND id NOT LIKE '%-ab-%'").get(lReest.id).c), 4);
    await rechazo('POST /api/loans/:id/reestructurar', 'POST /reestructurar con modo invalido', 'POST',
      '/api/loans/' + lReest.id + '/reestructurar', { recalcMode: 'loQueSea', recalcValor: 3 }, '4xx');
    await rechazo('POST /api/loans/:id/reestructurar', 'POST /reestructurar con 0 cuotas', 'POST',
      '/api/loans/' + lReest.id + '/reestructurar', { recalcMode: 'modificarPlazo', recalcValor: 0 }, '4xx');
    await rechazo('POST /api/loans/:id/reestructurar', 'POST /reestructurar sobre modalidad no C+I', 'POST',
      '/api/loans/' + lEdit.id + '/reestructurar', { recalcMode: 'modificarPlazo', recalcValor: 3 }, '4xx');

    // ── POST /api/loans/:id/cambiar-dia-pago ───────────────────────────────
    R.seccion('POST /api/loans/:id/cambiar-dia-pago');
    const nuevoDia = lFecha.diaPago === 20 ? 22 : 20;
    const pagadasFechaAntes = conDb(DB, d => d.prepare("SELECT id FROM payments WHERE prestamoId=? AND estadoPago='Pagado' ORDER BY id").all(lFecha.id));
    const rFe = await pedir(S, 'POST', '/api/loans/' + lFecha.id + '/cambiar-dia-pago', { nuevoDia });
    marcar('POST /api/loans/:id/cambiar-dia-pago');
    R.check('POST /cambiar-dia-pago responde 200', rFe.status === 200, 'status=' + rFe.status + ' ' + rFe.text.slice(0, 250));
    exigirUndoId(rFe, 'POST /cambiar-dia-pago');
    R.eq('POST /cambiar-dia-pago persiste el nuevo dia',
      conDb(DB, d => d.prepare('SELECT diaPago FROM loans WHERE id=?').get(lFecha.id).diaPago), nuevoDia);
    R.check('POST /cambiar-dia-pago informa el prorrateo por dias reales',
      rFe.json.diasReales > 0 && typeof rFe.json.prorrateo === 'number',
      JSON.stringify({ dias: rFe.json.diasReales, prorrateo: rFe.json.prorrateo }));
    // Bug #38: jamas sobrescribir una cuota ya Pagada.
    const pagadasFechaDespues = conDb(DB, d => d.prepare("SELECT id FROM payments WHERE prestamoId=? AND estadoPago='Pagado' ORDER BY id").all(lFecha.id));
    R.eq('cambiar-dia-pago NO destruye cuotas Pagadas (Bug #38)',
      pagadasFechaDespues.map(p => p.id), pagadasFechaAntes.map(p => p.id));
    await rechazo('POST /api/loans/:id/cambiar-dia-pago', 'POST /cambiar-dia-pago con el mismo dia', 'POST',
      '/api/loans/' + lFecha.id + '/cambiar-dia-pago', { nuevoDia }, '4xx');
    await rechazo('POST /api/loans/:id/cambiar-dia-pago', 'POST /cambiar-dia-pago con dia 99', 'POST',
      '/api/loans/' + lFecha.id + '/cambiar-dia-pago', { nuevoDia: 99 }, '4xx');
    await rechazo('POST /api/loans/:id/cambiar-dia-pago', 'POST /cambiar-dia-pago sobre modalidad sin cuotas periodicas', 'POST',
      '/api/loans/' + lLiq.id + '/cambiar-dia-pago', { nuevoDia: 9 }, '4xx');

    // ── POST /api/recalculate ──────────────────────────────────────────────
    R.seccion('POST /api/recalculate');
    const rRc = await pedir(S, 'POST', '/api/recalculate');
    marcar('POST /api/recalculate');
    R.check('POST /recalculate responde 200', rRc.status === 200, 'status=' + rRc.status);
    R.check('POST /recalculate procesa los prestamos activos', rRc.json.updated > 0, JSON.stringify(rRc.json));
    const hashRc1 = hashBD(DB);
    const rRc2 = await pedir(S, 'POST', '/api/recalculate');
    const hashRc2 = hashBD(DB);
    R.check('POST /recalculate es IDEMPOTENTE (2a corrida no cambia la BD)', hashRc1 === hashRc2,
      'hash1=' + hashRc1.slice(0, 12) + ' hash2=' + hashRc2.slice(0, 12));
    R.eq('POST /recalculate reporta el mismo conteo la 2a vez', rRc2.json.updated, rRc.json.updated);

    // ── POST /api/loans/:id/force-close ────────────────────────────────────
    R.seccion('POST /api/loans/:id/force-close');
    // El valor esperado se computa APARTE con la formula canonica ANTES de cerrar. Comparar
    // loans.capitalPerdido contra rFc.json.capitalPerdido seria una tautologia: ambos salen de
    // la misma variable del backend (verificado con mutacion: forzar capitalPerdido=0 pasaba).
    const loanCierreAntes = conDb(DB, d => d.prepare('SELECT * FROM loans WHERE id=?').get(lCierre.id));
    const paysCierreAntes = conDb(DB, d => d.prepare('SELECT * FROM payments WHERE prestamoId=?').all(lCierre.id));
    const origCierre = loanCierreAntes.moneda === 'USD'
      ? Math.round(loanCierreAntes.montoOrigen * loanCierreAntes.trmAcordada)
      : Math.round(loanCierreAntes.montoOrigen);
    const capPagadoCierre = paysCierreAntes.filter(p => p.estadoPago === 'Pagado').reduce((s, p) => s + p.abonoCapital, 0);
    const capPerdidoEsperado = Math.max(0, Math.round(origCierre - capPagadoCierre));
    const intPerdidoEsperado = Math.round(paysCierreAntes
      .filter(p => p.estadoPago === 'En Mora' && p.id.indexOf('-ab-') === -1)
      .reduce((s, p) => s + p.interesPeriodo, 0));
    R.check('el prestamo del cierre forzoso tiene capital que perder (no es un cierre vacio)',
      capPerdidoEsperado > 0, 'esperado=' + capPerdidoEsperado);

    const rFc = await pedir(S, 'POST', '/api/loans/' + lCierre.id + '/force-close');
    marcar('POST /api/loans/:id/force-close');
    R.check('POST /force-close responde 200', rFc.status === 200, 'status=' + rFc.status + ' ' + rFc.text.slice(0, 200));
    exigirUndoId(rFc, 'POST /force-close');
    const loanFc = conDb(DB, d => d.prepare('SELECT * FROM loans WHERE id=?').get(lCierre.id));
    R.eq('force-close marca el prestamo Cancelado', loanFc.estado, 'Cancelado');
    R.eq('force-close persiste el capital perdido REAL (origCOP - capital de Pagadas)',
      Math.round(loanFc.capitalPerdido), capPerdidoEsperado);
    R.eq('force-close persiste los intereses perdidos REALES (interes de lo no pagado)',
      Math.round(loanFc.interesesPerdidos), intPerdidoEsperado);
    R.eq('force-close: la respuesta coincide con lo persistido', rFc.json.capitalPerdido, loanFc.capitalPerdido);
    R.eq('force-close deja montoCOP en 0', loanFc.montoCOP, 0);
    R.eq('force-close borra Pendientes y Mora',
      conDb(DB, d => d.prepare("SELECT count(*) c FROM payments WHERE prestamoId=? AND estadoPago IN ('Pendiente','En Mora')").get(lCierre.id).c), 0);
    await rechazo('POST /api/loans/:id/force-close', 'POST /force-close sobre prestamo ya cerrado', 'POST',
      '/api/loans/' + lCierre.id + '/force-close', {}, '4xx');
    await rechazo('POST /api/loans/:id/force-close', 'POST /force-close sobre prestamo inexistente', 'POST',
      '/api/loans/no-existe/force-close', {}, 404);

    // ── /api/debts (5 endpoints) ───────────────────────────────────────────
    R.seccion('/api/debts — los 5 endpoints de Mis Deudas');
    const rNd = await pedir(S, 'POST', '/api/debts',
      { titulo: 'Deuda E2E', acreedor: 'Acreedor E2E', concepto: 'prueba', monto_original: 100000 });
    marcar('POST /api/debts');
    R.check('POST /api/debts responde 200', rNd.status === 200, 'status=' + rNd.status + ' ' + rNd.text.slice(0, 200));
    exigirUndoId(rNd, 'POST /api/debts');
    const idDeuda = rNd.json && rNd.json.id;
    R.check('POST /api/debts devuelve la deuda creada', !!idDeuda, JSON.stringify(rNd.json).slice(0, 200));
    R.eq('POST /api/debts arranca con saldo == monto', rNd.json.saldo_pendiente, 100000);
    R.eq('POST /api/debts arranca Activa', rNd.json.estado, 'Activa');
    await rechazo('POST /api/debts', 'POST /api/debts sin titulo', 'POST', '/api/debts', { acreedor: 'X', monto_original: 1 }, 400);
    await rechazo('POST /api/debts', 'POST /api/debts sin acreedor', 'POST', '/api/debts', { titulo: 'X', monto_original: 1 }, 400);
    await rechazo('POST /api/debts', 'POST /api/debts con monto 0', 'POST', '/api/debts', { titulo: 'X', acreedor: 'Y', monto_original: 0 }, 400);

    const rAb1 = await pedir(S, 'POST', '/api/debts/' + idDeuda + '/pay', { monto_pagado: 30000, tipo: 'abono', fecha_pago: hoyStr() });
    marcar('POST /api/debts/:id/pay');
    R.check('POST /debts/:id/pay (abono) responde 200', rAb1.status === 200, 'status=' + rAb1.status);
    exigirUndoId(rAb1, 'POST /debts/:id/pay');
    R.eq('el abono reduce el saldo (100000-30000)', rAb1.json.deuda.saldo_pendiente, 70000);
    const rCg = await pedir(S, 'POST', '/api/debts/' + idDeuda + '/pay', { monto_pagado: 5000, tipo: 'cargo', fecha_pago: hoyStr() });
    R.check('POST /debts/:id/pay (cargo) responde 200', rCg.status === 200, 'status=' + rCg.status);
    R.eq('el cargo aumenta el saldo (70000+5000)', rCg.json.deuda.saldo_pendiente, 75000);
    await rechazo('POST /api/debts/:id/pay', 'abono mayor al saldo pendiente', 'POST',
      '/api/debts/' + idDeuda + '/pay', { monto_pagado: 999999, tipo: 'abono' }, 400);
    await rechazo('POST /api/debts/:id/pay', 'movimiento con monto 0', 'POST',
      '/api/debts/' + idDeuda + '/pay', { monto_pagado: 0, tipo: 'abono' }, 400);
    await rechazo('POST /api/debts/:id/pay', 'movimiento sobre deuda inexistente', 'POST',
      '/api/debts/no-existe/pay', { monto_pagado: 10, tipo: 'abono' }, 404);

    const rPd = await pedir(S, 'PUT', '/api/debts/' + idDeuda,
      { titulo: 'Deuda E2E editada', acreedor: 'Acreedor E2E', concepto: 'x', monto_original: 200000 });
    marcar('PUT /api/debts/:id');
    R.check('PUT /api/debts/:id responde 200', rPd.status === 200, 'status=' + rPd.status);
    exigirUndoId(rPd, 'PUT /api/debts/:id');
    R.eq('PUT /api/debts/:id recalcula el saldo desde el ledger (200000+5000-30000)', rPd.json.saldo_pendiente, 175000);
    await rechazo('PUT /api/debts/:id', 'PUT /api/debts/:id con monto por debajo de lo abonado neto', 'PUT',
      '/api/debts/' + idDeuda, { titulo: 'X', acreedor: 'Y', monto_original: 10 }, 400);
    await rechazo('PUT /api/debts/:id', 'PUT /api/debts/:id sin titulo', 'PUT',
      '/api/debts/' + idDeuda, { acreedor: 'Y', monto_original: 300000 }, 400);
    await rechazo('PUT /api/debts/:id', 'PUT /api/debts/:id inexistente', 'PUT',
      '/api/debts/no-existe', { titulo: 'X', acreedor: 'Y', monto_original: 1 }, 404);

    const detDeuda = (await pedir(S, 'GET', '/api/debts/' + idDeuda)).json;
    R.eq('GET /api/debts/:id refleja los 2 movimientos del ledger', detDeuda.pagos.length, 2);

    const rDd = await pedir(S, 'DELETE', '/api/debts/' + idDeuda);
    marcar('DELETE /api/debts/:id');
    R.check('DELETE /api/debts/:id responde 200', rDd.status === 200, 'status=' + rDd.status);
    exigirUndoId(rDd, 'DELETE /api/debts/:id');
    R.eq('DELETE /api/debts/:id borra la deuda',
      conDb(DB, d => d.prepare('SELECT count(*) c FROM mis_deudas WHERE id=?').get(idDeuda).c), 0);
    R.eq('DELETE /api/debts/:id borra su ledger (cascade)',
      conDb(DB, d => d.prepare('SELECT count(*) c FROM pagos_deudas WHERE deuda_id=?').get(idDeuda).c), 0);
    await rechazo('DELETE /api/debts/:id', 'DELETE /api/debts/:id inexistente', 'DELETE', '/api/debts/no-existe', undefined, 404);

    // ── Historial: toda mutacion dejo huella ───────────────────────────────
    R.seccion('activity_log — huella de las mutaciones');
    const act = (await pedir(S, 'GET', '/api/activity')).json;
    const tipos = new Set(act.map(a => a.tipo));
    ['prestamo', 'edicion', 'eliminacion', 'pago', 'abono', 'reestructuracion', 'cierre', 'cambio-fecha', 'deuda']
      .forEach(t => R.check('activity_log registro el tipo "' + t + '"', tipos.has(t), Array.from(tipos).join(',')));
    R.check('las entradas journalizadas quedaron enlazadas por undo_id',
      act.filter(a => a.undo_id).length > 0, 'con undo_id=' + act.filter(a => a.undo_id).length);

    // Observaciones (no tumban la suite): endpoints sin validacion 4xx propia.
    HALLAZGOS.push('POST /api/loans no valida el cuerpo: con {} revienta en el driver SQLite y sale 500 (no 4xx). La BD queda intacta por la transaccion, pero el contrato de error no es el del resto de la app.');
    HALLAZGOS.push('PUT /api/loans/:id igual que POST: cuerpo incompleto -> 500 en vez de 4xx. Ademas, con un id inexistente responde 200 aunque el UPDATE afecte 0 filas.');
    HALLAZGOS.push('DELETE /api/loans/:id sobre un id inexistente responde 200 {ok:true} en lugar de 404 (el resto de DELETE, p.ej. /api/debts/:id, si devuelve 404).');
    HALLAZGOS.push('PUT /api/config acepta cualquier clave/valor sin validacion y siempre responde 200; no existe ninguna ruta 4xx.');
    HALLAZGOS.push('POST /api/recalculate no tiene ninguna ruta de rechazo: siempre 200. Se cubrio con una propiedad de idempotencia en su lugar.');
  } finally { await cerrar(S); }
}

// ═════════════════════════════════════════════════════════════════════════════
// FASE C — UNDO: round-trip byte-identico + candado LIFO
// ═════════════════════════════════════════════════════════════════════════════
async function faseUndo() {
  R.seccion('FASE C — deshacer: round-trip byte-identico + candado LIFO');
  const S = await arrancar(copiaDeProduccion('e2e-undo'));
  const DB = S.dbPath;
  try {
    const loans = (await pedir(S, 'GET', '/api/loans')).json;
    const pays  = (await pedir(S, 'GET', '/api/payments')).json;
    const paysDe = id => pays.filter(p => p.prestamoId === id);

    const usados = new Set();
    function tomar(pred, etiqueta) {
      const l = loans.find(x => !usados.has(x.id) && pred(x));
      if (!l) throw new Error('ANTI-VACIO: no hay prestamo para "' + etiqueta + '"');
      usados.add(l.id); return l;
    }
    const lA = tomar(l => l.estado === 'Activo' && l.modalidad === 'Capital + Intereses'
      && paysDe(l.id).some(p => p.estadoPago === 'Pendiente')
      && paysDe(l.id).every(p => p.estadoPago === 'Pagado' || !(p.partialPaid > 0)), 'undo de abono');
    const lB = tomar(l => l.estado === 'Activo' && paysDe(l.id).some(p => p.estadoPago === 'Pendiente'), 'undo de pago');
    // Para el LIFO hacen falta 2 parciales encadenados sin completar la cuota.
    const lC = tomar(l => l.estado === 'Activo'
      && paysDe(l.id).some(p => p.estadoPago === 'Pendiente' && p.cuotaTotal - (p.partialPaid || 0) > 5000), 'candado LIFO');

    // 1) Round-trip de POST /abono ------------------------------------------
    const antesA = agregadoLoan(DB, lA.id);
    const rAb = await pedir(S, 'POST', '/api/loans/' + lA.id + '/abono',
      { monto: 25000, fecha: hoyStr(), observaciones: 'undo e2e', recalcMode: 'mantener' });
    R.check('undo/abono: la mutacion se aplico', rAb.status === 200 && !!rAb.json.undoId, rAb.text.slice(0, 200));
    const durante = agregadoLoan(DB, lA.id);
    R.check('undo/abono: el agregado SI cambio antes de deshacer (no es un no-op)',
      JSON.stringify(durante) !== JSON.stringify(antesA));
    const rU1 = await pedir(S, 'POST', '/api/undo/' + rAb.json.undoId);
    marcar('POST /api/undo/:id');
    R.check('undo/abono: POST /api/undo/:id responde 200', rU1.status === 200, 'status=' + rU1.status + ' ' + rU1.text.slice(0, 200));
    R.eq('undo/abono: el agregado vuelve BYTE-IDENTICO', agregadoLoan(DB, lA.id), antesA);
    R.eq('undo/abono: la entrada del journal queda "deshecho"',
      conDb(DB, d => d.prepare('SELECT estado FROM undo_journal WHERE id=?').get(rAb.json.undoId).estado), 'deshecho');
    R.check('undo/abono: el historial es append-only (queda entrada "deshacer")',
      conDb(DB, d => d.prepare("SELECT count(*) c FROM activity_log WHERE tipo='deshacer'").get().c) > 0);
    const rU1b = await pedir(S, 'POST', '/api/undo/' + rAb.json.undoId);
    R.check('undo/abono: deshacer dos veces -> 400', rU1b.status === 400, 'status=' + rU1b.status);

    // 2) Round-trip de PUT /payments/:id ------------------------------------
    const antesB = agregadoLoan(DB, lB.id);
    const cuotaB = paysDe(lB.id).filter(p => p.estadoPago === 'Pendiente').sort((a, b) => a.cuotaN - b.cuotaN)[0];
    const rPay = await pedir(S, 'PUT', '/api/payments/' + cuotaB.id,
      { estadoPago: 'Pagado', fechaRecaudo: hoyStr(), montoCOPRecibido: cuotaB.cuotaTotal });
    R.check('undo/pago: la mutacion se aplico', rPay.status === 200 && !!rPay.json.undoId, rPay.text.slice(0, 200));
    R.check('undo/pago: el agregado SI cambio antes de deshacer',
      JSON.stringify(agregadoLoan(DB, lB.id)) !== JSON.stringify(antesB));
    const rU2 = await pedir(S, 'POST', '/api/undo/' + rPay.json.undoId);
    R.check('undo/pago: POST /api/undo/:id responde 200', rU2.status === 200, 'status=' + rU2.status);
    R.eq('undo/pago: el agregado vuelve BYTE-IDENTICO', agregadoLoan(DB, lB.id), antesB);

    // 3) Round-trip de POST /debts/:id/pay ----------------------------------
    const deuda = (await pedir(S, 'GET', '/api/debts')).json.find(d => d.saldo_pendiente > 1000);
    R.check('hay una deuda real con saldo para el undo', !!deuda, 'ninguna');
    const antesD = agregadoDebt(DB, deuda.id);
    const rMv = await pedir(S, 'POST', '/api/debts/' + deuda.id + '/pay', { monto_pagado: 500, tipo: 'abono', fecha_pago: hoyStr() });
    R.check('undo/deuda: la mutacion se aplico', rMv.status === 200 && !!rMv.json.undoId, rMv.text.slice(0, 200));
    R.check('undo/deuda: el agregado SI cambio antes de deshacer',
      JSON.stringify(agregadoDebt(DB, deuda.id)) !== JSON.stringify(antesD));
    const rU3 = await pedir(S, 'POST', '/api/undo/' + rMv.json.undoId);
    R.check('undo/deuda: POST /api/undo/:id responde 200', rU3.status === 200, 'status=' + rU3.status);
    R.eq('undo/deuda: el agregado vuelve BYTE-IDENTICO', agregadoDebt(DB, deuda.id), antesD);

    // 4) Candado A — LIFO por scope -----------------------------------------
    const cuotaC = paysDe(lC.id).filter(p => p.estadoPago === 'Pendiente' && p.cuotaTotal - (p.partialPaid || 0) > 5000)
      .sort((a, b) => a.cuotaN - b.cuotaN)[0];
    const antesC = agregadoLoan(DB, lC.id);
    const m1 = await pedir(S, 'POST', '/api/payments/' + cuotaC.id + '/partial', { monto: 1000, fecha: hoyStr() });
    const m2 = await pedir(S, 'POST', '/api/payments/' + cuotaC.id + '/partial', { monto: 2000, fecha: hoyStr() });
    R.check('LIFO: dos mutaciones encadenadas sobre el mismo prestamo',
      m1.status === 200 && m2.status === 200 && m1.json.undoId !== m2.json.undoId,
      m1.status + '/' + m2.status);
    const hashPre409 = hashBD(DB);
    const r409 = await pedir(S, 'POST', '/api/undo/' + m1.json.undoId);
    R.check('LIFO: deshacer la mutacion NO mas reciente -> 409', r409.status === 409, 'status=' + r409.status + ' ' + r409.text.slice(0, 200));
    R.check('LIFO: el 409 nombra la operacion que hay que deshacer primero',
      /Primero debes deshacer/.test(r409.text), r409.text.slice(0, 200));
    R.check('LIFO: el 409 dejo la BD INTACTA', hashBD(DB) === hashPre409);
    const rOk2 = await pedir(S, 'POST', '/api/undo/' + m2.json.undoId);
    R.check('LIFO: deshacer la mas reciente -> 200', rOk2.status === 200, 'status=' + rOk2.status);
    const rOk1 = await pedir(S, 'POST', '/api/undo/' + m1.json.undoId);
    R.check('LIFO: liberada la cabeza, la anterior ya se puede deshacer -> 200', rOk1.status === 200, 'status=' + rOk1.status);
    R.eq('LIFO: tras deshacer ambas, el agregado vuelve BYTE-IDENTICO', agregadoLoan(DB, lC.id), antesC);

    // 5) Errores del endpoint ------------------------------------------------
    const hashPre404 = hashBD(DB);
    const r404 = await pedir(S, 'POST', '/api/undo/uj-no-existe');
    R.check('POST /api/undo/:id inexistente -> 404', r404.status === 404, 'status=' + r404.status);
    R.check('POST /api/undo/:id inexistente deja la BD INTACTA', hashBD(DB) === hashPre404);

    // 6) El journal es append-only: nada se borro ---------------------------
    const journal = (await pedir(S, 'GET', '/api/undo')).json;
    R.check('GET /api/undo refleja las entradas de esta corrida',
      journal.filter(e => e.estado === 'deshecho').length >= 5,
      'deshechas=' + journal.filter(e => e.estado === 'deshecho').length);
  } finally { await cerrar(S); }
}

// ═════════════════════════════════════════════════════════════════════════════
// FASE D — SENSIBILIDAD A REGRESIONES
//
// Por que existe: las fases A-C afirmaban varias reglas sobre datos que YA cumplian la
// regla, asi que la afirmacion no probaba nada. Se midio con mutacion del backend real
// (edita-corre-revierte) y estas mutaciones pasaban EN VERDE:
//   · auto-mora desactivada (las 3 ocurrencias)  -> las filas de la BD ya venian En Mora
//   · guarda del Bug #38 desactivada             -> el prestamo elegido no tenia Pagadas no contiguas
//   · restaurarCobros() convertido en no-op      -> ningun endpoint se ejercia con un parcial encima
//   · Prestamo volviendo a abonoCapital = 0      -> la suite solo creaba prestamos C+I
//   · liquidar validando contra saldoReal        -> se liquidaba un Pago Unico, donde ambas bases coinciden
//   · heuristica fragil en la auto-finalizacion  -> ningun prestamo de cuota unica se pagaba entero
// Esta fase FABRICA el caso que hace observable cada regla, y afirma primero la
// PRECONDICION (que el caso realmente es el peligroso) para no volver a caer en la tautologia.
// ═════════════════════════════════════════════════════════════════════════════
async function faseRegresiones() {
  R.seccion('FASE D — sensibilidad: casos fabricados donde la doctrina SI es observable');
  const rutaD = copiaDeProduccion('e2e-regresion');

  // Setup previo al arranque (la copia es nuestra; escribir en ella es legitimo).
  const pre = new Database(rutaD);
  const paysPre  = pre.prepare('SELECT * FROM payments').all();
  const loansPre = pre.prepare('SELECT * FROM loans').all();
  const hoy = hoyStr();

  // ── D1 (setup) auto-mora: se fuerza a Pendiente una cuota YA VENCIDA ────────
  const vencida = paysPre.find(p => p.fechaPago < hoy && p.estadoPago === 'En Mora' && p.id.indexOf('-ab-') === -1);
  if (!vencida) throw new Error('ANTI-VACIO: la BD no tiene ninguna cuota vencida con la que probar la auto-mora');
  pre.prepare("UPDATE payments SET estadoPago='Pendiente' WHERE id=?").run(vencida.id);

  // ── D2 (setup) Bug #38: se fabrica una PAGADA NO CONTIGUA ──────────────────
  // El endpoint cuenta como consumidas SOLO las Pagadas, pero regenera [Pagadas+1 .. plazo]:
  // con una Pagada de cuotaN alto el rango la pisa, e insPayment es INSERT OR REPLACE.
  const paysDePre = id => paysPre.filter(p => p.prestamoId === id && p.id.indexOf('-ab-') === -1);
  const lBug38 = loansPre.find(l => l.estado === 'Activo' && l.modalidad === 'Capital + Intereses'
    && (l.frecuencia || 'Mensual') === 'Mensual'
    && paysDePre(l.id).filter(p => p.estadoPago === 'Pendiente').length >= 4
    && paysDePre(l.id).every(p => p.estadoPago !== 'Pagado'));
  if (!lBug38) throw new Error('ANTI-VACIO: no hay C+I mensual con >=4 cuotas Pendientes para fabricar el caso del Bug #38');
  const cuotasB38   = paysDePre(lBug38.id).sort((a, b) => a.cuotaN - b.cuotaN);
  const cuotaSalteada = cuotasB38[3];   // se paga la 4a dejando 1-3 pendientes => NO contigua
  pre.prepare(`UPDATE payments SET estadoPago='Pagado', fechaRecaudo=?, montoCOPRecibido=?,
      partialPaid=?, paidAt='2026-07-01 09:00:00', recibos=?, observaciones='marca e2e bug38' WHERE id=?`)
    .run(hoy, cuotaSalteada.cuotaTotal, cuotaSalteada.cuotaTotal,
         JSON.stringify([{ fecha: hoy, cop: Math.round(cuotaSalteada.cuotaTotal) }]), cuotaSalteada.id);
  const filaB38Antes = pre.prepare('SELECT * FROM payments WHERE id=?').get(cuotaSalteada.id);

  // ── D5 (setup) Bug #35: se fabrica capital ATRAPADO en cuotas En Mora ──────
  // La BD real puede tener 0, 1 o N prestamos con esa forma; depender de eso volveria el test
  // aleatorio (y el control negativo llego a no poder ejercerse). Se fabrican DOS: uno para
  // liquidar y otro para el control de que el abono NORMAL si topa en saldoReal.
  const reservados = new Set([lBug38.id]);
  function reservarConMora(etiqueta) {
    const l = loansPre.find(x => !reservados.has(x.id) && x.estado === 'Activo'
      && x.modalidad === 'Capital + Intereses' && (x.frecuencia || 'Mensual') === 'Mensual'
      && paysDePre(x.id).filter(p => p.estadoPago === 'Pendiente' && p.abonoCapital > 0).length >= 2);
    if (!l) throw new Error('ANTI-VACIO: no hay C+I mensual con Pendientes para fabricar el caso de "' + etiqueta + '"');
    reservados.add(l.id);
    // La cuota mas proxima pasa a En Mora con fecha vencida: su capital queda fuera de saldoReal
    // pero DENTRO de capitalPendienteLiq -> es exactamente la ventana del Bug #35/#36.
    const cuota = paysDePre(l.id).filter(p => p.estadoPago === 'Pendiente' && p.abonoCapital > 0)
      .sort((a, b) => a.cuotaN - b.cuotaN)[0];
    pre.prepare("UPDATE payments SET estadoPago='En Mora', fechaPago=? WHERE id=?")
      .run('2026-06-05', cuota.id);
    return { loan: l, cuotaMora: cuota };
  }
  const d5a = reservarConMora('liquidacion de C+I con mora');
  const d5b = reservarConMora('control del techo del abono normal');
  pre.close();

  const S  = await arrancar(rutaD);
  const DB = S.dbPath;
  try {
    // ── D1 — AUTO-MORA, afirmada donde se puede observar ────────────────────
    R.seccion('D1 — auto-mora (Pendiente vencida -> En Mora), no la que ya venia marcada');
    R.check('D1 precondicion: la cuota quedo Pendiente y vencida antes del arranque',
      vencida.fechaPago < hoy, 'fechaPago=' + vencida.fechaPago + ' hoy=' + hoy);
    R.eq('D1 el housekeeping de ARRANQUE marca En Mora la cuota vencida',
      conDb(DB, d => d.prepare('SELECT estadoPago FROM payments WHERE id=?').get(vencida.id).estadoPago), 'En Mora');
    // Y ahora la otra ruta: la del propio GET /api/payments.
    conDbW(DB, d => d.prepare("UPDATE payments SET estadoPago='Pendiente' WHERE id=?").run(vencida.id));
    R.eq('D1 control: la cuota volvio a Pendiente antes del GET',
      conDb(DB, d => d.prepare('SELECT estadoPago FROM payments WHERE id=?').get(vencida.id).estadoPago), 'Pendiente');
    const paysD1 = (await pedir(S, 'GET', '/api/payments')).json;
    R.eq('D1 GET /api/payments marca En Mora la cuota vencida',
      (paysD1.find(p => p.id === vencida.id) || {}).estadoPago, 'En Mora');
    R.eq('D1 el cambio quedo PERSISTIDO, no solo en la respuesta',
      conDb(DB, d => d.prepare('SELECT estadoPago FROM payments WHERE id=?').get(vencida.id).estadoPago), 'En Mora');
    // Control negativo: una cuota futura NO puede caer en mora.
    const futura = paysD1.find(p => p.fechaPago > hoy && p.estadoPago !== 'Pagado');
    R.check('D1 control negativo: una cuota futura sigue sin estar En Mora',
      !futura || futura.estadoPago !== 'En Mora', futura && (futura.fechaPago + ' ' + futura.estadoPago));

    // ── D2 — Bug #38: cambiar-dia-pago NO puede pisar una Pagada ────────────
    R.seccion('D2 — Bug #38: cuota Pagada NO contigua sobrevive a /cambiar-dia-pago');
    const pendB38 = conDb(DB, d => d.prepare(
      "SELECT * FROM payments WHERE prestamoId=? AND estadoPago!='Pagado' AND id NOT LIKE '%-ab-%' ORDER BY cuotaN").all(lBug38.id));
    const pagadasB38 = conDb(DB, d => d.prepare(
      "SELECT * FROM payments WHERE prestamoId=? AND estadoPago='Pagado' AND id NOT LIKE '%-ab-%'").all(lBug38.id));
    const nextRegularN = pagadasB38.length + 1;
    R.check('D2 precondicion: la Pagada es NO contigua (su cuotaN cae dentro del rango a regenerar)',
      cuotaSalteada.cuotaN >= nextRegularN && cuotaSalteada.cuotaN <= (lBug38.plazoMeses || 12),
      'cuotaN=' + cuotaSalteada.cuotaN + ' nextRegularN=' + nextRegularN + ' plazo=' + lBug38.plazoMeses);
    R.check('D2 precondicion: hay cuotas Pendientes por delante', pendB38.length > 0, 'n=' + pendB38.length);
    const nuevoDiaB38 = lBug38.diaPago === 18 ? 23 : 18;
    const rB38 = await pedir(S, 'POST', '/api/loans/' + lBug38.id + '/cambiar-dia-pago', { nuevoDia: nuevoDiaB38 });
    R.check('D2 POST /cambiar-dia-pago responde 200', rB38.status === 200, 'status=' + rB38.status + ' ' + rB38.text.slice(0, 200));
    const filaB38Despues = conDb(DB, d => d.prepare('SELECT * FROM payments WHERE id=?').get(cuotaSalteada.id));
    R.eq('D2 la cuota Pagada sobrevive BYTE-IDENTICA (estado, recaudo, monto, paidAt, ledger)',
      filaB38Despues && {
        estadoPago: filaB38Despues.estadoPago, fechaRecaudo: filaB38Despues.fechaRecaudo,
        montoCOPRecibido: filaB38Despues.montoCOPRecibido, partialPaid: filaB38Despues.partialPaid,
        paidAt: filaB38Despues.paidAt, recibos: filaB38Despues.recibos
      },
      {
        estadoPago: filaB38Antes.estadoPago, fechaRecaudo: filaB38Antes.fechaRecaudo,
        montoCOPRecibido: filaB38Antes.montoCOPRecibido, partialPaid: filaB38Antes.partialPaid,
        paidAt: filaB38Antes.paidAt, recibos: filaB38Antes.recibos
      });
    R.check('D2 el endpoint informa la cuota protegida',
      Array.isArray(rB38.json.cuotasProtegidas) && rB38.json.cuotasProtegidas.indexOf(cuotaSalteada.cuotaN) !== -1,
      JSON.stringify(rB38.json.cuotasProtegidas));

    // ── D3 — Bug #44: regenerar un cronograma NO puede borrar dinero ────────
    R.seccion('D3 — Bug #44: el pago parcial y su ledger sobreviven a las rutas que regeneran');
    const loansD = (await pedir(S, 'GET', '/api/loans')).json;
    const paysD  = (await pedir(S, 'GET', '/api/payments')).json;
    const lD3 = loansD.find(l => !reservados.has(l.id) && l.estado === 'Activo' && l.modalidad === 'Capital + Intereses'
      && (l.frecuencia || 'Mensual') === 'Mensual'
      && paysD.some(p => p.prestamoId === l.id && p.estadoPago === 'Pendiente'
        && p.id.indexOf('-ab-') === -1 && p.cuotaTotal - (p.partialPaid || 0) > 30000));
    if (!lD3) throw new Error('ANTI-VACIO: no hay C+I mensual con una cuota Pendiente donde poner un parcial');
    const cuotaD3 = paysD.filter(p => p.prestamoId === lD3.id && p.estadoPago === 'Pendiente'
      && p.id.indexOf('-ab-') === -1 && p.cuotaTotal - (p.partialPaid || 0) > 30000)
      .sort((a, b) => a.cuotaN - b.cuotaN)[0];
    const rParD3 = await pedir(S, 'POST', '/api/payments/' + cuotaD3.id + '/partial',
      { monto: 7000, fecha: hoy, observaciones: 'parcial durabilidad e2e' });
    R.check('D3 se registro el pago parcial de control', rParD3.status === 200 && rParD3.json.completa === false,
      'status=' + rParD3.status + ' ' + rParD3.text.slice(0, 150));
    const tras = () => conDb(DB, d => d.prepare('SELECT partialPaid, recibos, observaciones FROM payments WHERE id=?').get(cuotaD3.id));
    const estadoParcial = tras();
    R.check('D3 precondicion: la cuota lleva dinero encima y ledger poblado',
      estadoParcial && estadoParcial.partialPaid > 0 && estadoParcial.recibos && estadoParcial.recibos !== '[]',
      JSON.stringify(estadoParcial));

    // Las 5 rutas que borran y regeneran cuotas. Cada una debe conservar partialPaid + `recibos`.
    const rutasQueRegeneran = [
      ['POST /recalculate', () => pedir(S, 'POST', '/api/recalculate')],
      ['PUT /loans/:id',    () => pedir(S, 'PUT', '/api/loans/' + lD3.id, Object.assign({}, lD3, { notas: 'durabilidad e2e' }))],
      ['POST /abono',       () => pedir(S, 'POST', '/api/loans/' + lD3.id + '/abono', { monto: 20000, fecha: hoy, recalcMode: 'mantener' })],
      ['POST /reestructurar', () => pedir(S, 'POST', '/api/loans/' + lD3.id + '/reestructurar', { recalcMode: 'modificarPlazo', recalcValor: 6 })],
      ['POST /cambiar-dia-pago', () => pedir(S, 'POST', '/api/loans/' + lD3.id + '/cambiar-dia-pago', { nuevoDia: lD3.diaPago === 17 ? 21 : 17 })]
    ];
    for (const [nombreRuta, ejecutar] of rutasQueRegeneran) {
      const r = await ejecutar();
      R.check('D3 ' + nombreRuta + ' responde 200', r.status === 200, 'status=' + r.status + ' ' + r.text.slice(0, 180));
      const t = tras();
      R.check('D3 ' + nombreRuta + ' conserva el pago parcial ($' + estadoParcial.partialPaid + ')',
        !!t && t.partialPaid === estadoParcial.partialPaid,
        'antes=' + estadoParcial.partialPaid + ' despues=' + (t && t.partialPaid));
      R.eq('D3 ' + nombreRuta + ' conserva el ledger `recibos` (las fechas reales del dinero)',
        t && t.recibos, estadoParcial.recibos);
    }

    // ── D4 — cuota unica: capital persistido (Bug #34) + auto-finalizacion ──
    R.seccion('D4 — Prestamo / Pago Unico: capital persistido y auto-finalizacion');
    const basePrestamo = {
      nombre: 'ZZ Prestamo E2E', cedula: '1', telefono: '1', moneda: 'COP',
      montoOrigen: 750000, trmAcordada: 4100, montoCOP: 750000, tasaMensual: 0,
      plazoMeses: 1, modalidad: 'Prestamo', fechaInicio: hoy, fechaDevolucion: hoy,
      diaPago: 10, estado: 'Activo', notas: '', frecuencia: 'Mensual'
    };
    const rPre = await pedir(S, 'POST', '/api/loans', basePrestamo);
    R.check('D4 POST /api/loans crea el prestamo modalidad "Prestamo"', rPre.status === 201, 'status=' + rPre.status);
    const cuotaPre = conDb(DB, d => d.prepare('SELECT * FROM payments WHERE prestamoId=?').all(rPre.json.id));
    R.eq('D4 "Prestamo" genera 1 sola cuota', cuotaPre.length, 1);
    R.eq('D4 "Prestamo" persiste abonoCapital = capital, NO 0 (Bug #34)', cuotaPre[0].abonoCapital, 750000);
    R.eq('D4 "Prestamo" persiste interesPeriodo = 0 (0% de interes)', cuotaPre[0].interesPeriodo, 0);
    R.eq('D4 "Prestamo": interes + capital == cuota', cuotaPre[0].interesPeriodo + cuotaPre[0].abonoCapital, cuotaPre[0].cuotaTotal);

    const rPU = await pedir(S, 'POST', '/api/loans', Object.assign({}, basePrestamo, {
      nombre: 'ZZ PagoUnico E2E', modalidad: 'Pago Unico', gananciaFija: 90000, fechaDevolucion: ''
    }));
    R.check('D4 POST /api/loans crea el prestamo "Pago Unico"', rPU.status === 201, 'status=' + rPU.status);
    const cuotaPU = conDb(DB, d => d.prepare('SELECT * FROM payments WHERE prestamoId=?').all(rPU.json.id));
    R.eq('D4 "Pago Unico" genera 1 sola cuota', cuotaPU.length, 1);
    R.eq('D4 "Pago Unico" persiste abonoCapital = capital', cuotaPU[0].abonoCapital, 750000);
    R.eq('D4 "Pago Unico" persiste la ganancia pactada como interesPeriodo', cuotaPU[0].interesPeriodo, 90000);
    R.eq('D4 "Pago Unico": capital + ganancia == cuota', cuotaPU[0].cuotaTotal, 840000);

    // Auto-finalizacion de una cuota unica: es el caso que la heuristica fragil
    // (interesPeriodo===0 && abonoCapital>0) clasificaba como abono y dejaba Activo (Bugs #26/#27).
    const rPagPre = await pedir(S, 'PUT', '/api/payments/' + cuotaPre[0].id, {
      estadoPago: 'Pagado', fechaRecaudo: hoy, montoCOPRecibido: 750000, montoUSDRecibido: 0
    });
    R.check('D4 se cobra la cuota unica del "Prestamo"', rPagPre.status === 200, 'status=' + rPagPre.status);
    R.eq('D4 auto-finalizacion: el "Prestamo" 0% queda Finalizado al pagar su unica cuota (Bug #27)',
      conDb(DB, d => d.prepare('SELECT estado FROM loans WHERE id=?').get(rPre.json.id).estado), 'Finalizado');
    const capRecPre = conDb(DB, d => d.prepare(
      "SELECT COALESCE(SUM(abonoCapital),0) s FROM payments WHERE prestamoId=? AND estadoPago='Pagado'").get(rPre.json.id).s);
    R.eq('D4 el saldo canonico del "Prestamo" saldado queda en 0 (sin capital fantasma)',
      Math.max(0, 750000 - Math.round(capRecPre)), 0);

    // ── D5 — Bug #35: liquidar un C+I CON capital atrapado en mora ──────────
    R.seccion('D5 — Bug #35: liquidacion de C+I con cuotas En Mora');
    const loansD5 = (await pedir(S, 'GET', '/api/loans')).json;
    const paysD5  = (await pedir(S, 'GET', '/api/payments')).json;
    // Las dos bases de capital que el backend distingue (y que el Bug #35 confundia):
    //   capitalPendienteLiq = origCOP - capital(Pagadas)              -> techo de LIQUIDAR
    //   saldoReal           = capitalPendienteLiq - capital(En Mora)  -> techo del ABONO normal
    function basesDe(l) {
      const ps = paysD5.filter(p => p.prestamoId === l.id && p.id.indexOf('-ab-') === -1);
      const orig = l.moneda === 'USD' ? Math.round(l.montoOrigen * l.trmAcordada) : Math.round(l.montoOrigen);
      const capPag  = ps.filter(p => p.estadoPago === 'Pagado').reduce((s, p) => s + p.abonoCapital, 0);
      const capMora = ps.filter(p => p.estadoPago === 'En Mora').reduce((s, p) => s + p.abonoCapital, 0);
      return { orig, capMora, capPendienteLiq: Math.max(0, orig - capPag), saldoReal: Math.max(0, orig - capPag - capMora) };
    }
    const lD5    = loansD5.find(l => l.id === d5a.loan.id);
    const lD5b   = loansD5.find(l => l.id === d5b.loan.id);
    if (!lD5 || !lD5b) throw new Error('ANTI-VACIO: se perdieron los prestamos fabricados para el caso del Bug #35');
    const infoD5  = basesDe(lD5);
    const infoD5b = basesDe(lD5b);
    R.check('D5 precondicion: capitalPendienteLiq > saldoReal (hay capital atrapado en la mora)',
      infoD5.capPendienteLiq > infoD5.saldoReal,
      JSON.stringify(infoD5) + '  <- si fueran iguales, liquidar no distinguiria las dos bases y el test seria una tautologia');
    R.check('D5 precondicion: el prestamo de control tambien tiene capital en mora',
      infoD5b.capPendienteLiq > infoD5b.saldoReal, JSON.stringify(infoD5b));
    const rLiqD5 = await pedir(S, 'POST', '/api/loans/' + lD5.id + '/abono',
      { monto: infoD5.capPendienteLiq, fecha: hoy, liquidar: true, observaciones: 'liquidacion C+I con mora e2e' });
    R.check('D5 liquidar el capital pendiente COMPLETO es aceptado (no rebota con 400)',
      rLiqD5.status === 200, 'status=' + rLiqD5.status + ' ' + rLiqD5.text.slice(0, 250));
    const loanD5 = conDb(DB, d => d.prepare('SELECT * FROM loans WHERE id=?').get(lD5.id));
    R.eq('D5 el prestamo queda Finalizado', loanD5.estado, 'Finalizado');
    R.eq('D5 no quedan cuotas Pendientes ni En Mora',
      conDb(DB, d => d.prepare("SELECT count(*) c FROM payments WHERE prestamoId=? AND estadoPago IN ('Pendiente','En Mora')").get(lD5.id).c), 0);
    const capRecD5 = conDb(DB, d => d.prepare(
      "SELECT COALESCE(SUM(abonoCapital),0) s FROM payments WHERE prestamoId=? AND estadoPago='Pagado'").get(lD5.id).s);
    R.eq('D5 el capital recuperado == capital prestado (ni doble conteo ni capital fantasma)',
      Math.round(capRecD5), infoD5.orig);

    // Control negativo: un abono NORMAL por ese mismo monto SI debe rebotar (techo = saldoReal).
    // Es lo que separa la ruta `liquidar` de la ruta de abono; sin esto, "aceptar el monto grande"
    // podria lograrse tambien rompiendo la validacion entera.
    const hashPreAbNo = hashBD(DB);
    const rAbNo = await pedir(S, 'POST', '/api/loans/' + lD5b.id + '/abono',
      { monto: infoD5b.capPendienteLiq, fecha: hoy, recalcMode: 'mantener' });
    R.check('D5 control: el MISMO monto como abono NORMAL (sin liquidar) si se rechaza -> 4xx',
      rAbNo.status >= 400 && rAbNo.status < 500, 'status=' + rAbNo.status + ' ' + rAbNo.text.slice(0, 200));
    R.check('D5 control: el rechazo del abono dejo la BD INTACTA', hashBD(DB) === hashPreAbNo);
    // Y el borde exacto: hasta saldoReal el abono normal SI pasa. Sin este par, "rechaza" podria
    // lograrse rompiendo la validacion entera en vez de respetando el techo correcto.
    const rAbSi = await pedir(S, 'POST', '/api/loans/' + lD5b.id + '/abono',
      { monto: infoD5b.saldoReal, fecha: hoy, recalcMode: 'mantener' });
    R.check('D5 control: un abono normal por exactamente saldoReal SI es aceptado',
      rAbSi.status === 200, 'monto=' + infoD5b.saldoReal + ' status=' + rAbSi.status + ' ' + rAbSi.text.slice(0, 200));
  } finally { await cerrar(S); }
}

// ═════════════════════════════════════════════════════════════════════════════
// FASE E — BLINDAJE DE INTERES DIARIO
//
// Cada caso de aqui protege una defensa que NO tiene otro testigo en la suite. Sin
// esto, un refactor futuro puede quitar cualquiera de los seis guards y las 283
// comprobaciones anteriores seguirian en verde: el fixture no ejerce ninguno de
// estos caminos por si solo.
//
// El patron es siempre el mismo y es el que importa: no basta con que la respuesta
// sea 4xx — hay que comprobar que la BD quedo INTACTA. Un rechazo que ya escribio
// a medias es peor que no rechazar, porque deja al deudor en un estado que nadie
// diseno (doctrina de atomicidad, convencion #3).
async function faseBlindaje() {
  R.seccion('FASE E — blindaje de Interes Diario: seis defensas, cada una con su testigo');
  const E = require('../backend/core/engine');
  const { esCuotaRegular } = require('../backend/core/ids');
  const rutaE = copiaDeProduccion('e2e-blindaje');
  const S = await arrancar(rutaE);
  const DB = S.dbPath;
  try {
    // ── E1 — el motor rechaza lo que no entiende ──────────────────────────────
    R.seccion('E1 — buildSchedule: rechazo estricto de modalidad desconocida');
    const base = { id: 'T', nombre: 'X', tasaMensual: 3, fechaInicio: '2026-07-01',
                   diaPago: 15, montoCOP: 1000000, frecuencia: 'Mensual' };
    let lanzo = false, tipoErr = '';
    try { E.buildSchedule({ ...base, modalidad: 'Modalidad Inventada', plazoMeses: 0 }); }
    catch (e) { lanzo = true; tipoErr = e && e.constructor && e.constructor.name; }
    R.check('E1 lanza ante una modalidad desconocida', lanzo,
      'sin el throw, la cascada cae en amortizacion francesa y fabrica (plazoMeses || 12) cuotas PMT');
    R.eq('E1 lanza ClientError (=> 4xx, no 500)', tipoErr, 'ClientError');
    R.eq('E1 la modalidad de credito abierto NO lanza: devuelve cronograma vacio',
      E.buildSchedule({ ...base, modalidad: E.MODALIDAD_DIARIA, plazoMeses: 0 }).length, 0);
    // Control negativo: el rechazo no puede haberse logrado rompiendo el motor entero.
    E.MODALIDADES_CONOCIDAS.forEach(function (m) {
      let genero = 0;
      try { genero = E.buildSchedule({ ...base, modalidad: m, plazoMeses: 4 }).length; } catch (_) { genero = -1; }
      R.check('E1 control: ' + m + ' sigue generando cronograma', genero > 0, 'filas=' + genero);
    });

    // ── E2 — POST /api/loans con modalidad invalida ───────────────────────────
    R.seccion('E2 — POST /api/loans rechaza la modalidad antes de escribir');
    const hashE2 = hashBD(DB);
    const rE2 = await pedir(S, 'POST', '/api/loans', {
      nombre: 'Prueba blindaje', cedula: '', telefono: '', notas: '', frecuencia: 'Mensual',
      moneda: 'COP', montoOrigen: 100000, trmAcordada: 1, montoCOP: 100000,
      tasaMensual: 2, plazoMeses: 0, modalidad: 'Modalidad Inventada',
      fechaInicio: '2026-08-01', diaPago: 1, estado: 'Activo',
    });
    R.check('E2 responde 4xx', rE2.status >= 400 && rE2.status < 500, 'status=' + rE2.status);
    R.check('E2 la BD quedo INTACTA (el computo va en FASE 1, antes del INSERT)', hashBD(DB) === hashE2);

    // ── E3 — /cambiar-dia-pago: whitelist, no blacklist ───────────────────────
    R.seccion('E3 — /cambiar-dia-pago solo admite las modalidades con cuotas mensuales');
    const diario = conDb(DB, d => d.prepare("SELECT * FROM loans WHERE modalidad=?").get(E.MODALIDAD_DIARIA));
    R.check('E3 ANTI-VACIO: el fixture trae el credito de interes diario', !!diario,
      'sin el, este bloque entero seria verde en vacio');
    if (diario) {
      const hashE3 = hashBD(DB);
      const rE3 = await pedir(S, 'POST', '/api/loans/' + diario.id + '/cambiar-dia-pago', { nuevoDia: 20 });
      R.check('E3 rechaza el credito abierto', rE3.status >= 400 && rE3.status < 500,
        'status=' + rE3.status + ' — con blacklist entraba y se le recalculaba un cronograma mensual');
      R.check('E3 la BD quedo INTACTA (ni diaPago ni fechaBaseCronograma)', hashBD(DB) === hashE3);
      // Control negativo: a un C+I mensual el endpoint le SIGUE funcionando.
      const cyi = conDb(DB, d => d.prepare(
        "SELECT * FROM loans WHERE estado='Activo' AND modalidad='Capital + Intereses' AND (frecuencia IS NULL OR frecuencia='Mensual')").get());
      if (cyi) {
        const rOk = await pedir(S, 'POST', '/api/loans/' + cyi.id + '/cambiar-dia-pago',
          { nuevoDia: cyi.diaPago === 20 ? 21 : 20 });
        R.check('E3 control: un C+I mensual sigue pudiendo cambiar de dia', rOk.status === 200,
          'status=' + rOk.status + ' ' + String(rOk.text).slice(0, 160));
      }
    }

    // ── E4 — el CORTE es inmutable ────────────────────────────────────────────
    R.seccion('E4 — un corte no cambia de estado ni admite parciales');
    const corte = conDb(DB, d => d.prepare("SELECT * FROM payments WHERE id LIKE '%-ct-%' ORDER BY cuotaN").get());
    R.check('E4 ANTI-VACIO: existe al menos una fila de corte', !!corte);
    if (corte) {
      const hashE4 = hashBD(DB);
      const rPut = await pedir(S, 'PUT', '/api/payments/' + corte.id, { estadoPago: 'Pendiente' });
      R.check('E4 PUT /payments sobre un corte -> 4xx', rPut.status >= 400 && rPut.status < 500,
        'status=' + rPut.status + ' — dejarlo Pendiente lo expondria a la auto-mora');
      const rPar = await pedir(S, 'POST', '/api/payments/' + corte.id + '/partial',
        { monto: 5000, fecha: hoyStr() });
      R.check('E4 /partial sobre un corte -> 4xx', rPar.status >= 400 && rPar.status < 500,
        'status=' + rPar.status + ' — sumaria un evento al ledger e inflaria Cobros del Mes');
      R.check('E4 la BD quedo INTACTA tras los dos intentos', hashBD(DB) === hashE4);
    }

    // ── E5 — el credito abierto no se cierra solo ─────────────────────────────
    R.seccion('E5 — auto-finalizacion: un credito abierto no tiene cuotas que cerrar');
    if (diario) {
      R.eq('E5 sigue Activo tras los intentos anteriores',
        conDb(DB, d => d.prepare('SELECT estado FROM loans WHERE id=?').get(diario.id).estado), 'Activo');
      const suyas = conDb(DB, d => d.prepare('SELECT * FROM payments WHERE prestamoId=?').all(diario.id));
      R.check('E5 tiene filas, y NINGUNA cuenta como cuota de cronograma',
        suyas.length > 0 && suyas.filter(esCuotaRegular).length === 0,
        suyas.length + ' filas, ' + suyas.filter(esCuotaRegular).length + ' regulares — con `!esAbono` los ' +
        'cortes contaban como cuotas, y al estar todos Pagados el prestamo se auto-finalizaba con el capital vivo');
    }

    // ── E6 — /recalculate: aisla al problematico ──────────────────────────────
    R.seccion('E6 — /recalculate omite el prestamo que falla y sigue con los demas');
    const victima = conDb(DB, d => d.prepare(
      "SELECT * FROM loans WHERE modalidad='Capital + Intereses' AND estado='Activo'").get());
    R.check('E6 ANTI-VACIO: hay un C+I activo con el que fabricar el caso', !!victima);
    if (victima) {
      // Se corrompe la modalidad DIRECTO en la BD, saltandose la validacion del POST: es
      // como llegaria un dato heredado o una migracion futura a medio aplicar.
      conDbW(DB, d => d.prepare("UPDATE loans SET modalidad='Modalidad Corrupta' WHERE id=?").run(victima.id));
      const pendAntes = conDb(DB, d => d.prepare(
        "SELECT COUNT(*) c FROM payments WHERE prestamoId=? AND estadoPago='Pendiente'").get(victima.id).c);
      const rRec = await pedir(S, 'POST', '/api/recalculate', {});
      R.eq('E6 responde 200 pese al prestamo corrupto', rRec.status, 200);
      R.check('E6 lo REPORTA en `omitidos` en vez de callarlo',
        rRec.json && Array.isArray(rRec.json.omitidos) && rRec.json.omitidos.some(o => o.id === victima.id),
        JSON.stringify((rRec.json || {}).omitidos || []));
      R.check('E6 recalculo los demas prestamos', rRec.json && rRec.json.updated > 0,
        'updated=' + ((rRec.json || {}).updated));
      R.eq('E6 el corrupto quedo INTACTO (su transaccion revirtio sola)',
        conDb(DB, d => d.prepare("SELECT COUNT(*) c FROM payments WHERE prestamoId=? AND estadoPago='Pendiente'").get(victima.id).c),
        pendAntes);
      conDbW(DB, d => d.prepare("UPDATE loans SET modalidad='Capital + Intereses' WHERE id=?").run(victima.id));

      // ── E7 — PUT /loans no puede huerfanar un pago parcial ──────────────────
      R.seccion('E7 — Bug #44: PUT /loans aborta si el cronograma nuevo dejaria un parcial sin sitio');
      const ultima = conDb(DB, d => d.prepare(
        "SELECT * FROM payments WHERE prestamoId=? AND estadoPago='Pendiente' AND id NOT LIKE '%-ab-%' ORDER BY cuotaN DESC").get(victima.id));
      R.check('E7 ANTI-VACIO: el prestamo tiene una Pendiente sobre la que poner el parcial', !!ultima);
      if (ultima) {
        conDbW(DB, d => d.prepare('UPDATE payments SET partialPaid=?, recibos=? WHERE id=?')
          .run(70000, JSON.stringify([{ fecha: hoyStr(), cop: 70000 }]), ultima.id));
        const loanRow = conDb(DB, d => d.prepare('SELECT * FROM loans WHERE id=?').get(victima.id));
        const hashE7 = hashBD(DB);
        // Acortar el plazo a 1 deja fuera esa cuotaN: el parcial no tendria donde restaurarse.
        const rE7 = await pedir(S, 'PUT', '/api/loans/' + victima.id, { ...loanRow, plazoMeses: 1 });
        R.check('E7 responde 4xx en vez de tragarse el parcial', rE7.status >= 400 && rE7.status < 500,
          'status=' + rE7.status + ' ' + String(rE7.text).slice(0, 160));
        R.check('E7 la BD quedo INTACTA: el parcial, su ledger y el plazo siguen igual', hashBD(DB) === hashE7);
        // Control negativo: el MISMO PUT sin acortar el plazo si pasa. Sin esto, "rechaza"
        // podria conseguirse rompiendo PUT /loans entero.
        const rE7ok = await pedir(S, 'PUT', '/api/loans/' + victima.id, { ...loanRow });
        R.eq('E7 control: el mismo PUT sin acortar el plazo SI es aceptado', rE7ok.status, 200);
        R.eq('E7 control: y el parcial sobrevivio a esa regeneracion',
          conDb(DB, d => d.prepare('SELECT partialPaid FROM payments WHERE id=?').get(ultima.id).partialPaid), 70000);
      }
    }
  } finally { await cerrar(S); }
}

// ═════════════════════════════════════════════════════════════════════════════
// FASE F — CICLO DE VIDA DE UN CREDITO DE INTERES DIARIO
//
// Recorre el producto entero contra el servidor REAL: crear retroactivo, cobrar
// intereses, abonar capital, saldar, y los rechazos de cada validacion. Es lo que
// convierte "el motor calcula bien" (suite motor-diario, pura) en "el endpoint
// escribe bien lo que el motor calcula".
//
// TODAS las fechas son RELATIVAS a hoy. Con fechas fijas el test caducaria: un
// credito "abierto hace 15 dias" pasaria a tener 400 y los importes cambiarian
// solos. Relativas, los montos son estables (15 dias al 3% sobre 1.000.000 son
// 15.000 cualquier dia del ano).
async function faseDiario() {
  R.seccion('FASE F — ciclo de vida completo de un credito de interes diario');
  const E = require('../backend/core/engine');
  const rutaF = copiaDeProduccion('e2e-diario');
  const S = await arrancar(rutaF);
  const DB = S.dbPath;
  const hoy = hoyStr();
  const haceDias = (n) => E.sumarDias(hoy, -n);
  // El registro de cobertura se mantiene A MANO (`pedir` no marca solo). Sin esta
  // linea la suite seguiria anunciando cobertura total teniendo un endpoint sin tocar.
  marcar('POST /api/loans/:id/corte');
  // Snapshot del agregado (loan + sus payments) para comprobar "BD intacta" y el undo.
  const agregado = (id) => JSON.stringify({
    loan: conDb(DB, d => d.prepare('SELECT * FROM loans WHERE id=?').get(id)),
    pays: conDb(DB, d => d.prepare('SELECT * FROM payments WHERE prestamoId=? ORDER BY id').all(id)),
  });

  try {
    // ── F1 — creacion RETROACTIVA ──────────────────────────────────────────
    R.seccion('F1 — POST /api/loans crea el credito abierto sin cronograma');
    const rNuevo = await pedir(S, 'POST', '/api/loans', {
      nombre: 'Deudor Diario E2E', cedula: '', telefono: '', notas: '', frecuencia: 'Mensual',
      moneda: 'COP', montoOrigen: 1000000, trmAcordada: 1, montoCOP: 1000000,
      tasaMensual: 3, plazoMeses: 0, modalidad: E.MODALIDAD_DIARIA,
      fechaInicio: haceDias(15), diaPago: 1, estado: 'Activo',
    });
    R.eq('F1 responde 201', rNuevo.status, 201);
    const idD = rNuevo.json && rNuevo.json.id;
    R.check('F1 devuelve el id del credito', !!idD);
    if (!idD) return;
    R.eq('F1 NO le genero ni una cuota de cronograma',
      conDb(DB, d => d.prepare('SELECT COUNT(*) c FROM payments WHERE prestamoId=?').get(idD).c), 0);
    const l1 = conDb(DB, d => d.prepare('SELECT * FROM loans WHERE id=?').get(idD));
    R.eq('F1 fechaUltimoCorte se sembro en fechaInicio (nunca NULL: evita el interes-cero-silencioso)',
      l1.fechaUltimoCorte, haceDias(15));
    R.eq('F1 interesAcumuladoPend arranca en 0', l1.interesAcumuladoPend, 0);
    R.eq('F1 plazoMeses normalizado al centinela', l1.plazoMeses, 0);

    // ── F2 — rechazos, cada uno con la BD intacta ──────────────────────────
    R.seccion('F2 — validaciones del corte: 4xx Y la BD sin tocar');
    const casos = [
      ['interes mayor que el devengado', { interesPagado: 99999999 }],
      ['abono mayor que el capital vivo', { abonoCapital: 99999999 }],
      ['corte vacio (ni interes ni capital)', { interesPagado: 0, abonoCapital: 0 }],
      ['fecha futura', { interesPagado: 1000, fecha: E.sumarDias(hoy, 1) }],
      ['fecha anterior al inicio del credito', { interesPagado: 1000, fecha: haceDias(40) }],
      ['montos negativos', { interesPagado: -5000 }],
      ['fecha con formato invalido', { interesPagado: 1000, fecha: '05/08/2026' }],
    ];
    for (const [etiqueta, cuerpo] of casos) {
      const antes = agregado(idD);
      const r = await pedir(S, 'POST', '/api/loans/' + idD + '/corte', cuerpo);
      R.check('F2 rechaza ' + etiqueta + ' -> 4xx', r.status >= 400 && r.status < 500,
        'status=' + r.status + ' ' + String(r.text).slice(0, 140));
      R.check('F2 y la BD quedo INTACTA tras ' + etiqueta, agregado(idD) === antes);
    }

    // ── F3 — corte de SOLO INTERES ─────────────────────────────────────────
    R.seccion('F3 — corte de solo interes: cobra el devengo y no toca el capital');
    // 15 dias al 3% sobre 1.000.000 = 15.000, con la convencion dias reales / 30.
    const rC1 = await pedir(S, 'POST', '/api/loans/' + idD + '/corte',
      { fecha: hoy, interesPagado: 15000, abonoCapital: 0, observaciones: 'corte e2e 1' });
    R.eq('F3 responde 200', rC1.status, 200);
    R.eq('F3 el devengo previo era exactamente 15.000 (15 dias retroactivos)',
      rC1.json && rC1.json.antes.interesPendiente, 15000);
    R.eq('F3 tras el corte no queda interes pendiente', rC1.json && rC1.json.despues.interesPendiente, 0);
    R.eq('F3 el capital sigue intacto', rC1.json && rC1.json.despues.capitalVivo, 1000000);
    const ct1 = conDb(DB, d => d.prepare('SELECT * FROM payments WHERE prestamoId=? ORDER BY cuotaN').all(idD));
    R.eq('F3 creo UNA fila', ct1.length, 1);
    R.eq('F3 con id de corte', ct1[0].id, idD + '-ct-1');
    R.eq('F3 nace Pagado (invariante I1)', ct1[0].estadoPago, 'Pagado');
    R.eq('F3 cuotaTotal == interesPeriodo en un corte de solo interes (invariante I6)',
      ct1[0].cuotaTotal, ct1[0].interesPeriodo);
    R.eq('F3 abonoCapital = 0', ct1[0].abonoCapital, 0);
    R.check('F3 el ledger `recibos` quedo escrito (invariante I5)',
      (ct1[0].recibos || '').indexOf('15000') !== -1, ct1[0].recibos);
    R.check('F3 partialPaid == cuotaTotal (el corte esta saldado por definicion)',
      ct1[0].partialPaid === ct1[0].cuotaTotal);
    const l3 = conDb(DB, d => d.prepare('SELECT * FROM loans WHERE id=?').get(idD));
    R.eq('F3 el cache avanzo al dia del corte', l3.fechaUltimoCorte, hoy);
    R.eq('F3 sin interes arrastrado', l3.interesAcumuladoPend, 0);
    R.eq('F3 el credito sigue Activo (queda capital)', l3.estado, 'Activo');

    // ── F4 — /abono esta cerrado para esta modalidad ───────────────────────
    R.seccion('F4 — /abono rechaza el credito abierto (crearia una fila que el motor no mira)');
    const antesAb = agregado(idD);
    const rAb = await pedir(S, 'POST', '/api/loans/' + idD + '/abono',
      { monto: 100000, fecha: hoy, recalcMode: 'mantener' });
    R.check('F4 responde 4xx', rAb.status >= 400 && rAb.status < 500, 'status=' + rAb.status);
    R.check('F4 y la BD quedo INTACTA', agregado(idD) === antesAb);

    // ── F5 — UNDO del corte: round-trip byte-exacto ────────────────────────
    R.seccion('F5 — deshacer un corte devuelve el agregado tal cual estaba');
    const antesUndo = agregado(idD);
    const rC2 = await pedir(S, 'POST', '/api/loans/' + idD + '/corte',
      { fecha: hoy, interesPagado: 0, abonoCapital: 200000 });
    R.eq('F5 el corte con abono responde 200', rC2.status, 200);
    R.eq('F5 el capital bajo', rC2.json && rC2.json.despues.capitalVivo, 800000);
    const undos = (await pedir(S, 'GET', '/api/undo?scopeTipo=loan&scopeId=' + idD)).json;
    const head = Array.isArray(undos) && undos.find(u => u.estado === 'disponible');
    R.check('F5 el corte quedo journalizado y es reversible', !!head, JSON.stringify(undos || []).slice(0, 200));
    if (head) {
      R.eq('F5 marcado como movimiento de caja', head.afecta_caja, 1);
      const rUndo = await pedir(S, 'POST', '/api/undo/' + head.id, {});
      R.eq('F5 el undo responde 200', rUndo.status, 200);
      R.check('F5 el agregado volvio BYTE-EXACTO al estado previo', agregado(idD) === antesUndo,
        'el snapshot restaurado no coincide');
    }

    // ── F6 — CIERRE ESTRICTO ───────────────────────────────────────────────
    R.seccion('F6 — solo finaliza con capital 0 Y devengo 0');
    // Se abona TODO el capital pero se deja 0 de interes pagado. Como el corte es
    // del mismo dia que el anterior, el tramo es de 0 dias y no devenga nada nuevo.
    const rC3 = await pedir(S, 'POST', '/api/loans/' + idD + '/corte',
      { fecha: hoy, interesPagado: 0, abonoCapital: 1000000 });
    R.eq('F6 el abono total responde 200', rC3.status, 200);
    R.eq('F6 el capital quedo en 0', rC3.json && rC3.json.despues.capitalVivo, 0);
    R.eq('F6 con capital 0 y sin interes pendiente, SALDA', rC3.json && rC3.json.saldado, true);
    R.eq('F6 el credito quedo Finalizado',
      conDb(DB, d => d.prepare('SELECT estado FROM loans WHERE id=?').get(idD).estado), 'Finalizado');

    // Y el control que de verdad prueba la regla: capital 0 PERO interes vivo.
    R.seccion('F6b — control: capital 0 con interes pendiente NO cierra');
    const rB = await pedir(S, 'POST', '/api/loans', {
      nombre: 'Deudor Diario E2E b', cedula: '', telefono: '', notas: '', frecuencia: 'Mensual',
      moneda: 'COP', montoOrigen: 1000000, trmAcordada: 1, montoCOP: 1000000,
      tasaMensual: 3, plazoMeses: 0, modalidad: E.MODALIDAD_DIARIA,
      fechaInicio: haceDias(10), diaPago: 1, estado: 'Activo',
    });
    const idB = rB.json && rB.json.id;
    R.check('F6b se creo el segundo credito', !!idB);
    if (idB) {
      // Abona TODO el capital sin pagar un peso de los 10.000 devengados.
      const rBC = await pedir(S, 'POST', '/api/loans/' + idB + '/corte',
        { fecha: hoy, interesPagado: 0, abonoCapital: 1000000 });
      R.eq('F6b responde 200', rBC.status, 200);
      R.eq('F6b el capital quedo en 0', rBC.json && rBC.json.despues.capitalVivo, 0);
      R.eq('F6b PERO quedan 10.000 de interes devengado', rBC.json && rBC.json.despues.interesPendiente, 10000);
      R.eq('F6b por eso NO salda', rBC.json && rBC.json.saldado, false);
      R.eq('F6b y el credito sigue Activo',
        conDb(DB, d => d.prepare('SELECT estado FROM loans WHERE id=?').get(idB).estado), 'Activo');
      // Al cobrar ese interes —y solo entonces— cierra.
      const rBF = await pedir(S, 'POST', '/api/loans/' + idB + '/corte',
        { fecha: hoy, interesPagado: 10000, abonoCapital: 0 });
      R.eq('F6b cobrado el interes, ahora SI salda', rBF.json && rBF.json.saldado, true);
      R.eq('F6b y queda Finalizado',
        conDb(DB, d => d.prepare('SELECT estado FROM loans WHERE id=?').get(idB).estado), 'Finalizado');
    }

    // ── F7 — el corte solo aplica a esta modalidad ─────────────────────────
    R.seccion('F7 — /corte rechaza las modalidades con cronograma');
    const cyi = conDb(DB, d => d.prepare("SELECT id FROM loans WHERE modalidad='Capital + Intereses' AND estado='Activo'").get());
    if (cyi) {
      const antesC = agregado(cyi.id);
      const rNo = await pedir(S, 'POST', '/api/loans/' + cyi.id + '/corte', { interesPagado: 1000 });
      R.check('F7 responde 4xx sobre un C+I', rNo.status >= 400 && rNo.status < 500, 'status=' + rNo.status);
      R.check('F7 y la BD quedo INTACTA', agregado(cyi.id) === antesC);
    }

    // ── F8 — cierre forzoso: el interes devengado SI cuenta como perdida ───
    R.seccion('F8 — force-close de un credito abierto no reporta $0 de interes perdido');
    const rF8 = await pedir(S, 'POST', '/api/loans', {
      nombre: 'Deudor Diario E2E c', cedula: '', telefono: '', notas: '', frecuencia: 'Mensual',
      moneda: 'COP', montoOrigen: 1000000, trmAcordada: 1, montoCOP: 1000000,
      tasaMensual: 3, plazoMeses: 0, modalidad: E.MODALIDAD_DIARIA,
      fechaInicio: haceDias(20), diaPago: 1, estado: 'Activo',
    });
    const idC = rF8.json && rF8.json.id;
    if (idC) {
      const rFc = await pedir(S, 'POST', '/api/loans/' + idC + '/force-close', {});
      R.eq('F8 responde 200', rFc.status, 200);
      R.eq('F8 el capital perdido es el prestado', rFc.json && rFc.json.capitalPerdido, 1000000);
      R.eq('F8 y los intereses perdidos son los 20 dias devengados', rFc.json && rFc.json.interesesPerdidos, 20000);
    }
  } finally { await cerrar(S); }
}

// ═════════════════════════════════════════════════════════════════════════════
// createApp nunca cierra su conexion a SQLite, asi que las copias de ESTA corrida siguen
// bloqueadas al terminar y no se pueden borrar desde aqui. Se podan al ARRANCAR las que ya
// tienen mas de 2 horas: sus procesos murieron hace rato y el handle esta libre. El margen
// protege a cualquier otra suite que este corriendo en paralelo (sus copias son de hace
// segundos). Sin esto, %TEMP%/cartera-tests crece sin techo durante un refactor largo
// (medido: 445 archivos / 77 MB acumulados).
function podarCopiasViejas() {
  const dir = require('./lib/db').WORK;
  if (!fs.existsSync(dir)) return 0;
  const limite = Date.now() - 2 * 60 * 60 * 1000;
  let n = 0;
  for (const f of fs.readdirSync(dir)) {
    if (!/\.db(-journal|-wal|-shm)?$/.test(f)) continue;
    const p = path.join(dir, f);
    try { if (fs.statSync(p).mtimeMs < limite) { fs.unlinkSync(p); n++; } } catch (_) { /* en uso: se ignora */ }
  }
  return n;
}

async function main() {
  console.log('e2e-api — golden master de los ' + ENDPOINTS.length + ' endpoints contra backend/server.js REAL');
  console.log('modo: ' + (ACTUALIZAR ? 'ACTUALIZAR BASELINES' : 'comparar contra baseline'));
  const podadas = podarCopiasViejas();
  if (podadas) console.log('copias temporales viejas eliminadas: ' + podadas);

  await faseLectura();
  await faseEscritura();
  await faseUndo();
  await faseRegresiones();
  await faseBlindaje();
  await faseDiario();

  // ── ANTI-VACIO ─────────────────────────────────────────────────────────────
  R.seccion('Anti-vacio — cobertura y volumen');
  const faltan = ENDPOINTS.filter(e => !tocados.has(e));
  R.check('se ejercitaron los ' + ENDPOINTS.length + ' endpoints (faltan ' + faltan.length + ')',
    faltan.length === 0, faltan.join('\n'));
  R.check('se compararon o crearon los 8 golden', goldenCreados + goldenComparados === 8,
    'creados=' + goldenCreados + ' comparados=' + goldenComparados);
  // Piso de volumen: backstop contra una suite que deje de afirmar sin fallar (una fase que
  // devuelva temprano, un bucle que no itere). Hoy son 282; el piso se fija con holgura para
  // absorber variacion de datos, pero muy por encima de "casi nada".
  const total = R.ok + R.fallos;
  R.check('la suite afirmo un volumen significativo (>=250 checks)', total >= 250, 'checks=' + total);
  R.check('FASE D corrio: los casos fabricados de sensibilidad estan presentes',
    R.pasos.filter(p => /^D\d /.test(p.desc)).length >= 25,
    'checks de FASE D=' + R.pasos.filter(p => /^D\d /.test(p.desc)).length);

  if (HALLAZGOS.length) {
    console.log('\n-- HALLAZGOS (posibles bugs de produccion, NO corregidos)');
    HALLAZGOS.forEach((h, i) => console.log('  ' + (i + 1) + '. ' + h));
  }
  console.log('\ncobertura: ' + tocados.size + '/' + ENDPOINTS.length + ' endpoints');
  return R.finalizar();
}

main()
  .then(code => process.exit(code))
  .catch(err => {
    console.error('\nERROR FATAL — la suite no pudo completarse (esto NO es un verde en vacio):');
    console.error(err && err.stack || err);
    process.exit(2);
  });
