// tests/fixture/crear-fixture.js — genera la BD de prueba ANONIMIZADA.
//
//   node tests/fixture/crear-fixture.js
//
// POR QUE EXISTE
// Los golden master se versionan en el repo (es el seguro contra un cambio
// silencioso de una respuesta de API o de la estructura de un PDF). Pero al
// generarlos desde la BD de produccion arrastraban DATOS PERSONALES REALES a un
// repositorio PUBLICO: nombres completos, cedulas, telefonos, notas privadas y
// —lo mas grave— los datos bancarios del propio usuario en `config.datos_pago`.
//
// Este script produce `cartera-fixture.db`: la MISMA base, con la MISMA
// estructura y los MISMOS importes, fechas e ids, pero con toda identidad
// sustituida por datos inventados.
//
// POR QUE ANONIMIZAR EN VEZ DE INVENTAR UNA BD DESDE CERO
// El valor de estos tests esta en los casos borde REALES que la cartera acumulo:
// el residuo de redondeo del Bug #43, un pago parcial en vuelo, cuotas En Mora
// con capital atrapado, una cuota transitoria por cambio de dia de pago, prestamos
// USD con TRM distinta a la pactada. Una BD sintetica "limpia" no tendria nada de
// eso y los golden dejarian de proteger justo lo que costo descubrir. Se cambian
// las identidades y NO se toca un solo numero.
//
// Los importes se conservan a proposito: sin nombres ni cedulas no identifican a
// nadie, y alterarlos invalidaria los casos borde (el residuo de 1 peso del
// Bug #43 depende del importe exacto).
//
// ES DETERMINISTA: el mismo origen produce siempre el mismo fixture, asi que
// regenerarlo no ensucia el diff de los golden.

const fs   = require('fs');
const path = require('path');

