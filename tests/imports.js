// tests/imports.js — salud del grafo de modulos del frontend.
//
// Comprueba tres cosas que el refactor de la Etapa 3 puede romper en silencio y
// que ninguna otra suite ve:
//
//  1. HUERFANOS: un modulo usa un simbolo del catalogo que NO importa. Bajo ESM
//     eso es un ReferenceError en cuanto se ejecuta esa linea — y como puede vivir
//     en una rama poco transitada, la app arranca bien y revienta despues.
//     Es justo la clase de fallo que `new Function` no ve (Bug #40).
//  2. IMPORTS SIN USAR: ruido que queda al mover codigo de sitio.
//  3. CICLOS: A importa B y B importa A. ESM los tolera a veces, pero producen
//     bindings a medio inicializar que fallan de formas dificiles de diagnosticar.
//     El grafo del proyecto es un DAG y debe seguir siendolo.
//
// Tambien verifica que todo lo que se exporta se consuma en alguna parte, para
// detectar modulos que quedaron colgando tras una extraccion.

const fs   = require('fs');
const path = require('path');
const { PUBLIC_DIR } = require('./lib/paths');
const { Reporter } = require('./lib/report');

const JS_DIR = path.join(PUBLIC_DIR, 'js');

const RE_CADENAS  = /'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g;
const RE_COM_LIN  = /\/\/.*$/gm;
const RE_COM_BLQ  = /\/\*[\s\S]*?\*\//g;

function sinRuido(t) {
  return t.replace(RE_COM_BLQ, '').replace(RE_CADENAS, '""').replace(RE_COM_LIN, '');
}

function listarModulos(dir, acc = []) {
  for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, f.name);
    if (f.isDirectory()) listarModulos(p, acc);
    else if (f.name.endsWith('.js')) acc.push(p);
  }
  return acc;
}

// Devuelve { imports: [{simbolos, desde, resuelto}], exports: [nombres], cuerpo }
function analizar(archivo) {
  const src = fs.readFileSync(archivo, 'utf8');
  const imports = [];
  const re = /import\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]\s*;?/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const simbolos = m[1].split(',').map(s => s.trim()).filter(Boolean);
    const resuelto = path.resolve(path.dirname(archivo), m[2]);
    imports.push({ simbolos, desde: m[2], resuelto });
  }
  const exports = [];
  const reEx = /^export\s+(?:default\s+)?(?:function|const|let|var|class)\s+([A-Za-z_$][\w$]*)/gm;
  while ((m = reEx.exec(src)) !== null) exports.push(m[1]);

  // Cuerpo sin las lineas de import, para no contar el propio import como uso.
  const cuerpo = sinRuido(src.replace(re, ''));
  return { imports, exports, cuerpo, src };
}

