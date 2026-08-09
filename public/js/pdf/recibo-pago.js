// public/js/pdf/recibo-pago.js — Comprobante de un pago YA registrado.
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
import { nowStr } from '../core/ui.js';
import { saldoConCaja, pendienteDeCuota } from '../core/dominio.js';
import { esAbono } from '../core/ids.js';

export function generateRecibo(pay, loan, copRec, usdRec, allPays, opts) {
  opts = opts || {};
  var dark = document.documentElement.getAttribute('data-theme') === 'dark';
  var esUSD = loan && loan.moneda === 'USD';
  var montoRecibido = copRec || pay.cuotaTotal;
  // Fase 3 — imputacion de ESTE pago y saldo resultante.
  // OJO: el recibo se emite ANTES de persistir, asi que `allPays` es el estado PREVIO y el ledger
  // aun no contiene este evento. Por eso se parte de lo que la cuota debia (pendienteDeCuota) y se
  // aplica la cascada al monto recibido, en vez de leer el ledger.
  // CAJA vs OBLIGACION: en un prestamo USD la deuda esta denominada en dolares, asi que lo
  // que este pago extingue se valua a la TRM PACTADA (usdRec * trm), no a los pesos que
  // entraron a la TRM del dia. Cascadear la caja hacia interes/capital hacia que el recibo
  // declarara menos de lo que el cliente realmente abono — el mismo defecto que /partial
  // tenia al escribir `partialPaid` (misma doctrina que /abono desde v2.0.0, Bug #37).
  // La diferencia entre ambas es efecto cambiario y NO es deuda viva.
  var obligRecibida = (esUSD && loan && loan.trmAcordada > 0 && (+usdRec || 0) > 0)
    ? Math.round((+usdRec) * loan.trmAcordada)
    : Math.round(montoRecibido);
  var _pendR = pendienteDeCuota(pay);
  var _iR = Math.min(obligRecibida, _pendR.interes);
  var impPago = { interes: _iR, capital: Math.min(obligRecibida - _iR, _pendR.capital) };
  // Saldo DESPUES del pago = saldo con caja aplicada (previo) menos el capital que este pago cubre.
  // Antes se imprimia `pay.saldoFinal`, el cierre PROYECTADO del cronograma: una TERCERA definicion
  // de saldo, que no coincidia ni con la app ni con los demas PDFs.
  var saldoRestante = loan ? Math.max(0, saldoConCaja(loan, allPays) - impPago.capital) : pay.saldoFinal;
  var yaAbonadoPrev = opts.yaAbonadoPrev || 0;
  // `yaAbonadoPrev` viene de partialPaid, que ya esta valuado en obligacion: se le suma la
  // obligacion de este pago, no la caja, o el "restante" volveria a mentir en USD.
  var totalAcum = yaAbonadoPrev + obligRecibida;
  // v1.12.x FIX (recibo bimonetario): en prestamos USD, si el USD recibido cubre la cuota en USD
  // (cuotaTotal/trmAcordada), el pago NO es parcial aunque los COP sean menores por la baja de la
  // TRM. Espeja la logica del backend para que el recibo no marque "Abono parcial" por error.
  var cubreEnUSD = esUSD && (loan.trmAcordada > 0) && (+usdRec || 0) >= Math.round((pay.cuotaTotal / loan.trmAcordada) * 100) / 100 - 0.005;
  var esParcial = totalAcum < pay.cuotaTotal && !cubreEnUSD;
  var completaCuota = !esParcial && yaAbonadoPrev > 0;
  var tipoTitulo = esParcial ? 'Recibo de Abono Parcial' : completaCuota ? 'Recibo Final de Cuota' : 'Recibo de Pago';
  var tipoEtiqueta = esParcial ? 'Abono parcial a cuota' : completaCuota ? 'Pago final (completa cuota)' : 'Pago completo';
  var restanteTrasEste = Math.max(0, pay.cuotaTotal - totalAcum);
  var fechaEmision = new Date().toLocaleDateString('es-CO', {day:'2-digit', month:'long', year:'numeric'});
  // Próximas cuotas (solo para Capital + Intereses y si hay pays disponibles)
  var allProxCuotas = [];
  var proxCuotas = [];
  var totalPending = 0;
  if (allPays && loan.modalidad === 'Capital + Intereses' && saldoRestante > 0) {
    allProxCuotas = allPays.filter(function(p) {
      return p.prestamoId === loan.id && p.estadoPago === 'Pendiente' && !esAbono(p) && p.cuotaN > pay.cuotaN;
    }).sort(function(a, b) { return a.cuotaN - b.cuotaN; });
    totalPending = allProxCuotas.length;
    proxCuotas = allProxCuotas.slice(0, 3);
  }
  var trm = loan.trmAcordada || 1;
  // Para USD: mostrar solo dolares; para COP: mostrar pesos
  var fv = esUSD ? function(cop) { return copToUsd(cop, trm); } : fmt;
  // ¿Este pago liquida el prestamo? = pago completo (no parcial), modalidad con fin definido (no Intereses)
  // y no queda NINGUNA otra cuota regular sin pagar. allPays es snapshot pre-pago: excluimos este pay y miramos el resto.
  var otrasRegPend = Array.isArray(allPays) ? allPays.filter(function(p){
    return p.prestamoId === loan.id && !esAbono(p) && p.id !== pay.id && p.estadoPago !== 'Pagado';
  }) : null;
  var esLiquidacion = !esParcial && loan.modalidad !== 'Intereses' && otrasRegPend !== null && otrasRegPend.length === 0;
  // Banner dinamico: liquidacion (prioridad absoluta) > puntualidad. Compara la fecha REAL de cobro
  // (la elegida en el form, fallback fechaRecaudo/hoy) contra la fechaPago esperada, ambas ancladas a
  // mediodia local para evitar desfases por zona horaria. La puntualidad solo aplica a pagos COMPLETOS
  // (no parciales, no abonos a capital).
  var fechaRealPago = opts.fechaRecaudo || pay.fechaRecaudo || nowStr();
  var diasRetraso = (pay.fechaPago && fechaRealPago && !esAbono(pay))
    ? Math.round((new Date(fechaRealPago + 'T12:00:00') - new Date(pay.fechaPago + 'T12:00:00')) / 86400000) : 0;
  function bannerBox(bg, bd, tx, titulo, sub) {
    return '<div style="margin:16px 0;padding:14px 16px;background:' + bg + ';border:1px solid ' + bd + ';border-radius:8px;text-align:center">' +
      '<div style="font-size:15px;font-weight:700;color:' + tx + '">' + titulo + '</div>' +
      '<div style="font-size:11px;color:' + tx + ';margin-top:3px">' + sub + '</div></div>';
  }
  var bannerHTML = '';
  if (esLiquidacion) {
    bannerHTML = bannerBox(dark ? '#0f2b19' : '#dafbe1', dark ? '#1b4332' : '#aceebb', dark ? '#3fb950' : '#166534',
      '¡Felicidades! Ha cancelado la totalidad de su prestamo',
      'Con este pago se salda el 100% del prestamo. ¡Gracias por tu cumplimiento!');
  } else if (!esParcial && pay.fechaPago && !esAbono(pay)) {
    if (diasRetraso > 0) {
      bannerHTML = bannerBox(dark ? '#2d2410' : '#fff8c5', dark ? '#3d3115' : '#eac54f', dark ? '#d29922' : '#9a6700',
        'Pago recibido con ' + diasRetraso + ' ' + (diasRetraso === 1 ? 'dia' : 'dias') + ' de retraso',
        'Procura pagar a tiempo para evitar inconvenientes.');
    } else {
      bannerHTML = bannerBox(dark ? '#0d2440' : '#ddf4ff', dark ? '#1f3a5f' : '#b6e3ff', dark ? '#58a6ff' : '#0969da',
        diasRetraso < 0 ? '¡Gracias por tu pago anticipado!' : '¡Gracias por tu pago puntual!',
        diasRetraso < 0 ? 'Recibimos tu pago antes de la fecha acordada. ¡Excelente!' : 'Recibimos tu pago en la fecha acordada. ¡Gracias por tu cumplimiento!');
    }
  }
  var html = [
    '<!DOCTYPE html><html><head><meta charset="utf-8"><title>Recibo de Pago</title>',
    '<style>',
    '*{margin:0;padding:0;box-sizing:border-box}',
    dark ? 'body{font-family:Arial,sans-serif;padding:30px;max-width:500px;margin:0 auto;color:#e6edf3;background:#0d1117}' :
           'body{font-family:Arial,sans-serif;padding:30px;max-width:500px;margin:0 auto;color:#1f2328}',
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
    dark ? '.total-box{background:#0f2b19;border:1px solid #1b4332;border-radius:8px;padding:14px;text-align:center;margin:16px 0}' :
           '.total-box{background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:14px;text-align:center;margin:16px 0}',
    dark ? '.total-box .amount{font-size:24px;font-weight:700;color:#3fb950}' :
           '.total-box .amount{font-size:24px;font-weight:700;color:#166534}',
    dark ? '.total-box .sub{font-size:12px;color:#3fb950;margin-top:2px}' :
           '.total-box .sub{font-size:12px;color:#166534;margin-top:2px}',
    dark ? '.footer{text-align:center;margin-top:20px;padding-top:14px;border-top:1px solid #30363d;font-size:10px;color:#6e7681}' :
           '.footer{text-align:center;margin-top:20px;padding-top:14px;border-top:1px solid #ddd;font-size:10px;color:#8c959f}',
    dark ? '@media print{html,body{-webkit-print-color-adjust:exact!important;print-color-adjust:exact!important;color-adjust:exact!important}*{-webkit-print-color-adjust:exact!important;print-color-adjust:exact!important;color-adjust:exact!important}@page{margin:0}html{background:#0d1117!important}body{max-width:none;padding:2cm;background:#0d1117!important;color:#e6edf3!important;min-height:100vh}}' :
           '@media print{html,body{-webkit-print-color-adjust:exact!important;print-color-adjust:exact!important;color-adjust:exact!important}*{-webkit-print-color-adjust:exact!important;print-color-adjust:exact!important;color-adjust:exact!important}@page{margin:0}html{background:#ffffff!important}body{max-width:none;padding:2cm;background:#ffffff!important;color:#1f2328!important;min-height:100vh}}',
    '</style></head><body>',
    '<div class="header">',
    '<h1>' + tipoTitulo + '</h1>',
    '<p>Fecha de emision: ' + fechaEmision + '</p>',
    '</div>',
    '<div class="section">',
    '<div class="section-title">Deudor</div>',
    '<div class="row"><span class="label">Nombre</span><span class="value">' + pay.nombreCliente + '</span></div>',
    loan.cedula ? '<div class="row"><span class="label">Cedula / ID</span><span class="value">' + loan.cedula + '</span></div>' : '',
    loan.telefono ? '<div class="row"><span class="label">Telefono</span><span class="value">' + loan.telefono + '</span></div>' : '',
    '</div>',
    '<div class="section">',
    '<div class="section-title">Prestamo</div>',
    '<div class="row"><span class="label">Modalidad</span><span class="value">' + loan.modalidad + '</span></div>',
    '<div class="row"><span class="label">Monto original</span><span class="value">' + (esUSD ? fmtUSD(loan.montoOrigen) : fmt(loan.montoOrigen)) + '</span></div>',
    loan.tasaMensual > 0 ? '<div class="row"><span class="label">Tasa mensual</span><span class="value">' + loan.tasaMensual + '%</span></div>' : '',
    '</div>',
    '<div class="section">',
    '<div class="section-title">Detalle del pago</div>',
    '<div class="row"><span class="label">Tipo</span><span class="value">' + tipoEtiqueta + '</span></div>',
    '<div class="row"><span class="label">Cuota</span><span class="value">#' + pay.cuotaN + ((pay && pay.extraConsolidado && pay.extraConsolidado !== 0) ? ' <span style="color:' + (dark ? '#d29922' : '#9a6700') + ';font-weight:700">(Cuota Transitoria / Interes Prorrateado)</span>' : '') + '</span></div>',
    '<div class="row"><span class="label">Fecha vencimiento</span><span class="value">' + fmtD(pay.fechaPago) + '</span></div>',
    '<div class="row"><span class="label">Fecha recaudo</span><span class="value">' + fmtD(opts.fechaRecaudo || pay.fechaRecaudo || nowStr()) + '</span></div>',
    // Fase 3: se imputa ESTE pago (cascada interes -> capital), no la composicion nominal de la
    // cuota. Antes, en un pago PARCIAL las dos filas se suprimian —el deudor no sabia a que fue su
    // dinero— y en el pago que cerraba la cuota se imprimian los rubros COMPLETOS, de modo que el
    // recibo del remanente de $50.000 declaraba $227.574 de interes + $222.426 de capital.
    impPago.interes > 0 ? '<div class="row"><span class="label">Intereses</span><span class="value">' + fv(impPago.interes) + '</span></div>' : '',
    impPago.capital > 0 ? '<div class="row"><span class="label">Abono a capital</span><span class="value">' + fv(impPago.capital) + '</span></div>' : '',
    '<div class="row"><span class="label">Monto cuota</span><span class="value">' + fv(pay.cuotaTotal) + '</span></div>',
    yaAbonadoPrev > 0 ? '<div class="row"><span class="label">Abonado previamente</span><span class="value">' + fv(yaAbonadoPrev) + '</span></div>' : '',
    '</div>',
    '<div class="total-box">',
    '<div style="font-size:10px;color:' + (dark ? '#8b949e' : '#656d76') + ';margin-bottom:4px">' + (esParcial ? 'ABONO RECIBIDO' : 'MONTO RECIBIDO') + '</div>',
    '<div class="amount">' + (esUSD && usdRec ? fmtUSD(usdRec) : fv(montoRecibido)) + '</div>',
    esUSD && usdRec ? '<div class="sub">' + fmt(montoRecibido) + ' COP</div>' : '',
    '</div>',
    bannerHTML,
    esParcial ? '<div class="section"><div class="section-title">Estado de la cuota</div>' +
      '<div class="row"><span class="label">Total cuota</span><span class="value">' + fv(pay.cuotaTotal) + '</span></div>' +
      '<div class="row"><span class="label">Total abonado (con este pago)</span><span class="value">' + fv(totalAcum) + '</span></div>' +
      '<div class="row"><span class="label">Restante por pagar</span><span class="value" style="color:' + (dark?'#d29922':'#9a6700') + '">' + fv(restanteTrasEste) + '</span></div>' +
      '</div>' : '',
    '<div class="section">',
    !esParcial ? '<div class="row"><span class="label">Saldo restante del prestamo</span><span class="value">' + fv(saldoRestante) + '</span></div>' : '',
    pay.observaciones ? '<div class="row"><span class="label">Observaciones</span><span class="value">' + pay.observaciones + '</span></div>' : '',
    '</div>',
    proxCuotas.length > 0 ? '<div class="section"><div class="section-title">Proximas cuotas (quedan ' + totalPending + ' de ' + loan.plazoMeses + ')</div>' + proxCuotas.map(function(pc) {
      return '<div class="row"><span class="label">Cuota #' + pc.cuotaN + ' - ' + fmtD(pc.fechaPago) + '</span><span class="value">' + fv(pc.cuotaTotal) + '</span></div>';
    }).join('') + (totalPending > 3 ? '<div style="text-align:center;color:var(--text2,#888);font-size:11px;margin-top:6px">... y ' + (totalPending - 3) + ' cuotas mas</div>' : '') + '</div>' : '',
    '<div class="footer">',
    '<p>Este recibo es un comprobante de pago</p>',
    '<p style="margin-top:4px">Cartera</p>',
    '</div>',
    '</body></html>'
  ].join('\n');
  if (window.electronAPI && window.electronAPI.printPDF) {
    var montoTxt = loan.moneda === 'USD'
      ? 'USD $' + Math.round(loan.montoOrigen).toLocaleString('es-CO')
      : '$' + Math.round(loan.montoOrigen).toLocaleString('es-CO');
    var fname = 'Recibo Préstamo ' + montoTxt + ' - ' + pay.nombreCliente + ' - Cuota ' + pay.cuotaN;
    window.electronAPI.printPDF(html, fname);
  } else {
    var w = window.open('', '_blank', 'width=550,height=700');
    w.document.write(html);
    w.document.close();
    w.onload = function() { w.print(); };
  }
}
