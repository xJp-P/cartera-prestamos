/**
 * server.js — Express API
 * Exporta una función factory que recibe la ruta del DB.
 * desktop/main.js crea el servidor http y llama a .listen().
 */

const express  = require('express');
const Database = require('better-sqlite3');
const path     = require('path');
const crypto   = require('crypto');

// Raíz del proyecto (un nivel arriba de /backend)
const PROJECT_ROOT = path.join(__dirname, '..');

// Fecha local (no UTC) en formato YYYY-MM-DD
function hoyStr() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

// ID unico estilo timestamp + sufijo aleatorio (mismo formato que los IDs de loans)
function genId() {
  return Date.now().toString() + Math.random().toString(36).slice(2, 6);
}

module.exports = function createApp(dbPath) {

  const app = express();

  // ── Servir React desde node_modules (sin internet) ────────────────────────
  // Usamos package.json como punto de entrada porque React 18 restringe
  // el acceso directo a subcarpetas via require.resolve()
  app.get('/vendor/react.js', (_req, res) => {
    const base = path.dirname(require.resolve('react/package.json'));
    res.sendFile(path.join(base, 'umd', 'react.production.min.js'));
  });
  app.get('/vendor/react-dom.js', (_req, res) => {
    const base = path.dirname(require.resolve('react-dom/package.json'));
    res.sendFile(path.join(base, 'umd', 'react-dom.production.min.js'));
  });

  app.use(express.json());
  app.use(express.static(path.join(PROJECT_ROOT, 'public')));

  // ── Base de datos ─────────────────────────────────────────────────────────
  const db = new Database(dbPath);

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
  const logAction = db.prepare('INSERT INTO activity_log(tipo, mensaje) VALUES (?, ?)');
  try { db.exec("ALTER TABLE loans ADD COLUMN fechaDevolucion TEXT DEFAULT ''"); } catch(_){}
  // v1.10.0: ganancia para modalidad 'Pago Unico' (monto unico pactado en COP)
  try { db.exec("ALTER TABLE loans ADD COLUMN gananciaFija REAL DEFAULT 0"); } catch(_){}


  // ── Motor financiero ──────────────────────────────────────────────────────
  function pmt(r, n, pv) {
    if (r === 0) return pv / n;
    return pv * r * Math.pow(1 + r, n) / (Math.pow(1 + r, n) - 1);
  }

  function getPayDate(startISO, cuotaN, diaPago, frecuencia) {
    const d = new Date(startISO + 'T12:00:00');
    if (frecuencia === 'Semanal') {
      d.setDate(d.getDate() + cuotaN * 7);
      return d.toISOString().split('T')[0];
    }
    if (frecuencia === 'Quincenal') {
      d.setDate(d.getDate() + cuotaN * 14);
      return d.toISOString().split('T')[0];
    }
    // Mensual (default)
    d.setDate(1);
    d.setMonth(d.getMonth() + cuotaN);
    d.setDate(Math.min(diaPago, new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()));
    return d.toISOString().split('T')[0];
  }

  // Convertir tasa mensual a tasa del período según frecuencia
  function tasaPeriodo(tasaMensual, frecuencia) {
    if (frecuencia === 'Semanal') return tasaMensual / 4.33;
    if (frecuencia === 'Quincenal') return tasaMensual / 2;
    return tasaMensual; // Mensual
  }

  /**
   * buildSchedule — genera cronograma de cuotas
   * @param {object} loan        - datos del prestamo
   * @param {number} startN      - numero de cuota inicial (default 1)
   * @param {number} startSaldo  - saldo sobre el cual calcular (default loan.montoCOP)
   * @param {number} numCuotas   - cuantas cuotas generar (default: plazoMeses completo)
   *
   * startN tambien determina el offset de fecha: cuotaN=5 => mes 5 desde fechaInicio
   */
  // Para Intereses: calcular cuántas cuotas generar hasta N períodos adelante de hoy
  function cuotasHastaHoy(fechaInicio, startN, periodosAdelante, frecuencia) {
    const hoy = new Date();
    const inicio = new Date(fechaInicio + 'T12:00:00');
    const diffMs = hoy - inicio;
    const diasDiff = diffMs / (24 * 60 * 60 * 1000);
    var periodosDesdeInicio;
    if (frecuencia === 'Semanal') periodosDesdeInicio = Math.ceil(diasDiff / 7);
    else if (frecuencia === 'Quincenal') periodosDesdeInicio = Math.ceil(diasDiff / 14);
    else periodosDesdeInicio = Math.ceil(diasDiff / 30.44);
    periodosDesdeInicio += periodosAdelante;
    return Math.max(3, periodosDesdeInicio - startN + 1);
  }

  function buildSchedule(loan, startN, startSaldo, numCuotas) {
    startN = startN || 1;
    const { id, nombre, tasaMensual, modalidad, fechaInicio, diaPago } = loan;
    const freq = loan.frecuencia || 'Mensual';
    // Base para las FECHAS del cronograma (aplazamiento por cambio de dia de pago). NULL -> fechaInicio.
    const baseCron = loan.fechaBaseCronograma || fechaInicio;
    const montoCOP = startSaldo !== undefined ? startSaldo : loan.montoCOP;
    const indefinido = modalidad === 'Intereses';
    const totalCuotas = numCuotas !== undefined ? numCuotas : (indefinido ? cuotasHastaHoy(fechaInicio, startN, 3, freq) : (loan.plazoMeses || 12));
    const r = tasaPeriodo(tasaMensual / 100, freq);
    let saldo = montoCOP;
    const cuotaFija = pmt(r, totalCuotas, montoCOP);
    const rows = [];

    // Prestamo sin intereses: 1 cuota por el capital total (interesPeriodo=0, abonoCapital=capital).
    // v1.18.2 (Bug #30): abonoCapital persiste el CAPITAL (= cuotaTotal, ya que interes=0), NO 0.
    // El 0 historico era defensa contra la heuristica fragil 'interesPeriodo===0 && abonoCapital>0'
    // que confundia esta cuota con un abono; esa heuristica se erradico en v1.14.0 (Bug #28) y hoy
    // los abonos se identifican SOLO por id.indexOf('-ab-'). Con el 0, la formula canonica de saldo
    // (origCOP - Σ abonoCapital de Pagadas) no contaba el capital cobrado -> saldo fantasma en
    // prestamos ya saldados. Ahora es byte-identico a lo que 'Pago Unico' persiste con ganancia 0.
    if (modalidad === 'Prestamo') {
      var fechaCuota = loan.fechaDevolucion || getPayDate(baseCron, 1, diaPago, freq);
      rows.push({
        id: `${id}-1`, prestamoId: id, nombreCliente: nombre, cuotaN: 1,
        fechaPago: fechaCuota,
        saldoInicial: Math.round(montoCOP), interesPeriodo: 0,
        abonoCapital: Math.round(montoCOP), cuotaTotal: Math.round(montoCOP),
        saldoFinal: 0, estadoPago: 'Pendiente', fechaRecaudo: null, observaciones: '',
        montoCOPRecibido: 0, montoUSDRecibido: 0, partialPaid: 0, extraConsolidado: 0
      });
      return rows;
    }

    // v1.10.0 — Pago Unico: 1 cuota con capital + ganancia fija pactada
    // interesPeriodo carga la ganancia → entra al KPI Ganancias del Dashboard
    // abonoCapital carga el capital → entra al calculo de Saldo Pendiente
    // cuotaTotal = capital + ganancia → entra al Recaudo del mes
    if (modalidad === 'Pago Unico') {
      var fechaCuotaPU = loan.fechaDevolucion || getPayDate(baseCron, 1, diaPago, freq);
      var capitalPU = Math.round(montoCOP);
      var gananciaPU = Math.round(+loan.gananciaFija || 0);
      rows.push({
        id: `${id}-1`, prestamoId: id, nombreCliente: nombre, cuotaN: 1,
        fechaPago: fechaCuotaPU,
        saldoInicial: capitalPU,
        interesPeriodo: gananciaPU,
        abonoCapital: capitalPU,
        cuotaTotal: capitalPU + gananciaPU,
        saldoFinal: 0, estadoPago: 'Pendiente', fechaRecaudo: null, observaciones: '',
        montoCOPRecibido: 0, montoUSDRecibido: 0, partialPaid: 0, extraConsolidado: 0
      });
      return rows;
    }

    for (let i = 0; i < totalCuotas; i++) {
      const cuotaN = startN + i;
      const interes = Math.round(saldo * r * 100) / 100;
      const isLast  = indefinido ? false : (i === totalCuotas - 1);
      let capital, cuota;

      if (indefinido || modalidad === 'Intereses') {
        capital = isLast ? saldo : 0;
        cuota   = isLast ? Math.round((interes + saldo) * 100) / 100 : Math.round(interes * 100) / 100;
      } else {
        capital = isLast ? saldo : Math.round((cuotaFija - interes) * 100) / 100;
        cuota   = isLast ? Math.round((interes + saldo) * 100) / 100 : Math.round(cuotaFija * 100) / 100;
      }

      const saldoFinal = Math.max(0, Math.round((saldo - capital) * 100) / 100);
      rows.push({
        id: `${id}-${cuotaN}`, prestamoId: id, nombreCliente: nombre, cuotaN: cuotaN,
        fechaPago: getPayDate(baseCron, cuotaN, diaPago, freq),
        saldoInicial: Math.round(saldo), interesPeriodo: Math.round(interes),
        abonoCapital: Math.round(capital), cuotaTotal: Math.round(cuota),
        saldoFinal: Math.round(saldoFinal),
        estadoPago: 'Pendiente', fechaRecaudo: null, observaciones: '',
        montoCOPRecibido: 0, montoUSDRecibido: 0, partialPaid: 0, extraConsolidado: 0
      });
      saldo = saldoFinal;
    }
    return rows;
  }

  /**
   * buildScheduleFixedPMT — genera cronograma con cuota fija y cuota residual final.
   * Usado por opcion 3 del recalculo (Fijar valor de cuota).
   * Genera N-1 cuotas iguales de cuotaFija + 1 ultima cuota que ajusta el saldo a 0.
   *
   * @param {object} loan        - datos del prestamo (necesita id, nombre, fechaInicio, diaPago, frecuencia, modalidad, tasaMensual)
   * @param {number} startN      - numero de cuota inicial
   * @param {number} saldoInicial - saldo de capital sobre el cual aplicar
   * @param {number} cuotaFija   - cuota deseada por periodo (debe ser > saldoInicial * r)
   * @returns {Array<object>} - filas de cuotas (la ultima es la residual)
   * @throws Error si cuotaFija <= saldoInicial * r (cuota insuficiente para cubrir intereses)
   */
  function buildScheduleFixedPMT(loan, startN, saldoInicial, cuotaFija) {
    const { id, nombre, tasaMensual, fechaInicio, diaPago } = loan;
    const freq = loan.frecuencia || 'Mensual';
    const baseCron = loan.fechaBaseCronograma || fechaInicio; // fechas via base de cronograma (aplazamiento)
    const r = tasaPeriodo(tasaMensual / 100, freq);
    const interesInicial = saldoInicial * r;
    // Validacion: cuota debe cubrir al menos el interes del primer periodo
    if (cuotaFija <= interesInicial) {
      throw new Error('Cuota insuficiente: $' + Math.round(cuotaFija).toLocaleString('es-CO') +
        ' no cubre el interes del primer periodo ($' + Math.round(interesInicial).toLocaleString('es-CO') + ').');
    }
    const rows = [];
    let saldo = saldoInicial;
    let cuotaN = startN;
    const MAX_ITER = 1000; // safety net
    let i = 0;
    while (saldo > 0.5 && i < MAX_ITER) {
      const interes = Math.round(saldo * r * 100) / 100;
      // Si esta cuota completa o exceria el saldo, es la ultima (residual)
      const saldoMasInteres = saldo + interes;
      let capital, cuotaTotal, saldoFinal;
      if (saldoMasInteres <= cuotaFija + 0.5) {
        // Ultima cuota: residual exacto
        capital = saldo;
        cuotaTotal = Math.round(saldoMasInteres * 100) / 100;
        saldoFinal = 0;
      } else {
        capital = Math.round((cuotaFija - interes) * 100) / 100;
        cuotaTotal = cuotaFija;
        saldoFinal = Math.max(0, Math.round((saldo - capital) * 100) / 100);
      }
      rows.push({
        id: `${id}-${cuotaN}`,
        prestamoId: id,
        nombreCliente: nombre,
        cuotaN: cuotaN,
        fechaPago: getPayDate(baseCron, cuotaN, diaPago, freq),
        saldoInicial: Math.round(saldo),
        interesPeriodo: Math.round(interes),
        abonoCapital: Math.round(capital),
        cuotaTotal: Math.round(cuotaTotal),
        saldoFinal: Math.round(saldoFinal),
        estadoPago: 'Pendiente',
        fechaRecaudo: null,
        observaciones: '',
        montoCOPRecibido: 0,
        montoUSDRecibido: 0,
        partialPaid: 0,
        extraConsolidado: 0
      });
      saldo = saldoFinal;
      cuotaN++;
      i++;
    }
    if (i >= MAX_ITER) throw new Error('Cuota demasiado baja: requiere mas de ' + MAX_ITER + ' cuotas para saldar.');
    return rows;
  }

  const insPayment = db.prepare(`
    INSERT OR REPLACE INTO payments(id,prestamoId,nombreCliente,cuotaN,fechaPago,saldoInicial,
      interesPeriodo,abonoCapital,cuotaTotal,saldoFinal,estadoPago,fechaRecaudo,observaciones,montoCOPRecibido,montoUSDRecibido,partialPaid,extraConsolidado)
    VALUES (@id,@prestamoId,@nombreCliente,@cuotaN,@fechaPago,@saldoInicial,
      @interesPeriodo,@abonoCapital,@cuotaTotal,@saldoFinal,@estadoPago,@fechaRecaudo,@observaciones,@montoCOPRecibido,@montoUSDRecibido,@partialPaid,@extraConsolidado)
  `);
  const insertSchedule = db.transaction(rows => rows.forEach(r => insPayment.run(r)));

  // ── Auto-mora al arrancar ─────────────────────────────────────────────────
  db.prepare(`UPDATE payments SET estadoPago='En Mora' WHERE estadoPago='Pendiente' AND fechaPago < ?`)
    .run(hoyStr());

  // ── Corregir cuotas en mora de Prestamo: cuotaTotal debe = saldo actual (montoCOP) ──
  // Solo para Prestamo (sin intereses, 1 cuota de capital). NO para Intereses (cuota = interés mensual fijo).
  // v1.18.2 (Bug #30): tambien abonoCapital = montoCOP, simetrico con el housekeeping de /recalculate
  // (L~518) y de /abono (L~955). Antes solo tocaba cuotaTotal/saldoFinal -> dejaba abonoCapital=0 en
  // la cuota En Mora, y al pagarse (PUT /payments no recalcula abonoCapital) el capital no contaba.
  const fixPrestamos = db.prepare("SELECT * FROM loans WHERE estado = 'Activo' AND modalidad = 'Prestamo'").all();
  fixPrestamos.forEach(fl => {
    const nsFix = Math.round(fl.montoCOP);
    db.prepare(`UPDATE payments SET saldoInicial = ?, abonoCapital = ?, cuotaTotal = ?, saldoFinal = 0
      WHERE prestamoId = ? AND estadoPago = 'En Mora'
      AND id NOT LIKE '%-ab-%'`)
      .run(nsFix, nsFix, nsFix, fl.id);
  });

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
      schema_ver   INTEGER NOT NULL DEFAULT 1
    );
    CREATE INDEX IF NOT EXISTS idx_uj_scope  ON undo_journal(scope_tipo, scope_id);
    CREATE INDEX IF NOT EXISTS idx_uj_estado ON undo_journal(estado);
  `);

  let APP_VERSION = 'desconocida';
  try { APP_VERSION = require('../package.json').version; } catch (_) {}

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
  // Housekeeping determinista re-aplicado tras restaurar (Candado B): deja el estado
  // consistente con la fecha de HOY, igual que el arranque, sin caducar el undo.
  function reHousekeepLoan(id) {
    db.prepare("UPDATE payments SET estadoPago='En Mora' WHERE prestamoId=? AND estadoPago='Pendiente' AND fechaPago < ?").run(id, hoyStr());
    const l = db.prepare('SELECT * FROM loans WHERE id = ?').get(id);
    if (l && l.estado === 'Activo' && l.modalidad === 'Prestamo') {
      const ns = Math.round(l.montoCOP);
      db.prepare("UPDATE payments SET saldoInicial=?, abonoCapital=?, cuotaTotal=?, saldoFinal=0 WHERE prestamoId=? AND estadoPago='En Mora' AND id NOT LIKE '%-ab-%'").run(ns, ns, ns, id);
    }
  }

  const insUndo = db.prepare(`
    INSERT INTO undo_journal(id, accion, endpoint, descripcion, scope_tipo, scope_id, snapshot, pre_hash, post_hash, app_version)
    VALUES (@id, @accion, @endpoint, @descripcion, @scope_tipo, @scope_id, @snapshot, @pre_hash, @post_hash, @app_version)
  `);

  // Retencion: conservar las 200 mas recientes y descartar > 90 dias (lo que ocurra
  // primero). Borra el TAIL (mas viejo), nunca el head, asi que no rompe el LIFO.
  function podarJournal() {
    db.prepare("DELETE FROM undo_journal WHERE created_at < datetime('now','localtime','-90 days')").run();
    db.prepare("DELETE FROM undo_journal WHERE rowid NOT IN (SELECT rowid FROM undo_journal ORDER BY rowid DESC LIMIT 200)").run();
  }
  podarJournal();

  // Error de validacion -> respuesta 4xx sin tocar la BD.
  class ClientError extends Error {
    constructor(message, code) { super(message); this.code = code || 400; }
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
      insUndo.run({
        id: ujId, accion: meta.accion, endpoint: meta.endpoint,
        descripcion: desc, scope_tipo: meta.scopeTipo, scope_id: meta.scopeId,
        snapshot: JSON.stringify(pre), pre_hash: preHash, post_hash: postHash, app_version: APP_VERSION
      });
      logAction.run(meta.logTipo || meta.accion, desc);
      podarJournal();
      return ujId;
    });
    const undoId = run();
    res.json(Object.assign({ undoId: undoId }, payload));
  }

  // ── API: Deshacer ────────────────────────────────────────────────────────────
  app.post('/api/undo/:id', (req, res) => {
    const entry = db.prepare('SELECT * FROM undo_journal WHERE id = ?').get(req.params.id);
    if (!entry) return res.status(404).json({ error: 'Operacion no encontrada en el historial' });
    if (entry.estado !== 'disponible') {
      return res.status(400).json({ error: 'Esta operacion ya fue ' + (entry.estado === 'deshecho' ? 'deshecha' : 'invalidada') + ' y no puede revertirse de nuevo' });
    }
    // Candado A — LIFO estricto por scope: solo la entrada disponible MAS reciente
    // de este agregado puede deshacerse.
    const top = db.prepare("SELECT id, descripcion, created_at FROM undo_journal WHERE scope_tipo=? AND scope_id=? AND estado='disponible' ORDER BY rowid DESC LIMIT 1").get(entry.scope_tipo, entry.scope_id);
    if (top && top.id !== entry.id) {
      return res.status(409).json({ error: 'Primero debes deshacer la operacion mas reciente de este ' + (entry.scope_tipo === 'debt' ? 'registro' : 'prestamo') + ': "' + top.descripcion + '" (' + top.created_at + ')' });
    }
    let snap;
    try { snap = JSON.parse(entry.snapshot); } catch (_) { return res.status(500).json({ error: 'Snapshot corrupto: no se puede deshacer con seguridad' }); }

    // Candado B (DETECTOR, no gate): si el estado ACTUAL del agregado ya no coincide
    // con el post_hash del journal, algo lo cambio despues (housekeeping del arranque,
    // o una mutacion aun NO cubierta por el journal en esta fase). Se restaura igual
    // y se ADVIERTE — nunca se bloquea en silencio.
    const drift = hashSnapshot(snapshotScope(entry.scope_tipo, entry.scope_id)) !== entry.post_hash;

    const run = db.transaction(() => {
      restoreScope(snap, entry.scope_id);
      if (entry.scope_tipo === 'loan') reHousekeepLoan(entry.scope_id);
      db.prepare("UPDATE undo_journal SET estado='deshecho', undone_at=datetime('now','localtime') WHERE id=?").run(entry.id);
      logAction.run('deshacer', 'Deshiciste: ' + entry.descripcion);
    });
    run();

    res.json({
      ok: true, deshecho: entry.id, accion: entry.accion, scope_id: entry.scope_id,
      warning: drift ? 'El estado habia cambiado desde esta operacion (housekeeping o una mutacion no journalizada). Se restauro el snapshot y se re-aplico el housekeeping; revisa el resultado.' : null
    });
  });

  // ── API: Historial de undo (para la UI y diagnostico) ────────────────────────
  app.get('/api/undo', (req, res) => {
    const { scopeTipo, scopeId } = req.query;
    const cols = 'id, created_at, accion, descripcion, scope_tipo, scope_id, estado, undone_at';
    const rows = (scopeTipo && scopeId)
      ? db.prepare('SELECT ' + cols + " FROM undo_journal WHERE scope_tipo=? AND scope_id=? ORDER BY rowid DESC LIMIT 50").all(scopeTipo, scopeId)
      : db.prepare('SELECT ' + cols + ' FROM undo_journal ORDER BY rowid DESC LIMIT 50').all();
    res.json(rows);
  });

  // ── API: Recalcular cronogramas ───────────────────────────────────────────
  // v1.9.0 FIX: solo borra Pendientes regulares. Cuotas Pagadas y En Mora se preservan
  // intactas (son deuda historica / causada y no deben ser recalculadas). nextRegularN
  // se deriva de las cuotas (Pagadas + Mora) existentes para que las nuevas Pendientes
  // no colisionen con los cuotaN existentes.
  app.post('/api/recalculate', (_req, res) => {
    const activeLoans = db.prepare("SELECT * FROM loans WHERE estado = 'Activo'").all();
    let updated = 0;
    // ATOMICO por prestamo: el borrado de Pendientes y su regeneracion van juntos. Antes iban
    // sueltos -> un fallo entre ambos dejaba al deudor SIN cronograma. Se envuelve cada iteracion
    // (no el lote entero) para que un prestamo problematico no revierta el trabajo de los demas.
    // NO se journaliza: /recalculate es reconstructivo por diseño y de alcance global.
    const recalcularUno = db.transaction((loan) => {
      const prev = db.prepare('SELECT * FROM payments WHERE prestamoId = ?').all(loan.id);
      const prevRegulares = prev.filter(p => !p.id || p.id.indexOf('-ab-') === -1);
      const prevPagadasYMora = prevRegulares.filter(p => p.estadoPago === 'Pagado' || p.estadoPago === 'En Mora');
      const prevPendientes = prevRegulares.filter(p => p.estadoPago === 'Pendiente');

      // Snapshot de partialPaid + observaciones de Pendientes (para restaurar tras regenerar)
      const partialMap = {};
      prevPendientes.forEach(p => {
        if ((p.partialPaid || 0) > 0 || p.observaciones) {
          partialMap[p.cuotaN] = { partialPaid: p.partialPaid || 0, observaciones: p.observaciones || '' };
        }
      });

      // Borrar SOLO las Pendientes — Pagadas y Mora quedan intactas
      prevPendientes.forEach(p => {
        db.prepare('DELETE FROM payments WHERE id = ?').run(p.id);
      });

      const regularConsumed = prevPagadasYMora.length;
      const nextRegularN = regularConsumed + 1;
      const cuotaFija = Math.round(+loan.cuotaFijaPactada || 0);
      const indefinido = loan.modalidad === 'Intereses';

      // v1.9.x FIX (bug general de cuotas infladas): NO usar loan.montoCOP que puede
      // estar stale (solo se actualiza con /abono, no al marcar pagos sin abono).
      // Calcular saldo real desde formula confiable: originalCOP - capitalPagado total
      // (cuotas Pagadas regulares + abonos a capital Pagados). Aplica solo a modalidades
      // que necesitan amortizacion (Capital + Intereses, Intereses). Prestamo se mantiene
      // con montoCOP porque su flujo es diferente.
      const originalCOPRec = loan.moneda === 'USD' ? Math.round(loan.montoOrigen * loan.trmAcordada) : Math.round(loan.montoOrigen);
      const capPorAbonos = prev.filter(p => p.id.indexOf('-ab-') !== -1 && p.estadoPago === 'Pagado').reduce((s, p) => s + p.abonoCapital, 0);
      // v1.12.x FIX (bug de mora): restar tambien el capital de las cuotas EN MORA (deuda
      // independiente, su capital NO se re-amortiza en las pendientes). prevPagadasYMora =
      // Pagadas + Mora -> simetrico con regularConsumed (que tambien las cuenta). Antes solo Pagadas.
      const capPorCuotasPagadas = prevPagadasYMora.reduce((s, p) => s + p.abonoCapital, 0);
      const saldoReal = Math.max(0, originalCOPRec - capPorAbonos - capPorCuotasPagadas);
      let schedule = [];

      if (saldoReal > 0) {
        if (cuotaFija > 0 && loan.modalidad === 'Capital + Intereses') {
          try {
            schedule = buildScheduleFixedPMT(loan, nextRegularN, saldoReal, cuotaFija);
          } catch (e) {
            const remaining = Math.max(0, (loan.plazoMeses || 12) - regularConsumed);
            if (remaining > 0) schedule = buildSchedule(loan, nextRegularN, saldoReal, remaining);
          }
        } else if (loan.modalidad === 'Prestamo') {
          // Para Prestamo (sin intereses, 1 cuota) seguimos usando montoCOP — su flujo
          // no es PMT y montoCOP refleja el saldo correctamente tras abonos.
          if (regularConsumed === 0 && loan.montoCOP > 0) schedule = buildSchedule(loan);
        } else if (loan.modalidad === 'Pago Unico') {
          // v1.10.0: espejo de Prestamo — 1 cuota unica, regenera si no se consumio
          if (regularConsumed === 0 && loan.montoCOP > 0) schedule = buildSchedule(loan);
        } else {
          // Intereses o Capital+Intereses sin cuotaFija — usar saldoReal computado
          const remaining = indefinido
            ? Math.max(0, cuotasHastaHoy(loan.fechaInicio, nextRegularN, 3, loan.frecuencia || 'Mensual'))
            : Math.max(0, (loan.plazoMeses || 12) - regularConsumed);
          if (remaining > 0) schedule = buildSchedule(loan, nextRegularN, saldoReal, remaining);
        }
      }

      // Aplicar extra del prorrateo (proximaCuotaExtra) a la cuota objetivo si aun esta pendiente
      const extraLoan = Math.round(+loan.proximaCuotaExtra || 0);
      const extraN = +loan.proximaCuotaExtraN || 0;
      schedule.forEach(p => {
        const partial = partialMap[p.cuotaN];
        if (partial) {
          p.partialPaid = partial.partialPaid;
          if (partial.observaciones) p.observaciones = partial.observaciones;
        }
        if (extraLoan !== 0 && p.cuotaN === extraN) {
          p.interesPeriodo = Math.round(p.interesPeriodo + extraLoan);
          p.cuotaTotal = Math.round(p.cuotaTotal + extraLoan);
          p.extraConsolidado = extraLoan;
          if (!p.observaciones) p.observaciones = 'Cuota transitoria por cambio de fecha de pago (' + (extraLoan >= 0 ? '+$' : '-$') + Math.abs(extraLoan).toLocaleString('es-CO') + ')';
        }
      });
      if (schedule.length > 0) insertSchedule(schedule);
    });
    for (const loan of activeLoans) {
      recalcularUno(loan);
      updated++;
    }
    // Re-aplicar auto-mora a Pendientes que cruzaron la fecha
    db.prepare(`UPDATE payments SET estadoPago='En Mora' WHERE estadoPago='Pendiente' AND fechaPago < ?`)
      .run(hoyStr());
    // Fix cuotas en mora de Prestamo (sin intereses): cuotaTotal = saldo actual
    // v1.10.0 fix housekeeping: tambien saldoInicial y abonoCapital para mantener
    // consistencia interna de la cuota tras abonos previos.
    const fixP = db.prepare("SELECT * FROM loans WHERE estado = 'Activo' AND modalidad = 'Prestamo'").all();
    fixP.forEach(fl => {
      const ns = Math.round(fl.montoCOP);
      db.prepare(`UPDATE payments SET saldoInicial = ?, abonoCapital = ?, cuotaTotal = ?, saldoFinal = 0
        WHERE prestamoId = ? AND estadoPago = 'En Mora'
        AND id NOT LIKE '%-ab-%'`)
        .run(ns, ns, ns, fl.id);
    });
    // v1.10.0 — Fix cuotas en mora de Pago Unico: cuotaTotal = saldo + ganancia
    // (la ganancia pactada se mantiene aunque el deudor caiga en mora)
    const fixPU = db.prepare("SELECT * FROM loans WHERE estado = 'Activo' AND modalidad = 'Pago Unico'").all();
    fixPU.forEach(fl => {
      const gPU = Math.round(+fl.gananciaFija || 0);
      const nsPU = Math.round(fl.montoCOP);
      db.prepare(`UPDATE payments SET saldoInicial = ?, abonoCapital = ?, cuotaTotal = ?, saldoFinal = 0
        WHERE prestamoId = ? AND estadoPago = 'En Mora'
        AND id NOT LIKE '%-ab-%'`)
        .run(nsPU, nsPU, nsPU + gPU, fl.id);
    });
    res.json({ ok: true, updated });
  });

  // ── API: Config ───────────────────────────────────────────────────────────
  app.get('/api/config', (_req, res) => {
    const rows = db.prepare('SELECT key, value FROM config').all();
    res.json(Object.fromEntries(rows.map(r => [r.key, r.value])));
  });
  app.put('/api/config', (req, res) => {
    const stmt = db.prepare('INSERT OR REPLACE INTO config(key, value) VALUES (?, ?)');
    // ATOMICO: guarda TODAS las claves o ninguna (antes, un fallo a mitad del bucle dejaba la
    // configuracion a medio guardar). No se journaliza: no es una operacion financiera.
    db.transaction(() => {
      for (const [k, v] of Object.entries(req.body)) stmt.run(k, String(v));
    })();
    res.json({ ok: true });
  });

  // ── API: Loans ────────────────────────────────────────────────────────────
  app.get('/api/loans', (_req, res) => {
    res.json(db.prepare('SELECT * FROM loans ORDER BY createdAt').all());
  });

  app.post('/api/loans', (req, res) => {
    const loan = { fechaDevolucion: '', comprasUSD: '', gananciaFija: 0, ...req.body, id: Date.now().toString() + Math.random().toString(36).slice(2,6) };
    // Si comprasUSD viene como array/objeto, serializar a JSON
    if (loan.comprasUSD && typeof loan.comprasUSD !== 'string') loan.comprasUSD = JSON.stringify(loan.comprasUSD);
    // v1.10.0: gananciaFija solo aplica para modalidad Pago Unico — forzar 0 en el resto
    if (loan.modalidad !== 'Pago Unico') loan.gananciaFija = 0;
    else loan.gananciaFija = Math.round(+loan.gananciaFija || 0);
    // ATOMICO: el INSERT del prestamo y la generacion de su cronograma van en UNA transaccion.
    // Antes iban sueltos: un fallo entre ambos creaba un prestamo sin cuotas. Este endpoint NO
    // se journaliza (fuera del alcance acordado del undo), pero la atomicidad si es exigible.
    db.transaction(() => {
      db.prepare(`
        INSERT INTO loans(id,nombre,cedula,telefono,moneda,montoOrigen,trmAcordada,montoCOP,
          tasaMensual,plazoMeses,modalidad,fechaInicio,diaPago,estado,notas,frecuencia,fechaDevolucion,comprasUSD,gananciaFija)
        VALUES (@id,@nombre,@cedula,@telefono,@moneda,@montoOrigen,@trmAcordada,@montoCOP,
          @tasaMensual,@plazoMeses,@modalidad,@fechaInicio,@diaPago,@estado,@notas,@frecuencia,@fechaDevolucion,@comprasUSD,@gananciaFija)
      `).run(loan);
      insertSchedule(buildSchedule(loan));
    })();
    var detalleLog = (loan.moneda === 'USD' ? 'USD $' + loan.montoOrigen : '$' + Math.round(loan.montoCOP).toLocaleString()) + ' (' + loan.modalidad + ')';
    if (loan.modalidad === 'Pago Unico' && loan.gananciaFija > 0) {
      detalleLog += ' [ganancia $' + Math.round(loan.gananciaFija).toLocaleString('es-CO') + ']';
    }
    logAction.run('prestamo', 'Nuevo prestamo: ' + loan.nombre + ' por ' + detalleLog);
    res.status(201).json(loan);
  });

  app.put('/api/loans/:id', (req, res) => {
    const loan = { fechaDevolucion: '', comprasUSD: '', gananciaFija: 0, ...req.body, id: req.params.id };
    if (loan.comprasUSD && typeof loan.comprasUSD !== 'string') loan.comprasUSD = JSON.stringify(loan.comprasUSD);
    // v1.10.0: gananciaFija solo aplica para modalidad Pago Unico — forzar 0 en el resto
    if (loan.modalidad !== 'Pago Unico') loan.gananciaFija = 0;
    else loan.gananciaFija = Math.round(+loan.gananciaFija || 0);
    // ATOMICO desde "La Bestia": antes el UPDATE de loans, el DELETE de Pendientes y el
    // insertSchedule iban sueltos (3 escrituras sin transaccion) -> un fallo intermedio dejaba
    // el prestamo editado con el cronograma a medio borrar. Ahora todo va en una sola tx.
    // El UPDATE se movio al final (a `aplicar`): ningun computo posterior lee `payments` de la
    // BD despues del DELETE, y el cronograma se calcula desde el `loan` del body, no de la BD.
    return mutacionAtomica(req, res, { accion: 'edicion', endpoint: 'PUT /api/loans/:id', scopeTipo: 'loan', scopeId: req.params.id }, () => {

    // v1.9.0 FIX: solo borrar Pendientes regulares. Cuotas Pagadas y En Mora se preservan
    // intactas (deuda historica/causada). Esto garantiza que un edit nunca afecta cuotas
    // ya pactadas con el deudor.
    const prev = db.prepare('SELECT * FROM payments WHERE prestamoId = ?').all(loan.id);
    const prevAbonos = prev.filter(p => p.id.indexOf('-ab-') !== -1);
    const prevRegulares = prev.filter(p => p.id.indexOf('-ab-') === -1);
    const prevPagadasYMora = prevRegulares.filter(p => p.estadoPago === 'Pagado' || p.estadoPago === 'En Mora');
    const prevPendientes = prevRegulares.filter(p => p.estadoPago === 'Pendiente');

    // Snapshot de partialPaid + observaciones de Pendientes
    const partialMapEdit = {};
    prevPendientes.forEach(p => {
      if ((p.partialPaid || 0) > 0 || p.observaciones) {
        partialMapEdit[p.cuotaN] = { partialPaid: p.partialPaid || 0, observaciones: p.observaciones || '' };
      }
    });

    // (El borrado de Pendientes se aplica en la fase de escritura, mas abajo.)

    // Saldo actual considerando abonos previos (montoCOP es el del request, pero defendemos
    // contra valores incorrectos restando los abonos confirmados).
    const totalAbonado = prevAbonos.filter(p => p.estadoPago === 'Pagado')
      .reduce((s, p) => s + p.abonoCapital, 0);
    // capital ya consumido por cuotas Pagadas regulares (no abonos)
    // v1.12.x FIX (bug de mora): incluir el capital de las cuotas EN MORA (deuda independiente)
    // para que saldoActual sea simetrico con regularConsumedEdit (que cuenta Pagadas + Mora).
    const capPorCuotasPagadas = prevPagadasYMora.reduce((s, p) => s + p.abonoCapital, 0);
    const originalCOPEdit = loan.moneda === 'USD' ? Math.round(loan.montoOrigen * loan.trmAcordada) : Math.round(loan.montoOrigen);
    const saldoActual = Math.max(0, originalCOPEdit - totalAbonado - capPorCuotasPagadas);
    const regularConsumedEdit = prevPagadasYMora.length;
    const nextRegularNEdit = regularConsumedEdit + 1;
    const cuotaFijaEdit = Math.round(+loan.cuotaFijaPactada || 0);
    const indefinidoEdit = loan.modalidad === 'Intereses';

    let schedule = [];
    if (saldoActual > 0) {
      if (cuotaFijaEdit > 0 && loan.modalidad === 'Capital + Intereses') {
        try {
          schedule = buildScheduleFixedPMT({ ...loan, montoCOP: saldoActual }, nextRegularNEdit, saldoActual, cuotaFijaEdit);
        } catch (e) {
          const remaining = Math.max(0, (loan.plazoMeses || 12) - regularConsumedEdit);
          if (remaining > 0) schedule = buildSchedule({ ...loan, montoCOP: saldoActual }, nextRegularNEdit, saldoActual, remaining);
        }
      } else if (loan.modalidad === 'Prestamo') {
        if (regularConsumedEdit === 0) schedule = buildSchedule({ ...loan, montoCOP: saldoActual });
      } else if (loan.modalidad === 'Pago Unico') {
        // v1.10.0: igual que Prestamo — solo regenera si no se consumio la cuota unica
        if (regularConsumedEdit === 0) schedule = buildSchedule({ ...loan, montoCOP: saldoActual });
      } else {
        const remaining = indefinidoEdit
          ? Math.max(0, cuotasHastaHoy(loan.fechaInicio, nextRegularNEdit, 3, loan.frecuencia || 'Mensual'))
          : Math.max(0, (loan.plazoMeses || 12) - regularConsumedEdit);
        if (remaining > 0) schedule = buildSchedule({ ...loan, montoCOP: saldoActual }, nextRegularNEdit, saldoActual, remaining);
      }
    }

    // Aplicar extra del prorrateo + restaurar partialPaid
    const extraLoanEdit = Math.round(+loan.proximaCuotaExtra || 0);
    const extraNEdit = +loan.proximaCuotaExtraN || 0;
    schedule.forEach(p => {
      const partial = partialMapEdit[p.cuotaN];
      if (partial) {
        p.partialPaid = partial.partialPaid;
        if (partial.observaciones) p.observaciones = partial.observaciones;
      }
      if (extraLoanEdit !== 0 && p.cuotaN === extraNEdit) {
        p.interesPeriodo = Math.round(p.interesPeriodo + extraLoanEdit);
        p.cuotaTotal = Math.round(p.cuotaTotal + extraLoanEdit);
        p.extraConsolidado = extraLoanEdit;
        if (!p.observaciones) p.observaciones = 'Cuota transitoria por cambio de fecha de pago (' + (extraLoanEdit >= 0 ? '+$' : '-$') + Math.abs(extraLoanEdit).toLocaleString('es-CO') + ')';
      }
    });

    return {
      descripcion: 'Editaste prestamo de ' + loan.nombre,
      payload: loan,
      aplicar: () => {
        db.prepare(`
          UPDATE loans SET nombre=@nombre, cedula=@cedula, telefono=@telefono, moneda=@moneda,
            montoOrigen=@montoOrigen, trmAcordada=@trmAcordada, montoCOP=@montoCOP,
            tasaMensual=@tasaMensual, plazoMeses=@plazoMeses, modalidad=@modalidad,
            fechaInicio=@fechaInicio, diaPago=@diaPago, estado=@estado, notas=@notas, frecuencia=@frecuencia, fechaDevolucion=@fechaDevolucion, comprasUSD=@comprasUSD, gananciaFija=@gananciaFija
          WHERE id=@id
        `).run(loan);
        // Borrar SOLO Pendientes — Pagadas, Mora y abonos quedan intactos
        prevPendientes.forEach(p => {
          db.prepare('DELETE FROM payments WHERE id = ?').run(p.id);
        });
        if (schedule.length > 0) insertSchedule(schedule);
      }
    };
    });
  });

  app.delete('/api/loans/:id', (req, res) => {
    const loan = db.prepare('SELECT nombre, montoCOP FROM loans WHERE id = ?').get(req.params.id);
    // ATOMICO: los dos DELETE van juntos (antes sueltos -> podian dejar cuotas huerfanas sin su
    // prestamo). NO se journaliza: eliminar un prestamo es deliberado y ya tiene su confirmacion.
    db.transaction(() => {
      db.prepare('DELETE FROM payments WHERE prestamoId = ?').run(req.params.id);
      db.prepare('DELETE FROM loans WHERE id = ?').run(req.params.id);
    })();
    if (loan) logAction.run('eliminacion', 'Eliminaste prestamo de ' + loan.nombre);
    res.json({ ok: true });
  });

  // ── API: Payments ─────────────────────────────────────────────────────────
  // Auto-extender cuotas de Intereses si faltan pocas pendientes
  function autoExtendSoloIntereses() {
    const activeIndefinidos = db.prepare("SELECT * FROM loans WHERE estado = 'Activo' AND modalidad = 'Intereses'").all();
    for (const loan of activeIndefinidos) {
      const allPays = db.prepare('SELECT * FROM payments WHERE prestamoId = ? ORDER BY cuotaN DESC').all(loan.id);
      const regulares = allPays.filter(p => p.id.indexOf('-ab-') === -1);
      // Si quedan menos de 3 cuotas pendientes futuras, generar más
      const pendFuturas = regulares.filter(p => p.estadoPago === 'Pendiente');
      if (pendFuturas.length < 3) {
        const maxN = regulares.length > 0 ? Math.max(...regulares.map(p => p.cuotaN)) : 0;
        const nextN = maxN + 1;
        // Calcular saldo actual (considerando abonos)
        const abonos = allPays.filter(p => p.id.indexOf('-ab-') !== -1 && p.estadoPago === 'Pagado');
        const totalAbonado = abonos.reduce((s, p) => s + p.abonoCapital, 0);
        const saldo = Math.max(0, loan.montoCOP - totalAbonado);
        if (saldo > 0) {
          const nuevas = buildSchedule({ ...loan, montoCOP: saldo }, nextN, saldo, 3);
          // Solo insertar si no existen ya
          nuevas.forEach(p => {
            const exists = db.prepare('SELECT id FROM payments WHERE id = ?').get(p.id);
            if (!exists) insPayment.run(p);
          });
        }
      }
    }
  }

  app.get('/api/payments', (_req, res) => {
    autoExtendSoloIntereses();
    db.prepare(`UPDATE payments SET estadoPago='En Mora' WHERE estadoPago='Pendiente' AND fechaPago < ?`)
      .run(hoyStr());
    res.json(db.prepare('SELECT * FROM payments ORDER BY fechaPago, nombreCliente').all());
  });

  app.put('/api/payments/:id', (req, res) => {
    const { estadoPago, fechaRecaudo, observaciones, montoCOPRecibido, montoUSDRecibido } = req.body;
    const payBefore = db.prepare('SELECT * FROM payments WHERE id = ?').get(req.params.id);
    // El scope del journal es el PRESTAMO (no la cuota): esta ruta tambien muta loans via
    // auto-finalizacion / reactivacion, asi que el agregado entero es la unidad de undo.
    if (!payBefore) return res.status(404).json({ error: 'Cuota no encontrada' });
    return mutacionAtomica(req, res, { accion: 'pago', endpoint: 'PUT /api/payments/:id', scopeTipo: 'loan', scopeId: payBefore.prestamoId }, () => {
    // Al marcar Pagado: partialPaid = cuotaTotal (recibido completo); al revertir: partialPaid = 0 (historial se pierde)
    let newPartial;
    if (estadoPago === 'Pagado' && payBefore) newPartial = payBefore.cuotaTotal;
    else if ((estadoPago === 'Pendiente' || estadoPago === 'En Mora') && payBefore) newPartial = 0;
    else newPartial = payBefore ? (payBefore.partialPaid || 0) : 0;
    // v1.11.1: paidAt = hora real del marcado. Se conserva si ya estaba pagado; se limpia al revertir.
    const nowTs = db.prepare("SELECT datetime('now','localtime') AS t").get().t;
    let newPaidAt;
    if (estadoPago === 'Pagado') newPaidAt = (payBefore && payBefore.paidAt) ? payBefore.paidAt : nowTs;
    else if (estadoPago === 'Pendiente' || estadoPago === 'En Mora') newPaidAt = null;
    else newPaidAt = payBefore ? (payBefore.paidAt || null) : null;
    // v1.11.4: ledger de recibos. Al marcar Pagado, anadir el REMANENTE (lo que falta para cubrir
    // el monto recibido) como un evento en fechaRecaudo: preserva parciales previos en sus fechas
    // reales y nunca duplica. En el flujo normal (cuota sin parciales) el remanente == monto total.
    // Al revertir se limpia el ledger (coherente con partialPaid=0). En otros casos se conserva.
    let newRecibos;
    let prevRec; try { prevRec = JSON.parse((payBefore && payBefore.recibos) || '[]'); } catch (_) { prevRec = []; }
    if (!Array.isArray(prevRec)) prevRec = [];
    if (estadoPago === 'Pagado' && payBefore) {
      const target = Math.round((montoCOPRecibido || payBefore.cuotaTotal) || 0);
      const prevSum = prevRec.reduce((a, r) => a + (Math.round(+r.cop) || 0), 0);
      const remanente = target - prevSum;
      if (remanente > 0) prevRec.push({ fecha: fechaRecaudo || hoyStr(), cop: remanente });
      newRecibos = JSON.stringify(prevRec);
    } else if ((estadoPago === 'Pendiente' || estadoPago === 'En Mora') && payBefore) {
      newRecibos = '[]';
    } else {
      newRecibos = (payBefore && payBefore.recibos) || '[]';
    }
    const label = estadoPago === 'Pagado' ? 'Registraste pago' : estadoPago === 'En Mora' ? 'Marcaste en mora' : 'Revertiste a pendiente';
    return {
      descripcion: label + ': ' + payBefore.nombreCliente + ' cuota #' + payBefore.cuotaN + ' por $' + Math.round(payBefore.cuotaTotal).toLocaleString(),
      payload: { ok: true },
      aplicar: () => {
    db.prepare('UPDATE payments SET estadoPago=?, fechaRecaudo=?, observaciones=?, montoCOPRecibido=?, montoUSDRecibido=?, partialPaid=?, recibos=?, paidAt=? WHERE id=?')
      .run(estadoPago, fechaRecaudo || null, observaciones || '', montoCOPRecibido || 0, montoUSDRecibido || 0, newPartial, newRecibos, newPaidAt, req.params.id);

    // Auto-finalización: si se marcó como Pagado, verificar si todas las cuotas regulares están pagadas
    if (estadoPago === 'Pagado') {
      const pay = db.prepare('SELECT prestamoId, cuotaN FROM payments WHERE id = ?').get(req.params.id);
      if (pay) {
        // Si la cuota pagada era la de proximaCuotaExtra → limpiar para que recalculate no la vuelva a aplicar.
        const loanRow = db.prepare('SELECT proximaCuotaExtraN FROM loans WHERE id = ?').get(pay.prestamoId);
        if (loanRow && loanRow.proximaCuotaExtraN === pay.cuotaN) {
          db.prepare('UPDATE loans SET proximaCuotaExtra = 0, proximaCuotaExtraN = 0 WHERE id = ?').run(pay.prestamoId);
        }
        const allPays = db.prepare('SELECT * FROM payments WHERE prestamoId = ?').all(pay.prestamoId);
        // Cuotas regulares = las que NO son abonos a capital. Regla canonica: id con '-ab-'.
        // NO usar la heuristica interes===0 && capital>0: la cuota unica de un Prestamo (o Pago Unico
        // sin ganancia) tambien la cumple -> quedaba fuera de 'regulares', 'todasPagadas' nunca era
        // true y el prestamo no auto-finalizaba al pagar (gemelo backend del Bug #26).
        const regulares = allPays.filter(p => p.id.indexOf('-ab-') === -1);
        const todasPagadas = regulares.length > 0 && regulares.every(p => p.estadoPago === 'Pagado');
        if (todasPagadas) {
          db.prepare("UPDATE loans SET estado = 'Finalizado', cuotaFijaPactada = 0 WHERE id = ? AND estado = 'Activo'").run(pay.prestamoId);
        }
      }
    }

    // Si se revierte a Pendiente/En Mora, reactivar el préstamo si estaba Finalizado por auto-finalización
    if (estadoPago === 'Pendiente' || estadoPago === 'En Mora') {
      const pay = db.prepare('SELECT prestamoId FROM payments WHERE id = ?').get(req.params.id);
      if (pay) {
        const loan = db.prepare('SELECT * FROM loans WHERE id = ?').get(pay.prestamoId);
        if (loan && loan.estado === 'Finalizado' && loan.montoCOP > 0) {
          db.prepare("UPDATE loans SET estado = 'Activo' WHERE id = ?").run(pay.prestamoId);
        }
      }
    }
      }
    };
    });
  });

  // ── API: Pago Parcial ─────────────────────────────────────────────────────
  // Suma al campo partialPaid. Si con este pago se completa la cuota, auto-marca Pagado.
  app.post('/api/payments/:id/partial', (req, res) => {
    const { monto, fecha, observaciones, montoUSD } = req.body;
    const pay = db.prepare('SELECT * FROM payments WHERE id = ?').get(req.params.id);
    if (!pay) return res.status(404).json({ error: 'Cuota no encontrada' });
    // Scope = el PRESTAMO: esta ruta tambien puede mutar loans (auto-finalizacion y limpieza
    // de proximaCuotaExtra), asi que el agregado entero es la unidad de undo.
    return mutacionAtomica(req, res, { accion: 'pago_parcial', logTipo: 'pago', endpoint: 'POST /api/payments/:id/partial', scopeTipo: 'loan', scopeId: pay.prestamoId }, () => {
    if (pay.estadoPago === 'Pagado') throw new ClientError('La cuota ya está pagada');
    if (pay.id.indexOf('-ab-') !== -1) throw new ClientError('No se pueden aplicar pagos parciales sobre un abono a capital');
    const montoNum = Math.round(+monto || 0);
    if (montoNum <= 0) throw new ClientError('El monto debe ser mayor a 0');
    const yaPagado = pay.partialPaid || 0;
    const restante = pay.cuotaTotal - yaPagado;
    if (montoNum > restante) throw new ClientError('El monto supera el saldo pendiente de la cuota ($' + Math.round(restante).toLocaleString() + ')');

    const nuevoPartial = yaPagado + montoNum;
    // v1.12.x FIX (pago bimonetario): en prestamos USD, si el USD recibido cubre la cuota en USD
    // (cuotaTotal / trmAcordada), la cuota se completa aunque los COP sean menores por una baja de
    // la TRM. Se acepta el deficit/superavit cambiario sin penalizar el estado de la cuota.
    const loanPay = db.prepare('SELECT moneda, trmAcordada FROM loans WHERE id = ?').get(pay.prestamoId);
    const cuotaEnUSD = (loanPay && loanPay.moneda === 'USD' && loanPay.trmAcordada > 0)
      ? Math.round((pay.cuotaTotal / loanPay.trmAcordada) * 100) / 100 : 0;
    const usdRecibidoAcum = Math.round(((pay.montoUSDRecibido || 0) + (+montoUSD || 0)) * 100) / 100;
    const completaUSD = cuotaEnUSD > 0 && usdRecibidoAcum >= cuotaEnUSD - 0.005; // tolerancia de centavo
    const completa = nuevoPartial >= pay.cuotaTotal || completaUSD;
    const fechaPago = fecha || hoyStr();
    const obsPrev = pay.observaciones || '';
    const obsNueva = (observaciones || '').trim();
    const obsCombinada = [obsPrev, obsNueva && ('Parcial ' + fechaPago + ': $' + montoNum.toLocaleString() + (obsNueva ? ' — ' + obsNueva : ''))].filter(Boolean).join(' | ');
    // v1.11.4: registrar este parcial como evento de caja en el ledger (con su fecha real de
    // recaudo). La suma de los parciales == cuotaTotal al completar (montoNum <= restante).
    let recibosArr; try { recibosArr = JSON.parse(pay.recibos || '[]'); } catch (_) { recibosArr = []; }
    if (!Array.isArray(recibosArr)) recibosArr = [];
    recibosArr.push({ fecha: fechaPago, cop: montoNum });
    const recibosJSON = JSON.stringify(recibosArr);

    // `completa` ya se conoce aqui (se deriva de pay + monto), asi que la descripcion del
    // journal/log se puede fijar antes de escribir.
    const descPartial = completa
      ? 'Pago parcial final: ' + pay.nombreCliente + ' cuota #' + pay.cuotaN + ' $' + montoNum.toLocaleString() + ' (completo $' + Math.round(pay.cuotaTotal).toLocaleString() + ')'
      : 'Pago parcial: ' + pay.nombreCliente + ' cuota #' + pay.cuotaN + ' $' + montoNum.toLocaleString() + ' (faltan $' + Math.round(pay.cuotaTotal - nuevoPartial).toLocaleString() + ')';

    return {
      descripcion: descPartial,
      payload: { ok: true, completa, partialPaid: nuevoPartial, restante: Math.max(0, pay.cuotaTotal - nuevoPartial) },
      aplicar: () => {
    if (completa) {
      // Completa la cuota: marcar Pagado
      const usdAcum = (pay.montoUSDRecibido || 0) + (+montoUSD || 0);
      db.prepare("UPDATE payments SET estadoPago=?, fechaRecaudo=?, observaciones=?, montoCOPRecibido=?, montoUSDRecibido=?, partialPaid=?, recibos=?, paidAt=datetime('now','localtime') WHERE id=?")
        .run('Pagado', fechaPago, obsCombinada, nuevoPartial, Math.round(usdAcum * 100) / 100, pay.cuotaTotal, recibosJSON, req.params.id);

      // Si era la cuota con proximaCuotaExtra, limpiarla del loan
      const loanRow = db.prepare('SELECT proximaCuotaExtraN FROM loans WHERE id = ?').get(pay.prestamoId);
      if (loanRow && loanRow.proximaCuotaExtraN === pay.cuotaN) {
        db.prepare('UPDATE loans SET proximaCuotaExtra = 0, proximaCuotaExtraN = 0 WHERE id = ?').run(pay.prestamoId);
      }
      // Auto-finalización del préstamo
      const allPays = db.prepare('SELECT * FROM payments WHERE prestamoId = ?').all(pay.prestamoId);
      const regulares = allPays.filter(p => p.id.indexOf('-ab-') === -1); // abono = id con '-ab-' (canonico, ver Bug #26)
      const todasPagadas = regulares.length > 0 && regulares.every(p => p.estadoPago === 'Pagado');
      if (todasPagadas) {
        db.prepare("UPDATE loans SET estado = 'Finalizado', cuotaFijaPactada = 0 WHERE id = ? AND estado = 'Activo'").run(pay.prestamoId);
      }
    } else {
      // Solo suma al partialPaid, estado permanece
      const copAcum = (pay.montoCOPRecibido || 0) + montoNum;
      const usdAcum = (pay.montoUSDRecibido || 0) + (+montoUSD || 0);
      db.prepare('UPDATE payments SET partialPaid=?, observaciones=?, montoCOPRecibido=?, montoUSDRecibido=?, recibos=? WHERE id=?')
        .run(nuevoPartial, obsCombinada, copAcum, Math.round(usdAcum * 100) / 100, recibosJSON, req.params.id);
    }
      }
    };
    });
  });

  // ── API: Abono a Capital ──────────────────────────────────────────────────
  // ATOMICO (v1.9.0): toda validacion + buildSchedule(FixedPMT) ocurre ANTES de cualquier
  // escritura. Si algo falla, se retorna 400 sin tocar la BD. Las escrituras se aplican
  // dentro de una transaccion SQLite (all-or-nothing).
  app.post('/api/loans/:id/abono', (req, res) => {
    const { monto, fecha, observaciones, montoUSD, liquidar, recalcMode, recalcValor, intExtra, montoCOPRecibido } = req.body;
    const loan = db.prepare('SELECT * FROM loans WHERE id = ?').get(req.params.id);
    if (!loan) return res.status(404).json({ error: 'No encontrado' });

    // v2.1 "La Bestia" — el endpoint delega en mutacionAtomica: la FASE 1 (compute)
    // valida y computa; la FASE 2 (aplicar) se ejecuta dentro de la transaccion del
    // helper junto al INSERT del journal de undo. Las validaciones lanzan ClientError.
    return mutacionAtomica(req, res, { accion: 'abono', endpoint: 'POST /api/loans/:id/abono', scopeTipo: 'loan', scopeId: req.params.id }, () => {
    // ── FASE 1: LECTURA + VALIDACION (sin escrituras) ────────────────────────
    const allPays = db.prepare('SELECT * FROM payments WHERE prestamoId = ? ORDER BY cuotaN').all(req.params.id);

    const originalCOP = loan.moneda === 'USD' ? Math.round(loan.montoOrigen * loan.trmAcordada) : Math.round(loan.montoOrigen);
    // Regla canonica de abono: id con '-ab-'. Las modalidades de cuota unica (Prestamo, Pago Unico)
    // NO aportan su capital a todoCapPagado: su abonoCapital ES el saldo vivo (no capital pagado);
    // restarlo colapsaria saldoReal a 0 y rechazaria el abono (bug corregido en el sprint heuristica).
    const esSingleCuota = loan.modalidad === 'Prestamo' || loan.modalidad === 'Pago Unico';
    // v1.12.x FIX (bug de mora): en modalidades que amortizan (Capital + Intereses, Intereses) el
    // capital de las cuotas EN MORA tambien esta "consumido" (deuda independiente) -> restarlo,
    // simetrico con regularConsumed. En Prestamo/Pago Unico se excluye por !esSingleCuota.
    const todoCapPagado = allPays.filter(p =>
      p.estadoPago === 'Pagado' ||
      (p.estadoPago === 'En Mora' && !esSingleCuota)
    ).reduce((s, p) => s + p.abonoCapital, 0);
    const saldoReal = Math.max(0, originalCOP - todoCapPagado);
    // ── CAPITAL PENDIENTE PARA LIQUIDACION (regla de negocio v1.19.0) ──
    // NO resta el capital de las cuotas En Mora: siguen debiendose, el cliente las paga HOY al
    // liquidar. Es distinto de saldoReal, que SI resta el capital En Mora para el RECALCULO
    // (Bug #21, deuda independiente amortizada aparte). Solo cuenta Pagadas (incluye abonos '-ab-').
    // Identidad: capitalPendienteLiq = saldoReal + capitalEnMora (para C+I); en Prestamo/Pago Unico
    // (esSingleCuota) coinciden porque su mora no aporta a todoCapPagado.
    const capPagadasSolo = allPays.filter(p => p.estadoPago === 'Pagado').reduce((s, p) => s + p.abonoCapital, 0);
    const capitalPendienteLiq = Math.max(0, originalCOP - capPagadasSolo);
    const montoNum = +monto || 0;
    const intExtraNum = Math.max(0, Math.round(+intExtra || 0)); // interes del proximo mes al liquidar (checkbox)
    // v2.0.0 — CAJA REAL del abono. En prestamos USD el capital se descuenta a la TRM PACTADA
    // (monto = montoUSD x trmAcordada), pero los COP que entran por caja dependen de la TRM del
    // dia. Sin este dato el desfase cambiario de un abono era invisible: montoCOPRecibido se
    // derivaba del propio capital y siempre cuadraba a la fuerza. Opcional: si no llega (prestamos
    // COP y la ruta de liquidacion) se conserva el comportamiento anterior.
    const copRecibidoNum = Math.max(0, Math.round(+montoCOPRecibido || 0));
    if (montoNum <= 0) throw new ClientError('El monto del abono debe ser mayor a 0');
    // Validacion bifurcada: al LIQUIDAR se acepta cubrir todo el capital pendiente (incluida la mora),
    // por eso se valida contra capitalPendienteLiq y NO contra saldoReal (que rebotaba el cobro de un
    // C+I con mora — showstopper). En un abono normal se mantiene la validacion contra saldoReal.
    if (liquidar) {
      if (montoNum > capitalPendienteLiq + 1) {
        throw new ClientError('El monto supera el capital pendiente ($' + capitalPendienteLiq.toLocaleString('es-CO') + ')');
      }
    } else if (Math.round(saldoReal - montoNum) < 0) {
      // v2.0.0 — defense-in-depth. El AbonoModal ya topa el monto en saldoAbonable (espejo exacto
      // de saldoReal), asi que esta rama solo se alcanza saltandose el frontend. El mensaje explica
      // POR QUE el tope es menor que el capital total y a que herramienta acudir, en vez del
      // criptico "El abono supera el saldo actual".
      const capMoraMsg = Math.max(0, capitalPendienteLiq - saldoReal);
      throw new ClientError('El abono supera el capital amortizable ($' + Math.round(saldoReal).toLocaleString('es-CO') + ').' +
        (capMoraMsg > 0
          ? ' Los $' + Math.round(capMoraMsg).toLocaleString('es-CO') + ' restantes son capital de cuotas En Mora: se cobran liquidando la deuda o pagando esas cuotas desde la seccion Pagos.'
          : ''));
    }
    // En liquidacion el prestamo se salda por completo -> nuevoSaldo 0 (no hay recalculo de pendientes).
    const nuevoSaldo = liquidar ? 0 : Math.round(saldoReal - montoNum);

    // Un registro de abono se identifica por la regla canonica: id con '-ab-'.
    const regularConsumed = allPays.filter(p =>
      (p.estadoPago === 'Pagado' || p.estadoPago === 'En Mora') &&
      p.id.indexOf('-ab-') === -1
    ).length;
    const maxExistingN = allPays.reduce((max, p) => Math.max(max, p.cuotaN), 0);

    const indefinido = loan.modalidad === 'Intereses';
    const esCapInt = loan.modalidad === 'Capital + Intereses';
    const remainingDefault = indefinido ? 3 : Math.max(0, (loan.plazoMeses || 12) - regularConsumed);
    const nextRegularN = regularConsumed + 1;
    const updatedLoan = Object.assign({}, loan, { montoCOP: nuevoSaldo });

    // Pre-computar TODO el cronograma nuevo (si aplica) ANTES de tocar BD.
    let nuevasCuotas = [];
    let nuevoPlazoMeses = null;     // null = no actualizar plazoMeses
    let nuevaCuotaFija = null;      // null = no actualizar; 0 = limpiar; >0 = persistir
    let logRecalc = '';

    if (nuevoSaldo > 0) {
      if (esCapInt && recalcMode === 'modificarPlazo') {
        const nuevoN = parseInt(recalcValor, 10);
        if (!nuevoN || nuevoN < 1) throw new ClientError('Numero de cuotas invalido. Debe ser >= 1.');
        nuevasCuotas = buildSchedule(updatedLoan, nextRegularN, nuevoSaldo, nuevoN);
        nuevoPlazoMeses = regularConsumed + nuevoN;
        nuevaCuotaFija = 0; // limpiar (el usuario cambio de opinion)
        logRecalc = ' — plazo ajustado a ' + nuevoN + ' cuota' + (nuevoN > 1 ? 's' : '') + ' restantes (total: ' + nuevoPlazoMeses + ')';
      } else if (esCapInt && recalcMode === 'fijarCuota') {
        const cuotaDeseada = +recalcValor || 0;
        if (cuotaDeseada <= 0) throw new ClientError('Cuota invalida. Debe ser > 0.');
        const r = tasaPeriodo((loan.tasaMensual || 0) / 100, loan.frecuencia || 'Mensual');
        const interesPrimerPeriodo = nuevoSaldo * r;
        if (cuotaDeseada <= interesPrimerPeriodo) {
          throw new ClientError('La cuota debe ser mayor a $' + Math.round(interesPrimerPeriodo).toLocaleString('es-CO') +
            ' (intereses del primer periodo). Con $' + Math.round(cuotaDeseada).toLocaleString('es-CO') +
            ' nunca se saldaria la deuda.');
        }
        try {
          nuevasCuotas = buildScheduleFixedPMT(updatedLoan, nextRegularN, nuevoSaldo, cuotaDeseada);
        } catch (e) {
          throw new ClientError(e.message);
        }
        nuevoPlazoMeses = regularConsumed + nuevasCuotas.length;
        nuevaCuotaFija = Math.round(cuotaDeseada);
        logRecalc = ' — cuota fija $' + Math.round(cuotaDeseada).toLocaleString('es-CO') + ' x ' + nuevasCuotas.length + ' cuotas (total: ' + nuevoPlazoMeses + ')';
      } else {
        // Opcion 1 (default): mantener plazo, baja la cuota
        if (loan.cuotaFijaPactada && +loan.cuotaFijaPactada > 0) nuevaCuotaFija = 0; // limpia (cambio de opinion)
        if (remainingDefault > 0) {
          nuevasCuotas = buildSchedule(updatedLoan, nextRegularN, nuevoSaldo, remainingDefault);
        }
      }
    }

    // ── FASE 2: ESCRITURA — la ejecuta mutacionAtomica dentro de UNA transaccion,
    // junto al INSERT del journal de undo y el activity_log. Todo o nada.
    let logBase = 'Registraste abono de $' + Math.round(montoNum).toLocaleString() + ' a ' + loan.nombre + (nuevoSaldo <= 0 ? ' (SALDADO)' : ' — saldo: $' + Math.round(nuevoSaldo).toLocaleString());
    if (recalcMode === 'modificarPlazo' || recalcMode === 'fijarCuota') logBase += ' [recalc: ' + recalcMode + ']';
    return {
      descripcion: logBase,
      payload: { ok: true, nuevoSaldo: Math.max(0, nuevoSaldo) },
      aplicar: () => {
      const abonoId = req.params.id + '-ab-' + Date.now();
      const fechaAbono = fecha || hoyStr();
      // Solo borrar cuotas PENDIENTES; las cuotas En Mora permanecen intactas (deuda independiente)
      db.prepare("DELETE FROM payments WHERE prestamoId = ? AND estadoPago = 'Pendiente'").run(req.params.id);

      // Para Prestamo: actualizar cuotaTotal de cuotas En Mora al nuevo saldo
      // v1.10.0 fix housekeeping: tambien actualizar saldoInicial y abonoCapital para
      // que la cuota refleje correctamente el estado tras el abono. Sin este fix los
      // valores quedaban con el monto original e inflaban marginalmente el KPI de
      // "capital recuperado" cuando se pagaba la cuota en mora.
      if (loan.modalidad === 'Prestamo') {
        const moraRegulares = allPays.filter(p => p.estadoPago === 'En Mora' && p.id.indexOf('-ab-') === -1);
        const ns = Math.max(0, nuevoSaldo);
        moraRegulares.forEach(p => {
          db.prepare('UPDATE payments SET saldoInicial = ?, abonoCapital = ?, cuotaTotal = ?, saldoFinal = ? WHERE id = ?')
            .run(ns, ns, ns, 0, p.id);
        });
      }
      // v1.10.0 — Pago Unico: igual que Prestamo pero conservando la ganancia pactada
      // (cuotaTotal = capital restante + ganancia; abonoCapital solo el capital)
      if (loan.modalidad === 'Pago Unico') {
        const gPU2 = Math.round(+loan.gananciaFija || 0);
        const moraRegularesPU = allPays.filter(p => p.estadoPago === 'En Mora' && p.id.indexOf('-ab-') === -1);
        const nsPU = Math.max(0, nuevoSaldo);
        moraRegularesPU.forEach(p => {
          db.prepare('UPDATE payments SET saldoInicial = ?, abonoCapital = ?, cuotaTotal = ?, saldoFinal = ? WHERE id = ?')
            .run(nsPU, nsPU, nsPU + gPU2, 0, p.id);
        });
      }

      // Registrar el abono como cuota especial.
      // v1.19.0 — al LIQUIDAR el abono captura SOLO el capital pendiente NO en mora (= saldoReal):
      // el capital de las cuotas En Mora ya queda contabilizado al marcarlas Pagadas abajo. Sin esto
      // el capital se contaria DOBLE (abono por el total + cuotas mora con su propio capital) y
      // "capital recuperado" superaria el monto prestado. En single-cuota (Prestamo/Pago Unico)
      // saldoReal == montoNum, asi que no cambia. El interes del proximo mes (intExtra, opcional) se
      // registra como interesPeriodo del abono para que cuente como ingreso real.
      const abonoCapReg = liquidar ? Math.round(saldoReal) : Math.round(montoNum);
      const abonoInt = liquidar ? intExtraNum : 0;
      // En liquidacion con saldoReal 0 y sin interes extra (todo el capital estaba en la mora) no hay
      // nada que registrar en un abono aparte -> se omite la fila (las cuotas mora ya lo capturan).
      const crearAbono = !liquidar || abonoCapReg > 0 || abonoInt > 0;
      if (crearAbono) {
        insPayment.run({
          id: abonoId,
          prestamoId: req.params.id,
          nombreCliente: loan.nombre,
          cuotaN: maxExistingN + 1,
          fechaPago: fechaAbono,
          saldoInicial: saldoReal,
          interesPeriodo: abonoInt,
          abonoCapital: abonoCapReg,
          cuotaTotal: abonoCapReg + abonoInt,
          saldoFinal: Math.max(0, nuevoSaldo),
          estadoPago: 'Pagado',
          fechaRecaudo: fechaAbono,
          observaciones: observaciones || 'Abono a capital',
          // v2.0.0 — caja real si el frontend la envia (USD: COP efectivamente recibidos, que
          // difieren del capital a TRM pactada); si no, el valor derivado de siempre.
          montoCOPRecibido: copRecibidoNum > 0 ? copRecibidoNum : (abonoCapReg + abonoInt),
          montoUSDRecibido: montoUSD ? Math.round(montoUSD * 100) / 100 : 0,
          partialPaid: 0,
          extraConsolidado: 0
        });
        db.prepare("UPDATE payments SET paidAt = datetime('now','localtime') WHERE id = ?").run(abonoId);
      }

      if (nuevoSaldo <= 0) {
        // Capital saldado
        if (liquidar) {
          // Las cuotas En Mora se saldan: Pagado + montoCOPRecibido = su cuotaTotal (capital + interes
          // de esa cuota), asi el efectivo recibido cuadra y el interes de mora cuenta como cobrado.
          db.prepare("UPDATE payments SET estadoPago = 'Pagado', fechaRecaudo = ?, montoCOPRecibido = cuotaTotal, paidAt = datetime('now','localtime') WHERE prestamoId = ? AND estadoPago = 'En Mora'").run(fechaAbono, req.params.id);
          db.prepare("UPDATE loans SET montoCOP = 0, estado = 'Finalizado', cuotaFijaPactada = 0 WHERE id = ?").run(req.params.id);
        } else {
          const moraRestante = db.prepare("SELECT COUNT(*) as c FROM payments WHERE prestamoId = ? AND estadoPago = 'En Mora'").get(req.params.id);
          if (moraRestante.c === 0) {
            db.prepare("UPDATE loans SET montoCOP = 0, estado = 'Finalizado', cuotaFijaPactada = 0 WHERE id = ?").run(req.params.id);
          } else {
            db.prepare("UPDATE loans SET montoCOP = 0 WHERE id = ?").run(req.params.id);
          }
        }
      } else {
        db.prepare('UPDATE loans SET montoCOP = ? WHERE id = ?').run(nuevoSaldo, req.params.id);
        if (nuevasCuotas.length > 0) insertSchedule(nuevasCuotas);
        if (nuevoPlazoMeses !== null) {
          db.prepare('UPDATE loans SET plazoMeses = ? WHERE id = ?').run(nuevoPlazoMeses, req.params.id);
        }
        if (nuevaCuotaFija !== null) {
          db.prepare('UPDATE loans SET cuotaFijaPactada = ? WHERE id = ?').run(nuevaCuotaFija, req.params.id);
        }
      }
      }
      };
    });
  });

  // ── API: Reestructurar Prestamo (sin abono) ──────────────────────────────
  // Permite recalcular el cronograma de cuotas FUTURAS sin necesidad de hacer un abono.
  // SOLO para modalidad Capital + Intereses. Cuotas Pagadas y En Mora NO se tocan.
  // Atomico: valida + computa todo antes de cualquier escritura.
  app.post('/api/loans/:id/reestructurar', (req, res) => {
    const { recalcMode, recalcValor } = req.body;
    const loan = db.prepare('SELECT * FROM loans WHERE id = ?').get(req.params.id);
    if (!loan) return res.status(404).json({ error: 'No encontrado' });
    return mutacionAtomica(req, res, { accion: 'reestructuracion', endpoint: 'POST /api/loans/:id/reestructurar', scopeTipo: 'loan', scopeId: req.params.id }, () => {
    if (loan.estado !== 'Activo') throw new ClientError('Solo se pueden reestructurar prestamos activos');
    if (loan.modalidad !== 'Capital + Intereses') throw new ClientError('La reestructuracion solo aplica para prestamos de Capital + Intereses');
    if (recalcMode !== 'modificarPlazo' && recalcMode !== 'fijarCuota') {
      throw new ClientError('Modo de recalculo invalido. Debe ser "modificarPlazo" o "fijarCuota".');
    }

    // ── FASE 1: LECTURA + VALIDACION (sin escrituras) ────────────────────────
    const allPays = db.prepare('SELECT * FROM payments WHERE prestamoId = ? ORDER BY cuotaN').all(req.params.id);

    const originalCOP = loan.moneda === 'USD' ? Math.round(loan.montoOrigen * loan.trmAcordada) : Math.round(loan.montoOrigen);
    // v1.12.x FIX (bug de mora): incluir el capital de las cuotas EN MORA (deuda independiente),
    // simetrico con regularConsumed (cuenta Pagadas + Mora). Regla canonica '-ab-' (endpoint
    // gated a Capital + Intereses, asi que Prestamo/Pago Unico no llegan aqui).
    const todoCapPagado = allPays.filter(p =>
      p.estadoPago === 'Pagado' ||
      (p.estadoPago === 'En Mora' && p.id.indexOf('-ab-') === -1)
    ).reduce((s, p) => s + p.abonoCapital, 0);
    const saldoReal = Math.max(0, originalCOP - todoCapPagado);
    if (saldoReal <= 0) throw new ClientError('El prestamo no tiene saldo de capital pendiente para reestructurar');

    const regularConsumed = allPays.filter(p =>
      (p.estadoPago === 'Pagado' || p.estadoPago === 'En Mora') &&
      p.id.indexOf('-ab-') === -1
    ).length;
    const nextRegularN = regularConsumed + 1;
    const updatedLoan = Object.assign({}, loan, { montoCOP: saldoReal });

    let nuevasCuotas = [];
    let nuevoPlazoMeses;
    let nuevaCuotaFija; // 0 = limpiar, >0 = persistir
    let logRecalc;

    if (recalcMode === 'modificarPlazo') {
      const nuevoN = parseInt(recalcValor, 10);
      if (!nuevoN || nuevoN < 1) throw new ClientError('Numero de cuotas invalido. Debe ser >= 1.');
      nuevasCuotas = buildSchedule(updatedLoan, nextRegularN, saldoReal, nuevoN);
      nuevoPlazoMeses = regularConsumed + nuevoN;
      nuevaCuotaFija = 0;
      logRecalc = ' — plazo ajustado a ' + nuevoN + ' cuota' + (nuevoN > 1 ? 's' : '') + ' restantes (total: ' + nuevoPlazoMeses + ')';
    } else {
      // fijarCuota
      const cuotaDeseada = +recalcValor || 0;
      if (cuotaDeseada <= 0) throw new ClientError('Cuota invalida. Debe ser > 0.');
      const r = tasaPeriodo((loan.tasaMensual || 0) / 100, loan.frecuencia || 'Mensual');
      const interesPrimerPeriodo = saldoReal * r;
      if (cuotaDeseada <= interesPrimerPeriodo) {
        throw new ClientError('La cuota debe ser mayor a $' + Math.round(interesPrimerPeriodo).toLocaleString('es-CO') +
          ' (intereses del primer periodo). Con $' + Math.round(cuotaDeseada).toLocaleString('es-CO') +
          ' nunca se saldaria la deuda.');
      }
      try {
        nuevasCuotas = buildScheduleFixedPMT(updatedLoan, nextRegularN, saldoReal, cuotaDeseada);
      } catch (e) {
        throw new ClientError(e.message);
      }
      nuevoPlazoMeses = regularConsumed + nuevasCuotas.length;
      nuevaCuotaFija = Math.round(cuotaDeseada);
      logRecalc = ' — cuota fija $' + Math.round(cuotaDeseada).toLocaleString('es-CO') + ' x ' + nuevasCuotas.length + ' cuotas (total: ' + nuevoPlazoMeses + ')';
    }

    // ── FASE 2: ESCRITURA — la ejecuta mutacionAtomica dentro de UNA transaccion.
    return {
      descripcion: 'Reestructuraste ' + loan.nombre + logRecalc,
      payload: { ok: true, nuevasCuotas: nuevasCuotas.length, nuevoPlazoMeses, cuotaFijaPactada: nuevaCuotaFija },
      aplicar: () => {
        // Borrar cuotas Pendientes (regulares, no abonos). Mora y Pagadas intactas.
        db.prepare("DELETE FROM payments WHERE prestamoId = ? AND estadoPago = 'Pendiente' AND id NOT LIKE '%-ab-%'").run(req.params.id);
        insertSchedule(nuevasCuotas);
        db.prepare('UPDATE loans SET plazoMeses = ?, cuotaFijaPactada = ? WHERE id = ?').run(nuevoPlazoMeses, nuevaCuotaFija, req.params.id);
      }
    };
    });
  });

  // ── API: Cierre Forzoso ───────────────────────────────────────────────────
  // Marca el préstamo como 'Cancelado' (cierre con pérdidas), guarda snapshot
  // de capital pendiente + intereses en mora, y borra las cuotas restantes.
  app.post('/api/loans/:id/force-close', (req, res) => {
    const loan = db.prepare('SELECT * FROM loans WHERE id = ?').get(req.params.id);
    if (!loan) return res.status(404).json({ error: 'No encontrado' });
    // ATOMICO desde "La Bestia": antes el DELETE y el UPDATE iban sueltos (sin transaccion),
    // asi que un fallo entre ambos dejaba el cronograma borrado con el prestamo aun Activo.
    return mutacionAtomica(req, res, { accion: 'cierre', endpoint: 'POST /api/loans/:id/force-close', scopeTipo: 'loan', scopeId: req.params.id }, () => {
      if (loan.estado !== 'Activo') throw new ClientError('Solo se pueden cerrar préstamos activos');

      const allPays = db.prepare('SELECT * FROM payments WHERE prestamoId = ?').all(req.params.id);
      const originalCOP = loan.moneda === 'USD' ? Math.round(loan.montoOrigen * loan.trmAcordada) : Math.round(loan.montoOrigen);
      const todoCapPagado = allPays.filter(p => p.estadoPago === 'Pagado').reduce((s, p) => s + p.abonoCapital, 0);
      const capitalPerdido = Math.max(0, Math.round(originalCOP - todoCapPagado));
      const interesesPerdidos = Math.round(allPays
        .filter(p => p.estadoPago === 'En Mora' && p.id.indexOf('-ab-') === -1)
        .reduce((s, p) => s + p.interesPeriodo, 0));
      const totalPerdido = capitalPerdido + interesesPerdidos;

      return {
        descripcion: 'Cerraste a la fuerza el préstamo de ' + loan.nombre + ' — pérdida: $' + totalPerdido.toLocaleString() + ' (capital $' + capitalPerdido.toLocaleString() + ' + intereses mora $' + interesesPerdidos.toLocaleString() + ')',
        payload: { ok: true, capitalPerdido: capitalPerdido, interesesPerdidos: interesesPerdidos, totalPerdido: totalPerdido },
        aplicar: () => {
          db.prepare("DELETE FROM payments WHERE prestamoId = ? AND estadoPago IN ('Pendiente', 'En Mora')").run(req.params.id);
          db.prepare("UPDATE loans SET estado = 'Cancelado', capitalPerdido = ?, interesesPerdidos = ?, montoCOP = 0, cuotaFijaPactada = 0 WHERE id = ?")
            .run(capitalPerdido, interesesPerdidos, req.params.id);
        }
      };
    });
  });

  // ── API: Cambiar día de pago (con prorrateo) ──────────────────────────────
  // Cambia loan.diaPago y regenera el cronograma. La PRIMERA cuota regenerada es
  // TRANSITORIA: su interes se prorratea a los DIAS REALES de su periodo (desde la
  // ultima cuota PAGADA — o fechaInicio — hasta la nueva fecha), NO un mes completo.
  // Las cuotas siguientes reanudan el ciclo normal de un mes. La mora previa se
  // consolida aparte. Solo aplica a Intereses / Capital + Intereses en frecuencia
  // Mensual. Atomico: valida + computa TODO antes de la primera escritura.
  app.post('/api/loans/:id/cambiar-dia-pago', (req, res) => {
    const { nuevoDia } = req.body;
    const loan = db.prepare('SELECT * FROM loans WHERE id = ?').get(req.params.id);
    if (!loan) return res.status(404).json({ error: 'No encontrado' });
    const freq = loan.frecuencia || 'Mensual';
    const nuevoDiaInt = parseInt(nuevoDia, 10);
    return mutacionAtomica(req, res, { accion: 'cambio-fecha', endpoint: 'POST /api/loans/:id/cambiar-dia-pago', scopeTipo: 'loan', scopeId: req.params.id }, () => {
    if (loan.estado !== 'Activo') throw new ClientError('Solo se puede cambiar la fecha de prestamos activos');
    if (loan.modalidad === 'Prestamo' || loan.modalidad === 'Pago Unico') throw new ClientError('No aplica para prestamos sin cuotas periodicas');
    if (freq !== 'Mensual') throw new ClientError('Cambiar el dia de pago solo aplica a prestamos de frecuencia Mensual');
    if (!nuevoDiaInt || nuevoDiaInt < 1 || nuevoDiaInt > 31) throw new ClientError('Dia invalido');
    if (nuevoDiaInt === loan.diaPago) throw new ClientError('El nuevo dia debe ser distinto al actual');

    // ── FASE 1: LECTURA + VALIDACION + COMPUTO (sin escrituras) ───────────────
    const allPays = db.prepare('SELECT * FROM payments WHERE prestamoId = ? ORDER BY cuotaN').all(req.params.id);
    const regularesTodas = allPays.filter(p => p.id.indexOf('-ab-') === -1); // regla canonica '-ab-'

    // Mora a consolidar: intereses de las cuotas En Mora regulares -> se suman a la 1a cuota nueva
    const morasRegulares = regularesTodas.filter(p => p.estadoPago === 'En Mora');
    const moraCount = morasRegulares.length;
    const moraConsolidada = Math.round(morasRegulares.reduce((s, p) => s + p.interesPeriodo, 0));

    // Punto de partida: cuotas ya PAGADAS (las En Mora se borran; su capital vuelve al residual y
    // se re-amortiza, simetrico con regularConsumed = solo Pagadas — misma doctrina que hoy).
    const pagadasRegulares = regularesTodas.filter(p => p.estadoPago === 'Pagado');
    const regularConsumed = pagadasRegulares.length;
    const nextRegularN = regularConsumed + 1;

    // Saldo actual (capital pendiente). Solo Pagadas -> simetrico con regularConsumed.
    const originalCOP = loan.moneda === 'USD' ? Math.round(loan.montoOrigen * loan.trmAcordada) : Math.round(loan.montoOrigen);
    const todoCapPagado = pagadasRegulares.reduce((s, p) => s + p.abonoCapital, 0);
    const saldoActual = Math.max(0, originalCOP - todoCapPagado);
    if (saldoActual <= 0) throw new ClientError('El prestamo no tiene saldo pendiente');

    // CUOTA TRANSITORIA: prorratear el interes de la 1a cuota a los DIAS REALES de su periodo.
    // Referencia = fechaPago de la ultima cuota PAGADA (o fechaInicio si aun no hay pagos).
    // diasReales = nuevaFecha - referencia. La mora ya cubre su propio periodo (se suma aparte).
    const lastSettledDate = pagadasRegulares.length > 0
      ? pagadasRegulares.map(p => p.fechaPago).sort().slice(-1)[0]
      : loan.fechaInicio;
    // Regla "NUNCA ADELANTAR EL COBRO": si el nuevo dia dejaria la 1a cuota ANTES de la que ya
    // estaba agendada (mismo mes, dia menor), se rueda la base del cronograma +1 mes -> el pago
    // queda PROYECTADO HACIA ADELANTE (aplazamiento). Se persiste en fechaBaseCronograma para que
    // el salto sobreviva a /recalculate y PUT /loans (buildSchedule usa esa base para las fechas).
    const baseActual = loan.fechaBaseCronograma || loan.fechaInicio;
    const origNextDate = getPayDate(baseActual, nextRegularN, loan.diaPago, freq);   // fecha ya agendada
    const naiveDate    = getPayDate(baseActual, nextRegularN, nuevoDiaInt, freq);
    let baseCron = baseActual;
    if (naiveDate < origNextDate) {
      const b = new Date(baseActual + 'T12:00:00');
      b.setDate(1);                    // evita overflow de mes antes de sumar
      b.setMonth(b.getMonth() + 1);
      baseCron = b.toISOString().split('T')[0];
    }
    const firstNewDate = getPayDate(baseCron, nextRegularN, nuevoDiaInt, freq);
    const MS_DIA = 24 * 60 * 60 * 1000;
    const rawDias = Math.round((new Date(firstNewDate + 'T12:00:00') - new Date(lastSettledDate + 'T12:00:00')) / MS_DIA);
    const diasReales = Math.max(1, rawDias);
    const interesProrrateado = Math.round(saldoActual * (loan.tasaMensual / 100) * diasReales / 30);

    // Regenerar cronograma con el nuevo dia y convertir la primera cuota en transitoria.
    const loanConNuevoDia = Object.assign({}, loan, { diaPago: nuevoDiaInt, fechaBaseCronograma: baseCron });
    const indefinido = loan.modalidad === 'Intereses';
    const remaining = indefinido ? 3 : Math.max(1, (loan.plazoMeses || 12) - regularConsumed);
    let nuevasCuotas = buildSchedule(loanConNuevoDia, nextRegularN, saldoActual, remaining);

    // ── GUARDA DEFENSIVA: NUNCA sobrescribir una cuota ya PAGADA ───────────────
    // Este endpoint tiene una asimetria propia: BORRA las cuotas En Mora pero cuenta como
    // consumidas SOLO las Pagadas (regularConsumed, arriba). Si las Pagadas no son contiguas
    // —estado normal cuando el deudor abona el mes corriente y arrastra cuotas viejas— entonces
    // nextRegularN queda POR DEBAJO del cuotaN de una Pagada existente, y como los ids son
    // deterministas (`${loanId}-${cuotaN}`) e insPayment es INSERT OR REPLACE, la fila Pagada
    // se reemplazaba EN SILENCIO por una Pendiente nueva: se perdian estadoPago, fechaRecaudo,
    // montoCOPRecibido, paidAt y el ledger `recibos`, y el capital de esa cuota dejaba de contar
    // en la formula canonica de saldo -> la deuda del cliente SUBIA sola.
    // (Defecto preexistente detectado en la auditoria adversarial de la Fase 1 de undo; reproducido
    //  sobre la BD real: un pago de $265.000 destruido y el saldo inflado en $162.761.)
    // Se saltan esos ids. Mismo patron defensivo que autoExtendSoloIntereses, que ya comprueba
    // la existencia antes de insertar. NO cambia la doctrina financiera del prorrateo: el filtro
    // se aplica ANTES de marcar la cuota transitoria, de modo que la transitoria siempre recae
    // sobre una fila que si se va a insertar.
    const idsPagadas = new Set(pagadasRegulares.map(p => p.id));
    const cuotasProtegidas = nuevasCuotas.filter(p => idsPagadas.has(p.id)).map(p => p.cuotaN);
    if (cuotasProtegidas.length > 0) {
      nuevasCuotas = nuevasCuotas.filter(p => !idsPagadas.has(p.id));
    }

    let netAdj = 0;
    if (nuevasCuotas.length > 0) {
      const primera = nuevasCuotas[0];
      const fullInt = primera.interesPeriodo;          // interes de mes completo que calculo buildSchedule
      const deltaInt = fullInt - interesProrrateado;   // reduccion por periodo corto (negativo si el periodo es > 1 mes)
      // Ajuste NETO con signo = (prorrateo + mora) - full. Se persiste para sobrevivir a /recalculate y PUT /loans.
      netAdj = Math.round(moraConsolidada - deltaInt);
      // interesPeriodo = interes prorrateado + mora; cuotaTotal baja el delta y suma la mora.
      // abonoCapital y saldoFinal quedan INTACTOS -> amortizacion (Capital + Intereses) preservada.
      primera.interesPeriodo = Math.round(interesProrrateado + moraConsolidada);
      primera.cuotaTotal = Math.round(primera.cuotaTotal - deltaInt + moraConsolidada);
      primera.extraConsolidado = netAdj;
      primera.observaciones = 'Cuota transitoria: interes de ' + diasReales + ' dias prorrateado'
        + (moraConsolidada > 0 ? ' + mora consolidada $' + moraConsolidada.toLocaleString('es-CO') : '');
    }

    // ── FASE 2: ESCRITURA — la ejecuta mutacionAtomica dentro de UNA transaccion.
    const logMsg = 'Cambiaste dia de pago de ' + loan.nombre + ' del ' + loan.diaPago + ' al ' + nuevoDiaInt
      + ' - 1a cuota transitoria de ' + diasReales + ' dias (interes $' + interesProrrateado.toLocaleString('es-CO') + ')'
      + (moraCount > 0 ? ' + ' + moraCount + ' cuota' + (moraCount > 1 ? 's' : '') + ' en mora ($' + moraConsolidada.toLocaleString('es-CO') + ')' : '');

    return {
      descripcion: logMsg,
      payload: {
        ok: true,
        nuevoDia: nuevoDiaInt,
        primeraCuota: nuevasCuotas[0] || null,
        // Radiografia de la cuota transitoria para el modal: capital (amortizacion normal, intacta),
        // interes prorrateado (solo dias reales) y total. capitalCuota = abonoCapital de la 1a cuota.
        capitalCuota: nuevasCuotas.length > 0 ? nuevasCuotas[0].abonoCapital : 0,
        cuotaTotalTransitoria: nuevasCuotas.length > 0 ? nuevasCuotas[0].cuotaTotal : 0,
        cuotasRecurrentes: nuevasCuotas.length > 1 ? nuevasCuotas[1].cuotaTotal : (nuevasCuotas[0] ? nuevasCuotas[0].cuotaTotal - netAdj : 0),
        moraConsolidada: moraConsolidada,
        prorrateo: interesProrrateado,
        diasReales: diasReales,
        moraCount: moraCount,
        // Cuotas ya Pagadas que la guarda defensiva protegio de ser sobrescritas (normalmente []).
        cuotasProtegidas: cuotasProtegidas
      },
      aplicar: () => {
        // Borrar Pendientes + En Mora regulares (preserva Pagadas y abonos '-ab-')
        db.prepare("DELETE FROM payments WHERE prestamoId = ? AND estadoPago IN ('Pendiente','En Mora') AND id NOT LIKE '%-ab-%'").run(req.params.id);
        db.prepare('UPDATE loans SET diaPago = ?, fechaBaseCronograma = ? WHERE id = ?').run(nuevoDiaInt, baseCron, req.params.id);
        // Persistir el ajuste NETO con signo (proximaCuotaExtra) para reproducir la cuota transitoria
        // al regenerar. /recalculate y PUT /loans aplican `+= extra` con guard `!== 0`.
        db.prepare('UPDATE loans SET proximaCuotaExtra = ?, proximaCuotaExtraN = ? WHERE id = ?')
          .run(netAdj, nuevasCuotas.length > 0 ? nuevasCuotas[0].cuotaN : 0, req.params.id);
        if (nuevasCuotas.length > 0) insertSchedule(nuevasCuotas);
      }
    };
    });
  });

  // ── API: Historial de acciones ────────────────────────────────────────────
  app.get('/api/activity', (_req, res) => {
    const rows = db.prepare('SELECT * FROM activity_log ORDER BY id DESC LIMIT 100').all();
    res.json(rows);
  });

  // ── API: Modulo "Mis Deudas" (registro manual, sin intereses) ───────────────

  // Lista todas las deudas con su saldo_pendiente actual (Activas primero, luego por fecha desc)
  app.get('/api/debts', (_req, res) => {
    // QA5: agrega total_cargos / total_abonos por deuda para que la barra de progreso del frontend
    // tenga base dinamica (monto_original + cargos) sin pedir el detalle de cada una.
    res.json(db.prepare(`
      SELECT d.*,
        COALESCE((SELECT SUM(CASE WHEN p.tipo = 'cargo' THEN p.monto_pagado ELSE 0 END) FROM pagos_deudas p WHERE p.deuda_id = d.id), 0) AS total_cargos,
        COALESCE((SELECT SUM(CASE WHEN p.tipo = 'cargo' THEN 0 ELSE p.monto_pagado END) FROM pagos_deudas p WHERE p.deuda_id = d.id), 0) AS total_abonos
      FROM mis_deudas d
      ORDER BY d.estado ASC, d.fecha_creacion DESC, d.id DESC
    `).all());
  });

  // Detalle de una deuda + su historial de pagos (ledger pagos_deudas)
  app.get('/api/debts/:id', (req, res) => {
    const deuda = db.prepare('SELECT * FROM mis_deudas WHERE id = ?').get(req.params.id);
    if (!deuda) return res.status(404).json({ error: 'Deuda no encontrada' });
    const pagos = db.prepare('SELECT * FROM pagos_deudas WHERE deuda_id = ? ORDER BY fecha_pago DESC, id DESC').all(req.params.id);
    res.json({ ...deuda, pagos });
  });

  // Crea una deuda. saldo_pendiente arranca igual al monto_original; estado 'Activa'.
  app.post('/api/debts', (req, res) => {
    const titulo = (req.body.titulo || '').trim();
    const acreedor = (req.body.acreedor || '').trim();
    const concepto = (req.body.concepto || '').trim();
    const monto = Math.round(+req.body.monto_original || 0);
    if (!titulo) return res.status(400).json({ error: 'El titulo es obligatorio' });
    if (!acreedor) return res.status(400).json({ error: 'El acreedor es obligatorio' });
    if (monto <= 0) return res.status(400).json({ error: 'El monto original debe ser mayor a 0' });
    // QA3: fecha_creacion editable. Si viene en el payload se usa; si no, el INSERT omite la
    // columna y queda el DEFAULT (datetime('now','localtime')).
    const fecha = (req.body.fecha_creacion || '').toString().slice(0, 10);
    // El id se genera ANTES para que el scope del journal sea conocido. El snapshot previo de
    // una deuda que aun no existe es {deuda:null, pagos:[]} -> deshacer = eliminarla.
    const id = genId();
    return mutacionAtomica(req, res, { accion: 'deuda_crear', logTipo: 'deuda', endpoint: 'POST /api/debts', scopeTipo: 'debt', scopeId: id }, () => ({
      descripcion: 'Nueva deuda "' + titulo + '" con ' + acreedor + ' por $' + monto.toLocaleString('es-CO'),
      aplicar: () => {
        if (fecha) {
          db.prepare(`INSERT INTO mis_deudas(id, titulo, acreedor, concepto, monto_original, saldo_pendiente, estado, fecha_creacion)
                      VALUES (?, ?, ?, ?, ?, ?, 'Activa', ?)`).run(id, titulo, acreedor, concepto, monto, monto, fecha);
        } else {
          db.prepare(`INSERT INTO mis_deudas(id, titulo, acreedor, concepto, monto_original, saldo_pendiente, estado)
                      VALUES (?, ?, ?, ?, ?, ?, 'Activa')`).run(id, titulo, acreedor, concepto, monto, monto);
        }
        return db.prepare('SELECT * FROM mis_deudas WHERE id = ?').get(id);
      }
    }));
  });

  // Registra un abono manual: inserta en pagos_deudas y resta saldo_pendiente.
  // Si el saldo llega a 0 -> estado 'Pagada'. ATOMICO: valida y computa TODO antes
  // de la primera escritura; las mutaciones van dentro de db.transaction (all-or-nothing).
  app.post('/api/debts/:id/pay', (req, res) => {
    // FASE 1 — lectura + validacion (sin escrituras)
    const deuda = db.prepare('SELECT * FROM mis_deudas WHERE id = ?').get(req.params.id);
    if (!deuda) return res.status(404).json({ error: 'Deuda no encontrada' });
    // QA5 "Cuenta Rotativa": 'abono' reduce la deuda, 'cargo' la aumenta (sin tope).
    const tipo = req.body.tipo === 'cargo' ? 'cargo' : 'abono';
    const monto = Math.round(+req.body.monto_pagado || 0);
    const fecha = (req.body.fecha_pago || hoyStr()).toString().slice(0, 10);
    const notas = (req.body.notas || '').trim();
    const pagoId = genId();

    return mutacionAtomica(req, res, { accion: 'deuda_movimiento', logTipo: 'deuda', endpoint: 'POST /api/debts/:id/pay', scopeTipo: 'debt', scopeId: req.params.id }, () => {
      if (monto <= 0) throw new ClientError('El monto del movimiento debe ser mayor a 0');
      // Solo el abono tiene tope (no se puede abonar mas que el saldo). El cargo NO tiene limite,
      // y puede reactivar una deuda 'Pagada'.
      if (tipo === 'abono' && monto > deuda.saldo_pendiente) {
        throw new ClientError('El abono ($' + monto.toLocaleString('es-CO') + ') supera el saldo pendiente ($' + Math.round(deuda.saldo_pendiente).toLocaleString('es-CO') + ')');
      }
      // El saldo se RECALCULA desde el ledger: monto_original + SUM(cargos) - SUM(abonos).
      // La descripcion se evalua DESPUES de aplicar (necesita el saldo ya recalculado).
      let actualizada = null;
      return {
        descripcion: () => (tipo === 'cargo' ? 'Cargo' : 'Abono') + ' a deuda con ' + deuda.acreedor + ': $' + monto.toLocaleString('es-CO')
          + ' — saldo: $' + Math.round(actualizada.saldo_pendiente).toLocaleString('es-CO') + (actualizada.estado === 'Pagada' ? ' (PAGADA)' : ''),
        aplicar: () => {
          db.prepare('INSERT INTO pagos_deudas(id, deuda_id, monto_pagado, fecha_pago, notas, tipo) VALUES (?, ?, ?, ?, ?, ?)')
            .run(pagoId, deuda.id, monto, fecha, notas, tipo);
          const agg = db.prepare("SELECT COALESCE(SUM(CASE WHEN tipo = 'cargo' THEN monto_pagado ELSE 0 END), 0) AS cargos, COALESCE(SUM(CASE WHEN tipo = 'cargo' THEN 0 ELSE monto_pagado END), 0) AS abonos FROM pagos_deudas WHERE deuda_id = ?").get(deuda.id);
          const saldo = Math.round((deuda.monto_original + agg.cargos - agg.abonos) * 100) / 100;
          const estado = saldo <= 0 ? 'Pagada' : 'Activa';
          db.prepare('UPDATE mis_deudas SET saldo_pendiente = ?, estado = ? WHERE id = ?').run(saldo, estado, deuda.id);
          actualizada = db.prepare('SELECT * FROM mis_deudas WHERE id = ?').get(deuda.id);
          return { ok: true, pago: db.prepare('SELECT * FROM pagos_deudas WHERE id = ?').get(pagoId), deuda: actualizada };
        }
      };
    });
  });

  // Edita una deuda (acreedor, concepto, monto_original). Recalcula saldo y estado.
  // Validacion: el nuevo monto_original NO puede ser menor a lo ya pagado en el ledger.
  app.put('/api/debts/:id', (req, res) => {
    const deuda = db.prepare('SELECT * FROM mis_deudas WHERE id = ?').get(req.params.id);
    if (!deuda) return res.status(404).json({ error: 'Deuda no encontrada' });
    const titulo = (req.body.titulo || '').trim();
    const acreedor = (req.body.acreedor || '').trim();
    const concepto = (req.body.concepto || '').trim();
    const monto = Math.round(+req.body.monto_original || 0);
    return mutacionAtomica(req, res, { accion: 'deuda_editar', logTipo: 'deuda', endpoint: 'PUT /api/debts/:id', scopeTipo: 'debt', scopeId: req.params.id }, () => {
      if (!titulo) throw new ClientError('El titulo es obligatorio');
      if (!acreedor) throw new ClientError('El acreedor es obligatorio');
      if (monto <= 0) throw new ClientError('El monto original debe ser mayor a 0');
      // QA5: saldo = monto_original + SUM(cargos) - SUM(abonos). La proteccion impide bajar el monto
      // por debajo de lo ya abonado NETO (abonos - cargos), que dejaria el saldo negativo.
      const agg = db.prepare("SELECT COALESCE(SUM(CASE WHEN tipo = 'cargo' THEN monto_pagado ELSE 0 END), 0) AS cargos, COALESCE(SUM(CASE WHEN tipo = 'cargo' THEN 0 ELSE monto_pagado END), 0) AS abonos FROM pagos_deudas WHERE deuda_id = ?").get(req.params.id);
      const netAbonado = Math.round(agg.abonos - agg.cargos);
      if (monto < netAbonado) {
        throw new ClientError('El monto ($' + monto.toLocaleString('es-CO') + ') no puede ser menor a lo ya abonado neto ($' + netAbonado.toLocaleString('es-CO') + ')');
      }
      const nuevoSaldo = Math.round((monto + agg.cargos - agg.abonos) * 100) / 100;
      const nuevoEstado = nuevoSaldo <= 0 ? 'Pagada' : 'Activa';
      // QA3: fecha_creacion editable; si el payload no la trae, se conserva la existente.
      const fecha = (req.body.fecha_creacion || '').toString().slice(0, 10) || deuda.fecha_creacion;
      return {
        descripcion: 'Editaste la deuda "' + titulo + '" con ' + acreedor + ' (monto $' + monto.toLocaleString('es-CO') + ', saldo $' + nuevoSaldo.toLocaleString('es-CO') + ')',
        aplicar: () => {
          db.prepare('UPDATE mis_deudas SET titulo = ?, acreedor = ?, concepto = ?, monto_original = ?, saldo_pendiente = ?, estado = ?, fecha_creacion = ? WHERE id = ?')
            .run(titulo, acreedor, concepto, monto, nuevoSaldo, nuevoEstado, fecha, req.params.id);
          return db.prepare('SELECT * FROM mis_deudas WHERE id = ?').get(req.params.id);
        }
      };
    });
  });

  // Elimina una deuda y su ledger. La FK tiene ON DELETE CASCADE; ademas borramos el
  // ledger explicitamente (robustez) dentro de una transaccion all-or-nothing.
  app.delete('/api/debts/:id', (req, res) => {
    const deuda = db.prepare('SELECT * FROM mis_deudas WHERE id = ?').get(req.params.id);
    if (!deuda) return res.status(404).json({ error: 'Deuda no encontrada' });
    // El snapshot guarda la deuda + su ledger completo -> deshacer la RESUCITA con sus movimientos.
    return mutacionAtomica(req, res, { accion: 'deuda_eliminar', logTipo: 'deuda', endpoint: 'DELETE /api/debts/:id', scopeTipo: 'debt', scopeId: req.params.id }, () => ({
      descripcion: 'Eliminaste la deuda con ' + deuda.acreedor + ' ($' + Math.round(deuda.monto_original).toLocaleString('es-CO') + ')',
      aplicar: () => {
        db.prepare('DELETE FROM pagos_deudas WHERE deuda_id = ?').run(req.params.id);
        db.prepare('DELETE FROM mis_deudas WHERE id = ?').run(req.params.id);
      }
    }));
  });

  return app;
};
