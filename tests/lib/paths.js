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

// BD de produccion — SOLO LECTURA, y SOLO la usa `tests/fixture/crear-fixture.js`
// para regenerar el fixture. Ningun test la toca.
// Se puede apuntar a otra con CARTERA_DB; va por entorno y no fijo en el codigo
// porque este repo es publico y porque en otra maquina la ruta no existe.
const PROD_DB = process.env.CARTERA_DB ||
  path.join(os.homedir(), 'Desktop', 'bd_App_PTM_Backup', 'cartera.db');

// BD de la que se alimentan TODOS los tests: misma estructura, mismos importes,
// mismos casos borde que produccion, pero con las identidades sustituidas.
// Se versiona en el repo, asi que la suite es reproducible en cualquier maquina
// y los golden no arrastran datos personales a un repositorio publico.
// Ver tests/fixture/crear-fixture.js.
const FIXTURE_DB = path.join(__dirname, '..', 'fixture', 'cartera-fixture.db');

// Carpeta de trabajo para copias de BD y artefactos de test.
const WORK = path.join(os.tmpdir(), 'cartera-tests');

module.exports = { REPO, PUBLIC_DIR, BACKEND, INDEX_HTML, SERVER_JS, PROD_DB, FIXTURE_DB, WORK };
