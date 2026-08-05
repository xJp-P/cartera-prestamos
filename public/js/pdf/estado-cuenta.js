// public/js/pdf/estado-cuenta.js — Estado de Cuenta de un credito de INTERES DIARIO.
//
// Es el sustituto del Cronograma para esta modalidad: un credito abierto no tiene
// cuotas que listar, tiene un interes que se genero dia a dia. Este documento
// responde la unica pregunta que el deudor hace de verdad — "¿por que debo esto?"—
// mostrando la secuencia completa de tramos y, INTERCALADOS en azul, los cortes que
// los interrumpieron. Asi se lee como una linea de tiempo (se devengo, se cobro, se
// devengo) y se ve por que el capital base baja tras un abono, en vez de obligar a
// cruzar dos tablas separadas.
//
// La tabla va SIEMPRE COMPLETA (decision de negocio): en un PDF la paginacion no es
// un problema y la trazabilidad del calculo es lo que evita disputas.
//
// DOCTRINA: el devengo NO se recalcula aqui. Sale de `estadoDiario`, el mismo espejo
// del motor que usa la pantalla y que la suite verifica contra el backend. El papel y
// la app no pueden contradecirse (Bug #45).

import { fmt, fmtD, copToUsd } from '../core/format.js';
import { nowStr, properCase } from '../core/ui.js';
import { estadoDiario } from '../core/dominio.js';

