// backend/routes/vendor.js — React UMD servido desde node_modules.
//
// Extraido de `server.js` en la Etapa 2 (A5) del refactor. Codigo VERBATIM
// (la unica sustitucion es `app.get` -> `router.get`, que exige express.Router).
//
// ORDEN DE MIDDLEWARE (importa): este router se monta ANTES de `express.json()` y
// de `express.static`, igual que en el monolito. Son archivos, no API.

const express = require('express');
const path = require('path');

module.exports = function crearRutasVendor() {
  const router = express.Router();

  // ── Servir React desde node_modules (sin internet) ────────────────────────
  // Usamos package.json como punto de entrada porque React 18 restringe
  // el acceso directo a subcarpetas via require.resolve()
  router.get('/vendor/react.js', (_req, res) => {
    const base = path.dirname(require.resolve('react/package.json'));
    res.sendFile(path.join(base, 'umd', 'react.production.min.js'));
  });

  router.get('/vendor/react-dom.js', (_req, res) => {
    const base = path.dirname(require.resolve('react-dom/package.json'));
    res.sendFile(path.join(base, 'umd', 'react-dom.production.min.js'));
  });

  return router;
};
