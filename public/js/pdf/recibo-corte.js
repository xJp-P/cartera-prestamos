// public/js/pdf/recibo-corte.js — Comprobante de un CORTE de interes diario.
//
// Es el equivalente del Recibo de Pago para esta modalidad: se entrega al deudor
// justo despues de registrar un corte, y certifica que ese dinero entro.
//
// Responde tres cosas, en este orden: cuanto entrego, DE DONDE SALE esa cifra
// (dias x interes diario, no un numero caido del cielo), y como le queda el credito
// — incluido cuanto va a generar desde manana, que es lo que un credito abierto
// tiene de particular y lo que el deudor necesita saber para decidir su proximo pago.
//
// El estado PREVIO no se pide por parametro: se deriva excluyendo este corte del
// ledger, con el mismo `estadoDiario` que usa la pantalla. Asi el recibo no puede
// contradecir a la app aunque el llamador pase datos incompletos.

import { fmt, fmtD, copToUsd } from '../core/format.js';
import { properCase } from '../core/ui.js';
import { estadoDiario } from '../core/dominio.js';

function campoValido(v){
  if (v === null || v === undefined) return false;
  var s = String(v).trim();
  return s !== '' && s !== '0';
}
function esc(s){
  return String(s == null ? '' : s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

export function generateReciboCorte(loan, allPays, corte, opts) {
  opts = opts || {};
  if (!loan || !corte) return;
  var dark = document.documentElement.getAttribute('data-theme') === 'dark';
  var esUSD = loan.moneda === 'USD';
  var trm = loan.trmAcordada || 1;
  function money(cop){ return esUSD ? copToUsd(cop, trm) : fmt(cop); }

  var fechaCorte = corte.fechaPago;
  var intCobrado = Math.round(+corte.interesPeriodo || 0);
  var abonoCap   = Math.round(+corte.abonoCapital  || 0);
  var total      = intCobrado + abonoCap;

  // Estado DESPUES (el ledger ya trae este corte) y ANTES (excluyendolo).
  var mios = (allPays || []).filter(function(p){ return String(p.prestamoId) === String(loan.id); });
  var devPost = estadoDiario(loan, mios, fechaCorte);
  var devPre  = estadoDiario(loan, mios.filter(function(p){ return String(p.id) !== String(corte.id); }), fechaCorte);

  var interesDiaAntes  = Math.round(devPre.capitalVivo  * (+loan.tasaMensual || 0) / 100 / 30);
  var interesDiaDespues= Math.round(devPost.capitalVivo * (+loan.tasaMensual || 0) / 100 / 30);
  var saldado = devPost.capitalVivo === 0 && devPost.interesPendiente === 0;

  var fechaEmision = new Date().toLocaleDateString('es-CO', {day:'2-digit', month:'long', year:'numeric'});
  var ini = properCase(loan.nombre || '').replace(/[^A-Za-zÁÉÍÓÚÑáéíóúñ]/g,'').slice(0,2);
  var rcCode = 'RC-' + (ini || 'XX') + '-' + String(loan.id).slice(-3) + '-' + String(corte.cuotaN).padStart(2,'0');

  var C = dark ? {
    bg:'#0d1117', text:'#e6edf3', muted:'#8b949e', bd:'#30363d', rowbd:'#21262d', panel:'#161b22',
    green:'#3fb950', greenBg:'#0f2b19', greenBd:'#1b4332', blue:'#79c0ff', blueBg:'#0d2440', blueBd:'#1f3a5f',
    headBd:'#30363d', foot:'#6e7681', footBd:'#30363d'
  } : {
    bg:'#ffffff', text:'#1f2328', muted:'#656d76', bd:'#d0d7de', rowbd:'#eeeeee', panel:'#f6f8fa',
    green:'#166534', greenBg:'#f0fdf4', greenBd:'#4ade80', blue:'#0969da', blueBg:'#ddf4ff', blueBd:'#b6e3ff',
    headBd:'#333333', foot:'#8c959f', footBd:'#dddddd'
  };

  function row(l, v, color){
    return '<div class="rc-row"><span class="rc-lab">' + l + '</span>' +
           '<span class="rc-val"' + (color ? ' style="color:' + color + '"' : '') + '>' + v + '</span></div>';
  }

  var deudorMeta = [
    campoValido(loan.cedula) ? 'C.C. ' + esc(loan.cedula) : '',
    campoValido(loan.telefono) ? 'Tel. ' + esc(loan.telefono) : ''
  ].filter(Boolean).join(' &nbsp;&middot;&nbsp; ');

  var html = [
    '<!DOCTYPE html><html><head><meta charset="utf-8"><title>Recibo de Corte - ' + esc(loan.nombre) + '</title><style>',
    '*{box-sizing:border-box}',
    'body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;margin:0;padding:26px 30px;background:' + C.bg + ';color:' + C.text + ';font-size:12px;line-height:1.45;max-width:560px}',
    '.rc-head{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;padding-bottom:11px;border-bottom:2px solid ' + C.headBd + ';margin-bottom:14px}',
    '.rc-brand{display:flex;align-items:center;gap:9px}',
    '.rc-wm{font-size:17px;font-weight:700;letter-spacing:-.3px}',
    '.rc-sub{font-size:9.5px;color:' + C.muted + ';margin-top:1px}',
    '.rc-meta{text-align:right}',
    '.rc-type{font-size:11px;font-weight:700;color:' + C.green + ';letter-spacing:.5px;text-transform:uppercase}',
    '.rc-num{font-family:ui-monospace,monospace;font-size:10.5px;color:' + C.muted + ';margin-top:2px}',
    '.rc-date{font-size:9.5px;color:' + C.foot + ';margin-top:1px}',
    '.rc-st{font-size:9.5px;color:' + C.muted + ';text-transform:uppercase;letter-spacing:.7px}',
    '.rc-name{font-size:16px;font-weight:700;margin:2px 0 1px}',
    '.rc-cc{font-size:10px;color:' + C.muted + '}',
    '.rc-hero{margin:14px 0 2px;padding:15px;text-align:center;background:' + C.greenBg + ';border:1px solid ' + C.greenBd + ';border-radius:12px}',
    '.rc-hero .l{font-size:9.5px;color:' + C.muted + ';text-transform:uppercase;letter-spacing:.8px}',
    '.rc-hero .a{font-size:29px;font-weight:700;color:' + C.green + ';font-family:ui-monospace,monospace;margin-top:3px}',
    '.rc-chip{display:inline-block;margin-top:6px;padding:3px 10px;border-radius:99px;background:' + C.panel + ';color:' + C.muted + ';font-size:10px}',
    '.rc-sec{font-size:9.5px;font-weight:700;color:' + C.muted + ';letter-spacing:.8px;text-transform:uppercase;margin:16px 0 6px}',
    '.rc-row{display:flex;justify-content:space-between;padding:5px 0;border-bottom:1px solid ' + C.rowbd + ';font-size:11.5px}',
    '.rc-lab{color:' + C.muted + '}',
    '.rc-val{font-family:ui-monospace,monospace;font-weight:600;white-space:nowrap}',
    '.rc-sm{font-size:9.5px;color:' + C.foot + '}',
    '.rc-caja{margin-top:11px;padding:11px 14px;border-radius:9px;display:flex;justify-content:space-between;align-items:center;gap:12px;background:' + C.blueBg + ';border:1px solid ' + C.blueBd + '}',
    '.rc-caja .q{font-size:12px;font-weight:700;color:' + C.blue + '}',
    '.rc-caja .v{font-size:18px;font-weight:700;font-family:ui-monospace,monospace;color:' + C.blue + ';white-space:nowrap}',
    '.rc-paz{margin:12px 0 4px;padding:14px;text-align:center;background:' + C.greenBg + ';border:2px solid ' + C.greenBd + ';border-radius:14px}',
    '.rc-paz-t{font-size:20px;font-weight:700;letter-spacing:2px;color:' + C.green + '}',
    '.rc-paz-s{font-size:12px;color:' + C.text + ';margin-top:5px}',
    '.rc-foot{margin-top:17px;padding-top:9px;border-top:1px solid ' + C.footBd + ';text-align:center;color:' + C.foot + ';font-size:9.5px;line-height:1.55}',
    '.rc-foot b{color:' + C.green + '}',
    dark ? '@media print{html,body{-webkit-print-color-adjust:exact!important;print-color-adjust:exact!important;color-adjust:exact!important}*{-webkit-print-color-adjust:exact!important;print-color-adjust:exact!important;color-adjust:exact!important}@page{margin:0}html{background:#0d1117!important}body{max-width:none;padding:1.3cm;background:#0d1117!important;color:#e6edf3!important;min-height:100vh}}'
         : '@media print{html,body{-webkit-print-color-adjust:exact!important;print-color-adjust:exact!important;color-adjust:exact!important}*{-webkit-print-color-adjust:exact!important;print-color-adjust:exact!important;color-adjust:exact!important}@page{margin:0}html{background:#ffffff!important}body{max-width:none;padding:1.3cm;background:#ffffff!important;color:#1f2328!important;min-height:100vh}}',
    '</style></head><body>',
    '<div class="rc-head"><div class="rc-brand">',
    '<svg width="32" height="32" viewBox="0 0 36 36" xmlns="http://www.w3.org/2000/svg"><rect width="36" height="36" rx="9" fill="' + C.green + '"/><text x="18" y="25" font-family="Arial,sans-serif" font-size="21" font-weight="700" fill="#ffffff" text-anchor="middle">C</text></svg>',
    '<div><div class="rc-wm">Cartera</div><div class="rc-sub">Gestion de cartera de credito</div></div></div>',
    '<div class="rc-meta"><div class="rc-type">Recibo de Corte</div><div class="rc-num">' + rcCode + '</div>',
    '<div class="rc-date">Emision: ' + fechaEmision + '</div></div></div>',
    '<div class="rc-st">Recibido de</div>',
    '<div class="rc-name">' + esc(loan.nombre) + '</div>',
    (deudorMeta ? '<div class="rc-cc">' + deudorMeta + '</div>' : ''),

    '<div class="rc-hero"><div class="l">Total recibido</div><div class="a">' + money(total) + '</div>',
    '<div><span class="rc-chip">Registrado el ' + fmtD(fechaCorte) + '</span></div></div>',

    '<div class="rc-sec">Detalle</div>',
    (intCobrado > 0
      ? row('Intereses<div class="rc-sm">' + devPre.diasDesdeUltimoCorte + ' dia(s) x ' + money(interesDiaAntes) + '/dia desde ' +
            (devPre.fechaUltimoCorte ? fmtD(devPre.fechaUltimoCorte) : fmtD(loan.fechaInicio)) + '</div>', money(intCobrado), C.green)
      : row('Intereses', money(0))),
    row('Abono a capital', money(abonoCap), abonoCap > 0 ? C.blue : undefined),
    (corte.observaciones ? row('Observaciones', esc(corte.observaciones)) : ''),

    (saldado
      ? '<div class="rc-paz"><div class="rc-paz-t">PAZ Y SALVO</div><div class="rc-paz-s">Este credito quedo cancelado en su totalidad.</div></div>'
      : [
          '<div class="rc-sec">Como queda tu credito</div>',
          row('Capital vivo' + (abonoCap === 0 ? '<div class="rc-sm">Sin cambio: este corte no incluyo abono</div>' : ''), money(devPost.capitalVivo)),
          row('Interes por cobrar', money(devPost.interesPendiente), devPost.interesPendiente > 0 ? C.blue : undefined),
          row('Desde manana genera' + (abonoCap > 0 ? '<div class="rc-sm">Antes generaba ' + money(interesDiaAntes) + '/dia</div>' : ''),
              money(interesDiaDespues) + ' / dia'),
          '<div class="rc-caja"><span class="q">Si liquidas hoy</span><span class="v">' +
            money(devPost.capitalVivo + devPost.interesPendiente) + '</span></div>'
        ].join('\n')),

    '<div class="rc-foot">' + (saldado
        ? 'Este documento certifica que el credito fue cancelado en su totalidad.'
        : 'Este documento certifica el dinero recibido y como queda tu credito a la fecha.') +
      '<br>Generado por <b>Cartera</b> &nbsp;&middot;&nbsp; ' + rcCode + ' &nbsp;&middot;&nbsp; ' + fechaEmision + '</div>',
    '</body></html>'
  ].join('\n');

  // El monto se formatea aparte: fmt() mete un espacio duro (U+00A0) tras el '$'
  // que ensuciaria el nombre del archivo (misma razon que en el Recibo de Abono).
  var montoFname = esUSD ? copToUsd(total, trm) : ('$' + total.toLocaleString('es-CO'));
  var fname = saldado ? ('Paz y Salvo ' + loan.nombre) : ('RC ' + loan.nombre + ' - ' + montoFname);
  if (window.electronAPI && window.electronAPI.printPDF) {
    window.electronAPI.printPDF(html, fname);
  } else {
    var w = window.open('', '_blank', 'width=600,height=800');
    w.document.write(html); w.document.close();
    w.onload = function(){ w.print(); };
  }
}
