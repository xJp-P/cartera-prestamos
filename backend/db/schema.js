// backend/db/schema.js — ESQUEMA Y MIGRACIONES.
//
// Extraido de `server.js` en la Etapa 2 (A2) del refactor de modularizacion.
// Todo el DDL viaja VERBATIM y EN EL MISMO ORDEN. El orden no es cosmetico:
// la migracion del flag `mig_v18_rename_cancelado` lee y escribe `config`, y la
// correctiva de `Cancelado` depende de que `capitalPerdido`/`interesesPerdidos`
// ya existan. Reordenar aqui es cambiar el resultado.
//
// ############################################################################
// #  REGLA DE ORO: ESTO CORRE ANTES QUE db/statements.js.                    #
// #  `insPayment` nombra 18 columnas de `payments`, y 6 de ellas solo existen #
// #  DESPUES de los ALTER (montoCOPRecibido, montoUSDRecibido, partialPaid,   #
// #  paidAt, recibos, extraConsolidado). Si los statements se preparan        #
// #  primero, `db.prepare` lanza y la app no abre.                            #
// ############################################################################
//
// En el monolito estas sentencias vivian en 5 tramos NO CONTIGUOS, con un
// `db.prepare` intercalado en medio. Aca quedan consolidadas en un solo lugar,
// respetando el orden original. Unico movimiento relativo: el bloque de
// `undo_journal` (que antes corria despues del housekeeping de arranque) sube al
// final del esquema. Es DDL independiente de todo lo que habia en medio, y asi el
// `ALTER TABLE activity_log ADD COLUMN undo_id` ocurre ANTES de que se prepare
// ningun statement sobre esa tabla, que es estrictamente mas seguro.
//
// Toda migracion es idempotente: los ALTER van en try/catch (SQLite no tiene
// "ADD COLUMN IF NOT EXISTS") y los UPDATE correctivos llevan un WHERE que
// garantiza que una 2a pasada no encuentre nada.

