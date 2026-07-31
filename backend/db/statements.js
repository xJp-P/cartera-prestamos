// backend/db/statements.js — sentencias preparadas de larga vida.
//
// Extraido de `server.js` en la Etapa 2 (A3) del refactor de modularizacion.
// SQL movido VERBATIM.
//
// ############################################################################
// #  ORDEN OBLIGATORIO: `aplicarEsquema(db)` PRIMERO, ESTO DESPUES.          #
// #  `insPayment` nombra 18 columnas de `payments`, y 6 solo existen tras los #
// #  ALTER (montoCOPRecibido, montoUSDRecibido, partialPaid, paidAt, recibos, #
// #  extraConsolidado). Al reves, `db.prepare` lanza y la app no abre.        #
// #  Igual `logActionUndo`, que necesita `activity_log.undo_id`.              #
// ############################################################################

function crearStatements(db) {

  const logAction = db.prepare('INSERT INTO activity_log(tipo, mensaje) VALUES (?, ?)');

  const insPayment = db.prepare(`
    INSERT OR REPLACE INTO payments(id,prestamoId,nombreCliente,cuotaN,fechaPago,saldoInicial,
      interesPeriodo,abonoCapital,cuotaTotal,saldoFinal,estadoPago,fechaRecaudo,observaciones,montoCOPRecibido,montoUSDRecibido,partialPaid,extraConsolidado,recibos)
    VALUES (@id,@prestamoId,@nombreCliente,@cuotaN,@fechaPago,@saldoInicial,
      @interesPeriodo,@abonoCapital,@cuotaTotal,@saldoFinal,@estadoPago,@fechaRecaudo,@observaciones,@montoCOPRecibido,@montoUSDRecibido,@partialPaid,@extraConsolidado,@recibos)
  `);

  // `recibos` es INSERT OR REPLACE: si no se lista, REPLACE borra la fila y la reinserta con el
  // DEFAULT '[]' -> el ledger de caja se pierde en silencio al regenerar. Se normaliza aqui, en
  // un solo punto, para que ningun constructor de filas tenga que acordarse de la columna.
  const runPayment = r => insPayment.run(Object.assign({}, r, { recibos: r.recibos == null ? '[]' : r.recibos }));

  // OJO: esta transaccion se invoca DENTRO de la transaccion de `mutacionAtomica`.
  // better-sqlite3 lo resuelve con savepoints (transacciones anidadas). Preservar tal cual.
  const insertSchedule = db.transaction(rows => rows.forEach(r => runPayment(r)));

  const insUndo = db.prepare(`
    INSERT INTO undo_journal(id, accion, endpoint, descripcion, scope_tipo, scope_id, snapshot, pre_hash, post_hash, app_version, afecta_caja)
    VALUES (@id, @accion, @endpoint, @descripcion, @scope_tipo, @scope_id, @snapshot, @pre_hash, @post_hash, @app_version, @afecta_caja)
  `);

  // El log se escribe con el id de su entrada de undo para que el Historial sepa que fila es
  // reversible (enlace 1:1, no apareo por texto).
  const logActionUndo = db.prepare('INSERT INTO activity_log(tipo, mensaje, undo_id) VALUES (?, ?, ?)');

  return { logAction, insPayment, runPayment, insertSchedule, insUndo, logActionUndo };
}

module.exports = { crearStatements };
