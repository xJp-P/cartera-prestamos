// tests/lib/db.js — copias de trabajo de la base de datos.
//
// CONVENCION #6 del proyecto: cualquier cosa que escriba en una BD lo hace
// sobre una COPIA. Este modulo es el UNICO punto por el que los tests
// obtienen una ruta de BD escribible, y se niega a devolver la productiva.

const fs   = require('fs');
const path = require('path');
const { PROD_DB, FIXTURE_DB, WORK } = require('./paths');

function asegurarWork() {
  if (!fs.existsSync(WORK)) fs.mkdirSync(WORK, { recursive: true });
  return WORK;
}

// Copia la BD FIXTURE a una ruta temporal unica y la devuelve.
//
// Conserva el nombre `copiaDeProduccion` porque el origen sigue siendo la cartera
// real —mismos importes, fechas, ids y casos borde—, pero con las identidades
// sustituidas (ver tests/fixture/crear-fixture.js). NINGUN test abre la BD del
// usuario: hacerlo arrastraba nombres, cedulas, telefonos, notas privadas y hasta
// los datos bancarios del propio usuario hasta los golden de un repo PUBLICO.
//
// Efecto lateral bueno: la suite deja de depender de que exista una BD concreta
// en una maquina concreta. Corre igual en cualquier clone.
function copiaDeProduccion(etiqueta) {
  asegurarWork();
  if (!fs.existsSync(FIXTURE_DB)) {
    throw new Error(
      `No se encuentra la BD fixture en ${FIXTURE_DB}.\n` +
      `Regenerala con: node tests/fixture/crear-fixture.js`
    );
  }
  const destino = path.join(WORK, `${etiqueta || 'copia'}-${process.pid}-${Date.now()}.db`);
  fs.copyFileSync(FIXTURE_DB, destino);
  guardarContraProduccion(destino);
  return destino;
}

// BD vacia: deja que `createApp` construya el esquema desde cero.
// Sirve para probar migraciones y endpoints sin datos heredados.
function bdVacia(etiqueta) {
  asegurarWork();
  const destino = path.join(WORK, `${etiqueta || 'vacia'}-${process.pid}-${Date.now()}.db`);
  if (fs.existsSync(destino)) fs.unlinkSync(destino);
  guardarContraProduccion(destino);
  return destino;
}

// Red de seguridad: si alguna vez una ruta de test apunta a la productiva,
// se aborta en vez de escribir sobre los datos del usuario.
function guardarContraProduccion(ruta) {
  const norm = p => path.resolve(String(p)).toLowerCase();
  if (norm(ruta) === norm(PROD_DB)) {
    throw new Error('ABORTADO: un test intento escribir sobre la BD de produccion.');
  }
  return ruta;
}

// Limpia las copias de corridas anteriores para que WORK no crezca sin fin.
function limpiarCopias() {
  if (!fs.existsSync(WORK)) return 0;
  let n = 0;
  for (const f of fs.readdirSync(WORK)) {
    if (f.endsWith('.db') || f.endsWith('.db-journal') || f.endsWith('.db-wal') || f.endsWith('.db-shm')) {
      try { fs.unlinkSync(path.join(WORK, f)); n++; } catch (_) { /* en uso: se ignora */ }
    }
  }
  return n;
}

module.exports = { copiaDeProduccion, bdVacia, guardarContraProduccion, limpiarCopias, WORK };
