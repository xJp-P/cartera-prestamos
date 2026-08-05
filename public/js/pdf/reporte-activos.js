// public/js/pdf/reporte-activos.js — Mapa de riesgo interno: capital en la calle, mora y vencimientos.
//
// Extraido de `app.js` en la Etapa 3 (B6) del refactor. Codigo VERBATIM.
//
// Los 5 generadores emiten por `window.electronAPI.printPDF(html, nombre)` con
// respaldo a `window.open` + `print`. No hay libreria de PDF: se arma HTML y lo
// imprime Electron (printToPDF con margins:none, que es lo que consigue el borde
// a borde real; el `@page{margin:0}` del CSS por si solo no basta).
//
// DOCTRINA (v2.3.0): los PDF NO son una excepcion a lo que muestra la app. Usan
// `saldoConCaja` e `imputarCobros`, igual que la pantalla desde la que se generan.
// Hasta v2.3.0 usaban la formula vieja mientras la UI ya mostraba la nueva: el
// papel y la app se contradecian justo cuando el cliente pregunta (Bug #45).
// UNICA excepcion deliberada: el *Valor de liquidacion* sale de
// `computeLiquidacion`, que resta el parcial APARTE; migrarlo lo restaria dos veces.

import { fmt, fmtUSD, fmtD, copToUsd } from '../core/format.js';
import { saldoConCaja, esDiario, estadoDiario } from '../core/dominio.js';
import { nowStr } from '../core/ui.js';
import { esAbono } from '../core/ids.js';

