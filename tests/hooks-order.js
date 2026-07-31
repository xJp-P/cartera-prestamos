// tests/hooks-order.js — guarda estatica contra el Bug #40 (la pantalla negra de v2.1.0).
//
// QUE PASO: dos `useCallback` quedaron POR DEBAJO del `if(loading) return ...` de
// `App`. En el primer render el return corta y esos hooks no se ejecutan; al pasar
// `loading` a false el flujo sigue de largo y aparecen 2 hooks nuevos -> React lanza
// el error #310, desmonta el arbol entero y la ventana queda negra.
//
// POR QUE UN CHEQUEO ESTATICO: `new Function` valida SINTAXIS, NO EJECUCION, y los
// arneses que renderizan componentes EN AISLAMIENTO tampoco lo atrapan (hay que
// atravesar el ciclo de vida `loading` para verlo). Esta es la unica forma barata y
// repetible de blindar la regla; el chequeo definitivo sigue siendo cargar la app real
// en un navegador (ver tests/README.md).
//
// El refactor va a MOVER estos componentes de archivo. Esta guarda es justo la que
// impide que el movimiento reintroduzca el defecto.
//
// PRECISION (importante): la primera version de este archivo contaba cualquier
// `return` como guarda y producia 42 FALSOS POSITIVOS — marcaba returns que viven
// dentro de callbacks anidados (`useEffect(function(){ ... return; })`, `arr.filter(
// function(p){ return ...; })`). Solo importa el cuerpo del COMPONENTE, asi que el
// analizador lleva una pila de ambitos y distingue una llave que abre una funcion de
// una que abre un bloque. Un chequeo que grita en falso se termina ignorando, que es
// la peor forma de no tener chequeo.

const fs   = require('fs');
const path = require('path');
const { INDEX_HTML, PUBLIC_DIR } = require('./lib/paths');
const { escanearScripts } = require('./lib/load-frontend');
const { Reporter } = require('./lib/report');

const HOOKS = ['useState','useEffect','useMemo','useCallback','useRef','useReducer','useContext','useLayoutEffect'];
const RE_HOOK = new RegExp('^(?:React\\s*\\.\\s*)?(' + HOOKS.join('|') + ')\\s*\\(');

