// tests/lib/load-frontend.js — carga el codigo REAL del frontend para poder ejecutarlo.
//
// ############################################################################
// #  ESTE ES EL PUNTO DE COSTURA DEL REFACTOR.                               #
// #  Hoy `public/index.html` lleva un unico <script> inline: se extrae y se  #
// #  evalua en un contexto `vm`, de modo que TODA declaracion top-level      #
// #  (`function X`, `var X`) queda como propiedad del global del sandbox.    #
// #  Cuando la Etapa 3 convierta eso en modulos ES, hay que cambiar          #
// #  UNICAMENTE `cargarFrontend()` para que haga `import(...)`.              #
// #  El resto del arnes no se entera.                                        #
// ############################################################################
//
// Por que `vm` y no `new Function` + lista de nombres: `new Function` valida
// SINTAXIS, NO EJECUCION (leccion del Bug #40, la pantalla negra de v2.1.0).
// Ejecutando de verdad en un contexto se detectan los errores de carga, y de
// paso no hay que mantener a mano la lista de 75 simbolos.

const fs   = require('fs');
const vm   = require('vm');
const path = require('path');
const { INDEX_HTML, PUBLIC_DIR } = require('./paths');

// ── Extraccion ───────────────────────────────────────────────────────────────

// Devuelve { inline:[{code,start,end}], externos:[src] } de index.html.
function escanearScripts(html) {
  const inline   = [];
  const externos = [];
  const re = /<script([^>]*)>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const attrs = m[1] || '';
    const src   = /\bsrc\s*=\s*["']([^"']+)["']/i.exec(attrs);
    if (src) {
      externos.push({ src: src[1], type: /\btype\s*=\s*["']module["']/i.test(attrs) ? 'module' : 'classic' });
    } else if (m[2].trim()) {
      inline.push({
        code:  m[2],
        start: html.slice(0, m.index).split('\n').length,
        end:   html.slice(0, re.lastIndex).split('\n').length,
      });
    }
  }
  return { inline, externos };
}

// ── Resolucion del grafo de modulos ──────────────────────────────────────────
// Aplana el grafo ES en UN solo texto ejecutable: recorre los `import` en
// profundidad, concatena cada dependencia antes de quien la usa y le quita las
// palabras `import`/`export`. Asi los simbolos de todos los modulos conviven en un
// mismo ambito y el arnes los ve igual que cuando todo era un <script> inline.
//
// Por que aplanar y no `import()` de verdad: los tests necesitan los simbolos
// INTERNOS (imputarCobros, saldoConCaja, los 5 generadores de PDF...), y un modulo
// solo expone lo que exporta. Aplanar da acceso a todo sin obligar a exportar cosas
// solo para poder probarlas.
//
// Es tolerable porque el proyecto no tiene colisiones de nombres entre modulos
// (75 simbolos top-level, todos unicos). Si algun dia dos modulos declaran el mismo
// nombre, esto lo delata con un SyntaxError de redeclaracion en vez de callarselo.

const RE_IMPORT = /^[ \t]*import\s+(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"]\s*;?[ \t]*$/gm;

function resolverGrafo(entradaAbs, vistos, orden) {
  const abs = path.resolve(entradaAbs);
  if (vistos.has(abs)) return;
  vistos.add(abs);

  if (!fs.existsSync(abs)) {
    throw new Error(`load-frontend: el modulo ${abs} no existe (import roto en el grafo).`);
  }
  let src = fs.readFileSync(abs, 'utf8');

  // Primero las dependencias (orden topologico: la dependencia va antes).
  const deps = [];
  let m;
  RE_IMPORT.lastIndex = 0;
  while ((m = RE_IMPORT.exec(src)) !== null) deps.push(m[1]);
  for (const d of deps) {
    if (!d.startsWith('.') && !d.startsWith('/')) continue; // paquete externo: no aplica aca
    const destino = d.startsWith('/')
      ? path.join(PUBLIC_DIR, d.replace(/^\//, ''))
      : path.resolve(path.dirname(abs), d);
    resolverGrafo(destino, vistos, orden);
  }

  // Quitar los `import`, y desnudar los `export` dejando la declaracion.
  src = src.replace(RE_IMPORT, '');
  src = src.replace(/^[ \t]*export\s+default\s+/gm, 'var __default__ = ');
  src = src.replace(/^[ \t]*export\s+(?=(?:const|let|var|function|class|async)\b)/gm, '');
  src = src.replace(/^[ \t]*export\s*\{[^}]*\}\s*;?[ \t]*$/gm, '');

  orden.push({ archivo: path.relative(PUBLIC_DIR, abs), codigo: src });
}

// ── Stubs del entorno de navegador ───────────────────────────────────────────

function crearStubReact() {
  // Arbol plano; suficiente para inspeccionar lo que un componente produce.
  const createElement = (type, props, ...children) => ({
    type, props: props || {}, children: children.flat(Infinity).filter(c => c !== null && c !== undefined && c !== false),
  });
  // Hooks: implementacion lineal. Solo valen para UN render por componente
  // (no hay reconciliacion). Los tests de dominio no los usan; estan para que
  // un arnes futuro pueda renderizar un componente una vez.
  const React = {
    createElement,
    useState:    (init) => { const v = typeof init === 'function' ? init() : init; return [v, () => {}]; },
    useEffect:   () => {},
    useMemo:     (fn) => fn(),
    useCallback: (fn) => fn,
    useRef:      (init) => ({ current: init }),
    Fragment:    'Fragment',
  };
  const ReactDOM = { createRoot: () => ({ render: () => {}, unmount: () => {} }) };
  return { React, ReactDOM };
}

function crearStubDom(captura) {
  const noop = () => {};
  const elem = () => ({
    style: {}, dataset: {}, classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
    setAttribute: noop, getAttribute: () => null, appendChild: noop, removeChild: noop,
    addEventListener: noop, removeEventListener: noop, click: noop, focus: noop,
    querySelector: () => null, querySelectorAll: () => [], innerHTML: '', textContent: '', children: [],
  });

  const documentStub = {
    documentElement: Object.assign(elem(), {
      _attrs: {},
      setAttribute(k, v) { this._attrs[k] = v; },
      getAttribute(k) { return this._attrs[k] === undefined ? null : this._attrs[k]; },
    }),
    body: elem(),
    getElementById: () => elem(),
    createElement: () => elem(),
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: noop,
    removeEventListener: noop,
    write: noop,
    close: noop,
  };

  const almacen = new Map();
  const localStorageStub = {
    getItem: k => (almacen.has(k) ? almacen.get(k) : null),
    setItem: (k, v) => { almacen.set(k, String(v)); },
    removeItem: k => { almacen.delete(k); },
    clear: () => almacen.clear(),
  };

  const windowStub = {
    innerWidth: 1280, innerHeight: 860,
    addEventListener: noop, removeEventListener: noop, focus: noop, print: noop,
    localStorage: localStorageStub,
    location: { href: 'http://127.0.0.1:3420/', origin: 'http://127.0.0.1:3420' },
    navigator: { userAgent: 'cartera-tests', platform: 'Win32' },
    // Los 5 generadores de PDF emiten por aqui -> capturamos HTML + nombre.
    electronAPI: {
      printPDF: (html, fname) => { captura.pdfs.push({ html, fname }); return Promise.resolve({ ok: true }); },
      getPlatform: () => Promise.resolve('win32'),
      getStartupErrors: () => Promise.resolve([]),
      onUpdateStatus: () => () => {},
    },
    // Fallback de los generadores cuando no hay electronAPI.
    open: () => {
      const doc = { write: h => { captura.pdfs.push({ html: h, fname: '(window.open)' }); }, close: noop };
      return { document: doc, print: noop, onload: null, focus: noop };
    },
    matchMedia: () => ({ matches: false, addListener: noop, removeListener: noop, addEventListener: noop, removeEventListener: noop }),
  };

  return { documentStub, windowStub, localStorageStub };
}

// ── API publica ──────────────────────────────────────────────────────────────

/**
 * Carga el frontend y devuelve sus simbolos top-level.
 *
 * @returns {{simbolos:Object, captura:{pdfs:Array}, meta:Object}}
 *   simbolos — todo lo declarado top-level (fmt, imputarCobros, App, ...).
 *   captura  — efectos observados; `captura.pdfs` acumula los PDF generados.
 *   meta     — de donde salio el codigo (para que el reporte sea honesto).
 */
function cargarFrontend(opts) {
  const o    = opts || {};
  const html = fs.readFileSync(INDEX_HTML, 'utf8');
  const { inline, externos } = escanearScripts(html);

  // ---- De donde sale el codigo ----------------------------------------------
  // Pre-refactor: un <script> inline. Post-B1: <script type="module" src=...>.
  // Se soportan los dos, y si no aparece NINGUNO se falla ruidosamente: un arnes
  // que carga 0 simbolos y reporta exito es el modo de fallo que hay que impedir.
  let script, meta;

  const propios = externos.filter(e => e.src.startsWith('/') && !e.src.startsWith('/vendor/'));

  if (inline.length > 0) {
    // El script de la app es el inline mas grande.
    const s = inline.slice().sort((a, b) => b.code.length - a.code.length)[0];
    script = { code: s.code, start: s.start };
    meta = { origen: 'inline', lineas: `${s.start}-${s.end}`, modulos: [] };
  } else if (propios.length > 0) {
    // Grafo de modulos ES, aplanado a un solo texto.
    const vistos = new Set(), orden = [];
    for (const e of propios) {
      resolverGrafo(path.join(PUBLIC_DIR, e.src.replace(/^\//, '')), vistos, orden);
    }
    script = { code: orden.map(o => o.codigo).join('\n'), start: 0 };
    meta = { origen: 'modulos', lineas: '-', modulos: orden.map(o => o.archivo) };
  } else {
    throw new Error(
      'load-frontend: `public/index.html` no tiene ni <script> inline ni <script src> propio.\n' +
      `Scripts vistos: ${externos.map(e => e.src).join(', ') || '(ninguno)'}\n` +
      'Sin codigo que cargar, cualquier "OK" de esta suite seria mentira.'
    );
  }

  const captura = { pdfs: [] };
  const { React, ReactDOM } = crearStubReact();
  const { documentStub, windowStub, localStorageStub } = crearStubDom(captura);

  const sandbox = {
    React, ReactDOM,
    window: windowStub,
    document: documentStub,
    localStorage: localStorageStub,
    navigator: windowStub.navigator,
    location: windowStub.location,
    console: o.silenciarConsola ? { log: () => {}, warn: () => {}, error: () => {} } : console,
    fetch: o.fetch || (() => Promise.reject(new Error('fetch no stubeado en este test'))),
    setTimeout, clearTimeout, setInterval, clearInterval,
  };
  sandbox.globalThis = sandbox;
  sandbox.self       = sandbox;
  // El codigo lee `window.X` y a veces `X` a secas: que apunten al mismo objeto.
  windowStub.React    = React;
  windowStub.ReactDOM = ReactDOM;
  windowStub.document = documentStub;

  const ctx = vm.createContext(sandbox);
  try {
    vm.runInContext(script.code, ctx, { filename: 'public/index.html <script>', lineOffset: script.start });
  } catch (e) {
    throw new Error(
      `load-frontend: el script de index.html fallo AL EJECUTARSE (no es un error de sintaxis).\n` +
      `Esto es exactamente la clase de fallo que \`new Function\` no detecta (Bug #40).\n` +
      `${e && e.stack ? e.stack : e}`
    );
  }

  // ---- Cosecha de simbolos --------------------------------------------------
  // Los `var` y `function` de nivel superior SI quedan como propiedades del global
  // del contexto...
  const reservados = new Set(['window','document','localStorage','navigator','location','console','fetch',
                              'setTimeout','clearTimeout','setInterval','clearInterval','globalThis','self']);
  const simbolos = {};
  for (const k of Object.getOwnPropertyNames(sandbox)) {
    if (!reservados.has(k)) simbolos[k] = sandbox[k];
  }

  // ...pero `const`, `let` y `class` NO: viven en el ambito lexico global, que no
  // es el objeto global. Sin este segundo paso, todo lo que un modulo declare con
  // `const` (o exporte con `export const`) resultaria INVISIBLE para el arnes, que
  // seguiria reportando OK sobre los simbolos que si ve. Es un verde en vacio en
  // camara lenta, y aparecio en cuanto B2 saco `CHANGELOGS` a su propio modulo.
  //
  // Se leen evaluando una expresion en el MISMO contexto: las declaraciones
  // lexicas globales persisten entre llamadas a runInContext.
  const declarados = new Set();
  const RE_DECL = /^(?:const|let|class|var|function|async\s+function)\s+([A-Za-z_$][\w$]*)/gm;
  let d;
  while ((d = RE_DECL.exec(script.code)) !== null) declarados.add(d[1]);

  const faltantes = [...declarados].filter(n => !(n in simbolos) && !reservados.has(n));
  if (faltantes.length) {
    const expr = '({' + faltantes.map(n => `${JSON.stringify(n)}: typeof ${n} === 'undefined' ? undefined : ${n}`).join(',') + '})';
    let lexicos = {};
    try {
      lexicos = vm.runInContext(expr, ctx, { filename: 'load-frontend:cosecha-lexica' });
    } catch (e) {
      throw new Error(`load-frontend: no se pudieron cosechar los simbolos lexicos (${faltantes.length}): ${e.message}`);
    }
    for (const [k, v] of Object.entries(lexicos)) if (v !== undefined) simbolos[k] = v;
  }

  return {
    simbolos,
    captura,
    sandbox,
    meta: Object.assign({}, meta, {
      bytes: script.code.length,
      externos,
      nSimbolos: Object.keys(simbolos).length,
    }),
  };
}

module.exports = { cargarFrontend, escanearScripts };
