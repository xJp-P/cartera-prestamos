// public/js/pdf/estado-liquidacion.js — ESTADO DE LIQUIDACION.
//
// El documento que se le entrega al deudor cuando pide cerrar el credito: "esto es
// lo que debes pagar HOY para quedar a paz y salvo, y este es el respaldo de por que".
// Lo dispara el boton secundario de `LiquidarModal`, ANTES de confirmar — el flujo
// real es generar el papel, cobrar, y solo entonces confirmar.
//
// ── DOCTRINA (lo que NO se puede tocar sin romper algo) ──────────────────────
//
// 1. EL TOTAL SALE DE `computeLiquidacion`, NUNCA se recalcula aqui. Es la unica
//    fuente de verdad del valor de liquidacion y ya la consumen otras 5 superficies;
//    una copia mas seria una fuente de divergencia (por eso se centralizo en v1.19.0).
//    En particular NO se migra a `saldoConCaja`: computeLiquidacion resta los pagos
//    parciales APARTE del total, asi que hacerlo los restaria dos veces.
//
// 2. EL RESPALDO SI usa `imputarCobros`, que es lo correcto para una tabla historica:
//    reparte cada cobro entre interes y capital en cascada (Bug #45). Las dos cosas
//    conviven sin contradecirse porque miden cosas distintas — el desglose mide lo que
//    FALTA, la tabla mide lo que YA ENTRO.
//
// 3. `hasta` ES UN PARAMETRO, no `new Date()` por dentro. El valor de liquidacion
//    depende del dia (el interes sigue corriendo), asi que quien lo genera fija la
//    fecha. Sin esto el documento no seria reproducible ni testeable con reloj
//    congelado, y `pdf-render` no podria tener golden.
//
// 4. FECHA DE VALIDEZ VISIBLE. Un estado de liquidacion caduca: manana el interes
//    devengo mas y el papel ya no cuadra. Se dice explicitamente para que nadie
//    aparezca dos semanas despues exigiendo el monto impreso.

import { fmt, fmtD, copToUsd } from '../core/format.js';
import { nowStr, properCase } from '../core/ui.js';
import { computeLiquidacion, imputarCobros, esDiario } from '../core/dominio.js';
import { esAbono, esCorte } from '../core/ids.js';