if (!process.versions.electron) {
  const { spawn } = require('child_process');
  const electron = path.join(__dirname, '..', '..', 'node_modules', '.bin',
    process.platform === 'win32' ? 'electron.cmd' : 'electron');
  const hijo = spawn(electron, [__filename, ...process.argv.slice(2)],
    { stdio: 'inherit', shell: process.platform === 'win32',
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
  hijo.on('exit', c => process.exit(c === null ? 1 : c));
  return;
}

const Database = require('better-sqlite3');
const { PROD_DB } = require('../lib/paths');
const { inyectarCreditoDiario } = require('./credito-diario');

const DESTINO = path.join(__dirname, 'cartera-fixture.db');

// ── Identidades sinteticas ──────────────────────────────────────────────────
const NOMBRES = [
  'Ana Restrepo', 'Bruno Salgado', 'Carla Ossa', 'Diego Marin', 'Elena Vargas',
  'Felipe Nunez', 'Gabriela Rios', 'Hector Pardo', 'Irene Bastidas', 'Julian Correa',
  'Karina Lozano', 'Leonel Amaya', 'Marta Quintero', 'Nicolas Duarte', 'Olga Serrano',
  'Pablo Herrera', 'Quintin Abad', 'Rosa Cardenas', 'Simon Toro', 'Tania Escobar',
  'Ulises Bravo', 'Valeria Mesa', 'Wilson Parra', 'Ximena Gil', 'Yamil Castro', 'Zoe Ferrer',
];

function crearMapa(valores) {
  const mapa = new Map();
  let i = 0;
  for (const v of valores) {
    if (!v || !String(v).trim()) continue;
    if (mapa.has(v)) continue;
    mapa.set(v, NOMBRES[i % NOMBRES.length] + (i >= NOMBRES.length ? ' ' + Math.floor(i / NOMBRES.length) : ''));
    i++;
  }
  return mapa;
}

// Cedula/telefono sinteticos pero estables y con la misma forma (largo) que el original.
function cedulaFalsa(n)   { return n == null ? n : String(1000000000 + (n * 7919) % 899999999); }
function telefonoFalso(n) { return '30' + String(10000000 + (n * 6271) % 89999999); }

function main() {
  if (!fs.existsSync(PROD_DB)) {
    console.error(`No se encuentra la BD de origen: ${PROD_DB}`);
    console.error('Define CARTERA_DB si esta en otra ruta.');
    process.exit(1);
  }
  if (fs.existsSync(DESTINO)) fs.unlinkSync(DESTINO);
  fs.copyFileSync(PROD_DB, DESTINO);

  const db = new Database(DESTINO);

  // ── Mapa de nombres, sobre TODAS las fuentes de identidad ────────────────
  const fuentes = []
    .concat(db.prepare('SELECT DISTINCT nombre AS v FROM loans').all().map(r => r.v))
    .concat(db.prepare('SELECT DISTINCT nombreCliente AS v FROM payments').all().map(r => r.v))
    .concat(db.prepare('SELECT DISTINCT acreedor AS v FROM mis_deudas').all().map(r => r.v));
  const mapa = crearMapa(fuentes);

  // ── Sustitucion en texto libre ────────────────────────────────────────────
  //
  // Tres trampas que el historial de esta cartera destapo, y que una sustitucion
  // ingenua no salva:
  //
  //  1. LIMITES DE PALABRA. Hay acreedores de DOS LETRAS ("Ma", "Pa"). Un
  //     split/join los cambiaba dentro de otras palabras y convertia "Pago
  //     parcial" en basura. El limite se define contra letras Unicode y digitos
  //     —no `\b`— porque los nombres llevan tildes y ahi `\b` cae mal.
  //  2. TILDES. El historial guarda variantes acentuadas de nombres que las
  //     tablas almacenan sin tilde. Se compara plegando diacriticos.
  //  3. VARIANTES. Conserva ademas la grafia anterior de un acreedor que el
  //     usuario corrigio despues (una letra de diferencia). Por eso, ademas de
  //     los nombres completos, se mapea TOKEN A TOKEN: cualquier variante cae.
  //
  // Los mensajes del historial son la unica fuente que guarda identidades de
  // prestamos YA ELIMINADOS, que no estan en ninguna tabla. De ahi que no baste
  // con mapear lo que hay hoy en `loans`.
  const plegar = s => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '');
  const escapar = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  // Tokens: cada palabra de 3+ letras de cualquier nombre conocido.
  // Se registra tambien la variante sin la `s` final: el historial conserva la grafia
  // anterior de un acreedor corregido despues, y un apellido
  // escrito de dos formas sigue identificando a la misma persona.
  const tokens = new Map();
  let ti = 0;
  const registrar = (tok) => {
    if (!tok || tok.length < 3) return;
    const clave = plegar(tok).toLowerCase();
    if (tokens.has(clave)) return;
    tokens.set(clave, NOMBRES[ti % NOMBRES.length].split(' ')[ti % 2] + (ti >= NOMBRES.length ? ti : ''));
    ti++;
  };
  for (const nombre of mapa.keys()) {
    for (const tok of String(nombre).split(/[^\p{L}]+/u)) {
      registrar(tok);
      if (tok.length >= 5 && /s$/i.test(tok)) registrar(tok.slice(0, -1));
    }
  }

  // Primero los nombres completos (mas largos), despues los tokens sueltos.
  const reglas = [
    ...[...mapa.keys()].sort((a, b) => b.length - a.length).map(k => [k, mapa.get(k)]),
    ...[...tokens.keys()].sort((a, b) => b.length - a.length).map(k => [k, tokens.get(k)]),
  ];

  function limpiarTexto(t) {
    if (!t) return t;
    let s = String(t);
    for (const [clave, valor] of reglas) {
      // Se busca sobre el texto PLEGADO y se reemplaza en el original por indice,
      // para que una forma acentuada caiga con su clave sin tilde, sin romper el resto.
      const re = new RegExp('(?<![\\p{L}\\d])' + escapar(plegar(clave)) + '(?![\\p{L}\\d])', 'giu');
      let out = '', last = 0, m;
      const plano = plegar(s);
      while ((m = re.exec(plano)) !== null) {
        out += s.slice(last, m.index) + valor;
        last = m.index + m[0].length;
      }
      s = out + s.slice(last);
    }
    return s;
  }

  const tx = db.transaction(() => {
    // loans
    let i = 0;
    for (const l of db.prepare('SELECT id, nombre, cedula, telefono, notas FROM loans').all()) {
      i++;
      db.prepare('UPDATE loans SET nombre=?, cedula=?, telefono=?, notas=? WHERE id=?').run(
        mapa.get(l.nombre) || 'Deudor ' + i,
        l.cedula ? cedulaFalsa(i) : l.cedula,
        l.telefono ? telefonoFalso(i) : l.telefono,
        l.notas ? 'Nota de prueba ' + i : l.notas,
        l.id
      );
    }
    // payments
    for (const [orig, falso] of mapa) {
      db.prepare('UPDATE payments SET nombreCliente=? WHERE nombreCliente=?').run(falso, orig);
    }
    // payments.observaciones puede llevar texto libre
    for (const p of db.prepare("SELECT id, observaciones FROM payments WHERE observaciones <> ''").all()) {
      db.prepare('UPDATE payments SET observaciones=? WHERE id=?').run(limpiarTexto(p.observaciones), p.id);
    }
    // mis_deudas: acreedor mapeado; titulo/concepto son texto libre que menciona a terceros
    let d = 0;
    for (const x of db.prepare('SELECT id, acreedor FROM mis_deudas').all()) {
      d++;
      db.prepare('UPDATE mis_deudas SET acreedor=?, titulo=?, concepto=? WHERE id=?').run(
        mapa.get(x.acreedor) || 'Acreedor ' + d, 'Deuda de prueba ' + d, 'Concepto de prueba ' + d, x.id
      );
    }
    // pagos_deudas.notas
    for (const g of db.prepare("SELECT id, notas FROM pagos_deudas WHERE notas <> ''").all()) {
      db.prepare('UPDATE pagos_deudas SET notas=? WHERE id=?').run(limpiarTexto(g.notas), g.id);
    }
    // activity_log: los mensajes llevan nombres
    for (const a of db.prepare('SELECT id, mensaje FROM activity_log').all()) {
      db.prepare('UPDATE activity_log SET mensaje=? WHERE id=?').run(limpiarTexto(a.mensaje), a.id);
    }
    // undo_journal: descripcion Y el snapshot JSON, que lleva el agregado entero
    for (const u of db.prepare('SELECT id, descripcion, snapshot FROM undo_journal').all()) {
      db.prepare('UPDATE undo_journal SET descripcion=?, snapshot=? WHERE id=?').run(
        limpiarTexto(u.descripcion), limpiarTexto(u.snapshot), u.id
      );
    }
    // config: `datos_pago` son los datos BANCARIOS del usuario. Se reemplazan enteros.
    db.prepare("UPDATE config SET value=? WHERE key='datos_pago'").run(
      'Transferencia\nBanco de Prueba: 000000000\nLlave: @ejemplo'
    );
  });
  tx();

  // ── Verificacion: que no sobreviva ningun rastro ─────────────────────────
  const sospechosos = [...mapa.keys()];
  let restos = 0;
  const tablas = {
    loans: ['nombre', 'cedula', 'telefono', 'notas'],
    payments: ['nombreCliente', 'observaciones'],
    mis_deudas: ['acreedor', 'titulo', 'concepto'],
    pagos_deudas: ['notas'],
    activity_log: ['mensaje'],
    undo_journal: ['descripcion', 'snapshot'],
    config: ['value'],
  };
  // La comprobacion va con limites de palabra Y plegando tildes, igual que la
  // sustitucion: con LIKE '%Pa%' cualquier nombre sintetico que contenga "Pa"
  // (Pablo, Parra) daria un falso positivo y el chequeo se volveria inservible a
  // fuerza de gritar. Y busca tambien TOKENS sueltos, que es como sobreviven las
  // variantes historicas (una grafia antigua cuando la tabla ya tiene la corregida).
  const aBuscar = [...new Set([...sospechosos, ...tokens.keys()])].filter(s => plegar(s).length >= 3);
  for (const [tabla, cols] of Object.entries(tablas)) {
    for (const col of cols) {
      const filas = db.prepare(`SELECT ${col} AS v FROM ${tabla} WHERE ${col} IS NOT NULL`).all();
      for (const s of aBuscar) {
        const re = new RegExp('(?<![\\p{L}\\d])' + escapar(plegar(s)) + '(?![\\p{L}\\d])', 'iu');
        const n = filas.filter(f => re.test(plegar(f.v))).length;
        if (n) { console.error(`  RESTO: "${s}" sigue en ${tabla}.${col} (${n} filas)`); restos += n; }
      }
    }
  }
  const banco = db.prepare("SELECT value v FROM config WHERE key='datos_pago'").get();
  if (banco && /\d{8,}/.test(banco.v.replace(/000000000/g, ''))) {
    console.error('  RESTO: datos_pago parece conservar un numero real');
    restos++;
  }

  // ── Credito SINTETICO de Interes Diario ──────────────────────────────────
  // VA DESPUES de la verificacion de rastros A PROPOSITO: el barrido de nombres
  // reales busca tambien TOKENS sueltos, asi que un nombre sintetico inyectado
  // antes podria disparar un falso positivo y tumbar la generacion por un dato
  // que no viene de ningun cliente. Lo real se anonimiza y se verifica primero;
  // lo sintetico se anade despues, y el VACUUM de abajo lo compacta igual.
  //
  // La definicion vive en `credito-diario.js` para poder inyectarla SOLA sobre el
  // fixture ya versionado: regenerar desde produccion arrastra actividad real y
  // estado dependiente del calendario (la auto-mora marca por fecha), asi que no
  // siempre se quiere —ni se puede— una regeneracion completa.
  inyectarCreditoDiario(db);

  // ── VACUUM: sin esto el fichero SIGUE conteniendo los datos reales ────────
  // SQLite no sobrescribe: un UPDATE deja el valor viejo en paginas libres. Las
  // consultas devolvian todo anonimizado y aun asi `grep -a` sacaba del binario
  // los nombres y las cedulas originales — es decir, habrian viajado al repo
  // publico dentro del .db pese a estar "limpio" por SQL.
  // VACUUM reconstruye el archivo entero y descarta ese espacio.
  db.exec('VACUUM');

  const resumen = {
    loans: db.prepare('SELECT COUNT(*) c FROM loans').get().c,
    payments: db.prepare('SELECT COUNT(*) c FROM payments').get().c,
    mis_deudas: db.prepare('SELECT COUNT(*) c FROM mis_deudas').get().c,
    pagos_deudas: db.prepare('SELECT COUNT(*) c FROM pagos_deudas').get().c,
    activity_log: db.prepare('SELECT COUNT(*) c FROM activity_log').get().c,
    undo_journal: db.prepare('SELECT COUNT(*) c FROM undo_journal').get().c,
  };
  db.close();

  // ── Comprobacion a nivel de BYTES, no de SQL ──────────────────────────────
  // La consulta SQL puede decir "limpio" mientras el binario conserva los datos
  // en paginas libres. Esta es la unica verificacion que valdria ante alguien
  // abriendo el .db con un editor hexadecimal, que es lo que importa cuando el
  // archivo se publica. Ojo: `strings` NO los encuentra; hay que buscar en crudo.
  const crudo = fs.readFileSync(DESTINO, 'latin1');
  const enBinario = sospechosos.filter(s => s && String(s).length >= 3 && crudo.includes(s));
  if (enBinario.length) {
    console.error(`\n  RESTO EN BINARIO: ${enBinario.join(', ')}`);
    restos += enBinario.length;
  }

  console.log('fixture:', DESTINO);
  console.log('identidades sustituidas:', mapa.size);
  console.log('filas:', JSON.stringify(resumen));
  if (restos) {
    console.error(`\nFALLO: quedaron ${restos} rastros de datos reales. No se puede commitear.`);
    process.exit(1);
  }
  console.log('sin rastros de datos reales: OK');
}

main();
