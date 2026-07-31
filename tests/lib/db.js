// tests/lib/db.js — copias de trabajo de la base de datos.
//
// CONVENCION #6 del proyecto: cualquier cosa que escriba en una BD lo hace
// sobre una COPIA. Este modulo es el UNICO punto por el que los tests
// obtienen una ruta de BD escribible, y se niega a devolver la productiva.

const fs   = require('fs');
const path = require('path');
const { PROD_DB, WORK } = require('./paths');

function asegurarWork() {
  if (!fs.existsSync(WORK)) fs.mkdirSync(WORK, { recursive: true });
  return WORK;
}

// Copia la BD de produccion a una ruta temporal unica y la devuelve.
// `etiqueta` solo sirve para poder identificar el archivo si algo falla.
function copiaDeProduccion(etiqueta) {
  asegurarWork();
  if (!fs.existsSync(PROD_DB)) {
    throw new Error(
      `No se encuentra la BD de produccion en ${PROD_DB}.\n` +
      `Los tests que dependen de datos reales no pueden correr.`
    );
  }
  const destino = path.join(WORK, `${etiqueta || 'copia'}-${process.pid}-${Date.now()}.db`);
  fs.copyFileSync(PROD_DB, destino);
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
