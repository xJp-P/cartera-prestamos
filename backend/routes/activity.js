// backend/routes/activity.js — historial de acciones.
//
// Extraido de `server.js` en la Etapa 2 (A5) del refactor. Codigo VERBATIM
// (unica sustitucion: `app.X` -> `router.X`).
//
// `activity_log` es APPEND-ONLY: deshacer una operacion no borra su huella, agrega
// una entrada compensatoria de tipo `deshacer`. La columna `undo_id` es lo que
// permite al Historial saber que fila es reversible sin aparear por texto.

const express = require('express');

module.exports = function crearRutasActivity(ctx) {
  const { db } = ctx;
  const router = express.Router();

  // ── API: Historial de acciones ────────────────────────────────────────────
  router.get('/api/activity', (_req, res) => {
    const rows = db.prepare('SELECT * FROM activity_log ORDER BY id DESC LIMIT 100').all();
    res.json(rows);
  });

  return router;
};
