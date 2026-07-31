// backend/db/housekeeping.js — normalizaciones deterministas de arranque.
//
// Extraido de `server.js` en la Etapa 2 (A3) del refactor de modularizacion.
// SQL movido VERBATIM.
//
// Son deterministas y dependen de la FECHA DE HOY, no de decisiones del usuario.
// Ese detalle es el que obliga a que el Candado B del undo sea un DETECTOR y no un
// gate: si el `post_hash` bloqueara, TODOS los undos caducarian con solo reiniciar
// la app o cruzar una fecha de vencimiento. Por eso `reHousekeepLoan` existe: tras
// restaurar un agregado se vuelve a aplicar esto, y la divergencia viaja como
// `warning`, nunca como bloqueo.
//
// NOTA DEL REFACTOR: `aplicarHousekeepingArranque` (global) y `reHousekeepLoan`
// (por prestamo) hacen lo mismo con SQL distinto — uno barre toda la tabla, el otro
// filtra por `prestamoId`. Se conservan como estaban, POR SEPARADO. Unificarlas
// seria un cambio de logica, que este refactor tiene prohibido: el barrido global
// y el puntual no son intercambiables (el global corre una sola vez al abrir; el
// puntual corre dentro de la transaccion de un undo).

const { hoyStr } = require('../core/util');

function crearHousekeeping(db) {

  // ── Auto-mora al arrancar + correccion de cuotas en mora de 'Prestamo' ──────
  function aplicarHousekeepingArranque() {
    // ── Auto-mora al arrancar ─────────────────────────────────────────────────
    db.prepare(`UPDATE payments SET estadoPago='En Mora' WHERE estadoPago='Pendiente' AND fechaPago < ?`)
      .run(hoyStr());

    // ── Corregir cuotas en mora de Prestamo: cuotaTotal debe = saldo actual (montoCOP) ──
    // Solo para Prestamo (sin intereses, 1 cuota de capital). NO para Intereses (cuota = interés mensual fijo).
    // v1.18.2 (Bug #30): tambien abonoCapital = montoCOP, simetrico con el housekeeping de /recalculate
    // y de /abono. Antes solo tocaba cuotaTotal/saldoFinal -> dejaba abonoCapital=0 en
    // la cuota En Mora, y al pagarse (PUT /payments no recalcula abonoCapital) el capital no contaba.
    const fixPrestamos = db.prepare("SELECT * FROM loans WHERE estado = 'Activo' AND modalidad = 'Prestamo'").all();
    fixPrestamos.forEach(fl => {
      const nsFix = Math.round(fl.montoCOP);
      db.prepare(`UPDATE payments SET saldoInicial = ?, abonoCapital = ?, cuotaTotal = ?, saldoFinal = 0
        WHERE prestamoId = ? AND estadoPago = 'En Mora'
        AND id NOT LIKE '%-ab-%'`)
        .run(nsFix, nsFix, nsFix, fl.id);
    });
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

  return { aplicarHousekeepingArranque, reHousekeepLoan };
}

module.exports = { crearHousekeeping };
