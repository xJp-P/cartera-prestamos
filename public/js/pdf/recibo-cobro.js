// public/js/pdf/recibo-cobro.js — Comprobante CONSOLIDADO de un cobro en cascada.
//
// Un cobro en cascada son N movimientos contra endpoints distintos (`/partial` por
// cada cuota vencida, `/abono` por el remanente), pero para el cliente fue UNA sola
// entrega de dinero. Este documento es el papel que se le devuelve: cuanto entrego,
// contra que se aplico y como quedo su credito.
//
// ── POR QUE NO ALCANZABAN LOS RECIBOS QUE YA EXISTIAN ────────────────────────
// `generateReciboAbono` cuelga de un unico call site (`_doAbono`) y describe UN
// abono; una cascada lo dejaria declarando solo el ultimo paso y callando los
// intereses de mora cobrados. `generateRecibo` documenta el pago de UNA cuota. Y
// nada en el esquema ata los movimientos de un mismo cobro: `payments` no tiene
// columna de correlacion, el id `-ab-` no existe si el cobro fue solo de mora, y
// agrupar por fecha fusionaria dos cobros del mismo dia al mismo credito. Por eso
// la correlacion se pasa aqui como parametro, desde quien acaba de ejecutarla.
//
// ── DE DONDE SALEN LOS DATOS (regla que no se negocia) ───────────────────────
// De `cobro.pasos`, que es `estado.hechos` del orquestador: lo que EFECTIVAMENTE
// se aplico. NUNCA de `plan.pasos`, que es lo que se pretendia aplicar. Si un paso
// falla, un recibo armado desde el plan declara dinero que no se registro — la
// clase de falla del Bug #45. Los totales tambien se DERIVAN de los pasos, no se
// copian de `plan.totales`, para que la regla se cumpla literalmente.
//
// Coherente con eso, `_doCobroCascada` solo llama aqui cuando la cadena entera
// tuvo exito: en un fallo parcial la suma de caja de los pasos aplicados es MENOR
// que lo que el cliente entrego, asi que el recibo declararia menos dinero del que
// recibio y se volveria evidencia en su contra.
//
// DOCTRINA (v2.3.0): el papel no puede contradecir a la app. El saldo sale de
// `saldoConCaja`, nunca del motor.

import { fmt, fmtUSD, fmtD } from '../core/format.js';
import { nowStr, properCase } from '../core/ui.js';
import { saldoConCaja, esDiario, pendCuota } from '../core/dominio.js';
import { esAbono } from '../core/ids.js';