// Descarta ""/null/undefined/"0" — sin esto salia "C.C. 0" en los documentos.
function campoValido(v){
  if (v === null || v === undefined) return false;
  var s = String(v).trim();
  return s !== '' && s !== '0';
}
function esc(s){
  return String(s == null ? '' : s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

export function generateEstadoCuentaDiario(loan, allPays, opts) {
  opts = opts || {};
  if (!loan) return;
  var hasta = opts.hasta || nowStr();
  var dark = document.documentElement.getAttribute('data-theme') === 'dark';
  var esUSD = loan.moneda === 'USD';
  var trm = loan.trmAcordada || 1;
  // USD protagonista: una linea por rubro, no COP+USD (doctrina v1.16.0).
  function money(cop){ return esUSD ? copToUsd(cop, trm) : fmt(cop); }

  var dev = estadoDiario(loan, allPays, hasta);
  var cortes = (allPays || [])
    .filter(function(p){ return String(p.prestamoId) === String(loan.id) && String(p.id).indexOf('-ct-') !== -1; })
    .sort(function(a,b){
      var c = String(a.fechaPago).localeCompare(String(b.fechaPago));
      return c !== 0 ? c : (a.cuotaN - b.cuotaN);
    });

  var fechaEmision = new Date().toLocaleDateString('es-CO', {day:'2-digit', month:'long', year:'numeric'});
  var ini = properCase(loan.nombre || '').replace(/[^A-Za-zÁÉÍÓÚÑáéíóúñ]/g,'').slice(0,2);
  var ecCode = 'EC-' + (ini || 'XX') + '-' + String(loan.id).slice(-3) + '-' + String(hasta).slice(8,10) + String(hasta).slice(5,7);
  var interesDia = Math.round(dev.capitalVivo * (+loan.tasaMensual || 0) / 100 / 30);
  var tasaDia = Math.round((+loan.tasaMensual || 0) / 30 * 1000) / 1000;

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
    return '<div class="ec-row"><span class="ec-lab">' + l + '</span>' +
           '<span class="ec-val"' + (color ? ' style="color:' + color + '"' : '') + '>' + v + '</span></div>';
  }

  // ── Linea de tiempo: tramos con los cortes intercalados ────────────────────
  // Los tramos de 0 dias (dos cortes el mismo dia) se omiten: no aportan interes y
  // solo anadirian una fila vacia que el deudor leeria como un error del documento.
  var filas = [];
  dev.tramos.forEach(function(t, i){
    if (t.dias > 0 || i === dev.tramos.length - 1) {
      filas.push('<tr><td>' + fmtD(t.desde) + '</td><td>' + fmtD(t.hasta) + '</td>' +
        '<td class="n">' + t.dias + '</td><td class="n">' + money(t.base) + '</td>' +
        '<td class="n">' + money(t.interes) + '</td></tr>');
    }
    // Tras cada tramo (salvo el abierto) viene el corte que lo cerro.
    var c = cortes[i];
    if (c) {
      var det = [];
      if (Math.round(+c.interesPeriodo || 0) > 0) det.push('pago intereses');
      if (Math.round(+c.abonoCapital || 0) > 0) det.push('abono a capital ' + money(Math.round(+c.abonoCapital)));
      filas.push('<tr class="ev"><td colspan="4">Corte #' + c.cuotaN + ' &nbsp;&middot;&nbsp; ' +
        fmtD(c.fechaPago) + ' &nbsp;&middot;&nbsp; ' + (det.join(' + ') || 'sin movimiento') + '</td>' +
        '<td class="n">&minus;' + money(Math.round(+c.interesPeriodo || 0)) + '</td></tr>');
    }
  });
  filas.push('<tr class="tot"><td colspan="3">Total devengado</td><td class="n">' + dev.diasTotales + ' dias</td>' +
             '<td class="n">' + money(dev.interesDevengado) + '</td></tr>');
  filas.push('<tr class="tot"><td colspan="4">Total cobrado</td><td class="n">&minus;' + money(dev.interesCobrado) + '</td></tr>');

  var deudorMeta = [
    campoValido(loan.cedula) ? 'C.C. ' + esc(loan.cedula) : '',
    campoValido(loan.telefono) ? 'Tel. ' + esc(loan.telefono) : ''
  ].filter(Boolean).join(' &nbsp;&middot;&nbsp; ');

  var html = [
    '<!DOCTYPE html><html><head><meta charset="utf-8"><title>Estado de Cuenta - ' + esc(loan.nombre) + '</title><style>',
    '*{box-sizing:border-box}',
    'body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;margin:0;padding:26px 30px;background:' + C.bg + ';color:' + C.text + ';font-size:12px;line-height:1.45;max-width:700px}',
    '.ec-head{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;padding-bottom:11px;border-bottom:2px solid ' + C.headBd + ';margin-bottom:14px}',
    '.ec-brand{display:flex;align-items:center;gap:9px}',
    '.ec-wm{font-size:17px;font-weight:700;letter-spacing:-.3px}',
    '.ec-sub{font-size:9.5px;color:' + C.muted + ';margin-top:1px}',
    '.ec-meta{text-align:right}',
    '.ec-type{font-size:11px;font-weight:700;color:' + C.green + ';letter-spacing:.5px;text-transform:uppercase}',
    '.ec-num{font-family:ui-monospace,monospace;font-size:10.5px;color:' + C.muted + ';margin-top:2px}',
    '.ec-date{font-size:9.5px;color:' + C.foot + ';margin-top:1px}',
    '.ec-st{font-size:9.5px;color:' + C.muted + ';text-transform:uppercase;letter-spacing:.7px}',
    '.ec-name{font-size:16px;font-weight:700;margin:2px 0 1px}',
    '.ec-cc{font-size:10px;color:' + C.muted + '}',
    '.ec-sec{font-size:9.5px;font-weight:700;color:' + C.muted + ';letter-spacing:.8px;text-transform:uppercase;margin:16px 0 6px}',
    '.ec-row{display:flex;justify-content:space-between;padding:5px 0;border-bottom:1px solid ' + C.rowbd + ';font-size:11.5px}',
    '.ec-lab{color:' + C.muted + '}',
    '.ec-val{font-family:ui-monospace,monospace;font-weight:600;white-space:nowrap}',
    '.ec-sm{font-size:9.5px;color:' + C.foot + '}',
    'table{width:100%;border-collapse:collapse;font-size:10.5px}',
    'th{text-align:left;background:' + C.panel + ';color:' + C.muted + ';font-size:9px;letter-spacing:.4px;text-transform:uppercase;padding:6px 5px;border-bottom:1px solid ' + C.bd + ';white-space:nowrap}',
    'td{padding:5px;border-bottom:1px solid ' + C.rowbd + ';white-space:nowrap}',
    'td.n,th.n{text-align:right;font-family:ui-monospace,monospace}',
    'tr.ev td{background:' + C.blueBg + ';color:' + C.blue + ';font-weight:600;font-size:10px}',
    'tr.tot td{background:' + C.panel + ';font-weight:700;border-top:2px solid ' + C.bd + ';border-bottom:none}',
    '.ec-caja{margin-top:11px;padding:12px 15px;border-radius:9px;display:flex;justify-content:space-between;align-items:center;gap:14px;background:' + C.blueBg + ';border:1px solid ' + C.blueBd + '}',
    '.ec-caja .q{font-size:12px;font-weight:700;color:' + C.blue + '}',
    '.ec-caja .v{font-size:22px;font-weight:700;font-family:ui-monospace,monospace;color:' + C.blue + ';white-space:nowrap}',
    '.ec-nota{margin-top:11px;padding:9px 13px;background:' + C.blueBg + ';border:1px solid ' + C.blueBd + ';border-radius:9px;font-size:10.5px;line-height:1.5;color:' + C.blue + '}',
    '.ec-foot{margin-top:17px;padding-top:9px;border-top:1px solid ' + C.footBd + ';text-align:center;color:' + C.foot + ';font-size:9.5px;line-height:1.55}',
    '.ec-foot b{color:' + C.green + '}',
    dark ? '@media print{html,body{-webkit-print-color-adjust:exact!important;print-color-adjust:exact!important;color-adjust:exact!important}*{-webkit-print-color-adjust:exact!important;print-color-adjust:exact!important;color-adjust:exact!important}@page{margin:0}html{background:#0d1117!important}body{max-width:none;padding:2cm;background:#0d1117!important;color:#e6edf3!important;min-height:100vh}}'
         : '@media print{html,body{-webkit-print-color-adjust:exact!important;print-color-adjust:exact!important;color-adjust:exact!important}*{-webkit-print-color-adjust:exact!important;print-color-adjust:exact!important;color-adjust:exact!important}@page{margin:0}html{background:#ffffff!important}body{max-width:none;padding:2cm;background:#ffffff!important;color:#1f2328!important;min-height:100vh}}',
    '</style></head><body>',
    '<div class="ec-head"><div class="ec-brand">',
    '<svg width="32" height="32" viewBox="0 0 36 36" xmlns="http://www.w3.org/2000/svg"><rect width="36" height="36" rx="9" fill="' + C.green + '"/><text x="18" y="25" font-family="Arial,sans-serif" font-size="21" font-weight="700" fill="#ffffff" text-anchor="middle">C</text></svg>',
    '<div><div class="ec-wm">Cartera</div><div class="ec-sub">Gestion de cartera de credito</div></div></div>',
    '<div class="ec-meta"><div class="ec-type">Estado de Cuenta</div><div class="ec-num">' + ecCode + '</div>',
    '<div class="ec-date">Emision: ' + fechaEmision + '</div></div></div>',
    '<div class="ec-st">Credito abierto de</div>',
    '<div class="ec-name">' + esc(loan.nombre) + '</div>',
    (deudorMeta ? '<div class="ec-cc">' + deudorMeta + '</div>' : ''),

    '<div class="ec-sec">Condiciones</div>',
    row('Capital prestado', money(dev.origCOP)),
    row('Desde', fmtD(loan.fechaInicio)),
    row('Tasa', (+loan.tasaMensual || 0) + '% mensual &nbsp;&middot;&nbsp; ' + tasaDia + '% diario'),

    '<div class="ec-sec">Como se genero el interes</div>',
    '<table><tr><th>Desde</th><th>Hasta</th><th class="n">Dias</th><th class="n">Capital base</th><th class="n">Interes</th></tr>',
    filas.join(''),
    '</table>',
    '<div class="ec-sm" style="margin-top:5px">Cada tramo va desde su fecha inicial inclusive hasta la siguiente sin incluir, de modo que ningun dia se cobra dos veces. Un abono a capital reduce la base ese mismo dia.</div>',

    '<div class="ec-sec">Situacion al ' + fmtD(hasta) + '</div>',
    row('Capital prestado', money(dev.origCOP)),
    row('Capital devuelto', '&minus;' + money(dev.capitalAbonado), C.green),
    row('Capital vivo', money(dev.capitalVivo)),
    row('Interes devengado por cobrar<div class="ec-sm">' + dev.diasDesdeUltimoCorte + ' dia(s) x ' + money(interesDia) +
        '/dia desde ' + (dev.fechaUltimoCorte ? ('el ultimo corte (' + fmtD(dev.fechaUltimoCorte) + ')') : ('el inicio (' + fmtD(loan.fechaInicio) + ')')) + '</div>',
        money(dev.interesPendiente), C.blue),

    '<div class="ec-caja"><span class="q">Valor para liquidar al ' + fmtD(hasta) + '</span>',
    '<span class="v">' + money(dev.capitalVivo + dev.interesPendiente) + '</span></div>',
    (dev.capitalVivo > 0
      ? '<div class="ec-nota">Mientras quede capital vivo, el credito genera <b>' + money(interesDia) + '</b> cada dia. Puedes pagar solo los intereses o abonar a capital en cualquier momento: cada abono baja el interes diario desde ese mismo dia.</div>'
      : '<div class="ec-nota">El capital fue devuelto en su totalidad; el credito ya no genera interes.</div>'),

    '<div class="ec-foot">Este documento detalla como se genero el interes de tu credito abierto y su situacion a la fecha de emision.',
    '<br>Generado por <b>Cartera</b> &nbsp;&middot;&nbsp; ' + ecCode + ' &nbsp;&middot;&nbsp; ' + fechaEmision + '</div>',
    '</body></html>'
  ].join('\n');

  var fname = 'Estado de cuenta ' + loan.nombre + ' - ' + hasta;
  if (window.electronAPI && window.electronAPI.printPDF) {
    window.electronAPI.printPDF(html, fname);
  } else {
    var w = window.open('', '_blank', 'width=750,height=800');
    w.document.write(html); w.document.close();
    w.onload = function(){ w.print(); };
  }
}