// Descarta ""/null/undefined/"0" — sin esto salia "C.C. 0" en los documentos.
function campoValido(v){
  if (v === null || v === undefined) return false;
  var s = String(v).trim();
  return s !== '' && s !== '0';
}
// El texto del deudor y sus observaciones son TEXTO LIBRE: se escapan siempre. Un
// '<' en una nota no puede deformar un documento que se entrega impreso.
function esc(s){
  return String(s == null ? '' : s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

export function generateEstadoLiquidacion(loan, allPays, datosPago, opts) {
  opts = opts || {};
  if (!loan) return;
  var hasta = opts.hasta || nowStr();
  var dark  = document.documentElement.getAttribute('data-theme') === 'dark';
  var esUSD = loan.moneda === 'USD';
  var trm   = loan.trmAcordada || 1;
  var diario = esDiario(loan);

  // USD protagonista: una sola linea por rubro, no COP+USD (doctrina v1.16.0).
  function money(cop){ return esUSD ? copToUsd(cop, trm) : fmt(cop); }
  // Variante compacta para las celdas de la tabla: la tabla es monomoneda, asi que
  // el prefijo "USD " se repetiria en cada celda y roba ~28px de ancho (patron `fvT`
  // de v1.18.0, necesario aqui porque son 8 columnas).
  function moneyT(cop){ return esUSD ? String(copToUsd(cop, trm)).replace('USD ', '') : fmt(cop); }

  // ── UNICA fuente del total (ver doctrina 1) ────────────────────────────────
  var L = computeLiquidacion(loan, allPays, {
    incluyeProxMes: !!opts.incluyeProxMes,
    hasta: hasta
  });

  var pays = (allPays || []).filter(function(p){ return String(p.prestamoId) === String(loan.id); });
  var origCOP = esUSD ? Math.round(loan.montoOrigen * trm) : Math.round(loan.montoOrigen);
  var capAmortizado = Math.max(0, origCOP - L.capitalPendiente);

  var fechaEmision = new Date(hasta + 'T12:00:00')
    .toLocaleDateString('es-CO', {day:'2-digit', month:'long', year:'numeric'});
  // Lista blanca CON dieresis y diacriticos: un apellido con "ü" o "Ñ" conserva sus
  // iniciales en vez de saltar a las letras siguientes.
  var ini = properCase(loan.nombre || '').replace(/[^A-Za-zÁÉÍÓÚÜÑáéíóúüñ]/g,'').slice(0,2);
  var lqCode = 'LQ-' + (ini || 'XX') + '-' + String(loan.id).slice(-3) + '-' +
               String(hasta).slice(8,10) + String(hasta).slice(5,7);

  var C = dark ? {
    bg:'#0d1117', text:'#e6edf3', muted:'#8b949e', bd:'#30363d', rowbd:'#21262d', panel:'#161b22',
    green:'#3fb950', blue:'#79c0ff', blueBg:'#0d2440', blueBd:'#1f3a5f',
    red:'#f85149', redBg:'#2d1214', redBd:'#5c2226',
    amber:'#d29922', amberBg:'#2b2312', amberBd:'#5c4813',
    headBd:'#30363d', foot:'#6e7681', footBd:'#30363d'
  } : {
    bg:'#ffffff', text:'#1f2328', muted:'#656d76', bd:'#d0d7de', rowbd:'#eeeeee', panel:'#f6f8fa',
    green:'#166534', blue:'#0969da', blueBg:'#ddf4ff', blueBd:'#b6e3ff',
    red:'#cf222e', redBg:'#ffebe9', redBd:'#ffcecb',
    amber:'#9a6700', amberBg:'#fff8e5', amberBd:'#e8d3a0',
    headBd:'#333333', foot:'#8c959f', footBd:'#dddddd'
  };

  function row(l, v, color){
    return '<div class="lq-row"><span class="lq-lab">' + l + '</span>' +
           '<span class="lq-val"' + (color ? ' style="color:' + color + '"' : '') + '>' + v + '</span></div>';
  }
  function dsg(titulo, sub, valor, color){
    return '<div class="lq-d"><div><div class="t">' + titulo + '</div>' +
           (sub ? '<div class="s">' + sub + '</div>' : '') + '</div>' +
           '<div class="v"' + (color ? ' style="color:' + color + '"' : '') + '>' + valor + '</div></div>';
  }

  // ── DESGLOSE ───────────────────────────────────────────────────────────────
  // Dos ramas porque el producto es distinto: en un credito con cuotas el interes
  // que falta vive en las filas En Mora; en uno abierto NO existe fila alguna — se
  // deriva del tiempo transcurrido, asi que hay que explicarlo en dias.
  var desglose = [];
  desglose.push(dsg('Capital pendiente',
    money(origCOP) + ' prestados &minus; ' + money(capAmortizado) + ' ya amortizados',
    money(L.capitalPendiente)));

  if (diario) {
    var porDia = L.interesDia;
    desglose.push(dsg('Interes acumulado',
      L.diasDevengados + ' dia(s) x ' + money(porDia) + ' por dia',
      money(L.interesDevengado), C.amber));
  } else if (L.moraCount > 0) {
    desglose.push(dsg('Intereses atrasados',
      L.moraCount + ' cuota' + (L.moraCount > 1 ? 's' : '') + ' vencida' + (L.moraCount > 1 ? 's' : '') +
      ' &nbsp;&middot;&nbsp; ' + money(L.moraValorMes) + ' por mes' + (L.moraUniforme ? '' : ' (promedio)'),
      money(L.intMora), C.amber));
  }
  if (L.partialPend > 0) {
    desglose.push(dsg('Abonos parciales ya recibidos', 'Se descuentan del total',
      '&minus; ' + money(L.partialPend), C.blue));
  }
  if (L.incluyeProxMes && L.intExtra > 0) {
    desglose.push(dsg(diario ? 'Interes del proximo mes' : 'Interes del mes en curso',
      L.tasaMensual + '% sobre el capital pendiente &nbsp;&middot;&nbsp; pactado con el deudor',
      money(L.intExtra), C.amber));
  }

  // ── RESPALDO ───────────────────────────────────────────────────────────────
  // La pregunta que evita la discusion: "¿por que debo esto?". Se responde con lo que
  // YA entro, no con lo que falta.
  var respaldo = '', notaRespaldo = '', totalRecibido = 0;

  if (diario) {
    var cortes = pays.filter(esCorte).sort(function(a,b){
      var c = String(a.fechaPago).localeCompare(String(b.fechaPago));
      return c !== 0 ? c : (a.cuotaN - b.cuotaN);
    });
    var fc = cortes.map(function(p){
      var interes = Math.round(+p.interesPeriodo || 0);
      var capital = Math.round(+p.abonoCapital || 0);
      totalRecibido += interes + capital;
      return '<tr><td>#' + p.cuotaN + '</td><td>' + fmtD(p.fechaPago) + '</td>' +
             '<td class="n">' + moneyT(interes) + '</td>' +
             '<td class="n">' + moneyT(capital) + '</td>' +
             '<td class="n">' + moneyT(interes + capital) + '</td></tr>';
    });
    if (!fc.length) {
      fc.push('<tr><td colspan="5" style="text-align:center;color:' + C.muted +
              '">Todavia no se ha registrado ningun corte en este credito.</td></tr>');
    } else {
      fc.push('<tr class="tot"><td colspan="4">Total recibido a la fecha</td>' +
              '<td class="n">' + moneyT(totalRecibido) + '</td></tr>');
    }
    respaldo =
      '<table><tr><th>Corte</th><th>Fecha</th><th class="n">Intereses</th>' +
      '<th class="n">Abono a capital</th><th class="n">Total</th></tr>' + fc.join('') + '</table>';
    notaRespaldo = 'Cada corte es un movimiento real de caja. El interes se genera dia a dia sobre el ' +
                   'capital vivo, por eso un abono lo reduce desde ese mismo dia.';
  } else {
    // Cuotas regulares + abonos INTERCALADOS por fecha (mismo comparador que el
    // cronograma, para que los dos documentos cuenten la misma secuencia).
    //
    // Solo HISTORIAL: lo ya ocurrido al dia de la liquidacion. Las cuotas futuras aun
    // pendientes no explican nada de lo que se debe hoy — y son justamente las que el
    // deudor deja de pagar al liquidar, asi que listarlas invita a la confusion que este
    // documento existe para evitar. Se incluye igual cualquier fila que YA tenga dinero
    // encima aunque su vencimiento sea futuro (un parcial en vuelo si es historia).
    var todas = pays.filter(function(p){ return !esCorte(p); });
    var filas = todas.filter(function(p){
      return String(p.fechaPago) <= String(hasta) || imputarCobros(p).totales.cobrado > 0;
    }).sort(function(a,b){
      var c = String(a.fechaPago).localeCompare(String(b.fechaPago));
      return c !== 0 ? c : ((a.cuotaN || 0) - (b.cuotaN || 0));
    });
    var omitidas = todas.length - filas.length;
    var fr = filas.map(function(p){
      var imp = imputarCobros(p);
      var cobrado = imp.totales.cobrado;
      totalRecibido += cobrado;
      var evs = (imp.eventos || []);
      var recaudo = p.fechaRecaudo ? fmtD(p.fechaRecaudo)
                  : (evs.length ? fmtD(evs[evs.length - 1].fecha) : '&mdash;');
      var ab = esAbono(p);
      var interes = Math.round(+p.interesPeriodo || 0);
      // Capital reconciliado contra la cuota, no la columna cruda (doctrina v1.18.0).
      var capital = Math.round(+p.cuotaTotal || 0) - interes;
      var est = ab ? ['Abono','b-ok']
              : p.estadoPago === 'Pagado'  ? ['Pagado','b-ok']
              : p.estadoPago === 'En Mora' ? ['En mora','b-mora']
              : cobrado > 0                ? ['Parcial','b-par']
              : ['Pendiente','b-pen'];
      return '<tr' + (ab ? ' class="ab"' : '') + '>' +
        '<td>' + (ab ? '&mdash;' : (p.cuotaN || '')) + '</td>' +
        '<td>' + fmtD(p.fechaPago) + '</td>' +
        '<td class="n">' + moneyT(Math.round(+p.cuotaTotal || 0)) + '</td>' +
        '<td class="n">' + (ab ? '&mdash;' : moneyT(interes)) + '</td>' +
        '<td class="n">' + moneyT(ab ? Math.round(+p.abonoCapital || 0) : capital) + '</td>' +
        '<td class="n">' + (cobrado > 0 ? moneyT(cobrado) : '&mdash;') + '</td>' +
        '<td>' + recaudo + '</td>' +
        '<td><span class="bdg ' + est[1] + '">' + est[0] + '</span></td></tr>';
    });
    if (!fr.length) {
      fr.push('<tr><td colspan="8" style="text-align:center;color:' + C.muted +
              '">Este credito todavia no tiene movimientos registrados.</td></tr>');
    } else {
      fr.push('<tr class="tot"><td colspan="4">Capital amortizado a la fecha</td>' +
              '<td class="n">' + moneyT(capAmortizado) + '</td>' +
              '<td class="n">' + moneyT(totalRecibido) + '</td>' +
              '<td colspan="2">Total recibido</td></tr>');
    }
    respaldo =
      '<table><tr><th>#</th><th>Vence</th><th class="n">Valor cuota</th><th class="n">Interes</th>' +
      '<th class="n">Abono a capital</th><th class="n">Pagado</th><th>Recaudado</th><th>Estado</th></tr>' +
      fr.join('') + '</table>';
    // Nunca recortar en silencio: si algo quedo fuera, el documento lo dice (doctrina
    // "no silent caps"). Sin esto la tabla parece el cronograma completo y no lo es.
    notaRespaldo = 'Las filas azules son abonos a capital, no cuotas del cronograma.' +
      (L.partialPend > 0 ? ' Los abonos parciales ya estan descontados del total a liquidar.' : '') +
      (omitidas > 0 ? ' No se listan ' + omitidas + ' cuota(s) de vencimiento posterior al ' +
        fmtD(hasta) + ': quedan canceladas con esta liquidacion.' : '');
  }

  var deudorMeta = [
    campoValido(loan.cedula)   ? 'C.C. ' + esc(loan.cedula)   : '',
    campoValido(loan.telefono) ? 'Tel. ' + esc(loan.telefono) : ''
  ].filter(Boolean).join(' &nbsp;&middot;&nbsp; ');

  var comoPagar = (datosPago && String(datosPago).trim())
    ? '<div class="lq-pagar"><div class="h">Como pagar</div><div class="b">' +
      esc(datosPago).replace(/\n/g, '<br>') + '</div></div>'
    : '';

  var tasaTxt = diario
    ? (L.tasaMensual + '% mensual &nbsp;&middot;&nbsp; ' + money(L.interesDia) + ' por dia')
    : (L.tasaMensual + '% mensual');

  var html = [
    '<!DOCTYPE html><html><head><meta charset="utf-8"><title>Estado de Liquidacion - ' + esc(loan.nombre) + '</title><style>',
    '*{box-sizing:border-box}',
    'body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;margin:0;padding:26px 30px;background:' + C.bg + ';color:' + C.text + ';font-size:12px;line-height:1.45;max-width:700px}',
    '.lq-head{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;padding-bottom:11px;border-bottom:2px solid ' + C.headBd + ';margin-bottom:14px}',
    '.lq-brand{display:flex;align-items:center;gap:9px}',
    '.lq-wm{font-size:17px;font-weight:700;letter-spacing:-.3px}',
    '.lq-sub{font-size:9.5px;color:' + C.muted + ';margin-top:1px}',
    '.lq-meta{text-align:right}',
    '.lq-type{font-size:11px;font-weight:700;color:' + C.red + ';letter-spacing:.5px;text-transform:uppercase}',
    '.lq-num{font-family:ui-monospace,monospace;font-size:10.5px;color:' + C.muted + ';margin-top:2px}',
    '.lq-date{font-size:9.5px;color:' + C.foot + ';margin-top:1px}',
    '.lq-st{font-size:9.5px;color:' + C.muted + ';text-transform:uppercase;letter-spacing:.7px}',
    '.lq-name{font-size:16px;font-weight:700;margin:2px 0 1px}',
    '.lq-cc{font-size:10px;color:' + C.muted + '}',
    '.lq-sec{font-size:9.5px;font-weight:700;color:' + C.muted + ';letter-spacing:.8px;text-transform:uppercase;margin:16px 0 6px}',
    '.lq-row{display:flex;justify-content:space-between;padding:5px 0;border-bottom:1px solid ' + C.rowbd + ';font-size:11.5px}',
    '.lq-lab{color:' + C.muted + '}',
    '.lq-val{font-family:ui-monospace,monospace;font-weight:600;white-space:nowrap}',
    '.lq-sm{font-size:9.5px;color:' + C.foot + '}',
    '.lq-vig{margin-top:14px;padding:9px 13px;background:' + C.amberBg + ';border:1px solid ' + C.amberBd + ';border-radius:9px;font-size:10.5px;line-height:1.5;color:' + C.amber + '}',
    '.lq-desg{margin-top:6px;border:1px solid ' + C.bd + ';border-radius:9px;overflow:hidden}',
    '.lq-d{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;padding:9px 13px;border-bottom:1px solid ' + C.rowbd + '}',
    '.lq-d:last-child{border-bottom:none}',
    '.lq-d .t{font-size:11.5px;font-weight:600}',
    '.lq-d .s{font-size:9.5px;color:' + C.foot + ';margin-top:1px}',
    '.lq-d .v{font-family:ui-monospace,monospace;font-size:12.5px;font-weight:600;white-space:nowrap}',
    '.lq-total{margin-top:11px;padding:13px 16px;border-radius:9px;display:flex;justify-content:space-between;align-items:center;gap:14px;background:' + C.redBg + ';border:1px solid ' + C.redBd + '}',
    '.lq-total .q{font-size:11px;font-weight:700;color:' + C.red + ';letter-spacing:.4px;text-transform:uppercase}',
    '.lq-total .qs{font-size:9.5px;color:' + C.foot + ';margin-top:2px;font-weight:400;letter-spacing:0;text-transform:none}',
    '.lq-total .v{font-size:25px;font-weight:700;font-family:ui-monospace,monospace;color:' + C.red + ';white-space:nowrap}',
    // 8 columnas en ~640px utiles: padding lateral 4px, tipografia 9/10px y nowrap
    // (mismo tratamiento que absorbio la 7a columna del cronograma en v1.18.0).
    'table{width:100%;border-collapse:collapse;font-size:10px}',
    'th{text-align:left;background:' + C.panel + ';color:' + C.muted + ';font-size:9px;letter-spacing:.3px;text-transform:uppercase;padding:5px 4px;border-bottom:1px solid ' + C.bd + ';white-space:nowrap}',
    'td{padding:4px;border-bottom:1px solid ' + C.rowbd + ';white-space:nowrap}',
    'td.n,th.n{text-align:right;font-family:ui-monospace,monospace}',
    'tr.ab td{background:' + C.blueBg + ';color:' + C.blue + ';font-weight:600}',
    'tr.tot td{background:' + C.panel + ';font-weight:700;border-top:2px solid ' + C.bd + ';border-bottom:none}',
    '.bdg{display:inline-block;font-size:8.5px;font-weight:700;padding:1px 5px;border-radius:4px;letter-spacing:.2px}',
    '.b-ok{background:' + C.blueBg + ';color:' + C.blue + '}',
    '.b-mora{background:' + C.redBg + ';color:' + C.red + '}',
    '.b-par{background:' + C.amberBg + ';color:' + C.amber + '}',
    '.b-pen{background:' + C.panel + ';color:' + C.muted + '}',
    '.lq-pagar{margin-top:13px;padding:10px 13px;background:' + C.panel + ';border:1px solid ' + C.bd + ';border-radius:9px}',
    '.lq-pagar .h{font-size:9.5px;font-weight:700;color:' + C.muted + ';letter-spacing:.6px;text-transform:uppercase;margin-bottom:4px}',
    '.lq-pagar .b{font-size:10.5px;line-height:1.55}',
    '.lq-foot{margin-top:11px;padding-top:8px;border-top:1px solid ' + C.footBd + ';text-align:center;color:' + C.foot + ';font-size:9.5px;line-height:1.5}',
    '.lq-foot b{color:' + C.green + '}',
    // Inset de impresion 1.3cm (no 2cm) y secciones mas juntas: el documento tiene que
    // caber en UNA hoja aun con desglose completo, respaldo y "Como pagar" — mismo
    // ajuste que ya hizo `generateFacturaCobro` por la misma razon.
    dark ? '@media print{html,body{-webkit-print-color-adjust:exact!important;print-color-adjust:exact!important;color-adjust:exact!important}*{-webkit-print-color-adjust:exact!important;print-color-adjust:exact!important;color-adjust:exact!important}@page{margin:0}html{background:#0d1117!important}body{max-width:none;padding:1.3cm;background:#0d1117!important;color:#e6edf3!important;min-height:100vh}.lq-sec{margin:11px 0 5px}}'
         : '@media print{html,body{-webkit-print-color-adjust:exact!important;print-color-adjust:exact!important;color-adjust:exact!important}*{-webkit-print-color-adjust:exact!important;print-color-adjust:exact!important;color-adjust:exact!important}@page{margin:0}html{background:#ffffff!important}body{max-width:none;padding:1.3cm;background:#ffffff!important;color:#1f2328!important;min-height:100vh}.lq-sec{margin:11px 0 5px}}',
    '</style></head><body>',

    '<div class="lq-head"><div class="lq-brand">',
    '<svg width="32" height="32" viewBox="0 0 36 36" xmlns="http://www.w3.org/2000/svg"><rect width="36" height="36" rx="9" fill="' + C.green + '"/><text x="18" y="25" font-family="Arial,sans-serif" font-size="21" font-weight="700" fill="#ffffff" text-anchor="middle">C</text></svg>',
    '<div><div class="lq-wm">Cartera</div><div class="lq-sub">Gestion de cartera de credito</div></div></div>',
    '<div class="lq-meta"><div class="lq-type">Estado de Liquidacion</div><div class="lq-num">' + lqCode + '</div>',
    '<div class="lq-date">Emision: ' + fechaEmision + '</div></div></div>',

    '<div class="lq-st">Liquidacion del credito de</div>',
    '<div class="lq-name">' + esc(loan.nombre) + '</div>',
    (deudorMeta ? '<div class="lq-cc">' + deudorMeta + '</div>' : ''),

    '<div class="lq-vig"><b>Este valor es valido unicamente para el ' + fmtD(hasta) + '.</b> ' +
      (L.capitalPendiente > 0
        ? 'El credito sigue generando intereses, asi que a partir del dia siguiente el monto a pagar cambia. Si el deudor liquida en otra fecha, solicita un documento actualizado.'
        : 'El capital ya fue devuelto en su totalidad.') + '</div>',

    '<div class="lq-sec">Condiciones del credito</div>',
    row('Capital prestado', money(origCOP)),
    row('Modalidad', esc(loan.modalidad)),
    row('Tasa', tasaTxt),
    row('Fecha de inicio', fmtD(loan.fechaInicio)),
    (diario ? '' : row('Plazo', (loan.modalidad === 'Intereses' ? 'Indefinido'
              : (loan.plazoMeses || 0) + ' cuota' + ((loan.plazoMeses || 0) === 1 ? '' : 's')))),

    '<div class="lq-sec">Desglose de la liquidacion</div>',
    '<div class="lq-desg">' + desglose.join('') + '</div>',

    '<div class="lq-total"><div><div class="q">Total a liquidar hoy</div>',
    '<div class="qs">Con este pago el credito queda cancelado en su totalidad</div></div>',
    '<div class="v">' + money(L.total) + '</div></div>',

    '<div class="lq-sec">Respaldo &middot; historial del credito al ' + fmtD(hasta) + '</div>',
    respaldo,
    '<div class="lq-sm" style="margin-top:5px">' + notaRespaldo + '</div>',

    comoPagar,

    '<div class="lq-foot">Documento informativo de liquidacion. No constituye recibo de pago.',
    '<br>Generado por <b>Cartera</b> &nbsp;&middot;&nbsp; ' + lqCode + ' &nbsp;&middot;&nbsp; ' + fechaEmision + '</div>',
    '</body></html>'
  ].join('\n');

  // Sin `fmt()` en el nombre de archivo: inserta un espacio duro U+00A0 tras el '$'
  // que ensucia el nombre en disco (leccion de v1.17.1).
  var fname = 'Liquidacion ' + loan.nombre + ' - ' + hasta;
  if (window.electronAPI && window.electronAPI.printPDF) {
    window.electronAPI.printPDF(html, fname);
  } else {
    var w = window.open('', '_blank', 'width=750,height=800');
    w.document.write(html); w.document.close();
    w.onload = function(){ w.print(); };
  }
}
