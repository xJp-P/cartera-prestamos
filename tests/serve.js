// tests/serve.js — levanta el backend REAL sobre una COPIA de la BD, para
// poder cargar la app de verdad en un navegador.
//
// Por que existe: la doctrina del proyecto (convencion #7, leccion del Bug #40)
// exige que todo cambio que toque `App` o un path de render se verifique
// CARGANDO LA APP REAL, no solo con arneses que renderizan en aislamiento.
// `new Function` valida SINTAXIS, NO EJECUCION.
//
// Uso:
//   node tests/serve.js              -> puerto 3421 sobre copia de la BD productiva
//   node tests/serve.js --puerto 4000
//   node tests/serve.js --bd-vacia   -> esquema desde cero, sin datos heredados
//
// Se auto-relanza bajo `ELECTRON_RUN_AS_NODE` porque better-sqlite3 esta
// compilado para el ABI de Electron y no carga en Node standalone.

const path = require('path');

// ── Auto-bootstrap al ABI correcto ───────────────────────────────────────────
if (!process.versions.electron) {
  const { spawn } = require('child_process');
  const electron = path.join(__dirname, '..', 'node_modules', '.bin',
    process.platform === 'win32' ? 'electron.cmd' : 'electron');
  const hijo = spawn(electron, [__filename, ...process.argv.slice(2)], {
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  });
  hijo.on('exit', c => process.exit(c === null ? 1 : c));
  hijo.on('error', e => {
    console.error('No se pudo relanzar bajo Electron:', e.message);
    process.exit(1);
  });
  return;
}

// ── Servidor ────────────────────────────────────────────────────────────────
const { copiaDeProduccion, bdVacia } = require('./lib/db');

const args   = process.argv.slice(2);
const iP     = args.indexOf('--puerto');
const PUERTO = iP !== -1 ? Number(args[iP + 1]) : 3421;
const VACIA  = args.includes('--bd-vacia');

const dbPath = VACIA ? bdVacia('serve') : copiaDeProduccion('serve');
console.log('BD (copia de trabajo):', dbPath);

const createApp = require('../backend/server');
const app = createApp(dbPath);

// Sin cache: durante el refactor los modulos cambian a cada paso y un
// index.html o un /js/*.js servido desde cache produce diagnosticos falsos.
//
// OJO 1: `createApp` ya registro `express.static`, que responde y CORTA la cadena;
// una capa agregada aqui nunca se ejecutaria para los archivos estaticos (se
// comprobo: seguian saliendo con `Cache-Control: public, max-age=0`). Por eso la
// movemos al FRENTE del stack del router. Es un truco de arnes, no de produccion.
//
// OJO 2: al quedar en la posicion 0 corre ANTES del `expressInit` de Express, que
// es quien agrega `res.set`. Usamos `res.setHeader`, nativo de http.ServerResponse,
// que existe desde el primer instante. (Con `res.set` todo respondia 500.)
app.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
if (app._router && Array.isArray(app._router.stack)) {
  app._router.stack.unshift(app._router.stack.pop());
} else {
  console.warn('AVISO: no se pudo anteponer la capa no-store; puede haber cache de modulos.');
}

const srv = app.listen(PUERTO, '127.0.0.1', () => {
  console.log(`Cartera (backend real) escuchando en http://127.0.0.1:${PUERTO}`);
  console.log('Ctrl+C para detener. La BD productiva NO se toca.');
});

function apagar() { srv.close(() => process.exit(0)); setTimeout(() => process.exit(0), 1500); }
process.on('SIGINT', apagar);
process.on('SIGTERM', apagar);
