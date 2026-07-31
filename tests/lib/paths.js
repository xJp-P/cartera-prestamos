// tests/lib/paths.js — rutas canonicas del arnes de verificacion.
//
// REGLA DE ORO: la BD productiva del usuario JAMAS se abre en modo escritura.
// Todo test que necesite una BD trabaja sobre una COPIA (ver lib/db.js).

const path = require('path');
const os   = require('os');

const REPO       = path.join(__dirname, '..', '..');
const PUBLIC_DIR = path.join(REPO, 'public');
const BACKEND    = path.join(REPO, 'backend');
const INDEX_HTML = path.join(PUBLIC_DIR, 'index.html');
const SERVER_JS  = path.join(BACKEND, 'server.js');

// BD de produccion — SOLO LECTURA, solo como origen de copias.
// Se puede apuntar a otra con la variable de entorno CARTERA_DB; el valor por
// defecto es la ruta de la maquina de desarrollo. Va por entorno y no fijo en el
// codigo porque este repo es publico y porque en otra maquina la ruta no existe.
const PROD_DB = process.env.CARTERA_DB ||
  path.join(os.homedir(), 'Desktop', 'bd_App_PTM_Backup', 'cartera.db');

// Carpeta de trabajo para copias de BD y artefactos de test.
const WORK = path.join(os.tmpdir(), 'cartera-tests');

module.exports = { REPO, PUBLIC_DIR, BACKEND, INDEX_HTML, SERVER_JS, PROD_DB, WORK };
