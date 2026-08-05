// tests/motor-diario.js — INVARIANTES DEL MOTOR DE INTERES DIARIO.
//
// Que es esto: no verifica "casos de ejemplo", verifica PROPIEDADES que deben
// cumplirse para toda combinacion de (fecha de inicio, tasa, capital, cortes,
// fecha de consulta). Los pocos casos con numeros a mano que hay estan para fijar
// el CONTRATO —cuanto devenga exactamente el credito del fixture, que pasa el dia
// de un abono— y para que un cambio de doctrina se vea como un fallo, no como un
// numero distinto que nadie mira.
//
// POR QUE ES SU PROPIO SUITE Y NO PARTE DE OTRO
// `devengoDiario` es matematica PURA de backend: no toca la BD, ni Express, ni el
// frontend. `props-dominio` carga el frontend, `e2e-api` levanta el servidor —
// meter esto ahi obligaria a arrancar maquinaria que este codigo no necesita, y a
// que un fallo de setup se confundiera con un fallo de la matematica. Aqui, si
// algo falla, el numero esta mal y punto.
//
// Corre sin Electron (no hay better-sqlite3 de por medio), pero run-all.js lo
// lanza igual bajo ELECTRON_RUN_AS_NODE por uniformidad.

const { Reporter } = require('./lib/report');
const E = require('../backend/core/engine');

const R = new Reporter('motor-diario');

// Prestamo base de los casos con numeros a mano: 1.000.000 al 3% mensual.
// Con la convencion del proyecto (dias reales / 30) eso es 1.000 COP por dia, que
// hace la aritmetica comprobable de cabeza y los fallos legibles.
const L = (over) => Object.assign({
  id: 'D1', nombre: 'Prueba', moneda: 'COP', montoOrigen: 1000000, trmAcordada: 1,
  tasaMensual: 3, modalidad: E.MODALIDAD_DIARIA, fechaInicio: '2026-07-01', plazoMeses: 0,
}, over || {});

const ct = (n, fecha, interes, abono) => ({
  id: 'D1-ct-' + n, prestamoId: 'D1', cuotaN: n, fechaPago: fecha,
  interesPeriodo: interes, abonoCapital: abono, cuotaTotal: interes + abono,
  estadoPago: 'Pagado',
});

