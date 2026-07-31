// backend/core/atomic.js — MUTACION ATOMICA + JOURNAL DE UNDO ("La Bestia").
//
// Extraido de `server.js` en la Etapa 2 (A4) del refactor de modularizacion.
// Codigo movido VERBATIM.
//
// Doctrina (no se renegocia): todo endpoint que escriba pasa por `mutacionAtomica`.
// No abre su propia transaccion ni llama a logAction por su cuenta: devuelve
// { descripcion, payload, aplicar, afectaCaja } desde compute() y deja que el
// helper haga la FASE 2.
//   FASE 0  snapshot del agregado (solo lectura) + pre_hash
//   FASE 1  compute() valida y computa TODO en memoria; si lanza ClientError -> 4xx
//           con la BD intacta (ni una escritura)
//   FASE 2  UNA transaccion: aplicar() + INSERT journal + activity_log + poda
//
// El journal se escribe DENTRO de la misma transaccion que la mutacion. Fuera de
// ella hay dos fallos irrecuperables: mutacion sin journal (imposible deshacer) o
// journal sin mutacion (undo fantasma que corrompe).
//
// ES UNA FACTORY, Y ESO IMPORTA: `_colsCache` (PRAGMA table_info) no se invalida
// nunca. Hoy es seguro solo porque vive en el closure de `createApp`, es decir una
// cache por instancia y por BD. Si fuera una constante de modulo, dos instancias
// con esquemas distintos compartirian columnas y el restore escribiria en la tabla
// equivocada. Por eso se crea aca adentro y no arriba.
//
// `mutacionAtomica` es DUENA DE LA RESPUESTA HTTP (res.status().json()). No se
// convirtio en funcion pura porque eso obligaria a reescribir los 11 endpoints
// journalizados, que es cambio de logica y esta fuera del alcance del refactor.

const crypto = require('crypto');
const { ClientError } = require('./errors');
const { genId } = require('./util');

