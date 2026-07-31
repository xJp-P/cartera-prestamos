// public/js/pdf/factura-cobro.js — Documento PROSPECTIVO de cobranza (antes de pagar).
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
import { nowStr, facturaCode } from '../core/ui.js';
import { saldoConCaja, pendienteDeCuota } from '../core/dominio.js';

// ── Recibo de Cobro / Factura (v1.16.0) ──────────────────────────────────────
// Documento PROSPECTIVO (antes de pagar) para gestion de cartera. Distinto de
// generateRecibo (que confirma un pago ya hecho). Reusa el pipeline printPDF.
export function generateFacturaCobro(pay, loan, allPays, datosPago, opts) {
  opts = opts || {};
  if (!loan) return;
  var dark = document.documentElement.getAttribute('data-theme') === 'dark';
  var esUSD = loan.moneda === 'USD';
  var trm = loan.trmAcordada || 1;
  var hoyStr = nowStr();
  // Estado por FECHA (TZ-safe, mediodia): >0 mora, ===0 hoy, <0 proxima
  var dr = Math.round((new Date(hoyStr + 'T12:00:00') - new Date(pay.fechaPago + 'T12:00:00')) / 86400000);
  var fcCode = facturaCode(pay);
  var fechaEmision = new Date().toLocaleDateString('es-CO', {day:'2-digit', month:'long', year:'numeric'});
  function esc(s){ return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

  // Saldo del prestamo (formula canonica: originalCOP - capital de cuotas Pagadas)
  var originalCOP = esUSD ? Math.round(loan.montoOrigen * trm) : Math.round(loan.montoOrigen);
  // Fase 3: saldo CON CAJA APLICADA. Antes filtraba por estadoPago==='Pagado', asi que el capital
  // ya cubierto por un parcial era invisible: el papel que recibia el cliente imprimia un saldo
  // clavado mientras su propio perfil en la app ya mostraba otro (medido: $172.426 de diferencia).
  var saldoPrestamo = saldoConCaja(loan, allPays);

  var yaPag = +pay.partialPaid || 0;
  var aPagar = yaPag > 0 ? Math.max(0, pay.cuotaTotal - yaPag) : pay.cuotaTotal;
  // Rubros que aun se deben, tras imputar lo ya abonado en cascada interes -> capital.
  var pend = pendienteDeCuota(pay);
  // USD: el cliente paga DOLARES, asi que lo pendiente se mide en dolares contra los dolares ya
  // entregados (montoUSDRecibido). Reconvertir los COP abonados a TRM pactada exigia de mas cuando
  // la TRM del dia fue menor: con USD 200 entregados de una cuota de USD 400 el documento pedia
  // USD 227.19. Es la doctrina del Bug #23, que el backend ya aplica al dar la cuota por saldada
  // comparando USD contra USD (server.js, rama `completaUSD` de /partial).
  var usdRec = +pay.montoUSDRecibido || 0;
  var pendUSD = (esUSD && usdRec > 0) ? Math.max(0, Math.round((pay.cuotaTotal / trm - usdRec) * 100) / 100) : null;
  function moneyPend(){ return pendUSD !== null ? fmtUSD(pendUSD) : money(aPagar); }
  function moneyYaPag(){ return (esUSD && usdRec > 0) ? fmtUSD(usdRec) : money(yaPag); }
  // Cuota transitoria (v1.14.0): interes prorrateado por cambio de dia de pago
  var esTransitoria = !!(pay.extraConsolidado && pay.extraConsolidado !== 0);

  var C = dark ? {
    bg:'#0d1117', text:'#e6edf3', muted:'#8b949e', bd:'#30363d', rowbd:'#21262d', panel:'#161b22',
    green:'#3fb950', greenBg:'#0f2b19', greenBd:'#1b4332', blue:'#79c0ff',
    amber:'#d29922', amberBg:'#2b2005', amberBd:'#3d2e08', headBd:'#30363d', foot:'#6e7681', footBd:'#30363d'
  } : {
    bg:'#ffffff', text:'#1f2328', muted:'#656d76', bd:'#d0d7de', rowbd:'#eeeeee', panel:'#f6f8fa',
    green:'#166534', greenBg:'#f0fdf4', greenBd:'#4ade80', blue:'#0969da',
    amber:'#9a6700', amberBg:'#fff8e1', amberBd:'#eac54f', headBd:'#333333', foot:'#8c959f', footBd:'#dddddd'
  };
  var heroC = dr > 0 ? { ac: dark ? '#f85149' : '#cf222e', bg: dark ? '#2d1117' : '#fff1f0', bd: dark ? '#5c1b18' : '#cf222e' }
            : dr === 0 ? { ac: C.amber, bg: C.amberBg, bd: C.amberBd }
            : { ac: C.blue, bg: dark ? '#0d2440' : '#ddf4ff', bd: dark ? '#1f3a5f' : '#b6e3ff' };

  var heroLabel, heroBig, heroMsg;
  if (dr > 0) {
    heroLabel = 'Aviso de mora';
    heroBig = '<div class="rc-hero-days">' + dr + '<span>' + (dr === 1 ? 'dia' : 'dias') + '</span></div>';
    heroMsg = 'Estas atrasado <b>' + dr + ' ' + (dr === 1 ? 'dia' : 'dias') + '</b> con el pago de esta cuota.';
  } else if (dr === 0) {
    heroLabel = 'Recordatorio';
    heroBig = '<div class="rc-hero-days" style="font-size:28px;letter-spacing:0">HOY</div>';
    heroMsg = '<b>Hoy</b> es el dia de pago de tu cuota.';
  } else {
    var faltan = -dr;
    heroLabel = 'Aviso de proximo vencimiento';
    heroBig = '<div class="rc-hero-days">' + faltan + '<span>' + (faltan === 1 ? 'dia' : 'dias') + '</span></div>';
    heroMsg = 'Tu cuota vence en <b>' + faltan + ' ' + (faltan === 1 ? 'dia' : 'dias') + '</b>.';
  }
  // Proxima accion: exige el pago para la FECHA DE VENCIMIENTO REAL (sin dias de gracia)
  var proxAccion = dr > 0
    ? '<b>Accion requerida:</b> el plazo de pago vencio el <b>' + fmtD(pay.fechaPago) + '</b>. Regulariza esta cuota de inmediato para evitar mayores intereses de mora.'
    : dr === 0
    ? '<b>Accion requerida:</b> el pago de esta cuota vence <b>hoy, ' + fmtD(pay.fechaPago) + '</b>. Realiza el pago durante el dia.'
    : '<b>Proxima accion:</b> ten lista esta cuota para su pago a mas tardar el <b>' + fmtD(pay.fechaPago) + '</b>.';

  // En prestamos USD el cliente paga en dolares -> el USD es la moneda protagonista y UNICA del
  // recibo (sin la doble fila COP+USD que duplicaba el alto de la columna). En COP se muestra COP.
  function money(cop){ return esUSD ? copToUsd(cop, trm) : fmt(cop); }
  function rowHTML(label, cop){ return '<div class="rc-row"><span class="rc-lab">' + label + '</span><span class="rc-val">' + money(cop) + '</span></div>'; }
  // Capital mostrado = Valor cuota - Interes (en la moneda visible) para que Interes + Capital cuadre
  // EXACTO con el total (en USD, redondear cada rubro por separado descuadraba 1 centavo).
  // Se ancla a lo PENDIENTE (aPagar / pend.interes), no a la cuota nominal, para que
  // Interes + Capital siga sumando EXACTO el total exigido cuando hay un parcial en curso.
  function moneyCapital(){
    if (esUSD) { var t = pendUSD !== null ? pendUSD : Math.round(aPagar / trm * 100) / 100, i = Math.round(pend.interes / trm * 100) / 100; return fmtUSD(t - i); }
    return fmt(aPagar - pend.interes);
  }

  var comoPagar = (datosPago && String(datosPago).trim())
    ? '<div class="rc-stitle">Como pagar</div><div class="rc-panel"><div class="rc-pay-body">' + esc(datosPago).replace(/\n/g, '<br>') + '</div></div>'
    : '';
  // Cedula/telefono validos: descarta vacio, null/undefined y el placeholder "0" (evita "C.C. 0").
  // Si ambos son invalidos, deudorMeta queda '' y la linea de contacto no se renderiza.
  function campoValido(v){ v = String(v == null ? '' : v).trim(); return v !== '' && v !== '0'; }
  var deudorMeta = [ campoValido(loan.cedula) ? ('C.C. ' + esc(String(loan.cedula).trim())) : '', campoValido(loan.telefono) ? ('Tel. ' + esc(String(loan.telefono).trim())) : '' ].filter(Boolean).join(' &nbsp;&middot;&nbsp; ');

  var html = [
    '<!DOCTYPE html><html><head><meta charset="utf-8"><title>Recibo de Cobro</title>',
    '<style>',
    '*{margin:0;padding:0;box-sizing:border-box}',
    'body{font-family:Arial,Helvetica,sans-serif;padding:22px;max-width:520px;margin:0 auto;color:' + C.text + ';background:' + C.bg + ';line-height:1.3}',
    '.rc-head{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;padding-bottom:10px;border-bottom:2px solid ' + C.headBd + '}',
    '.rc-brand{display:flex;align-items:center;gap:10px}',
    '.rc-wordmark{font-size:19px;font-weight:700;letter-spacing:.3px;color:' + C.text + ';line-height:1.1}',
    '.rc-brand-sub{font-size:10px;color:' + C.muted + ';letter-spacing:.4px;margin-top:2px}',
    '.rc-meta{text-align:right}',
    '.rc-doc-type{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:' + C.muted + '}',
    '.rc-doc-num{font-size:15px;font-weight:700;color:' + C.text + ';margin-top:3px}',
    '.rc-doc-date{font-size:11px;color:' + C.muted + ';margin-top:3px}',
    '.rc-hero{position:relative;margin:12px 0 4px;padding:11px 16px 11px 18px;background:' + heroC.bg + ';border:1px solid ' + heroC.bd + ';border-radius:12px;overflow:hidden}',
    '.rc-hero:before{content:"";position:absolute;left:0;top:0;bottom:0;width:6px;background:' + heroC.ac + '}',
    '.rc-hero-top{display:flex;align-items:center;gap:8px}',
    '.rc-hero-dot{width:8px;height:8px;border-radius:50%;background:' + heroC.ac + ';display:inline-block}',
    '.rc-hero-label{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:1.4px;color:' + heroC.ac + '}',
    '.rc-hero-body{display:flex;align-items:baseline;gap:10px;margin-top:5px;flex-wrap:wrap}',
    '.rc-hero-days{font-size:38px;font-weight:700;color:' + heroC.ac + ';line-height:.95;letter-spacing:-1px}',
    '.rc-hero-days span{font-size:13px;font-weight:700;letter-spacing:.3px;margin-left:4px}',
    '.rc-hero-msg{font-size:13px;color:' + C.text + ';flex:1 1 180px;min-width:170px}',
    '.rc-hero-msg b{color:' + heroC.ac + '}',
    '.rc-stitle{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:' + C.muted + ';margin:13px 0 5px}',
    '.rc-deudor-name{font-size:17px;font-weight:700;color:' + C.text + '}',
    '.rc-deudor-meta{font-size:12px;color:' + C.muted + ';margin-top:3px}',
    '.rc-total{margin:12px 0 4px;padding:13px;text-align:center;background:' + C.greenBg + ';border:2px solid ' + C.greenBd + ';border-radius:14px}',
    '.rc-total-label{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:2px;color:' + C.green + '}',
    '.rc-total-amt{font-size:32px;font-weight:700;color:' + C.green + ';line-height:1.05;margin:3px 0 0;letter-spacing:-1px}',
    '.rc-total-chip{display:inline-block;background:' + C.bg + ';border:1px solid ' + C.greenBd + ';color:' + C.green + ';border-radius:20px;padding:4px 14px;font-size:11px;font-weight:700}',
    '.rc-total-sub{font-size:11px;color:' + C.muted + ';margin-top:5px}',
    '.rc-total-dates{display:flex;gap:8px;margin-top:9px}',
    '.rc-tdate{flex:1;background:' + C.bg + ';border:1px solid ' + C.bd + ';border-radius:8px;padding:6px 6px;text-align:center}',
    '.rc-tdate-lab{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.6px;color:' + C.muted + '}',
    '.rc-tdate-val{font-size:13px;font-weight:700;color:' + C.text + ';margin-top:3px}',
    '.rc-usd{font-size:10px;color:' + C.blue + ';font-weight:600}',
    '.rc-row{display:flex;justify-content:space-between;align-items:baseline;padding:4px 0;border-bottom:1px solid ' + C.rowbd + '}',
    '.rc-row:last-child{border-bottom:none}',
    '.rc-lab{font-size:12px;color:' + C.muted + '}',
    '.rc-val{font-size:13px;font-weight:600;color:' + C.text + ';text-align:right}',
    '.rc-row-tot{padding-top:6px;margin-top:2px;border-top:1px solid ' + C.bd + '}',
    '.rc-row-tot .rc-lab{font-weight:700;color:' + C.text + '}',
    '.rc-row-tot .rc-val{color:' + C.green + ';font-size:15px;font-weight:700}',
    '.rc-panel{background:' + C.panel + ';border:1px solid ' + C.bd + ';border-radius:10px;padding:8px 14px;margin-top:6px}',
    '.rc-pay-body{font-size:12px;color:' + C.text + ';line-height:1.35;padding:2px 0}',
    '.rc-pay-ref{font-size:11px;color:' + C.muted + ';margin-top:6px;padding-top:6px;border-top:1px solid ' + C.rowbd + '}',
    '.rc-pay-ref b{color:' + C.green + '}',
    '.rc-next{margin-top:9px;padding:9px 14px;background:' + C.amberBg + ';border:1px solid ' + C.amberBd + ';border-radius:10px}',
    '.rc-next-txt{font-size:11.5px;line-height:1.4;color:' + C.amber + '}',
    '.rc-next-txt b{color:' + C.amber + ';font-weight:700}',
    '.rc-foot{margin-top:14px;padding-top:10px;border-top:1px solid ' + C.footBd + ';text-align:center;color:' + C.foot + ';font-size:10.5px;line-height:1.5}',
    '.rc-foot b{color:' + C.green + '}',
    dark ? '@media print{html,body{-webkit-print-color-adjust:exact!important;print-color-adjust:exact!important;color-adjust:exact!important}*{-webkit-print-color-adjust:exact!important;print-color-adjust:exact!important;color-adjust:exact!important}@page{margin:0}html{background:#0d1117!important}body{max-width:none;padding:1.3cm;background:#0d1117!important;color:#e6edf3!important;min-height:100vh}}'
         : '@media print{html,body{-webkit-print-color-adjust:exact!important;print-color-adjust:exact!important;color-adjust:exact!important}*{-webkit-print-color-adjust:exact!important;print-color-adjust:exact!important;color-adjust:exact!important}@page{margin:0}html{background:#ffffff!important}body{max-width:none;padding:1.3cm;background:#ffffff!important;color:#1f2328!important;min-height:100vh}}',
    '</style></head><body>',
    '<div class="rc-head"><div class="rc-brand">',
    '<svg width="36" height="36" viewBox="0 0 36 36" xmlns="http://www.w3.org/2000/svg"><rect width="36" height="36" rx="9" fill="' + C.green + '"/><text x="18" y="25" font-family="Arial,sans-serif" font-size="21" font-weight="700" fill="#ffffff" text-anchor="middle">C</text></svg>',
    '<div><div class="rc-wordmark">Cartera</div><div class="rc-brand-sub">Gestion de cartera de credito</div></div></div>',
    '<div class="rc-meta"><div class="rc-doc-type">Factura de Cobro</div><div class="rc-doc-num">' + fcCode + '</div><div class="rc-doc-date">Emision: ' + fechaEmision + '</div></div></div>',
    '<div class="rc-hero"><div class="rc-hero-top"><span class="rc-hero-dot"></span><span class="rc-hero-label">' + heroLabel + '</span></div>',
    '<div class="rc-hero-body">' + heroBig + '<div class="rc-hero-msg">' + heroMsg + '</div></div></div>',
    '<div class="rc-stitle">Cobro dirigido a</div>',
    '<div><div class="rc-deudor-name">' + esc(pay.nombreCliente) + '</div>' + (deudorMeta ? '<div class="rc-deudor-meta">' + deudorMeta + '</div>' : '') + '</div>',
    '<div class="rc-total"><div class="rc-total-label">Total a pagar</div>',
    '<div class="rc-total-amt">' + moneyPend() + '</div>',
    '<div style="margin-top:8px"><span class="rc-total-chip">Cuota #' + pay.cuotaN + '</span>' + (esTransitoria ? ' <span style="font-size:10px;color:' + C.amber + ';font-weight:700">(Cuota Transitoria / Interes Prorrateado)</span>' : '') + '</div>',
    (yaPag > 0 ? '<div class="rc-total-sub">Ya abonaste ' + moneyYaPag() + ' de ' + money(pay.cuotaTotal) + '</div>' : ''),
    '<div class="rc-total-dates">',
    '<div class="rc-tdate"><div class="rc-tdate-lab">' + (dr > 0 ? 'Vencio el' : dr === 0 ? 'Vence hoy' : 'Vence el') + '</div><div class="rc-tdate-val" style="color:' + heroC.ac + '">' + fmtD(pay.fechaPago) + '</div></div>',
    '<div class="rc-tdate"><div class="rc-tdate-lab">Fecha de hoy</div><div class="rc-tdate-val">' + fmtD(hoyStr) + '</div></div>',
    '</div></div>',
    // Fase 3: con un parcial en curso el desglose muestra lo que AUN SE DEBE, no la composicion
    // nominal. Antes imprimia $227.574 de interes + $222.426 de capital bajo un "Total a pagar" de
    // $50.000: cobraba un interes que el parcial ya habia cubierto y las filas no sumaban el total.
    '<div class="rc-stitle">' + (yaPag > 0 ? 'Desglose de lo que falta' : 'Desglose de la cuota') + '</div><div>',
    (pend.interes > 0 ? rowHTML(esTransitoria ? 'Interes prorrateado' : 'Interes del periodo', pend.interes) : ''),
    (pend.capital > 0 ? '<div class="rc-row"><span class="rc-lab">Abono a capital</span><span class="rc-val">' + moneyCapital() + '</span></div>' : ''),
    '<div class="rc-row rc-row-tot"><span class="rc-lab">' + (yaPag > 0 ? 'Total pendiente' : 'Valor de la cuota') + '</span><span class="rc-val">' + moneyPend() + '</span></div></div>',
    '<div class="rc-stitle">Detalle del prestamo</div><div class="rc-panel">',
    '<div class="rc-row"><span class="rc-lab">Modalidad</span><span class="rc-val">' + esc(loan.modalidad) + '</span></div>',
    '<div class="rc-row"><span class="rc-lab">Monto original</span><span class="rc-val">' + (esUSD ? fmtUSD(loan.montoOrigen) : fmt(loan.montoOrigen)) + '</span></div>',
    (loan.tasaMensual > 0 ? '<div class="rc-row"><span class="rc-lab">Tasa</span><span class="rc-val">' + loan.tasaMensual + '% mensual</span></div>' : ''),
    (loan.modalidad !== 'Prestamo' && loan.modalidad !== 'Pago Unico' && loan.plazoMeses > 0 ? '<div class="rc-row"><span class="rc-lab">Plazo</span><span class="rc-val">' + (loan.modalidad === 'Intereses' ? 'Indefinido' : (loan.plazoMeses + ' meses')) + '</span></div>' : ''),
    '<div class="rc-row"><span class="rc-lab">Saldo pendiente del prestamo</span><span class="rc-val">' + money(saldoPrestamo) + '</span></div>',
    '</div>',
    comoPagar,
    '<div class="rc-next"><div class="rc-next-txt">' + proxAccion + '</div></div>',
    '<div class="rc-foot">Este documento es una solicitud de cobro y no constituye un comprobante de pago.<br>Generado por <b>Cartera</b> &nbsp;&middot;&nbsp; ' + fcCode + ' &nbsp;&middot;&nbsp; ' + fechaEmision + '</div>',
    '</body></html>'
  ].join('\n');

  if (window.electronAPI && window.electronAPI.printPDF) {
    window.electronAPI.printPDF(html, 'FC ' + pay.nombreCliente + ' - C' + pay.cuotaN);
  } else {
    var w = window.open('', '_blank', 'width=560,height=760');
    w.document.write(html); w.document.close();
    w.onload = function() { w.print(); };
  }
}
