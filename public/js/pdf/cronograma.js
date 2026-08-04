// public/js/pdf/cronograma.js — Cronograma de pagos que se entrega al deudor.
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
import { imputarCobros, computeLiquidacion } from '../core/dominio.js';
import { esAbono } from '../core/ids.js';

export function generateCronogramaPDF(loan, payments, darkMode) {
  var esUSD = loan && loan.moneda === 'USD';
  var trm = loan.trmAcordada || 1;
  var fv = esUSD ? function(cop) { return copToUsd(cop, trm); } : fmt;
  // Variante compacta SOLO para las celdas de la tabla del cronograma: en USD omite el
  // prefijo "USD " (la tabla es monomoneda, el prefijo es redundante y roba ~28px por
  // celda). Con 7 columnas en ~640px utiles ese ahorro es lo que evita el desborde.
  var fvT = function(cop) { return fmtDisp(toDisp(cop)); };
  // toDisp/fmtDisp separan el REDONDEO del FORMATO para poder reconciliar el capital en la
  // MONEDA VISIBLE. Redondear cada rubro por separado en USD descuadra la identidad por 1
  // centavo (363.25 + 96.74 = 459.99 != 460.00); reconciliando sobre valores ya redondeados
  // cuadra por construccion. Misma doctrina que moneyCapital en generateFacturaCobro (v1.16.0).
  function toDisp(cop) { return esUSD ? (trm > 0 ? Math.round((cop||0)/trm*100)/100 : 0) : Math.round(cop||0); }
  function fmtDisp(v) { return esUSD ? '$' + new Intl.NumberFormat('en-US',{minimumFractionDigits:2,maximumFractionDigits:2}).format(v||0) : fmt(v); }
  var fechaEmision = new Date().toLocaleDateString('es-CO', {day:'2-digit', month:'long', year:'numeric'});
  var dark = !!darkMode;
  // Todas las cuotas del préstamo
  var allCuotas = payments.filter(function(p) {
    return p.prestamoId === loan.id;
  }).sort(function(a, b) { return a.cuotaN - b.cuotaN; });
  var cuotasAll = allCuotas.filter(function(p) { return !esAbono(p); });
  var abonos = allCuotas.filter(function(p) { return esAbono(p); });
  // Para Intereses: excluir cuotas pendientes (evitar confusión con plazo indefinido)
  var cuotas = loan.modalidad === 'Intereses' ? cuotasAll.filter(function(p) { return p.estadoPago !== 'Pendiente'; }) : cuotasAll;
  var totalPagar = cuotas.reduce(function(s, p) { return s + p.cuotaTotal; }, 0);
  var totalInteres = cuotas.reduce(function(s, p) { return s + p.interesPeriodo; }, 0);
  var totalAbonos = abonos.reduce(function(s, p) { return s + p.abonoCapital; }, 0);
  // Combinar cuotas y abonos (filtrados), ordenar por fecha y luego cuotaN
  var filasBase = cuotas.concat(abonos);
  var filas = filasBase.slice().sort(function(a, b) {
    var cmp = a.fechaPago.localeCompare(b.fechaPago);
    return cmp !== 0 ? cmp : a.cuotaN - b.cuotaN;
  });
  // Pago Unico: la "frecuencia" base (Mensual) confunde -> se fuerza a "Pago Unico"
  var freqLabel = loan.modalidad === 'Pago Unico' ? 'Pago Unico' : (loan.frecuencia === 'Semanal' ? 'Semanal' : loan.frecuencia === 'Quincenal' ? 'Quincenal' : 'Mensual');
  // Fecha de finalizacion = fecha programada de la ultima cuota (Indefinido para modalidad Intereses)
  var fechaFinPrestamo = loan.modalidad === 'Intereses' ? null : (cuotasAll.length ? cuotasAll.reduce(function(mx, p){ return p.fechaPago > mx ? p.fechaPago : mx; }, '') : null);
  // Tasa: Pago Unico imprime la ganancia pactada como % del capital; el resto, su tasa mensual
  var capCOPpdf = esUSD ? Math.round(loan.montoOrigen * trm) : Math.round(loan.montoOrigen);
  var tasaPdfRow;
  if (loan.modalidad === 'Pago Unico') {
    var puPct = (loan.gananciaFija > 0 && capCOPpdf > 0) ? (Math.round(loan.gananciaFija / capCOPpdf * 1000) / 10) : (loan.tasaMensual || 0);
    tasaPdfRow = '<div class="row"><span class="label">Tasa</span><span class="value">' + puPct + '% (ganancia pactada)</span></div>';
  } else {
    tasaPdfRow = loan.tasaMensual > 0 ? '<div class="row"><span class="label">Tasa</span><span class="value">' + loan.tasaMensual + '% mensual</span></div>' : '';
  }
  var html = [
    '<!DOCTYPE html><html><head><meta charset="utf-8"><title>Cronograma de Pagos</title>',
    '<style>',
    '*{margin:0;padding:0;box-sizing:border-box}',
    dark ? 'body{font-family:Arial,sans-serif;padding:30px;max-width:700px;margin:0 auto;color:#e6edf3;background:#0d1117;font-size:12px}' :
           'body{font-family:Arial,sans-serif;padding:30px;max-width:700px;margin:0 auto;color:#1f2328;font-size:12px}',
    dark ? '.header{text-align:center;border-bottom:2px solid #30363d;padding-bottom:14px;margin-bottom:18px}' :
           '.header{text-align:center;border-bottom:2px solid #333;padding-bottom:14px;margin-bottom:18px}',
    '.header h1{font-size:20px;margin-bottom:4px}',
    dark ? '.header p{font-size:11px;color:#8b949e}' : '.header p{font-size:11px;color:#656d76}',
    '.section{margin-bottom:14px}',
    dark ? '.section-title{font-size:10px;font-weight:700;color:#8b949e;letter-spacing:1px;margin-bottom:6px;text-transform:uppercase}' :
           '.section-title{font-size:10px;font-weight:700;color:#656d76;letter-spacing:1px;margin-bottom:6px;text-transform:uppercase}',
    dark ? '.row{display:flex;justify-content:space-between;padding:4px 0;font-size:13px;border-bottom:1px solid #21262d}' :
           '.row{display:flex;justify-content:space-between;padding:4px 0;font-size:13px;border-bottom:1px solid #eee}',
    dark ? '.row .label{color:#8b949e}' : '.row .label{color:#656d76}',
    '.row .value{font-weight:600;text-align:right}',
    'table{width:100%;border-collapse:collapse;margin-top:8px}',
    // Cronograma de 7 columnas en ~640px utiles: el padding lateral baja de 8px a 4px
    // (ahorra ~56px de cromo) y las cabeceras largas ("ABONO A CAPITAL", "VALOR CUOTA")
    // envuelven a dos lineas en vez de ensanchar su columna.
    dark ? 'th{background:#161b22;border:1px solid #30363d;padding:5px 4px;text-align:right;font-size:9px;font-weight:700;color:#8b949e;text-transform:uppercase;line-height:1.2}' :
           'th{background:#f6f8fa;border:1px solid #d0d7de;padding:5px 4px;text-align:right;font-size:9px;font-weight:700;color:#656d76;text-transform:uppercase;line-height:1.2}',
    'th:first-child,td:first-child{text-align:center}',
    // nowrap en los importes: sin el, el espacio duro de fmt() ("$ 3.445.494") parte el
    // simbolo del numero en dos lineas al apretarse la columna.
    dark ? 'td{border:1px solid #30363d;padding:4px 4px;text-align:right;font-size:10px;white-space:nowrap}' :
           'td{border:1px solid #d0d7de;padding:4px 4px;text-align:right;font-size:10px;white-space:nowrap}',
    dark ? 'tr:nth-child(even){background:#161b22}' : 'tr:nth-child(even){background:#f6f8fa}',
    dark ? 'tr.pagado{background:#0f2b19 !important}' : 'tr.pagado{background:#f0fdf4 !important}',
    dark ? 'tr.pagado td{color:#3fb950}' : 'tr.pagado td{color:#166534}',
    dark ? 'tr.mora{background:#2d1117 !important}' : 'tr.mora{background:#fff1f0 !important}',
    dark ? 'tr.mora td{color:#f85149;font-weight:600}' : 'tr.mora td{color:#cf222e;font-weight:600}',
    dark ? 'tr.pendiente td{color:#e6edf3}' : 'tr.pendiente td{color:#1f2328}',
    '.badge{display:inline-block;padding:1px 6px;border-radius:4px;font-size:9px;font-weight:700}',
    dark ? '.badge-pagado{background:#0f2b19;color:#3fb950;border:1px solid #1b4332}' : '.badge-pagado{background:#dafbe1;color:#166534}',
    dark ? '.badge-mora{background:#2d1117;color:#f85149;border:1px solid #5c1b18}' : '.badge-mora{background:#ffebe9;color:#cf222e}',
    dark ? '.badge-pendiente{background:#2b2005;color:#d29922;border:1px solid #3d2e08}' : '.badge-pendiente{background:#fff8c5;color:#9a6700}',
    dark ? '.badge-abono{background:#1d3a6e;color:#79c0ff;border:1px solid #388bfd}' : '.badge-abono{background:#ddf4ff;color:#0969da}',
    dark ? '.badge-parcial{background:#1d3a6e;color:#79c0ff;border:1px solid #388bfd}' : '.badge-parcial{background:#ddf4ff;color:#0969da}',
    dark ? 'tr.abono{background:#131d2e !important}' : 'tr.abono{background:#f0f8ff !important}',
    dark ? 'tr.abono td{color:#79c0ff;font-style:italic}' : 'tr.abono td{color:#0969da;font-style:italic}',
    dark ? '.total-row{background:#0f2b19 !important;font-weight:700}' : '.total-row{background:#f0fdf4 !important;font-weight:700}',
    dark ? '.footer{text-align:center;margin-top:20px;padding-top:14px;border-top:1px solid #30363d;font-size:10px;color:#6e7681}' :
           '.footer{text-align:center;margin-top:20px;padding-top:14px;border-top:1px solid #ddd;font-size:10px;color:#8c959f}',
    dark ? '.nota{margin-top:12px;padding:10px 14px;background:#2b2005;border:1px solid #3d2e08;border-radius:8px;font-size:11px;color:#d29922}' :
           '.nota{margin-top:12px;padding:10px 14px;background:#fff8c5;border:1px solid #d4a72c;border-radius:8px;font-size:11px;color:#7a5900}',
    dark ? '@media print{html,body{-webkit-print-color-adjust:exact!important;print-color-adjust:exact!important;color-adjust:exact!important}*{-webkit-print-color-adjust:exact!important;print-color-adjust:exact!important;color-adjust:exact!important}@page{margin:0}html{background:#0d1117!important}body{max-width:none;padding:2cm;font-size:11px;background:#0d1117!important;color:#e6edf3!important;min-height:100vh}}' :
           '@media print{html,body{-webkit-print-color-adjust:exact!important;print-color-adjust:exact!important;color-adjust:exact!important}*{-webkit-print-color-adjust:exact!important;print-color-adjust:exact!important;color-adjust:exact!important}@page{margin:0}html{background:#ffffff!important}body{max-width:none;padding:2cm;font-size:11px;background:#ffffff!important;color:#1f2328!important;min-height:100vh}}',
    '</style></head><body>',
    '<div class="header">',
    '<h1>Cronograma de Pagos</h1>',
    '<p>Fecha de emision: ' + fechaEmision + '</p>',
    '</div>',
    '<div class="section">',
    '<div class="section-title">Deudor</div>',
    '<div class="row"><span class="label">Nombre</span><span class="value">' + loan.nombre + '</span></div>',
    loan.cedula && loan.cedula !== '0' ? '<div class="row"><span class="label">Cedula / ID</span><span class="value">' + loan.cedula + '</span></div>' : '',
    loan.telefono && loan.telefono !== '0' ? '<div class="row"><span class="label">Telefono</span><span class="value">' + loan.telefono + '</span></div>' : '',
    '</div>',
    '<div class="section">',
    '<div class="section-title">Prestamo</div>',
    '<div class="row"><span class="label">Monto prestado</span><span class="value">' + (esUSD ? fmtUSD(loan.montoOrigen) : fmt(loan.montoOrigen)) + '</span></div>',
    '<div class="row"><span class="label">Modalidad</span><span class="value">' + loan.modalidad + '</span></div>',
    '<div class="row"><span class="label">Frecuencia</span><span class="value">' + freqLabel + '</span></div>',
    tasaPdfRow,
    '<div class="row"><span class="label">Fecha inicio</span><span class="value">' + fmtD(loan.fechaInicio) + '</span></div>',
    '<div class="row"><span class="label">Fecha de finalizacion</span><span class="value">' + (loan.modalidad === 'Intereses' ? 'Indefinido' : (fechaFinPrestamo ? fmtD(fechaFinPrestamo) : '—')) + '</span></div>',
    loan.modalidad !== 'Intereses' ? '<div class="row"><span class="label">Cuotas</span><span class="value">' + cuotas.length + '</span></div>' : '',
    '</div>',
    '<div class="section">',
    '<div class="section-title">Cronograma</div>',
    '<table>',
    '<tr><th>#</th><th>Vence</th><th>Interes</th><th>Abono a capital</th><th>Valor cuota</th><th>Saldo</th><th>Estado</th></tr>',
    filas.map(function(p) {
      var filaEsAbono = esAbono(p);
      var isParcial = !filaEsAbono && (p.partialPaid||0) > 0 && p.estadoPago !== 'Pagado';
      var cls = filaEsAbono ? ' class="abono"' : isParcial ? ' class="mora"' : p.estadoPago === 'Pagado' ? ' class="pagado"' : p.estadoPago === 'En Mora' ? ' class="mora"' : ' class="pendiente"';
      var badge = filaEsAbono ? '<span class="badge badge-abono">Abono</span>' : isParcial ? '<span class="badge badge-mora">'+(p.estadoPago==='En Mora'?'En Mora':'Pendiente')+'</span> <span class="badge badge-parcial">Parcial</span>' : p.estadoPago === 'Pagado' ? '<span class="badge badge-pagado">Pagado</span>' : p.estadoPago === 'En Mora' ? '<span class="badge badge-mora">En Mora</span>' : '<span class="badge badge-pendiente">Pendiente</span>';
      if (filaEsAbono) {
        // Un abono no devenga interes: la columna INTERES va en guion (no "$0", que se
        // confundiria con un interes calculado en cero).
        return '<tr' + cls + '><td>-</td><td style="text-align:left">' + fmtD(p.fechaPago) + '</td><td>&mdash;</td>' +
          '<td><strong>' + fvT(p.abonoCapital) + '</strong></td><td><strong>' + fvT(p.cuotaTotal) + '</strong></td>' +
          '<td>' + fvT(p.saldoFinal) + '</td><td style="text-align:center">' + badge + '</td></tr>';
      }
      // Capital RECONCILIADO (= Valor cuota - Interes), NO p.abonoCapital crudo: en modalidad
      // Prestamo el backend persiste abonoCapital=0 (Bug #2 historico), lo que imprimiria
      // "0 + 0 = 2.300.000" y afirmaria que no se amortizo capital pese a que el saldo cae a
      // cero. Anclado a cuotaTotal, la identidad Interes + Capital = Valor cuota cuadra en las
      // 4 modalidades. La resta va sobre valores YA redondeados a la moneda visible para que
      // en USD tampoco descuadre el centavo (ver nota en toDisp/fmtDisp).
      var intD = toDisp(p.interesPeriodo);
      var cuoD = toDisp(p.cuotaTotal);
      var capD = Math.max(0, Math.round((cuoD - intD) * 100) / 100);
      // VALOR CUOTA es siempre cuotaTotal (el valor pactado de la cuota). En un parcial, lo ya
      // abonado va como sub-linea: si la celda mostrara el remanente, romperia la identidad
      // con las columnas de Interes y Capital, que si suman la cuota completa.
      var cuotaCell = '<strong>' + fmtDisp(cuoD) + '</strong>' +
        (isParcial ? '<br><span style="font-size:9px;opacity:0.75">Abonado ' + fvT(p.partialPaid||0) + '</span>' : '');
      return '<tr' + cls + '><td>' + p.cuotaN + '</td><td style="text-align:left">' + fmtD(p.fechaPago) + '</td>' +
        '<td>' + fmtDisp(intD) + '</td><td>' + fmtDisp(capD) + '</td><td>' + cuotaCell + '</td>' +
        '<td>' + fvT(p.saldoFinal) + '</td><td style="text-align:center">' + badge + '</td></tr>';
    }).join(''),
    // Filas de totales: 7 celdas (antes 6) y cada total alineado BAJO SU columna —
    // los intereses en INTERES (3a) y el capital en ABONO A CAPITAL (4a). Antes todos
    // caian en la 4a celda, que en el layout viejo era la de "Cuota".
    loan.modalidad === 'Intereses' ? function(){var intPagados=cuotas.reduce(function(s,p){return s+imputarCobros(p).totales.interes;},0);return intPagados>0?'<tr class="total-row"><td></td><td style="text-align:left">INTERESES PAGADOS</td><td><strong>'+fvT(intPagados)+'</strong></td><td></td><td></td><td></td><td></td></tr>':'';}() : loan.modalidad === 'Capital + Intereses' ? function(){var capPagado=cuotas.reduce(function(s,p){return s+imputarCobros(p).totales.capital;},0);return capPagado>0?'<tr class="total-row"><td></td><td style="text-align:left">CAPITAL PAGADO</td><td></td><td><strong>'+fvT(capPagado)+'</strong></td><td></td><td></td><td></td></tr>':'';}() : '',
    totalAbonos > 0 ? '<tr class="total-row" style="background:' + (dark ? '#131d2e' : '#ddf4ff') + ' !important;color:' + (dark ? '#79c0ff' : '#0969da') + '"><td></td><td style="text-align:left">ABONOS</td><td></td><td><strong>' + fvT(totalAbonos) + '</strong></td><td></td><td></td><td></td></tr>' : '',
    '</table>',
    loan.modalidad === 'Intereses' ? '<div class="nota"><strong>Nota:</strong> Este prestamo es de plazo indefinido. Solo se muestran las cuotas generadas hasta la fecha. Los pagos de intereses continuaran hasta que el capital sea devuelto en su totalidad, ya sea al final del acuerdo o mediante abonos a capital.</div>' : '',
    function(){
      // v1.19.0 — valor de liquidacion desde el helper centralizado (misma cifra que el modal).
      var L = computeLiquidacion(loan, payments, {});
      if(L.capitalPendiente <= 0) return '';
      var mesTxt = fv(L.moraValorMes) + '/mes' + (L.moraUniforme ? '' : ' prom.');
      var detalle = 'Capital ' + fv(L.capitalPendiente) +
        (L.intMora > 0 ? ' + mora ' + fv(L.intMora) + ' (' + L.moraCount + ' cuota' + (L.moraCount>1?'s':'') + ' a ' + mesTxt + ')' : '') +
        (L.partialPend > 0 ? ' &minus; parciales ' + fv(L.partialPend) : '');
      var bg = dark ? '#2b2005' : '#fff8c5';
      var bd = dark ? '#3d2e08' : '#d4a72c';
      var cl = dark ? '#d29922' : '#7a5900';
      return '<div style="margin-top:14px;padding:12px 16px;background:'+bg+';border:1px solid '+bd+';border-radius:8px;display:flex;justify-content:space-between;align-items:center;gap:12px">' +
        '<div><div style="font-size:10px;font-weight:700;color:'+cl+';text-transform:uppercase;letter-spacing:1px">Valor de liquidacion</div>' +
        '<div style="font-size:10px;color:'+cl+';margin-top:2px">' + detalle + '</div></div>' +
        '<div style="font-size:20px;font-weight:700;color:'+cl+';white-space:nowrap">' + fv(L.total) + '</div></div>';
    }(),
    '</div>',
    '<div class="footer">',
    '<p>Este cronograma es informativo y puede variar por abonos a capital</p>',
    '<p style="margin-top:4px">Cartera</p>',
    '</div>',
    '</body></html>'
  ].join('\n');
  if (window.electronAPI && window.electronAPI.printPDF) {
    var fname = 'Cronograma ' + fmt(loan.montoOrigen) + ' - ' + loan.nombre;
    window.electronAPI.printPDF(html, fname);
  } else {
    var w = window.open('', '_blank', 'width=750,height=700');
    w.document.write(html);
    w.document.close();
    w.onload = function() { w.print(); };
  }
}
