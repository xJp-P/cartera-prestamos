// backend/routes/undo.js — el Boton Deshacer ("La Bestia").
//
// Extraido de `server.js` en la Etapa 2 (A5) del refactor. Codigo VERBATIM
// (unica sustitucion: `app.X` -> `router.X`).
//
// Estos 2 endpoints son los CONSUMIDORES del journal; quien lo ESCRIBE es
// `mutacionAtomica` (core/atomic.js), dentro de la misma transaccion que cada
// mutacion. Los candados que se aplican aca:
//   A  LIFO por scope: solo la entrada `disponible` mas reciente de ESE agregado
//      puede deshacerse; si no, 409 nombrando la que falta.
//   B  `post_hash` es DETECTOR, NO GATE. El arranque corre housekeeping
//      determinista (auto-mora, fixPrestamos) que cambia filas sin ser decision
//      del usuario; si el hash bloqueara, todos los undos caducarian con solo
//      reiniciar la app. Se restaura, se RE-APLICA el housekeeping y la
//      divergencia viaja como `warning`.
//   E  drift de esquema: el restore inserta por INTERSECCION de columnas.
//
// APPEND-ONLY: deshacer no borra la huella. La entrada queda `deshecho` y se
// agrega una compensatoria de tipo `deshacer` al activity_log.

const express = require('express');

module.exports = function crearRutasUndo(ctx) {
  const { db, logAction, hashSnapshot, snapshotScope, restoreScope, reHousekeepLoan } = ctx;
  const router = express.Router();

  // ── API: Deshacer ────────────────────────────────────────────────────────────
  router.post('/api/undo/:id', (req, res) => {
    const entry = db.prepare('SELECT * FROM undo_journal WHERE id = ?').get(req.params.id);
    if (!entry) return res.status(404).json({ error: 'Operacion no encontrada en el historial' });
    if (entry.estado !== 'disponible') {
      return res.status(400).json({ error: 'Esta operacion ya fue ' + (entry.estado === 'deshecho' ? 'deshecha' : 'invalidada') + ' y no puede revertirse de nuevo' });
    }
    // Candado A — LIFO estricto por scope: solo la entrada disponible MAS reciente
    // de este agregado puede deshacerse.
    const top = db.prepare("SELECT id, descripcion, created_at FROM undo_journal WHERE scope_tipo=? AND scope_id=? AND estado='disponible' ORDER BY rowid DESC LIMIT 1").get(entry.scope_tipo, entry.scope_id);
    if (top && top.id !== entry.id) {
      return res.status(409).json({ error: 'Primero debes deshacer la operacion mas reciente de este ' + (entry.scope_tipo === 'debt' ? 'registro' : 'prestamo') + ': "' + top.descripcion + '" (' + top.created_at + ')' });
    }
    let snap;
    try { snap = JSON.parse(entry.snapshot); } catch (_) { return res.status(500).json({ error: 'Snapshot corrupto: no se puede deshacer con seguridad' }); }

    // Candado B (DETECTOR, no gate): si el estado ACTUAL del agregado ya no coincide
    // con el post_hash del journal, algo lo cambio despues (housekeeping del arranque,
    // o una mutacion aun NO cubierta por el journal en esta fase). Se restaura igual
    // y se ADVIERTE — nunca se bloquea en silencio.
    const drift = hashSnapshot(snapshotScope(entry.scope_tipo, entry.scope_id)) !== entry.post_hash;

    const run = db.transaction(() => {
      restoreScope(snap, entry.scope_id);
      if (entry.scope_tipo === 'loan') reHousekeepLoan(entry.scope_id);
      db.prepare("UPDATE undo_journal SET estado='deshecho', undone_at=datetime('now','localtime') WHERE id=?").run(entry.id);
      logAction.run('deshacer', 'Deshiciste: ' + entry.descripcion);
    });
    run();

    res.json({
      ok: true, deshecho: entry.id, accion: entry.accion, scope_id: entry.scope_id,
      warning: drift ? 'El estado habia cambiado desde esta operacion (housekeeping o una mutacion no journalizada). Se restauro el snapshot y se re-aplico el housekeeping; revisa el resultado.' : null
    });
  });

  // ── API: Historial de undo (para la UI y diagnostico) ────────────────────────
  router.get('/api/undo', (req, res) => {
    const { scopeTipo, scopeId } = req.query;
    const cols = 'id, created_at, accion, descripcion, scope_tipo, scope_id, estado, undone_at, afecta_caja';
    const rows = (scopeTipo && scopeId)
      ? db.prepare('SELECT ' + cols + " FROM undo_journal WHERE scope_tipo=? AND scope_id=? ORDER BY rowid DESC LIMIT 50").all(scopeTipo, scopeId)
      : db.prepare('SELECT ' + cols + ' FROM undo_journal ORDER BY rowid DESC LIMIT 50').all();
    res.json(rows);
  });

  return router;
};
