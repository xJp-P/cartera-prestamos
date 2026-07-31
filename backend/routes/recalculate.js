// backend/routes/recalculate.js — reconstruccion de todos los cronogramas activos.
//
// Extraido de `server.js` en la Etapa 2 (A5) del refactor. Codigo VERBATIM
// (unica sustitucion: `app.X` -> `router.X`).
//
// FUERA del journal de undo por decision de negocio: es una operacion GLOBAL y
// reconstructiva, no la mutacion de un agregado concreto. Pero SI es atomica, y
// de una forma particular: la transaccion envuelve CADA PRESTAMO POR SEPARADO,
// porque un prestamo problematico no debe revertir el trabajo de los demas.
//
// Reglas que este endpoint sostiene y que no se tocan al moverlo:
//   - Solo borra las cuotas PENDIENTES regulares; Pagadas, En Mora y abonos
//     (`-ab-`) quedan intactos.
//   - `saldoReal` resta el capital de Pagadas Y de En Mora (Bug #21): es simetrico
//     con `regularConsumed`, que cuenta la mora como consumida. NO usa
//     `loan.montoCOP`, que puede estar stale (Bug #17).
//   - snapshot/restauracion de pagos parciales y del ledger `recibos` (Bug #44):
//     regenerar un cronograma no puede borrar dinero ya cobrado.

const express = require('express');

