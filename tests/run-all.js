// tests/run-all.js — corre TODA la suite de verificacion con un solo comando.
//
//   node tests/run-all.js
//   node tests/run-all.js --solo syntax,hooks-order
//   node tests/run-all.js --actualizar        (regenera los golden master a proposito)
//
// Se auto-relanza bajo `ELECTRON_RUN_AS_NODE` porque better-sqlite3 esta compilado
// para el ABI de Electron y no carga en Node standalone (convencion #5 del proyecto).

const path = require('path');
const { spawnSync, spawn } = require('child_process');

const ELECTRON = path.join(__dirname, '..', 'node_modules', '.bin',
  process.platform === 'win32' ? 'electron.cmd' : 'electron');

// ── Auto-bootstrap al ABI correcto ───────────────────────────────────────────
if (!process.versions.electron) {
  const hijo = spawn(ELECTRON, [__filename, ...process.argv.slice(2)], {
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  });
  hijo.on('exit', c => process.exit(c === null ? 1 : c));
  hijo.on('error', e => { console.error('No se pudo relanzar bajo Electron:', e.message); process.exit(1); });
  return;
}

// ── Suites ───────────────────────────────────────────────────────────────────
// Orden deliberado: primero lo barato y estatico (falla rapido y con el mensaje
// mas claro), despues lo que arranca servidores y toca BD.
const SUITES = [
  { nombre: 'syntax',        archivo: 'syntax.js',        desc: 'sintaxis de backend, desktop y frontend' },
  { nombre: 'hooks-order',   archivo: 'hooks-order.js',   desc: 'ningun hook bajo un return condicional (Bug #40)' },
  { nombre: 'imports',       archivo: 'imports.js',       desc: 'grafo de modulos: sin huerfanos, sin ciclos, sin imports muertos' },
  { nombre: 'motor-diario',  archivo: 'motor-diario.js',  desc: 'invariantes del devengo de interes diario (motor puro)' },
  { nombre: 'props-dominio', archivo: 'props-dominio.js', desc: 'invariantes de imputacion, saldos y flujo de caja' },
  { nombre: 'pdf-render',    archivo: 'pdf-render.js',    desc: 'estructura de los generadores de PDF (golden master)' },
  { nombre: 'e2e-api',       archivo: 'e2e-api.js',       desc: 'todos los endpoints contra el server.js real' },
  { nombre: 'cascada-cobro', archivo: 'cascada-cobro.js', desc: 'orquestador de cobro en cascada (mora -> abono) contra el server real' },
  { nombre: 'condonacion',   archivo: 'condonacion.js',   desc: 'condonar intereses: la obligacion baja sin mover un peso de caja' },
];

const args  = process.argv.slice(2);
const iSolo = args.indexOf('--solo');
const filtro = iSolo !== -1 ? String(args[iSolo + 1] || '').split(',').map(s => s.trim()).filter(Boolean) : null;
const extra  = args.filter(a => a.startsWith('--') && a !== '--solo').filter(a => a !== '--solo');

const fs = require('fs');
const aCorrer = SUITES.filter(s => !filtro || filtro.includes(s.nombre));

if (aCorrer.length === 0) {
  console.log(`Ningun suite coincide con --solo ${filtro && filtro.join(',')}`);
  console.log('Disponibles:', SUITES.map(s => s.nombre).join(', '));
  process.exit(1);
}

console.log('='.repeat(70));
console.log('  SUITE DE VERIFICACION — Cartera');
console.log(`  node ${process.versions.node} · electron ${process.versions.electron}`);
console.log('='.repeat(70));

const resultados = [];
let ausentes = 0;

for (const s of aCorrer) {
  const ruta = path.join(__dirname, s.archivo);
  console.log(`\n${'-'.repeat(70)}\n>>> ${s.nombre} — ${s.desc}\n${'-'.repeat(70)}`);

  if (!fs.existsSync(ruta)) {
    // Un suite que falta NO es un exito: se cuenta como fallo.
    console.log(`AUSENTE: no existe ${s.archivo}`);
    resultados.push({ nombre: s.nombre, code: 127, estado: 'AUSENTE' });
    ausentes++;
    continue;
  }

  const r = spawnSync(process.execPath, [ruta, ...extra], {
    stdio: 'inherit',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  });
  const code = r.status === null ? 1 : r.status;
  resultados.push({ nombre: s.nombre, code, estado: code === 0 ? 'OK' : 'FALLO' });
}

// ── Resumen ──────────────────────────────────────────────────────────────────
console.log(`\n${'='.repeat(70)}\n  RESUMEN\n${'='.repeat(70)}`);
for (const r of resultados) {
  const marca = r.estado === 'OK' ? ' OK  ' : r.estado === 'AUSENTE' ? 'AUSEN' : 'FALLO';
  console.log(`  [${marca}] ${r.nombre}${r.code ? `   (exit ${r.code})` : ''}`);
}

const fallidos = resultados.filter(r => r.code !== 0);
console.log('');
if (fallidos.length === 0) {
  console.log(`  TODO VERDE — ${resultados.length}/${resultados.length} suites.`);
} else {
  console.log(`  ${fallidos.length} de ${resultados.length} suites con problemas: ${fallidos.map(f => f.nombre).join(', ')}`);
  if (ausentes) console.log(`  (${ausentes} suite(s) ausente(s) — un archivo que falta cuenta como fallo, nunca como exito)`);
}
console.log('');
console.log('  Recordatorio: esta suite NO reemplaza cargar la app real en un navegador.');
console.log('  `new Function` valida sintaxis, no ejecucion (Bug #40). Ver tests/README.md.');
console.log('');

process.exit(fallidos.length === 0 ? 0 : 1);