// Recorre el cuerpo de una funcion caracter a caracter llevando una pila de ambitos.
// Devuelve los `return` y las llamadas a hooks que ocurren en el PRIMER nivel de
// funcion (el cuerpo del componente), ignorando todo lo que este dentro de closures.
function escanearCuerpo(texto) {
  const returns = [];
  const hooks   = [];

  let i = 0;
  const n = texto.length;
  let linea = 1;
  // pila[0] es el cuerpo del propio componente.
  const pila = [];          // 'fn' | 'blk'
  let reciente = '';        // ultimos chars significativos, para el lookbehind
  let arrancoCuerpo = false;

  const nivelFn = () => pila.filter(t => t === 'fn').length;

  while (i < n) {
    const c = texto[i];

    if (c === '\n') { linea++; i++; reciente += ' '; continue; }

    // ── Comentarios ──
    if (c === '/' && texto[i + 1] === '/') { while (i < n && texto[i] !== '\n') i++; continue; }
    if (c === '/' && texto[i + 1] === '*') {
      i += 2;
      while (i < n && !(texto[i] === '*' && texto[i + 1] === '/')) { if (texto[i] === '\n') linea++; i++; }
      i += 2; continue;
    }

    // ── Cadenas (incluye plantillas multilinea) ──
    if (c === '"' || c === "'" || c === '`') {
      const cierre = c; i++;
      while (i < n) {
        if (texto[i] === '\\') { i += 2; continue; }
        if (texto[i] === '\n') linea++;
        if (texto[i] === cierre) { i++; break; }
        i++;
      }
      reciente += '""';
      continue;
    }

    // ── Llaves: abrir/cerrar ambito ──
    if (c === '{') {
      // Decide si esta llave abre una FUNCION o un simple bloque, mirando atras.
      const cola = reciente.slice(-260);
      const esFn = /(?:function\s*[A-Za-z0-9_$]*\s*\([^()]*\)\s*|=>\s*)$/.test(cola);
      if (!arrancoCuerpo) { arrancoCuerpo = true; pila.push('fn'); }   // el cuerpo del componente
      else pila.push(esFn ? 'fn' : 'blk');
      i++; reciente += '{'; continue;
    }
    if (c === '}') { pila.pop(); i++; reciente += '}'; continue; }

    // ── Palabras ──
    if (/[A-Za-z_$]/.test(c)) {
      let j = i;
      while (j < n && /[A-Za-z0-9_$]/.test(texto[j])) j++;
      const palabra = texto.slice(i, j);
      const anterior = reciente[reciente.length - 1];
      const esMiembro = anterior === '.';   // obj.return / obj.useState -> no cuenta

      if (arrancoCuerpo && nivelFn() === 1 && !esMiembro) {
        if (palabra === 'return') {
          returns.push({ linea, texto: extraerLinea(texto, i) });
        } else if (HOOKS.indexOf(palabra) !== -1) {
          const resto = texto.slice(i, i + 40);
          if (RE_HOOK.test(resto) || /^\w+\s*\(/.test(resto)) {
            hooks.push({ linea, hook: palabra, texto: extraerLinea(texto, i) });
          }
        }
      }
      reciente += palabra;
      i = j; continue;
    }

    reciente += c;
    if (reciente.length > 400) reciente = reciente.slice(-300);
    i++;
  }

  return { returns, hooks };
}

function extraerLinea(texto, idx) {
  const ini = texto.lastIndexOf('\n', idx) + 1;
  let fin = texto.indexOf('\n', idx);
  if (fin === -1) fin = texto.length;
  return texto.slice(ini, fin).trim().slice(0, 110);
}

// Localiza los componentes React: `function Nombre(` con Nombre en MayusculaInicial.
//
// Acepta el prefijo `export` (y `export default`). Sin eso, en cuanto el refactor
// movio los primeros componentes a modulos, el analizador dejo de verlos EN
// SILENCIO: paso de 29 a 24 componentes y siguio reportando 8/8 OK. El piso de
// ">= 20 componentes" tampoco salta, porque la caida es gradual — habria ido
// quedandose ciego justo en B7, que mueve las 23 vistas y modales. Es la misma
// clase de fallo que el `const` invisible en el contexto vm (ver load-frontend.js).
const RE_COMPONENTE = /^(?:export\s+(?:default\s+)?)?function\s+([A-Z][A-Za-z0-9_]*)\s*\(/;

function extraerComponentes(codigo, offset) {
  const lineas = codigo.split('\n');
  const comps = [];
  for (let i = 0; i < lineas.length; i++) {
    const m = RE_COMPONENTE.exec(lineas[i]);
    if (!m) continue;
    let depth = 0, empezo = false, fin = i;
    for (let j = i; j < lineas.length; j++) {
      const l = lineas[j].replace(/\\./g, '')
        .replace(/'(?:[^'\\]|\\.)*'/g, "''").replace(/"(?:[^"\\]|\\.)*"/g, '""')
        .replace(/\/\/.*$/, '');
      for (const ch of l) { if (ch === '{') { depth++; empezo = true; } else if (ch === '}') depth--; }
      if (empezo && depth <= 0) { fin = j; break; }
    }
    comps.push({
      nombre: m[1],
      lineaInicio: offset + i,
      cuerpo: lineas.slice(i, fin + 1).join('\n'),
      offset: offset + i,
    });
  }
  return comps;
}

// Un componente viola la regla si llama a un hook DESPUES de un return de guarda.
// El ultimo return de nivel 1 es el return del render: ese no es guarda.
function analizar(comp) {
  const { returns, hooks } = escanearCuerpo(comp.cuerpo);
  if (returns.length === 0 || hooks.length === 0) return [];
  const guardas = returns.slice(0, -1);          // todos menos el return final
  if (guardas.length === 0) return [];
  const primeraGuarda = guardas[0];
  return hooks
    .filter(h => h.linea > primeraGuarda.linea)
    .map(h => ({
      hook: h.hook,
      lineaHook:   comp.offset + h.linea - 1,
      textoHook:   h.texto,
      lineaReturn: comp.offset + primeraGuarda.linea - 1,
      textoReturn: primeraGuarda.texto,
    }));
}

// ── Auto-prueba del analizador ──────────────────────────────────────────────
// Sin esto, un analizador ciego reportaria "0 violaciones" y pareceria exito.
function autoPrueba(R) {
  R.seccion('Auto-prueba del analizador (control positivo y negativo)');

  const casos = [
    {
      nombre: 'MALO: hook despues de return condicional',
      esperado: 1,
      src: [
        'function Cebo(props){',
        '  var s = useState(0);',
        '  if (props.loading) return h("div", null, "cargando");',
        '  var t = useCallback(function(){}, []);',
        '  return h("div", null, t);',
        '}'].join('\n'),
    },
    {
      nombre: 'MALO: idem pero como `export function` (forma de los modulos)',
      esperado: 1,
      src: [
        'export function CeboExportado(props){',
        '  var s = useState(0);',
        '  if (props.loading) return h("div", null, "cargando");',
        '  var t = useCallback(function(){}, []);',
        '  return h("div", null, t);',
        '}'].join('\n'),
    },
    {
      nombre: 'BUENO: todos los hooks antes del return condicional',
      esperado: 0,
      src: [
        'function Sano(props){',
        '  var s = useState(0);',
        '  var t = useCallback(function(){}, []);',
        '  if (props.loading) return h("div", null, "cargando");',
        '  return h("div", null, t);',
        '}'].join('\n'),
    },
    {
      nombre: 'BUENO: return dentro de un useEffect no es guarda (falso positivo clasico)',
      esperado: 0,
      src: [
        'function ConEfecto(props){',
        '  useEffect(function(){',
        '    if (typeof window.electronAPI === "undefined") return;',
        '    window.electronAPI.algo();',
        '  }, []);',
        '  var m = useMemo(function(){ return 1; }, []);',
        '  return h("div", null, m);',
        '}'].join('\n'),
    },
    {
      nombre: 'BUENO: return dentro de un callback de filter no es guarda',
      esperado: 0,
      src: [
        'function ConFiltro(props){',
        '  var noAb = function(p){ return p.id.indexOf("-ab-") === -1; };',
        '  var g = useMemo(function(){ return props.pays.filter(noAb); }, [props.pays]);',
        '  return h("div", null, g.length);',
        '}'].join('\n'),
    },
    {
      nombre: 'BUENO: return dentro de una funcion auxiliar anidada no es guarda',
      esperado: 0,
      src: [
        'function ConAux(props){',
        '  function hasActivity(loan){ if(!loan||!loan.id) return false; return true; }',
        '  var s = useState(hasActivity(props.loan));',
        '  return h("div", null, s[0]);',
        '}'].join('\n'),
    },
  ];

  let sano = true;
  for (const c of casos) {
    const comps = extraerComponentes(c.src, 0);
    const v = comps.length ? analizar(comps[0]) : [];
    const ok = v.length === c.esperado;
    if (!ok) sano = false;
    R.check(`  ${c.nombre}`, ok,
      `se esperaban ${c.esperado} violacion(es), se detectaron ${v.length}` +
      (v.length ? '\n' + v.map(x => `  ${x.hook}() tras return de linea ${x.lineaReturn}`).join('\n') : ''));
  }
  return sano;
}

function main() {
  const R = new Reporter('hooks-order');
  const html = fs.readFileSync(INDEX_HTML, 'utf8');
  const { inline, externos } = escanearScripts(html);

  // El analizador se valida a si mismo ANTES de emitir juicio sobre produccion.
  const analizadorSano = autoPrueba(R);

  const fuentes = [];
  for (const s of inline) fuentes.push({ etiqueta: 'index.html <script>', codigo: s.code, offset: s.start });

  // A prueba de futuro: tras el refactor el codigo vive en modulos bajo public/js.
  const jsDir = path.join(PUBLIC_DIR, 'js');
  if (fs.existsSync(jsDir)) {
    const pila = [jsDir];
    while (pila.length) {
      const d = pila.pop();
      for (const f of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, f.name);
        if (f.isDirectory()) pila.push(p);
        else if (f.name.endsWith('.js')) {
          fuentes.push({ etiqueta: path.relative(PUBLIC_DIR, p), codigo: fs.readFileSync(p, 'utf8'), offset: 0 });
        }
      }
    }
  }

  // ── Barrera anti "verde en vacio" ──────────────────────────────────────────
  if (fuentes.length === 0) {
    console.log('\nFALLO: no se encontro NINGUNA fuente de frontend que analizar.');
    console.log('Scripts externos vistos:', externos.map(e => e.src).join(', ') || '(ninguno)');
    console.log('Un "0 componentes revisados, todo OK" es exactamente el verde falso que');
    console.log('este arnes existe para evitar.');
    process.exit(1);
  }

  let comps = [];
  for (const f of fuentes) comps = comps.concat(extraerComponentes(f.codigo, f.offset));

  R.seccion(`Fuentes: ${fuentes.map(f => f.etiqueta).join(', ')}`);
  console.log(`   componentes React detectados: ${comps.length}`);
  console.log(`   ${comps.map(c => c.nombre).join(', ')}`);

  R.check('El analizador paso su propia auto-prueba', analizadorSano,
    'el analizador esta dando falsos positivos o esta ciego: su veredicto no vale nada');

  R.check(`Se detectaron componentes suficientes (>=20, hay ${comps.length})`, comps.length >= 20,
    `solo ${comps.length}. Si el refactor movio los componentes, este chequeo esta mirando ` +
    `al lugar equivocado y hay que actualizar la deteccion de fuentes.`);

  R.seccion('Regla: ningun hook por debajo de un return condicional (Bug #40)');
  let totalViolaciones = 0;
  for (const c of comps) {
    const v = analizar(c);
    totalViolaciones += v.length;
    if (v.length) {
      R.check(`${c.nombre}: sin hooks tras un return condicional`, false,
        v.map(x =>
          `hook ${x.hook}() en linea ${x.lineaHook}\n  ${x.textoHook}\n` +
          `viene DESPUES del return de guarda de la linea ${x.lineaReturn}\n  ${x.textoReturn}`
        ).join('\n\n'));
    }
  }
  R.check(`Los ${comps.length} componentes respetan el orden de hooks`, totalViolaciones === 0,
    totalViolaciones ? `${totalViolaciones} violacion(es) — ver detalle arriba` : undefined);

  process.exit(R.finalizar());
}

main();
