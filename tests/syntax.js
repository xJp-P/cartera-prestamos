// tests/syntax.js — validador estatico de sintaxis de TODO el codigo del proyecto.
//
// ############################################################################
// #  POR QUE EXISTE ESTE ARCHIVO                                             #
// #                                                                          #
// #  El validador de la sesion anterior "pasaba EN VACIO": se saltaba los    #
// #  <script src=...>, y cuando no encontraba bloque inline imprimia         #
// #  "0 bloques validados" y salia con exit 0. Verde falso.                  #
// #                                                                          #
// #  Este archivo esta construido alrededor de tres defensas:                #
// #                                                                          #
// #  1. AUTODIAGNOSTICO — antes de validar nada real, el validador se        #
// #     valida a si mismo: comprueba que ACEPTA codigo bueno y que RECHAZA   #
// #     codigo roto, en las dos estrategias (clasica y modulo ES). Si el     #
// #     instrumento no detecta un error plantado a proposito, no sirve de    #
// #     nada que despues diga "todo OK".                                     #
// #                                                                          #
// #  2. COBERTURA POR TRES VIAS — no confia en una sola fuente:              #
// #       a) barrido recursivo de backend/ y desktop/                        #
// #       b) los <script> de index.html (inline Y src), siguiendo ademas el  #
// #          grafo de imports de los modulos de forma transitiva             #
// #       c) barrido de huerfanos: cualquier .js/.mjs bajo public/ que no    #
// #          haya sido alcanzado por (b) se valida igual y se reporta        #
// #     Sin (c), el refactor podria mover 6.000 lineas a modulos que nadie   #
// #     referencia todavia y el validador seguiria en verde con 1 archivo.   #
// #                                                                          #
// #  3. BARRERA ANTI-VACIO — minimos duros al final. Si valido menos de lo   #
// #     esperado (0 bloques de frontend, <2 archivos de backend/desktop),    #
// #     FALLA con exit != 0 y explica por que, aunque no haya errores de     #
// #     sintaxis.                                                            #
// #                                                                          #
// #  4. PISO DE VOLUMEN — contar BLOQUES no alcanza. Verificado de forma     #
// #     adversarial: si el <script> inline se reduce a `var a=1;` la suite   #
// #     seguia diciendo 19/19 OK porque "1 bloque de frontend" cumplia el    #
// #     piso, aunque se hubieran evaporado 565 KB de codigo. El refactor va  #
// #     justamente a MOVER ese codigo: si el destino no queda cableado, lo   #
// #     que sobrevive es un stub que parsea perfecto. Por eso ademas de      #
// #     contar unidades se mide el VOLUMEN total validado por grupo.         #
// ############################################################################
//
// EJECUCION (better-sqlite3 esta compilado para el ABI de Electron; este test
// no toca la BD, pero se corre igual que el resto del arnes para uniformidad):
//   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron tests/syntax.js

'use strict';

const fs   = require('fs');
const vm   = require('vm');
const path = require('path');
const { spawnSync } = require('child_process');

const { Reporter }        = require('./lib/report');
const { escanearScripts } = require('./lib/load-frontend');
const { REPO, PUBLIC_DIR, BACKEND, INDEX_HTML, WORK } = require('./lib/paths');

const DESKTOP = path.join(REPO, 'desktop');

const R = new Reporter('syntax');

// ── Minimos de la barrera anti-vacio ─────────────────────────────────────────
// Se ajustan hacia ARRIBA cuando el refactor parta el frontend en modulos.
const MIN_FRONTEND = 1;  // al menos 1 bloque/archivo de frontend validado
const MIN_BACKEND  = 2;  // backend/server.js + desktop/main.js como piso
const MIN_TOTAL    = 3;

// ── Pisos de VOLUMEN (defensa 4) ─────────────────────────────────────────────
// Contar unidades no distingue "565 KB de frontend" de "un stub de 8 caracteres".
// Estos pisos miden el total de caracteres validados por grupo, sin importar en
// cuantas unidades este repartido: el refactor puede partir el inline en 20
// modulos y el total apenas cambia (crece un poco con import/export), pero si el
// codigo se PIERDE el total se desploma y esto lo caza.
//
// Estado medido hoy (v2.3.0, sin refactorizar):
//   frontend        565.734 car. (el unico <script> inline)
//   backend/desktop 148.898 car. (server.js 116.036 + main.js 31.796 + preload 1.066)
// Los pisos van holgados (~30% de margen) para no dar rojos por el ruido normal
// del refactor. Si algun dia se borra codigo A PROPOSITO, se bajan A MANO y con
// intencion — que es exactamente el punto: que la perdida sea una decision, no
// un accidente que pasa en verde.
const MIN_CHARS_FRONTEND = 400000;
const MIN_CHARS_BACKEND  = 100000;