// ── Recibo de Cobro (consolidado) ────────────────────────────────────────────
// `cobro` = { fecha, pasos, pre, observaciones }
//   - pasos: los del orquestador ya aplicados. Cada uno trae `obligacionCOP`
//     (deuda extinguida), `cajaCOP` (pesos reales que entraron), `interes` y
//     `capital`; los `partial` ademas `cuotaN`, `fechaPago`, `salda` y
//     `restanteCuota`, y en USD el `obligacionUSD` exacto.
//   - pre: snapshot ANTERIOR al cobro (`_snapshotAbono`), para el antes/despues.
//
// 2 variantes: RECIBO (credito con saldo vivo) y PAZ Y SALVO (el cobro lo salda).
export function generateReciboCobro(loan, allPays, cobro, opts) {
  cobro = cobro || {}; opts = opts || {};
  if (!loan) return;
  // Un credito de interes diario no tiene cuotas y queda fuera de la cascada: su
  // puerta es el CORTE y su comprobante `generateReciboCorte`. Inalcanzable hoy,
  // pero si algun dia se alcanzara imprimiria un documento sin sentido.
  if (esDiario(loan)) return;
  var pasos = (cobro.pasos || []).filter(Boolean);
  // Sin movimientos aplicados no hay nada que certificar. Emitir un recibo en
  // blanco seria peor que no emitir ninguno.
  if (!pasos.length) return;

  var dark  = document.documentElement.getAttribute('data-theme') === 'dark';
  var esUSD = loan.moneda === 'USD';
  var trm   = +loan.trmAcordada || 1;
  var pre   = cobro.pre || {};
  var esCapInt = loan.modalidad === 'Capital + Intereses';
  var esIndef  = loan.modalidad === 'Intereses';
  var fechaCobro   = cobro.fecha || nowStr();
  var fechaEmision = new Date().toLocaleDateString('es-CO', {day:'2-digit', month:'long', year:'numeric'});

  function esc(s){ return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
  function campoValido(v){ v = String(v == null ? '' : v).trim(); return v !== '' && v !== '0'; }

  // ── Aritmetica en la unidad de la MONEDA VISIBLE ───────────────────────────
  // Centavos de dolar en USD, pesos en COP. Reconciliar en COP y convertir despues
  // descuadra un centavo (Bug #31): round(363.25)+round(96.74) != round(460.00).
  // Todo lo que deba sumar se resta sobre valores YA redondeados a lo que se imprime.
  function uni(cop){ return esUSD ? Math.round((cop || 0) / trm * 100) : Math.round(cop || 0); }
  function fmtUni(u){ return esUSD ? fmtUSD((u || 0) / 100) : fmt(u || 0); }
  function money(cop){ return fmtUni(uni(cop)); }

  // ── Totales DERIVADOS de los pasos aplicados ───────────────────────────────
  var partials = pasos.filter(function(p){ return p.tipo === 'partial'; });
  var abonos   = pasos.filter(function(p){ return p.tipo === 'abono'; });
  var oblPartialsU = partials.reduce(function(s,p){ return s + uni(p.obligacionCOP); }, 0);
  var intU     = partials.filter(function(p){ return !p.esInteresMes; })
                         .reduce(function(s,p){ return s + uni(p.interes); }, 0);
  // El interes del PERIODO EN CURSO se declara aparte del vencido. Sumarlos hacia que el
  // recibo rotulara "Intereses vencidos" un interes que aun no vencia: medido en una
  // prueba real, un cobro del 3 de sept declaraba atrasada una cuota que vence el 19. El
  // documento le imputaba al cliente una mora que no existio.
  var mesU     = pasos.filter(function(p){ return p.esInteresMes; })
                      .reduce(function(s,p){ return s + uni(p.interes); }, 0);
  // El capital de mora se ANCLA al total de los pasos de mora (capital = cuota - interes,
  // doctrina v1.18.0): asi absorbe el residuo de redondeo de las filas legacy (Bug #43)
  // en vez de dejar un descuadre visible entre los rubros y el total.
  var capMoraU = Math.max(0, oblPartialsU - intU - mesU);
  var abonoU   = abonos.reduce(function(s,p){ return s + uni(p.obligacionCOP); }, 0);
  var aplicadoU = intU + mesU + capMoraU + abonoU;
  // CAJA: los pesos que entraron de verdad ese dia (doctrina CAJA vs OBLIGACION).
  // El orquestador reparte la caja entre los pasos y el ultimo absorbe el residuo,
  // asi que esta suma es EXACTAMENTE lo que el usuario declaro haber recibido.
  var cajaCOP  = pasos.reduce(function(s,p){ return s + Math.round(p.cajaCOP || 0); }, 0);
  var oblUSD   = esUSD ? pasos.reduce(function(s,p){ return s + (+p.obligacionUSD || 0); }, 0) : 0;
  var trmImpl  = (esUSD && oblUSD > 0) ? Math.round(cajaCOP / oblUSD) : 0;

  // ── Estado del credito DESPUES (datos ya persistidos y recargados) ─────────
  var lp = (allPays || []).filter(function(p){ return String(p.prestamoId) === String(loan.id); });
  var saldoDespues = saldoConCaja(loan, lp);
  var esPazYSalvo  = saldoDespues <= 0 || loan.estado === 'Finalizado';
  // Mismo blindaje que el Recibo de Abono: un "PAZ Y SALVO" con saldo > 0 seria un
  // documento que se contradice a si mismo ante cualquier desfase de la formula.
  if (esPazYSalvo) saldoDespues = 0;
  var saldoAntes = (pre.saldoCaja != null) ? pre.saldoCaja
                 : ((pre.saldo != null) ? pre.saldo : saldoDespues);

  var pend = lp.filter(function(p){ return !esAbono(p) && p.estadoPago === 'Pendiente'; })
               .sort(function(a,b){ return a.cuotaN - b.cuotaN; });
  var cuotaDespues = pend.length ? Math.round(pend[0].cuotaTotal) : 0;
  var proxVence    = pend.length ? pend[0].fechaPago : null;
  // Mora que SOBREVIVE al cobro: si el cliente pago solo una parte, el recibo tiene
  // que decirlo. Sin esta linea el documento se leeria como "estas al dia".
  var moraViva = lp.filter(function(p){ return !esAbono(p) && p.estadoPago === 'En Mora'; })
                   .reduce(function(s,p){ return s + pendCuota(p); }, 0);

  // Codigo: RC-[2 iniciales]-[3 ultimos del loanId]-[DDMM del cobro]
  // Lista blanca CON dieresis y diacriticos (misma que estado-liquidacion): un
  // apellido con dieresis o con enye conserva sus iniciales en vez de saltarse letras.
  var ini = properCase(loan.nombre || '').replace(/[^A-Za-zÁÉÍÓÚÜÑáéíóúüñ]/g,'').slice(0,2);
  var rcCode = 'RC-' + (ini || 'XX') + '-' + String(loan.id || '').slice(-3) + '-' +
               String(fechaCobro).slice(8,10) + String(fechaCobro).slice(5,7);

  var C = dark ? {
    bg:'#0d1117', text:'#e6edf3', muted:'#8b949e', bd:'#30363d', rowbd:'#21262d', panel:'#161b22',
    green:'#3fb950', greenBg:'#0f2b19', greenBd:'#1b4332',
    red:'#f85149', redBg:'#2d1214', redBd:'#5c2226',
    amber:'#d29922', amberBg:'#2b2005', amberBd:'#3d2e08',
    blue:'#58a6ff', blueBg:'#0d2136', blueBd:'#1f3d5c',
    headBd:'#30363d', foot:'#6e7681', footBd:'#30363d'
  } : {
    bg:'#ffffff', text:'#1f2328', muted:'#656d76', bd:'#d0d7de', rowbd:'#eeeeee', panel:'#f6f8fa',
    green:'#166534', greenBg:'#f0fdf4', greenBd:'#4ade80',
    red:'#cf222e', redBg:'#ffebe9', redBd:'#ffcecb',
    amber:'#9a6700', amberBg:'#fff8e1', amberBd:'#eac54f',
    blue:'#0969da', blueBg:'#ddf4ff', blueBd:'#54aeff',
    headBd:'#333333', foot:'#8c959f', footBd:'#dddddd'
  };

  function row(l, v, color){
    return '<div class="rc-row"><span class="rc-lab">' + l + '</span>' +
           '<span class="rc-val"' + (color ? ' style="color:' + color + '"' : '') + '>' + v + '</span></div>';
  }
  function rowTot(l, v){
    return '<div class="rc-row rc-row-tot"><span class="rc-lab">' + l + '</span><span class="rc-val">' + v + '</span></div>';
  }
  function card(label, oldTxt, newTxt, nota){
    return '<div class="rc-card"><div class="rc-cl">' + label + '</div>' +
      (oldTxt ? '<div class="rc-old">' + oldTxt + '</div>' : '') +
      '<div class="rc-new">' + newTxt + '</div>' +
      (nota ? '<div class="rc-cnota">' + nota + '</div>' : '') + '</div>';
  }

  // ── BLOQUE 3 — "Como se aplico tu pago" ────────────────────────────────────
  // Es el mismo desglose que el modal muestra ANTES de cobrar, para que lo que el
  // usuario aprobo y lo que el cliente se lleva sean el mismo documento.
  var pasosHTML = pasos.map(function(p, i){
    var totU  = uni(p.obligacionCOP);
    var pIntU = uni(p.interes);
    // Capital reconciliado en la moneda visible (nunca `p.capital` crudo).
    var pCapU = Math.max(0, totU - pIntU);
    var esMora = p.tipo === 'partial';
    var titulo = p.esInteresMes ? ('Interes del mes &middot; cuota #' + p.cuotaN)
               : esMora ? ('Cuota #' + p.cuotaN + ' vencida') : 'Abono extraordinario a capital';
    var chip = p.esInteresMes
      ? '<span class="rc-chip rc-chip-b">POR ADELANTADO</span>'
      : esMora
      ? (p.salda ? '<span class="rc-chip rc-chip-g">SE SALDA</span>'
                 : '<span class="rc-chip rc-chip-a">ABONO PARCIAL</span>')
      : '';
    var det = [];
    // El tiempo verbal importa: esta cuota NO vencio, se pago por adelantado.
    if (p.esInteresMes && p.fechaPago) det.push('aun no vence (' + fmtD(p.fechaPago) + ')');
    else if (esMora && p.fechaPago) det.push('vencia el ' + fmtD(p.fechaPago));
    if (pIntU > 0) det.push('intereses <b style="color:' + C.red + '">' + fmtUni(pIntU) + '</b>');
    if (pCapU > 0) det.push('capital <b>' + fmtUni(pCapU) + '</b>');
    // OJO: `restanteCuota` se calcula al PLANEAR. Si despues viene un abono con recalculo,
    // el cronograma se regenera y esa cifra deja de ser cierta — medido: el recibo decia
    // "queda debiendo USD 243.38" cuando la cuota ya solo debia USD 117.65. Lo pendiente se
    // declara UNA vez, con datos persistidos, en el bloque "Lo que queda por pagar".
    if (esMora && !p.esInteresMes && !p.salda && p.restanteCuota > 0) det.push('queda debiendo <b style="color:' + C.amber + '">' + money(p.restanteCuota) + '</b>');
    if (!esMora) det.push('reduce el capital vivo y no genera intereses futuros');
    return '<div class="rc-paso"><div class="rc-paso-h">' +
      '<span class="rc-n">' + (i + 1) + '</span>' +
      '<span class="rc-paso-t">' + titulo + '</span>' + chip +
      '<span class="rc-paso-v">' + fmtUni(totU) + '</span></div>' +
      (det.length ? '<div class="rc-paso-d">' + det.join(' &nbsp;&middot;&nbsp; ') + '</div>' : '') +
      '</div>';
  }).join('');

  var totalesHTML = '<div class="rc-panel">' +
    (intU     > 0 ? row('Intereses vencidos',             fmtUni(intU),     C.red)   : '') +
    (mesU     > 0 ? row('Interes del mes en curso',       fmtUni(mesU),     C.blue)  : '') +
    (capMoraU > 0 ? row('Capital de cuotas vencidas',     fmtUni(capMoraU), '')      : '') +
    (abonoU   > 0 ? row('Abono extraordinario a capital', fmtUni(abonoU),   C.green) : '') +
    rowTot('Total aplicado', fmtUni(aplicadoU)) +
    // En USD la caja se declara aparte: es la unica cifra que registra el efecto
    // cambiario del dia frente a la deuda valuada a la TRM pactada.
    (esUSD ? row('Caja registrada en pesos', fmt(cajaCOP) +
      (trmImpl > 0 ? ' <span style="font-size:10px;opacity:.8">(TRM ' + fmt(trmImpl) + ')</span>' : '')) : '') +
    '</div>';

  // ── BLOQUE 4 — "Tu credito despues de este pago" ───────────────────────────
  // Resumen, NO el cronograma completo: el bloque 3 ya es de largo variable y el
  // documento tiene que caber en una hoja. El cronograma es otro documento.
  var despuesHTML = '', quedaHTML = '';
  if (!esPazYSalvo) {
    // ── LO QUE QUEDA POR PAGAR ──
    // Se computa ANTES de las tarjetas porque la primera de ellas lidera con este total.
    // OJO CON EL ORDEN: `var` es hoisted, asi que leerlo mas arriba no daria error, daria
    // `undefined` — y la tarjeta desapareceria del PDF que va al cliente en silencio. Es
    // literalmente el Bug #63, cometido en el modal de al lado.
    //
    // Sale de las filas PERSISTIDAS tras el cobro, no del plan: si el abono regenero el
    // cronograma, esto ya refleja el nuevo. Incluye las vencidas —tambien son dinero por
    // cobrar— marcadas en rojo mas abajo.
    var porPagar = lp.filter(function(p){
      return !esAbono(p) && (p.estadoPago === 'Pendiente' || p.estadoPago === 'En Mora') && pendCuota(p) > 0;
    }).sort(function(a,b){
      var d = String(a.fechaPago || '').localeCompare(String(b.fechaPago || ''));
      return d !== 0 ? d : ((a.cuotaN || 0) - (b.cuotaN || 0));
    });
    var totalFalta = porPagar.reduce(function(s,p){ return s + pendCuota(p); }, 0);

    // La PRIMERA tarjeta es "Total por pagar": la MISMA cifra con la que abre la Propuesta
    // de Abono, el papel que se le manda al cliente ANTES de cobrar. Hasta aqui cada
    // documento lideraba con algo distinto en el mismo lugar visual —la propuesta con el
    // total, el recibo con el saldo de capital—. Las dos cifras eran correctas (una lleva
    // los intereses de las cuotas que faltan y la otra no), pero puestas en el mismo sitio
    // de dos papeles de la MISMA operacion se leian como una contradiccion. La nota es lo
    // que las concilia, y por eso las dos tarjetas viajan juntas en vez de sustituirse.
    //
    // SOLO donde el cronograma CONTIENE toda la deuda, y esa condicion no es teorica:
    //  - en modalidad `Intereses` las cuotas son de puro interes y el capital vence al
    //    final, FUERA de la tabla. Sumarlas da un total MENOR que el capital adeudado, o
    //    sea lo contrario de lo que el rotulo promete (medido sobre un credito real del
    //    fixture: "Total por pagar 2.700.000" junto a "Saldo de capital 3.000.000"). Es
    //    ademas donde la Propuesta lo omite sola, porque su preview del cronograma solo
    //    existe en `Capital + Intereses` — asi que gatearlo aqui es lo que mantiene a los
    //    dos papeles diciendo lo mismo, no una excepcion a esa regla.
    //  - si la cifra COINCIDE con el saldo de capital tampoco se dibuja: en `Prestamo`
    //    (0% interes) la cuota unica ES el capital, y dos tarjetas con el mismo numero se
    //    leen como un error del documento. Se comparan los valores YA FORMATEADOS, que es
    //    la condicion real ("el lector ve dos veces lo mismo"), no los COP subyacentes.
    //
    // La TABLA de abajo conserva su fila TOTAL POR PAGAR en todos los casos: alli es el
    // total de las filas que se estan listando —con "Plazo: Indefinido" a la vista— y no
    // un titular sobre la deuda entera.
    var totalTxt = money(totalFalta);
    var cards = (porPagar.length && !esIndef && totalTxt !== money(saldoDespues))
      ? card('Total por pagar',
          (pre.totalPorPagar > totalFalta) ? money(pre.totalPorPagar) : '', totalTxt,
          'capital + intereses')
      : '';
    cards += card('Saldo de capital',
      (saldoAntes > saldoDespues) ? money(saldoAntes) : '', money(saldoDespues));
    if (cuotaDespues > 0) {
      // "Valor de la cuota" es el importe CONTRACTUAL que rige de aqui en adelante, y no
      // tiene por que coincidir con lo que falta de la PROXIMA: si el cliente adelanto el
      // interes del mes, esa cuota ya trae abono encima. Sin decirlo, el documento
      // mostraba 157.79 arriba y 117.65 en la tabla de abajo, de la misma cuota, sin nada
      // que los uniera — parecian contradecirse. La nota es el puente, y solo aparece
      // cuando de verdad hay diferencia que explicar.
      var abonadoProx = pend.length ? Math.round(pend[0].partialPaid || 0) : 0;
      cards += card('Valor de la cuota',
        (pre.cuota && Math.round(pre.cuota) !== cuotaDespues) ? money(pre.cuota) : '', money(cuotaDespues),
        abonadoProx > 0 ? ('de la proxima ya abonaste ' + money(abonadoProx)) : '');
    }
    if (esCapInt && pend.length) cards += card('Cuotas pendientes', '', String(pend.length));
    else if (esIndef)            cards += card('Plazo', '', 'Indefinido');

    var pie = [];
    if (proxVence) pie.push('Proximo vencimiento: <b>' + fmtD(proxVence) + '</b>');
    if (moraViva > 0) pie.push('<span style="color:' + C.red + '">Aun quedan <b>' + money(moraViva) + '</b> en cuotas vencidas</span>');

    // La tarjeta de arriba RESUME el total; esta tabla lo DETALLA, cuota por cuota, con lo
    // ya abonado en cada una. Hacia falta: sin ella el recibo mostraba "saldo de capital
    // USD 117.65" junto a "valor de la cuota USD 157.79" y UNA cuota pendiente, sin forma
    // de ver que la diferencia era el interes del mes que el cliente acababa de adelantar
    // sobre esa misma cuota.
    if (porPagar.length) {
      var filasQ = porPagar.map(function(p){
        var abonado = Math.max(0, Math.round(p.partialPaid || 0));
        return '<tr class="' + (p.estadoPago === 'En Mora' ? 'v' : '') + '">' +
          '<td class="l">' + p.cuotaN + (p.estadoPago === 'En Mora' ? ' &middot; vencida' : '') + '</td>' +
          '<td class="l">' + fmtD(p.fechaPago) + '</td>' +
          '<td>' + money(p.cuotaTotal) + '</td>' +
          '<td>' + (abonado > 0 ? money(abonado) : '&mdash;') + '</td>' +
          '<td><b>' + money(pendCuota(p)) + '</b></td></tr>';
      }).join('');
      quedaHTML = '<div class="rc-st">Lo que queda por pagar</div>' +
        '<table class="rc-qt"><thead><tr>' +
        '<th class="l">CUOTA</th><th class="l">VENCE</th><th>VALOR CUOTA</th><th>YA ABONADO</th><th>FALTA</th>' +
        '</tr></thead><tbody>' + filasQ + '</tbody>' +
        '<tfoot><tr><td class="l" colspan="4">TOTAL POR PAGAR</td><td>' + money(totalFalta) + '</td></tr></tfoot>' +
        '</table>';
    }

    despuesHTML = '<div class="rc-st">Tu credito despues de este pago</div>' +
      '<div class="rc-imp">' + cards + '</div>' +
      (pie.length ? '<div class="rc-pie">' + pie.join(' &nbsp;&middot;&nbsp; ') + '</div>' : '') +
      quedaHTML;
  }

  // CSS que solo se emite si el documento lo usa. Incondicional metia ~570 bytes muertos
  // en cada recibo, incluidos los Paz y Salvo, que no llevan bloque 4 ni tabla.
  var cssExtra = []
    .concat(pasos.some(function(p){ return p.esInteresMes; })
      ? ['.rc-chip-b{background:' + C.blueBg + ';color:' + C.blue + ';border:1px solid ' + C.blueBd + '}'] : [])
    .concat(quedaHTML
      ? ['.rc-qt{width:100%;border-collapse:collapse;margin-top:5px;font-size:10.5px}',
         '.rc-qt th{text-align:right;font-size:8.5px;letter-spacing:.4px;color:' + C.muted + ';font-weight:700;padding:3px 5px;border-bottom:1px solid ' + C.bd + ';white-space:nowrap}',
         '.rc-qt th.l,.rc-qt td.l{text-align:left}',
         '.rc-qt td{text-align:right;padding:4px 5px;border-bottom:1px solid ' + C.rowbd + ';white-space:nowrap}',
         '.rc-qt tr.v td{color:' + C.red + '}',
         '.rc-qt tfoot td{border-bottom:none;border-top:1px solid ' + C.bd + ';font-weight:700;padding-top:5px}'] : []);

  var pazHTML = esPazYSalvo
    ? '<div class="rc-paz"><div class="rc-paz-t">PAZ Y SALVO</div>' +
      '<div class="rc-paz-s">Con este pago queda <b>cancelada la totalidad</b> del credito. No queda saldo pendiente.</div></div>'
    : '';

  // La nota explica POR QUE el dinero fue a donde fue. Es la razon de ser del
  // documento: un cobro en cascada reparte una sola entrega entre varias
  // obligaciones, y sin esta linea el reparto parece arbitrario.
  var notaHTML = (pasos.length > 1)
    ? '<div class="rc-nota"><b>Como se imputa el pago:</b> primero a los intereses ya vencidos, ' +
      'luego al capital de las cuotas vencidas y, si sobra, como abono extraordinario a capital ' +
      '(articulo 1653 del Codigo Civil). Cada movimiento queda registrado por separado.</div>'
    : '';

  var obsHTML = campoValido(cobro.observaciones)
    ? '<div class="rc-obs"><b>Observaciones:</b> ' + esc(String(cobro.observaciones).trim()) + '</div>' : '';

  var deudorMeta = [ campoValido(loan.cedula)   ? ('C.C. ' + esc(String(loan.cedula).trim()))   : '',
                     campoValido(loan.telefono) ? ('Tel. ' + esc(String(loan.telefono).trim())) : '' ]
                   .filter(Boolean).join(' &nbsp;&middot;&nbsp; ');
  var titulo  = esPazYSalvo ? 'Paz y Salvo' : 'Recibo de Cobro';
  // USD protagonista: en un credito en dolares el cliente entrego dolares, y esa es
  // la cifra que reconoce. Los pesos van debajo, como caja del dia.
  var heroTxt = esUSD ? fmtUSD(oblUSD) : fmt(cajaCOP);
  var heroSub = esUSD ? ('Equivalen a ' + fmt(cajaCOP) +
                (trmImpl > 0 ? ' &nbsp;&middot;&nbsp; TRM del dia ' + fmt(trmImpl) : '')) : '';

  var html = [
    '<!DOCTYPE html><html><head><meta charset="utf-8"><title>' + titulo + '</title>',
    '<style>',
    '*{margin:0;padding:0;box-sizing:border-box}',
    'body{font-family:Arial,Helvetica,sans-serif;padding:22px;max-width:640px;margin:0 auto;color:' + C.text + ';background:' + C.bg + ';line-height:1.3;font-variant-numeric:tabular-nums}',
    '.rc-head{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;padding-bottom:10px;border-bottom:2px solid ' + C.headBd + '}',
    '.rc-brand{display:flex;align-items:center;gap:10px}',
    '.rc-wm{font-size:19px;font-weight:700;color:' + C.text + ';line-height:1.1}',
    '.rc-sub{font-size:10px;color:' + C.muted + ';margin-top:2px}',
    '.rc-meta{text-align:right}',
    '.rc-type{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:' + C.muted + '}',
    '.rc-num{font-size:15px;font-weight:700;color:' + C.text + ';margin-top:3px}',
    '.rc-date{font-size:11px;color:' + C.muted + ';margin-top:3px}',
    '.rc-st{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:' + C.muted + ';margin:13px 0 5px}',
    '.rc-name{font-size:16px;font-weight:700;color:' + C.text + '}',
    '.rc-cc{font-size:12px;color:' + C.muted + ';margin-top:2px}',
    '.rc-total{margin:12px 0 4px;padding:14px;text-align:center;background:' + C.greenBg + ';border:2px solid ' + C.greenBd + ';border-radius:14px}',
    '.rc-tl{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:2px;color:' + C.green + '}',
    '.rc-ta{font-size:32px;font-weight:700;color:' + C.green + ';line-height:1.05;margin:3px 0 0;letter-spacing:-1px}',
    '.rc-ts{font-size:11px;color:' + C.muted + ';margin-top:4px}',
    '.rc-chipf{display:inline-block;margin-top:7px;background:' + C.bg + ';border:1px solid ' + C.greenBd + ';color:' + C.green + ';border-radius:20px;padding:3px 13px;font-size:11px;font-weight:700}',
    '.rc-paso{border:1px solid ' + C.bd + ';border-radius:9px;padding:8px 11px;margin-top:6px;background:' + C.panel + '}',
    '.rc-paso-h{display:flex;align-items:center;gap:7px}',
    '.rc-n{width:17px;height:17px;border-radius:99px;background:' + C.greenBg + ';color:' + C.green + ';font-size:9.5px;font-weight:700;display:inline-block;text-align:center;line-height:17px;flex-shrink:0}',
    '.rc-paso-t{font-size:12px;font-weight:700;color:' + C.text + '}',
    '.rc-paso-v{margin-left:auto;font-size:13px;font-weight:700;color:' + C.text + ';white-space:nowrap}',
    '.rc-paso-d{font-size:10.5px;color:' + C.muted + ';margin-top:3px;padding-left:24px;line-height:1.45}',
    '.rc-chip{font-size:8.5px;font-weight:700;letter-spacing:.4px;padding:2px 6px;border-radius:5px}',
    '.rc-chip-g{background:' + C.greenBg + ';color:' + C.green + ';border:1px solid ' + C.greenBd + '}',
    '.rc-chip-a{background:' + C.amberBg + ';color:' + C.amber + ';border:1px solid ' + C.amberBd + '}',
    '.rc-panel{background:' + C.panel + ';border:1px solid ' + C.bd + ';border-radius:10px;padding:6px 14px;margin-top:9px}',
    '.rc-row{display:flex;justify-content:space-between;align-items:baseline;padding:5px 0;border-bottom:1px solid ' + C.rowbd + '}',
    '.rc-row:last-child{border-bottom:none}',
    '.rc-lab{font-size:12px;color:' + C.muted + '}',
    '.rc-val{font-size:13px;font-weight:600;color:' + C.text + ';text-align:right}',
    '.rc-row-tot{border-top:1px solid ' + C.bd + ';padding-top:7px;margin-top:2px}',
    '.rc-row-tot .rc-lab{font-weight:700;color:' + C.text + '}',
    '.rc-row-tot .rc-val{color:' + C.green + ';font-size:15px;font-weight:700}',
    '.rc-imp{display:flex;gap:8px;margin-top:4px}',
    '.rc-card{flex:1;background:' + C.panel + ';border:1px solid ' + C.bd + ';border-radius:9px;padding:9px 10px;text-align:center}',
    '.rc-cl{font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:' + C.muted + '}',
    '.rc-old{font-size:11px;color:' + C.muted + ';text-decoration:line-through;margin-top:3px}',
    '.rc-new{font-size:15px;font-weight:700;color:' + C.green + ';margin-top:1px}',
    '.rc-cnota{font-size:9px;color:' + C.muted + ';margin-top:3px;line-height:1.35}',
    '.rc-pie{font-size:11px;color:' + C.muted + ';margin-top:6px;text-align:center;line-height:1.45}',
    '.rc-paz{margin:12px 0 4px;padding:14px;text-align:center;background:' + C.greenBg + ';border:2px solid ' + C.greenBd + ';border-radius:14px}',
    '.rc-paz-t{font-size:20px;font-weight:700;letter-spacing:2px;color:' + C.green + '}',
    '.rc-paz-s{font-size:12px;color:' + C.text + ';margin-top:5px}',
    '.rc-nota{margin-top:10px;padding:8px 12px;background:' + C.amberBg + ';border:1px solid ' + C.amberBd + ';border-radius:9px;font-size:10.5px;line-height:1.45;color:' + C.amber + '}',
    '.rc-obs{margin-top:8px;padding:7px 12px;background:' + C.panel + ';border:1px solid ' + C.bd + ';border-radius:9px;font-size:11px;color:' + C.muted + ';line-height:1.4}',
    '.rc-foot{margin-top:14px;padding-top:9px;border-top:1px solid ' + C.footBd + ';text-align:center;color:' + C.foot + ';font-size:10px;line-height:1.5}',
    '.rc-foot b{color:' + C.green + '}',
    dark ? '@media print{html,body{-webkit-print-color-adjust:exact!important;print-color-adjust:exact!important;color-adjust:exact!important}*{-webkit-print-color-adjust:exact!important;print-color-adjust:exact!important;color-adjust:exact!important}@page{margin:0}html{background:#0d1117!important}body{max-width:none;padding:1.3cm;background:#0d1117!important;color:#e6edf3!important;min-height:100vh}}'
         : '@media print{html,body{-webkit-print-color-adjust:exact!important;print-color-adjust:exact!important;color-adjust:exact!important}*{-webkit-print-color-adjust:exact!important;print-color-adjust:exact!important;color-adjust:exact!important}@page{margin:0}html{background:#ffffff!important}body{max-width:none;padding:1.3cm;background:#ffffff!important;color:#1f2328!important;min-height:100vh}}',
  ].concat(cssExtra).concat([
    '</style></head><body>',
    '<div class="rc-head"><div class="rc-brand">',
    '<svg width="34" height="34" viewBox="0 0 36 36" xmlns="http://www.w3.org/2000/svg"><rect width="36" height="36" rx="9" fill="' + C.green + '"/><text x="18" y="25" font-family="Arial,sans-serif" font-size="21" font-weight="700" fill="#ffffff" text-anchor="middle">C</text></svg>',
    '<div><div class="rc-wm">Cartera</div><div class="rc-sub">Gestion de cartera de credito</div></div></div>',
    '<div class="rc-meta"><div class="rc-type">' + titulo + '</div><div class="rc-num">' + rcCode + '</div><div class="rc-date">Emision: ' + fechaEmision + '</div></div></div>',
    '<div class="rc-st">Pago recibido de</div>',
    '<div class="rc-name">' + esc(loan.nombre) + '</div>',
    (deudorMeta ? '<div class="rc-cc">' + deudorMeta + '</div>' : ''),
    '<div class="rc-total"><div class="rc-tl">Total recibido</div>',
    '<div class="rc-ta">' + heroTxt + '</div>',
    (heroSub ? '<div class="rc-ts">' + heroSub + '</div>' : ''),
    '<div><span class="rc-chipf">Recibido el ' + fmtD(fechaCobro) + '</span></div></div>',
    pazHTML,
    '<div class="rc-st">Como se aplico tu pago</div>',
    pasosHTML,
    totalesHTML,
    despuesHTML,
    notaHTML,
    obsHTML,
    '<div class="rc-foot">' + (esPazYSalvo
        ? 'Este documento certifica que el credito fue cancelado en su totalidad.'
        : 'Este documento certifica el dinero recibido y la forma en que se aplico al credito.') +
      '<br>Generado por <b>Cartera</b> &nbsp;&middot;&nbsp; ' + rcCode + ' &nbsp;&middot;&nbsp; ' + fechaEmision + '</div>',
    '</body></html>'
  ]).join('\n');

  // El monto se formatea aparte: fmt() mete un espacio duro (U+00A0) tras el signo
  // de pesos que ensuciaria el nombre del archivo.
  var montoFname = esUSD ? fmtUSD(oblUSD) : ('$' + Math.round(cajaCOP).toLocaleString('es-CO'));
  var fname = esPazYSalvo ? ('Paz y Salvo ' + loan.nombre) : ('RC ' + loan.nombre + ' - ' + montoFname);
  if (window.electronAPI && window.electronAPI.printPDF) {
    window.electronAPI.printPDF(html, fname);
  } else {
    var w = window.open('', '_blank', 'width=680,height=800');
    w.document.write(html); w.document.close();
    w.onload = function() { w.print(); };
  }
}
