// backend/routes/debts.js — modulo "Mis Deudas" (lo que YO debo).
//
// Extraido de `server.js` en la Etapa 2 (A5) del refactor. Codigo VERBATIM
// (unica sustitucion: `app.X` -> `router.X`).
//
// Cuenta rotativa de doble via, sin intereses ni cuotas automaticas. El modelo
// matematico es la fuente de verdad y no se toca al mover el codigo:
//
//   saldo_pendiente = monto_original + Σ(cargos) − Σ(abonos)
//
// El servidor SIEMPRE recalcula el saldo DESDE EL LEDGER tras cada movimiento o
// edicion; nunca lo muta de forma incremental. El estado (`Activa`/`Pagada`) es
// derivado, jamas manual, y un `cargo` puede reactivar una deuda ya pagada.
//
// Los 4 endpoints que mutan SI estan journalizados (scope `debt`), a diferencia
// de `DELETE /api/loans/:id`. Esa diferencia es estructural y explica el Bug #41:
// como el borrado de una deuda crea su propia entrada de undo, esa entrada pasa a
// ser el head del LIFO y bloquea a las anteriores; deshacerla resucita la deuda
// con su ledger y recien entonces se libera la siguiente.

const express = require('express');

module.exports = function crearRutasDebts(ctx) {
  const { db, mutacionAtomica, ClientError, genId, hoyStr } = ctx;
  const router = express.Router();

  // Lista todas las deudas con su saldo_pendiente actual (Activas primero, luego por fecha desc)
  router.get('/api/debts', (_req, res) => {
    // QA5: agrega total_cargos / total_abonos por deuda para que la barra de progreso del frontend
    // tenga base dinamica (monto_original + cargos) sin pedir el detalle de cada una.
    res.json(db.prepare(`
      SELECT d.*,
        COALESCE((SELECT SUM(CASE WHEN p.tipo = 'cargo' THEN p.monto_pagado ELSE 0 END) FROM pagos_deudas p WHERE p.deuda_id = d.id), 0) AS total_cargos,
        COALESCE((SELECT SUM(CASE WHEN p.tipo = 'cargo' THEN 0 ELSE p.monto_pagado END) FROM pagos_deudas p WHERE p.deuda_id = d.id), 0) AS total_abonos
      FROM mis_deudas d
      ORDER BY d.estado ASC, d.fecha_creacion DESC, d.id DESC
    `).all());
  });

  // Detalle de una deuda + su historial de pagos (ledger pagos_deudas)
  router.get('/api/debts/:id', (req, res) => {
    const deuda = db.prepare('SELECT * FROM mis_deudas WHERE id = ?').get(req.params.id);
    if (!deuda) return res.status(404).json({ error: 'Deuda no encontrada' });
    const pagos = db.prepare('SELECT * FROM pagos_deudas WHERE deuda_id = ? ORDER BY fecha_pago DESC, id DESC').all(req.params.id);
    res.json({ ...deuda, pagos });
  });

  // Crea una deuda. saldo_pendiente arranca igual al monto_original; estado 'Activa'.
  router.post('/api/debts', (req, res) => {
    const titulo = (req.body.titulo || '').trim();
    const acreedor = (req.body.acreedor || '').trim();
    const concepto = (req.body.concepto || '').trim();
    const monto = Math.round(+req.body.monto_original || 0);
    if (!titulo) return res.status(400).json({ error: 'El titulo es obligatorio' });
    if (!acreedor) return res.status(400).json({ error: 'El acreedor es obligatorio' });
    if (monto <= 0) return res.status(400).json({ error: 'El monto original debe ser mayor a 0' });
    // QA3: fecha_creacion editable. Si viene en el payload se usa; si no, el INSERT omite la
    // columna y queda el DEFAULT (datetime('now','localtime')).
    const fecha = (req.body.fecha_creacion || '').toString().slice(0, 10);
    // El id se genera ANTES para que el scope del journal sea conocido. El snapshot previo de
    // una deuda que aun no existe es {deuda:null, pagos:[]} -> deshacer = eliminarla.
    const id = genId();
    return mutacionAtomica(req, res, { accion: 'deuda_crear', logTipo: 'deuda', endpoint: 'POST /api/debts', scopeTipo: 'debt', scopeId: id }, () => ({
      descripcion: 'Nueva deuda "' + titulo + '" con ' + acreedor + ' por $' + monto.toLocaleString('es-CO'),
      aplicar: () => {
        if (fecha) {
          db.prepare(`INSERT INTO mis_deudas(id, titulo, acreedor, concepto, monto_original, saldo_pendiente, estado, fecha_creacion)
                      VALUES (?, ?, ?, ?, ?, ?, 'Activa', ?)`).run(id, titulo, acreedor, concepto, monto, monto, fecha);
        } else {
          db.prepare(`INSERT INTO mis_deudas(id, titulo, acreedor, concepto, monto_original, saldo_pendiente, estado)
                      VALUES (?, ?, ?, ?, ?, ?, 'Activa')`).run(id, titulo, acreedor, concepto, monto, monto);
        }
        return db.prepare('SELECT * FROM mis_deudas WHERE id = ?').get(id);
      }
    }));
  });

  // Registra un abono manual: inserta en pagos_deudas y resta saldo_pendiente.
  // Si el saldo llega a 0 -> estado 'Pagada'. ATOMICO: valida y computa TODO antes
  // de la primera escritura; las mutaciones van dentro de db.transaction (all-or-nothing).
  router.post('/api/debts/:id/pay', (req, res) => {
    // FASE 1 — lectura + validacion (sin escrituras)
    const deuda = db.prepare('SELECT * FROM mis_deudas WHERE id = ?').get(req.params.id);
    if (!deuda) return res.status(404).json({ error: 'Deuda no encontrada' });
    // QA5 "Cuenta Rotativa": 'abono' reduce la deuda, 'cargo' la aumenta (sin tope).
    const tipo = req.body.tipo === 'cargo' ? 'cargo' : 'abono';
    const monto = Math.round(+req.body.monto_pagado || 0);
    const fecha = (req.body.fecha_pago || hoyStr()).toString().slice(0, 10);
    const notas = (req.body.notas || '').trim();
    const pagoId = genId();

    return mutacionAtomica(req, res, { accion: 'deuda_movimiento', logTipo: 'deuda', endpoint: 'POST /api/debts/:id/pay', scopeTipo: 'debt', scopeId: req.params.id }, () => {
      if (monto <= 0) throw new ClientError('El monto del movimiento debe ser mayor a 0');
      // Solo el abono tiene tope (no se puede abonar mas que el saldo). El cargo NO tiene limite,
      // y puede reactivar una deuda 'Pagada'.
      if (tipo === 'abono' && monto > deuda.saldo_pendiente) {
        throw new ClientError('El abono ($' + monto.toLocaleString('es-CO') + ') supera el saldo pendiente ($' + Math.round(deuda.saldo_pendiente).toLocaleString('es-CO') + ')');
      }
      // El saldo se RECALCULA desde el ledger: monto_original + SUM(cargos) - SUM(abonos).
      // La descripcion se evalua DESPUES de aplicar (necesita el saldo ya recalculado).
      let actualizada = null;
      return {
        descripcion: () => (tipo === 'cargo' ? 'Cargo' : 'Abono') + ' a deuda con ' + deuda.acreedor + ': $' + monto.toLocaleString('es-CO')
          + ' — saldo: $' + Math.round(actualizada.saldo_pendiente).toLocaleString('es-CO') + (actualizada.estado === 'Pagada' ? ' (PAGADA)' : ''),
        // Movimiento de caja propio (deuda mia). No hay recibo entregado a un tercero, pero si
        // es dinero real: la UI lo advierte con menor severidad que un cobro a un deudor.
        afectaCaja: tipo === 'abono',
        aplicar: () => {
          db.prepare('INSERT INTO pagos_deudas(id, deuda_id, monto_pagado, fecha_pago, notas, tipo) VALUES (?, ?, ?, ?, ?, ?)')
            .run(pagoId, deuda.id, monto, fecha, notas, tipo);
          const agg = db.prepare("SELECT COALESCE(SUM(CASE WHEN tipo = 'cargo' THEN monto_pagado ELSE 0 END), 0) AS cargos, COALESCE(SUM(CASE WHEN tipo = 'cargo' THEN 0 ELSE monto_pagado END), 0) AS abonos FROM pagos_deudas WHERE deuda_id = ?").get(deuda.id);
          const saldo = Math.round((deuda.monto_original + agg.cargos - agg.abonos) * 100) / 100;
          const estado = saldo <= 0 ? 'Pagada' : 'Activa';
          db.prepare('UPDATE mis_deudas SET saldo_pendiente = ?, estado = ? WHERE id = ?').run(saldo, estado, deuda.id);
          actualizada = db.prepare('SELECT * FROM mis_deudas WHERE id = ?').get(deuda.id);
          return { ok: true, pago: db.prepare('SELECT * FROM pagos_deudas WHERE id = ?').get(pagoId), deuda: actualizada };
        }
      };
    });
  });

  // Edita una deuda (acreedor, concepto, monto_original). Recalcula saldo y estado.
  // Validacion: el nuevo monto_original NO puede ser menor a lo ya pagado en el ledger.
  router.put('/api/debts/:id', (req, res) => {
    const deuda = db.prepare('SELECT * FROM mis_deudas WHERE id = ?').get(req.params.id);
    if (!deuda) return res.status(404).json({ error: 'Deuda no encontrada' });
    const titulo = (req.body.titulo || '').trim();
    const acreedor = (req.body.acreedor || '').trim();
    const concepto = (req.body.concepto || '').trim();
    const monto = Math.round(+req.body.monto_original || 0);
    return mutacionAtomica(req, res, { accion: 'deuda_editar', logTipo: 'deuda', endpoint: 'PUT /api/debts/:id', scopeTipo: 'debt', scopeId: req.params.id }, () => {
      if (!titulo) throw new ClientError('El titulo es obligatorio');
      if (!acreedor) throw new ClientError('El acreedor es obligatorio');
      if (monto <= 0) throw new ClientError('El monto original debe ser mayor a 0');
      // QA5: saldo = monto_original + SUM(cargos) - SUM(abonos). La proteccion impide bajar el monto
      // por debajo de lo ya abonado NETO (abonos - cargos), que dejaria el saldo negativo.
      const agg = db.prepare("SELECT COALESCE(SUM(CASE WHEN tipo = 'cargo' THEN monto_pagado ELSE 0 END), 0) AS cargos, COALESCE(SUM(CASE WHEN tipo = 'cargo' THEN 0 ELSE monto_pagado END), 0) AS abonos FROM pagos_deudas WHERE deuda_id = ?").get(req.params.id);
      const netAbonado = Math.round(agg.abonos - agg.cargos);
      if (monto < netAbonado) {
        throw new ClientError('El monto ($' + monto.toLocaleString('es-CO') + ') no puede ser menor a lo ya abonado neto ($' + netAbonado.toLocaleString('es-CO') + ')');
      }
      const nuevoSaldo = Math.round((monto + agg.cargos - agg.abonos) * 100) / 100;
      const nuevoEstado = nuevoSaldo <= 0 ? 'Pagada' : 'Activa';
      // QA3: fecha_creacion editable; si el payload no la trae, se conserva la existente.
      const fecha = (req.body.fecha_creacion || '').toString().slice(0, 10) || deuda.fecha_creacion;
      return {
        descripcion: 'Editaste la deuda "' + titulo + '" con ' + acreedor + ' (monto $' + monto.toLocaleString('es-CO') + ', saldo $' + nuevoSaldo.toLocaleString('es-CO') + ')',
        aplicar: () => {
          db.prepare('UPDATE mis_deudas SET titulo = ?, acreedor = ?, concepto = ?, monto_original = ?, saldo_pendiente = ?, estado = ?, fecha_creacion = ? WHERE id = ?')
            .run(titulo, acreedor, concepto, monto, nuevoSaldo, nuevoEstado, fecha, req.params.id);
          return db.prepare('SELECT * FROM mis_deudas WHERE id = ?').get(req.params.id);
        }
      };
    });
  });

  // Elimina una deuda y su ledger. La FK tiene ON DELETE CASCADE; ademas borramos el
  // ledger explicitamente (robustez) dentro de una transaccion all-or-nothing.
  router.delete('/api/debts/:id', (req, res) => {
    const deuda = db.prepare('SELECT * FROM mis_deudas WHERE id = ?').get(req.params.id);
    if (!deuda) return res.status(404).json({ error: 'Deuda no encontrada' });
    // El snapshot guarda la deuda + su ledger completo -> deshacer la RESUCITA con sus movimientos.
    return mutacionAtomica(req, res, { accion: 'deuda_eliminar', logTipo: 'deuda', endpoint: 'DELETE /api/debts/:id', scopeTipo: 'debt', scopeId: req.params.id }, () => ({
      descripcion: 'Eliminaste la deuda con ' + deuda.acreedor + ' ($' + Math.round(deuda.monto_original).toLocaleString('es-CO') + ')',
      aplicar: () => {
        db.prepare('DELETE FROM pagos_deudas WHERE deuda_id = ?').run(req.params.id);
        db.prepare('DELETE FROM mis_deudas WHERE id = ?').run(req.params.id);
      }
    }));
  });

  return router;
};