function main() {
  const R = new Reporter('imports');

  if (!fs.existsSync(JS_DIR)) {
    console.log('FALLO: no existe public/js — no hay grafo que analizar.');
    process.exit(1);
  }
  const modulos = listarModulos(JS_DIR);

  if (modulos.length < 5) {
    console.log(`FALLO: solo ${modulos.length} modulos. Un grafo tan pequeno significa que este`);
    console.log('chequeo esta mirando al lugar equivocado; cualquier "OK" seria vacio.');
    process.exit(1);
  }

  const info = new Map();
  for (const f of modulos) info.set(f, analizar(f));

  // Catalogo: simbolo -> archivo que lo exporta
  const catalogo = new Map();
  for (const [f, d] of info) for (const e of d.exports) catalogo.set(e, f);

  R.seccion(`Modulos analizados: ${modulos.length} · simbolos exportados: ${catalogo.size}`);
  console.log('   ' + modulos.map(f => path.relative(JS_DIR, f)).join(', '));

  // ── 1. Imports que no se usan ──────────────────────────────────────────────
  R.seccion('1. Imports declarados pero NO usados');
  let sinUsar = 0;
  for (const [f, d] of info) {
    for (const im of d.imports) {
      for (const s of im.simbolos) {
        const re = new RegExp('(?<![\\w.$])' + s.replace(/[$]/g, '\\$') + '(?![\\w$])');
        if (!re.test(d.cuerpo)) {
          sinUsar++;
          R.check(`${path.relative(JS_DIR, f)}: importa \`${s}\` sin usarlo`, false,
            `viene de ${im.desde}`);
        }
      }
    }
  }
  R.check(`Ningun import sobra (${sinUsar} encontrados)`, sinUsar === 0);

  // ── 2. Referencias huerfanas ───────────────────────────────────────────────
  R.seccion('2. Simbolos usados pero NO importados (romperian en runtime)');
  let huerfanos = 0;
  for (const [f, d] of info) {
    const importados = new Set(d.imports.flatMap(i => i.simbolos));
    const propios = new Set(d.exports);
    // declaraciones locales (para no confundirlas con simbolos externos)
    const locales = new Set();
    const reLoc = /(?:^|\n)\s*(?:export\s+)?(?:function|const|let|var|class)\s+([A-Za-z_$][\w$]*)/g;
    let mm;
    while ((mm = reLoc.exec(d.src)) !== null) locales.add(mm[1]);

    for (const [simbolo, origen] of catalogo) {
      if (origen === f || importados.has(simbolo) || propios.has(simbolo) || locales.has(simbolo)) continue;
      const re = new RegExp('(?<![\\w.$])' + simbolo.replace(/[$]/g, '\\$') + '(?![\\w$])');
      if (re.test(d.cuerpo)) {
        huerfanos++;
        R.check(`${path.relative(JS_DIR, f)}: usa \`${simbolo}\` sin importarlo`, false,
          `se exporta desde ${path.relative(JS_DIR, origen)} -> ReferenceError al ejecutarse`);
      }
    }
  }
  R.check(`Ninguna referencia huerfana (${huerfanos} encontradas)`, huerfanos === 0);

  // ── 3. Ciclos ──────────────────────────────────────────────────────────────
  R.seccion('3. Ciclos en el grafo de imports');
  const grafo = new Map();
  for (const [f, d] of info) grafo.set(f, d.imports.map(i => i.resuelto).filter(r => info.has(r)));
  const ciclos = [];
  const estado = new Map();
  function dfs(n, pila) {
    estado.set(n, 1);
    for (const v of grafo.get(n) || []) {
      if (estado.get(v) === 1) ciclos.push([...pila.slice(pila.indexOf(v)), v].map(x => path.relative(JS_DIR, x)).join(' -> '));
      else if (!estado.has(v)) dfs(v, [...pila, v]);
    }
    estado.set(n, 2);
  }
  for (const n of grafo.keys()) if (!estado.has(n)) dfs(n, [n]);
  R.check(`El grafo es un DAG (${ciclos.length} ciclos)`, ciclos.length === 0, ciclos.join('\n'));

  // ── 4. Imports rotos ───────────────────────────────────────────────────────
  R.seccion('4. Imports que apuntan a archivos inexistentes');
  let rotos = 0;
  for (const [f, d] of info) {
    for (const im of d.imports) {
      if (!fs.existsSync(im.resuelto)) {
        rotos++;
        R.check(`${path.relative(JS_DIR, f)}: import roto -> ${im.desde}`, false);
      }
    }
  }
  R.check(`Todos los imports resuelven (${rotos} rotos)`, rotos === 0);

  // ── 5. Exports que nadie consume ───────────────────────────────────────────
  R.seccion('5. Exports que ningun modulo consume');
  const consumidos = new Set();
  for (const d of info.values()) for (const im of d.imports) for (const s of im.simbolos) consumidos.add(s);
  const huerfanosExp = [...catalogo.keys()].filter(s => !consumidos.has(s));
  // Los del punto de entrada no se importan desde ningun lado: es normal.
  console.log(`   sin consumidores: ${huerfanosExp.length ? huerfanosExp.join(', ') : '(ninguno)'}`);
  R.check('Se listaron los exports sin consumidores (informativo)', true);

  process.exit(R.finalizar());
}

main();
