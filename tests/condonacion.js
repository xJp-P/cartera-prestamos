// tests/condonacion.js — CONDONACION DE INTERESES contra el server REAL.
//
// El escenario que motiva el endpoint: "devuelveme el capital y te perdono los
// intereses". Antes de v2.9.0 no habia herramienta y los tres caminos disponibles
// mentian de formas distintas — el peor, `Liquidar`, FABRICA CAJA: registra como
// recibido el interes que se perdono. Esta suite fija que la via nueva no lo haga.
//
// Que se verifica, en orden de importancia:
//   1. CAJA CERO. Una condonacion no puede producir ni un evento de flujo. Es la
//      propiedad central: si la produjera, seria el mismo defecto que se vino a
//      corregir, solo que por otro camino.
//   2. La OBLIGACION baja y el CAPITAL no se toca (interes -> 0, cuotaTotal ->
//      capital), con la invariante `interes + capital == cuota` intacta.
//   3. El ESCENARIO COMPLETO: condonar -> cobrar el capital -> el credito cierra
//      como 'Finalizado' (no 'Cancelado'), con capital recuperado == prestado y la
//      caja registrada == exactamente lo que entro.
//   4. Los 4xx dejan la BD INTACTA (doctrina de atomicidad).
//   5. El undo restaura el interes condonado byte a byte.
//
// Se ejecuta:
//   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron tests/condonacion.js

const fs   = require('fs');
const vm   = require('vm');
const path = require('path');
const http = require('http');
const { Reporter }          = require('./lib/report');
const { copiaDeProduccion } = require('./lib/db');
const { REPO }              = require('./lib/paths');

const R = new Reporter('condonacion');
const PORT = 3974;   // NUNCA 3420 (la app real) ni 3971-3973 (cascada-cobro)

// ── Modulos reales del frontend que hacen falta para medir ───────────────────
// `cobrosDe` es la fuente de verdad del flujo de caja en TODA la app (KPI, grafico,
// transacciones y panel del deudor). Se carga el REAL en vez de replicarlo: si el
// helper cambiara, la propiedad 1 tiene que seguir midiendo lo que la app muestra.
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
function cargarDominio() {
  const orden = [], vistos = new Set();
  aplanar(path.join(REPO, 'public', 'js', 'core', 'dominio.js'), vistos, orden);
  aplanar(path.join(REPO, 'public', 'js', 'core', 'cascada.js'), vistos, orden);
  const sb = { console };
  sb.globalThis = sb;
  const ctx = vm.createContext(sb);
  vm.runInContext(orden.join('\n'), ctx);
  return vm.runInContext('({cobrosDe,imputarCobros,saldoConCaja,planCascada,cobrableTotal})', ctx);
}

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

