// backend/routes/config.js — clave-valor de configuracion.
//
// Extraido de `server.js` en la Etapa 2 (A5) del refactor. Codigo VERBATIM
// (unica sustitucion: `app.X` -> `router.X`).
//
// `PUT /api/config` esta FUERA del journal de undo por decision de negocio (no es
// una mutacion financiera), pero SI es atomico: la atomicidad es independiente del
// undo.

const express = require('express');

module.exports = function crearRutasConfig(ctx) {
  const { db } = ctx;
  const router = express.Router();

  // ── API: Config ───────────────────────────────────────────────────────────
  router.get('/api/config', (_req, res) => {
    const rows = db.prepare('SELECT key, value FROM config').all();
    res.json(Object.fromEntries(rows.map(r => [r.key, r.value])));
  });

  router.put('/api/config', (req, res) => {
    const stmt = db.prepare('INSERT OR REPLACE INTO config(key, value) VALUES (?, ?)');
    // ATOMICO: guarda TODAS las claves o ninguna (antes, un fallo a mitad del bucle dejaba la
    // configuracion a medio guardar). No se journaliza: no es una operacion financiera.
    db.transaction(() => {
      for (const [k, v] of Object.entries(req.body)) stmt.run(k, String(v));
    })();
    res.json({ ok: true });
  });

  return router;
};
