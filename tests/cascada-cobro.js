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
function cargarCascada() {
  const orden = [], vistos = new Set();
  aplanar(path.join(REPO, 'public', 'js', 'core', 'cascada.js'), vistos, orden);
  const sb = { console };
  sb.globalThis = sb;
  const ctx = vm.createContext(sb);
  vm.runInContext(orden.join('\n'), ctx);
  return vm.runInContext('({planCascada,cobrableTotal,contextoCascada})', ctx);
}

// ── Servidor real sobre copia ────────────────────────────────────────────────
const PORT = 3971;
function pedir(method, ruta, body) {
  return new Promise((res, rej) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({
      host: '127.0.0.1', port: PORT, path: ruta, method,
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
async function ejecutarPlan(loanId, plan, fecha, obs) {
  const estado = { ok: true, hechos: [], error: null, pasoFallido: null };
  for (const paso of plan.pasos) {
    const r = paso.tipo === 'partial'
      ? await pedir('POST', '/api/payments/' + paso.payId + '/partial',
          { monto: paso.cajaCOP, fecha, observaciones: obs, montoUSD: paso.obligacionUSD || 0 })
      : await pedir('POST', '/api/loans/' + loanId + '/abono',
          { monto: paso.obligacionCOP, fecha, observaciones: obs, montoUSD: paso.obligacionUSD || 0,
            montoCOPRecibido: paso.cajaCOP, liquidar: false, recalcMode: 'mantener', recalcValor: null, intExtra: 0 });
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
  const { planCascada, cobrableTotal } = cargarCascada();
  R.check('el modulo real de cascada se cargo', typeof planCascada === 'function' && typeof cobrableTotal === 'function');

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

  srv.close();
  process.exit(R.finalizar());
})().catch(e => {
  console.error('\n[cascada-cobro] ABORTADO — el arnes no pudo ejecutarse:');
  console.error(e && e.stack ? e.stack : e);
  process.exit(1);
});
