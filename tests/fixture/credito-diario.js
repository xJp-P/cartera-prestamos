// tests/fixture/credito-diario.js — el credito SINTETICO de Interes Diario del fixture.
//
// Vive en su propio modulo, y no dentro de `crear-fixture.js`, por una razon
// concreta: el fixture NO es reproducible en el tiempo. Regenerarlo desde
// produccion arrastra dos cosas ajenas al cambio que uno este haciendo:
//   (a) la actividad real que el usuario haya registrado desde la ultima vez, y
//   (b) estado dependiente del CALENDARIO — la auto-mora de arranque marca
//       'En Mora' toda cuota Pendiente con fechaPago < hoy, asi que el mismo
//       origen produce un fixture distinto segun el dia en que se regenere.
// Medido el 2026-08-04: una regeneracion trajo 1 pago real nuevo y 2 cuotas que
// habian cambiado de estado solas.
//
// Por eso el credito sintetico tiene que poder inyectarse SOLO, sobre el fixture
// ya versionado, sin volver a pasar por produccion. Asi el commit que lo anade
// mueve unicamente sus propias filas y los golden siguen siendo atribuibles.
// `crear-fixture.js` llama a esta misma funcion, de modo que una regeneracion
// completa produce exactamente el mismo credito: una sola fuente, sin copias.
//
// ── EL DATO ────────────────────────────────────────────────────────────────
// Es 100% inventado. No se anonimiza un credito real porque no existe ninguno de
// esta modalidad en produccion, y crear uno para despues anonimizarlo seria meter
// datos de un cliente en un repo publico por la puerta de atras.
//
// POR QUE ES OBLIGATORIO Y NO UN EXTRA
// Los PISO de tests/props-dominio.js son totales GLOBALES sobre la cartera. Sin
// una sola fila '-ct-' en el fixture, toda propiedad sobre cortes daria VERDE EN
// VACIO: pasaria por no tener nada que evaluar, que es peor que fallar.
//
// MODELO (decisiones de negocio confirmadas): base 30/360, tramos SEMIABIERTOS
// [desde, hasta) y SIN capitalizacion del interes impago.
//   capital 1.000.000 al 3% mensual -> tasaDia = 0,03/30 = 0,001 -> 1.000 COP/dia
//   corte 1  16-jul  dias [01,16) = 15  sobre 1.000.000 -> interes 15.000, sin abono
//   corte 2  31-jul  dias [16,31) = 15  sobre 1.000.000 -> interes 15.000 + abono 400.000
//   capital vivo tras el corte 2 = 600.000
//
// El corte 1 es el caso borde que de verdad importa: `abonoCapital = 0` Y
// `cuotaTotal === interesPeriodo` EXACTO. Si esa identidad se rompe por un solo
// peso, el fallback `if (capTotal<=0 && reconc>0) capTotal = reconc` de
// imputarCobros reclasifica TODO el interes cobrado como capital y el credito se
// salda solo. Por eso vive en el fixture y no en un test sintetico aparte.
//
// TODO es determinista (fechas, importes, ids y createdAt fijos): inyectarlo dos
// veces deja el mismo resultado (INSERT OR REPLACE) y no ensucia el diff de los
// golden. `createdAt` se fija a mano porque su DEFAULT es datetime('now'), que
// cambiaria en cada corrida.

const DIARIO_ID = 'fixture-diario-01';
// Nombre FUERA de la lista NOMBRES del anonimizador, para que no colisione con
// ninguna identidad sustituida y los tests no confundan dos prestamos distintos.
const DIARIO_NOMBRE = 'Nilda Paredes';

function inyectarCreditoDiario(db) {
  const tx = db.transaction(() => {
    db.prepare(`INSERT OR REPLACE INTO loans
      (id, nombre, cedula, telefono, moneda, montoOrigen, trmAcordada, montoCOP,
       tasaMensual, plazoMeses, modalidad, fechaInicio, diaPago, estado, notas,
       createdAt, frecuencia)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      DIARIO_ID, DIARIO_NOMBRE, '1099887766', '3011234567', 'COP',
      1000000, 1, 600000,          // montoOrigen / TRM / montoCOP = capital VIVO tras el corte 2
      3, 0,                        // 3% mensual · plazoMeses = 0 (centinela: no hay plazo)
      'Interes Diario', '2026-07-01', 1, 'Activo', 'Credito abierto de prueba',
      '2026-07-01 12:00:00', 'Mensual'
    );

    const corte = (n, fecha, saldoIni, interes, abono, saldoFin) => {
      const total = interes + abono;
      db.prepare(`INSERT OR REPLACE INTO payments
        (id, prestamoId, nombreCliente, cuotaN, fechaPago, saldoInicial, interesPeriodo,
         abonoCapital, cuotaTotal, saldoFinal, estadoPago, fechaRecaudo, observaciones,
         montoCOPRecibido, montoUSDRecibido, partialPaid, paidAt, recibos, extraConsolidado)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        `${DIARIO_ID}-ct-${n}`, DIARIO_ID, DIARIO_NOMBRE, n, fecha,
        saldoIni, interes, abono, total, saldoFin,
        'Pagado',                  // I1: nace Pagado -> la auto-mora (4 copias) no lo toca
        fecha, '',
        total, 0, total,           // caja real == composicion (credito en COP, sin efecto TRM)
        `${fecha} 12:00:00`,
        JSON.stringify([{ fecha, cop: total }]),  // I5: ledger siempre escrito -> cobrosDe no usa fallback
        0
      );
    };
    corte(1, '2026-07-16', 1000000, 15000,      0, 1000000);  // solo interes
    corte(2, '2026-07-31', 1000000, 15000, 400000,  600000);  // interes + abono a capital
  });
  tx();
}

module.exports = { DIARIO_ID, DIARIO_NOMBRE, inyectarCreditoDiario };
