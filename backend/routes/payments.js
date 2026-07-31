// backend/routes/payments.js — cuotas: consulta, marcado y pagos parciales.
//
// Extraido de `server.js` en la Etapa 2 (A5) del refactor. Codigo VERBATIM
// (unica sustitucion: `app.X` -> `router.X`).
//
// Se lleva consigo `autoExtendSoloIntereses`, que es su unico consumidor: la
// modalidad `Intereses` tiene plazo infinito y genera cuotas sobre la marcha, asi
// que cada GET /api/payments comprueba si quedan menos de 3 pendientes y extiende.
// Ojo con el patron defensivo que usa —comprobar si el id ya existe antes de
// insertar—: `insPayment` es INSERT OR REPLACE con ids deterministas
// (`${loanId}-${cuotaN}`), asi que sin esa guarda pisaria cuotas ya pagadas. Es la
// misma clase de fallo del Bug #38.
//
// Doctrina que sostienen estos endpoints y que no cambia al moverlos:
//   - El ledger `recibos` es la fuente de verdad del flujo de caja: /partial hace
//     push de cada parcial en SU fecha, PUT->Pagado agrega el REMANENTE, y
//     PUT->revertir lo limpia a '[]'. Nunca ledger Y fallback a la vez.
//   - Pago completo por USD (Bug #23): una cuota USD se salda si el USD recibido
//     cubre la cuota en USD, aunque los COP queden cortos por una baja de TRM. Se
//     acepta la perdida cambiaria y se guarda el COP REAL, no el teorico.
//   - Auto-finalizacion: las cuotas regulares se cuentan con la regla canonica
//     `id.indexOf('-ab-') === -1`, NUNCA con la heuristica fragil de
//     interesPeriodo/abonoCapital que se erradico en v1.14.0 (Bugs #27 y #28).

const express = require('express');

