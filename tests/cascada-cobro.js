// tests/cascada-cobro.js — el ORQUESTADOR de cobro en cascada, contra el server REAL.
//
// Que se prueba aqui y por que:
//
// 1. `planCascada` es codigo del FRONTEND (public/js/core/cascada.js) y se carga con
//    el mismo aplanador de modulos que usan las demas suites: se ejecuta el archivo
//    REAL, no una reimplementacion.
// 2. Los pasos del plan se disparan contra el `server.js` REAL sobre una COPIA de la
//    BD. Eso es lo unico que demuestra la afirmacion central de la feature: que la
//    cascada se puede armar SIN matematica nueva en el backend, solo ordenando
//    llamadas a `/partial` y `/abono`.
// 3. La cadena es multi-peticion y NO es una transaccion. Por eso la prueba mas
//    importante es la del FALLO A MITAD (seccion D): que se corte al primer error,
//    que lo ya aplicado quede integro, y que lo posterior no se toque.
// 4. El modal PROMETE como quedara el cronograma, y lo dibuja con `filasPreview`, una
//    segunda implementacion de `buildSchedule`. La seccion F ata esas dos copias contra
//    el motor real: es la clase de divergencia silenciosa que causo el Bug #51.
//
// Ejecutar:  ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron tests/cascada-cobro.js

const fs   = require('fs');
const vm   = require('vm');
const path = require('path');
const http = require('http');
const { Reporter }          = require('./lib/report');
const { copiaDeProduccion } = require('./lib/db');
const { REPO }              = require('./lib/paths');

const R = new Reporter('cascada-cobro');

// ── Carga del modulo real de cascada (aplanado, como en load-frontend) ────────
const RE_IMPORT = /^[ \t]*import\s+(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"]\s*;?[ \t]*$/gm;
function aplanar(entrada, vistos, orden) {
  const abs = path.resolve(entrada);
  if (vistos.has(abs)) return;
  vistos.add(abs);
  let src = fs.readFileSync(abs, 'utf8');
  const deps = [];
  let m; RE_IMPORT.lastIndex = 0;
  while ((m = RE_IMPORT.exec(src)) !== null) deps.push(m[1]);
  for (const d of deps) {
    if (!d.startsWith('.') && !d.startsWith('/')) continue;
    aplanar(path.resolve(path.dirname(abs), d), vistos, orden);
  }
  src = src.replace(RE_IMPORT, '')
    .replace(/^[ \t]*export\s+(?=(?:const|let|var|function|class|async)\b)/gm, '')
    .replace(/^[ \t]*export\s*\{[^}]*\}\s*;?[ \t]*$/gm, '');
  orden.push(src);
}
// `calculo.js` entra en el mismo contexto porque la seccion F necesita `filasPreview`
// —el espejo del motor que dibuja el preview del modal— junto con `_pmt`/`_tasaPeriodo`,
// que son los que el propio CobroModal usa para alimentarlo.
//
// `pdf/recibo-cobro.js` entra por la seccion G, que comprueba que el PAPEL que se le
// entrega al deudor no contradiga lo que el motor acaba de persistir. Necesita un DOM
// minimo: el generador solo lee el tema de `document.documentElement` y emite por
// `electronAPI.printPDF`, que aqui se sustituye por una captura del HTML.
function cargarCascada() {
  const orden = [], vistos = new Set();
  aplanar(path.join(REPO, 'public', 'js', 'core', 'cascada.js'), vistos, orden);
  aplanar(path.join(REPO, 'public', 'js', 'core', 'calculo.js'), vistos, orden);
  aplanar(path.join(REPO, 'public', 'js', 'pdf', 'recibo-cobro.js'), vistos, orden);
  const pdfs = [];
  const sb = {
    console,
    document: { documentElement: { getAttribute: () => 'light' } },
    window:   { electronAPI: { printPDF: (html, fname) => { pdfs.push({ html, fname }); } } },
  };
  sb.globalThis = sb;
  const ctx = vm.createContext(sb);
  vm.runInContext(orden.join('\n'), ctx);
  const api = vm.runInContext(
    '({planCascada,cobrableTotal,contextoCascada,filasPreview,_pmt,_tasaPeriodo,generateReciboCobro,saldoConCaja})', ctx);
  api.pdfs = pdfs;
  return api;
}

// ── Servidor real sobre copia ────────────────────────────────────────────────
const PORT = 3971;
// La seccion F levanta su PROPIA copia y su propio servidor (ver alli el por que),
// asi que `pedir` y `ejecutarPlan` aceptan un puerto.
const PORT_F = 3972;
// La seccion G hace lo mismo: su propia copia, su propio servidor.
const PORT_G = 3973;
function pedir(method, ruta, body, port) {
  return new Promise((res, rej) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({
      host: '127.0.0.1', port: port || PORT, path: ruta, method,
      headers: Object.assign({ 'Content-Type': 'application/json' },
        data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
    }, x => {
      let b = '';
      x.on('data', c => b += c);
      x.on('end', () => { let j = null; try { j = JSON.parse(b || '{}'); } catch (_) {} res({ status: x.statusCode, json: j }); });
    });
    r.on('error', rej);
    if (data) r.write(data);
    r.end();
  });
}

// Replica EXACTA de `_doCobroCascada` (app.js): en serie, corta al primer fallo.
// Se replica en vez de importarse porque vive dentro del componente App y sacarlo
// de ahi solo para el test cambiaria el codigo de produccion por conveniencia del
// arnes. Lo que se verifica aqui es el CONTRATO: orden, corte y campos enviados.
async function ejecutarPlan(loanId, plan, fecha, obs, port) {
  const estado = { ok: true, hechos: [], error: null, pasoFallido: null };
  for (const paso of plan.pasos) {
    const r = paso.tipo === 'partial'
      ? await pedir('POST', '/api/payments/' + paso.payId + '/partial',
          { monto: paso.cajaCOP, fecha, observaciones: obs, montoUSD: paso.obligacionUSD || 0 }, port)
      : await pedir('POST', '/api/loans/' + loanId + '/abono',
          { monto: paso.obligacionCOP, fecha, observaciones: obs, montoUSD: paso.obligacionUSD || 0,
            montoCOPRecibido: paso.cajaCOP, liquidar: false, recalcMode: 'mantener', recalcValor: null, intExtra: 0 }, port);
    if (r.status >= 400 || !r.json || r.json.error) {
      estado.ok = false;
      estado.error = (r.json && r.json.error) || ('HTTP ' + r.status);
      estado.pasoFallido = paso;
      break;
    }
    estado.hechos.push(paso);
  }
  return estado;
}