function aplicarEsquema(db) {
  db.exec(`
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS loans (
      id          TEXT PRIMARY KEY,
      nombre      TEXT NOT NULL,
      cedula      TEXT DEFAULT '',
      telefono    TEXT DEFAULT '',
      moneda      TEXT DEFAULT 'COP',
      montoOrigen REAL NOT NULL,
      trmAcordada REAL DEFAULT 1,
      montoCOP    REAL NOT NULL,
      tasaMensual REAL DEFAULT 0,
      plazoMeses  INTEGER NOT NULL,
      modalidad   TEXT DEFAULT 'Intereses',
      fechaInicio TEXT NOT NULL,
      diaPago     INTEGER DEFAULT 15,
      estado      TEXT DEFAULT 'Activo',
      notas       TEXT DEFAULT '',
      createdAt   TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS payments (
      id             TEXT PRIMARY KEY,
      prestamoId     TEXT NOT NULL,
      nombreCliente  TEXT NOT NULL,
      cuotaN         INTEGER NOT NULL,
      fechaPago      TEXT NOT NULL,
      saldoInicial   REAL DEFAULT 0,
      interesPeriodo REAL DEFAULT 0,
      abonoCapital   REAL DEFAULT 0,
      cuotaTotal     REAL DEFAULT 0,
      saldoFinal     REAL DEFAULT 0,
      estadoPago     TEXT DEFAULT 'Pendiente',
      fechaRecaudo   TEXT,
      observaciones  TEXT DEFAULT '',
      FOREIGN KEY(prestamoId) REFERENCES loans(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS config (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    INSERT OR IGNORE INTO config(key, value) VALUES ('trm', '4100');
  `);

  // Migraciones seguras
  try { db.exec('ALTER TABLE payments ADD COLUMN montoCOPRecibido REAL DEFAULT 0'); } catch(_){}
  try { db.exec('ALTER TABLE payments ADD COLUMN montoUSDRecibido REAL DEFAULT 0'); } catch(_){}
  // Pagos parciales: acumulado recibido antes de completar la cuota
  try { db.exec('ALTER TABLE payments ADD COLUMN partialPaid REAL DEFAULT 0'); } catch(_){}
  // v1.11.1: timestamp real (YYYY-MM-DD HH:MM:SS) de cuando se marco Pagado. Permite ordenar
  // "Transacciones recientes" por HORA exacta y no solo por fecha de recaudo (que empata el mismo dia).
  try { db.exec('ALTER TABLE payments ADD COLUMN paidAt TEXT'); } catch(_){}
  // v1.11.4: ledger de recibos (flujo de caja real). JSON [{fecha,cop}] — un evento por
  // transaccion (cada parcial en su fecha de recaudo + el pago final). Permite que "Cobros del
  // Mes" cuente los parciales en curso en su dia exacto sin doble conteo. Las filas sin ledger
  // (historico, abonos, liquidaciones de mora) usan fallback a fechaRecaudo en el frontend.
  try { db.exec("ALTER TABLE payments ADD COLUMN recibos TEXT DEFAULT '[]'"); } catch(_){}
  // Renombrar modalidad legacy
  try { db.exec("UPDATE loans SET modalidad = 'Intereses' WHERE modalidad = 'Solo Intereses'"); } catch(_){}
  // Migración: frecuencia de pago
  try { db.exec("ALTER TABLE loans ADD COLUMN frecuencia TEXT DEFAULT 'Mensual'"); } catch(_){}
  // Cierre forzoso: snapshot de pérdida (capital pendiente + intereses en mora al momento del cierre)
  try { db.exec('ALTER TABLE loans ADD COLUMN capitalPerdido REAL DEFAULT 0'); } catch(_){}
  try { db.exec('ALTER TABLE loans ADD COLUMN interesesPerdidos REAL DEFAULT 0'); } catch(_){}
  // Migración v1.8: renombrar 'Cancelado' legacy a 'Finalizado'. Antes 'Cancelado' significaba éxito;
  // ahora significa cierre forzoso con pérdidas. CORRE UNA SOLA VEZ — controlada por flag en config.
  try {
    var migRow = db.prepare("SELECT value FROM config WHERE key = 'mig_v18_rename_cancelado'").get();
    if (!migRow) {
      db.exec("UPDATE loans SET estado = 'Finalizado' WHERE estado = 'Cancelado'");
      db.prepare("INSERT OR REPLACE INTO config(key, value) VALUES ('mig_v18_rename_cancelado', '1')").run();
    }
  } catch(_){}
  // Migración correctiva (idempotente): si un préstamo quedó como 'Finalizado' pero tiene pérdidas
  // registradas, en realidad fue un cierre forzoso — corregir a 'Cancelado'.
  try { db.exec("UPDATE loans SET estado = 'Cancelado' WHERE estado = 'Finalizado' AND (capitalPerdido > 0 OR interesesPerdidos > 0)"); } catch(_){}
  // Compras fraccionadas de USD: desglose de lotes con su tasa. JSON: [{monto, tasa}, ...]
  try { db.exec("ALTER TABLE loans ADD COLUMN comprasUSD TEXT DEFAULT ''"); } catch(_){}
  // Extra consolidado en una cuota (prorrateo + mora del cambio-dia-pago) que debe preservarse al recalcular
  try { db.exec("ALTER TABLE payments ADD COLUMN extraConsolidado REAL DEFAULT 0"); } catch(_){}
  // Extra pendiente del prorrateo a aplicar a la PROXIMA cuota regular del prestamo.
  // Persiste en loans para sobrevivir cualquier regeneracion del cronograma (recalculate, edit, etc.).
  // Se aplica a la primera cuota Pendiente cuyo cuotaN >= proximaCuotaExtraN.
  // Se limpia automaticamente cuando esa cuota se paga.
  try { db.exec("ALTER TABLE loans ADD COLUMN proximaCuotaExtra REAL DEFAULT 0"); } catch(_){}
  try { db.exec("ALTER TABLE loans ADD COLUMN proximaCuotaExtraN INTEGER DEFAULT 0"); } catch(_){}
  // Base del cronograma SOLO para el calculo de FECHAS (no toca fechaInicio, que es historico y lo
  // usan reportes/antiguedad). Default NULL -> buildSchedule cae a fechaInicio (cero cambio para
  // prestamos sin salto). /cambiar-dia-pago la adelanta 1 mes cuando el nuevo dia adelantaria el
  // cobro (regla "nunca adelantar"), para que el aplazamiento sobreviva a /recalculate y PUT /loans.
  try { db.exec("ALTER TABLE loans ADD COLUMN fechaBaseCronograma TEXT"); } catch(_){}
  // Cuota fija pactada (modo "Fijar cuota" de abono opcion 3): cuando > 0, el cronograma debe
  // regenerarse usando buildScheduleFixedPMT en vez de buildSchedule.
  // Se limpia al saldar el prestamo o al hacer un abono con otra opcion (Mantener/Modificar plazo).
  try { db.exec("ALTER TABLE loans ADD COLUMN cuotaFijaPactada REAL DEFAULT 0"); } catch(_){}

  // ── Migración v1.18.2 (Bug #30): normalizar abonoCapital en modalidad 'Prestamo' ──
  // Historicamente buildSchedule escribia abonoCapital=0 en la cuota unica de un Prestamo (0% interes),
  // asi que la formula canonica de saldo (origCOP - Σ abonoCapital de Pagadas) no contaba el capital
  // cobrado -> prestamos ya saldados arrastraban un saldo fantasma. Ahora se persiste el capital real.
  // Esta migracion sanea los datos historicos.
  // IDEMPOTENTE Y AUTO-LIMITADA: solo toca filas cuyo abonoCapital difiere de (cuotaTotal - interesPeriodo),
  // es decir las escritas con 0. Excluye abonos (-ab-) y las cuotas En Mora ya normalizadas por el
  // housekeeping (cuyo abonoCapital ya == cuotaTotal, con interesPeriodo=0). Correr N veces = correr 1.
  // No requiere flag: el propio WHERE garantiza que una 2a pasada no encuentre nada.
  try {
    db.exec(`
      UPDATE payments
         SET abonoCapital = cuotaTotal - interesPeriodo
       WHERE id IN (
         SELECT p.id FROM payments p
           JOIN loans l ON l.id = p.prestamoId
          WHERE l.modalidad = 'Prestamo'
            AND p.id NOT LIKE '%-ab-%'
            AND p.abonoCapital <> p.cuotaTotal - p.interesPeriodo
       )
    `);
  } catch(_){}

  // ── Interes Diario (credito abierto): columnas cache del devengo ────────────
  // El estado del devengo es DERIVABLE de (fechaInicio + los cortes), y esa
  // derivacion —`devengoDiario` en core/engine.js— sigue siendo la autoridad.
  // Estas dos columnas son un CACHE del estado en el ultimo evento economico:
  //
  //   fechaUltimoCorte      fecha del ultimo corte. NULL -> no hay ninguno, y el
  //                         devengo arranca en `fechaInicio`. Por eso el default
  //                         NULL es correcto y no hace falta rellenar nada: los
  //                         prestamos de las otras 4 modalidades no la usan jamas.
  //   interesAcumuladoPend  interes devengado y NO cobrado hasta ese corte. Es el
  //                         arrastre: el modelo NO capitaliza (decision de negocio),
  //                         asi que el interes impago no puede vivir sumado al
  //                         capital — necesita columna propia o se perderia.
  //
  // Interes de hoy = interesAcumuladoPend + devengo([fechaUltimoCorte, hoy)).
  // Que el cache y la derivacion completa coincidan es un INVARIANTE verificable,
  // y es lo que delata una divergencia entre el ledger de cortes y el atajo.
  try { db.exec("ALTER TABLE loans ADD COLUMN fechaUltimoCorte TEXT"); } catch(_){}
  try { db.exec("ALTER TABLE loans ADD COLUMN interesAcumuladoPend REAL DEFAULT 0"); } catch(_){}

  // interesesCondonados (v2.9.0) — intereses PERDONADOS por acuerdo comercial, ADITIVO
  // (se puede condonar mas de una vez). NO se reusa `interesesPerdidos`: ese es un
  // snapshot del cierre forzoso y significa "el deudor no pago"; condonar significa
  // "recupere el capital y perdone el redito". Conflarlos mantiene el error de
  // etiqueta que Rendimiento ya comete al pintar esos creditos como perdida total.
  try { db.exec("ALTER TABLE loans ADD COLUMN interesesCondonados REAL DEFAULT 0"); } catch(_){}

  // ── Tabla de historial de acciones ──────────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS activity_log (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      fecha     TEXT DEFAULT (datetime('now','localtime')),
      tipo      TEXT NOT NULL,
      mensaje   TEXT NOT NULL
    )
  `);

  // ── Modulo "Mis Deudas" (lo que YO debo) — registro manual ──────────────────
  // Sin intereses ni cuotas automaticas. El saldo se reduce manualmente via abonos
  // registrados en el ledger pagos_deudas. mis_deudas primero (la FK la referencia).
  db.exec(`
    CREATE TABLE IF NOT EXISTS mis_deudas (
      id              TEXT PRIMARY KEY,
      acreedor        TEXT NOT NULL,
      concepto        TEXT DEFAULT '',
      monto_original  REAL NOT NULL DEFAULT 0,
      saldo_pendiente REAL NOT NULL DEFAULT 0,
      estado          TEXT NOT NULL DEFAULT 'Activa',
      fecha_creacion  TEXT DEFAULT (datetime('now','localtime'))
    );
    CREATE TABLE IF NOT EXISTS pagos_deudas (
      id           TEXT PRIMARY KEY,
      deuda_id     TEXT NOT NULL,
      monto_pagado REAL NOT NULL DEFAULT 0,
      fecha_pago   TEXT NOT NULL,
      notas        TEXT DEFAULT '',
      FOREIGN KEY(deuda_id) REFERENCES mis_deudas(id) ON DELETE CASCADE
    );
  `);
  // QA2: campo "titulo" independiente de la descripcion (migracion segura e idempotente).
  try { db.exec("ALTER TABLE mis_deudas ADD COLUMN titulo TEXT DEFAULT ''"); } catch(_){}
  // QA5: tipo de movimiento en el ledger ('abono' reduce la deuda, 'cargo' la aumenta).
  try { db.exec("ALTER TABLE pagos_deudas ADD COLUMN tipo TEXT DEFAULT 'abono'"); } catch(_){}
  try { db.exec("ALTER TABLE loans ADD COLUMN fechaDevolucion TEXT DEFAULT ''"); } catch(_){}
  // v1.10.0: ganancia para modalidad 'Pago Unico' (monto unico pactado en COP)
  try { db.exec("ALTER TABLE loans ADD COLUMN gananciaFija REAL DEFAULT 0"); } catch(_){}

  // ══════════════════════════════════════════════════════════════════════════
  // "La Bestia" — Fase 1: infraestructura de DESHACER (undo_journal)
  // ══════════════════════════════════════════════════════════════════════════
  // Doctrina: se guarda el SNAPSHOT del AGREGADO COMPLETO antes de mutar (no diffs
  // ni matematica inversa), y el journal se escribe DENTRO de la misma transaccion
  // que la mutacion. Deshacer = restaurar el agregado verbatim + re-aplicar el
  // housekeeping determinista (auto-mora, fixPrestamos) para que el paso del tiempo
  // no corrompa estados (Candado B). LIFO estricto por scope (Candado A).
  db.exec(`
    CREATE TABLE IF NOT EXISTS undo_journal (
      id           TEXT PRIMARY KEY,
      created_at   TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      accion       TEXT NOT NULL,
      endpoint     TEXT NOT NULL,
      descripcion  TEXT NOT NULL,
      scope_tipo   TEXT NOT NULL,
      scope_id     TEXT NOT NULL,
      snapshot     TEXT NOT NULL,
      pre_hash     TEXT NOT NULL,
      post_hash    TEXT NOT NULL,
      estado       TEXT NOT NULL DEFAULT 'disponible',
      undone_at    TEXT,
      app_version  TEXT NOT NULL DEFAULT '',
      schema_ver   INTEGER NOT NULL DEFAULT 1,
      afecta_caja  INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_uj_scope  ON undo_journal(scope_tipo, scope_id);
    CREATE INDEX IF NOT EXISTS idx_uj_estado ON undo_journal(estado);
  `);
  // afecta_caja: la operacion movio dinero real (pago, parcial o abono) -> deshacerla puede
  // invalidar un recibo PDF que el deudor YA tiene en la mano. Alimenta la alerta severa de la UI.
  // ALTER idempotente por si la tabla se creo antes de existir esta columna.
  try { db.exec('ALTER TABLE undo_journal ADD COLUMN afecta_caja INTEGER NOT NULL DEFAULT 0'); } catch (_) {}
  // Enlace 1:1 entre la entrada del historial y su entrada de undo. Sin esta columna habria que
  // aparear por (tipo, mensaje, timestamp), que colisiona ante dos operaciones identicas.
  try { db.exec('ALTER TABLE activity_log ADD COLUMN undo_id TEXT'); } catch (_) {}
}

module.exports = { aplicarEsquema };