module.exports = function crearRutasPayments(ctx) {
  const { db, mutacionAtomica, ClientError, hoyStr, buildSchedule, runPayment } = ctx;
  const router = express.Router();

  // ── API: Payments ─────────────────────────────────────────────────────────
  // Auto-extender cuotas de Intereses si faltan pocas pendientes
  function autoExtendSoloIntereses() {
    const activeIndefinidos = db.prepare("SELECT * FROM loans WHERE estado = 'Activo' AND modalidad = 'Intereses'").all();
    for (const loan of activeIndefinidos) {
      const allPays = db.prepare('SELECT * FROM payments WHERE prestamoId = ? ORDER BY cuotaN DESC').all(loan.id);
      const regulares = allPays.filter(p => p.id.indexOf('-ab-') === -1);
      // Si quedan menos de 3 cuotas pendientes futuras, generar más
      const pendFuturas = regulares.filter(p => p.estadoPago === 'Pendiente');
      if (pendFuturas.length < 3) {
        const maxN = regulares.length > 0 ? Math.max(...regulares.map(p => p.cuotaN)) : 0;
        const nextN = maxN + 1;
        // Calcular saldo actual (considerando abonos)
        const abonos = allPays.filter(p => p.id.indexOf('-ab-') !== -1 && p.estadoPago === 'Pagado');
        const totalAbonado = abonos.reduce((s, p) => s + p.abonoCapital, 0);
        const saldo = Math.max(0, loan.montoCOP - totalAbonado);
        if (saldo > 0) {
          const nuevas = buildSchedule({ ...loan, montoCOP: saldo }, nextN, saldo, 3);
          // Solo insertar si no existen ya
          nuevas.forEach(p => {
            const exists = db.prepare('SELECT id FROM payments WHERE id = ?').get(p.id);
            if (!exists) runPayment(p);
          });
        }
      }
    }
  }

  router.get('/api/payments', (_req, res) => {
    autoExtendSoloIntereses();
    db.prepare(`UPDATE payments SET estadoPago='En Mora' WHERE estadoPago='Pendiente' AND fechaPago < ?`)
      .run(hoyStr());
    res.json(db.prepare('SELECT * FROM payments ORDER BY fechaPago, nombreCliente').all());
  });

  router.put('/api/payments/:id', (req, res) => {
    const { estadoPago, fechaRecaudo, observaciones, montoCOPRecibido, montoUSDRecibido } = req.body;
    const payBefore = db.prepare('SELECT * FROM payments WHERE id = ?').get(req.params.id);
    // El scope del journal es el PRESTAMO (no la cuota): esta ruta tambien muta loans via
    // auto-finalizacion / reactivacion, asi que el agregado entero es la unidad de undo.
    if (!payBefore) return res.status(404).json({ error: 'Cuota no encontrada' });
    return mutacionAtomica(req, res, { accion: 'pago', endpoint: 'PUT /api/payments/:id', scopeTipo: 'loan', scopeId: payBefore.prestamoId }, () => {
    // Al marcar Pagado: partialPaid = cuotaTotal (recibido completo); al revertir: partialPaid = 0 (historial se pierde)
    let newPartial;
    if (estadoPago === 'Pagado' && payBefore) newPartial = payBefore.cuotaTotal;
    else if ((estadoPago === 'Pendiente' || estadoPago === 'En Mora') && payBefore) newPartial = 0;
    else newPartial = payBefore ? (payBefore.partialPaid || 0) : 0;
    // v1.11.1: paidAt = hora real del marcado. Se conserva si ya estaba pagado; se limpia al revertir.
    const nowTs = db.prepare("SELECT datetime('now','localtime') AS t").get().t;
    let newPaidAt;
    if (estadoPago === 'Pagado') newPaidAt = (payBefore && payBefore.paidAt) ? payBefore.paidAt : nowTs;
    else if (estadoPago === 'Pendiente' || estadoPago === 'En Mora') newPaidAt = null;
    else newPaidAt = payBefore ? (payBefore.paidAt || null) : null;
    // v1.11.4: ledger de recibos. Al marcar Pagado, anadir el REMANENTE (lo que falta para cubrir
    // el monto recibido) como un evento en fechaRecaudo: preserva parciales previos en sus fechas
    // reales y nunca duplica. En el flujo normal (cuota sin parciales) el remanente == monto total.
    // Al revertir se limpia el ledger (coherente con partialPaid=0). En otros casos se conserva.
    let newRecibos;
    let prevRec; try { prevRec = JSON.parse((payBefore && payBefore.recibos) || '[]'); } catch (_) { prevRec = []; }
    if (!Array.isArray(prevRec)) prevRec = [];
    if (estadoPago === 'Pagado' && payBefore) {
      const target = Math.round((montoCOPRecibido || payBefore.cuotaTotal) || 0);
      const prevSum = prevRec.reduce((a, r) => a + (Math.round(+r.cop) || 0), 0);
      const remanente = target - prevSum;
      if (remanente > 0) prevRec.push({ fecha: fechaRecaudo || hoyStr(), cop: remanente });
      newRecibos = JSON.stringify(prevRec);
    } else if ((estadoPago === 'Pendiente' || estadoPago === 'En Mora') && payBefore) {
      newRecibos = '[]';
    } else {
      newRecibos = (payBefore && payBefore.recibos) || '[]';
    }
    const label = estadoPago === 'Pagado' ? 'Registraste pago' : estadoPago === 'En Mora' ? 'Marcaste en mora' : 'Revertiste a pendiente';
    return {
      descripcion: label + ': ' + payBefore.nombreCliente + ' cuota #' + payBefore.cuotaN + ' por $' + Math.round(payBefore.cuotaTotal).toLocaleString(),
      // Solo marcar Pagado mueve caja (y genera recibo); revertir o marcar mora, no.
      afectaCaja: estadoPago === 'Pagado',
      payload: { ok: true },
      aplicar: () => {
    db.prepare('UPDATE payments SET estadoPago=?, fechaRecaudo=?, observaciones=?, montoCOPRecibido=?, montoUSDRecibido=?, partialPaid=?, recibos=?, paidAt=? WHERE id=?')
      .run(estadoPago, fechaRecaudo || null, observaciones || '', montoCOPRecibido || 0, montoUSDRecibido || 0, newPartial, newRecibos, newPaidAt, req.params.id);

    // Auto-finalización: si se marcó como Pagado, verificar si todas las cuotas regulares están pagadas
    if (estadoPago === 'Pagado') {
      const pay = db.prepare('SELECT prestamoId, cuotaN FROM payments WHERE id = ?').get(req.params.id);
      if (pay) {
        // Si la cuota pagada era la de proximaCuotaExtra → limpiar para que recalculate no la vuelva a aplicar.
        const loanRow = db.prepare('SELECT proximaCuotaExtraN FROM loans WHERE id = ?').get(pay.prestamoId);
        if (loanRow && loanRow.proximaCuotaExtraN === pay.cuotaN) {
          db.prepare('UPDATE loans SET proximaCuotaExtra = 0, proximaCuotaExtraN = 0 WHERE id = ?').run(pay.prestamoId);
        }
        const allPays = db.prepare('SELECT * FROM payments WHERE prestamoId = ?').all(pay.prestamoId);
        // Cuotas regulares = las que NO son abonos a capital. Regla canonica: id con '-ab-'.
        // NO usar la heuristica interes===0 && capital>0: la cuota unica de un Prestamo (o Pago Unico
        // sin ganancia) tambien la cumple -> quedaba fuera de 'regulares', 'todasPagadas' nunca era
        // true y el prestamo no auto-finalizaba al pagar (gemelo backend del Bug #26).
        const regulares = allPays.filter(p => p.id.indexOf('-ab-') === -1);
        const todasPagadas = regulares.length > 0 && regulares.every(p => p.estadoPago === 'Pagado');
        if (todasPagadas) {
          db.prepare("UPDATE loans SET estado = 'Finalizado', cuotaFijaPactada = 0 WHERE id = ? AND estado = 'Activo'").run(pay.prestamoId);
        }
      }
    }

    // Si se revierte a Pendiente/En Mora, reactivar el préstamo si estaba Finalizado por auto-finalización
    if (estadoPago === 'Pendiente' || estadoPago === 'En Mora') {
      const pay = db.prepare('SELECT prestamoId FROM payments WHERE id = ?').get(req.params.id);
      if (pay) {
        const loan = db.prepare('SELECT * FROM loans WHERE id = ?').get(pay.prestamoId);
        if (loan && loan.estado === 'Finalizado' && loan.montoCOP > 0) {
          db.prepare("UPDATE loans SET estado = 'Activo' WHERE id = ?").run(pay.prestamoId);
        }
      }
    }
      }
    };
    });
  });

  // ── API: Pago Parcial ─────────────────────────────────────────────────────
  // Suma al campo partialPaid. Si con este pago se completa la cuota, auto-marca Pagado.
  router.post('/api/payments/:id/partial', (req, res) => {
    const { monto, fecha, observaciones, montoUSD } = req.body;
    const pay = db.prepare('SELECT * FROM payments WHERE id = ?').get(req.params.id);
    if (!pay) return res.status(404).json({ error: 'Cuota no encontrada' });
    // Scope = el PRESTAMO: esta ruta tambien puede mutar loans (auto-finalizacion y limpieza
    // de proximaCuotaExtra), asi que el agregado entero es la unidad de undo.
    return mutacionAtomica(req, res, { accion: 'pago_parcial', logTipo: 'pago', endpoint: 'POST /api/payments/:id/partial', scopeTipo: 'loan', scopeId: pay.prestamoId }, () => {
    if (pay.estadoPago === 'Pagado') throw new ClientError('La cuota ya está pagada');
    if (pay.id.indexOf('-ab-') !== -1) throw new ClientError('No se pueden aplicar pagos parciales sobre un abono a capital');
    const montoNum = Math.round(+monto || 0);
    if (montoNum <= 0) throw new ClientError('El monto debe ser mayor a 0');
    const yaPagado = pay.partialPaid || 0;
    const restante = pay.cuotaTotal - yaPagado;
    if (montoNum > restante) throw new ClientError('El monto supera el saldo pendiente de la cuota ($' + Math.round(restante).toLocaleString() + ')');

    const nuevoPartial = yaPagado + montoNum;
    // v1.12.x FIX (pago bimonetario): en prestamos USD, si el USD recibido cubre la cuota en USD
    // (cuotaTotal / trmAcordada), la cuota se completa aunque los COP sean menores por una baja de
    // la TRM. Se acepta el deficit/superavit cambiario sin penalizar el estado de la cuota.
    const loanPay = db.prepare('SELECT moneda, trmAcordada FROM loans WHERE id = ?').get(pay.prestamoId);
    const cuotaEnUSD = (loanPay && loanPay.moneda === 'USD' && loanPay.trmAcordada > 0)
      ? Math.round((pay.cuotaTotal / loanPay.trmAcordada) * 100) / 100 : 0;
    const usdRecibidoAcum = Math.round(((pay.montoUSDRecibido || 0) + (+montoUSD || 0)) * 100) / 100;
    const completaUSD = cuotaEnUSD > 0 && usdRecibidoAcum >= cuotaEnUSD - 0.005; // tolerancia de centavo
    const completa = nuevoPartial >= pay.cuotaTotal || completaUSD;
    const fechaPago = fecha || hoyStr();
    const obsPrev = pay.observaciones || '';
    const obsNueva = (observaciones || '').trim();
    const obsCombinada = [obsPrev, obsNueva && ('Parcial ' + fechaPago + ': $' + montoNum.toLocaleString() + (obsNueva ? ' — ' + obsNueva : ''))].filter(Boolean).join(' | ');
    // v1.11.4: registrar este parcial como evento de caja en el ledger (con su fecha real de
    // recaudo). La suma de los parciales == cuotaTotal al completar (montoNum <= restante).
    let recibosArr; try { recibosArr = JSON.parse(pay.recibos || '[]'); } catch (_) { recibosArr = []; }
    if (!Array.isArray(recibosArr)) recibosArr = [];
    recibosArr.push({ fecha: fechaPago, cop: montoNum });
    const recibosJSON = JSON.stringify(recibosArr);

    // `completa` ya se conoce aqui (se deriva de pay + monto), asi que la descripcion del
    // journal/log se puede fijar antes de escribir.
    const descPartial = completa
      ? 'Pago parcial final: ' + pay.nombreCliente + ' cuota #' + pay.cuotaN + ' $' + montoNum.toLocaleString() + ' (completo $' + Math.round(pay.cuotaTotal).toLocaleString() + ')'
      : 'Pago parcial: ' + pay.nombreCliente + ' cuota #' + pay.cuotaN + ' $' + montoNum.toLocaleString() + ' (faltan $' + Math.round(pay.cuotaTotal - nuevoPartial).toLocaleString() + ')';

    return {
      descripcion: descPartial,
      afectaCaja: true,   // un parcial SIEMPRE es dinero recibido (y suele llevar recibo)
      payload: { ok: true, completa, partialPaid: nuevoPartial, restante: Math.max(0, pay.cuotaTotal - nuevoPartial) },
      aplicar: () => {
    if (completa) {
      // Completa la cuota: marcar Pagado
      const usdAcum = (pay.montoUSDRecibido || 0) + (+montoUSD || 0);
      db.prepare("UPDATE payments SET estadoPago=?, fechaRecaudo=?, observaciones=?, montoCOPRecibido=?, montoUSDRecibido=?, partialPaid=?, recibos=?, paidAt=datetime('now','localtime') WHERE id=?")
        .run('Pagado', fechaPago, obsCombinada, nuevoPartial, Math.round(usdAcum * 100) / 100, pay.cuotaTotal, recibosJSON, req.params.id);

      // Si era la cuota con proximaCuotaExtra, limpiarla del loan
      const loanRow = db.prepare('SELECT proximaCuotaExtraN FROM loans WHERE id = ?').get(pay.prestamoId);
      if (loanRow && loanRow.proximaCuotaExtraN === pay.cuotaN) {
        db.prepare('UPDATE loans SET proximaCuotaExtra = 0, proximaCuotaExtraN = 0 WHERE id = ?').run(pay.prestamoId);
      }
      // Auto-finalización del préstamo
      const allPays = db.prepare('SELECT * FROM payments WHERE prestamoId = ?').all(pay.prestamoId);
      const regulares = allPays.filter(p => p.id.indexOf('-ab-') === -1); // abono = id con '-ab-' (canonico, ver Bug #26)
      const todasPagadas = regulares.length > 0 && regulares.every(p => p.estadoPago === 'Pagado');
      if (todasPagadas) {
        db.prepare("UPDATE loans SET estado = 'Finalizado', cuotaFijaPactada = 0 WHERE id = ? AND estado = 'Activo'").run(pay.prestamoId);
      }
    } else {
      // Solo suma al partialPaid, estado permanece
      const copAcum = (pay.montoCOPRecibido || 0) + montoNum;
      const usdAcum = (pay.montoUSDRecibido || 0) + (+montoUSD || 0);
      db.prepare('UPDATE payments SET partialPaid=?, observaciones=?, montoCOPRecibido=?, montoUSDRecibido=?, recibos=? WHERE id=?')
        .run(nuevoPartial, obsCombinada, copAcum, Math.round(usdAcum * 100) / 100, recibosJSON, req.params.id);
    }
      }
    };
    });
  });

  return router;
};