(async function main() {
  const { planCascada, cobrableTotal, filasPreview, _pmt, _tasaPeriodo,
          generateReciboCobro, saldoConCaja, pdfs } = cargarCascada();
  R.check('el modulo real de cascada se cargo', typeof planCascada === 'function' && typeof cobrableTotal === 'function');
  R.check('el modulo real de calculo se cargo (preview del cronograma)',
    typeof filasPreview === 'function' && typeof _pmt === 'function' && typeof _tasaPeriodo === 'function');
  R.check('el generador real del recibo consolidado se cargo',
    typeof generateReciboCobro === 'function' && typeof saldoConCaja === 'function');

  const DB = copiaDeProduccion('cascada-cobro');
  const app = require(path.join(REPO, 'backend', 'server.js'))(DB);
  const srv = http.createServer(app);
  await new Promise(ok => srv.listen(PORT, '127.0.0.1', ok));

  const Database = require(path.join(REPO, 'node_modules', 'better-sqlite3'));
  const conDb = fn => { const d = new Database(DB, { readonly: true }); try { return fn(d); } finally { d.close(); } };
  const esAbono = p => p.id.indexOf('-ab-') !== -1;
  const hoy = new Date().toISOString().slice(0, 10);

  const cargar = () => ({
    loans: conDb(d => d.prepare('SELECT * FROM loans').all()),
    pays:  conDb(d => d.prepare('SELECT * FROM payments').all()),
  });

  // Capital pendiente canonico: origCOP - suma abonoCapital de Pagadas.
  const capitalPendiente = (loan, pays) => {
    const orig = loan.moneda === 'USD' ? Math.round(loan.montoOrigen * loan.trmAcordada) : Math.round(loan.montoOrigen);
    const cap = pays.filter(p => p.prestamoId === loan.id && p.estadoPago === 'Pagado')
      .reduce((s, p) => s + p.abonoCapital, 0);
    return orig - Math.round(cap);
  };
  // Caja total registrada, leida del ledger `recibos` (fuente de verdad del flujo).
  const cajaDeFecha = (pays, loanId, fecha) => pays.filter(p => p.prestamoId === loanId).reduce((s, p) => {
    let ev = []; try { ev = JSON.parse(p.recibos || '[]'); } catch (_) {}
    if (Array.isArray(ev) && ev.length) return s + ev.filter(e => e.fecha === fecha).reduce((a, e) => a + Math.round(e.cop || 0), 0);
    // Sin ledger (abonos): se cae a montoCOPRecibido si la fila es de esa fecha.
    return s + ((p.fechaPago === fecha && esAbono(p)) ? Math.round(p.montoCOPRecibido || 0) : 0);
  }, 0);

  // ── A — CREDITO USD CON MORA: la cascada completa ──────────────────────────
  R.seccion('A — credito USD con mora: mora primero, remanente a capital');
  {
    let { loans, pays } = cargar();
    const loan = loans.find(l => l.moneda === 'USD' && l.estado === 'Activo' && l.modalidad === 'Capital + Intereses' &&
      pays.some(p => p.prestamoId === l.id && p.estadoPago === 'En Mora' && !esAbono(p)));
    R.check('A ANTI-VACIO: hay un C+I en USD con mora', !!loan);
    if (loan) {
      const cob = cobrableTotal(loan, pays);
      const moraUSD = Math.round(cob.mora / loan.trmAcordada * 100) / 100;
      // Se cobra la mora entera + un poco mas, para que haya paso de abono.
      const usd = Math.round((moraUSD + 100) * 100) / 100;
      const caja = Math.round(usd * loan.trmAcordada * 0.82); // TRM del dia por debajo de la pactada
      const plan = planCascada(loan, pays, { obligacionUSD: usd, cajaCOP: caja, obligacionCOP: 0 });

      R.check('A el plan pone la mora ANTES del abono',
        plan.pasos.length >= 2 && plan.pasos[0].tipo === 'partial' && plan.pasos[plan.pasos.length - 1].tipo === 'abono',
        plan.pasos.map(p => p.tipo).join(' -> '));
      R.eq('A la suma de los pasos == lo aplicado',
        plan.pasos.reduce((s, p) => s + p.obligacionCOP, 0), plan.totales.aplicado);
      R.eq('A la caja repartida == la caja declarada',
        plan.pasos.reduce((s, p) => s + p.cajaCOP, 0), caja);

      const capAntes = capitalPendiente(loan, pays);
      const est = await ejecutarPlan(loan.id, plan, hoy, 'test cascada');
      R.check('A los ' + plan.pasos.length + ' pasos se aplicaron sin error', est.ok, est.error || '');

      ({ loans, pays } = cargar());
      const loanD = loans.find(l => l.id === loan.id);
      R.eq('A no quedan cuotas En Mora',
        pays.filter(p => p.prestamoId === loan.id && p.estadoPago === 'En Mora' && !esAbono(p)).length, 0);
      // La obligacion extinguida es capital + interes; el capital pendiente baja solo
      // por la parte de capital (mora + abono), nunca por el interes cobrado.
      const capDespues = capitalPendiente(loanD, pays);
      R.eq('A el capital pendiente bajo EXACTAMENTE el capital imputado',
        capAntes - capDespues, plan.totales.capitalMora + plan.totales.abonoCapital);
      R.eq('A la caja del dia == lo que el usuario dijo haber recibido',
        cajaDeFecha(pays, loan.id, hoy), caja);
      R.check('A el capital pendiente nunca es negativo', capDespues >= 0, String(capDespues));
    }
  }

  // ── B — MULTIPLES CUOTAS EN MORA: orden y corte ────────────────────────────
  R.seccion('B — varias cuotas en mora: se cobran de la mas antigua a la mas nueva');
  {
    const { loans, pays } = cargar();
    const loan = loans.find(l => l.estado === 'Activo' &&
      pays.filter(p => p.prestamoId === l.id && p.estadoPago === 'En Mora' && !esAbono(p)).length >= 2);
    R.check('B ANTI-VACIO: hay un credito con 2+ cuotas en mora', !!loan);
    if (loan) {
      const esUSD = loan.moneda === 'USD';
      const cob = cobrableTotal(loan, pays);
      // Monto que cubre la primera mora entera y deja a la segunda a medias.
      const objetivo = Math.round(cob.mora * 0.6);
      const plan = planCascada(loan, pays, esUSD
        ? { obligacionUSD: Math.round(objetivo / loan.trmAcordada * 100) / 100, cajaCOP: objetivo, obligacionCOP: 0 }
        : { obligacionCOP: objetivo, cajaCOP: objetivo, obligacionUSD: 0 });

      const fechas = plan.pasos.filter(p => p.tipo === 'partial').map(p => p.fechaPago);
      const ordenadas = fechas.slice().sort();
      R.check('B las cuotas van en orden cronologico', JSON.stringify(fechas) === JSON.stringify(ordenadas), fechas.join(', '));
      R.check('B no se abre una cuota nueva sin haber saldado la anterior',
        plan.pasos.filter(p => p.tipo === 'partial').every((p, i, arr) => i === arr.length - 1 || p.salda),
        plan.pasos.filter(p => p.tipo === 'partial').map(p => p.salda ? 'salda' : 'parcial').join(', '));
      R.check('B sin remanente no se genera paso de abono',
        !plan.pasos.some(p => p.tipo === 'abono'), plan.pasos.map(p => p.tipo).join(' -> '));

      const est = await ejecutarPlan(loan.id, plan, hoy, 'test multi-mora');
      R.check('B la cadena se aplico completa', est.ok, est.error || '');
      const { pays: p2 } = cargar();
      const parcial = plan.pasos.filter(p => p.tipo === 'partial' && !p.salda)[0];
      if (parcial) {
        const fila = p2.find(p => p.id === parcial.payId);
        R.check('B la cuota parcial sigue En Mora con su abono encima',
          fila && fila.estadoPago === 'En Mora' && Math.round(fila.partialPaid) > 0,
          fila ? fila.estadoPago + ' partialPaid=' + Math.round(fila.partialPaid) : 'sin fila');
      }
    }
  }

  // ── C — CREDITO COP SIN MORA: solo abono ───────────────────────────────────
  R.seccion('C — credito COP sin mora: la cascada degenera en un abono simple');
  {
    const { loans, pays } = cargar();
    const loan = loans.find(l => l.moneda === 'COP' && l.estado === 'Activo' && l.modalidad === 'Capital + Intereses' &&
      !pays.some(p => p.prestamoId === l.id && p.estadoPago === 'En Mora' && !esAbono(p)));
    R.check('C ANTI-VACIO: hay un C+I en COP sin mora', !!loan);
    if (loan) {
      const monto = 100000;
      const plan = planCascada(loan, pays, { obligacionCOP: monto, cajaCOP: monto, obligacionUSD: 0 });
      R.eq('C un solo paso', plan.pasos.length, 1);
      R.eq('C y es de tipo abono', plan.pasos[0].tipo, 'abono');
      R.eq('C en COP la caja es la obligacion (sin efecto cambiario)', plan.pasos[0].cajaCOP, plan.pasos[0].obligacionCOP);
      const capAntes = capitalPendiente(loan, pays);
      const est = await ejecutarPlan(loan.id, plan, hoy, 'test cop');
      R.check('C se aplico', est.ok, est.error || '');
      const { loans: l2, pays: p2 } = cargar();
      R.eq('C el capital bajo exactamente el monto abonado',
        capAntes - capitalPendiente(l2.find(x => x.id === loan.id), p2), monto);
    }
  }

  // ── D — FALLO A MITAD: lo aplicado queda integro, lo demas intacto ─────────
  // Es LA prueba de esta arquitectura: la cadena no es transaccional, asi que hay
  // que demostrar que un fallo no deja el credito en un estado a medio construir
  // ni aplica pasos posteriores.
  R.seccion('D — fallo a mitad de la cadena: se corta y nada queda a medias');
  {
    const { loans, pays } = cargar();
    const loan = loans.find(l => l.estado === 'Activo' &&
      pays.some(p => p.prestamoId === l.id && p.estadoPago === 'En Mora' && !esAbono(p)));
    R.check('D ANTI-VACIO: hay un credito con mora para el escenario', !!loan);
    if (loan) {
      const esUSD = loan.moneda === 'USD';
      const cob = cobrableTotal(loan, pays);
      const objetivo = Math.round(cob.mora + Math.min(cob.abonable, 200000));
      const plan = planCascada(loan, pays, esUSD
        ? { obligacionUSD: Math.round(objetivo / loan.trmAcordada * 100) / 100, cajaCOP: objetivo, obligacionCOP: 0 }
        : { obligacionCOP: objetivo, cajaCOP: objetivo, obligacionUSD: 0 });
      R.check('D ANTI-VACIO: el plan tiene 2+ pasos (mora y abono)', plan.pasos.length >= 2,
        plan.pasos.map(p => p.tipo).join(' -> '));

      if (plan.pasos.length >= 2) {
        // Se sabotea el ULTIMO paso apuntandolo a un prestamo inexistente: el backend
        // responde 404 y la cadena debe cortarse ahi, con los previos ya aplicados.
        const capAntes = capitalPendiente(loan, pays);
        const planRoto = { pasos: plan.pasos.slice() };
        const ultimo = planRoto.pasos[planRoto.pasos.length - 1];
        const est = await ejecutarPlan('NO-EXISTE-' + loan.id,
          { pasos: [planRoto.pasos[0], ultimo] }, hoy, 'test fallo');

        R.check('D la cadena reporta fallo', est.ok === false, JSON.stringify(est.error));
        R.eq('D se aplico exactamente 1 paso antes de cortar', est.hechos.length, 1);
        R.eq('D el paso que fallo es el saboteado', est.pasoFallido && est.pasoFallido.tipo, ultimo.tipo);

        const { loans: l2, pays: p2 } = cargar();
        const loanD = l2.find(x => x.id === loan.id);
        const capDespues = capitalPendiente(loanD, p2);
        // El primer paso (la mora) SI se aplico: el capital bajo por su parte de capital.
        R.eq('D el capital refleja SOLO el paso aplicado',
          capAntes - capDespues, planRoto.pasos[0].capital);
        R.check('D el credito quedo en un estado consistente (capital >= 0)', capDespues >= 0, String(capDespues));
        // Y el journal tiene UNA sola entrada nueva: lo aplicado es reversible pieza a pieza.
        const journal = conDb(d => d.prepare(
          "SELECT COUNT(*) c FROM undo_journal WHERE scope_id=? AND estado='disponible'").get(loan.id).c);
        R.check('D lo aplicado quedo en el journal (reversible por separado)', journal > 0, 'entradas=' + journal);
      }
    }
  }

  // ── E — el plan NUNCA propone mas de lo que se debe ────────────────────────
  R.seccion('E — propiedad: el plan jamas imputa mas de lo cobrable');
  {
    const { loans, pays } = cargar();
    let casos = 0, violaciones = 0;
    for (const loan of loans.filter(l => l.estado === 'Activo')) {
      const cob = cobrableTotal(loan, pays);
      if (cob.total <= 0) continue;
      const esUSD = loan.moneda === 'USD';
      // Se prueba por debajo, justo en el techo y por encima.
      for (const factor of [0.13, 0.5, 1, 1.4]) {
        const obj = Math.round(cob.total * factor);
        if (obj <= 0) continue;
        const plan = planCascada(loan, pays, esUSD
          ? { obligacionUSD: Math.round(obj / loan.trmAcordada * 100) / 100, cajaCOP: obj, obligacionCOP: 0 }
          : { obligacionCOP: obj, cajaCOP: obj, obligacionUSD: 0 });
        casos++;
        // Tolerancia de un peso por dolar: el redondeo a centavos no puede dar mas.
        const tol = esUSD ? Math.ceil(loan.trmAcordada / 100) + 2 : 2;
        if (plan.totales.aplicado > cob.total + tol) { violaciones++; continue; }
        if (plan.totales.abonoCapital > plan.saldoAbonableDespues + tol) { violaciones++; continue; }
        for (const p of plan.pasos.filter(x => x.tipo === 'partial')) {
          const fila = pays.find(x => x.id === p.payId);
          const pend = Math.round(fila.cuotaTotal) - Math.round(fila.partialPaid || 0);
          if (p.obligacionCOP > pend + tol) { violaciones++; break; }
          if (Math.abs(p.interes + p.capital - p.obligacionCOP) > 2) { violaciones++; break; }
        }
        if (factor > 1 && !plan.error) { violaciones++; }  // pasarse debe avisarse
      }
    }
    R.check('E ANTI-VACIO: se probaron combinaciones reales', casos >= 12, 'casos=' + casos);
    R.eq('E ninguna violacion en ' + casos + ' combinaciones', violaciones, 0);
  }

  // ── F — EL PREVIEW DEL CRONOGRAMA ES ESPEJO DEL MOTOR ──────────────────────
  // `CobroModal` promete al usuario como quedaran sus cuotas DESPUES del cobro, y lo
  // dibuja con `filasPreview`, que es una SEGUNDA implementacion de lo que hace
  // `buildSchedule` en el backend. El proyecto ya pago ese precio: el Bug #51 existio
  // porque las dos copias divergieron y nadie se entero (el motor se arreglo en v2.2.0
  // y el preview siguio mal hasta v2.6.2). La cascada es un consumidor NUEVO de ese
  // espejo, asi que aqui se fija: se calcula el preview sobre el estado PREVIO, se
  // ejecuta la cascada contra el motor real, y se comparan fila a fila.
  //
  // Copia y servidor PROPIOS a proposito: si esta seccion dependiera de lo que A-E
  // dejaron, reordenarlas o cambiar sus montos podria dejarla sin cuotas que comparar
  // y el check se volveria verde en vacio, que es justo el modo de fallo que persigue.
  R.seccion('F — el preview del modal coincide con lo que el motor persiste');
  {
    const DB_F = copiaDeProduccion('cascada-preview');
    const appF = require(path.join(REPO, 'backend', 'server.js'))(DB_F);
    const srvF = http.createServer(appF);
    await new Promise(ok => srvF.listen(PORT_F, '127.0.0.1', ok));
    const conDbF = fn => { const d = new Database(DB_F, { readonly: true }); try { return fn(d); } finally { d.close(); } };
    const cargarF = () => ({
      loans: conDbF(d => d.prepare('SELECT * FROM loans').all()),
      pays:  conDbF(d => d.prepare('SELECT * FROM payments').all()),
    });
    await pedir('GET', '/api/payments', null, PORT_F);   // auto-mora, como en la app real

    // Se prueban las DOS formas en que el modal llega al preview: con mora previa
    // (donde `regularConsumed` y `saldoTrasCascada` los fija la cascada) y sin ella
    // (donde el cobro degenera en un abono simple).
    const { loans, pays } = cargarF();
    const capInt = l => l.estado === 'Activo' && l.modalidad === 'Capital + Intereses' &&
      pays.some(p => p.prestamoId === l.id && p.estadoPago === 'Pendiente' && !esAbono(p));
    const conMora = l => pays.some(p => p.prestamoId === l.id && p.estadoPago === 'En Mora' && !esAbono(p));
    const objetivos = [
      { etiqueta: 'con mora previa', loan: loans.filter(capInt).filter(conMora)[0] },
      { etiqueta: 'sin mora',        loan: loans.filter(capInt).filter(l => !conMora(l))[0] },
    ];
    R.check('F ANTI-VACIO: hay un C+I con mora y otro sin mora',
      !!objetivos[0].loan && !!objetivos[1].loan,
      objetivos.map(o => o.etiqueta + '=' + (o.loan ? o.loan.id : 'NINGUNO')).join(', '));

    let filasComparadas = 0;
    for (const obj of objetivos) {
      const loan = obj.loan;
      if (!loan) continue;
      const esUSD = loan.moneda === 'USD';
      const cob = cobrableTotal(loan, pays);
      // Hace falta que el plan incluya un ABONO: es el paso que regenera el cronograma.
      // Sin abono el motor no recalcula nada y el espejo no se ejercita.
      const objetivoCOP = Math.round(cob.mora + Math.min(cob.abonable, Math.max(100000, cob.abonable * 0.2)));
      const plan = planCascada(loan, pays, esUSD
        ? { obligacionUSD: Math.round(objetivoCOP / loan.trmAcordada * 100) / 100, cajaCOP: objetivoCOP, obligacionCOP: 0 }
        : { obligacionCOP: objetivoCOP, cajaCOP: objetivoCOP, obligacionUSD: 0 });
      R.check('F (' + obj.etiqueta + ') ANTI-VACIO: el plan incluye un abono, que es lo que regenera el cronograma',
        plan.ok && plan.pasos.some(p => p.tipo === 'abono'),
        (plan.error || '') + ' | ' + plan.pasos.map(p => p.tipo).join(' -> '));
      if (!plan.ok || !plan.pasos.some(p => p.tipo === 'abono')) continue;

      // REPLICA EXACTA del bloque `cronoPreview` de CobroModal.js. Si aquello cambia y
      // esto no, el check deja de medir lo que el usuario ve: van juntos a proposito.
      const saldo   = plan.saldoTrasCascada;
      const n       = Math.max(0, (+loan.plazoMeses || 0) - plan.ctx.regularConsumed);
      const r       = _tasaPeriodo((+loan.tasaMensual || 0) / 100, loan.frecuencia || 'Mensual');
      const nominal = Math.round(_pmt(r, n, saldo));
      const filas   = filasPreview(saldo, r, n, false, nominal);
      R.check('F (' + obj.etiqueta + ') ANTI-VACIO: el preview dibuja filas', filas.length > 0, 'n=' + n);

      const est = await ejecutarPlan(loan.id, plan, hoy, 'test preview', PORT_F);
      R.check('F (' + obj.etiqueta + ') la cascada se aplico contra el motor real', est.ok, est.error || '');
      if (!est.ok) continue;

      const post = cargarF().pays
        .filter(p => p.prestamoId === loan.id && !esAbono(p) && p.estadoPago === 'Pendiente')
        .sort((a, b) => a.cuotaN - b.cuotaN);
      R.eq('F (' + obj.etiqueta + ') el preview dibuja tantas filas como cuotas persistio el motor',
        filas.length, post.length);

      // Se comparan los TRES numeros de cada fila. Solo la cuota no basta: el Bug #43
      // desviaba el reparto interes/capital dejando el total intacto.
      const dif = [];
      for (let i = 0; i < Math.min(filas.length, post.length); i++) {
        const f = filas[i], p = post[i];
        const dc = Math.round(f.cuota)   - Math.round(p.cuotaTotal);
        const di = Math.round(f.interes) - Math.round(p.interesPeriodo);
        const dk = Math.round(f.capital) - Math.round(p.abonoCapital);
        filasComparadas++;
        if (dc || di || dk) dif.push('#' + p.cuotaN + ' cuota' + (dc >= 0 ? '+' : '') + dc +
          ' int' + (di >= 0 ? '+' : '') + di + ' cap' + (dk >= 0 ? '+' : '') + dk);
      }
      R.check('F (' + obj.etiqueta + ') preview == motor en cuota, interes y capital de cada fila',
        dif.length === 0, dif.join(' | '));
    }
    R.check('F ANTI-VACIO: se comparo un cronograma de verdad', filasComparadas >= 2,
      'filas comparadas=' + filasComparadas);
    srvF.close();
  }

  // ── G — EL PAPEL NO PUEDE CONTRADECIR AL MOTOR ─────────────────────────────
  // El recibo consolidado es lo unico que se lleva el cliente de un cobro en cascada, y
  // la doctrina v2.3.0 (Bug #45) es que el papel y la app nunca digan cosas distintas.
  // Aqui se ejecuta la cascada contra el motor REAL, se genera el recibo con los pasos
  // que EFECTIVAMENTE se aplicaron y con el cronograma ya persistido, y se comprueban
  // cinco cosas sobre el HTML emitido:
  //   1. el hero declara exactamente el dinero que el cliente entrego (la CAJA);
  //   2. los rubros del desglose suman el total aplicado, en la MONEDA VISIBLE — es la
  //      identidad que el Bug #31 rompia al reconciliar en COP y convertir despues;
  //   3. la fila "Capital de cuotas vencidas" aparece si y solo si la mora llevaba
  //      capital, en vez de imprimir un $0 que confundiria al deudor;
  //   4. el saldo impreso es el mismo que muestra la app (`saldoConCaja`, nunca el motor);
  //   5. hay una fila por movimiento aplicado: ni se calla uno ni se inventa otro.
  //
  // Los dos objetivos NO son redundantes: en `Capital + Intereses` una cuota En Mora
  // arrastra capital (3 rubros), mientras que en `Intereses` es puro interes (2 rubros).
  // Son las dos formas del documento, y la segunda es la que verifica el punto 3.
  //
  // La CAJA se aparta a proposito de la obligacion en el caso USD (TRM del dia por
  // debajo de la pactada), para que el recibo tenga que declarar DOS cifras distintas.
  // Con caja == obligacion los checks 1 y 2 serian la misma identidad trivial.
  //
  // Copia y servidor PROPIOS, misma razon que en F: si dependiera de lo que A-F dejaron,
  // reordenarlas podria dejar esta seccion sin mora que cobrar y volverla verde en vacio.
  R.seccion('G — el recibo consolidado dice lo mismo que el motor persistio');
  {
    const DB_G = copiaDeProduccion('cascada-recibo');
    const appG = require(path.join(REPO, 'backend', 'server.js'))(DB_G);
    const srvG = http.createServer(appG);
    await new Promise(ok => srvG.listen(PORT_G, '127.0.0.1', ok));
    const conDbG = fn => { const d = new Database(DB_G, { readonly: true }); try { return fn(d); } finally { d.close(); } };
    const cargarG = () => ({
      loans: conDbG(d => d.prepare('SELECT * FROM loans').all()),
      pays:  conDbG(d => d.prepare('SELECT * FROM payments').all()),
    });
    await pedir('GET', '/api/payments', null, PORT_G);   // auto-mora, como en la app real

    // PRIMER importe de un fragmento. Varias celdas llevan dos cifras (la caja y la TRM
    // del dia), asi que barrer todos los digitos las concatenaria en un numero absurdo.
    // En COP el punto separa miles; en USD es el decimal: hay que ramificar o
    // "USD $283.51" se leeria como 28.351.
    const numDe = t => {
      const x = String(t == null ? '' : t).replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ');
      const m = /(USD\s*)?\$\s*([\d.,]+)/.exec(x);
      if (!m) return NaN;
      return m[1] ? parseFloat(m[2].replace(/,/g, ''))
                  : parseInt(m[2].replace(/[^0-9]/g, ''), 10);
    };
    const heroDe  = html => (/<div class="rc-ta">([\s\S]*?)<\/div>/.exec(html) || [])[1];
    const heroSub = html => (/<div class="rc-ts">([\s\S]*?)<\/div>/.exec(html) || [])[1];
    const filasPanel = html => {
      const out = [], re = /<div class="rc-row(?: rc-row-tot)?"><span class="rc-lab">([\s\S]*?)<\/span><span class="rc-val"[^>]*>([\s\S]*?)<\/span><\/div>/g;
      let m; while ((m = re.exec(html)) !== null) out.push({ lab: m[1], val: m[2] });
      return out;
    };
    const tarjetas = html => {
      const out = [], re = /<div class="rc-card"><div class="rc-cl">([\s\S]*?)<\/div>([\s\S]*?)<div class="rc-new">([\s\S]*?)<\/div><\/div>/g;
      let m; while ((m = re.exec(html)) !== null) out.push({ lab: m[1], val: m[3] });
      return out;
    };

    const inicial = cargarG();
    const conMoraG = l => inicial.pays.some(p => p.prestamoId === l.id && p.estadoPago === 'En Mora' && !esAbono(p));
    const candidatos = inicial.loans.filter(l => l.estado === 'Activo' && l.modalidad !== 'Interes Diario').filter(conMoraG);
    const capInt = candidatos.filter(l => l.moneda === 'USD' && l.modalidad === 'Capital + Intereses')[0];
    // El ORDEN importa y es deliberado: el primer objetivo deja un parcial EN VUELO sobre
    // una cuota vencida, que es el unico estado en el que `saldoConCaja` y el saldo del
    // motor DIFIEREN. Sin el, el check del saldo pasaria igual imprimiendo el del motor y
    // no verificaria nada. El segundo termina de cobrar esa misma mora y agrega el abono.
    // Un reordenamiento no deja esto verde en vacio: cada objetivo trae su anti-vacio.
    const objetivosG = [
      { etiqueta: 'USD, parcial sobre cuota vencida', modo: 'parcial', loan: capInt },
      { etiqueta: 'USD, mora con capital + abono',    modo: 'mixto',   loan: capInt },
      { etiqueta: 'COP, mora solo interes + abono',   modo: 'mixto',
        loan: candidatos.filter(l => l.moneda !== 'USD' && l.modalidad === 'Intereses')[0] },
    ];
    R.check('G ANTI-VACIO: hay un credito con capital en mora y otro con mora de puro interes',
      objetivosG.every(o => !!o.loan),
      objetivosG.map(o => o.etiqueta + '=' + (o.loan ? o.loan.id : 'NINGUNO')).join(', '));

    let recibosVerificados = 0;
    const rubrosVistos = {};   // que los tres rubros se hayan ejercitado con valor alguna vez
    for (const obj of objetivosG) {
      const loan = obj.loan;
      if (!loan) continue;
      const et = 'G (' + obj.etiqueta + ') ';
      const esUSD = loan.moneda === 'USD';
      const trm = +loan.trmAcordada || 1;
      const antes = cargarG().pays;

      // 'mixto': toda la mora mas parte del capital amortizable -> el plan tiene los DOS
      // tipos de paso y el recibo debe explicar ambos.
      // 'parcial': solo el interes de la cuota vencida mas parte de su capital -> UN paso
      // que NO la salda, y deja capital imputado sin amortizar.
      const cob = cobrableTotal(loan, antes);
      const c0 = cob.ctx.moraCuotas[0];
      const objetivoCOP = obj.modo === 'parcial'
        ? Math.round(Math.round(c0.interesPeriodo) + Math.round(c0.abonoCapital) * 0.4)
        : Math.round(cob.mora + Math.min(cob.abonable, Math.max(100000, cob.abonable * 0.2)));
      const cajaCOP = esUSD ? Math.round(objetivoCOP * 0.94) : objetivoCOP;
      const oblUSD  = esUSD ? Math.round(objetivoCOP / trm * 100) / 100 : 0;
      const plan = planCascada(loan, antes, esUSD
        ? { obligacionUSD: oblUSD, cajaCOP: cajaCOP, obligacionCOP: 0 }
        : { obligacionCOP: objetivoCOP, cajaCOP: cajaCOP, obligacionUSD: 0 });
      R.check(et + (obj.modo === 'parcial'
          ? 'ANTI-VACIO: el plan es UN parcial que no salda la cuota'
          : 'ANTI-VACIO: el plan mezcla mora y abono (el recibo debe explicar los dos)'),
        plan.ok && (obj.modo === 'parcial'
          ? (plan.pasos.length === 1 && plan.pasos[0].tipo === 'partial' && !plan.pasos[0].salda)
          : (plan.pasos.some(p => p.tipo === 'partial') && plan.pasos.some(p => p.tipo === 'abono'))),
        (plan.error || '') + ' | ' + plan.pasos.map(p => p.tipo + (p.salda ? '(salda)' : '')).join(' -> '));
      if (!plan.ok) continue;

      // Snapshot PREVIO, replica de `_snapshotAbono` (app.js): es lo que el recibo
      // imprime tachado como "antes".
      const lpAntes   = antes.filter(p => p.prestamoId === loan.id);
      const pendAntes = lpAntes.filter(p => !esAbono(p) && p.estadoPago === 'Pendiente').sort((a, b) => a.cuotaN - b.cuotaN);
      const pre = { saldoCaja: saldoConCaja(loan, lpAntes), cuota: pendAntes.length ? pendAntes[0].cuotaTotal : 0 };

      const est = await ejecutarPlan(loan.id, plan, hoy, 'test recibo', PORT_G);
      R.check(et + 'la cascada se aplico contra el motor real', est.ok, est.error || '');
      if (!est.ok) continue;

      const post = cargarG();
      const loanPost = post.loans.find(l => l.id === loan.id);
      const lpPost = post.pays.filter(p => p.prestamoId === loan.id);
      pdfs.length = 0;
      // Se alimenta de `est.hechos` — lo APLICADO, nunca de `plan.pasos`.
      generateReciboCobro(loanPost, post.pays, { fecha: hoy, pasos: est.hechos, pre: pre, observaciones: 'test recibo' });
      R.eq(et + 'se emitio exactamente un documento', pdfs.length, 1);
      if (pdfs.length !== 1) continue;
      const html = pdfs[0].html;
      recibosVerificados++;
      // Se deriva de lo APLICADO (est.hechos), no del plan: son iguales en exito, pero la
      // regla del documento es "lo aplicado" y el test la respeta igual.
      const esperaCapMora = est.hechos.filter(p => p.tipo === 'partial').reduce((s, p) => s + p.capital, 0) > 0;

      // 1. EL HERO DECLARA LO QUE EL CLIENTE ENTREGO.
      if (esUSD) {
        // En USD el protagonista es el dolar, y los pesos van en la sub-linea: son la
        // CAJA, y tienen que cuadrar al peso o "Cobros del Mes" queda descuadrado.
        R.check(et + 'el hero declara los dolares entregados',
          Math.abs(numDe(heroDe(html)) - oblUSD) <= 0.05,
          'hero=' + heroDe(html) + ' esperado=' + oblUSD);
        R.eq(et + 'la sub-linea declara la caja en pesos, exacta', numDe(heroSub(html)), cajaCOP);
      } else {
        R.eq(et + 'el hero declara la caja recibida, exacta', numDe(heroDe(html)), cajaCOP);
      }

      // 2. IDENTIDAD DEL DESGLOSE, en la moneda visible (Bug #31).
      const filas = filasPanel(html);
      const fila = lab => filas.find(x => x.lab === lab);
      const val  = lab => { const f = fila(lab); return f ? numDe(f.val) : 0; };
      const totalDoc = val('Total aplicado');
      const sumaRubros = val('Intereses vencidos') + val('Capital de cuotas vencidas') + val('Abono extraordinario a capital');
      R.eq(et + 'intereses + capital de mora + abono == total aplicado',
        esUSD ? Math.round(sumaRubros * 100) / 100 : Math.round(sumaRubros), totalDoc);
      // El aserto anterior es NECESARIO pero no suficiente: el generador calcula el total
      // COMO la suma de los rubros, asi que se cumple solo. Este es el que ata el papel al
      // dinero — el total declarado tiene que ser la obligacion que de verdad se extinguio.
      const oblAplicada = est.hechos.reduce((s, p) => s + Math.round(p.obligacionCOP), 0);
      R.eq(et + 'el total declarado == la obligacion realmente extinguida',
        totalDoc, esUSD ? Math.round(oblAplicada / trm * 100) / 100 : oblAplicada);

      // 3. CADA RUBRO APARECE SI Y SOLO SI ESTE COBRO LO TIENE.
      // La expectativa se DERIVA de los pasos aplicados, no se cablea: un rubro en cero
      // impreso como "$0" confundiria al deudor, y uno omitido teniendo valor le
      // escondería a donde fue su dinero. Los tres casos se dan de verdad en este bucle:
      // sin capital en la mora (modalidad Intereses) y sin intereses (cuota cuyo interes
      // ya lo cobro el parcial del objetivo anterior).
      const espera = {
        'Intereses vencidos':             est.hechos.reduce((s, p) => s + p.interes, 0) > 0,
        'Capital de cuotas vencidas':     esperaCapMora,
        'Abono extraordinario a capital': est.hechos.filter(p => p.tipo === 'abono').length > 0,
      };
      Object.keys(espera).forEach(lab => {
        const hay = !!fila(lab);
        rubrosVistos[lab] = rubrosVistos[lab] || (hay && val(lab) > 0);
        R.check(et + (espera[lab] ? ('declara "' + lab + '"')
                                  : ('omite "' + lab + '" en vez de imprimir un cero')),
          espera[lab] ? (hay && val(lab) > 0) : !hay,
          filas.map(f => f.lab).join(' | '));
      });

      if (esUSD) {
        R.eq(et + 'la caja en pesos tambien se declara en el desglose',
          numDe((fila('Caja registrada en pesos') || {}).val), cajaCOP);
      }

      // 4. EL SALDO IMPRESO ES EL QUE MUESTRA LA APP (nunca el del motor).
      const cards = tarjetas(html);
      const cSaldo = cards.find(c => c.lab === 'Saldo de capital');
      R.check(et + 'el recibo imprime el saldo resultante', !!cSaldo, cards.map(c => c.lab).join(' | '));
      if (cSaldo) {
        const saldoApp = saldoConCaja(loanPost, lpPost);
        // Saldo del MOTOR, la formula canonica. Con un parcial en vuelo los dos numeros
        // DIFIEREN, y ahi es donde el check muerde: sin este anti-trivial, imprimir el del
        // motor pasaria igual y la doctrina v2.3.0 quedaria sin verificar.
        const origCOP = esUSD ? Math.round(loanPost.montoOrigen * trm) : Math.round(loanPost.montoOrigen);
        const saldoMotor = Math.max(0, origCOP - Math.round(lpPost.filter(p => p.estadoPago === 'Pagado')
          .reduce((s, p) => s + p.abonoCapital, 0)));
        if (obj.modo === 'parcial') {
          R.check(et + 'ANTI-TRIVIAL: con el parcial en vuelo, el saldo con caja NO es el del motor',
            saldoApp !== saldoMotor, 'conCaja=' + saldoApp + ' motor=' + saldoMotor);
        }
        R.eq(et + 'el saldo del recibo == saldoConCaja de la app',
          numDe(cSaldo.val), esUSD ? Math.round(saldoApp / trm * 100) / 100 : Math.round(saldoApp));
      }

      // 5. UNA FILA POR MOVIMIENTO APLICADO.
      R.eq(et + 'el recibo lista tantos movimientos como se aplicaron',
        (html.match(/<div class="rc-paso">/g) || []).length, est.hechos.length);
    }
    // ── El borde del Bug #31, forzado a proposito ─────────────────────────────
    // En USD, redondear cada rubro por separado y sumarlos NO siempre da lo mismo que
    // redondear el total: 363.25 + 96.74 = 459.99, no 460.00. Por eso el generador ancla
    // el capital al total (capital = obligacion - interes) en vez de convertir rubro a
    // rubro. Con los importes que hay hoy en la cartera esa colision puede no darse nunca
    // —se comprobo: cambiar el anclaje por una conversion rubro a rubro dejaba las tres
    // objetivos en verde—, asi que aqui se BUSCA una combinacion que colisione de verdad
    // y se comprueba que el documento la resuelve.
    //
    // El aserto que muerde no es "los rubros suman el total" (eso es tautologico: el
    // generador calcula el total como la suma de los rubros), sino "el total declarado es
    // la obligacion que de verdad se extinguio". Ahi es donde una reconciliacion mal hecha
    // se separa del dinero.
    {
      const loanU = capInt;
      if (loanU) {
        const trmU = +loanU.trmAcordada || 1;
        const cent = n => Math.round(n / trmU * 100);
        let I = 0, K = 0;
        buscar:
        for (let i = 100000; i < 100400 && !I; i++) {
          for (let k = 200000; k < 200400; k++) {
            if (cent(i) + cent(k) !== cent(i + k)) { I = i; K = k; break buscar; }
          }
        }
        R.check('G ANTI-VACIO: se hallo un reparto donde el redondeo en dolares colisiona',
          I > 0, 'interes=' + I + ' capital=' + K + ' trm=' + trmU +
          ' | rubros=' + (cent(I) + cent(K)) + ' vs total=' + cent(I + K));
        if (I > 0) {
          const post = cargarG();
          const loanPost = post.loans.find(l => l.id === loanU.id);
          const pasoSint = {
            tipo: 'partial', payId: 'sintetico', cuotaN: 1, fechaPago: hoy,
            obligacionCOP: I + K, obligacionUSD: Math.round((I + K) / trmU * 100) / 100,
            interes: I, capital: K, salda: false, restanteCuota: 0, cajaCOP: I + K,
          };
          pdfs.length = 0;
          generateReciboCobro(loanPost, post.pays,
            { fecha: hoy, pasos: [pasoSint], pre: { saldoCaja: 0, cuota: 0 } });
          R.eq('G (borde #31) se emitio el documento', pdfs.length, 1);
          if (pdfs.length === 1) {
            const filasB = filasPanel(pdfs[0].html);
            const valB = lab => { const f = filasB.find(x => x.lab === lab); return f ? numDe(f.val) : 0; };
            R.eq('G (borde #31) el total declarado == la obligacion extinguida',
              valB('Total aplicado'), Math.round((I + K) / trmU * 100) / 100);
            R.eq('G (borde #31) intereses + capital == total, sin perder el centavo',
              Math.round((valB('Intereses vencidos') + valB('Capital de cuotas vencidas')) * 100) / 100,
              valB('Total aplicado'));
          }
        }
      }
    }

    R.check('G ANTI-VACIO: se verificaron los tres recibos', recibosVerificados === 3,
      'recibos verificados=' + recibosVerificados);
    R.check('G ANTI-VACIO: los tres rubros del desglose se ejercitaron con valor',
      ['Intereses vencidos', 'Capital de cuotas vencidas', 'Abono extraordinario a capital']
        .every(k => rubrosVistos[k]),
      JSON.stringify(rubrosVistos));
    srvG.close();
  }

  srv.close();
  process.exit(R.finalizar());
})().catch(e => {
  console.error('\n[cascada-cobro] ABORTADO — el arnes no pudo ejecutarse:');
  console.error(e && e.stack ? e.stack : e);
  process.exit(1);
});