// ── Contabilidad global ──────────────────────────────────────────────────────
const validados = {
  frontend: [],   // { etiqueta, modo, bytes, origen }
  backend:  [],
  otros:    [],   // codigo del proyecto fuera de public//backend//desktop
  omitidos: [],   // { etiqueta, motivo }
  errores:  [],   // { etiqueta, detalle }
};

const yaValidados = new Set(); // rutas absolutas normalizadas, para no repetir

const norm = p => path.resolve(p).toLowerCase();
const rel  = p => path.relative(REPO, p).replace(/\\/g, '/');

// ─────────────────────────────────────────────────────────────────────────────
// ESTRATEGIAS DE VALIDACION
// ─────────────────────────────────────────────────────────────────────────────

// Formatea un SyntaxError de vm/subproceso en algo accionable: archivo, linea,
// el fragmento con el cursor ^, y el mensaje.
function detallarError(e, etiqueta) {
  const stack = (e && e.stack) ? String(e.stack) : String(e);
  // El code-frame de V8 son las primeras lineas del stack, antes del primer "    at ".
  const lineas = stack.split('\n');
  const corte  = lineas.findIndex(l => /^\s+at\s/.test(l));
  const marco  = (corte > 0 ? lineas.slice(0, corte) : lineas.slice(0, 5)).join('\n');
  return `[${etiqueta}]\n${marco}`;
}

// Extrae "archivo:linea" del code-frame para poder reportar la linea a secas.
function lineaDelError(txt) {
  const m = /:(\d+)\s*$/m.exec(String(txt).split('\n')[1] || String(txt).split('\n')[0] || '');
  return m ? Number(m[1]) : null;
}