function main() {
  // ── 0 — anti-vacio ─────────────────────────────────────────────────────────
  R.seccion('0. El instrumental existe (si no, todo lo demas seria verde en vacio)');
  const NECESARIOS = ['devengoDiario', 'diasEntre', 'interesDeTramo', 'sumarDias', 'MODALIDAD_DIARIA'];
  const faltan = NECESARIOS.filter(n => E[n] === undefined);
  R.check(`el motor exporta los ${NECESARIOS.length} simbolos del devengo`, faltan.length === 0,
    faltan.length ? 'faltan: ' + faltan.join(', ') : undefined);
  if (faltan.length) return R.finalizar();

  // ── 1 — el contrato, con numeros a mano ────────────────────────────────────
  R.seccion('1. El credito del fixture: el motor reproduce sus cifras exactas');
  {
    const cortes = [ct(1, '2026-07-16', 15000, 0), ct(2, '2026-07-31', 15000, 400000)];
    const r = E.devengoDiario(L(), cortes, '2026-07-31');
    R.eq('tramo 1 = 15 dias', r.tramos[0].dias, 15);
    R.eq('tramo 1 devenga 15.000', r.tramos[0].interes, 15000);
    R.eq('tramo 2 = 15 dias', r.tramos[1].dias, 15);
    R.eq('tramo 2 mantiene la base: el corte 1 fue de SOLO INTERES', r.tramos[1].base, 1000000);
    R.eq('capital vivo tras el abono = 600.000', r.capitalVivo, 600000);
    R.eq('devengado == cobrado -> no debe intereses', r.interesPendiente, 0);
  }

  // ── 2 — creacion retroactiva ───────────────────────────────────────────────
  R.seccion('2. Creacion RETROACTIVA: no es un caso especial, es un tramo largo');
  {
    const loan = L({ fechaInicio: '2026-07-21' });
    const r = E.devengoDiario(loan, [], '2026-08-05');
    R.eq('un unico tramo abierto', r.tramos.length, 1);
    R.eq('15 dias devengados desde el inicio', r.tramos[0].dias, 15);
    R.eq('interes acumulado = 15.000', r.interesPendiente, 15000);
    R.eq('el capital no se ha tocado', r.capitalVivo, 1000000);
    // Y el dia siguiente suma exactamente un dia: el devengo "sigue corriendo".
    const r2 = E.devengoDiario(loan, [], '2026-08-06');
    R.eq('el dia siguiente suma exactamente 1.000', r2.interesPendiente - r.interesPendiente, 1000);
  }

  // ── 3 — el abono mueve la base ─────────────────────────────────────────────
  R.seccion('3. Un abono a capital reduce la base del devengo');
  {
    const r = E.devengoDiario(L(), [ct(1, '2026-07-11', 10000, 500000)], '2026-07-21');
    R.eq('tramo 1: 10 dias a la base original', r.tramos[0].base, 1000000);
    R.eq('tramo 1 devenga 10.000', r.tramos[0].interes, 10000);
    R.eq('tramo 2: la base cayo a la mitad', r.tramos[1].base, 500000);
    R.eq('tramo 2 devenga la mitad por los mismos 10 dias', r.tramos[1].interes, 5000);
    // El BORDE, fijado a proposito: con tramos [desde, hasta) el dia del corte
    // pertenece al tramo siguiente, luego se cobra a la base NUEVA. La regla
    // alternativa ("a partir del dia siguiente") daria 500 pesos mas aqui.
    // Si algun dia se invierte la doctrina, este aserto es el que debe gritar.
    R.eq('BORDE: el dia del corte se cobra a la base NUEVA (doctrina semiabierta)',
      r.interesDevengado, 15000);
  }

  // ── 4 — sin dia fantasma ───────────────────────────────────────────────────
  R.seccion('4. Dos cortes el MISMO dia no cobran el dia dos veces');
  {
    const r = E.devengoDiario(L(), [ct(1, '2026-07-11', 10000, 200000), ct(2, '2026-07-11', 0, 300000)], '2026-07-21');
    const cero = r.tramos.filter(t => t.dias === 0);
    R.check('aparece un tramo de 0 dias y devenga 0', cero.length >= 1 && cero.every(t => t.interes === 0));
    R.eq('los DOS abonos bajaron el capital', r.capitalVivo, 500000);
    R.eq('total devengado = 10 dias a 1M + 10 dias a 500k', r.interesDevengado, 15000);
  }

  // ── 5 — sin capitalizacion ─────────────────────────────────────────────────
  R.seccion('5. SIN capitalizacion: el interes impago no engorda la base');
  {
    // Corte donde el cliente no paga NADA: ni interes ni capital.
    const r = E.devengoDiario(L(), [ct(1, '2026-07-31', 0, 0)], '2026-08-30');
    R.eq('la base del 2o tramo sigue siendo el capital', r.tramos[1].base, 1000000);
    R.eq('30 dias mas devengan otros 30.000, ni un peso mas', r.tramos[1].interes, 30000);
    R.eq('lo impago se ARRASTRA como pendiente', r.interesPendiente, 60000);
  }

  // ── 6 — bordes ─────────────────────────────────────────────────────────────
  R.seccion('6. Bordes: nada negativo, nada que se dispare');
  {
    R.eq('hasta == fechaInicio -> 0 dias', E.devengoDiario(L(), [], '2026-07-01').interesDevengado, 0);
    const rNeg = E.devengoDiario(L(), [], '2026-06-01');
    R.check('una fecha ANTERIOR al inicio da 0, nunca negativo',
      rNeg.interesDevengado === 0 && rNeg.tramos.every(t => t.dias >= 0));
    const rSobre = E.devengoDiario(L(), [ct(1, '2026-07-11', 0, 5000000)], '2026-07-21');
    R.eq('un abono mayor que el capital deja el saldo en 0', rSobre.capitalVivo, 0);
    R.eq('y desde ahi no devenga nada', rSobre.tramos[1].interes, 0);
    R.eq('tasa 0 -> devengo 0', E.devengoDiario(L({ tasaMensual: 0 }), [], '2026-08-01').interesDevengado, 0);
    R.eq('si se cobro de mas, el pendiente se clampa a 0',
      E.devengoDiario(L(), [ct(1, '2026-07-11', 999999, 0)], '2026-07-11').interesPendiente, 0);
    // Orden de entrada irrelevante: el motor ordena por fecha (desempate cuotaN).
    const a = E.devengoDiario(L(), [ct(1, '2026-07-11', 0, 100000), ct(2, '2026-07-21', 0, 100000)], '2026-07-31');
    const b = E.devengoDiario(L(), [ct(2, '2026-07-21', 0, 100000), ct(1, '2026-07-11', 0, 100000)], '2026-07-31');
    R.eq('el resultado no depende del orden en que lleguen los cortes',
      a.interesDevengado, b.interesDevengado);
  }

  // ── 7 — USD ────────────────────────────────────────────────────────────────
  R.seccion('7. USD: la base es el capital en COP a la TRM pactada');
  {
    const r = E.devengoDiario(L({ moneda: 'USD', montoOrigen: 300, trmAcordada: 4000 }), [], '2026-07-31');
    R.eq('origCOP = 300 x 4.000', r.origCOP, 1200000);
    R.eq('30 dias al 3% sobre esa base', r.interesDevengado, 36000);
  }

  // ── 8 — propiedades sobre el espacio de combinaciones ──────────────────────
  R.seccion('8. PROPIEDADES sobre 1.800 combinaciones (fecha x tasa x capital x cortes x consulta)');
  {
    let vPart = 0, vSuma = 0, vEnt = 0, vNeg = 0, vCap = 0, vCache = 0, n = 0;
    const inicios = ['2026-01-15', '2026-02-01', '2026-02-28', '2026-03-31', '2026-06-30', '2026-12-01'];
    const tasas   = [0, 1.5, 3, 7.5, 20];
    const montos  = [1, 100000, 1000000, 7777777, 50000000];
    const hastas  = ['2026-03-01', '2026-07-15', '2027-01-31', '2028-02-29'];  // incluye ano bisiesto
    for (const fi of inicios) for (const ta of tasas) for (const mo of montos) for (const ha of hastas) {
      for (const nc of [0, 1, 3]) {
        n++;
        const loan = L({ fechaInicio: fi, tasaMensual: ta, montoOrigen: mo });
        const cortes = [];
        for (let k = 1; k <= nc; k++) {
          cortes.push(ct(k, E.sumarDias(fi, k * 17), Math.round(mo * 0.001 * k), Math.round(mo / (nc + 2))));
        }
        const r = E.devengoDiario(loan, cortes, ha);

        // (a) PARTICION: los tramos cubren [fechaInicio, hasta) sin huecos ni solapes.
        //     Es la propiedad que garantiza que ningun dia se cobra dos veces ni se pierde.
        let cursor = fi, part = true;
        r.tramos.forEach(t => { if (t.desde !== cursor) part = false; cursor = t.hasta; });
        if (!part || cursor !== ha) vPart++;

        // (b) la suma de dias de los tramos == dias totales del periodo.
        const suma = r.tramos.reduce((s, t) => s + t.dias, 0);
        const tot  = E.diasEntre(fi, ha);
        if (tot >= 0 && cortes.every(c => c.fechaPago <= ha) && suma !== tot) vSuma++;

        // (c) pesos ENTEROS de punta a punta (doctrina v2.2.0, Bug #43).
        if (!Number.isInteger(r.interesDevengado) || !Number.isInteger(r.capitalVivo)
            || r.tramos.some(t => !Number.isInteger(t.interes))) vEnt++;

        // (d) nada negativo en ninguna magnitud.
        if (r.interesDevengado < 0 || r.interesPendiente < 0 || r.capitalVivo < 0
            || r.tramos.some(t => t.dias < 0 || t.interes < 0)) vNeg++;

        // (e) el capital vivo es exactamente el prestado menos lo abonado, con clamp.
        if (r.capitalVivo !== Math.max(0, r.origCOP - r.capitalAbonado)) vCap++;

        // (f) el CACHE (lo que van a guardar fechaUltimoCorte/interesAcumuladoPend)
        //     reconstruye el pendiente exacto al sumarle el tramo abierto. Es lo que
        //     permitira que el atajo y la derivacion completa no diverjan.
        const abierto = r.tramos[r.tramos.length - 1].interes;
        if (r.interesPendiente > 0 && r.cache.interesAcumuladoPend + abierto !== r.interesPendiente) vCache++;
      }
    }
    console.log(`   combinaciones evaluadas: ${n}`);
    R.check(`ANTI-VACIO: se evaluaron al menos 1.500 combinaciones (real: ${n})`, n >= 1500);
    R.check('(a) los tramos PARTICIONAN [fechaInicio, hasta): sin huecos ni solapes', vPart === 0, 'violaciones=' + vPart);
    R.check('(b) la suma de dias de los tramos == dias del periodo', vSuma === 0, 'violaciones=' + vSuma);
    R.check('(c) todo en pesos ENTEROS', vEnt === 0, 'violaciones=' + vEnt);
    R.check('(d) ninguna magnitud negativa', vNeg === 0, 'violaciones=' + vNeg);
    R.check('(e) capitalVivo == max(0, prestado - abonado)', vCap === 0, 'violaciones=' + vCap);
    R.check('(f) el cache reconstruye el pendiente exacto', vCache === 0, 'violaciones=' + vCache);
  }

  // ── 9 — la convencion de dias, fijada ──────────────────────────────────────
  R.seccion('9. Convencion de dias: DIAS REALES / 30 (la misma de /cambiar-dia-pago)');
  {
    R.eq('31 dias cobran 31/30 de la tasa mensual (Actual/360, no 30/360 bursatil)',
      E.interesDeTramo(1000000, 3, 31), 31000);
    R.eq('febrero de 28 dias cobra 28/30', E.interesDeTramo(1000000, 3, 28), 28000);
    R.eq('un mes exacto de 30 dias cobra la tasa mensual', E.interesDeTramo(1000000, 3, 30), 30000);
    // Y la formula es literalmente la del prorrateo que ya existia en el proyecto.
    R.eq('coincide con saldo * tasa/100 * dias/30', E.interesDeTramo(1234567, 2.5, 17),
      Math.round(1234567 * 2.5 / 100 * 17 / 30));
    // TZ: el anclaje a mediodia sobrevive a un cambio de mes y a un bisiesto.
    R.eq('dias entre fin de mes y el siguiente', E.diasEntre('2026-01-31', '2026-02-01'), 1);
    R.eq('febrero bisiesto de 2028 tiene 29 dias', E.diasEntre('2028-02-01', '2028-03-01'), 29);
    R.eq('un ano no bisiesto tiene 365 dias', E.diasEntre('2026-01-01', '2027-01-01'), 365);
  }

  return R.finalizar();
}

let code;
try {
  code = main();
} catch (e) {
  console.error('\n[motor-diario] ABORTADO — el arnes no pudo ejecutarse:');
  console.error(e && e.stack ? e.stack : e);
  code = 2;
}
process.exit(code);
