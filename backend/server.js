/**
 * server.js — Express API
 * Exporta una función factory que recibe la ruta del DB.
 * desktop/main.js crea el servidor http y llama a .listen().
 */

const express  = require('express');
const Database = require('better-sqlite3');
const path     = require('path');

// Raíz del proyecto (un nivel arriba de /backend)
const PROJECT_ROOT = path.join(__dirname, '..');

// Motor financiero (puro, sin BD ni Express) — Etapa 2/A1 del refactor.
const {
  getPayDate, tasaPeriodo, cuotasHastaHoy, buildSchedule, buildScheduleFixedPMT,
  MODALIDAD_DIARIA, devengoDiario,
} = require('./core/engine');

// Esquema/migraciones y tipos de error — Etapa 2/A2 del refactor.
const { aplicarEsquema } = require('./db/schema');
const { ClientError }    = require('./core/errors');

// Helpers puros, statements y housekeeping — Etapa 2/A3 del refactor.
const { hoyStr, genId }     = require('./core/util');
const { crearStatements }   = require('./db/statements');
const { crearHousekeeping } = require('./db/housekeeping');

// Mutacion atomica/journal y durabilidad de cobros — Etapa 2/A4 del refactor.
const { crearAtomic } = require('./core/atomic');
const {
  snapshotCobros, restaurarCobros, abortarSiHuerfanos,
} = require('./core/cobros');

// Routers — Etapa 2/A5 del refactor. Cada uno exporta (ctx) => Router.
const crearRutasVendor   = require('./routes/vendor');
const crearRutasConfig   = require('./routes/config');
const crearRutasActivity = require('./routes/activity');
const crearRutasUndo     = require('./routes/undo');
const crearRutasRecalc   = require('./routes/recalculate');
const crearRutasDebts    = require('./routes/debts');
const crearRutasPayments = require('./routes/payments');
const crearRutasLoans    = require('./routes/loans');

module.exports = function createApp(dbPath) {

  const app = express();

  // ── Rutas ─────────────────────────────────────────────────────────────────
  // vendor va ANTES de express.json()/static, igual que en el monolito.
  app.use(crearRutasVendor());

  app.use(express.json());
  app.use(express.static(path.join(PROJECT_ROOT, 'public')));

  // ── Base de datos ─────────────────────────────────────────────────────────
  const db = new Database(dbPath);

  // ── Esquema y migraciones ─────────────────────────────────────────────────
  // Viven en db/schema.js (Etapa 2/A2). CORRE ANTES que cualquier db.prepare:
  // `insPayment` nombra 6 columnas que solo existen despues de los ALTER.
  aplicarEsquema(db);

  // ── Sentencias preparadas ─────────────────────────────────────────────────
  // Viven en db/statements.js (Etapa 2/A3). DESPUES de aplicarEsquema(db): 6 de las
  // columnas que nombra `insPayment` solo existen tras los ALTER.
  const { logAction, insPayment, runPayment, insertSchedule, insUndo, logActionUndo } = crearStatements(db);

  // Normalizaciones deterministas de arranque (auto-mora + cuotas en mora de Prestamo).
  const { aplicarHousekeepingArranque, reHousekeepLoan } = crearHousekeeping(db);

  aplicarHousekeepingArranque();

  let APP_VERSION = 'desconocida';
  try { APP_VERSION = require('../package.json').version; } catch (_) {}

  // ── Mutacion atomica + journal de undo ────────────────────────────────────
  // Vive en core/atomic.js (Etapa 2/A4). Es una FACTORY porque `_colsCache` debe
  // ser por instancia de createApp (una cache de columnas por BD), no de modulo.
  const {
    hashSnapshot, snapshotScope, restoreScope, podarJournal, mutacionAtomica,
  } = crearAtomic({ db, insUndo, logActionUndo, appVersion: APP_VERSION });
  podarJournal();

  // ── Montaje de los routers ────────────────────────────────────────────────
  // `ctx` es lo que cada router necesita del closure: la conexion, las sentencias
  // preparadas, el motor y los helpers transversales. Se arma una sola vez.
  const ctx = {
    db, logAction, insPayment, runPayment, insertSchedule,
    mutacionAtomica, hashSnapshot, snapshotScope, restoreScope, podarJournal,
    snapshotCobros, restaurarCobros, abortarSiHuerfanos, reHousekeepLoan,
    buildSchedule, buildScheduleFixedPMT, getPayDate, tasaPeriodo, cuotasHastaHoy,
    MODALIDAD_DIARIA, devengoDiario,
    ClientError, genId, hoyStr,
  };

  app.use(crearRutasConfig(ctx));
  app.use(crearRutasActivity(ctx));
  app.use(crearRutasUndo(ctx));
  app.use(crearRutasRecalc(ctx));
  app.use(crearRutasDebts(ctx));
  app.use(crearRutasPayments(ctx));
  app.use(crearRutasLoans(ctx));

  return app;
};