// --- Estrategia CLASICA -----------------------------------------------------
// Scripts de navegador (<script> sin type=module) y modulos CommonJS.
//
// Para CommonJS se envuelve en el mismo wrapper que usa Node
// ("(function (exports, require, module, __filename, __dirname) { ... })"),
// porque sin el un `return` de nivel superior — legal en CJS — se reportaria
// como error de sintaxis. El wrapper se abre en la MISMA linea 1, asi que los
// numeros de linea del error siguen coincidiendo con el archivo.
function validarClasico(codigo, opts) {
  const o = opts || {};
  const fuente = o.cjs
    ? '(function (exports, require, module, __filename, __dirname) { ' + codigo + '\n});'
    : codigo;
  try {
    // Construir un vm.Script PARSEA el codigo completo sin ejecutarlo.
    new vm.Script(fuente, {
      filename:   o.filename || o.etiqueta || '<anonimo>',
      lineOffset: o.lineOffset || 0,
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, detalle: detallarError(e, o.etiqueta || o.filename || '<anonimo>') };
  }
}

// --- Estrategia MODULO ES ---------------------------------------------------
// `new vm.Script` NO puede parsear `import`/`export`: los rechaza como error de
// sintaxis. Un modulo hay que parsearlo como modulo. Dos caminos, en orden:
//
//   A) `vm.SourceTextModule` — solo existe si el proceso arranco con
//      --experimental-vm-modules. Construirlo PARSEA sin ejecutar ni resolver
//      imports. Es el camino preciso y en-proceso.
//
//   B) subproceso `process.execPath --check <tmp>.mjs` — SIEMPRE disponible.
//      Se escribe el codigo VERBATIM a un temporal con extension .mjs para que
//      Node lo parsee con la gramatica de modulo; `--check` solo comprueba
//      sintaxis, no ejecuta ni resuelve imports. Como la copia es literal, los
//      numeros de linea del error coinciden con los del archivo original.
//      (Verificado: `--check` sobre un .mjs valido da exit 0; sobre uno roto,
//      exit 1 con el code-frame.)
//
// Si NINGUNO de los dos esta disponible, la funcion NO devuelve "ok": devuelve
// un fallo ruidoso. Saltarse los modulos en silencio es el modo de fallo que
// este archivo existe para impedir.
let ESTRATEGIA_MODULO = null; // se resuelve una sola vez

function elegirEstrategiaModulo() {
  if (ESTRATEGIA_MODULO) return ESTRATEGIA_MODULO;
  if (typeof vm.SourceTextModule === 'function') {
    ESTRATEGIA_MODULO = 'SourceTextModule';
  } else {
    // Probar el subproceso con una muestra conocida antes de confiar en el.
    const prueba = validarModuloPorSubproceso('export const _p = 1;\n', '<sonda>');
    ESTRATEGIA_MODULO = prueba.disponible ? 'subproceso --check' : 'NINGUNA';
  }
  return ESTRATEGIA_MODULO;
}

function asegurarWork() {
  if (!fs.existsSync(WORK)) fs.mkdirSync(WORK, { recursive: true });
  return WORK;
}

let contadorTmp = 0;
function validarModuloPorSubproceso(codigo, etiqueta) {
  asegurarWork();
  const tmp = path.join(WORK, `syntax-mod-${process.pid}-${contadorTmp++}.mjs`);
  try {
    fs.writeFileSync(tmp, codigo, 'utf8');
    const r = spawnSync(process.execPath, ['--check', tmp], {
      encoding: 'utf8',
      env: Object.assign({}, process.env, { ELECTRON_RUN_AS_NODE: '1' }),
      windowsHide: true,
    });
    if (r.error) return { disponible: false, ok: false, detalle: `[${etiqueta}] no se pudo lanzar el subproceso: ${r.error.message}` };
    if (r.status === 0) return { disponible: true, ok: true };
    const salida = String(r.stderr || r.stdout || '').trim();
    // El temporal aparece en el mensaje: se sustituye por la etiqueta real.
    const limpio = salida.split('\n').slice(0, 6).join('\n').split(tmp).join(etiqueta);
    return { disponible: true, ok: false, detalle: `[${etiqueta}]\n${limpio}` };
  } catch (e) {
    return { disponible: false, ok: false, detalle: `[${etiqueta}] fallo del subproceso: ${e.message}` };
  } finally {
    try { fs.unlinkSync(tmp); } catch (_) { /* da igual */ }
  }
}

function validarModulo(codigo, etiqueta) {
  const est = elegirEstrategiaModulo();
  if (est === 'SourceTextModule') {
    try {
      // Construirlo basta para parsear; NO se llama a link() ni evaluate().
      new vm.SourceTextModule(codigo, { identifier: etiqueta });
      return { ok: true };
    } catch (e) {
      return { ok: false, detalle: detallarError(e, etiqueta) };
    }
  }
  if (est === 'subproceso --check') {
    const r = validarModuloPorSubproceso(codigo, etiqueta);
    return { ok: r.ok, detalle: r.detalle };
  }
  return {
    ok: false,
    detalle: `[${etiqueta}] NO HAY ESTRATEGIA PARA VALIDAR MODULOS ES.\n` +
             `  vm.SourceTextModule ausente (falta --experimental-vm-modules) y el\n` +
             `  subproceso "--check" tampoco funciona. Un modulo NO se puede validar\n` +
             `  con vm.Script. Se falla a proposito en vez de saltarselo en silencio.`,
  };
}

// Heuristica de clasificacion cuando el HTML no lo dice (barrido de huerfanos).
function pareceModulo(codigo) {
  return /^\s*(?:import|export)\s/m.test(codigo) ||
         /^\s*import\s*[({'"]/m.test(codigo);
}

// Valida un archivo de disco eligiendo modo. Registra en `validados`.
function validarArchivo(ruta, opts) {
  const o = opts || {};
  const clave = norm(ruta);
  if (yaValidados.has(clave)) return { ok: true, repetido: true };
  yaValidados.add(clave);

  let codigo;
  try {
    codigo = fs.readFileSync(ruta, 'utf8');
  } catch (e) {
    const detalle = `[${rel(ruta)}] no se pudo leer: ${e.message}`;
    validados.errores.push({ etiqueta: rel(ruta), detalle });
    R.check(`leer ${rel(ruta)}`, false, detalle);
    return { ok: false };
  }

  let modo = o.modo;
  if (!modo) modo = (path.extname(ruta) === '.mjs' || pareceModulo(codigo)) ? 'modulo' : 'clasico';

  let r;
  if (modo === 'modulo') {
    r = validarModulo(codigo, rel(ruta));
  } else {
    r = validarClasico(codigo, { etiqueta: rel(ruta), filename: rel(ruta), cjs: !!o.cjs });
    // Un .js del frontend puede ser modulo sin que el HTML lo declare: si el
    // parseo clasico falla, se reintenta como modulo antes de dar por roto.
    if (!r.ok && !o.cjs) {
      const alt = validarModulo(codigo, rel(ruta));
      if (alt.ok) { r = alt; modo = 'modulo (detectado en reintento)'; }
    }
    // Archivo sin clasificar (grupo "otros"): tampoco se sabe si es CommonJS.
    // Se prueba el ultimo sistema de modulos que queda antes de darlo por roto;
    // un `return` top-level legal no debe reportarse como error de sintaxis.
    if (!r.ok && !o.cjs && o.grupo === 'otros') {
      const alt = validarClasico(codigo, { etiqueta: rel(ruta), filename: rel(ruta), cjs: true });
      if (alt.ok) { r = alt; modo = 'commonjs (detectado en reintento)'; }
    }
  }

  const ficha = { etiqueta: rel(ruta), modo, bytes: codigo.length, origen: o.origen || 'archivo' };
  if (r.ok) {
    const bolsa = o.grupo === 'backend' ? validados.backend
                : o.grupo === 'otros'   ? validados.otros
                : validados.frontend;
    bolsa.push(ficha);
  } else {
    validados.errores.push({ etiqueta: rel(ruta), detalle: r.detalle });
  }
  R.check(`sintaxis OK — ${rel(ruta)} (${modo}, ${codigo.length} car.)`, r.ok, r.detalle);
  return { ok: r.ok, codigo, modo, ruta };
}

// ─────────────────────────────────────────────────────────────────────────────
// RESOLUCION DE REFERENCIAS (src de <script> e imports entre modulos)
// ─────────────────────────────────────────────────────────────────────────────

function esVendor(spec) {
  const s = String(spec).replace(/\\/g, '/').toLowerCase();
  return /(^|\/)vendor\//.test(s);
}

function esExterno(spec) {
  return /^(?:[a-z][a-z0-9+.-]*:)?\/\//i.test(spec) || /^(?:data|blob|node):/i.test(spec);
}

// Resuelve un especificador a un archivo de disco.
//   raizUrl  — como resuelve el navegador un src que empieza por "/": PUBLIC_DIR.
//   desde    — archivo que hace la referencia (para specs relativos).
function resolver(spec, desde) {
  const limpio = String(spec).split('?')[0].split('#')[0];
  if (!limpio) return { tipo: 'externo', motivo: 'especificador vacio' };
  if (esExterno(limpio)) return { tipo: 'externo', motivo: 'URL absoluta / protocolo' };
  // Especificador "pelado" (react, lodash): dependencia, no codigo del proyecto.
  if (!/^[./]/.test(limpio)) return { tipo: 'externo', motivo: 'especificador pelado (dependencia)' };

  const base = limpio.startsWith('/')
    ? path.join(PUBLIC_DIR, limpio.slice(1))
    : path.resolve(path.dirname(desde), limpio);

  const cands = [base, base + '.js', base + '.mjs', path.join(base, 'index.js'), path.join(base, 'index.mjs')];
  for (const c of cands) {
    try { if (fs.statSync(c).isFile()) return { tipo: 'archivo', ruta: c }; } catch (_) { /* siguiente */ }
  }
  return { tipo: 'roto', intentos: cands.map(rel) };
}

// Blanquea comentarios (// y /* */) conservando los saltos de linea, sin tocar
// el contenido de las cadenas. Se usa SOLO para el descubrimiento de imports:
// la validacion de sintaxis siempre corre sobre el codigo ORIGINAL.
//
// Por que hace falta: sin esto, un `@see import('./tipos.js')` en un JSDoc o un
// `// migrar: import './legado.js'` se leian como imports REALES y, al no
// resolver a disco, la suite daba un ROJO por un comentario. Verificado de
// forma adversarial: dos comentarios asi tumbaban la corrida entera. Un falso
// rojo durante el refactor es tan inutil como un falso verde.
//
// El modo de fallo de este barrido es benigno por diseno: si se equivoca, se
// PIERDE un import del grafo — y ese archivo lo recoge igual el barrido de
// huerfanos de public/. Nunca puede inventar un import que no existe.
function quitarComentarios(src) {
  let out = '';
  let modo = 'codigo';   // codigo | linea | bloque | cadena
  let comilla = '';
  for (let i = 0; i < src.length; i++) {
    const c = src[i], d = src[i + 1];
    if (modo === 'codigo') {
      if (c === '/' && d === '/') { modo = 'linea';  i++; continue; }
      if (c === '/' && d === '*') { modo = 'bloque'; i++; continue; }
      if (c === '"' || c === "'" || c === '`') { modo = 'cadena'; comilla = c; }
      out += c;
    } else if (modo === 'linea') {
      if (c === '\n') { modo = 'codigo'; out += c; }
    } else if (modo === 'bloque') {
      if (c === '*' && d === '/') { modo = 'codigo'; i++; }
      else if (c === '\n') { out += c; }
    } else { // cadena
      out += c;
      if (c === '\\') { out += (d === undefined ? '' : d); i++; }
      else if (c === comilla) { modo = 'codigo'; }
    }
  }
  return out;
}

// Descubre las referencias de un modulo ES a otros archivos locales.
// Regex y no un parser de verdad: alcanza para el DESCUBRIMIENTO, y el barrido
// de huerfanos es la red que atrapa lo que se escape.
function referenciasDeModulo(codigoCrudo) {
  const codigo = quitarComentarios(codigoCrudo);
  const specs = new Set();
  const patrones = [
    /\bfrom\s*['"]([^'"]+)['"]/g,           // import X from '...' / export * from '...'
    /\bimport\s*['"]([^'"]+)['"]/g,          // import '...' (efecto colateral)
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g, // import('...')
  ];
  for (const re of patrones) {
    let m;
    while ((m = re.exec(codigo)) !== null) specs.add(m[1]);
  }
  return Array.from(specs);
}

// Recorre el grafo de imports desde un modulo raiz, validando todo lo local.
function recorrerGrafo(rutaRaiz, grupo) {
  const pila = [rutaRaiz];
  let n = 0;
  while (pila.length) {
    const actual = pila.pop();
    if (yaValidados.has(norm(actual))) continue;
    const r = validarArchivo(actual, { modo: 'modulo', grupo, origen: 'grafo de imports' });
    n++;
    if (!r.codigo) continue;
    for (const spec of referenciasDeModulo(r.codigo)) {
      const res = resolver(spec, actual);
      if (res.tipo === 'archivo') { pila.push(res.ruta); }
      else if (res.tipo === 'roto') {
        const detalle = `import "${spec}" desde ${rel(actual)} no resuelve a ningun archivo.\n` +
                        `  intentos: ${res.intentos.join(', ')}`;
        validados.errores.push({ etiqueta: rel(actual), detalle });
        R.check(`import resuelto — "${spec}" desde ${rel(actual)}`, false, detalle);
      } else {
        validados.omitidos.push({ etiqueta: spec, motivo: `import externo (${res.motivo})` });
      }
    }
  }
  return n;
}

// ─────────────────────────────────────────────────────────────────────────────
// BARRIDOS DE DIRECTORIO
// ─────────────────────────────────────────────────────────────────────────────

function barrerJs(dir, opts) {
  const o = opts || {};
  const ignorar = new Set(['node_modules', '.git', 'dist', 'build', 'out', 'coverage']);
  for (const extra of (o.ignorarExtra || [])) ignorar.add(extra);
  const salida = [];
  (function anda(d) {
    let entradas;
    try { entradas = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
    for (const e of entradas) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        if (ignorar.has(e.name)) continue;
        if (o.saltarVendor && e.name.toLowerCase() === 'vendor') continue;
        anda(p);
      } else if (/\.(?:js|mjs|cjs)$/i.test(e.name)) {
        salida.push(p);
      }
    }
  })(dir);
  return salida.sort();
}

// ─────────────────────────────────────────────────────────────────────────────
// 1) AUTODIAGNOSTICO — el validador se valida a si mismo
// ─────────────────────────────────────────────────────────────────────────────
R.seccion('1) Autodiagnostico del validador (debe aceptar lo bueno y rechazar lo roto)');

const estrategia = elegirEstrategiaModulo();
console.log(`   estrategia para modulos ES: ${estrategia}`);
R.check('hay una estrategia utilizable para validar modulos ES', estrategia !== 'NINGUNA',
        'Sin SourceTextModule ni subproceso --check no se puede validar un modulo; ' +
        'el validador quedaria ciego ante el refactor a modulos.');

R.check('clasico: ACEPTA codigo valido',
        validarClasico('var a = 1; function f(){ return a; }', { etiqueta: '<sonda-ok>' }).ok);

const sondaRota = validarClasico('var a = ;', { etiqueta: '<sonda-rota>' });
R.check('clasico: RECHAZA codigo roto', sondaRota.ok === false,
        'Si el validador no detecta "var a = ;" no detecta nada.');
R.check('clasico: el rechazo trae detalle accionable',
        !!sondaRota.detalle && /SyntaxError/i.test(sondaRota.detalle), sondaRota.detalle);

R.check('cjs: ACEPTA un `return` de nivel superior (semantica CommonJS)',
        validarClasico('if (!process.env.X) return;\nmodule.exports = 1;\n', { etiqueta: '<sonda-cjs>', cjs: true }).ok,
        'Sin el wrapper de Node, un return top-level de un .js de backend daria falso positivo.');

R.check('clasico: RECHAZA `export` (por eso los modulos necesitan otra estrategia)',
        validarClasico('export const a = 1;', { etiqueta: '<sonda-export>' }).ok === false);

if (estrategia !== 'NINGUNA') {
  R.check('modulo: ACEPTA `import`/`export` validos',
          validarModulo('import x from "y";\nexport const a = x;\n', '<sonda-mod-ok>').ok);
  const modRoto = validarModulo('export const a = ;\n', '<sonda-mod-rota>');
  R.check('modulo: RECHAZA un modulo roto', modRoto.ok === false,
          'El validador de modulos no detecta errores -> inservible.');
  R.check('modulo: el rechazo trae detalle accionable',
          !!modRoto.detalle && /SyntaxError|Unexpected/i.test(modRoto.detalle), modRoto.detalle);
}

// El descubrimiento de imports debe leer CODIGO, no comentarios. Si esto se
// rompe, la suite empieza a dar rojos por un JSDoc y deja de ser utilizable.
R.check('imports: IGNORA los especificadores que viven en un comentario',
        (() => {
          const specs = referenciasDeModulo(
            "// migrar esto: import './legado.js'\n" +
            "/** @see import('./tipos.js') */\n" +
            "/* import './viejo.js' */\n" +
            "import { u } from './util.js';\n");
          return specs.length === 1 && specs[0] === './util.js';
        })(),
        'Un import comentado se leia como real y daba un rojo falso.');

R.check('imports: NO confunde una cadena que contiene "//" con un comentario',
        (() => {
          const specs = referenciasDeModulo(
            "const url = 'http://x/y'; // ojo\nimport { a } from './a.js';\n");
          return specs.length === 1 && specs[0] === './a.js';
        })());

R.check('imports: SIGUE detectando los imports reales (from / desnudo / dinamico)',
        (() => {
          const specs = referenciasDeModulo(
            "import a from './a.js';\nimport './b.js';\nconst c = await import('./c.js');\n" +
            "export * from './d.js';\n").sort();
          return JSON.stringify(specs) === JSON.stringify(['./a.js', './b.js', './c.js', './d.js']);
        })(),
        'Quitar comentarios no puede quitar tambien los imports de verdad.');

R.check('escanearScripts distingue inline de externos',
        (() => {
          const s = escanearScripts('<script src="/v/a.js"></script><script>var q=1;</script>' +
                                    '<script type="module" src="/js/m.js"></script>');
          return s.inline.length === 1 && s.externos.length === 2 &&
                 s.externos[1].type === 'module';
        })());

// ─────────────────────────────────────────────────────────────────────────────
// 2) BACKEND + DESKTOP
// ─────────────────────────────────────────────────────────────────────────────
R.seccion('2) backend/ y desktop/ (barrido recursivo, semantica CommonJS)');

const archivosNode = barrerJs(BACKEND).concat(barrerJs(DESKTOP));
R.check('el barrido encontro archivos en backend/ y desktop/', archivosNode.length > 0,
        `backend=${BACKEND}\ndesktop=${DESKTOP}\nEncontrados: 0. Rutas mal o proyecto movido.`);

for (const f of archivosNode) {
  validarArchivo(f, { grupo: 'backend', cjs: true, modo: 'clasico', origen: 'barrido backend/desktop' });
}

// ─────────────────────────────────────────────────────────────────────────────
// 3) FRONTEND — los <script> de index.html
// ─────────────────────────────────────────────────────────────────────────────
R.seccion('3) public/index.html — <script> inline y <script src>');

let html = null;
try {
  html = fs.readFileSync(INDEX_HTML, 'utf8');
} catch (e) {
  R.check('leer public/index.html', false, `${INDEX_HTML}: ${e.message}`);
}

let scan = { inline: [], externos: [] };
if (html !== null) {
  scan = escanearScripts(html);
  console.log(`   <script> inline: ${scan.inline.length}   <script src>: ${scan.externos.length}`);

  // --- Requisito 5: estado intermedio del refactor (inline Y externos propios)
  const externosPropios = scan.externos.filter(e => !esVendor(e.src) && !esExterno(e.src));
  if (scan.inline.length > 0 && externosPropios.length > 0) {
    console.log('   AVISO (no es error): index.html tiene inline Y scripts propios externos a la vez.');
    console.log('          Estado intermedio del refactor. Externos propios: ' +
                externosPropios.map(e => e.src).join(', '));
  } else if (scan.inline.length > 0) {
    console.log('   Estado: 100% inline (pre-refactor).');
  } else if (externosPropios.length > 0) {
    console.log('   Estado: 100% externo (post-refactor).');
  }

  // --- Bloques inline -------------------------------------------------------
  scan.inline.forEach((blk, i) => {
    // `start` es la linea del HTML donde abre <script>; el contenido arranca en
    // esa misma linea, asi que lineOffset = start-1 hace que los numeros de
    // linea del error coincidan con los del archivo HTML.
    const etiqueta = `public/index.html <script> #${i + 1} (lineas ${blk.start}-${blk.end})`;
    const esMod = pareceModulo(blk.code);
    const r = esMod
      ? validarModulo(blk.code, etiqueta)
      : validarClasico(blk.code, { etiqueta, filename: 'public/index.html', lineOffset: blk.start - 1 });
    if (r.ok) {
      validados.frontend.push({ etiqueta, modo: esMod ? 'modulo' : 'clasico', bytes: blk.code.length, origen: 'inline' });
    } else {
      validados.errores.push({ etiqueta, detalle: r.detalle });
    }
    R.check(`sintaxis OK — ${etiqueta} (${esMod ? 'modulo' : 'clasico'}, ${blk.code.length} car.)`, r.ok, r.detalle);
  });

  // --- Scripts externos -----------------------------------------------------
  for (const ext of scan.externos) {
    if (esVendor(ext.src)) {
      validados.omitidos.push({ etiqueta: ext.src, motivo: 'vendor (libreria de terceros, no es codigo del proyecto)' });
      continue;
    }
    if (esExterno(ext.src)) {
      validados.omitidos.push({ etiqueta: ext.src, motivo: 'URL externa (no esta en disco)' });
      continue;
    }
    const res = resolver(ext.src, INDEX_HTML);
    if (res.tipo === 'externo') {
      validados.omitidos.push({ etiqueta: ext.src, motivo: res.motivo });
      continue;
    }
    if (res.tipo === 'roto') {
      const detalle = `<script src="${ext.src}"> no existe en disco.\n  intentos: ${res.intentos.join(', ')}`;
      validados.errores.push({ etiqueta: ext.src, detalle });
      R.check(`<script src> resuelto — ${ext.src}`, false, detalle);
      continue;
    }
    if (ext.type === 'module') {
      // Modulo raiz: se valida el y TODO lo que importe, transitivamente.
      const n = recorrerGrafo(res.ruta, 'frontend');
      console.log(`   grafo de "${ext.src}": ${n} modulo(s) validado(s)`);
    } else {
      validarArchivo(res.ruta, { grupo: 'frontend', modo: 'clasico', origen: `<script src="${ext.src}">` });
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 4) BARRIDO DE HUERFANOS — .js/.mjs bajo public/ que nadie referencia
// ─────────────────────────────────────────────────────────────────────────────
R.seccion('4) public/ — barrido de huerfanos (codigo propio no referenciado desde el HTML)');

const jsPublic = barrerJs(PUBLIC_DIR, { saltarVendor: true });
const huerfanos = jsPublic.filter(p => !yaValidados.has(norm(p)) && !esVendor(p));
if (huerfanos.length === 0) {
  console.log('   sin huerfanos (todo el .js propio de public/ ya estaba cubierto por el HTML).');
} else {
  console.log(`   ${huerfanos.length} archivo(s) no referenciado(s) desde index.html; se validan igual:`);
  for (const f of huerfanos) {
    console.log(`     - ${rel(f)}`);
    validarArchivo(f, { grupo: 'frontend', origen: 'huerfano en public/' });
  }
}
// Los vendor se registran como omitidos a proposito tambien cuando estan en disco.
for (const f of barrerJs(PUBLIC_DIR).filter(esVendor)) {
  validados.omitidos.push({ etiqueta: rel(f), motivo: 'vendor en disco (libreria de terceros)' });
}

// ─────────────────────────────────────────────────────────────────────────────
// 5) BARRIDO DE RESPALDO — codigo del proyecto fuera de public//backend//desktop
// ─────────────────────────────────────────────────────────────────────────────
// Las tres vias anteriores asumen que el codigo vive donde vive HOY. El refactor
// puede crear `src/`, `shared/` o `lib/` en la raiz y esas vias no lo verian:
// comprobado de forma adversarial (un modulo roto en `src/roto.js` pasaba en
// verde). Esta cuarta via barre el repo entero con una lista de exclusiones
// explicita, de modo que aparecer en un directorio nuevo no equivale a ser
// invisible. Lo ya validado se saltea solo (yaValidados).
R.seccion('5) Barrido de respaldo en la raiz del repo (directorios nuevos del refactor)');

const IGNORAR_RAIZ = ['tests', '.github', '.claude', 'vendor'];
const jsRepo = barrerJs(REPO, { saltarVendor: true, ignorarExtra: IGNORAR_RAIZ });
const fueraDeSitio = jsRepo.filter(p => !yaValidados.has(norm(p)) && !esVendor(p));
if (fueraDeSitio.length === 0) {
  console.log(`   nada fuera de sitio (excluidos a proposito: ${IGNORAR_RAIZ.join(', ')}, node_modules, dist, build).`);
} else {
  console.log(`   ${fueraDeSitio.length} archivo(s) de codigo fuera de public//backend//desktop; se validan igual:`);
  for (const f of fueraDeSitio) {
    console.log(`     - ${rel(f)}`);
    validarArchivo(f, { grupo: 'otros', origen: 'barrido de respaldo del repo' });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 6) INVENTARIO + BARRERA ANTI-VACIO
// ─────────────────────────────────────────────────────────────────────────────
R.seccion('6) Inventario de lo realmente validado');

const nFrontend = validados.frontend.length;
const nBackend  = validados.backend.length;
const nOtros    = validados.otros.length;
const nTotal    = nFrontend + nBackend + nOtros;

const suma = arr => arr.reduce((s, f) => s + f.bytes, 0);
const charsFrontend = suma(validados.frontend);
const charsBackend  = suma(validados.backend);

console.log(`   FRONTEND (${nFrontend}, ${charsFrontend} car.):`);
for (const f of validados.frontend) console.log(`     - ${f.etiqueta}  [${f.modo}, ${f.bytes} car., ${f.origen}]`);
console.log(`   BACKEND/DESKTOP (${nBackend}, ${charsBackend} car.):`);
for (const f of validados.backend)  console.log(`     - ${f.etiqueta}  [${f.modo}, ${f.bytes} car.]`);
if (nOtros) {
  console.log(`   OTROS (${nOtros}, ${suma(validados.otros)} car.):`);
  for (const f of validados.otros) console.log(`     - ${f.etiqueta}  [${f.modo}, ${f.bytes} car., ${f.origen}]`);
}
console.log(`   OMITIDOS A PROPOSITO (${validados.omitidos.length}):`);
for (const o of validados.omitidos) console.log(`     - ${o.etiqueta}  -> ${o.motivo}`);
if (validados.errores.length) {
  console.log(`   CON ERRORES (${validados.errores.length}):`);
  for (const e of validados.errores) console.log(`     - ${e.etiqueta}`);
}
console.log(`   TOTAL VALIDADO: ${nTotal} (frontend ${nFrontend} + backend/desktop ${nBackend}` +
            (nOtros ? ` + otros ${nOtros}` : '') + `)`);

R.seccion('7) Barrera anti-vacio (un verde con 0 validaciones — o con un stub — es el fallo que hay que impedir)');

R.check(`se valido al menos ${MIN_FRONTEND} bloque/archivo de FRONTEND (validados: ${nFrontend})`,
        nFrontend >= MIN_FRONTEND,
        'No se valido nada del frontend. O index.html no tiene <script> propios, o el\n' +
        'refactor los movio a rutas que este validador no resuelve. NO es un exito:\n' +
        'revisa la seccion 3 y el barrido de huerfanos de la seccion 4.');

R.check(`se validaron al menos ${MIN_BACKEND} archivos de BACKEND/DESKTOP (validados: ${nBackend})`,
        nBackend >= MIN_BACKEND,
        `Piso esperado: backend/server.js y desktop/main.js. Encontrados: ` +
        validados.backend.map(f => f.etiqueta).join(', ') || '(ninguno)');

R.check(`el total validado supera el minimo de ${MIN_TOTAL} (total: ${nTotal})`, nTotal >= MIN_TOTAL);

// --- Pisos de VOLUMEN (defensa 4) -------------------------------------------
// Contar unidades no basta: un <script> con `var a=1;` cumple "1 bloque".
R.check(`el FRONTEND validado supera el piso de ${MIN_CHARS_FRONTEND} car. (medido: ${charsFrontend})`,
        charsFrontend >= MIN_CHARS_FRONTEND,
        'Se valido MUY POCO codigo de frontend. No importa que parsee: el volumen\n' +
        'cayo por debajo del piso, asi que hay codigo que dejo de estar cubierto.\n' +
        'Causas tipicas: el refactor movio el <script> inline a modulos que este\n' +
        'validador no alcanza (revisa secciones 3, 4 y 5), o se perdio codigo.\n' +
        'Si el recorte es DELIBERADO, baja MIN_CHARS_FRONTEND a mano y con intencion.');

R.check(`el BACKEND/DESKTOP validado supera el piso de ${MIN_CHARS_BACKEND} car. (medido: ${charsBackend})`,
        charsBackend >= MIN_CHARS_BACKEND,
        'Se valido MUY POCO codigo de backend/desktop. Mismo criterio que arriba:\n' +
        'si server.js se partio en `backend/routes/*.js` el total no deberia bajar;\n' +
        'si bajo, hay archivos que el barrido ya no esta viendo.');

R.check('no quedo ningun archivo con error de sintaxis', validados.errores.length === 0,
        validados.errores.map(e => `${e.etiqueta}\n${e.detalle}`).join('\n\n'));

// Barrera final, independiente del Reporter: si por cualquier via el arnes
// llegara aqui sin haber afirmado nada, se sale con error igualmente.
const codigo = R.finalizar();
if ((R.ok + R.fallos) === 0) {
  console.log('\nABORTADO: la suite no ejecuto NINGUN assert. Verde en vacio = fallo.');
  process.exit(2);
}
if (nTotal === 0) {
  console.log('\nABORTADO: 0 archivos/bloques validados. Verde en vacio = fallo.');
  process.exit(2);
}
process.exit(codigo);