function crearAtomic({ db, insUndo, logActionUndo, appVersion }) {

  // Serializacion canonica (claves ordenadas, recursiva) -> hash estable e
  // independiente del orden de columnas que devuelva el driver.
  function stableStringify(v) {
    if (v === null || typeof v !== 'object') return JSON.stringify(v);
    if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
    return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}';
  }
  function hashSnapshot(obj) {
    return crypto.createHash('sha256').update(stableStringify(obj)).digest('hex');
  }

  // Columnas vigentes de una tabla (cache). Base del restore por INTERSECCION:
  // restaurar solo las columnas que existen hoy -> un snapshot viejo con menos
  // columnas deja las nuevas en su default (Candado E, drift de esquema).
  const _colsCache = {};
  function tableCols(t) {
    if (!_colsCache[t]) _colsCache[t] = db.prepare('PRAGMA table_info(' + t + ')').all().map(c => c.name);
    return _colsCache[t];
  }
  function restoreRow(table, row) {
    const cols = tableCols(table).filter(c => Object.prototype.hasOwnProperty.call(row, c));
    const vals = {}; cols.forEach(c => { vals[c] = row[c]; });
    db.prepare('INSERT OR REPLACE INTO ' + table + '(' + cols.join(',') + ') VALUES (' + cols.map(c => '@' + c).join(',') + ')').run(vals);
  }

  // ── Snapshot del AGREGADO (todo lo que una mutacion podria tocar) ────────────
  // Por que el agregado ENTERO y no solo la fila tocada: casi toda operacion tiene
  // efectos colaterales (p.ej. PUT /payments dispara la auto-finalizacion, que muta
  // loans.estado/montoCOP). Snapshotear solo la cuota dejaria el prestamo corrupto
  // al deshacer. El agregado elimina esa clase de bug por construccion.
  function snapshotScope(tipo, id) {
    if (tipo === 'debt') {
      return {
        v: 1, tipo: 'debt',
        deuda: db.prepare('SELECT * FROM mis_deudas WHERE id = ?').get(id) || null,
        pagos: db.prepare('SELECT * FROM pagos_deudas WHERE deuda_id = ? ORDER BY id').all(id)
      };
    }
    return {
      v: 1, tipo: 'loan',
      loan: db.prepare('SELECT * FROM loans WHERE id = ?').get(id) || null,
      payments: db.prepare('SELECT * FROM payments WHERE prestamoId = ? ORDER BY cuotaN, id').all(id)
    };
  }
  // Restaurar reemplaza el agregado ENTERO (no parchea filas sueltas). Los IDs de
  // cuota son deterministas (`${loanId}-${cuotaN}`), asi que reinsertar es exacto.
  function restoreScope(snap, id) {
    if (snap.tipo === 'debt') {
      db.prepare('DELETE FROM pagos_deudas WHERE deuda_id = ?').run(id);
      db.prepare('DELETE FROM mis_deudas WHERE id = ?').run(id);
      if (snap.deuda) restoreRow('mis_deudas', snap.deuda);
      (snap.pagos || []).forEach(p => restoreRow('pagos_deudas', p));
    } else {
      db.prepare('DELETE FROM payments WHERE prestamoId = ?').run(id);
      if (snap.loan) restoreRow('loans', snap.loan);
      else db.prepare('DELETE FROM loans WHERE id = ?').run(id);
      (snap.payments || []).forEach(p => restoreRow('payments', p));
    }
  }

  // Retencion: conservar las 200 mas recientes y descartar > 90 dias (lo que ocurra
  // primero). Borra el TAIL (mas viejo), nunca el head, asi que no rompe el LIFO.
  function podarJournal() {
    db.prepare("DELETE FROM undo_journal WHERE created_at < datetime('now','localtime','-90 days')").run();
    db.prepare("DELETE FROM undo_journal WHERE rowid NOT IN (SELECT rowid FROM undo_journal ORDER BY rowid DESC LIMIT 200)").run();
  }

  // ── HELPER UNIVERSAL: mutacion atomica con journal de undo ───────────────────
  // FASE 0: snapshot del agregado (solo lectura) + pre_hash.
  // FASE 1: compute() valida + computa TODO en memoria; si lanza ClientError -> 4xx,
  //         BD intacta (ni una escritura).
  // FASE 2: UNA sola transaccion -> aplicar() + INSERT journal (post_hash releido
  //         DENTRO de la tx) + activity_log + poda. Todo o nada.
  // compute() debe devolver { descripcion, payload, aplicar }.
  // La respuesta HTTP sale de: (lo que devuelva aplicar()) || payload || {ok:true}. Devolver el
  // payload desde aplicar() permite responder con la fila YA MUTADA (p.ej. la deuda actualizada),
  // que solo puede leerse despues de escribir y dentro de la misma transaccion.
  // descripcion tambien acepta funcion: se evalua tras aplicar(), para textos que dependen del
  // estado final (p.ej. el saldo recalculado desde el ledger).
  function mutacionAtomica(req, res, meta, compute) {
    const pre = snapshotScope(meta.scopeTipo, meta.scopeId);
    const preHash = hashSnapshot(pre);
    let computed;
    try {
      computed = compute();
    } catch (e) {
      if (e instanceof ClientError) return res.status(e.code).json({ error: e.message });
      throw e;
    }
    let payload = null;
    const run = db.transaction(() => {
      payload = computed.aplicar() || computed.payload || { ok: true };
      const desc = typeof computed.descripcion === 'function' ? computed.descripcion() : computed.descripcion;
      const postHash = hashSnapshot(snapshotScope(meta.scopeTipo, meta.scopeId));
      const ujId = 'uj-' + genId();
      // afectaCaja lo declara compute() (puede depender de los datos: PUT /payments solo mueve
      // dinero cuando se marca Pagado, no al revertir a Pendiente / marcar En Mora).
      const afectaCaja = computed.afectaCaja ? 1 : 0;
      insUndo.run({
        id: ujId, accion: meta.accion, endpoint: meta.endpoint,
        descripcion: desc, scope_tipo: meta.scopeTipo, scope_id: meta.scopeId,
        snapshot: JSON.stringify(pre), pre_hash: preHash, post_hash: postHash,
        app_version: appVersion, afecta_caja: afectaCaja
      });
      logActionUndo.run(meta.logTipo || meta.accion, desc, ujId);
      return ujId;
    });
    const undoId = run();
    res.json(Object.assign({ undoId: undoId }, payload));
  }

  return {
    stableStringify, hashSnapshot, tableCols, restoreRow,
    snapshotScope, restoreScope, podarJournal, mutacionAtomica,
  };
}

module.exports = { crearAtomic };
