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

const fs = require('fs');
const vm = require('vm');
const { INDEX_HTML } = require('./paths');

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

  // ---- Guarda anti "verde en vacio" -----------------------------------------
  // Si un dia el inline desaparece porque el refactor ya migro a modulos, este
  // arnes NO debe reportar exito con 0 simbolos: debe fallar y decir que hacer.
  if (inline.length === 0) {
    throw new Error(
      'load-frontend: `public/index.html` ya no tiene <script> inline.\n' +
      `Scripts externos encontrados: ${externos.map(e => e.src).join(', ') || '(ninguno)'}\n` +
      'El refactor a modulos ES ya ocurrio -> actualiza cargarFrontend() para\n' +
      'que haga import() de los modulos en vez de evaluar el inline.'
    );
  }

  // El script de la app es el inline mas grande (los otros, si existieran,
  // serian arranques menores). Hoy hay exactamente uno.
  const script = inline.slice().sort((a, b) => b.code.length - a.code.length)[0];

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

  // Todo lo declarado top-level quedo en el global del contexto.
  const reservados = new Set(['window','document','localStorage','navigator','location','console','fetch',
                              'setTimeout','clearTimeout','setInterval','clearInterval','globalThis','self']);
  const simbolos = {};
  for (const k of Object.getOwnPropertyNames(sandbox)) {
    if (!reservados.has(k)) simbolos[k] = sandbox[k];
  }

  return {
    simbolos,
    captura,
    sandbox,
    meta: {
      origen: 'inline',
      lineas: `${script.start}-${script.end}`,
      bytes:  script.code.length,
      externos,
      nSimbolos: Object.keys(simbolos).length,
    },
  };
}

module.exports = { cargarFrontend, escanearScripts };
