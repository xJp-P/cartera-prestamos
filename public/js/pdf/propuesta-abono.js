// public/js/pdf/propuesta-abono.js — "Si abonas X, asi quedaria tu credito".
//
// El papel que se le manda a un cliente que pregunta ANTES de pagar. No registra
// nada: se genera desde el modal de cobro, con el plan y el preview que el usuario
// ya tiene en pantalla, sin tocar el backend.
//
// ── POR QUE ES UN GENERADOR APARTE Y NO UN MODO DEL RECIBO ───────────────────
// Porque los dos documentos afirman cosas opuestas. `generateReciboCobro` dice
// "TOTAL RECIBIDO", "Recibido el [fecha]" y "certifica el dinero recibido"; este
// dice "SI ABONAS" y "no registra ningun pago". Un flag compartido deja a una sola
// funcion emitiendo las dos cosas, y un error de flag produciria el peor documento
// posible: un comprobante de dinero que nunca entro. Con dos generadores ese fallo
// es estructuralmente imposible. Es la misma leccion del Bug #45, donde el recibo
// se emitia ANTES de que la escritura ocurriera.
//
// ── DE DONDE SALEN LOS DATOS ────────────────────────────────────────────────
// Aqui SI se usa `plan.pasos` —y no `estado.hechos` como el recibo— porque no hay
// nada aplicado que consultar: el documento describe, por definicion, lo que
// PASARIA. Y el estado final NO puede salir de las filas persistidas: sale de la
// proyeccion que el modal dibujo con `previewRecalculo` + `filasPreview`, que son
// el espejo verificado del motor (seccion F de `cascada-cobro`).

import { fmt, fmtUSD, fmtD } from '../core/format.js';
import { nowStr, properCase } from '../core/ui.js';
import { esDiario } from '../core/dominio.js';

