// public/js/pdf/recibo-abono.js — Comprobante de un abono a capital (o Paz y Salvo si lo salda).
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
import { nowStr, properCase } from '../core/ui.js';
import { saldoConCaja, pendienteDeCuota, computeLiquidacion } from '../core/dominio.js';
import { esAbono } from '../core/ids.js';

// ── Recibo de Abono a Capital (v1.17.0) ──────────────────────────────────────
// Se genera automaticamente tras registrar un abono. Los 3 puntos de entrada
// (Cartera, perfil del deudor, "Liquidar deuda") convergen en _doAbono, que lo llama
// con el estado YA persistido (el cronograma lo regenero el backend; no se replica
// aqui el motor financiero). 4 variantes:
//   1. PAZ Y SALVO  -> el abono salda el prestamo (saldo 0): sin impacto ni cronograma
//   2. CORTA        -> modalidades sin cronograma amortizable (Intereses/Prestamo/Pago Unico)
//   3/4. COMPLETA   -> Capital + Intereses: impacto segun recalcMode + cronograma actualizado
export function generateReciboAbono(loan, allPays, opts) {
  opts = opts || {};
  if (!loan) return;
  var dark = document.documentElement.getAttribute('data-theme') === 'dark';
  var esUSD = loan.moneda === 'USD';
  var trm = loan.trmAcordada || 1;
  var monto = Math.round(+opts.monto || 0);
  var pre = opts.pre || {};
  var esCapInt = loan.modalidad === 'Capital + Intereses';
  var mode = opts.recalcMode || 'mantener';
  var fechaEmision = new Date().toLocaleDateString('es-CO', {day:'2-digit', month:'long', year:'numeric'});
  function esc(s){ return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
  function campoValido(v){ v = String(v == null ? '' : v).trim(); return v !== '' && v !== '0'; }

  var lp = (allPays || []).filter(function(p){ return p.prestamoId === loan.id; });
  var originalCOP = esUSD ? Math.round(loan.montoOrigen * trm) : Math.round(loan.montoOrigen);
  // Fase 3: saldo CON CAJA APLICADA (este recibo se emite DESPUES de persistir y recargar, asi que
  // `lp` ya trae el abono). Antes usaba la formula canonica pura y contradecia al perfil del deudor.
  var saldoDespues = saldoConCaja(loan, lp);
  // Fase 3: el "Saldo anterior" que se IMPRIME usa la base con caja aplicada, para no contradecir
  // al perfil del deudor. Se cae a `pre.saldo` (motor) si el snapshot es de una version anterior.
  var saldoAntes = (pre.saldoCaja != null) ? pre.saldoCaja : ((pre.saldo != null) ? pre.saldo : (saldoDespues + monto));
  var pend = lp.filter(function(p){ return !esAbono(p) && p.estadoPago === 'Pendiente'; })
               .sort(function(a, b){ return a.cuotaN - b.cuotaN; });
  var nAbonos = lp.filter(function(p){ return esAbono(p); }).length;

  var esPazYSalvo = saldoDespues <= 0 || loan.estado === 'Finalizado';
  // Si el prestamo quedo saldado/Finalizado el saldo mostrado es 0 por definicion (el backend
  // fija montoCOP=0 + estado='Finalizado' juntos). Evita un documento contradictorio del tipo
  // "PAZ Y SALVO" con saldo pendiente > 0 ante cualquier desfase con la formula canonica.
  if (esPazYSalvo) saldoDespues = 0;
  var cortoSinCrono = !esCapInt;   // Intereses / Prestamo / Pago Unico

  // Codigo: AB-[2 letras del deudor]-[3 ultimos del loanId]-[N de abono 2 digitos]
  var ini = properCase(String(loan.nombre || '')).replace(/\s+/g, '').slice(0, 2);
  var abCode = 'AB-' + ini + '-' + String(loan.id || '').slice(-3) + '-' + String(nAbonos || 1).padStart(2, '0');

  // VALOR DE LIQUIDACION HOY — desde el helper centralizado computeLiquidacion (v1.19.0), la
  // MISMA fuente de verdad que el modal "Liquidar deuda", la tarjeta y el cronograma PDF, para
  // que el recibo nunca muestre una cifra distinta a la que ve el usuario en la app.
  var _L = computeLiquidacion(loan, lp, {});
  var intMora = _L.intMora;
  var partialPend = _L.partialPend;
  var liquidacion = _L.total;
  var moraMesTxt = money(_L.moraValorMes) + '/mes' + (_L.moraUniforme ? '' : ' prom.');

  var C = dark ? {
    bg:'#0d1117', text:'#e6edf3', muted:'#8b949e', bd:'#30363d', rowbd:'#21262d', panel:'#161b22',
    green:'#3fb950', greenBg:'#0f2b19', greenBd:'#1b4332', blue:'#79c0ff', blueBg:'#0d2440', blueBd:'#1f3a5f',
    amber:'#d29922', amberBg:'#2b2005', amberBd:'#3d2e08', headBd:'#30363d', foot:'#6e7681', footBd:'#30363d'
  } : {
    bg:'#ffffff', text:'#1f2328', muted:'#656d76', bd:'#d0d7de', rowbd:'#eeeeee', panel:'#f6f8fa',
    green:'#166534', greenBg:'#f0fdf4', greenBd:'#4ade80', blue:'#0969da', blueBg:'#ddf4ff', blueBd:'#b6e3ff',
    amber:'#9a6700', amberBg:'#fff8e1', amberBd:'#eac54f', headBd:'#333333', foot:'#8c959f', footBd:'#dddddd'
  };
  // En prestamos USD el dolar es la moneda protagonista (misma doctrina que el Recibo de Cobro)
  function money(cop){ return esUSD ? copToUsd(cop, trm) : fmt(cop); }
  var montoTxt = esUSD ? ((+opts.montoUSD > 0) ? fmtUSD(+opts.montoUSD) : copToUsd(monto, trm)) : fmt(monto);
  function row(l, v){ return '<div class="ab-row"><span class="ab-lab">' + l + '</span><span class="ab-val">' + v + '</span></div>'; }
  function rowTot(l, v){ return '<div class="ab-row ab-row-tot"><span class="ab-lab">' + l + '</span><span class="ab-val">' + v + '</span></div>'; }
  function card(label, oldTxt, newTxt, delta){
    return '<div class="ab-card"><div class="ab-cl">' + label + '</div>' +
      (oldTxt ? '<div class="ab-old">' + oldTxt + '</div>' : '') +
      '<div class="ab-new">' + newTxt + '</div>' +
      (delta ? '<div class="ab-delta">' + delta + '</div>' : '') + '</div>';
  }

  var cuotaDespues = pend.length ? pend[0].cuotaTotal : 0;
  var nRest = pend.length;
  var intDespues = pend.reduce(function(s, p){ return s + p.interesPeriodo; }, 0);

  // ── Bloque IMPACTO (solo Capital + Intereses con saldo vivo), variable por recalcMode ──
  var impactoHTML = '';
  if (!esPazYSalvo && esCapInt) {
    var cards = card('Saldo de capital', money(saldoAntes), money(saldoDespues), '&#9660; ' + money(monto));
    if (mode === 'modificarPlazo') {
      cards += card('Plazo restante', (pre.cuotas || 0) + ' cuotas', nRest + ' cuotas',
        ((pre.cuotas || 0) > nRest) ? ('&#9660; ' + ((pre.cuotas || 0) - nRest) + ' cuotas menos') : '');
      cards += card('Cuota mensual', pre.cuota ? money(pre.cuota) : '', money(cuotaDespues), '');
    } else if (mode === 'fijarCuota') {
      cards += card('Nueva cuota fija', pre.cuota ? money(pre.cuota) : '', money(cuotaDespues), 'Cuota pactada');
      cards += card('Plazo restante', (pre.cuotas || 0) + ' cuotas', nRest + ' cuotas', '');
    } else {
      cards += card('Cuota mensual', pre.cuota ? money(pre.cuota) : '', money(cuotaDespues),
        (pre.cuota && pre.cuota > cuotaDespues) ? ('&#9660; ' + money(pre.cuota - cuotaDespues) + ' / mes') : '');
      cards += card('Intereses por pagar', pre.intereses ? money(pre.intereses) : '', money(intDespues),
        (pre.intereses && pre.intereses > intDespues) ? ('&#9660; ' + money(pre.intereses - intDespues) + ' ahorrados') : '');
    }
    impactoHTML = '<div class="ab-st">Impacto del abono</div><div class="ab-imp">' + cards + '</div>';
  }

  // ── Bloque "¿Quieres liquidar la deuda hoy?" (va entre Impacto y Cronograma) ──
  // En la variante corta solo se muestra si aporta algo distinto al saldo ya listado
  // en el Resumen (es decir, cuando hay mora o parciales en curso que lo modifican).
  var liqHTML = '';
  if (!esPazYSalvo && (esCapInt || liquidacion !== saldoDespues)) {
    var liqDet = 'Capital ' + money(_L.capitalPendiente) +
      (intMora > 0 ? ' + mora ' + money(intMora) + ' (' + _L.moraCount + ' cuota' + (_L.moraCount>1?'s':'') + ' a ' + moraMesTxt + ')' : '') +
      (partialPend > 0 ? ' &minus; parciales ' + money(partialPend) : '') + ', sin los intereses futuros del cronograma.';
    liqHTML = '<div class="ab-liq"><div><div class="ab-liq-q">&iquest;Quieres liquidar la deuda hoy?</div>' +
      '<div class="ab-liq-s">' + liqDet + '</div></div>' +
      '<div class="ab-liq-v">' + money(liquidacion) + '</div></div>';
  }

  // ── Bloque CRONOGRAMA ACTUALIZADO (solo variante completa) ──
  var cronoHTML = '';
  if (!esPazYSalvo && esCapInt && nRest > 0) {
    var filas = pend.map(function(p){
      return '<tr><td class="c">' + p.cuotaN + '</td><td>' + fmtD(p.fechaPago) + '</td>' +
        '<td class="r">' + money(p.interesPeriodo) + '</td><td class="r">' + money(p.abonoCapital) + '</td>' +
        '<td class="r"><strong>' + money(p.cuotaTotal) + '</strong>' +
        ((p.partialPaid||0) > 0 ? '<br><span style="font-size:9px;opacity:.75">Abonado ' + money(Math.round(p.partialPaid)) + '</span>' : '') +
        '</td><td class="r">' + money(p.saldoFinal) + '</td></tr>';
    }).join('');
    // Fase 3: el TOTAL declara lo que AUN se debe. Un parcial sobre una cuota Pendiente ahora
    // SOBREVIVE al abono (Bug #44), asi que sumar la cuota entera lo re-cobraria — y contradiria
    // al bloque de liquidacion de este mismo recibo, que si resta los parciales. La CELDA de cada
    // fila sigue en `cuotaTotal` (doctrina v1.18.0) con la sub-linea "Abonado X", igual que el
    // cronograma PDF. Sin parciales, estos totales son identicos a los anteriores.
    var tInt = pend.reduce(function(s, p){ return s + pendienteDeCuota(p).interes; }, 0);
    var tCap = pend.reduce(function(s, p){ return s + pendienteDeCuota(p).capital; }, 0);
    var tCuo = tInt + tCap;
    var yaAbon = pend.reduce(function(s, p){ return s + Math.round(p.partialPaid || 0); }, 0);
    cronoHTML = '<div class="ab-st">Cronograma actualizado &mdash; ' + nRest + ' cuota' + (nRest === 1 ? '' : 's') + ' restante' + (nRest === 1 ? '' : 's') + '</div>' +
      '<table class="ab-t"><tr><th style="text-align:center">Cuota</th><th>Vence</th><th style="text-align:right">Interes</th>' +
      '<th style="text-align:right">Abono a capital</th><th style="text-align:right">Valor cuota</th><th style="text-align:right">Saldo</th></tr>' +
      filas + '<tr class="tot"><td class="c" colspan="2">TOTAL A PAGAR' +
      (yaAbon > 0 ? ' <span style="font-weight:400;font-size:9px">(neto de ' + money(yaAbon) + ' ya abonado)</span>' : '') +
      '</td><td class="r">' + money(tInt) +
      '</td><td class="r">' + money(tCap) + '</td><td class="r">' + money(tCuo) + '</td><td class="r">&mdash;</td></tr></table>';
  }

  // ── Bloque RESUMEN (Paz y Salvo + variante corta) ──
  var resumenHTML = '';
  if (esPazYSalvo || cortoSinCrono) {
    resumenHTML = '<div class="ab-st">Resumen</div><div class="ab-panel">' +
      row('Modalidad', esc(loan.modalidad)) +
      row('Monto original del prestamo', esUSD ? fmtUSD(loan.montoOrigen) : fmt(loan.montoOrigen)) +
      row('Saldo anterior', money(saldoAntes)) +
      row('Abono aplicado', '&minus; ' + montoTxt) +
      rowTot('Nuevo saldo pendiente', money(saldoDespues)) + '</div>';
  }

  var pazHTML = esPazYSalvo
    ? '<div class="ab-paz"><div class="ab-paz-t">PAZ Y SALVO</div><div class="ab-paz-s">Con este abono queda <b>cancelada la totalidad</b> del prestamo. No queda saldo pendiente.</div></div>'
    : '';
  var notaHTML = (!esPazYSalvo && esCapInt)
    ? '<div class="ab-nota"><b>Recalculo aplicado:</b> ' + (
        mode === 'modificarPlazo' ? 'se ajusto el numero de cuotas restantes manteniendo el ritmo de pago.'
        : mode === 'fijarCuota'   ? 'se fijo el valor de la cuota; el plazo se ajusto en consecuencia.'
        : 'se mantuvo el plazo original y se redujo el valor de la cuota.'
      ) + ' El abono se aplico 100% a capital, por lo que no genera intereses futuros sobre ese monto.</div>'
    : '';
  var deudorMeta = [ campoValido(loan.cedula) ? ('C.C. ' + esc(String(loan.cedula).trim())) : '',
                     campoValido(loan.telefono) ? ('Tel. ' + esc(String(loan.telefono).trim())) : '' ].filter(Boolean).join(' &nbsp;&middot;&nbsp; ');
  var titulo = esPazYSalvo ? 'Paz y Salvo' : 'Recibo de Abono a Capital';

  var html = [
    '<!DOCTYPE html><html><head><meta charset="utf-8"><title>' + titulo + '</title>',
    '<style>',
    '*{margin:0;padding:0;box-sizing:border-box}',
    'body{font-family:Arial,Helvetica,sans-serif;padding:22px;max-width:640px;margin:0 auto;color:' + C.text + ';background:' + C.bg + ';line-height:1.3}',
    '.ab-head{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;padding-bottom:10px;border-bottom:2px solid ' + C.headBd + '}',
    '.ab-brand{display:flex;align-items:center;gap:10px}',
    '.ab-wm{font-size:19px;font-weight:700;color:' + C.text + ';line-height:1.1}',
    '.ab-sub{font-size:10px;color:' + C.muted + ';margin-top:2px}',
    '.ab-meta{text-align:right}',
    '.ab-type{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:' + C.muted + '}',
    '.ab-num{font-size:15px;font-weight:700;color:' + C.text + ';margin-top:3px}',
    '.ab-date{font-size:11px;color:' + C.muted + ';margin-top:3px}',
    '.ab-st{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:' + C.muted + ';margin:13px 0 5px}',
    '.ab-name{font-size:16px;font-weight:700;color:' + C.text + '}',
    '.ab-cc{font-size:12px;color:' + C.muted + ';margin-top:2px}',
    '.ab-total{margin:12px 0 4px;padding:14px;text-align:center;background:' + C.greenBg + ';border:2px solid ' + C.greenBd + ';border-radius:14px}',
    '.ab-tl{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:2px;color:' + C.green + '}',
    '.ab-ta{font-size:32px;font-weight:700;color:' + C.green + ';line-height:1.05;margin:3px 0 0;letter-spacing:-1px}',
    '.ab-chip{display:inline-block;margin-top:7px;background:' + C.bg + ';border:1px solid ' + C.greenBd + ';color:' + C.green + ';border-radius:20px;padding:3px 13px;font-size:11px;font-weight:700}',
    '.ab-imp{display:flex;gap:8px;margin-top:4px}',
    '.ab-card{flex:1;background:' + C.panel + ';border:1px solid ' + C.bd + ';border-radius:9px;padding:9px 10px;text-align:center}',
    '.ab-cl{font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:' + C.muted + '}',
    '.ab-old{font-size:11px;color:' + C.muted + ';text-decoration:line-through;margin-top:3px}',
    '.ab-new{font-size:15px;font-weight:700;color:' + C.green + ';margin-top:1px}',
    '.ab-delta{font-size:9px;color:' + C.green + ';font-weight:700;margin-top:1px}',
    '.ab-panel{background:' + C.panel + ';border:1px solid ' + C.bd + ';border-radius:10px;padding:6px 14px;margin-top:4px}',
    '.ab-row{display:flex;justify-content:space-between;align-items:baseline;padding:5px 0;border-bottom:1px solid ' + C.rowbd + '}',
    '.ab-row:last-child{border-bottom:none}',
    '.ab-lab{font-size:12px;color:' + C.muted + '}',
    '.ab-val{font-size:13px;font-weight:600;color:' + C.text + ';text-align:right}',
    '.ab-row-tot{border-top:1px solid ' + C.bd + ';padding-top:7px;margin-top:2px}',
    '.ab-row-tot .ab-lab{font-weight:700;color:' + C.text + '}',
    '.ab-row-tot .ab-val{color:' + C.green + ';font-size:15px;font-weight:700}',
    'table.ab-t{width:100%;border-collapse:collapse;margin-top:4px}',
    '.ab-t th{background:' + C.panel + ';border:1px solid ' + C.bd + ';padding:5px 7px;font-size:9px;font-weight:700;color:' + C.muted + ';text-transform:uppercase;letter-spacing:.3px}',
    '.ab-t td{border:1px solid ' + C.bd + ';padding:4px 7px;font-size:10.5px}',
    '.ab-t td.r{text-align:right}',
    '.ab-t td.c{text-align:center}',
    '.ab-t tr.tot td{background:' + C.greenBg + ';font-weight:700;color:' + C.green + ';border-color:' + C.greenBd + '}',
    '.ab-paz{margin:12px 0 4px;padding:14px;text-align:center;background:' + C.greenBg + ';border:2px solid ' + C.greenBd + ';border-radius:14px}',
    '.ab-paz-t{font-size:20px;font-weight:700;letter-spacing:2px;color:' + C.green + '}',
    '.ab-paz-s{font-size:12px;color:' + C.text + ';margin-top:5px}',
    '.ab-liq{margin-top:10px;padding:11px 14px;background:' + C.blueBg + ';border:1px solid ' + C.blueBd + ';border-radius:10px;display:flex;justify-content:space-between;align-items:center;gap:12px}',
    '.ab-liq-q{font-size:12.5px;font-weight:700;color:' + C.blue + '}',
    '.ab-liq-s{font-size:10px;color:' + C.muted + ';margin-top:2px;line-height:1.35}',
    '.ab-liq-v{font-size:20px;font-weight:700;color:' + C.blue + ';white-space:nowrap}',
    '.ab-nota{margin-top:9px;padding:8px 12px;background:' + C.amberBg + ';border:1px solid ' + C.amberBd + ';border-radius:9px;font-size:11px;line-height:1.4;color:' + C.amber + '}',
    '.ab-foot{margin-top:14px;padding-top:9px;border-top:1px solid ' + C.footBd + ';text-align:center;color:' + C.foot + ';font-size:10px;line-height:1.5}',
    '.ab-foot b{color:' + C.green + '}',
    dark ? '@media print{html,body{-webkit-print-color-adjust:exact!important;print-color-adjust:exact!important;color-adjust:exact!important}*{-webkit-print-color-adjust:exact!important;print-color-adjust:exact!important;color-adjust:exact!important}@page{margin:0}html{background:#0d1117!important}body{max-width:none;padding:1.3cm;background:#0d1117!important;color:#e6edf3!important;min-height:100vh}}'
         : '@media print{html,body{-webkit-print-color-adjust:exact!important;print-color-adjust:exact!important;color-adjust:exact!important}*{-webkit-print-color-adjust:exact!important;print-color-adjust:exact!important;color-adjust:exact!important}@page{margin:0}html{background:#ffffff!important}body{max-width:none;padding:1.3cm;background:#ffffff!important;color:#1f2328!important;min-height:100vh}}',
    '</style></head><body>',
    '<div class="ab-head"><div class="ab-brand">',
    '<svg width="34" height="34" viewBox="0 0 36 36" xmlns="http://www.w3.org/2000/svg"><rect width="36" height="36" rx="9" fill="' + C.green + '"/><text x="18" y="25" font-family="Arial,sans-serif" font-size="21" font-weight="700" fill="#ffffff" text-anchor="middle">C</text></svg>',
    '<div><div class="ab-wm">Cartera</div><div class="ab-sub">Gestion de cartera de credito</div></div></div>',
    '<div class="ab-meta"><div class="ab-type">' + titulo + '</div><div class="ab-num">' + abCode + '</div><div class="ab-date">Emision: ' + fechaEmision + '</div></div></div>',
    '<div class="ab-st">Abono realizado por</div>',
    '<div class="ab-name">' + esc(loan.nombre) + '</div>',
    (deudorMeta ? '<div class="ab-cc">' + deudorMeta + '</div>' : ''),
    '<div class="ab-total"><div class="ab-tl">Abono recibido a capital</div>',
    '<div class="ab-ta">' + montoTxt + '</div>',
    '<div><span class="ab-chip">Aplicado el ' + fmtD(opts.fecha || nowStr()) + '</span></div></div>',
    pazHTML,
    resumenHTML,
    impactoHTML,
    liqHTML,
    cronoHTML,
    notaHTML,
    '<div class="ab-foot">' + (esPazYSalvo
        ? 'Este documento certifica que el prestamo fue cancelado en su totalidad.'
        : 'Este documento certifica el abono a capital recibido y el saldo resultante.') +
      '<br>Generado por <b>Cartera</b> &nbsp;&middot;&nbsp; ' + abCode + ' &nbsp;&middot;&nbsp; ' + fechaEmision + '</div>',
    '</body></html>'
  ].join('\n');

  // Nombre de archivo con el monto (mas util al buscar que un consecutivo). Se formatea aparte
  // porque fmt() mete un espacio duro (U+00A0) tras el '$' que ensuciaria el nombre.
  var montoFname = esUSD
    ? ((+opts.montoUSD > 0) ? fmtUSD(+opts.montoUSD) : copToUsd(monto, trm))
    : ('$' + Math.round(monto).toLocaleString('es-CO'));
  var fname = esPazYSalvo ? ('Paz y Salvo ' + loan.nombre) : ('AB ' + loan.nombre + ' - ' + montoFname);
  if (window.electronAPI && window.electronAPI.printPDF) {
    window.electronAPI.printPDF(html, fname);
  } else {
    var w = window.open('', '_blank', 'width=680,height=800');
    w.document.write(html); w.document.close();
    w.onload = function() { w.print(); };
  }
}