module.exports = function crearRutasRecalculate(ctx) {
  const {
    db, insertSchedule, snapshotCobros, restaurarCobros,
    buildSchedule, buildScheduleFixedPMT, cuotasHastaHoy, hoyStr,
  } = ctx;
  const router = express.Router();

  // ── API: Recalcular cronogramas ───────────────────────────────────────────
  // v1.9.0 FIX: solo borra Pendientes regulares. Cuotas Pagadas y En Mora se preservan
  // intactas (son deuda historica / causada y no deben ser recalculadas). nextRegularN
  // se deriva de las cuotas (Pagadas + Mora) existentes para que las nuevas Pendientes
  // no colisionen con los cuotaN existentes.
  router.post('/api/recalculate', (_req, res) => {
    const activeLoans = db.prepare("SELECT * FROM loans WHERE estado = 'Activo'").all();
    let updated = 0;
    // ATOMICO por prestamo: el borrado de Pendientes y su regeneracion van juntos. Antes iban
    // sueltos -> un fallo entre ambos dejaba al deudor SIN cronograma. Se envuelve cada iteracion
    // (no el lote entero) para que un prestamo problematico no revierta el trabajo de los demas.
    // NO se journaliza: /recalculate es reconstructivo por diseño y de alcance global.
    const recalcularUno = db.transaction((loan) => {
      const prev = db.prepare('SELECT * FROM payments WHERE prestamoId = ?').all(loan.id);
      const prevRegulares = prev.filter(p => !p.id || p.id.indexOf('-ab-') === -1);
      const prevPagadasYMora = prevRegulares.filter(p => p.estadoPago === 'Pagado' || p.estadoPago === 'En Mora');
      const prevPendientes = prevRegulares.filter(p => p.estadoPago === 'Pendiente');

      // Snapshot de lo cobrado sobre las Pendientes: monto parcial + ledger `recibos` (fechas
      // reales del dinero) + observaciones, para restaurarlo tras regenerar.
      const partialMap = snapshotCobros(prevPendientes);

      // Borrar SOLO las Pendientes — Pagadas y Mora quedan intactas
      prevPendientes.forEach(p => {
        db.prepare('DELETE FROM payments WHERE id = ?').run(p.id);
      });

      const regularConsumed = prevPagadasYMora.length;
      const nextRegularN = regularConsumed + 1;
      const cuotaFija = Math.round(+loan.cuotaFijaPactada || 0);
      const indefinido = loan.modalidad === 'Intereses';

      // v1.9.x FIX (bug general de cuotas infladas): NO usar loan.montoCOP que puede
      // estar stale (solo se actualiza con /abono, no al marcar pagos sin abono).
      // Calcular saldo real desde formula confiable: originalCOP - capitalPagado total
      // (cuotas Pagadas regulares + abonos a capital Pagados). Aplica solo a modalidades
      // que necesitan amortizacion (Capital + Intereses, Intereses). Prestamo se mantiene
      // con montoCOP porque su flujo es diferente.
      const originalCOPRec = loan.moneda === 'USD' ? Math.round(loan.montoOrigen * loan.trmAcordada) : Math.round(loan.montoOrigen);
      const capPorAbonos = prev.filter(p => p.id.indexOf('-ab-') !== -1 && p.estadoPago === 'Pagado').reduce((s, p) => s + p.abonoCapital, 0);
      // v1.12.x FIX (bug de mora): restar tambien el capital de las cuotas EN MORA (deuda
      // independiente, su capital NO se re-amortiza en las pendientes). prevPagadasYMora =
      // Pagadas + Mora -> simetrico con regularConsumed (que tambien las cuenta). Antes solo Pagadas.
      const capPorCuotasPagadas = prevPagadasYMora.reduce((s, p) => s + p.abonoCapital, 0);
      const saldoReal = Math.max(0, originalCOPRec - capPorAbonos - capPorCuotasPagadas);
      let schedule = [];

      if (saldoReal > 0) {
        if (cuotaFija > 0 && loan.modalidad === 'Capital + Intereses') {
          try {
            schedule = buildScheduleFixedPMT(loan, nextRegularN, saldoReal, cuotaFija);
          } catch (e) {
            const remaining = Math.max(0, (loan.plazoMeses || 12) - regularConsumed);
            if (remaining > 0) schedule = buildSchedule(loan, nextRegularN, saldoReal, remaining);
          }
        } else if (loan.modalidad === 'Prestamo') {
          // Para Prestamo (sin intereses, 1 cuota) seguimos usando montoCOP — su flujo
          // no es PMT y montoCOP refleja el saldo correctamente tras abonos.
          if (regularConsumed === 0 && loan.montoCOP > 0) schedule = buildSchedule(loan);
        } else if (loan.modalidad === 'Pago Unico') {
          // v1.10.0: espejo de Prestamo — 1 cuota unica, regenera si no se consumio
          if (regularConsumed === 0 && loan.montoCOP > 0) schedule = buildSchedule(loan);
        } else {
          // Intereses o Capital+Intereses sin cuotaFija — usar saldoReal computado
          const remaining = indefinido
            ? Math.max(0, cuotasHastaHoy(loan.fechaInicio, nextRegularN, 3, loan.frecuencia || 'Mensual'))
            : Math.max(0, (loan.plazoMeses || 12) - regularConsumed);
          if (remaining > 0) schedule = buildSchedule(loan, nextRegularN, saldoReal, remaining);
        }
      }

      // Aplicar extra del prorrateo (proximaCuotaExtra) a la cuota objetivo si aun esta pendiente
      const extraLoan = Math.round(+loan.proximaCuotaExtra || 0);
      const extraN = +loan.proximaCuotaExtraN || 0;
      restaurarCobros(schedule, partialMap);
      schedule.forEach(p => {
        if (extraLoan !== 0 && p.cuotaN === extraN) {
          p.interesPeriodo = Math.round(p.interesPeriodo + extraLoan);
          p.cuotaTotal = Math.round(p.cuotaTotal + extraLoan);
          p.extraConsolidado = extraLoan;
          if (!p.observaciones) p.observaciones = 'Cuota transitoria por cambio de fecha de pago (' + (extraLoan >= 0 ? '+$' : '-$') + Math.abs(extraLoan).toLocaleString('es-CO') + ')';
        }
      });
      if (schedule.length > 0) insertSchedule(schedule);
    });
    for (const loan of activeLoans) {
      recalcularUno(loan);
      updated++;
    }
    // Re-aplicar auto-mora a Pendientes que cruzaron la fecha
    db.prepare(`UPDATE payments SET estadoPago='En Mora' WHERE estadoPago='Pendiente' AND fechaPago < ?`)
      .run(hoyStr());
    // Fix cuotas en mora de Prestamo (sin intereses): cuotaTotal = saldo actual
    // v1.10.0 fix housekeeping: tambien saldoInicial y abonoCapital para mantener
    // consistencia interna de la cuota tras abonos previos.
    const fixP = db.prepare("SELECT * FROM loans WHERE estado = 'Activo' AND modalidad = 'Prestamo'").all();
    fixP.forEach(fl => {
      const ns = Math.round(fl.montoCOP);
      db.prepare(`UPDATE payments SET saldoInicial = ?, abonoCapital = ?, cuotaTotal = ?, saldoFinal = 0
        WHERE prestamoId = ? AND estadoPago = 'En Mora'
        AND id NOT LIKE '%-ab-%'`)
        .run(ns, ns, ns, fl.id);
    });
    // v1.10.0 — Fix cuotas en mora de Pago Unico: cuotaTotal = saldo + ganancia
    // (la ganancia pactada se mantiene aunque el deudor caiga en mora)
    const fixPU = db.prepare("SELECT * FROM loans WHERE estado = 'Activo' AND modalidad = 'Pago Unico'").all();
    fixPU.forEach(fl => {
      const gPU = Math.round(+fl.gananciaFija || 0);
      const nsPU = Math.round(fl.montoCOP);
      db.prepare(`UPDATE payments SET saldoInicial = ?, abonoCapital = ?, cuotaTotal = ?, saldoFinal = 0
        WHERE prestamoId = ? AND estadoPago = 'En Mora'
        AND id NOT LIKE '%-ab-%'`)
        .run(nsPU, nsPU, nsPU + gPU, fl.id);
    });
    res.json({ ok: true, updated });
  });

  return router;
};