// `propuesta` = { fecha, plan, cajaCOP, proyeccion }
//   - plan       : resultado de `planCascada` (pasos + totales). NO aplicado.
//   - cajaCOP    : los pesos que el cliente entregaria (solo informativo en USD).
//   - proyeccion : { filas, n, saldado, totalAntes, totalDespues, abonadoProxima,
//                  cuotaAntes }. `filas` puede venir vacia (modalidades sin cronograma
//                  amortizable): el documento se emite igual, sin tabla ni total.
//
// La cifra grande de "asi quedaria" es el TOTAL POR PAGAR, no un saldo de capital. No
// es cosmetica: el saldo de capital sale de `saldoConCaja`, que depende de
// `imputarCobros`, y proyectar esa imputacion sobre un cronograma que aun no existe
// obliga a una segunda implementacion que se desincroniza — paso, y los dos papeles
// de la misma operacion terminaron en cifras distintas. El total por pagar sale
// DIRECTO de la proyeccion (suma de cuota menos lo ya abonado en ella) y es
// exactamente lo que el recibo totaliza en "Lo que queda por pagar".
// `allPays` se conserva en la firma por simetria con los otros generadores, aunque
// este documento no lo necesita: todo lo que muestra sale del plan y de la proyeccion.
export function generatePropuestaAbono(loan, allPays, propuesta, opts) {
  opts = opts || {};
  // Un credito de interes diario no pasa por la cascada: su puerta es el CORTE.
  if (esDiario(loan)) return;

  var plan = (propuesta && propuesta.plan) || null;
  if (!plan || !plan.pasos || !plan.pasos.length) return;

  var proy  = (propuesta && propuesta.proyeccion) || {};
  var pasos = plan.pasos;
  var dark  = opts.dark !== undefined ? opts.dark
            : (typeof document !== 'undefined' &&
               document.documentElement.getAttribute('data-theme') !== 'light');
  var esUSD = loan.moneda === 'USD';
  var trm   = +loan.trmAcordada || 1;
  var fechaProp    = (propuesta && propuesta.fecha) || nowStr();
  var fechaEmision = new Date().toLocaleDateString('es-CO', { day:'2-digit', month:'long', year:'numeric' });

  function esc(s){ return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
  function campoValido(v){ v = String(v == null ? '' : v).trim(); return v !== '' && v !== '0'; }

  // Aritmetica en la unidad de la MONEDA VISIBLE (Bug #31): lo que suma se resta
  // sobre valores ya redondeados a lo que se imprime.
  function uni(cop){ return esUSD ? Math.round((cop || 0) / trm * 100) : Math.round(cop || 0); }
  function fmtUni(u){ return esUSD ? fmtUSD((u || 0) / 100) : fmt(u || 0); }
  function money(cop){ return fmtUni(uni(cop)); }

  // ── Rubros, con el mismo reparto que el modal y el recibo ──────────────────
  var partials = pasos.filter(function(p){ return p.tipo === 'partial'; });
  var abonos   = pasos.filter(function(p){ return p.tipo === 'abono'; });
  var oblPartialsU = partials.reduce(function(s,p){ return s + uni(p.obligacionCOP); }, 0);
  var intU  = partials.filter(function(p){ return !p.esInteresMes; })
                      .reduce(function(s,p){ return s + uni(p.interes); }, 0);
  var mesU  = pasos.filter(function(p){ return p.esInteresMes; })
                   .reduce(function(s,p){ return s + uni(p.interes); }, 0);
  var capMoraU = Math.max(0, oblPartialsU - intU - mesU);
  var abonoU   = abonos.reduce(function(s,p){ return s + uni(p.obligacionCOP); }, 0);
  var totalU   = intU + mesU + capMoraU + abonoU;
  var oblUSD   = esUSD ? pasos.reduce(function(s,p){ return s + (+p.obligacionUSD || 0); }, 0) : 0;
  var cajaCOP  = Math.round((propuesta && propuesta.cajaCOP) || 0);

  var totalAntes   = Math.max(0, Math.round(proy.totalAntes || 0));
  var totalDespues = (proy.totalDespues === null || proy.totalDespues === undefined)
                     ? null : Math.max(0, Math.round(proy.totalDespues));
  var filas = proy.filas || [];
  var cuotaAntes   = Math.round(proy.cuotaAntes || 0);
  var cuotaDespues = filas.length ? Math.round(filas[0].cuota) : 0;

  // Codigo PA-[2 iniciales]-[3 ultimos del loanId]-[DDMM]. Lista blanca CON dieresis,
  // para que un apellido con enye o tilde conserve sus iniciales.
  var ini = properCase(loan.nombre || '').replace(/[^A-Za-zÁÉÍÓÚÜÑáéíóúüñ]/g,'').slice(0,2);
  var paCode = 'PA-' + (ini || 'XX') + '-' + String(loan.id || '').slice(-3) + '-' +
               String(fechaProp).slice(8,10) + String(fechaProp).slice(5,7);

  var C = dark ? {
    bg:'#0d1117', text:'#e6edf3', muted:'#8b949e', bd:'#30363d', rowbd:'#21262d', panel:'#161b22',
    blue:'#58a6ff', blueBg:'#0d2136', blueBd:'#1f3d5c',
    green:'#3fb950', red:'#f85149',
    amber:'#d29922', amberBg:'#2b2005', amberBd:'#3d2e08',
    headBd:'#30363d', foot:'#6e7681', footBd:'#30363d'
  } : {
    bg:'#ffffff', text:'#1f2328', muted:'#656d76', bd:'#d0d7de', rowbd:'#eeeeee', panel:'#f6f8fa',
    blue:'#0969da', blueBg:'#ddf4ff', blueBd:'#54aeff',
    green:'#166534', red:'#cf222e',
    amber:'#9a6700', amberBg:'#fff8e1', amberBd:'#eac54f',
    headBd:'#333333', foot:'#8c959f', footBd:'#dddddd'
  };

  function row(l, v, color){
    return '<div class="pa-row"><span class="pa-lab">' + l + '</span>' +
           '<span class="pa-val"' + (color ? ' style="color:' + color + '"' : '') + '>' + v + '</span></div>';
  }
  function card(label, oldTxt, newTxt, nota){
    return '<div class="pa-card"><div class="pa-cl">' + label + '</div>' +
      (oldTxt ? '<div class="pa-old">' + oldTxt + '</div>' : '') +
      '<div class="pa-new">' + newTxt + '</div>' +
      (nota ? '<div class="pa-cnota">' + nota + '</div>' : '') + '</div>';
  }
  function cardHero(label, valor, nota){
    return '<div class="pa-card pa-hero"><div class="pa-cl">' + label + '</div>' +
      '<div class="pa-new pa-hnew">' + valor + '</div>' +
      (nota ? '<div class="pa-cnota">' + nota + '</div>' : '') + '</div>';
  }
  // Ver la nota de `fechaCorta` en recibo-cobro.js: el formato largo parte el rotulo
  // de la tarjeta en tres lineas. Mismo anclaje a mediodia que `fmtD`.
  function fechaCorta(s){
    if (!s) return '';
    // es-CO devuelve "19 de ago" incluso con month:'short'; el rotulo necesita "19 ago".
    return new Date(s + 'T12:00:00').toLocaleDateString('es-CO', {day:'2-digit', month:'short'})
      .replace(/ de /g, ' ').replace(/\.$/, '');
  }

  // ── Los pasos, en CONDICIONAL: nada de esto ha ocurrido ────────────────────
  var pasosHTML = pasos.map(function(p, i){
    var totP = uni(p.obligacionCOP), intP = uni(p.interes);
    var capP = Math.max(0, totP - intP);
    var esMora = p.tipo === 'partial';
    var titulo = p.esInteresMes ? ('Interes del mes &middot; cuota #' + p.cuotaN)
               : esMora ? ('Cuota #' + p.cuotaN + ' vencida') : 'Abono extraordinario a capital';
    var chip = p.esInteresMes ? '<span class="pa-chip pa-chip-b">POR ADELANTADO</span>'
             : esMora ? (p.salda ? '<span class="pa-chip pa-chip-g">SE SALDARIA</span>'
                                 : '<span class="pa-chip pa-chip-a">QUEDARIA PARCIAL</span>')
             : '';
    var det = [];
    if (p.esInteresMes && p.fechaPago) det.push('aun no vence (' + fmtD(p.fechaPago) + ')');
    else if (esMora && p.fechaPago) det.push('vencio el ' + fmtD(p.fechaPago));
    if (intP > 0) det.push('intereses <b style="color:' + C.red + '">' + fmtUni(intP) + '</b>');
    if (capP > 0) det.push('capital <b>' + fmtUni(capP) + '</b>');
    if (esMora && !p.esInteresMes && !p.salda && p.restanteCuota > 0)
      det.push('seguiria debiendo <b style="color:' + C.amber + '">' + money(p.restanteCuota) + '</b>');
    if (!esMora) det.push('reduciria el capital vivo y los intereses futuros');
    return '<div class="pa-paso"><div class="pa-paso-h">' +
      '<span class="pa-n">' + (i + 1) + '</span>' +
      '<span class="pa-paso-t">' + titulo + '</span>' + chip +
      '<span class="pa-paso-v">' + fmtUni(totP) + '</span></div>' +
      (det.length ? '<div class="pa-paso-d">' + det.join(' &nbsp;&middot;&nbsp; ') + '</div>' : '') +
      '</div>';
  }).join('');

  var totalesHTML = '<div class="pa-panel">' +
    (intU  > 0 ? row('Intereses vencidos',             fmtUni(intU),  C.red)   : '') +
    (mesU  > 0 ? row('Interes del mes en curso',       fmtUni(mesU),  C.blue)  : '') +
    (capMoraU > 0 ? row('Capital de cuotas vencidas',  fmtUni(capMoraU))       : '') +
    (abonoU > 0 ? row('Abono extraordinario a capital', fmtUni(abonoU), C.green) : '') +
    '<div class="pa-row pa-row-tot"><span class="pa-lab">Total que se aplicaria</span>' +
      '<span class="pa-val">' + fmtUni(totalU) + '</span></div>' +
    (esUSD && cajaCOP > 0 ? row('Equivalente en pesos', fmt(cajaCOP)) : '') +
    '</div>';

  // ── Como quedaria ──────────────────────────────────────────────────────────
  // Mismo tratamiento que el Recibo de Cobro, y por la misma razon: el titular de la
  // tarjeta de la cuota es LO QUE HABRIA QUE GIRAR, no el valor contractual. Si esa
  // cuota queda con abono encima (el interes del mes que se cobra por adelantado), las
  // dos cifras difieren y la que le importa al cliente es la primera.
  var abonadoProx = Math.max(0, Math.round(proy.abonadoProxima || 0));
  var aPagarProx  = Math.max(0, cuotaDespues - abonadoProx);
  var fechaProx   = filas.length ? filas[0].fecha : null;
  var totalTxt    = (totalDespues !== null) ? money(totalDespues) : '';
  var aPagarTxt   = money(aPagarProx);

  // Colapso a tarjeta unica: con una sola cuota proyectada y sin mora que sobreviva,
  // el total y el proximo pago son EL MISMO numero. La condicion se evalua sobre los
  // valores ya formateados —"el lector ve dos veces lo mismo"— y `totalDespues` incluye
  // la mora que el cobro no salda, asi que si queda mora las dos cifras difieren y no
  // colapsa: correcto, porque entonces el proximo pago NO es toda la deuda.
  // `Intereses` queda fuera por la MISMA razon que en el recibo: sus cuotas son de puro
  // interes y el capital vence al final, fuera del cronograma, asi que ni el total ni un
  // "unico pago" describen la deuda. Hoy es inalcanzable desde la UI —el preview solo
  // existe en Capital + Intereses— pero el arnes de `pdf-render` SI lo alcanza, y llego a
  // emitir "Quedaria un solo pago de 2.310.000" sobre un capital de 3.000.000.
  var esIndef   = loan.modalidad === 'Intereses';
  var heroUnico = filas.length === 1 && aPagarProx > 0 && !esIndef &&
                  Math.round(proy.moraTras || 0) === 0 &&
                  totalDespues !== null && totalTxt === aPagarTxt;

  var cards;
  if (heroUnico) {
    cards = cardHero('Quedaria un solo pago', aPagarTxt,
      (fechaProx ? 'el ' + fmtD(fechaProx) : '') +
      (abonadoProx > 0 ? ' &nbsp;&middot;&nbsp; cuota ' + money(cuotaDespues) +
                         ' menos ' + money(abonadoProx) + ' ya abonado' : ''));
  } else {
    // Ninguna tarjeta repite una cifra que otra ya muestra: con una sola cuota
    // proyectada el total y el proximo pago coinciden aunque no colapsen al hero.
    // El gate de Intereses de aqui es DEFENSA EN PROFUNDIDAD y hoy ningun caso lo alcanza:
    // en esa modalidad la regla de redundancia de al lado ya suprime la tarjeta (verificado
    // inyectando la regresion, la suite sigue verde). Se conserva porque un call site futuro
    // que proyectara 2+ filas ahi imprimiria un total que MIENTE por debajo de la deuda.
    // El gate del hero, que si es alcanzable, si esta fijado por pdf-render.
    cards = (totalDespues !== null && !esIndef && !(aPagarProx > 0 && totalTxt === aPagarTxt))
      ? card('Total por pagar', (totalAntes > totalDespues) ? money(totalAntes) : '', totalTxt)
      : '';
    if (aPagarProx > 0) {
      // Mismo criterio que el recibo: si quedaria mora sin saldar, el rotulo no puede
      // prometer un proximo pago — hay deuda vencida que va antes.
      var conMora = Math.round(proy.moraTras || 0) > 0;
      var notaCuota = abonadoProx > 0
        ? ('cuota ' + money(cuotaDespues) + ' menos ' + money(abonadoProx) + ' ya abonado')
        : '';
      if (conMora && fechaProx) notaCuota = 'vence el ' + fmtD(fechaProx) +
        (notaCuota ? ' &middot; ' + notaCuota : '');
      cards += card(conMora ? 'Proxima cuota' : ('A pagar el ' + fechaCorta(fechaProx)),
        (abonadoProx === 0 && cuotaAntes && cuotaAntes !== cuotaDespues) ? money(cuotaAntes) : '',
        aPagarTxt, notaCuota);
    }
    if (filas.length) cards += card('Cuotas restantes', '', String(filas.length));
  }

  var saldadoHTML = (proy.saldado || totalDespues === 0)
    ? '<div class="pa-saldado">Con ese abono el credito quedaria <b>totalmente cancelado</b>.</div>' : '';

  // Cronograma PROYECTADO. Mismas columnas universales que el resto de la app
  // (v1.18.0), con el capital reconciliado en la moneda visible.
  var cronoHTML = '';
  if (filas.length) {
    cronoHTML = '<div class="pa-st">Cronograma que quedaria</div>' +
      '<table class="pa-tb"><thead><tr>' +
      '<th class="l">#</th><th class="l">VENCE</th><th>INTERES</th><th>ABONO A CAPITAL</th>' +
      '<th>VALOR CUOTA</th><th>SALDO</th></tr></thead><tbody>' +
      filas.map(function(f){
        var q = uni(f.cuota), i2 = uni(f.interes), c2 = Math.max(0, q - i2);
        return '<tr><td class="l">' + (f.cuotaN || '') + '</td>' +
          '<td class="l">' + (f.fecha ? fmtD(f.fecha) : '&mdash;') + '</td>' +
          '<td>' + fmtUni(i2) + '</td><td>' + fmtUni(c2) + '</td>' +
          '<td><b>' + fmtUni(q) + '</b></td><td>' + money(f.saldo) + '</td></tr>';
      }).join('') + '</tbody></table>';
  }

  var deudorMeta = [ campoValido(loan.cedula)   ? ('C.C. ' + esc(String(loan.cedula).trim()))   : '',
                     campoValido(loan.telefono) ? ('Tel. ' + esc(String(loan.telefono).trim())) : '' ]
                   .filter(Boolean).join(' &nbsp;&middot;&nbsp; ');
  var heroTxt = esUSD ? fmtUSD(oblUSD) : fmtUni(totalU);
  var heroSub = (esUSD && cajaCOP > 0) ? ('Equivalen a ' + fmt(cajaCOP)) : '';

  var html = [
    '<!DOCTYPE html><html><head><meta charset="utf-8"><title>Propuesta de Abono</title>',
    '<style>',
    '*{margin:0;padding:0;box-sizing:border-box}',
    'body{font-family:Arial,Helvetica,sans-serif;padding:22px;max-width:640px;margin:0 auto;color:' + C.text + ';background:' + C.bg + ';line-height:1.3;font-variant-numeric:tabular-nums}',
    '.pa-head{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;padding-bottom:10px;border-bottom:2px solid ' + C.headBd + '}',
    '.pa-brand{display:flex;align-items:center;gap:10px}',
    '.pa-wm{font-size:19px;font-weight:700;color:' + C.text + ';line-height:1.1}',
    '.pa-sub{font-size:10px;color:' + C.muted + ';margin-top:2px}',
    '.pa-meta{text-align:right}',
    '.pa-type{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:' + C.muted + '}',
    '.pa-num{font-size:15px;font-weight:700;color:' + C.text + ';margin-top:3px}',
    '.pa-date{font-size:11px;color:' + C.muted + ';margin-top:3px}',
    '.pa-st{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:' + C.muted + ';margin:13px 0 5px}',
    '.pa-name{font-size:16px;font-weight:700;color:' + C.text + '}',
    '.pa-cc{font-size:12px;color:' + C.muted + ';margin-top:2px}',
    '.pa-total{margin:12px 0 4px;padding:14px;text-align:center;background:' + C.blueBg + ';border:2px solid ' + C.blueBd + ';border-radius:14px}',
    '.pa-tl{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:2px;color:' + C.blue + '}',
    '.pa-ta{font-size:32px;font-weight:700;color:' + C.blue + ';line-height:1.05;margin:3px 0 0;letter-spacing:-1px}',
    '.pa-ts{font-size:11px;color:' + C.muted + ';margin-top:4px}',
    '.pa-paso{border:1px solid ' + C.bd + ';border-radius:9px;padding:8px 11px;margin-top:6px;background:' + C.panel + '}',
    '.pa-paso-h{display:flex;align-items:center;gap:7px}',
    '.pa-n{width:17px;height:17px;border-radius:99px;background:' + C.blueBg + ';color:' + C.blue + ';font-size:9.5px;font-weight:700;display:inline-block;text-align:center;line-height:17px;flex-shrink:0}',
    '.pa-paso-t{font-size:12px;font-weight:700;color:' + C.text + '}',
    '.pa-paso-v{margin-left:auto;font-size:13px;font-weight:700;color:' + C.text + ';white-space:nowrap}',
    '.pa-paso-d{font-size:10.5px;color:' + C.muted + ';margin-top:3px;padding-left:24px;line-height:1.45}',
    '.pa-chip{font-size:8.5px;font-weight:700;letter-spacing:.4px;padding:2px 6px;border-radius:5px}',
    '.pa-chip-b{background:' + C.blueBg + ';color:' + C.blue + ';border:1px solid ' + C.blueBd + '}',
    '.pa-chip-g{background:' + C.blueBg + ';color:' + C.green + ';border:1px solid ' + C.blueBd + '}',
    '.pa-chip-a{background:' + C.amberBg + ';color:' + C.amber + ';border:1px solid ' + C.amberBd + '}',
    '.pa-panel{background:' + C.panel + ';border:1px solid ' + C.bd + ';border-radius:10px;padding:6px 14px;margin-top:9px}',
    '.pa-row{display:flex;justify-content:space-between;align-items:baseline;padding:5px 0;border-bottom:1px solid ' + C.rowbd + ';font-size:12px}',
    '.pa-row:last-child{border-bottom:none}',
    '.pa-lab{color:' + C.muted + '}',
    '.pa-val{font-weight:700;color:' + C.text + ';white-space:nowrap}',
    '.pa-row-tot .pa-lab{color:' + C.text + ';font-weight:700}',
    '.pa-row-tot .pa-val{font-size:14px}',
    '.pa-imp{display:flex;gap:8px;margin-top:4px}',
    '.pa-card{flex:1;background:' + C.panel + ';border:1px solid ' + C.bd + ';border-radius:9px;padding:9px 10px;text-align:center}',
    '.pa-cl{font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:' + C.muted + '}',
    '.pa-old{font-size:11px;color:' + C.muted + ';text-decoration:line-through;margin-top:3px}',
    '.pa-new{font-size:15px;font-weight:700;color:' + C.blue + ';margin-top:1px}',
    '.pa-cnota{font-size:9px;color:' + C.muted + ';margin-top:3px;line-height:1.35}',
    '.pa-hero{background:' + C.blueBg + ';border-color:' + C.blueBd + ';padding:13px 12px}',
    '.pa-hero .pa-cl{color:' + C.blue + '}',
    '.pa-hero .pa-cnota{color:' + C.blue + ';font-size:10px;margin-top:5px}',
    '.pa-hnew{font-size:26px;margin-top:3px}',
    '.pa-tb{width:100%;border-collapse:collapse;margin-top:5px;font-size:10.5px}',
    '.pa-tb th{text-align:right;font-size:8.5px;letter-spacing:.4px;color:' + C.muted + ';font-weight:700;padding:3px 5px;border-bottom:1px solid ' + C.bd + ';white-space:nowrap}',
    '.pa-tb th.l,.pa-tb td.l{text-align:left}',
    '.pa-tb td{text-align:right;padding:4px 5px;border-bottom:1px solid ' + C.rowbd + ';white-space:nowrap}',
    '.pa-saldado{margin-top:9px;padding:10px 12px;text-align:center;background:' + C.blueBg + ';border:1px solid ' + C.blueBd + ';border-radius:10px;font-size:12px;color:' + C.text + '}',
    '.pa-aviso{margin-top:11px;padding:9px 12px;background:' + C.amberBg + ';border:1px solid ' + C.amberBd + ';border-radius:9px;font-size:10.5px;line-height:1.45;color:' + C.amber + '}',
    '.pa-foot{margin-top:14px;padding-top:9px;border-top:1px solid ' + C.footBd + ';text-align:center;color:' + C.foot + ';font-size:10px;line-height:1.5}',
    '.pa-foot b{color:' + C.blue + '}',
    dark ? '@media print{html,body{-webkit-print-color-adjust:exact!important;print-color-adjust:exact!important;color-adjust:exact!important}*{-webkit-print-color-adjust:exact!important;print-color-adjust:exact!important;color-adjust:exact!important}@page{margin:0}html{background:#0d1117!important}body{max-width:none;padding:1.3cm;background:#0d1117!important;color:#e6edf3!important;min-height:100vh}}'
         : '@media print{html,body{-webkit-print-color-adjust:exact!important;print-color-adjust:exact!important;color-adjust:exact!important}*{-webkit-print-color-adjust:exact!important;print-color-adjust:exact!important;color-adjust:exact!important}@page{margin:0}html{background:#ffffff!important}body{max-width:none;padding:1.3cm;background:#ffffff!important;color:#1f2328!important;min-height:100vh}}',
    '</style></head><body>',
    '<div class="pa-head"><div class="pa-brand">',
    '<svg width="34" height="34" viewBox="0 0 36 36" xmlns="http://www.w3.org/2000/svg"><rect width="36" height="36" rx="9" fill="' + C.blue + '"/><text x="18" y="25" font-family="Arial,sans-serif" font-size="21" font-weight="700" fill="#ffffff" text-anchor="middle">C</text></svg>',
    '<div><div class="pa-wm">Cartera</div><div class="pa-sub">Gestion de cartera de credito</div></div></div>',
    '<div class="pa-meta"><div class="pa-type">Propuesta de Abono</div><div class="pa-num">' + paCode + '</div><div class="pa-date">Emision: ' + fechaEmision + '</div></div></div>',
    '<div class="pa-st">Preparada para</div>',
    '<div class="pa-name">' + esc(loan.nombre) + '</div>',
    (deudorMeta ? '<div class="pa-cc">' + deudorMeta + '</div>' : ''),
    '<div class="pa-total"><div class="pa-tl">Si abonas</div>',
    '<div class="pa-ta">' + heroTxt + '</div>',
    (heroSub ? '<div class="pa-ts">' + heroSub + '</div>' : ''),
    '</div>',
    '<div class="pa-st">Asi se aplicaria tu pago</div>',
    pasosHTML,
    totalesHTML,
    '<div class="pa-st">Asi quedaria tu credito</div>',
    '<div class="pa-imp">' + cards + '</div>',
    saldadoHTML,
    cronoHTML,
    // El aviso es la razon de ser del documento: sin el, un papel con el membrete de
    // la app y cifras exactas se puede leer como comprobante de algo ya pagado.
    '<div class="pa-aviso"><b>Esto es una proyeccion, no un comprobante.</b> No se ha registrado ningun pago ' +
      'y el credito sigue como estaba. Los valores corresponden al ' + fmtD(fechaProp) +
      '; si vence una cuota antes de que abones, el reparto cambia.</div>',
    '<div class="pa-foot">Documento informativo preparado a solicitud del cliente.' +
      '<br>Generado por <b>Cartera</b> &nbsp;&middot;&nbsp; ' + paCode + ' &nbsp;&middot;&nbsp; ' + fechaEmision + '</div>',
    '</body></html>',
  ].join('\n');

  // `fmt()` mete un espacio duro despues del $ que ensuciaria el nombre del archivo.
  var montoFname = esUSD ? ('USD $' + oblUSD.toLocaleString('en-US', {minimumFractionDigits:2, maximumFractionDigits:2}))
                         : ('$' + Math.round(totalU).toLocaleString('es-CO'));
  var fname = 'Propuesta ' + loan.nombre + ' - ' + montoFname;
  if (window.electronAPI && window.electronAPI.printPDF) {
    window.electronAPI.printPDF(html, fname);
  } else {
    var w = window.open('', '_blank', 'width=680,height=800');
    w.document.write(html); w.document.close();
    w.onload = function() { w.print(); };
  }
}