// ── Reporte de Prestamos Activos (PDF) ────────────────────────────────────
// Reusa el pipeline printToPDF (electronAPI.printPDF) con fallback a window.print,
// igual que generateCronogramaPDF/generateRecibo -> cero dependencias nuevas.
// Un bloque por prestamo activo; las cuotas En Mora se anidan debajo del prestamo.
// Totalizador del "capital total en la calle" al final. Tema-aware (claro/oscuro).
export function generateReportePrestamosPDF(loans, pays, darkMode) {
  var dark = !!darkMode;
  var fechaEmision = new Date().toLocaleDateString('es-CO', {day:'2-digit', month:'long', year:'numeric'});
  var hoy = new Date(); hoy.setHours(12, 0, 0, 0);
  function diasAtraso(iso) { if (!iso) return 0; var d = new Date(iso + 'T12:00:00'); return Math.max(0, Math.round((hoy - d) / 86400000)); }
  // v2.1.2 — SALDO REAL de una cuota en mora: lo que FALTA por cobrar, no el valor original.
  // Un pago parcial (POST /payments/:id/partial que no completa la cuota) deja la cuota En Mora
  // con partialPaid > 0; imprimir cuotaTotal afirmaba que se debe el 100% cuando ya entro parte
  // del dinero. Se usa en las 4 superficies del reporte (sub-fila, orden del mapa de riesgo,
  // total vencido y su equivalente USD) para que no puedan divergir entre si.
  function saldoMora(p) { return Math.max(0, (p.cuotaTotal || 0) - (p.partialPaid || 0)); }
  // USD: el cliente paga DOLARES, asi que lo pendiente se mide contra los dolares YA entregados
  // (montoUSDRecibido), no reconvirtiendo los COP abonados a TRM pactada — eso exige de mas cuando
  // la TRM del dia fue menor (doctrina del Bug #23). Misma formula que `pendUSD` en la Factura de
  // Cobro. Sin USD registrado (parcial pagado en pesos) se cae al equivalente COP, correcto ahi.
  function saldoMoraUSD(p, trm) {
    if (!(trm > 0)) return 0;
    var usdRec = +p.montoUSDRecibido || 0;
    return usdRec > 0 ? Math.max(0, (p.cuotaTotal || 0) / trm - usdRec) : saldoMora(p) / trm;
  }

  // Saldo (formula canonica: originalCOP - capital pagado) + cuotas en mora, por prestamo activo
  var rows = (loans || []).filter(function(l) { return l.estado === 'Activo'; }).map(function(l) {
    var esUSD = l.moneda === 'USD';
    var trm = l.trmAcordada || 1;
    var lp = (pays || []).filter(function(p) { return p.prestamoId === l.id; });
    var originalCOP = esUSD ? Math.round(l.montoOrigen * trm) : Math.round(l.montoOrigen);
    // Fase 3: saldo CON CAJA APLICADA. Antes la columna SALDO y el totalizador "capital total en
    // la calle" eran ciegos al capital ya cubierto por un parcial en curso, mientras las sub-filas
    // de mora SI lo descontaban (helper saldoMora, v2.1.2) -> el documento se contradecia solo.
    var saldo = saldoConCaja(l, lp);
    var moras = lp.filter(function(p) { return !esAbono(p) && p.estadoPago === 'En Mora'; })
                  .sort(function(a, b) { return a.cuotaN - b.cuotaN; });
    var vencido = moras.reduce(function(s, p) { return s + saldoMora(p); }, 0);
    // Fila principal = proxima cuota PENDIENTE (el ciclo regular activo). Las En Mora NO van aqui:
    // se detallan en sub-filas rojas. Si no queda ninguna Pendiente (cronograma terminado) -> '—'.
    var pendientes = lp.filter(function(p) { return !esAbono(p) && p.estadoPago === 'Pendiente'; })
                       .sort(function(a, b) { return a.cuotaN - b.cuotaN; });
    var mainCuota = pendientes.length ? pendientes[0] : null;
    // Cuota transitoria (cambio de fecha): extraConsolidado != 0. La fila principal muestra su valor
    // REGULAR (cuotaTotal - extraConsolidado) como referencia; el prorrateo real va en sub-fila ambar.
    var esTransitoria = !!(mainCuota && mainCuota.extraConsolidado && mainCuota.extraConsolidado !== 0);
    var transValor = esTransitoria ? mainCuota.cuotaTotal : 0;
    var transFechaLabel = esTransitoria ? fmtD(mainCuota.fechaPago) : '';   // fecha REAL de la transitoria (sub-fila ambar)
    var vencLabel, proxLabel, proxValor, proxValorLabel;
    if (mainCuota) {
      proxValor = esTransitoria ? (mainCuota.cuotaTotal - mainCuota.extraConsolidado) : mainCuota.cuotaTotal;
      proxValorLabel = fmt(proxValor);
      if (esTransitoria) {
        // Vencimiento de la fila principal = fecha del PROXIMO ciclo regular (la cuota siguiente a la
        // transitoria): el mes en que retoma la normalidad. La fecha de la transitoria va en la sub-fila.
        var nextReg = pendientes.length > 1 ? pendientes[1] : null;
        vencLabel = fmtD(nextReg ? nextReg.fechaPago : mainCuota.fechaPago);
      } else {
        vencLabel = fmtD(mainCuota.fechaPago);
      }
      if (l.modalidad === 'Intereses') proxLabel = '#' + mainCuota.cuotaN;              // plazo indefinido
      else if (l.modalidad === 'Prestamo' || l.modalidad === 'Pago Unico') proxLabel = '1/1';
      else proxLabel = mainCuota.cuotaN + '/' + (l.plazoMeses || '?');                   // N/M
    } else { vencLabel = '—'; proxLabel = '—'; proxValor = 0; proxValorLabel = '—'; }
    // ── INTERES DIARIO ────────────────────────────────────────────────────────
    // Un credito abierto no tiene cuota que proyectar, asi que las tres columnas
    // salian en '—' y el reporte no decia NADA util de el. Se reinterpretan con lo
    // que si tiene: desde cuando devenga, cuantos dias lleva y cuanto genera al dia.
    // El saldo pasa a incluir el interes devengado: es lo que habria que cobrar hoy,
    // y ese es el sentido de un "capital en la calle".
    var devD = null;
    if (esDiario(l)) {
      devD = estadoDiario(l, lp, nowStr());
      vencLabel = devD.fechaUltimoCorte ? fmtD(devD.fechaUltimoCorte) : fmtD(l.fechaInicio);
      proxLabel = devD.diasDesdeUltimoCorte + ' dias';
      proxValor = Math.round(devD.capitalVivo * (+l.tasaMensual || 0) / 100 / 30);
      proxValorLabel = fmt(proxValor) + '/dia';
      saldo = devD.capitalVivo + devD.interesPendiente;
    }
    var tasaStr;
    if (l.modalidad === 'Pago Unico') {
      var pct = (l.gananciaFija > 0 && originalCOP > 0) ? (Math.round(l.gananciaFija / originalCOP * 1000) / 10) : 0;
      tasaStr = pct + '% ganancia';
    } else if (l.modalidad === 'Prestamo') {
      tasaStr = '0%';
    } else {
      tasaStr = (l.tasaMensual || 0) + '% mensual';
    }
    var modLabel = l.modalidad === 'Capital + Intereses' ? 'Cap. + Int.' : l.modalidad;
    return { l: l, esUSD: esUSD, trm: trm, saldo: saldo, moras: moras, vencido: vencido, tasaStr: tasaStr, modLabel: modLabel,
             vencLabel: vencLabel, proxLabel: proxLabel, proxValor: proxValor, proxValorLabel: proxValorLabel, esTransitoria: esTransitoria, transValor: transValor, transFechaLabel: transFechaLabel };
  });

  // Orden (mapa de riesgo): En Mora primero por TOTAL VENCIDO desc; luego Al dia por SALDO desc
  rows.sort(function(a, b) {
    var am = a.moras.length > 0, bm = b.moras.length > 0;
    if (am !== bm) return am ? -1 : 1;      // En Mora arriba
    if (am) return b.vencido - a.vencido;   // ambos en mora: quien deba mas plata vencida primero
    return b.saldo - a.saldo;               // ambos al dia: mayor capital prestado primero
  });

  var totalSaldo = rows.reduce(function(s, r) { return s + r.saldo; }, 0);
  var totalVencido = rows.reduce(function(s, r) { return s + r.moras.reduce(function(a, p) { return a + saldoMora(p); }, 0); }, 0);
  var countMora = rows.filter(function(r) { return r.moras.length > 0; }).length;
  // Porcion en USD de los totales (solo prestamos en dolares) para mostrarla al lado del COP
  var totalVencidoUSD = rows.reduce(function(s, r) { if (!r.esUSD || r.trm <= 0) return s; return s + r.moras.reduce(function(a, p) { return a + saldoMoraUSD(p, r.trm); }, 0); }, 0);
  var totalSaldoUSD = rows.reduce(function(s, r) { if (!r.esUSD || r.trm <= 0) return s; return s + r.saldo / r.trm; }, 0);

  var filasHTML = rows.map(function(r) {
    var l = r.l, esMora = r.moras.length > 0;
    // Estado del renglon: la fila principal representa la proxima cuota Pendiente (futura). Si el
    // prestamo tiene mora pero esa cuota aun no vence -> "Pendiente" (neutral gris); las sub-filas
    // rojas ya alertan la mora. Sin ninguna Pendiente (cronograma vencido completo) -> "En Mora".
    var estadoBadge = !esMora
      ? '<span class="badge badge-pagado">Al dia</span>'
      : (r.proxLabel !== '—' ? '<span class="badge badge-pend">Pendiente</span>' : '<span class="badge badge-mora">En Mora</span>');
    var usdSub = r.esUSD ? '<div class="usd-sub">' + copToUsd(r.saldo, r.trm) + '</div>' : '';
    var usdSubCuota = (r.esUSD && r.proxValor > 0) ? '<div class="usd-sub">' + copToUsd(r.proxValor, r.trm) + '</div>' : '';
    var loanTr = '<tr class="loan-row' + (esMora ? ' mora' : '') + '">' +
      '<td>' + r.vencLabel + '</td>' +
      '<td><strong>' + l.nombre + '</strong></td>' +
      '<td>' + r.modLabel + '</td>' +
      '<td>' + r.tasaStr + '</td>' +
      '<td style="text-align:center">' + r.proxLabel + '</td>' +
      '<td style="text-align:right">' + r.proxValorLabel + usdSubCuota + '</td>' +
      '<td style="text-align:right"><strong>' + fmt(r.saldo) + '</strong>' + usdSub + '</td>' +
      '<td style="text-align:center">' + estadoBadge + '</td></tr>';
    // Sub-filas rojas: cuotas En Mora. El valor USD va en azul (igual que el resto de valores USD).
    var moraTrs = r.moras.map(function(p) {
      var dias = diasAtraso(p.fechaPago);
      // v2.1.2 — se imprime el SALDO PENDIENTE de la cuota, no su valor nominal: si ya entro un
      // pago parcial, cobrar el 100% seria cobrar dos veces lo abonado.
      var pend = saldoMora(p);
      var abonado = Math.max(0, (p.cuotaTotal || 0) - pend);
      var usdMora = r.esUSD ? ' &middot; <span class="usd-i">' + fmtUSD(saldoMoraUSD(p, r.trm)) + '</span>' : '';
      // Si hubo abono parcial se aclara, para que el deudor entienda por que la cifra es menor
      // que el valor de la cuota (de lo contrario el documento parece tener un error).
      var notaParcial = abonado > 0 ? ' &middot; abonado ' + fmt(abonado) + ' de ' + fmt(p.cuotaTotal) : '';
      return '<tr class="mora-sub"><td colspan="8"><div class="mora-detalle">' +
        '<span>&#8627; Cuota #' + p.cuotaN + ' &middot; vencio el ' + fmtD(p.fechaPago) + ' &middot; ' + dias + ' dia' + (dias === 1 ? '' : 's') + ' de atraso' + notaParcial + '</span>' +
        '<span><strong>' + fmt(pend) + '</strong>' + usdMora + '</span></div></td></tr>';
    }).join('');
    // Sub-fila ambar: cuota transitoria (interes prorrateado por cambio de fecha)
    var transTr = r.esTransitoria ? ('<tr class="tran-sub"><td colspan="8"><div class="tran-detalle">' +
      '<span>&#8627; Cuota transitoria &middot; vence ' + r.transFechaLabel + ' &middot; interes prorrateado</span>' +
      '<span><strong>' + fmt(r.transValor) + '</strong>' + (r.esUSD ? ' &middot; <span class="usd-i">' + copToUsd(r.transValor, r.trm) + '</span>' : '') + '</span></div></td></tr>') : '';
    return loanTr + moraTrs + transTr;
  }).join('');

  var html = [
    '<!DOCTYPE html><html><head><meta charset="utf-8"><title>Reporte de Prestamos Activos</title>',
    '<style>',
    '*{margin:0;padding:0;box-sizing:border-box}',
    dark ? 'body{font-family:Arial,sans-serif;padding:30px;max-width:780px;margin:0 auto;color:#e6edf3;background:#0d1117;font-size:12px}' :
           'body{font-family:Arial,sans-serif;padding:30px;max-width:780px;margin:0 auto;color:#1f2328;font-size:12px}',
    dark ? '.header{text-align:center;border-bottom:2px solid #30363d;padding-bottom:14px;margin-bottom:12px}' :
           '.header{text-align:center;border-bottom:2px solid #333;padding-bottom:14px;margin-bottom:12px}',
    '.header h1{font-size:20px;margin-bottom:4px}',
    dark ? '.header p{font-size:11px;color:#8b949e}' : '.header p{font-size:11px;color:#656d76}',
    dark ? '.summary{display:flex;gap:20px;justify-content:center;margin-bottom:16px;font-size:11px;color:#8b949e}' :
           '.summary{display:flex;gap:20px;justify-content:center;margin-bottom:16px;font-size:11px;color:#656d76}',
    '.summary strong{color:' + (dark ? '#e6edf3' : '#1f2328') + '}',
    'table{width:100%;border-collapse:collapse}',
    dark ? 'th{background:#161b22;border:1px solid #30363d;padding:7px 9px;text-align:left;font-size:10px;font-weight:700;color:#8b949e;text-transform:uppercase}' :
           'th{background:#f6f8fa;border:1px solid #d0d7de;padding:7px 9px;text-align:left;font-size:10px;font-weight:700;color:#656d76;text-transform:uppercase}',
    dark ? 'td{border:1px solid #30363d;padding:7px 9px;font-size:11px;vertical-align:top}' :
           'td{border:1px solid #d0d7de;padding:7px 9px;font-size:11px;vertical-align:top}',
    dark ? 'tr.loan-row.mora td{background:#2d1117}' : 'tr.loan-row.mora td{background:#fff1f0}',
    '.usd-sub{font-size:9px;color:' + (dark ? '#79c0ff' : '#0969da') + ';margin-top:2px;font-weight:400}',
    dark ? 'tr.mora-sub td{border-top:none;background:#1a0e11;padding:3px 9px}' : 'tr.mora-sub td{border-top:none;background:#fff8f7;padding:3px 9px}',
    '.mora-detalle{display:flex;justify-content:space-between;gap:12px;padding-left:16px;font-size:10px;color:' + (dark ? '#f85149' : '#cf222e') + '}',
    '.usd-i{color:' + (dark ? '#79c0ff' : '#0969da') + ';font-weight:700}',
    dark ? 'tr.tran-sub td{border-top:none;background:#2b2005;padding:4px 9px}' : 'tr.tran-sub td{border-top:none;background:#fff8e1;padding:4px 9px}',
    '.tran-detalle{display:flex;justify-content:space-between;gap:12px;padding-left:16px;font-size:10px;font-weight:700;color:' + (dark ? '#d29922' : '#7a5900') + '}',
    '.badge{display:inline-block;padding:2px 8px;border-radius:4px;font-size:9px;font-weight:700}',
    dark ? '.badge-pagado{background:#0f2b19;color:#3fb950;border:1px solid #1b4332}' : '.badge-pagado{background:#dafbe1;color:#166534}',
    dark ? '.badge-mora{background:#2d1117;color:#f85149;border:1px solid #5c1b18}' : '.badge-mora{background:#ffebe9;color:#cf222e}',
    dark ? '.badge-pend{background:#21262d;color:#8b949e;border:1px solid #30363d}' : '.badge-pend{background:#eef1f4;color:#57606a;border:1px solid #d0d7de}',
    dark ? '.footer{text-align:center;margin-top:22px;padding-top:14px;border-top:1px solid #30363d;font-size:10px;color:#6e7681}' :
           '.footer{text-align:center;margin-top:22px;padding-top:14px;border-top:1px solid #ddd;font-size:10px;color:#8c959f}',
    dark ? '@media print{html,body{-webkit-print-color-adjust:exact!important;print-color-adjust:exact!important;color-adjust:exact!important}*{-webkit-print-color-adjust:exact!important;print-color-adjust:exact!important;color-adjust:exact!important}@page{margin:0}html{background:#0d1117!important}body{max-width:none;padding:2cm;font-size:11px;background:#0d1117!important;color:#e6edf3!important;min-height:100vh}}' :
           '@media print{html,body{-webkit-print-color-adjust:exact!important;print-color-adjust:exact!important;color-adjust:exact!important}*{-webkit-print-color-adjust:exact!important;print-color-adjust:exact!important;color-adjust:exact!important}@page{margin:0}html{background:#ffffff!important}body{max-width:none;padding:2cm;font-size:11px;background:#ffffff!important;color:#1f2328!important;min-height:100vh}}',
    '</style></head><body>',
    '<div class="header"><h1>Reporte de Prestamos Activos</h1><p>Fecha de emision: ' + fechaEmision + '</p></div>',
    '<div class="summary"><span><strong>' + rows.length + '</strong> prestamo' + (rows.length === 1 ? '' : 's') + ' activo' + (rows.length === 1 ? '' : 's') + '</span>' +
      '<span><strong>' + countMora + '</strong> en mora</span>' +
      '<span>Total vencido: <strong>' + fmt(totalVencido) + '</strong>' + (totalVencidoUSD > 0 ? ' <span style="color:' + (dark ? '#79c0ff' : '#0969da') + ';font-weight:400">(Incluye ' + fmtUSD(totalVencidoUSD) + ')</span>' : '') + '</span></div>',
    rows.length === 0 ?
      '<div style="text-align:center;padding:36px 0;font-size:12px;color:' + (dark ? '#8b949e' : '#656d76') + '">No hay prestamos activos.</div>' :
      '<table><tr><th>Vencimiento</th><th>Deudor</th><th>Modalidad</th><th>Tasa</th><th style="text-align:center">Cuota</th><th style="text-align:right">Valor cuota</th><th style="text-align:right">Saldo Pendiente</th><th style="text-align:center">Estado</th></tr>' + filasHTML + '</table>',
    '<div style="margin-top:18px;padding:14px 18px;background:' + (dark ? '#0f2b19' : '#f0fdf4') + ';border:1px solid ' + (dark ? '#1b4332' : '#4ade80') + ';border-radius:8px;display:flex;justify-content:space-between;align-items:center">' +
      '<div><div style="font-size:11px;font-weight:700;color:' + (dark ? '#3fb950' : '#166534') + ';text-transform:uppercase;letter-spacing:1px">Capital total en la calle</div>' +
      '<div style="font-size:10px;color:' + (dark ? '#3fb950' : '#166534') + ';margin-top:2px">' + rows.length + ' prestamo' + (rows.length === 1 ? '' : 's') + ' activo' + (rows.length === 1 ? '' : 's') + (countMora > 0 ? ' &middot; ' + countMora + ' en mora' : '') + '</div></div>' +
      '<div style="text-align:right"><div style="font-size:24px;font-weight:700;color:' + (dark ? '#3fb950' : '#166534') + '">' + fmt(totalSaldo) + '</div>' + (totalSaldoUSD > 0 ? '<div style="font-size:12px;font-weight:600;color:' + (dark ? '#79c0ff' : '#0969da') + ';margin-top:2px">Incluye ' + fmtUSD(totalSaldoUSD) + '</div>' : '') + '</div></div>',
    rows.length > 0 ? function() {
      var borde = dark ? '#30363d' : '#eaeef2';
      var txt = dark ? '#8b949e' : '#656d76';
      var rojo = dark ? '#f85149' : '#cf222e';
      var ambar = dark ? '#d29922' : '#7a5900';
      function item(chip, desc) {
        return '<div style="display:flex;gap:9px;align-items:baseline;margin-bottom:4px">' +
          '<span style="flex-shrink:0;width:72px">' + chip + '</span><span>' + desc + '</span></div>';
      }
      var cuad = function(c) { return '<span style="color:' + c + ';font-size:11px">&#9632;</span>'; };
      return '<div style="margin-top:14px;border-top:1px solid ' + borde + ';padding-top:10px;font-size:9px;color:' + txt + '">' +
        '<div style="font-size:9px;font-weight:700;color:' + txt + ';text-transform:uppercase;letter-spacing:.5px;margin-bottom:7px">Referencia de estados</div>' +
        item('<span class="badge badge-pagado">Al dia</span>', 'Sin cuotas vencidas.') +
        item('<span class="badge badge-pend">Pendiente</span>', 'El prestamo tiene mora, pero la fila principal proyecta la proxima cuota (aun no vence); lo vencido se detalla en las sub-filas rojas.') +
        item('<span class="badge badge-mora">En Mora</span>', 'Cronograma vencido por completo (sin ninguna cuota futura pendiente).') +
        item(cuad(rojo), 'Sub-fila roja: cuota vencida, con sus dias de atraso.') +
        item(cuad(ambar), 'Sub-fila ambar: cuota transitoria (interes prorrateado por cambio de fecha), con su fecha real a cobrar.') +
        '</div>';
    }() : '',
    '<div class="footer"><p>Reporte informativo del estado actual de la cartera</p><p style="margin-top:4px">Cartera</p></div>',
    '</body></html>'
  ].join('\n');

  if (window.electronAPI && window.electronAPI.printPDF) {
    var d2 = new Date();
    var fname = 'Reporte Prestamos Activos ' + d2.getFullYear() + '-' + ('0' + (d2.getMonth() + 1)).slice(-2) + '-' + ('0' + d2.getDate()).slice(-2);
    window.electronAPI.printPDF(html, fname);
  } else {
    var w = window.open('', '_blank', 'width=820,height=720');
    w.document.write(html);
    w.document.close();
    w.onload = function() { w.print(); };
  }
}