(async function main() {
  const { cobrosDe, saldoConCaja, planCascada, cobrableTotal } = cargarDominio();
  R.check('los helpers reales del frontend se cargaron',
    typeof cobrosDe === 'function' && typeof saldoConCaja === 'function' && typeof planCascada === 'function');

  const DB = copiaDeProduccion('condonacion');
  const app = require(path.join(REPO, 'backend', 'server.js'))(DB);
  const srv = http.createServer(app);
  await new Promise(ok => srv.listen(PORT, '127.0.0.1', ok));

  const Database = require(path.join(REPO, 'node_modules', 'better-sqlite3'));
  const conDb = fn => { const d = new Database(DB, { readonly: true }); try { return fn(d); } finally { d.close(); } };
  const cargar = () => ({
    loans: conDb(d => d.prepare('SELECT * FROM loans').all()),
    pays:  conDb(d => d.prepare('SELECT * FROM payments').all()),
  });
  const esAbono = p => p.id.indexOf('-ab-') !== -1;
  const hoy = new Date().toISOString().slice(0, 10);
  await pedir('GET', '/api/payments');   // auto-mora, como en la app real

  // Caja TOTAL de un prestamo segun `cobrosDe` (la misma que ve el usuario).
  const cajaDe = (pays, loanId) => pays.filter(p => p.prestamoId === loanId)
    .reduce((s, p) => s + cobrosDe(p).reduce((a, e) => a + e.cop, 0), 0);
  const moraDe = (pays, loanId) => pays.filter(p =>
    p.prestamoId === loanId && p.estadoPago === 'En Mora' && !esAbono(p));
  const origDe = l => l.moneda === 'USD'
    ? Math.round(l.montoOrigen * l.trmAcordada) : Math.round(l.montoOrigen);

  // ── A — MODALIDAD INTERESES: la mora es puro interes ──────────────────────
  R.seccion('A — Intereses: condonar apaga la mora entera y no mueve un peso de caja');
  let loanA = null;
  {
    const { loans, pays } = cargar();
    loanA = loans.filter(l => l.estado === 'Activo' && l.modalidad === 'Intereses')
                 .filter(l => moraDe(pays, l.id).length > 0)[0];
    R.check('A ANTI-VACIO: hay un credito Intereses con mora', !!loanA, loanA ? loanA.id : 'NINGUNO');
    if (loanA) {
      const moraAntes = moraDe(pays, loanA.id);
      const intAntes  = Math.round(moraAntes.reduce((s, p) => s + p.interesPeriodo, 0));
      const cajaAntes = cajaDe(pays, loanA.id);
      const saldoAntes = saldoConCaja(loanA, pays.filter(p => p.prestamoId === loanA.id));
      R.check('A ANTI-VACIO: hay intereses en mora que condonar', intAntes > 0,
        moraAntes.length + ' cuotas, $' + intAntes);

      const r = await pedir('POST', '/api/loans/' + loanA.id + '/condonar-intereses', {});
      R.eq('A el endpoint acepta la condonacion', r.status, 200);
      R.eq('A informa exactamente el interes condonado', Math.round(r.json.condonado || 0), intAntes);

      const post = cargar();
      const lPost = post.loans.find(l => l.id === loanA.id);
      const lpPost = post.pays.filter(p => p.prestamoId === loanA.id);
      const tocadas = lpPost.filter(p => moraAntes.some(m => m.id === p.id));

      R.eq('A el interes de esas cuotas quedo en 0',
        tocadas.filter(p => Math.round(p.interesPeriodo) !== 0).length, 0);
      R.eq('A su cuotaTotal bajo al capital (que en Intereses es 0)',
        tocadas.filter(p => Math.round(p.cuotaTotal) !== Math.round(p.abonoCapital)).length, 0);
      R.eq('A sin nada que cobrar, su estado terminal es Pagado',
        tocadas.filter(p => p.estadoPago !== 'Pagado').length, 0);
      R.eq('A ya no queda ninguna cuota En Mora', moraDe(post.pays, loanA.id).length, 0);

      // ── LA PROPIEDAD CENTRAL ──
      R.eq('A CAJA CERO: la condonacion no produjo ningun evento de flujo',
        cajaDe(post.pays, loanA.id), cajaAntes);
      R.eq('A ninguna cuota condonada emite evento de caja',
        tocadas.reduce((s, p) => s + cobrosDe(p).length, 0), 0);

      R.eq('A el capital no se movio',
        saldoConCaja(lPost, lpPost), saldoAntes);
      R.eq('A se acumulo en interesesCondonados', Math.round(lPost.interesesCondonados || 0), intAntes);
      R.check('A el credito sigue Activo: el capital todavia se debe',
        lPost.estado === 'Activo' || saldoAntes === 0,
        'estado=' + lPost.estado + ' saldo=' + saldoAntes);
    }
  }

  // ── B — EL ESCENARIO COMPLETO: condonar y cobrar el capital ───────────────
  R.seccion('B — escenario completo: tras condonar, el capital cierra el credito como Finalizado');
  {
    if (loanA) {
      const { loans, pays } = cargar();
      const l = loans.find(x => x.id === loanA.id);
      const lp = pays.filter(p => p.prestamoId === l.id);
      const capitalPend = saldoConCaja(l, lp);
      const cajaAntes = cajaDe(pays, l.id);
      R.check('B ANTI-VACIO: queda capital por cobrar', capitalPend > 0, '$' + capitalPend);

      if (capitalPend > 0) {
        // Se cobra por la via NORMAL — el cobro en cascada —, que es justo lo que
        // hace valiosa a la Opcion C: despues de condonar no hace falta nada especial.
        const plan = planCascada(l, pays, { obligacionCOP: capitalPend, cajaCOP: capitalPend, obligacionUSD: 0 });
        R.check('B el plan es un unico abono (ya no hay mora que cobrar)',
          plan.ok && plan.pasos.length === 1 && plan.pasos[0].tipo === 'abono',
          (plan.error || '') + ' | ' + plan.pasos.map(p => p.tipo).join(' -> '));

        for (const paso of plan.pasos) {
          const rr = await pedir('POST', '/api/loans/' + l.id + '/abono', {
            monto: paso.obligacionCOP, fecha: hoy, observaciones: 'test condonacion',
            montoUSD: 0, montoCOPRecibido: paso.cajaCOP, liquidar: false,
            recalcMode: 'mantener', recalcValor: null, intExtra: 0 });
          R.eq('B el cobro del capital se aplico', rr.status, 200);
        }

        const post = cargar();
        const lPost = post.loans.find(x => x.id === l.id);
        const lpPost = post.pays.filter(p => p.prestamoId === l.id);

        R.eq('B el credito quedo FINALIZADO (no Cancelado, que seria "perdida total")',
          lPost.estado, 'Finalizado');
        R.eq('B no queda saldo de capital', saldoConCaja(lPost, lpPost), 0);
        const capRecuperado = Math.round(lpPost.filter(p => p.estadoPago === 'Pagado')
          .reduce((s, p) => s + p.abonoCapital, 0));
        R.eq('B el capital recuperado es EXACTAMENTE el prestado', capRecuperado, origDe(lPost));
        // El corazon del escenario: `Liquidar` habria declarado tambien el interes.
        R.eq('B la caja registrada es exactamente el capital que entro',
          cajaDe(post.pays, l.id) - cajaAntes, capitalPend);
      }
    }
  }

  // ── C — CAPITAL + INTERESES: el capital de la mora SIGUE debiendose ───────
  R.seccion('C — Capital + Intereses: se perdona el interes, el capital sigue vivo');
  {
    const { loans, pays } = cargar();
    const l = loans.filter(x => x.estado === 'Activo' && x.modalidad === 'Capital + Intereses')
                   .filter(x => moraDe(pays, x.id).some(p => p.abonoCapital > 0))[0];
    R.check('C ANTI-VACIO: hay un C+I con capital dentro de la mora', !!l, l ? l.id : 'NINGUNO');
    if (l) {
      const moraAntes = moraDe(pays, l.id);
      const intAntes  = Math.round(moraAntes.reduce((s, p) => s + p.interesPeriodo, 0));
      const capMora   = Math.round(moraAntes.reduce((s, p) => s + p.abonoCapital, 0));
      const cajaAntes = cajaDe(pays, l.id);
      const saldoAntes = saldoConCaja(l, pays.filter(p => p.prestamoId === l.id));

      const r = await pedir('POST', '/api/loans/' + l.id + '/condonar-intereses', {});
      R.eq('C el endpoint acepta la condonacion', r.status, 200);
      R.eq('C informa el interes condonado', Math.round(r.json.condonado || 0), intAntes);
      R.eq('C informa el capital que sigue en mora', Math.round(r.json.capitalEnMora || 0), capMora);

      const post = cargar();
      const lpPost = post.pays.filter(p => p.prestamoId === l.id);
      const tocadas = lpPost.filter(p => moraAntes.some(m => m.id === p.id));

      R.eq('C el interes quedo en 0', tocadas.filter(p => Math.round(p.interesPeriodo) !== 0).length, 0);
      R.eq('C la cuota ahora vale exactamente su capital',
        tocadas.filter(p => Math.round(p.cuotaTotal) !== Math.round(p.abonoCapital)).length, 0);
      R.check('C las cuotas con capital SIGUEN En Mora (el capital no se perdona)',
        tocadas.filter(p => p.abonoCapital > 0).every(p => p.estadoPago === 'En Mora'),
        tocadas.map(p => '#' + p.cuotaN + ':' + p.estadoPago).join(' '));
      R.eq('C CAJA CERO tambien aqui', cajaDe(post.pays, l.id), cajaAntes);
      // El saldo del MOTOR (origCOP - capital de las Pagadas) es el que gobierna las
      // DECISIONES: techo del abono y valor de liquidacion. `saldoConCaja` no sirve para
      // vigilar esto — imputa por `partialPaid`, asi que marcar Pagado una cuota sin
      // dinero encima lo deja igual mientras el motor SI da el capital por recuperado.
      // Verificado inyectando esa regresion: `saldoConCaja` seguia en verde.
      const motorAntes = origDe(l) - Math.round(pays.filter(p => p.prestamoId === l.id &&
        p.estadoPago === 'Pagado').reduce((s, p) => s + p.abonoCapital, 0));
      const motorPost = origDe(l) - Math.round(lpPost.filter(p => p.estadoPago === 'Pagado')
        .reduce((s, p) => s + p.abonoCapital, 0));
      R.eq('C el saldo del MOTOR tampoco se movio (el capital no se da por recuperado)',
        motorPost, motorAntes);
      R.eq('C el saldo de capital no se movio',
        saldoConCaja(post.loans.find(x => x.id === l.id), lpPost), saldoAntes);
      // La invariante se mide sobre las filas QUE LA CONDONACION ESCRIBIO. Medirla sobre
      // todo el credito daria rojo por datos legacy: el fixture arrastra 7 filas Pagadas
      // con +-1 peso, residuo del Bug #43 anterior a la aritmetica de enteros de v2.2.0.
      // Ese ruido no lo introduce este endpoint y taparlo con una tolerancia esconderia
      // justo lo que si hay que vigilar, asi que ademas se comprueba que el CONJUNTO de
      // filas rotas no crecio.
      R.eq('C invariante interes + capital == cuota en las filas condonadas',
        tocadas.filter(p => Math.round(p.interesPeriodo) + Math.round(p.abonoCapital) !== Math.round(p.cuotaTotal)).length, 0);
      const rotasAntes = pays.filter(p => p.prestamoId === l.id && !esAbono(p) &&
        Math.round(p.interesPeriodo) + Math.round(p.abonoCapital) !== Math.round(p.cuotaTotal)).map(p => p.id).sort();
      const rotasPost = lpPost.filter(p => !esAbono(p) &&
        Math.round(p.interesPeriodo) + Math.round(p.abonoCapital) !== Math.round(p.cuotaTotal)).map(p => p.id).sort();
      R.eq('C la condonacion no rompio la invariante en ninguna fila nueva', rotasPost, rotasAntes);

      // La cascada ahora ve solo capital: es el efecto que hace cobrable el acuerdo.
      const cob = cobrableTotal(post.loans.find(x => x.id === l.id), post.pays);
      R.eq('C lo que queda por cobrar de la mora es solo el capital', Math.round(cob.mora), capMora);
    }
  }

  // ── D — SELECCION POR CUOTA ───────────────────────────────────────────────
  R.seccion('D — se puede condonar solo algunas cuotas vencidas');
  {
    const { loans, pays } = cargar();
    const l = loans.filter(x => x.estado === 'Activo' &&
                 ['Intereses', 'Capital + Intereses'].indexOf(x.modalidad) !== -1)
               .filter(x => moraDe(pays, x.id).filter(p => p.interesPeriodo > 0).length >= 2)[0];
    R.check('D ANTI-VACIO: hay un credito con 2+ cuotas vencidas con interes', !!l, l ? l.id : 'NINGUNO');
    if (l) {
      const mora = moraDe(pays, l.id).filter(p => p.interesPeriodo > 0);
      const elegida = mora[0];
      const intactas = mora.slice(1);
      const r = await pedir('POST', '/api/loans/' + l.id + '/condonar-intereses', { cuotas: [elegida.id] });
      R.eq('D el endpoint acepta la seleccion parcial', r.status, 200);
      R.eq('D condona solo el interes de la cuota elegida',
        Math.round(r.json.condonado || 0), Math.round(elegida.interesPeriodo));

      const post = cargar().pays.filter(p => p.prestamoId === l.id);
      R.eq('D la cuota elegida quedo sin interes',
        Math.round(post.find(p => p.id === elegida.id).interesPeriodo), 0);
      R.eq('D las NO elegidas conservan su interes intacto',
        intactas.filter(m => Math.round(post.find(p => p.id === m.id).interesPeriodo) !== Math.round(m.interesPeriodo)).length, 0);
    }
  }

  // ── E — RECHAZOS: 4xx con la BD INTACTA ───────────────────────────────────
  R.seccion('E — los rechazos dejan la base de datos intacta');
  {
    const antes = cargar();
    const huella = JSON.stringify(antes.pays.map(p => [p.id, p.interesPeriodo, p.cuotaTotal, p.estadoPago]));

    const r404 = await pedir('POST', '/api/loans/no-existe/condonar-intereses', {});
    R.eq('E id inexistente -> 404', r404.status, 404);

    const prestamo = antes.loans.filter(l => l.estado === 'Activo' && l.modalidad === 'Prestamo')[0];
    if (prestamo) {
      const r = await pedir('POST', '/api/loans/' + prestamo.id + '/condonar-intereses', {});
      R.eq('E modalidad Prestamo (0%) -> 4xx', Math.floor(r.status / 100), 4);
      R.check('E y lo explica: no genera intereses', /0%|intereses/i.test(r.json.error || ''), r.json.error);
    }
    const pagoUnico = antes.loans.filter(l => l.estado === 'Activo' && l.modalidad === 'Pago Unico')[0];
    if (pagoUnico) {
      const r = await pedir('POST', '/api/loans/' + pagoUnico.id + '/condonar-intereses', {});
      R.eq('E modalidad Pago Unico -> 4xx', Math.floor(r.status / 100), 4);
    }
    const finalizado = antes.loans.filter(l => l.estado !== 'Activo')[0];
    if (finalizado) {
      const r = await pedir('POST', '/api/loans/' + finalizado.id + '/condonar-intereses', {});
      R.eq('E credito no activo -> 4xx', Math.floor(r.status / 100), 4);
    }
    const sinMora = antes.loans.filter(l => l.estado === 'Activo' &&
        ['Intereses', 'Capital + Intereses'].indexOf(l.modalidad) !== -1 &&
        moraDe(antes.pays, l.id).length === 0)[0];
    if (sinMora) {
      const r = await pedir('POST', '/api/loans/' + sinMora.id + '/condonar-intereses', {});
      R.eq('E sin cuotas en mora -> 4xx', Math.floor(r.status / 100), 4);
    }
    // Id de cuota ajeno: no puede colarse aunque el cliente lo mande.
    const conMora = antes.loans.filter(l => l.estado === 'Activo' &&
        ['Intereses', 'Capital + Intereses'].indexOf(l.modalidad) !== -1 &&
        moraDe(antes.pays, l.id).length > 0)[0];
    if (conMora) {
      const r = await pedir('POST', '/api/loans/' + conMora.id + '/condonar-intereses',
        { cuotas: ['cuota-inventada-999'] });
      R.eq('E id de cuota ajeno -> 4xx', Math.floor(r.status / 100), 4);
      R.check('E y nombra la cuota rechazada', /cuota-inventada-999/.test(r.json.error || ''), r.json.error);
    }

    const despues = cargar();
    R.eq('E ANTI-REGRESION: ningun rechazo escribio en la BD',
      JSON.stringify(despues.pays.map(p => [p.id, p.interesPeriodo, p.cuotaTotal, p.estadoPago])), huella);
  }

  // ── F — UNDO: la condonacion es reversible ────────────────────────────────
  R.seccion('F — deshacer restaura el interes condonado');
  {
    const { loans, pays } = cargar();
    const l = loans.filter(x => x.estado === 'Activo' &&
                 ['Intereses', 'Capital + Intereses'].indexOf(x.modalidad) !== -1)
               .filter(x => moraDe(pays, x.id).filter(p => p.interesPeriodo > 0).length > 0)[0];
    R.check('F ANTI-VACIO: queda un credito con interes en mora para revertir', !!l, l ? l.id : 'NINGUNO');
    if (l) {
      const antes = JSON.stringify(cargar().pays.filter(p => p.prestamoId === l.id)
        .map(p => [p.id, p.interesPeriodo, p.cuotaTotal, p.estadoPago, p.fechaRecaudo]).sort());
      const r = await pedir('POST', '/api/loans/' + l.id + '/condonar-intereses', {});
      R.eq('F la condonacion se aplico', r.status, 200);
      R.check('F devuelve el undoId del journal', !!r.json.undoId, JSON.stringify(r.json.undoId));

      const entradas = await pedir('GET', '/api/undo?scopeTipo=loan&scopeId=' + l.id);
      const head = (entradas.json || []).filter(e => e.estado === 'disponible')[0];
      R.eq('F la condonacion es el head LIFO de ese credito', head && head.accion, 'condonacion');
      R.eq('F se marca como que NO afecta caja (sin falsa alarma de recibo)',
        head && head.afecta_caja, 0);

      const und = await pedir('POST', '/api/undo/' + r.json.undoId, {});
      R.eq('F el undo se acepta', und.status, 200);
      const despues = JSON.stringify(cargar().pays.filter(p => p.prestamoId === l.id)
        .map(p => [p.id, p.interesPeriodo, p.cuotaTotal, p.estadoPago, p.fechaRecaudo]).sort());
      R.eq('F el cronograma volvio EXACTAMENTE a su estado previo', despues, antes);
      R.eq('F interesesCondonados volvio a su valor previo',
        Math.round(cargar().loans.find(x => x.id === l.id).interesesCondonados || 0),
        Math.round(l.interesesCondonados || 0));
    }
  }

  srv.close();
  process.exit(R.finalizar());
})().catch(e => {
  console.error('\n[condonacion] ABORTADO — el arnes no pudo ejecutarse:');
  console.error(e && e.stack ? e.stack : e);
  process.exit(2);
});
