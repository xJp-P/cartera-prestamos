// backend/core/util.js — helpers puros compartidos.
//
// Extraidos de `server.js` en la Etapa 2 (A3) del refactor de modularizacion.
// Codigo movido VERBATIM. Ya vivian FUERA del closure `createApp`, asi que
// mudarlos a su propio archivo no cambia su semantica en nada.
//
// Existen como modulo propio porque `db/housekeeping.js` necesita `hoyStr` y los
// routers necesitan `genId`; la alternativa era duplicarlos, que es justo lo que
// este refactor no debe hacer.

// Fecha local (no UTC) en formato YYYY-MM-DD
function hoyStr() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

// ID unico estilo timestamp + sufijo aleatorio (mismo formato que los IDs de loans)
function genId() {
  return Date.now().toString() + Math.random().toString(36).slice(2, 6);
}

module.exports = { hoyStr, genId };
