// public/js/app.js — la aplicacion completa.
//
// Movido desde el <script> inline de index.html en la Etapa 3 (B1) del refactor.
// Codigo VERBATIM: en este paso NO se divide nada. B1 existe unicamente para
// probar que los modulos ES funcionan en Electron, de modo que si fallan, falle
// aca y sea un `git revert` de un solo commit.
//
// Por que funcionan sin bundler: desktop/main.js hace loadURL sobre
// http://127.0.0.1:3420, no file://. Con file:// el origen seria opaco y el
// navegador rechazaria los modulos por CORS.
//
// DOS CAMBIOS DE SEMANTICA QUE TRAE `type="module"` (verificados antes de mover):
//  1. STRICT MODE implicito. Se comprobo que el bloque parsea como modulo ES:
//     sin `with`, sin octales legacy, sin parametros duplicados, sin eval.
//  2. AMBITO PROPIO: los `var`/`function` de nivel superior YA NO caen en
//     `window`. Se verifico que el codigo no dependia de eso (0 referencias a
//     `window.<simbolo top-level>`). React y ReactDOM siguen siendo globales
//     porque los dos <script src="/vendor/..."> son CLASICOS y corren ANTES:
//     un modulo es diferido por definicion.
//
// El `createRoot(...)` del final ahora corre tras parsearse el HTML (los modulos
// son diferidos), asi que #root existe con mas garantia que antes, no menos.

import { CHANGELOGS } from './datos/changelogs.js';

'use strict';
var h = React.createElement;
var useState = React.useState;
var useEffect = React.useEffect;
var useMemo = React.useMemo;
var useCallback = React.useCallback;
var createRoot = ReactDOM.createRoot;

// ── Canal de errores hacia la UI ────────────────────────────────────────────
// `App` conecta su toast con `setErrorHandler` al renderizar; hasta que lo haga
// (y en los arneses de test, que no montan la UI) los errores caen a la consola.
//
// POR QUE UN SETTER Y NO UNA VARIABLE REASIGNABLE: esto era `var _showError = null`
// reasignado desde el cuerpo de render de `App`. Bajo modulos ES un `import` es un
// binding de SOLO LECTURA, asi que esa reasignacion seria un TypeError en el primer
// render — es decir, pantalla negra, la misma clase de fallo del Bug #40. El handler
// queda encapsulado aca y se cambia llamando a una funcion, que si cruza modulos.
var _errorHandler = null;
function setErrorHandler(fn) { _errorHandler = typeof fn === 'function' ? fn : null; }
function showError(msg) {
  if (_errorHandler) _errorHandler(msg);
  else console.error(msg);
}
function handleApiError(err) {
  showError(err && err.message ? err.message : 'Error de conexion con el servidor');
}
function handleRes(r) {
  if (!r.ok) return r.text().then(function(t) { try { var j=JSON.parse(t); throw new Error(j.error||'Error del servidor'); } catch(e) { if(e.message) throw e; throw new Error('Error del servidor ('+r.status+')'); }});
  return r.json();
}
var API = {
  get:  function(url)   { return fetch(url).then(handleRes).catch(function(e){handleApiError(e);return null;}); },
  post: function(url,b) { return fetch(url,{method:'POST',  headers:{'Content-Type':'application/json'},body:JSON.stringify(b)}).then(handleRes).catch(function(e){handleApiError(e);return null;}); },
  put:  function(url,b) { return fetch(url,{method:'PUT',   headers:{'Content-Type':'application/json'},body:JSON.stringify(b)}).then(handleRes).catch(function(e){handleApiError(e);return null;}); },
  del:  function(url)   { return fetch(url,{method:'DELETE'}).then(handleRes).catch(function(e){handleApiError(e);return null;}); }
};

// ── Guarda anti doble-submit (Bug #29) ───────────────────────────────────────
// Ejecuta `fn` solo si no hay otra operacion en vuelo y libera SIEMPRE la bandera:
// al resolver, al rechazar, si `fn` no devuelve promesa (rutas que ceden el control a
// otro modal, como el pre-flight de mora) o si lanza de forma sincrona.
//
// La liberacion va en el .then y NO en un .catch a proposito: los helpers de API
// (API.get/post/put/del) atrapan el error y RESUELVEN null, nunca rechazan, asi que un
// .catch jamas correria y el boton quedaria bloqueado para siempre. El manejador de
// rechazo se conserva por si esos helpers dejaran de atrapar en el futuro.
//
// Implementacion unica y compartida: los endpoints de escritura NO son idempotentes, y
// cinco copias de esta logica serian cinco sitios donde equivocarse.
function _submitGuard(sending,setSending,fn){
  if(sending) return;
  setSending(true);
  var p;
  try{ p=fn(); }catch(e){ setSending(false); throw e; }
  if(p&&typeof p.then==='function') p.then(function(){setSending(false);},function(){setSending(false);});
  else setSending(false);
}

function pmt(r,n,pv){ return r===0?pv/n:pv*r*Math.pow(1+r,n)/(Math.pow(1+r,n)-1); }
function fmt(n)  { return new Intl.NumberFormat('es-CO',{style:'currency',currency:'COP',maximumFractionDigits:0}).format(n||0); }
function fmtUSD(n){ return 'USD $'+new Intl.NumberFormat('en-US',{minimumFractionDigits:2,maximumFractionDigits:2}).format(n||0); }
function fmtN(n) { return new Intl.NumberFormat('es-CO').format(Math.round(n||0)); }
// Proper Case (Capitalizacion de Titulos): "pa"->"Pa", "juan PEREZ"->"Juan Perez"
function properCase(s){ return String(s||'').trim().split(/\s+/).map(function(w){return w?w.charAt(0).toUpperCase()+w.slice(1).toLowerCase():w;}).join(' '); }
// Saldo restante de una cuota considerando pagos parciales
function pendCuota(p){ return Math.max(0,(p.cuotaTotal||0)-(p.partialPaid||0)); }
// Codigo de Factura de Cobro: FC-[2 primeras letras del deudor]-[ultimos 3 del loanId]-[cuota 2 digitos]
function facturaCode(p){
  if(!p) return '';
  var ini=properCase(String(p.nombreCliente||'')).replace(/\s+/g,'').slice(0,2);
  return 'FC-'+ini+'-'+String(p.prestamoId||'').slice(-3)+'-'+String(p.cuotaN||0).padStart(2,'0');
}
// Match del buscador de Pagos: si el texto empieza por "fc-" filtra por codigo de factura; si no, por nombre.
function payMatchesQuery(p,q){
  if(!q) return true;
  var ql=String(q).toLowerCase().trim();
  if(ql.indexOf('fc-')===0) return facturaCode(p).toLowerCase().indexOf(ql)!==-1;
  return String(p.nombreCliente||'').toLowerCase().indexOf(ql)!==-1;
}
// Convierte COP a USD usando TRM del préstamo; retorna string "USD $X.XX"
function copToUsd(cop,trm){ return trm>0?fmtUSD(cop/trm):''; }
// v1.11.4: eventos de caja reales de un pago. Devuelve [{fecha:'YYYY-MM-DD', cop:int}].
// Fuente de verdad = ledger payments.recibos (cada parcial en su fecha + el pago final). Si la fila
// no tiene ledger (historico previo, abonos a capital, liquidaciones de mora) cae al FALLBACK: un
// unico evento en fechaRecaudo por (montoCOPRecibido||cuotaTotal). metrics.recibido y sparkCobros
// usan ESTA funcion -> el KPI y la suma del grafico cuadran por construccion, sin doble conteo.
function cobrosDe(p){
  if(!p) return [];
  if(p.recibos){
    var arr; try{arr=JSON.parse(p.recibos);}catch(_){arr=null;}
    if(Array.isArray(arr)&&arr.length){
      return arr.filter(function(r){return r&&r.fecha&&(+r.cop)>0;})
                .map(function(r){return {fecha:String(r.fecha),cop:Math.round(+r.cop)};});
    }
  }
  if(p.estadoPago==='Pagado'&&p.fechaRecaudo){
    return [{fecha:p.fechaRecaudo,cop:Math.round(p.montoCOPRecibido||p.cuotaTotal)}];
  }
  return [];
}
// ── IMPUTACION de lo cobrado entre INTERES y CAPITAL (Fase 1) ─────────────────
// UNA sola fuente de verdad para repartir el dinero de una cuota entre sus rubros. Antes este
// concepto NO existia: `partialPaid` era un escalar de caja sin composicion, asi que cada
// superficie improviso (unas ignoraban el parcial, otras lo contaban entero, y el Flujo de Caja
// volcaba interes y capital COMPLETOS en el evento que saldaba -> una fila de $50.000 declaraba
// $450.000 de rubros).
//
// REGLA DE NEGOCIO (decision del usuario, 2026-07-31): CASCADA INTERES -> CAPITAL.
//   Es el default legal en Colombia (Codigo Civil art. 1653: el pago se imputa primero a
//   intereses salvo consentimiento expreso del acreedor) y es coherente con el motor, que ya
//   devengo ese interes PARA ESE PERIODO. Imputar a capital primero dejaria interes devengado
//   y no cobrado sin columna donde vivir.
//
// ESTO ES PRESENTACION, NO AMORTIZACION. No toca buildSchedule, ni saldoFinal, ni el saldoReal
// del backend (techo del abono / liquidacion). Solo REPARTE una composicion que el motor ya fijo.
//
// Garantias, por construccion:
//   (1) En CADA evento:            interes + capital + ajuste === cop
//   (2) En una cuota SALDADA:      suma(interes) === interesPeriodo  y  suma(capital) === abonoCapital
//       -> reconcilia EXACTO con el motor y con la formula canonica de saldo, de modo que adoptar
//          este helper no mueve el saldo de ningun prestamo existente.
//   (3) `ajuste` es el hueco entre la caja y la composicion de la cuota. Dos origenes legitimos:
//       en USD, el efecto cambiario (Bug #23: una cuota queda Pagada con menos COP de los
//       proyectados) — concepto que la app YA modela; en COP, el residuo de redondeo de las filas
//       legacy del Bug #43 (medido: 4 prestamos, 1 a 3 pesos). Se NOMBRA en vez de esconderlo
//       inflando el capital, que es justo lo que descuadraria el saldo.
function imputarCobros(pay){
  var vacio={eventos:[],totales:{cobrado:0,interes:0,capital:0,ajuste:0},sinLedger:0,saldada:false};
  if(!pay) return vacio;
  var evs=cobrosDe(pay);
  var saldada=pay.estadoPago==='Pagado';
  var intTotal=Math.round(pay.interesPeriodo||0);
  // Capital de la cuota: se ancla a `abonoCapital` PORQUE ES LA MISMA BASE de la formula canonica
  // de saldo (origCOP - suma abonoCapital de Pagadas). Anclarlo a la reconciliacion
  // `cuotaTotal - interes` (doctrina v1.18.0, correcta para las COLUMNAS del cronograma) haria
  // que el capital imputado difiera del canonico en las filas legacy con residuo de redondeo del
  // Bug #43 — medido sobre la cartera real: 4 prestamos, entre 1 y 3 pesos — y entonces adoptar
  // este helper MOVERIA el saldo de esos prestamos sin explicacion. Defensa: si la columna viene
  // en 0 con cuota viva (capital fantasma historico, Bugs #30/#34) se cae a la reconciliacion.
  var capTotal=Math.round(pay.abonoCapital||0);
  var reconc=Math.round(pay.cuotaTotal||0)-intTotal;
  if(capTotal<=0&&reconc>0) capTotal=reconc;
  if(capTotal<0) capTotal=0;
  var intPend=intTotal, capPend=capTotal, cobrado=0;
  var out=evs.map(function(e){
    var cop=Math.round(e.cop||0);
    var ai=Math.min(cop,intPend);          intPend-=ai;
    var ac=Math.min(cop-ai,capPend);       capPend-=ac;
    cobrado+=cop;
    return {fecha:e.fecha,cop:cop,interes:ai,capital:ac,ajuste:0};
  });
  // Cuota SALDADA: el remanente de composicion que la caja no alcanzo a cubrir (tipico en USD
  // cuando la TRM bajo) se ancla al ULTIMO evento, para que los totales cuadren con el motor.
  // El desfase resultante queda visible como ajuste, no disfrazado de capital cobrado.
  if(saldada&&out.length>0&&(intPend>0||capPend>0)){
    var u=out[out.length-1];
    u.interes+=intPend; u.capital+=capPend;
    intPend=0; capPend=0;
  }
  // Identidad (1), calculada al final para que valga en TODOS los casos: si sobro caja sin
  // composicion que cubrir, el excedente cae aqui en vez de inflar un rubro.
  var ti=0,tc=0,ta=0;
  out.forEach(function(r){ r.ajuste=r.cop-r.interes-r.capital; ti+=r.interes; tc+=r.capital; ta+=r.ajuste; });
  // Dinero registrado en partialPaid que NINGUN evento representa: solo puede ocurrir en filas
  // legacy anteriores al ledger `recibos` (v1.11.4). Se reporta en vez de inventarle una fecha,
  // para no romper la identidad "KPI == suma del grafico" que cobrosDe garantiza.
  var sinLedger=Math.max(0,Math.round(pay.partialPaid||0)-cobrado);
  return {eventos:out,totales:{cobrado:cobrado,interes:ti,capital:tc,ajuste:ta},
          sinLedger:sinLedger,saldada:saldada};
}
// SALDO CON CAJA APLICADA (Fase 3) — la cifra que se MUESTRA, en pantalla y en los PDFs.
// = capital prestado - capital efectivamente cubierto (cuotas saldadas + abonos + la parte de
// capital de los parciales en curso, segun la cascada de imputarCobros).
// NO CONFUNDIR con el saldo del MOTOR (`originalCOP - suma abonoCapital de Pagadas`), que gobierna
// el techo del abono, la liquidacion y el recalculo del PMT y NO puede moverse por un parcial.
// Un solo helper para que ninguna superficie vuelva a inventar su propia formula: hasta la Fase 3
// convivian TRES definiciones distintas de "saldo" y los PDFs usaban la mas atrasada.
function saldoConCaja(loan, loanPays){
  if(!loan) return 0;
  var origCOP=loan.moneda==='USD'?Math.round(loan.montoOrigen*loan.trmAcordada):Math.round(loan.montoOrigen);
  var lp=(loanPays||[]).filter(function(p){return String(p.prestamoId)===String(loan.id);});
  var cap=lp.reduce(function(s,p){return s+imputarCobros(p).totales.capital;},0);
  return Math.max(0,origCOP-Math.round(cap));
}
// Rubros que AUN se deben de una cuota, tras aplicar lo ya abonado en cascada interes -> capital.
// Los PDFs prospectivos (factura de cobro) deben exigir esto, no la composicion nominal: si no,
// el documento cobra un interes que el parcial ya cubrio y sus filas no suman el total exigido.
function pendienteDeCuota(pay){
  var intTot=Math.round(pay.interesPeriodo||0);
  var capTot=Math.max(0,Math.round(pay.cuotaTotal||0)-intTot);
  var imp=imputarCobros(pay).totales;
  return {interes:Math.max(0,intTot-imp.interes), capital:Math.max(0,capTot-imp.capital)};
}
function fmtD(s) { return s?new Date(s+'T12:00:00').toLocaleDateString('es-CO',{day:'2-digit',month:'short',year:'numeric'}):'-'; }

// ── FLUJO DE CAJA REAL de un prestamo (v2.2.0) ────────────────────────────────
// Reconstruye lo que REALMENTE entro, cuando entro, a partir de la unica fuente fiable:
// los eventos de caja de cobrosDe(p) — el ledger `recibos` con fallback a fechaRecaudo.
// Se descartaron las alternativas: activity_log es texto libre sin FK ni montos estructurados,
// y undo_journal solo guarda 200 entradas / 90 dias (no existe para prestamos historicos).
// Auditado sobre la BD real: NINGUNA cuota pagada carece de fechaRecaudo, asi que esta fuente
// cubre el 100% de la historia. Cada evento se enriquece con los metadatos de su fila padre:
// el ledger aporta CUANDO y CUANTO, la fila aporta QUE era.
function flujoCajaDe(loan, loanPays){
  if(!loan) return {eventos:[],totales:{ingreso:0,interes:0,capital:0,ajuste:0},inferidos:0};
  var esUSD=loan.moneda==='USD';
  var origCOP=esUSD?Math.round(loan.montoOrigen*loan.trmAcordada):Math.round(loan.montoOrigen);
  var pays=(loanPays||[]).filter(function(p){return String(p.prestamoId)===String(loan.id);});
  var evs=[];
  pays.forEach(function(p){
    // Fase 2: el reparto interes/capital de CADA evento lo decide imputarCobros (cascada
    // interes -> capital). Antes se volcaba la composicion COMPLETA de la cuota en su ultimo
    // evento, de modo que un ingreso de $50.000 declaraba $450.000 de rubros y la fila del
    // parcial mostraba "—" con el saldo congelado.
    var imp=imputarCobros(p);
    // Sin ledger Y sin monto registrado, cobrosDe cae a cuotaTotal: el dato es RECONSTRUIDO.
    // Se marca para no presentarlo como registro exacto de caja (cobros previos a v1.11.4).
    // El ledger manda: si existe, el monto es REAL aunque montoCOPRecibido siga en 0 — que es lo
    // que pasa con un pago parcial en curso, donde /partial solo escribe partialPaid y `recibos`.
    var tieneLedger=false;
    try{var _l=JSON.parse(p.recibos||'[]'); tieneLedger=Array.isArray(_l)&&_l.length>0;}catch(_){}
    var inferido=!tieneLedger&&!(p.montoCOPRecibido>0);
    imp.eventos.forEach(function(ev,k){
      evs.push({fecha:String(ev.fecha),cop:ev.cop,interes:ev.interes,capital:ev.capital,ajuste:ev.ajuste,
        pay:p,k:k,nEv:imp.eventos.length,esUltimo:k===imp.eventos.length-1,inferido:inferido});
    });
  });
  // Orden por fecha REAL del dinero; desempate por hora de registro. Importa: hay cuotas
  // registradas el mismo dia que corresponden a cobros de meses distintos.
  evs.sort(function(a,b){
    var c=a.fecha.localeCompare(b.fecha);
    if(c!==0) return c;
    return String(a.pay.paidAt||'').localeCompare(String(b.pay.paidAt||''));
  });
  var saldo=origCOP,ti=0,tc=0,tg=0,ta=0,inf=0;
  var out=evs.map(function(e,i){
    var p=e.pay;
    var esAbono=p.id&&p.id.indexOf('-ab-')!==-1;
    var saldado=p.estadoPago==='Pagado';
    // El capital ya viene imputado por evento -> el saldo baja con CADA peso que entra, no de
    // golpe en el evento que salda la cuota.
    saldo=Math.max(0,saldo-e.capital); ti+=e.interes; tc+=e.capital; tg+=e.cop; ta+=e.ajuste;
    if(e.inferido) inf++;
    var atraso=(!esAbono&&p.fechaPago)?Math.round((new Date(e.fecha+'T12:00:00')-new Date(p.fechaPago+'T12:00:00'))/86400000):null;
    return {n:i+1,fecha:e.fecha,cop:e.cop,interes:e.interes,capital:e.capital,ajuste:e.ajuste,saldo:saldo,
      esAbono:esAbono,parcialEnCurso:!saldado,inferido:e.inferido,
      cuotaN:p.cuotaN,vence:p.fechaPago,atraso:atraso,obs:p.observaciones||'',
      usd:p.montoUSDRecibido||0,nEv:e.nEv};
  });
  return {eventos:out,totales:{ingreso:tg,interes:ti,capital:tc,ajuste:ta},inferidos:inf,origCOP:origCOP};
}

// ── Cálculo CENTRALIZADO de la liquidación (v1.19.0) ──────────────────────────
// UNA sola fuente de verdad para el "Valor de liquidación": LiquidarModal, AbonoModal, la
// tarjeta del perfil del deudor (DebtorModal) y los PDFs (cronograma + recibo de abono)
// llaman a este helper, así no pueden divergir. Regla de negocio:
//   Total = Capital pendiente + Intereses en mora − abonos parciales en curso (+ interés
//           del próximo mes si el checkbox está activo)
//   Capital pendiente = originalCOP − Σ abonoCapital de cuotas Pagadas (incluye abonos '-ab-').
//     Las cuotas EN MORA **no** restan capital: siguen debiéndose y se pagan al liquidar.
// Devuelve todo el desglose (incl. el valor por mes de los intereses) para renderizarlo.
function computeLiquidacion(loan, loanPays, opts){
  opts = opts || {};
  var esUSD = loan.moneda === 'USD';
  var origCOP = esUSD ? Math.round(loan.montoOrigen * loan.trmAcordada) : Math.round(loan.montoOrigen);
  var pays = (loanPays||[]).filter(function(p){ return String(p.prestamoId) === String(loan.id); });
  var regs = pays.filter(function(p){ return p.id.indexOf('-ab-') === -1; });
  var capPagadas = pays.filter(function(p){ return p.estadoPago === 'Pagado'; })
    .reduce(function(s,p){ return s + p.abonoCapital; }, 0);
  var capitalPendiente = Math.max(0, origCOP - capPagadas);
  var moraRows = regs.filter(function(p){ return p.estadoPago === 'En Mora'; });
  var moraCount = moraRows.length;
  var intMora = moraRows.reduce(function(s,p){ return s + p.interesPeriodo; }, 0);
  var moraInts = moraRows.map(function(p){ return Math.round(p.interesPeriodo); });
  var moraUniforme = moraCount > 0 && moraInts.every(function(v){ return v === moraInts[0]; });
  // valor por mes de los intereses en mora: exacto si todas las cuotas son iguales (Intereses o
  // C+I de 1 cuota); si varían (C+I multi-mora) se muestra el promedio, marcado como tal.
  var moraValorMes = moraCount > 0 ? (moraUniforme ? moraInts[0] : Math.round(intMora / moraCount)) : 0;
  var partialPend = regs.filter(function(p){ return p.estadoPago !== 'Pagado'; })
    .reduce(function(s,p){ return s + (p.partialPaid || 0); }, 0);
  var aplicaInteres = loan.modalidad !== 'Prestamo' && loan.modalidad !== 'Pago Unico' && (+loan.tasaMensual || 0) > 0;
  var intProxMes = aplicaInteres ? Math.round(capitalPendiente * (+loan.tasaMensual || 0) / 100) : 0;
  var incluye = !!opts.incluyeProxMes && aplicaInteres;
  var intExtra = incluye ? intProxMes : 0;
  var total = Math.max(0, capitalPendiente + intMora - partialPend + intExtra);
  return {
    esUSD: esUSD, trm: loan.trmAcordada, tasaMensual: +loan.tasaMensual || 0,
    capitalPendiente: capitalPendiente,
    intMora: intMora, moraCount: moraCount, moraUniforme: moraUniforme, moraValorMes: moraValorMes,
    partialPend: partialPend,
    aplicaInteres: aplicaInteres, intProxMes: intProxMes,
    incluyeProxMes: incluye, intExtra: intExtra,
    total: total
  };
}

// ── Input numérico con formato automático (1.000.000) ──
function fmtNumInput(v){
  if(!v&&v!==0)return '';
  var s=String(v).replace(/[^\d,]/g,'');
  var parts=s.split(',');
  var ent=parts[0].replace(/^0+(?=\d)/,'');
  if(!ent)ent='0';
  ent=ent.replace(/\B(?=(\d{3})+(?!\d))/g,'.');
  return parts.length>1?ent+','+parts[1]:ent;
}
function parseNum(v){
  if(!v)return '';
  var s=String(v).replace(/\./g,'').replace(',','.');
  return s;
}
// Acepta coma o punto como decimal; solo deja digitos y un unico punto decimal.
function parseDecimalInput(v){
  var s=String(v||'').replace(',','.').replace(/[^\d.]/g,'');
  var parts=s.split('.');
  if(parts.length>2) s=parts[0]+'.'+parts.slice(1).join('');
  return s;
}
// Solo deja digitos (para inputs enteros como plazo).
function parseIntInput(v){return String(v||'').replace(/[^\d]/g,'');}
function freqLabel(loan){
  if(loan.modalidad==='Intereses') return '\u221E Indefinido';
  var n=loan.plazoMeses;
  var f=loan.frecuencia||'Mensual';
  if(f==='Semanal') return n+' semanas';
  if(f==='Quincenal') return n+' quincenas';
  return n+' cuotas';
}
function freqCuotaLabel(f){return f==='Semanal'?'semanal':f==='Quincenal'?'quincenal':'mensual';}

function generateCronogramaPDF(loan, payments, darkMode) {
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
  var cuotasAll = allCuotas.filter(function(p) { return p.id.indexOf('-ab-') === -1; });
  var abonos = allCuotas.filter(function(p) { return p.id.indexOf('-ab-') !== -1; });
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
      var esAbono = p.id.indexOf('-ab-') !== -1;
      var isParcial = !esAbono && (p.partialPaid||0) > 0 && p.estadoPago !== 'Pagado';
      var cls = esAbono ? ' class="abono"' : isParcial ? ' class="mora"' : p.estadoPago === 'Pagado' ? ' class="pagado"' : p.estadoPago === 'En Mora' ? ' class="mora"' : ' class="pendiente"';
      var badge = esAbono ? '<span class="badge badge-abono">Abono</span>' : isParcial ? '<span class="badge badge-mora">'+(p.estadoPago==='En Mora'?'En Mora':'Pendiente')+'</span> <span class="badge badge-parcial">Parcial</span>' : p.estadoPago === 'Pagado' ? '<span class="badge badge-pagado">Pagado</span>' : p.estadoPago === 'En Mora' ? '<span class="badge badge-mora">En Mora</span>' : '<span class="badge badge-pendiente">Pendiente</span>';
      if (esAbono) {
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

// ── Reporte de Prestamos Activos (PDF) ────────────────────────────────────
// Reusa el pipeline printToPDF (electronAPI.printPDF) con fallback a window.print,
// igual que generateCronogramaPDF/generateRecibo -> cero dependencias nuevas.
// Un bloque por prestamo activo; las cuotas En Mora se anidan debajo del prestamo.
// Totalizador del "capital total en la calle" al final. Tema-aware (claro/oscuro).
function generateReportePrestamosPDF(loans, pays, darkMode) {
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
    var moras = lp.filter(function(p) { return p.id.indexOf('-ab-') === -1 && p.estadoPago === 'En Mora'; })
                  .sort(function(a, b) { return a.cuotaN - b.cuotaN; });
    var vencido = moras.reduce(function(s, p) { return s + saldoMora(p); }, 0);
    // Fila principal = proxima cuota PENDIENTE (el ciclo regular activo). Las En Mora NO van aqui:
    // se detallan en sub-filas rojas. Si no queda ninguna Pendiente (cronograma terminado) -> '—'.
    var pendientes = lp.filter(function(p) { return p.id.indexOf('-ab-') === -1 && p.estadoPago === 'Pendiente'; })
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

function generateRecibo(pay, loan, copRec, usdRec, allPays, opts) {
  opts = opts || {};
  var dark = document.documentElement.getAttribute('data-theme') === 'dark';
  var esUSD = loan && loan.moneda === 'USD';
  var montoRecibido = copRec || pay.cuotaTotal;
  // Fase 3 — imputacion de ESTE pago y saldo resultante.
  // OJO: el recibo se emite ANTES de persistir, asi que `allPays` es el estado PREVIO y el ledger
  // aun no contiene este evento. Por eso se parte de lo que la cuota debia (pendienteDeCuota) y se
  // aplica la cascada al monto recibido, en vez de leer el ledger.
  var _pendR = pendienteDeCuota(pay);
  var _iR = Math.min(Math.round(montoRecibido), _pendR.interes);
  var impPago = { interes: _iR, capital: Math.min(Math.round(montoRecibido) - _iR, _pendR.capital) };
  // Saldo DESPUES del pago = saldo con caja aplicada (previo) menos el capital que este pago cubre.
  // Antes se imprimia `pay.saldoFinal`, el cierre PROYECTADO del cronograma: una TERCERA definicion
  // de saldo, que no coincidia ni con la app ni con los demas PDFs.
  var saldoRestante = loan ? Math.max(0, saldoConCaja(loan, allPays) - impPago.capital) : pay.saldoFinal;
  var yaAbonadoPrev = opts.yaAbonadoPrev || 0;
  var totalAcum = yaAbonadoPrev + montoRecibido;
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
      return p.prestamoId === loan.id && p.estadoPago === 'Pendiente' && p.id.indexOf('-ab-') === -1 && p.cuotaN > pay.cuotaN;
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
    return p.prestamoId === loan.id && p.id.indexOf('-ab-') === -1 && p.id !== pay.id && p.estadoPago !== 'Pagado';
  }) : null;
  var esLiquidacion = !esParcial && loan.modalidad !== 'Intereses' && otrasRegPend !== null && otrasRegPend.length === 0;
  // Banner dinamico: liquidacion (prioridad absoluta) > puntualidad. Compara la fecha REAL de cobro
  // (la elegida en el form, fallback fechaRecaudo/hoy) contra la fechaPago esperada, ambas ancladas a
  // mediodia local para evitar desfases por zona horaria. La puntualidad solo aplica a pagos COMPLETOS
  // (no parciales, no abonos a capital).
  var fechaRealPago = opts.fechaRecaudo || pay.fechaRecaudo || nowStr();
  var diasRetraso = (pay.fechaPago && fechaRealPago && pay.id.indexOf('-ab-') === -1)
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
  } else if (!esParcial && pay.fechaPago && pay.id.indexOf('-ab-') === -1) {
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
// ── Recibo de Cobro / Factura (v1.16.0) ──────────────────────────────────────
// Documento PROSPECTIVO (antes de pagar) para gestion de cartera. Distinto de
// generateRecibo (que confirma un pago ya hecho). Reusa el pipeline printPDF.
function generateFacturaCobro(pay, loan, allPays, datosPago, opts) {
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
// ── Recibo de Abono a Capital (v1.17.0) ──────────────────────────────────────
// Se genera automaticamente tras registrar un abono. Los 3 puntos de entrada
// (Cartera, perfil del deudor, "Liquidar deuda") convergen en _doAbono, que lo llama
// con el estado YA persistido (el cronograma lo regenero el backend; no se replica
// aqui el motor financiero). 4 variantes:
//   1. PAZ Y SALVO  -> el abono salda el prestamo (saldo 0): sin impacto ni cronograma
//   2. CORTA        -> modalidades sin cronograma amortizable (Intereses/Prestamo/Pago Unico)
//   3/4. COMPLETA   -> Capital + Intereses: impacto segun recalcMode + cronograma actualizado
function generateReciboAbono(loan, allPays, opts) {
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
  var pend = lp.filter(function(p){ return p.id.indexOf('-ab-') === -1 && p.estadoPago === 'Pendiente'; })
               .sort(function(a, b){ return a.cuotaN - b.cuotaN; });
  var nAbonos = lp.filter(function(p){ return p.id.indexOf('-ab-') !== -1; }).length;

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
function nowStr()    { var d=new Date(); return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'); }
function addDays(s,n){ var d=new Date(s+'T12:00:00'); d.setDate(d.getDate()+n); return d.toISOString().split('T')[0]; }

var ST = {
  'Pagado':   {bg:'#0f2b19',color:'#3fb950',bd:'#1b4332',icon:'OK'},
  'Pendiente':{bg:'#2b2005',color:'#d29922',bd:'#3d2e08',icon:'...'},
  'En Mora':  {bg:'#2d1117',color:'#f85149',bd:'#5c1b18',icon:'!'}
};

var ICONS = {
  home:      'M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z M9 22V12h6v10',
  briefcase: 'M20 7H4a2 2 0 00-2 2v10a2 2 0 002 2h16a2 2 0 002-2V9a2 2 0 00-2-2z M16 7V5a2 2 0 00-2-2h-4a2 2 0 00-2 2v2',
  check2:    'M9 11l3 3L22 4 M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11',
  users:     'M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2 M23 21v-2a4 4 0 00-3-3.87 M16 3.13a4 4 0 010 7.75',
  trending:  'M23 6l-9.5 9.5-5-5L1 18 M17 6h6v6',
  plus:      'M12 5v14 M5 12h14',
  edit:      'M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7 M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z',
  trash:     'M3 6h18 M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a1 1 0 011-1h4a1 1 0 011 1v2',
  x:         'M18 6L6 18 M6 6l12 12',
  xCircle:   'M12 22a10 10 0 100-20 10 10 0 000 20z M15 9l-6 6 M9 9l6 6',
  check:     'M20 6L9 17l-5-5',
  alert:     'M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z M12 9v4 M12 17h.01',
  clock:     'M12 2a10 10 0 100 20A10 10 0 0012 2z M12 6v6l4 2',
  search:    'M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z',
  chevdown:  'M6 9l6 6 6-6',
  chevleft:  'M15 18l-6-6 6-6',
  chevright: 'M9 18l6-6-6-6',
  bell:      'M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9 M13.73 21a2 2 0 01-3.46 0',
  refresh:   'M23 4v6h-6 M1 20v-6h6 M3.51 9a9 9 0 0114.85-3.36L23 10 M1 14l4.64 4.36A9 9 0 0020.49 15',
  dollar:    'M12 1v22 M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6',
  phone:     'M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07A19.5 19.5 0 013.07 9.8a19.79 19.79 0 01-3.07-8.63A2 2 0 012 0h3a2 2 0 012 1.72c.127.96.361 1.903.7 2.81a2 2 0 01-.45 2.11L6.09 7.91a16 16 0 006 6l1.27-1.27a2 2 0 012.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0122 16.92z',
  menu:       'M3 12h18 M3 6h18 M3 18h18',
  calc:       'M4 2h16a2 2 0 012 2v16a2 2 0 01-2 2H4a2 2 0 01-2-2V4a2 2 0 012-2z M8 10h.01 M12 10h.01 M16 10h.01 M8 14h.01 M12 14h.01 M16 14h.01 M8 18h.01 M12 18h.01 M16 18h.01 M8 6h8',
  calendar:    'M19 4H5a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2V6a2 2 0 00-2-2z M16 2v4 M8 2v4 M3 10h18',
  download:    'M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4 M7 10l5 5 5-5 M12 15V3',
  settings:    'M12.22 2h-.44a2 2 0 00-2 2v.18a2 2 0 01-1 1.73l-.43.25a2 2 0 01-2 0l-.15-.08a2 2 0 00-2.73.73l-.22.38a2 2 0 00.73 2.73l.15.1a2 2 0 011 1.72v.51a2 2 0 01-1 1.74l-.15.09a2 2 0 00-.73 2.73l.22.38a2 2 0 002.73.73l.15-.08a2 2 0 012 0l.43.25a2 2 0 011 1.73V20a2 2 0 002 2h.44a2 2 0 002-2v-.18a2 2 0 011-1.73l.43-.25a2 2 0 012 0l.15.08a2 2 0 002.73-.73l.22-.39a2 2 0 00-.73-2.73l-.15-.08a2 2 0 01-1-1.74v-.5a2 2 0 011-1.74l.15-.09a2 2 0 00.73-2.73l-.22-.38a2 2 0 00-2.73-.73l-.15.08a2 2 0 01-2 0l-.43-.25a2 2 0 01-1-1.73V4a2 2 0 00-2-2z M12 15a3 3 0 100-6 3 3 0 000 6z',
  folder:      'M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z',
  'refresh-cw': 'M23 4v6h-6 M1 20v-6h6 M3.51 9a9 9 0 0114.85-3.36L23 10 M1 14l4.64 4.36A9 9 0 0020.49 15',
  sun:         'M12 17a5 5 0 100-10 5 5 0 000 10z M12 1v2 M12 21v2 M4.22 4.22l1.42 1.42 M18.36 18.36l1.42 1.42 M1 12h2 M21 12h2 M4.22 19.78l1.42-1.42 M18.36 5.64l1.42-1.42',
  moon:        'M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z',
  activity:    'M22 12h-4l-3 9L9 3l-3 9H2',
  clipboard:   'M16 4h2a2 2 0 012 2v14a2 2 0 01-2 2H6a2 2 0 01-2-2V6a2 2 0 012-2h2 M15 2H9a1 1 0 00-1 1v1a1 1 0 001 1h6a1 1 0 001-1V3a1 1 0 00-1-1z',
  sparkle:     'M12 2l2 6.5L20.5 10l-6.5 2L12 18.5 10 12l-6.5-1.5L10 8.5 12 2z',
  shield:      'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z',
  wallet:      'M4 5h16a2 2 0 012 2v10a2 2 0 01-2 2H4a2 2 0 01-2-2V7a2 2 0 012-2z M2 10h20 M7 15h3',
  receipt:     'M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z M14 2v6h6 M8 13h8 M8 17h8 M8 9h2'
};

function Ico(props){
  var name=props.name,size=props.size||18,sw=props.sw||1.8,color=props.color||'currentColor';
  var d=ICONS[name]; if(!d) return null;
  var parts=d.split(' M ');
  var paths=parts.map(function(p,i){return i===0?p:'M '+p;});
  return h('svg',{width:size,height:size,viewBox:'0 0 24 24',fill:'none',stroke:color,strokeWidth:sw,strokeLinecap:'round',strokeLinejoin:'round'},
    paths.map(function(p,i){return h('path',{key:i,d:p});}));
}

// ── App ───────────────────────────────────────────────────────────────────────
function App(){
  var s1=useState([]); var loans=s1[0]; var setLoans=s1[1];
  var s2=useState([]); var pays=s2[0]; var setPays=s2[1];
  var s3=useState({trm:'4100'}); var cfg=s3[0]; var setCfg=s3[1];
  var s4=useState(true); var loading=s4[0]; var setLoading=s4[1];
  var s5=useState('dashboard'); var view=s5[0]; var setView=s5[1];
  var s6=useState(null); var loanModal=s6[0]; var setLoanModal=s6[1];
  var s7=useState(null); var payModal=s7[0]; var setPayModal=s7[1];
  var s8=useState(''); var searchQ=s8[0]; var setSearchQ=s8[1];
  var s10=useState(''); var fMonth=s10[0]; var setFMonth=s10[1];
  var s11=useState(null); var abonoModal=s11[0]; var setAbonoModal=s11[1];
  var s12=useState(null); var debtorModal=s12[0]; var setDebtorModal=s12[1];
  // v2.0.0 — modal de liquidacion ELEVADO desde DebtorModal a nivel App: ahora es un modal
  // hermano de AbonoModal, invocable desde el perfil del deudor Y desde el CTA de AbonoModal.
  var s13=useState(null); var liquidarModal=s13[0]; var setLiquidarModal=s13[1];
  var s13=useState(false); var menuOpen=s13[0]; var setMenuOpen=s13[1];
  var s14=useState(null); var calcData=s14[0]; var setCalcData=s14[1];
  var s15=useState(null); var toast=s15[0]; var setToast=s15[1];
  var s16=useState(false); var gSearch=s16[0]; var setGSearch=s16[1];
  var s17=useState(''); var gQ=s17[0]; var setGQ=s17[1];
  var s18=useState(false); var needsRestart=s18[0]; var setNeedsRestart=s18[1];
  var s19=useState(function(){return localStorage.getItem('theme')||'dark';}); var theme=s19[0]; var setTheme=s19[1];
  var s20=useState([]); var actLog=s20[0]; var setActLog=s20[1];
  // "La Bestia" Fase 2 — journal de operaciones reversibles (GET /api/undo). El Historial lo
  // cruza con activity_log por `undo_id` (enlace 1:1 escrito por mutacionAtomica).
  var s24=useState([]); var undoLog=s24[0]; var setUndoLog=s24[1];
  var s25=useState(null); var undoDlg=s25[0]; var setUndoDlg=s25[1];
  var sDebts=useState([]); var debts=sDebts[0]; var setDebts=sDebts[1];
  var sDebtModal=useState(null); var debtModal=sDebtModal[0]; var setDebtModal=sDebtModal[1];
  var sDebtPay=useState(null); var debtPayModal=sDebtPay[0]; var setDebtPayModal=sDebtPay[1];
  var sDebtHist=useState(null); var debtHistory=sDebtHist[0]; var setDebtHistory=sDebtHist[1];
  var sDebtDel=useState(null); var debtDelete=sDebtDel[0]; var setDebtDelete=sDebtDel[1];
  var sNavOpen=useState(function(){ try{ var v=JSON.parse(localStorage.getItem('navSections')); return (v&&typeof v==='object')?v:{prestamos:true,deudas:true}; }catch(_){ return {prestamos:true,deudas:true}; } });
  var navOpen=sNavOpen[0]; var setNavOpen=sNavOpen[1];
  var s21=useState(null); var globalUpdate=s21[0]; var setGlobalUpdate=s21[1];
  var s22=useState(null); var confirmDlg=s22[0]; var setConfirmDlg=s22[1];
  var s24=useState(null); var errorDlg=s24[0]; var setErrorDlg=s24[1];
  var s25=useState('win32'); var platform=s25[0]; var setPlatform=s25[1];
  // v1.9.0 — Reestructurar prestamo (sin abono) + preflight de cuotas proximas a mora
  var sRe=useState(null); var restructureModal=sRe[0]; var setRestructureModal=sRe[1];
  var sPre=useState(null); var preflightDlg=sPre[0]; var setPreflightDlg=sPre[1];
  var isMac=platform==='darwin';
  var sWide=useState(window.innerWidth>=768); var isDesktop=sWide[0]; var setIsDesktop=sWide[1];
  useEffect(function(){function onR(){setIsDesktop(window.innerWidth>=768);} window.addEventListener('resize',onR); return function(){window.removeEventListener('resize',onR);};},[]);
  // Conectar el canal de errores de API con el toast de la UI
  setErrorHandler(function(msg){ showToast(msg, 'error'); });
  // Chequear errores de arranque
  useEffect(function(){
    if(typeof window.electronAPI==='undefined'||!window.electronAPI.getStartupErrors) return;
    window.electronAPI.getStartupErrors().then(function(errs){
      if(errs && errs.length > 0) {
        setErrorDlg({title:'Aviso al iniciar', messages: errs.map(function(e){return e.message;})});
      }
    });
  },[]);
  function toggleTheme(){
    var next=theme==='dark'?'light':'dark';
    setTheme(next);localStorage.setItem('theme',next);
    document.documentElement.setAttribute('data-theme',next);
  }
  useEffect(function(){document.documentElement.setAttribute('data-theme',theme);},[]);
  useEffect(function(){
    if(typeof window.electronAPI!=='undefined'&&window.electronAPI.getPlatform){
      window.electronAPI.getPlatform().then(function(p){setPlatform(p);});
    }
  },[]);
  useEffect(function(){
    if(typeof window.electronAPI==='undefined'||!window.electronAPI.onUpdateStatus) return;
    var unsub=window.electronAPI.onUpdateStatus(function(data){setGlobalUpdate(data);});
    return unsub;
  },[]);
  // ── Changelog post-actualización ──────────────────────────────────────────
  var s23=useState(null); var changelogDlg=s23[0]; var setChangelogDlg=s23[1];
  useEffect(function(){
    if(typeof window.electronAPI==='undefined'||!window.electronAPI.getAppVersion) return;
    window.electronAPI.getAppVersion().then(function(ver){
      window._appVersion=ver;
      var lastSeen = localStorage.getItem('lastSeenVersion');
      // v1.12.1: se quito el guard `lastSeen &&`. El rebranding mueve userData a
      // %APPDATA%\cartera\ -> localStorage arranca vacio (lastSeen null) y el modal
      // de novedades nunca disparaba. Ahora dispara siempre que la version guardada
      // difiera de la actual (incluido null) y exista changelog. El setItem de abajo
      // garantiza que solo se muestre una vez por version.
      if(lastSeen !== ver && CHANGELOGS[ver]){
        setChangelogDlg({version:ver, items:CHANGELOGS[ver]});
      }
      localStorage.setItem('lastSeenVersion', ver);
    });
  },[]);

  var toastTimer=React.useRef(null);
  function showToast(msg,type){
    type=type||'success';
    if(toastTimer.current) clearTimeout(toastTimer.current);
    setToast({msg:msg,type:type,out:false});
    toastTimer.current=setTimeout(function(){setToast(function(t){return t?Object.assign({},t,{out:true}):null;});
      setTimeout(function(){setToast(null);},300);
    },2000);
  }

  var reload=useCallback(function(){
    return Promise.all([API.get('/api/loans'),API.get('/api/payments'),API.get('/api/config')])
      .then(function(res){
        if(res[0]) setLoans(res[0]);
        if(res[1]) setPays(res[1]);
        if(res[2]) setCfg(res[2]);
        setLoading(false);
        return res; // v1.17.0: expone los datos frescos (el Recibo de Abono los necesita)
      });
  },[]);

  // Guarda pares clave/valor en config (PUT /api/config) y refresca el estado local.
  var saveConfig=useCallback(function(patch){
    return API.put('/api/config',patch).then(function(r){
      if(!r) return null;
      setCfg(function(c){return Object.assign({},c,patch);});
      return r;
    });
  },[]);

  // Mis Deudas: modulo independiente; se carga aparte de reload() (loans/pays/config)
  var loadDebts=useCallback(function(){
    return API.get('/api/debts').then(function(data){ if(data) setDebts(data); });
  },[]);

  // ⚠️ ORDEN DE HOOKS: estos dos useCallback DEBEN vivir aqui, junto al resto de hooks de App y
  // MUY por encima del `if(loading) return ...` que corta el render mientras cargan los datos.
  // Estuvieron mas abajo (junto a navTo) y provocaron la pantalla negra de v2.1.0: en el primer
  // render loading=true, el return temprano se disparaba y estos hooks NO se ejecutaban; al
  // terminar la carga el render pasaba de largo y aparecian 2 hooks nuevos -> React lanzaba el
  // error #310 ("rendered more hooks than during the previous render"), desmontaba el arbol y la
  // pantalla se quedaba con lo ultimo pintado: el fondo var(--bg) del spinner (casi negro).
  // Regla: NINGUN hook por debajo de un return condicional.

  // Carga el historial y el journal EN PARALELO: la fila del log solo sabe que es reversible
  // cuando su undo_id existe en el journal y ademas es el head LIFO de su agregado.
  var loadHistorial=useCallback(function(){
    return Promise.all([
      fetch('/api/activity').then(function(r){return r.json();}).catch(function(){return [];}),
      fetch('/api/undo').then(function(r){return r.json();}).catch(function(){return [];})
    ]).then(function(res){
      setActLog(Array.isArray(res[0])?res[0]:[]);
      setUndoLog(Array.isArray(res[1])?res[1]:[]);
      return res;
    });
  },[]);

  // Ejecuta el undo y refresca TODO: el journal cambia de estado, el historial gana su entrada
  // compensatoria y los datos del prestamo/deuda vuelven al snapshot.
  var confirmarUndo=useCallback(function(entry){
    return API.post('/api/undo/'+entry.id,{}).then(function(r){
      if(!r){showToast('No se pudo deshacer','error');return;}
      if(r.error){showToast(r.error,'error');return;}
      setUndoDlg(null);
      return Promise.all([reload(),loadHistorial(),loadDebts()]).then(function(){
        // El backend avisa (sin bloquear) cuando el estado habia cambiado desde la operacion.
        showToast(r.warning?'Deshecho, con advertencias':'Operacion deshecha');
      });
    });
  },[reload,loadHistorial,loadDebts]);

  // Crear o editar deuda. data.id presente -> PUT (editar); ausente -> POST (crear).
  var saveDebt=useCallback(function(data){
    var req=data.id?API.put('/api/debts/'+data.id,data):API.post('/api/debts',data);
    return req.then(function(r){
      if(!r) return; // en error, handleApiError ya mostro el toast
      setDebtModal(null);
      return loadDebts().then(function(){ showToast(data.id?'Deuda actualizada':'Deuda registrada'); });
    });
  },[loadDebts]);

  // Eliminar deuda (DELETE /api/debts/:id). El confirm() nativo se hace en la tarjeta.
  var deleteDebt=useCallback(function(id){
    return API.del('/api/debts/'+id).then(function(r){
      if(!r) return;
      return loadDebts().then(function(){ showToast('Deuda eliminada','error'); });
    });
  },[loadDebts]);

  // QA6: acreedores unicos (case-insensitive, Proper Case) para el autocompletado de DebtModal.
  var existingAcreedores=useMemo(function(){
    var seen={},out=[];
    debts.forEach(function(d){
      var n=properCase(d.acreedor||''); var k=n.toLowerCase();
      if(n&&!seen[k]){ seen[k]=1; out.push(n); }
    });
    out.sort(function(a,b){return a.localeCompare(b);});
    return out;
  },[debts]);

  // Abonar a una deuda (POST /api/debts/:id/pay). Cierra el modal y recarga la lista.
  var payDebt=useCallback(function(id,data){
    return API.post('/api/debts/'+id+'/pay',data).then(function(r){
      if(!r) return;
      var saldada=r.deuda&&r.deuda.estado==='Pagada';
      setDebtPayModal(null);
      return loadDebts().then(function(){ showToast(saldada?'Deuda saldada':'Abono registrado'); });
    });
  },[loadDebts]);

  useEffect(function(){
    API.post('/api/recalculate',{}).then(function(){return reload();});
    loadDebts();
  },[reload,loadDebts]);

  var openPayModal=useCallback(function(p){
    var loan=null;
    for(var i=0;i<loans.length;i++){if(loans[i].id===p.prestamoId){loan=loans[i];break;}}
    setPayModal({pay:p,loan:loan});
  },[loans]);

  var saveLoan=useCallback(function(data){
    // Vinculacion automatica: si es nuevo, buscar deudor existente por nombre (case-insensitive)
    if(!data.id){
      var nombreNorm=data.nombre.trim().toLowerCase();
      var existente=loans.find(function(l){return l.nombre.trim().toLowerCase()===nombreNorm;});
      if(existente){
        // Auto-vincular: usar cedula/telefono del deudor existente si no se llenaron
        if(!data.cedula||data.cedula==='0') data.cedula=existente.cedula;
        if(!data.telefono||data.telefono==='0') data.telefono=existente.telefono;
        // Usar nombre exacto del existente para consistencia
        data.nombre=existente.nombre;
        // Validacion de duplicados: mismo nombre + mismo monto activo
        var dupActivo=loans.find(function(l){return l.nombre.trim().toLowerCase()===nombreNorm&&l.estado==='Activo'&&Math.round(l.montoCOP)===Math.round(data.montoCOP);});
        if(dupActivo){
          setConfirmDlg({title:'Prestamo duplicado',message:'Ya existe un prestamo activo para "'+existente.nombre+'" por '+fmt(data.montoCOP)+'.',okLabel:'Crear igual',okColor:'var(--yellow)',onConfirm:function(){setConfirmDlg(null);doSaveLoan(data);}});
          return Promise.resolve();
        }
      }
    }
    return doSaveLoan(data);
  },[reload,loans]);
  function doSaveLoan(data){
    var isNew=!data.id;
    var p=data.id?API.put('/api/loans/'+data.id,data):API.post('/api/loans',data);
    return p.then(function(r){
      if(!r)return;
      var savedLoan=r;
      return reload().then(function(){
        setLoanModal(null);showToast(isNew?'Prestamo creado':'Prestamo actualizado');
        if(isNew&&savedLoan&&savedLoan.id){
          setConfirmDlg({title:'Cronograma PDF',message:'¿Deseas generar el cronograma de pagos en PDF para enviar al deudor?',okLabel:'Generar PDF',okColor:'var(--blue)',onConfirm:function(){
            setConfirmDlg(null);
            API.get('/api/payments').then(function(allPays){
              var loanPays=allPays.filter(function(p2){return p2.prestamoId===savedLoan.id;});
              generateCronogramaPDF(savedLoan,loanPays,theme==='dark');
            });
          }});
        }
      });
    });
  }

  var delLoan=useCallback(function(id){
    setConfirmDlg({title:'Eliminar prestamo',message:'Se eliminara el prestamo y todo su cronograma de pagos. Esta accion no se puede deshacer.',okLabel:'Eliminar',okColor:'#b91c1c',onConfirm:function(){setConfirmDlg(null);API.del('/api/loans/'+id).then(function(r){if(!r)return;reload();showToast('Prestamo eliminado','error');});}});
  },[reload]);

  var forceCloseLoan=useCallback(function(loan){
    // Calcular pérdida estimada para mostrarla en la confirmación
    var lp=pays.filter(function(p){return p.prestamoId===loan.id;});
    var origCOP=loan.moneda==='USD'?Math.round(loan.montoOrigen*loan.trmAcordada):Math.round(loan.montoOrigen);
    var capPag=lp.filter(function(p){return p.estadoPago==='Pagado';}).reduce(function(s,p){return s+p.abonoCapital;},0);
    var capPerd=Math.max(0,Math.round(origCOP-capPag));
    var intPerd=Math.round(lp.filter(function(p){return p.estadoPago==='En Mora'&&p.id.indexOf('-ab-')===-1;}).reduce(function(s,p){return s+p.interesPeriodo;},0));
    var total=capPerd+intPerd;
    var msg='Cerrar a la fuerza el prestamo de '+loan.nombre+'. Se daran por perdidos:\n'
      +'• Capital pendiente: $'+capPerd.toLocaleString('es-CO')+'\n'
      +'• Intereses en mora: $'+intPerd.toLocaleString('es-CO')+'\n'
      +'• Total perdido: $'+total.toLocaleString('es-CO')+'\n'
      +'Las cuotas pendientes y en mora se eliminaran. El prestamo pasara a "Cancelado" y no se podra reactivar.';
    setConfirmDlg({title:'Cerrar prestamo a la fuerza',message:msg,okLabel:'Cerrar prestamo',okColor:'#b91c1c',onConfirm:function(){
      setConfirmDlg(null);
      API.post('/api/loans/'+loan.id+'/force-close',{}).then(function(r){
        if(!r)return;
        if(r.error){showToast(r.error,'error');return;}
        reload();showToast('Prestamo cerrado — perdida: $'+(r.totalPerdido||total).toLocaleString('es-CO'),'error');
      });
    }});
  },[pays,reload]);

  var recalculate=useCallback(function(){
    API.post('/api/recalculate',{}).then(function(r){
      reload();showToast('Cronogramas recalculados');
    });
  },[reload]);

  // v1.18.1 — se devuelve la promesa para que PayModal pueda liberar su guarda anti
  // doble-submit. Sin el `return`, el modal recibe undefined y la guarda quedaria colgada.
  var markPay=useCallback(function(id,status,fecha,obs,copRecibido,usdRecibido){
    fecha=fecha||null; obs=obs||''; copRecibido=copRecibido||0; usdRecibido=usdRecibido||0;
    return API.put('/api/payments/'+id,{estadoPago:status,fechaRecaudo:status==='Pagado'?(fecha||nowStr()):null,observaciones:obs,montoCOPRecibido:copRecibido,montoUSDRecibido:usdRecibido})
      .then(function(r){if(!r)return null;return reload().then(function(){return r;});})
      // v1.18.1: faltaba el guard `if(!r)`. Ante un fallo de API (API.put atrapa el error y
      // resuelve null) este .then corria igual: cerraba el modal y anunciaba "Pago registrado"
      // pese a que la escritura NO se habia hecho. markPartial ya lo tenia bien.
      // v2.3.0: resuelve con `r` (o null) para que el llamador sepa si la escritura ocurrio —
      // PayModal lo usa para emitir el recibo SOLO si el pago se registro de verdad.
      .then(function(r){if(!r)return null;setPayModal(null);showToast(status==='Pagado'?'Pago registrado':status==='En Mora'?'Marcado en mora':'Estado actualizado');return r;});
  },[reload]);

  var markPartial=useCallback(function(id,monto,fecha,obs,usdRecibido){
    return API.post('/api/payments/'+id+'/partial',{monto:monto,fecha:fecha||nowStr(),observaciones:obs||'',montoUSD:usdRecibido||0})
      .then(function(r){if(!r)return;return reload().then(function(){return r;});})
      // v2.3.0: resuelve con `r` (o null) — ver markPay.
      .then(function(r){if(!r)return null;setPayModal(null);showToast(r.completa?'Pago completado':'Pago parcial registrado ($'+(r.restante||0).toLocaleString('es-CO')+' restante)');return r;});
  },[reload]);

  var confirmarCalc=useCallback(function(data){
    setCalcData(null);
    setLoanModal({_prefill:{},_calcPrefill:data});
    setView('cartera');
  },[]);

  // v1.9.0 — Helpers de aplicacion (abono + reestructurar). Cada uno verifica cuotas
  // proximas a mora (≤5 dias) cuando hay recalculo, y muestra PreflightMoraModal antes
  // de continuar.
  // v1.17.0 — snapshot PRE-abono para el Recibo de Abono: saldo, cuota, cuotas restantes e
  // intereses ANTES del recalculo. Tras el POST el cronograma anterior ya no existe en BD.
  function _snapshotAbono(loanId){
    var l=loans.find(function(x){return x.id===loanId;});
    if(!l) return {};
    var lp=pays.filter(function(p){return p.prestamoId===loanId;});
    var esUSD=l.moneda==='USD',trm=l.trmAcordada||1;
    var orig=esUSD?Math.round(l.montoOrigen*trm):Math.round(l.montoOrigen);
    var capPag=lp.filter(function(p){return p.estadoPago==='Pagado';}).reduce(function(s,p){return s+p.abonoCapital;},0);
    var pend=lp.filter(function(p){return p.id.indexOf('-ab-')===-1&&p.estadoPago==='Pendiente';}).sort(function(a,b){return a.cuotaN-b.cuotaN;});
    // `saldo` (MOTOR) se conserva a proposito: la liquidacion envia `monto = L.capitalPendiente`,
    // que esta en esa misma base; parearlo con el saldo con caja imprimiria un Paz y Salvo con
    // "saldo anterior < monto aplicado". `saldoCaja` es el que se MUESTRA como "Saldo anterior".
    return {saldo:Math.max(0,orig-capPag),saldoCaja:saldoConCaja(l,lp),cuota:pend.length?pend[0].cuotaTotal:0,cuotas:pend.length,
            intereses:pend.reduce(function(s,p){return s+p.interesPeriodo;},0),plazo:l.plazoMeses};
  }
  function _doAbono(loanId,monto,fecha,obs,montoUSD,liquidar,recalcMode,recalcValor,genRecibo,intExtra,copRecibido){
    var fromDeudor=abonoModal&&abonoModal.fromDeudor;
    var pre=_snapshotAbono(loanId);
    // v1.19.0 — intExtra (interes del proximo mes al liquidar, si el checkbox esta activo) viaja al
    // backend para registrarse como ingreso real; el backend lo ignora (0) fuera de la liquidacion.
    // v2.0.0 — montoCOPRecibido = CAJA REAL del abono (solo prestamos USD). NO toca el capital
    // (que va en `monto`, a TRM pactada): el backend lo persiste en la fila del abono para que el
    // desfase cambiario quede registrado. Si es 0 el backend conserva el valor derivado de antes.
    return API.post('/api/loans/'+loanId+'/abono',{monto:monto,fecha:fecha,observaciones:obs,montoUSD:montoUSD||0,liquidar:!!liquidar,recalcMode:recalcMode||null,recalcValor:recalcValor||null,intExtra:intExtra||0,montoCOPRecibido:copRecibido||0})
      .then(function(r){
        if(!r)return;
        if(r.error){showToast(r.error,'error');return;}
        // v1.9.0 — await reload antes de re-abrir DebtorModal para evitar mostrar datos viejos
        return reload().then(function(fresh){
          if(fromDeudor) setDebtorModal(fromDeudor);
          setAbonoModal(null);
          showToast(liquidar?'Deuda liquidada':'Abono registrado');
          // v1.17.0 — Recibo de Abono con el estado YA persistido (cronograma real regenerado
          // por el backend; no se replica aqui el motor financiero). Nunca rompe el flujo.
          try{
            var fl=((fresh&&fresh[0])||loans).find(function(x){return x.id===loanId;});
            var fp=(fresh&&fresh[1])||pays;
            // genRecibo!==false: la liquidacion (que no pasa el flag) mantiene el Paz y Salvo por defecto
            if(fl&&genRecibo!==false) generateReciboAbono(fl,fp,{monto:monto,montoUSD:montoUSD,fecha:fecha,observaciones:obs,pre:pre,recalcMode:recalcMode,liquidar:!!liquidar});
          }catch(e){}
        });
      });
  }
  function _doReestructurar(loanId,mode,valor,fromDeudor){
    return API.post('/api/loans/'+loanId+'/reestructurar',{recalcMode:mode,recalcValor:valor})
      .then(function(r){
        if(!r)return;
        if(r.error){showToast(r.error,'error');return;}
        // v1.9.0 — await reload antes de re-abrir DebtorModal
        return reload().then(function(){
          setRestructureModal(null);
          if(fromDeudor) setDebtorModal(fromDeudor);
          showToast('Prestamo reestructurado');
        });
      });
  }
  function _marcarMoraBatch(cuotas){
    var promises=cuotas.map(function(p){
      return API.put('/api/payments/'+p.id,{estadoPago:'En Mora',fechaRecaudo:null,observaciones:p.observaciones||'',montoCOPRecibido:0,montoUSDRecibido:0});
    });
    return Promise.all(promises);
  }
  var registrarAbono=useCallback(function(loanId,monto,fecha,obs,montoUSD,liquidar,recalcMode,recalcValor,genRecibo,intExtra,copRecibido){
    var needsPreflight=(recalcMode==='modificarPlazo'||recalcMode==='fijarCuota');
    var enRiesgo=needsPreflight?_cuotasEnRiesgo(pays,loanId):[];
    // v1.17.1: se devuelve la promesa para que AbonoModal libere su guarda anti doble-submit
    if(enRiesgo.length===0){return _doAbono(loanId,monto,fecha,obs,montoUSD,liquidar,recalcMode,recalcValor,genRecibo,intExtra,copRecibido);}
    var loanObj=loans.find(function(l){return l.id===loanId;});
    setPreflightDlg({
      cuotas:enRiesgo,loan:loanObj,
      // v1.18.1: se devuelve la promesa para que PreflightMoraModal libere su guarda.
      onMarkMora:function(){return _marcarMoraBatch(enRiesgo).then(function(){setPreflightDlg(null);return _doAbono(loanId,monto,fecha,obs,montoUSD,liquidar,recalcMode,recalcValor,genRecibo,intExtra,copRecibido);});},
      onContinue:function(){setPreflightDlg(null);return _doAbono(loanId,monto,fecha,obs,montoUSD,liquidar,recalcMode,recalcValor,genRecibo,intExtra,copRecibido);},
      onCancel:function(){setPreflightDlg(null);}
    });
  },[reload,abonoModal,pays,loans]);
  var reestructurarPrestamo=useCallback(function(loanId,mode,valor){
    var fromDeudor=restructureModal&&restructureModal.fromDeudor;
    var enRiesgo=_cuotasEnRiesgo(pays,loanId);
    // v1.18.1: se devuelve la promesa para que RestructureModal libere su guarda (mismo
    // patron que registrarAbono). En la rama de pre-flight se devuelve undefined a proposito:
    // el modal libera de inmediato porque el control pasa al PreflightMoraModal.
    if(enRiesgo.length===0){return _doReestructurar(loanId,mode,valor,fromDeudor);}
    var loanObj=loans.find(function(l){return l.id===loanId;});
    setPreflightDlg({
      cuotas:enRiesgo,loan:loanObj,
      // v1.18.1: se devuelve la promesa para que PreflightMoraModal libere su guarda.
      onMarkMora:function(){return _marcarMoraBatch(enRiesgo).then(function(){setPreflightDlg(null);return _doReestructurar(loanId,mode,valor,fromDeudor);});},
      onContinue:function(){setPreflightDlg(null);return _doReestructurar(loanId,mode,valor,fromDeudor);},
      onCancel:function(){setPreflightDlg(null);}
    });
  },[reload,restructureModal,pays,loans]);

  var metrics=useMemo(function(){
    var td=nowStr(),thisM=td.slice(0,7),nxtW=addDays(td,7);
    var active=loans.filter(function(l){return l.estado==='Activo';});
    var noAbono=function(p){return p.id.indexOf('-ab-')===-1;};
    var mp=pays.filter(function(p){return p.fechaPago.startsWith(thisM)&&noAbono(p);});
    var mora=pays.filter(function(p){return p.estadoPago==='En Mora'&&noAbono(p);});
    // v1.9.x — Recaudo del mes con logica de flujo de caja estricta. Mora arrastrada
    // ya no contamina el "esperado": solo cuenta lo que vence este mes. La mora
    // recuperada (cuotas de otros meses pagadas durante este mes) si suma al "recibido"
    // y aparece en la lista para visibilidad operativa.
    var moraRecuperadaMes=pays.filter(function(p){
      return noAbono(p)
        && !p.fechaPago.startsWith(thisM)
        && p.estadoPago==='Pagado'
        && p.fechaRecaudo
        && p.fechaRecaudo.startsWith(thisM);
    });
    // Ganancia real (historica, todos los estados): para USD usa montoCOPRecibido - capital robusto
    // (cuotaTotal - interesPeriodo), no abonoCapital (que se persiste en 0 en modalidad Prestamo y
    // contaria el capital como ganancia fantasma — Bug #25). Para COP usa interesPeriodo. Excluye abonos.
    // Misma definicion que loanMetrics.ganancia en PortfolioView -> ambas vistas cuadran.
    var loanCurrency={};loans.forEach(function(l){loanCurrency[l.id]=l.moneda;});
    var totalInteresesRecibidos=pays.filter(function(p){return p.estadoPago==='Pagado'&&p.id.indexOf('-ab-')===-1;})
      .reduce(function(s,p){
        var esUSD=loanCurrency[p.prestamoId]==='USD';
        if(esUSD&&p.montoCOPRecibido&&p.montoCOPRecibido>0){
          return s+(p.montoCOPRecibido-(p.cuotaTotal-p.interesPeriodo));
        }
        return s+p.interesPeriodo;
      },0);
    // Saldo real pendiente por préstamo activo (capital - capital recuperado)
    // KPI "Saldo Pendiente" del Inicio. Fase 3: capital vivo = original - CAPITAL IMPUTADO.
    // Antes restaba el parcial COMPLETO, mezclando interes dentro de una cifra de capital y
    // dando un numero distinto al del perfil del deudor para el mismo prestamo.
    var totalDeuda=active.reduce(function(s,l){
      var orig=l.moneda==='USD'?Math.round(l.montoOrigen*l.trmAcordada):Math.round(l.montoOrigen);
      var capImp=pays.filter(function(p){return p.prestamoId===l.id;})
        .reduce(function(a,p){return a+imputarCobros(p).totales.capital;},0);
      return s+Math.max(0,orig-Math.round(capImp));
    },0);
    // ESPERADO = SOLO cuotas con fechaPago en el mes actual (la meta real, sin mora arrastrada)
    var esperadoTot=mp.reduce(function(s,p){return s+p.cuotaTotal;},0);
    // RECIBIDO (Cobros del Mes) = flujo de caja real por FECHA DE TRANSACCION via cobrosDe():
    // ledger de recibos (cada parcial en su dia exacto + el pago final) con fallback a fechaRecaudo.
    // Incluye parciales EN CURSO y abonos a capital. Definicion IDENTICA a sparkCobros -> el KPI ==
    // suma de los puntos del grafico por construccion, sin doble conteo.
    var recibidoTot=pays.reduce(function(s,p){
      return s+cobrosDe(p).reduce(function(a,e){return a+(e.fecha.slice(0,7)===thisM?e.cop:0);},0);
    },0);
    return {
      totalCartera:totalDeuda,
      activeCount:active.length,
      esperado:esperadoTot,
      recibido:recibidoTot,
      mora:mora,totalMora:mora.reduce(function(s,p){return s+pendCuota(p);},0),
      totalInteresesRecibidos:totalInteresesRecibidos,
      hoy:pays.filter(function(p){return p.estadoPago==='Pendiente'&&p.fechaPago===td;})
              .sort(function(a,b){return a.nombreCliente.localeCompare(b.nombreCliente);}),
      proximos:pays.filter(function(p){return p.estadoPago==='Pendiente'&&p.fechaPago>td&&p.fechaPago<=nxtW;})
                   .sort(function(a,b){return a.fechaPago.localeCompare(b.fechaPago);}),
      pronto:pays.filter(function(p){return p.estadoPago==='Pendiente'&&p.fechaPago>td&&p.fechaPago<=addDays(td,3);})
                 .sort(function(a,b){return a.fechaPago.localeCompare(b.fechaPago);}),
      // Lista expandida: cuotas del mes actual (todos los estados) + mora recuperada este mes
      // (NO incluye mora historica pendiente — esa vive en la tarjeta "Pagos en Mora")
      recaudoList:mp.concat(moraRecuperadaMes)
                   .sort(function(a,b){return a.fechaPago.localeCompare(b.fechaPago)||a.nombreCliente.localeCompare(b.nombreCliente);})
    };
  },[loans,pays]);

  var filtPays=useMemo(function(){
    return pays.filter(function(p){
      if(p.estadoPago==='Pagado') return false;
      if(searchQ&&!payMatchesQuery(p,searchQ)) return false;
      if(fMonth&&p.fechaPago.indexOf(fMonth)!==0) return false;
      return true;
    }).sort(function(a,b){return a.fechaPago.localeCompare(b.fechaPago)||a.nombreCliente.localeCompare(b.nombreCliente);});
  },[pays,searchQ,fMonth]);

  // Deudores: agrupar loans por nombre
  var deudores=useMemo(function(){
    var map={};
    loans.forEach(function(l){
      var key=l.nombre;
      if(!map[key]) map[key]={nombre:l.nombre,cedula:l.cedula,telefono:l.telefono,loans:[],totalSaldo:0,totalSaldoUSD:0,mora:0};
      map[key].loans.push(l);
      if(l.estado==='Activo'){
        var origL=l.moneda==='USD'?Math.round(l.montoOrigen*l.trmAcordada):Math.round(l.montoOrigen);
        // Fase 2: el saldo mostrado descuenta el CAPITAL imputado, no el parcial completo. Restar
        // `partialPend` crudo descontaba de una cifra de capital una plata que en parte era interes,
        // y ademas contradecia al panel de Flujo de Caja del mismo perfil (medido: $200.000 de
        // diferencia entre la cabecera y la tabla, sobre el mismo prestamo).
        var capImpL=pays.filter(function(p){return p.prestamoId===l.id;})
          .reduce(function(s,p){return s+imputarCobros(p).totales.capital;},0);
        var saldoLoan=Math.max(0,origL-Math.round(capImpL));
        map[key].totalSaldo+=saldoLoan;
        if(l.moneda==='USD'&&l.trmAcordada>0) map[key].totalSaldoUSD+=Math.round(saldoLoan/l.trmAcordada*100)/100;
      }
    });
    // Add mora count per deudor
    pays.forEach(function(p){
      if(p.estadoPago==='En Mora'){
        var loan=null;
        for(var i=0;i<loans.length;i++){if(loans[i].id===p.prestamoId){loan=loans[i];break;}}
        if(loan&&map[loan.nombre]) map[loan.nombre].mora++;
      }
    });
    return Object.values(map).sort(function(a,b){
      var aActivos=a.loans.filter(function(l){return l.estado==='Activo';});
      var bActivos=b.loans.filter(function(l){return l.estado==='Activo';});
      // Activos primero, inactivos al final
      if(aActivos.length>0&&bActivos.length===0) return -1;
      if(aActivos.length===0&&bActivos.length>0) return 1;
      if(aActivos.length===0&&bActivos.length===0) return a.nombre.localeCompare(b.nombre);
      // Entre activos: más nuevo arriba, más viejo abajo
      var aFecha=aActivos.reduce(function(min,l){return l.fechaInicio<min?l.fechaInicio:min;},aActivos[0].fechaInicio);
      var bFecha=bActivos.reduce(function(min,l){return l.fechaInicio<min?l.fechaInicio:min;},bActivos[0].fechaInicio);
      return bFecha.localeCompare(aFecha);
    });
  },[loans,pays]);


  // Busqueda global
  var gResults=useMemo(function(){
    if(!gQ||gQ.length<2) return [];
    var q=gQ.toLowerCase();
    var results=[];
    // Deudores
    deudores.forEach(function(d){
      if(d.nombre.toLowerCase().indexOf(q)!==-1)
        results.push({type:'deudor',label:d.nombre,sub:d.loans.length+' prestamos - '+fmt(d.totalSaldo),data:d});
    });
    // Prestamos
    loans.forEach(function(l){
      if(l.nombre.toLowerCase().indexOf(q)!==-1||l.modalidad.toLowerCase().indexOf(q)!==-1)
        results.push({type:'prestamo',label:l.nombre+' - '+l.modalidad,sub:fmt(Math.round(l.montoOrigen*(l.moneda==='USD'?l.trmAcordada:1)))+' | '+l.estado,data:l});
    });
    // Pagos pendientes/mora
    pays.forEach(function(p){
      if(p.estadoPago==='Pagado') return;
      if(p.nombreCliente.toLowerCase().indexOf(q)!==-1)
        results.push({type:'pago',label:p.nombreCliente+' - Cuota '+p.cuotaN,sub:fmt(p.cuotaTotal)+' | '+p.estadoPago+' | '+fmtD(p.fechaPago),data:p});
    });
    return results.slice(0,15);
  },[gQ,deudores,loans,pays]);

  function openGSearch(){setGSearch(true);setGQ('');}
  function closeGSearch(){setGSearch(false);setGQ('');}

  // Abrir perfil deudor por nombre
  function openDebtorByName(nombre){
    var d=deudores.find(function(x){return x.nombre===nombre;});
    if(d) setDebtorModal(d);
  }

  // Botón rápido ✓: abre PayModal (permite elegir Completo o Parcial)
  var quickPay=openPayModal;

  if(loading) return h('div',{style:{display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',height:'100vh',background:'var(--bg)',gap:16}},
    h('div',{className:'spinner'}),
    h('p',{style:{color:'var(--text3)',fontSize:13}},'Cargando...'));

  var navSections=[
    {key:'prestamos',label:'Prestamos',items:[
      ['dashboard','home','Resumen'],
      ['cartera','briefcase','Cartera'],
      ['deudores','users','Deudores'],
      ['pagos','check2','Pagos'],
      ['rendimiento','trending','Rendimiento'],
      ['calculadora','calc','Calculadora'],
      ['historial','activity','Historial']
    ]},
    {key:'deudas',label:'Deudas',items:[
      ['deudas','wallet','Mis Deudas']
    ]}
  ];
  var navStandalone=[['desarrollador','settings','Desarrollador']];
  // Lista plana derivada (para el lookup de icono+label de la vista actual en el header).
  var nav=navSections.reduce(function(acc,s){return acc.concat(s.items);},[]).concat(navStandalone);

  function navTo(id){
    setView(id);setMenuOpen(false);
    if(id==='historial') loadHistorial();
    if(id==='deudas') loadDebts();
  }

  // Acordeon del sidebar: alterna una seccion y persiste el estado en localStorage (sobrevive F5).
  function toggleNavSection(key){
    setNavOpen(function(prev){
      var next=Object.assign({},prev); next[key]=!next[key];
      try{ localStorage.setItem('navSections',JSON.stringify(next)); }catch(_){}
      return next;
    });
  }

  var sidebarCollapsed = menuOpen;
  function toggleSidebar(){ setMenuOpen(!menuOpen); }

  return h('div',{className:'app-layout'},
    // ── Sidebar ──
    h('div',{className:'sidebar'+(menuOpen?' collapsed':'')},
      h('div',{className:'sidebar-header'},
        h(Ico,{name:'briefcase',size:18,color:'var(--green)'}),
        h('div',null,
          h('div',{style:{fontWeight:700,fontSize:16,color:'var(--text)'}},'Cartera'),
          h('div',{style:{fontSize:12,color:'var(--text3)',fontFamily:'monospace'}},metrics.activeCount+' activos'))),
      h('div',{className:'sidebar-nav'},
        navSections.map(function(sec){
          var open=navOpen[sec.key]!==false;
          return h('div',{key:sec.key,style:{marginBottom:2}},
            h('button',{onClick:function(){toggleNavSection(sec.key);},style:{display:'flex',alignItems:'center',justifyContent:'space-between',width:'100%',background:'none',border:'none',cursor:'pointer',fontFamily:'inherit',color:'var(--text3)',fontSize:11,fontWeight:700,textTransform:'uppercase',letterSpacing:'.6px',padding:'10px 14px 5px',userSelect:'none'}},
              h('span',null,sec.label),
              h(Ico,{name:open?'chevdown':'chevright',size:14,color:'var(--text3)'})),
            open?sec.items.map(function(item){
              var id=item[0],icon=item[1],label=item[2];
              return h('button',{key:id,className:'nav-item'+(view===id?' active':''),onClick:function(){navTo(id);},style:{paddingLeft:24}},
                h(Ico,{name:icon,size:18,color:view===id?'var(--green)':'var(--text3)'}),label);
            }):null);
        }),
        h('div',{style:{height:1,background:'var(--border)',margin:'8px 8px'}}),
        navStandalone.map(function(item){
          var id=item[0],icon=item[1],label=item[2];
          return h('button',{key:id,className:'nav-item'+(view===id?' active':''),onClick:function(){navTo(id);}},
            h(Ico,{name:icon,size:18,color:view===id?'var(--green)':'var(--text3)'}),label);
        })),
      h('div',{className:'sidebar-footer'},'v'+(window._appVersion||''))),
    // ── Main Area ──
    h('div',{className:'main-area'},
      h('div',{className:'main-header'},
        h('button',{onClick:toggleSidebar,style:{background:'none',border:'none',cursor:'pointer',padding:4,display:'flex'}},
          h(Ico,{name:'menu',size:22,color:'var(--text)'})),
        h('div',{style:{display:'flex',alignItems:'center',gap:8}},
          h(Ico,{name:nav.find(function(n){return n[0]===view;})?nav.find(function(n){return n[0]===view;})[1]:'home',size:18,color:'var(--green)'}),
          h('span',{style:{fontWeight:700,fontSize:16,color:'var(--text)'}},nav.find(function(n){return n[0]===view;})?nav.find(function(n){return n[0]===view;})[2]:'Inicio')),
        h('div',{style:{flex:1}}),
        h('div',{style:{display:'flex',alignItems:'center',gap:8}},
          metrics.pronto.length>0&&h('div',{onClick:function(){navTo('pagos');},style:{background:'var(--yellow-bg)',border:'1px solid var(--yellow)',padding:'5px 10px',borderRadius:99,fontSize:12,fontWeight:700,display:'flex',alignItems:'center',gap:4,cursor:'pointer',color:'var(--yellow)'},title:'Cuotas por vencer en 3 dias'},
            h(Ico,{name:'clock',size:12,color:'var(--yellow)'}),metrics.pronto.length,' pronto'),
          metrics.mora.length>0&&h('div',{onClick:function(){setSearchQ('');setFMonth('');navTo('pagos');},style:{background:'var(--red-bg)',border:'1px solid var(--red-bd)',padding:'5px 10px',borderRadius:99,fontSize:12,fontWeight:700,display:'flex',alignItems:'center',gap:4,cursor:'pointer',color:'var(--red)'}},
            h(Ico,{name:'bell',size:12,color:'var(--red)'}),metrics.mora.length,' mora'),
          h('button',{onClick:openGSearch,style:{background:'var(--bg3)',border:'1px solid var(--border)',borderRadius:99,padding:'6px 8px',cursor:'pointer',display:'flex',alignItems:'center'}},
            h(Ico,{name:'search',size:14,color:'var(--text3)'})),
          h('button',{onClick:toggleTheme,style:{background:'var(--bg3)',border:'1px solid var(--border)',borderRadius:99,padding:'6px 8px',cursor:'pointer',display:'flex',alignItems:'center'},title:theme==='dark'?'Tema claro':'Tema oscuro'},
            h(Ico,{name:theme==='dark'?'sun':'moon',size:14,color:'var(--text3)'})))),
      globalUpdate&&globalUpdate.status==='available'&&h('div',{style:{background:'var(--green-bg)',border:'1px solid var(--green-bd)',padding:'10px 20px',display:'flex',alignItems:'center',justifyContent:'space-between',gap:10,flexShrink:0}},
        h('div',{style:{display:'flex',alignItems:'center',gap:8}},
          h(Ico,{name:'download',size:16,color:'var(--green)'}),
          h('span',{style:{fontSize:12,color:'var(--green)',fontWeight:600}},'Nueva version v'+globalUpdate.version+' disponible')),
        h('div',{style:{display:'flex',gap:8}},
          h('button',{onClick:function(){window.electronAPI.downloadUpdate();},style:{background:'var(--green2)',color:'#fff',border:'none',borderRadius:8,padding:'6px 14px',fontSize:11,fontWeight:600,cursor:'pointer',fontFamily:'inherit'}},'Descargar'),
          h('button',{onClick:function(){setGlobalUpdate(null);},style:{background:'none',border:'none',cursor:'pointer',padding:4,display:'flex'}},
            h(Ico,{name:'x',size:14,color:'var(--green)'})))),
      globalUpdate&&globalUpdate.status==='downloading'&&h('div',{style:{background:'var(--blue-bg)',border:'1px solid var(--blue-bd)',padding:'10px 20px',display:'flex',alignItems:'center',gap:10,flexShrink:0}},
        h(Ico,{name:'download',size:16,color:'var(--blue)'}),
        h('div',{style:{flex:1}},
          h('div',{style:{fontSize:12,color:'var(--blue)',fontWeight:600,marginBottom:4}},'Descargando actualizacion... '+(globalUpdate.percent||0)+'%'),
          h('div',{style:{background:'var(--bg3)',borderRadius:6,height:5,overflow:'hidden'}},
            h('div',{style:{width:(globalUpdate.percent||0)+'%',height:'100%',background:'var(--blue)',borderRadius:6,transition:'width .3s'}})))),
      globalUpdate&&globalUpdate.status==='downloaded'&&h('div',{style:{background:'var(--green-bg)',border:'1px solid var(--green-bd)',padding:'10px 20px',display:'flex',alignItems:'center',justifyContent:'space-between',gap:10,flexShrink:0}},
        h('div',{style:{display:'flex',alignItems:'center',gap:8}},
          h(Ico,{name:'check',size:16,color:'var(--green)'}),
          h('span',{style:{fontSize:12,color:'var(--green)',fontWeight:600}},'v'+globalUpdate.version+' lista para instalar')),
        h('button',{onClick:function(){window.electronAPI.installUpdate();},style:{background:'var(--green2)',color:'#fff',border:'none',borderRadius:8,padding:'6px 14px',fontSize:11,fontWeight:600,cursor:'pointer',fontFamily:'inherit'}},'Reiniciar e instalar')),
      h('div',{className:'main-content'},
      view==='dashboard'  && h(DashView,  {metrics:metrics,isEmpty:loans.length===0,onNav:navTo,loans:loans,pays:pays,onNameClick:openDebtorByName,onNewLoan:function(){navTo('cartera');setLoanModal('new');}}),
      view==='cartera'    && h(CarteraView,{loans:loans,pays:pays,onAdd:function(){setLoanModal('new');},onEdit:setLoanModal,onDelete:delLoan,onAbono:setAbonoModal,onForceClose:forceCloseLoan}),
      view==='deudores'   && h(DeudoresView,{deudores:deudores,pays:pays,onSelect:setDebtorModal,onAdd:function(){setLoanModal('new');}}),
      view==='pagos'      && h(PagosView,  {pays:filtPays,allPays:pays,loans:loans,searchQ:searchQ,setSearchQ:setSearchQ,fMonth:fMonth,setFMonth:setFMonth,onSelect:openPayModal,onQuickPay:quickPay,onNameClick:openDebtorByName,datosPago:cfg.datos_pago}),
      view==='rendimiento'&& h(PortfolioView,{loans:loans,pays:pays}),
      view==='calculadora'&& h(CalcView,   {onConfirm:confirmarCalc}),
      view==='historial'   && h(HistorialView,{actLog:actLog,undoLog:undoLog,onUndo:function(entry){setUndoDlg(entry);},
        onRefresh:function(){loadHistorial().then(function(){showToast('Historial actualizado');});}}),
      view==='deudas'      && h(DebtsView,{debts:debts,onReload:loadDebts,onNew:function(){setDebtModal('new');},onPay:function(d){setDebtPayModal(d);},onEdit:function(d){setDebtModal(d);},onDelete:function(d){setDebtDelete(d);},onHistory:function(d){setDebtHistory(d);}}),
      view==='desarrollador'&& h(DevView,  {showToast:showToast,isMac:isMac,onNeedsRestart:function(){setNeedsRestart(true);},onSync:recalculate,onConfirm:function(cfg){setConfirmDlg(cfg);},loans:loans,pays:pays,datosPago:cfg.datos_pago,onSaveConfig:saveConfig}))
    ), /* end main-area */
    loanModal&&h(LoanModal,{loan:loanModal==='new'?null:loanModal,trm:cfg.trm,pays:pays,clientes:deudores,onSave:saveLoan,onClose:function(){setLoanModal(null);}}),
    payModal &&h(PayModal, {pay:payModal.pay,loan:payModal.loan,allPays:pays,onMark:markPay,onPartial:markPartial,onClose:function(){setPayModal(null);}}),
    debtModal&&h(DebtModal,{debt:debtModal==='new'?null:debtModal,onSave:saveDebt,onClose:function(){setDebtModal(null);},existingAcreedores:existingAcreedores}),
    debtPayModal&&h(DebtPayModal,{debt:debtPayModal,onSave:payDebt,onClose:function(){setDebtPayModal(null);}}),
    debtHistory&&h(DebtHistoryModal,{debt:debtHistory,onClose:function(){setDebtHistory(null);}}),
    debtDelete&&h(DeleteDebtModal,{debt:debtDelete,onConfirm:function(){var id=debtDelete.id;setDebtDelete(null);deleteDebt(id);},onClose:function(){setDebtDelete(null);}}),
    abonoModal&&h(AbonoModal,{loan:abonoModal.loan||abonoModal,pays:pays,onSave:registrarAbono,onClose:function(){if(abonoModal.fromDeudor){setDebtorModal(abonoModal.fromDeudor);} setAbonoModal(null);},
      // v2.0.0 — CTA "Liquidar deuda" del AbonoModal (cuando el abono excede el capital
      // amortizable por haber capital atrapado en cuotas En Mora). Cierra el abono y abre el
      // modal de liquidacion CONSERVANDO fromDeudor, para que Cancelar devuelva al perfil.
      // No se reutiliza onClose a proposito: ese re-abriria DebtorModal encima.
      onRequestLiquidar:function(l){var fd=abonoModal&&abonoModal.fromDeudor;setAbonoModal(null);setLiquidarModal({loan:l,fromDeudor:fd});}}),
    debtorModal&&h(DebtorModal,{deudor:debtorModal,pays:pays,loans:loans,onClose:function(){setDebtorModal(null);},onNewLoan:function(d){setDebtorModal(null);setLoanModal({_prefill:{nombre:d.nombre,cedula:d.cedula,telefono:d.telefono}});},onAbono:function(l){var dRef=debtorModal;setDebtorModal(null);setAbonoModal({loan:l,fromDeudor:dRef});},onReestructurar:function(l){var dRef=debtorModal;setDebtorModal(null);setRestructureModal({loan:l,fromDeudor:dRef});},
      // v2.0.0 — el modal de liquidacion se elevo a App; aqui solo se DISPARA, con el mismo
      // patron fromDeudor de onAbono/onReestructurar (Cancelar devuelve al perfil).
      onRequestLiquidar:function(l){var dRef=debtorModal;setDebtorModal(null);setLiquidarModal({loan:l,fromDeudor:dRef});},onReload:reload}),
    // v2.0.0 — LiquidarModal a nivel App (antes vivia DENTRO de DebtorModal, por eso era
    // inalcanzable desde AbonoModal). La logica de confirmacion es la MISMA de v1.19.0:
    // registrarAbono(...,liquidar=true,...) con el mismo obs y el mismo intExtra.
    liquidarModal&&h(LiquidarModal,{loan:liquidarModal.loan,pays:pays,
      onClose:function(){if(liquidarModal.fromDeudor){setDebtorModal(liquidarModal.fromDeudor);} setLiquidarModal(null);},
      onConfirm:function(loanId,monto,intExtra){var obs='Liquidacion total'+(intExtra>0?' + intereses anticipados proximo mes: $'+Math.round(intExtra).toLocaleString('es-CO'):'');
      // v1.18.1: se devuelve la promesa para que el modal de liquidacion libere su guarda.
      // Hasta ahora la unica proteccion era accidental: setDebtorModal(null) desmontaba el
      // modal en el mismo click, y el backend rechazaba el 2o intento porque el saldo ya
      // era 0. Ninguna de las dos es una garantia — la primera se cae con cualquier refactor
      // que mantenga el modal montado, y la segunda no aplica a una liquidacion parcial.
      // Tras liquidar NO se re-abre el perfil (comportamiento identico a v1.19.0).
      var _p=registrarAbono(loanId,monto,nowStr(),obs,0,true,null,null,undefined,intExtra);setLiquidarModal(null);setDebtorModal(null);return _p;}}),
    restructureModal&&h(RestructureModal,{loan:restructureModal.loan||restructureModal,pays:pays,onSave:reestructurarPrestamo,onClose:function(){if(restructureModal.fromDeudor){setDebtorModal(restructureModal.fromDeudor);} setRestructureModal(null);}}),
    preflightDlg&&h(PreflightMoraModal,{cuotas:preflightDlg.cuotas,loan:preflightDlg.loan,onMarkMora:preflightDlg.onMarkMora,onContinue:preflightDlg.onContinue,onCancel:preflightDlg.onCancel}),
    confirmDlg&&h(ConfirmModal,Object.assign({},confirmDlg,{onCancel:function(){setConfirmDlg(null);}})),
    // "La Bestia" Fase 2 — confirmacion de deshacer, con los candados C (>24h) y D (recibo).
    undoDlg&&h(ConfirmUndoModal,{entry:undoDlg,onConfirm:confirmarUndo,onClose:function(){setUndoDlg(null);}}),
    // v1.9.x — Changelog modal con max-height + scroll interno. Header (titulo) y
    // footer (boton Entendido) quedan fijos; solo la lista de items hace scroll.
    changelogDlg&&h('div',{className:'modal-overlay',onClick:function(){setChangelogDlg(null);}},
      h('div',{className:'modal-panel',onClick:function(e){e.stopPropagation();},style:{maxWidth:380,maxHeight:'min(620px,80vh)',display:'flex',flexDirection:'column'}},
        // Header fijo (handle + icono + titulo)
        h('div',{style:{flexShrink:0}},
          h('div',{className:'modal-handle'}),
          h('div',{style:{textAlign:'center',marginBottom:14}},
            h('div',{style:{marginBottom:6}},h(Ico,{name:'sparkle',size:28,color:'var(--green)'})),
            h('div',{style:{fontWeight:700,fontSize:17,color:'var(--text)'}},'Novedades de la version '+changelogDlg.version),
            h('div',{style:{fontSize:11,color:'var(--text3)',marginTop:4,fontStyle:'italic'}},changelogDlg.items.length+' '+(changelogDlg.items.length===1?'cambio':'cambios')))),
        // Cuerpo scrolleable (la lista de items)
        h('div',{style:{flex:'1 1 auto',minHeight:0,overflowY:'auto',marginBottom:14,paddingRight:6,borderTop:'1px solid var(--border)',borderBottom:'1px solid var(--border)',paddingTop:6,paddingBottom:6}},
          changelogDlg.items.map(function(item,i){
            return h('div',{key:i,style:{display:'flex',alignItems:'flex-start',gap:8,padding:'7px 0',fontSize:13,color:'var(--text2)',lineHeight:1.45}},
              h('div',{style:{flexShrink:0,marginTop:2}},h(Ico,{name:'check',size:14,color:'var(--green)',sw:2.4})),
              h('span',null,item));
          })),
        // Footer fijo (boton)
        h('button',{onClick:function(){setChangelogDlg(null);},style:{flexShrink:0,width:'100%',padding:'10px 0',background:'var(--green2)',color:'#fff',border:'none',borderRadius:10,fontWeight:700,fontSize:14,cursor:'pointer',fontFamily:'inherit'}},'Entendido'))),
    errorDlg&&h('div',{className:'modal-overlay',onClick:function(){setErrorDlg(null);}},
      h('div',{className:'modal-panel',onClick:function(e){e.stopPropagation();},style:{maxWidth:400}},
        h('div',{className:'modal-handle'}),
        h('div',{style:{textAlign:'center',marginBottom:14}},
          h('div',{style:{marginBottom:6}},h(Ico,{name:'alert',size:28,color:'var(--yellow)'})),
          h('div',{style:{fontWeight:700,fontSize:17,color:'var(--yellow)'}},errorDlg.title||'Error')),
        h('div',{style:{marginBottom:16}},
          errorDlg.messages.map(function(msg,i){
            return h('div',{key:i,style:{padding:'8px 12px',marginBottom:6,background:'var(--yellow-bg)',border:'1px solid var(--yellow)',borderRadius:8,fontSize:13,color:'var(--text)',whiteSpace:'pre-wrap'}},msg);
          })),
        h('button',{onClick:function(){setErrorDlg(null);},style:{width:'100%',padding:'10px 0',background:'var(--bg4)',color:'var(--text)',border:'1px solid var(--border)',borderRadius:10,fontWeight:700,fontSize:14,cursor:'pointer'}},'Entendido'))),
    gSearch&&h('div',{className:'gsearch-overlay',onClick:closeGSearch},
      h('div',{className:'gsearch-box',onClick:function(e){e.stopPropagation();}},
        h('div',{style:{position:'relative'}},
          h('div',{style:{position:'absolute',left:14,top:'50%',transform:'translateY(-50%)',display:'flex'}},h(Ico,{name:'search',size:16,color:'var(--green)'})),
          h('input',{className:'gsearch-input',value:gQ,onChange:function(e){setGQ(e.target.value);},placeholder:'Buscar cliente, prestamo, pago...',autoFocus:true})),
        gResults.length>0&&h('div',{className:'gsearch-results'},
          gResults.map(function(r,i){
            var catColor=r.type==='deudor'?'var(--blue)':r.type==='prestamo'?'var(--green)':'var(--yellow)';
            var catBg=r.type==='deudor'?'var(--blue-bg)':r.type==='prestamo'?'var(--green-bg)':'var(--yellow-bg)';
            var catLabel=r.type==='deudor'?'DEUDOR':r.type==='prestamo'?'PRESTAMO':'PAGO';
            return h('div',{key:i,className:'gsearch-item',onClick:function(){
              closeGSearch();
              if(r.type==='deudor') setDebtorModal(r.data);
              else if(r.type==='prestamo'){navTo('cartera');}
              else if(r.type==='pago') openPayModal(r.data);
            }},
              h('span',{className:'gsearch-cat',style:{background:catBg,color:catColor}},catLabel),
              h('div',{style:{flex:1,minWidth:0}},
                h('div',{style:{fontSize:13,fontWeight:600,color:'var(--text)',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}},r.label),
                h('div',{style:{fontSize:11,color:'var(--text3)',marginTop:1}},r.sub)));
          })),
        gQ.length>=2&&gResults.length===0&&h('div',{style:{padding:'20px 16px',textAlign:'center',color:'var(--text3)',fontSize:12}},'Sin resultados para "'+gQ+'"'))),
    toast&&h('div',{className:'toast'+(toast.out?' out':''),style:{background:toast.type==='error'?'var(--red-bg)':'var(--green-bg)',border:'1px solid '+(toast.type==='error'?'var(--red-bd)':'var(--green-bd)'),color:toast.type==='error'?'var(--red)':'var(--green)'}},toast.msg),
    needsRestart&&h('div',{style:{position:'fixed',inset:0,background:'rgba(0,0,0,.92)',display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',zIndex:999,backdropFilter:'blur(8px)'}},
      h(Ico,{name:'refresh-cw',size:40,color:'var(--green)'}),
      h('div',{style:{fontSize:18,fontWeight:700,color:'var(--text)',marginTop:16,marginBottom:8}},'Ruta actualizada'),
      h('div',{style:{fontSize:13,color:'var(--text3)',marginBottom:24,textAlign:'center',padding:'0 40px'}},'Debes reiniciar la app para usar la nueva ubicacion de la base de datos.'),
      h('button',{onClick:function(){if(window.electronAPI) window.electronAPI.relaunch();},style:{background:'var(--green)',color:'#fff',border:'none',borderRadius:12,padding:'14px 48px',fontSize:15,fontWeight:700,cursor:'pointer',fontFamily:'inherit'}},'Reiniciar')));
}

// ── Dashboard ─────────────────────────────────────────────────────────────────
// ── Gráfico financiero compacto (SVG puro, sin dependencias) ────────────────
// Marco clasico (eje Y Oeste + eje X Sur solidos), grid tenue punteado, linea de
// tendencia + relleno degradado, etiquetas Y (max/min, abreviadas k/M) e eje X (meses).
// Caja ESTRICTA via overflow:hidden. Padding asimetrico: padL deja aire al eje Y y sus
// etiquetas; padB deja aire al eje X + la fila de meses. Todo cabe dentro de w x hgt.
function SparklineChart(props){
  var _hov=useState(null);var hoveredIndex=_hov[0];var setHoveredIndex=_hov[1];
  var data=props.data||[];
  if(data.length<2) return null;
  var labels=props.labels||[],tipLabels=props.tipLabels||[];
  var w=props.width||298,hgt=props.height||98,stroke=props.color||'var(--green)';
  var padL=32,padR=20,padT=16,padB=22;                // padding moderado (el fix real fue z-index): recupera variacion vertical. padB aloja eje X + meses
  var plotL=padL,plotR=w-padR,plotT=padT,plotB=hgt-padB;
  var min=Math.min.apply(null,data),max=Math.max.apply(null,data),flat=max===min,range=(max-min)||1,n=data.length;
  function fmtSpark(v){var a=Math.abs(v);if(a>=1e6)return (v/1e6).toFixed(a>=1e7?0:1).replace(/\.0$/,'')+'M';if(a>=1e3)return Math.round(v/1e3)+'k';return String(Math.round(v));}
  var pts=data.map(function(v,i){
    var x=plotL+(i*(plotR-plotL)/(n-1));
    var y=flat?(plotT+plotB)/2:plotT+(1-(v-min)/range)*(plotB-plotT);
    return [Math.round(x*10)/10,Math.round(y*10)/10];
  });
  var line=pts.map(function(p,i){return (i===0?'M':'L')+p[0]+' '+p[1];}).join(' ');
  var area='M'+pts[0][0]+' '+plotB+' '+pts.map(function(p){return 'L'+p[0]+' '+p[1];}).join(' ')+' L'+pts[n-1][0]+' '+plotB+' Z';
  var gid='spark-'+String(props.id||'g').replace(/[^a-z0-9]/gi,'');
  var lblStyle={fill:'var(--text3)',fontSize:9,fontFamily:"'Cascadia Code','Consolas',monospace"};
  var hGrid=[0.25,0.5,0.75].map(function(f){return Math.round((plotT+f*(plotB-plotT))*10)/10;});
  // Tooltip interactivo: geometria del punto activo, anclada para NO salirse de la caja.
  var dense=n>14,rBase=dense?2:3.4,mono="'Cascadia Code','Consolas',monospace",tip=null;
  if(hoveredIndex!=null&&pts[hoveredIndex]){
    var cx=pts[hoveredIndex][0],cy=pts[hoveredIndex][1];
    var tLab=tipLabels[hoveredIndex]||labels[hoveredIndex]||('#'+(hoveredIndex+1));
    var tVal=fmt(data[hoveredIndex]);
    // Anclaje NATIVO con text-anchor (el motor de fuentes resuelve el ancho; sin medir tw).
    // rect de ancho FIJO; mitad derecha -> tooltip a la IZQ, mitad izq -> a la DER. Auto-acotado.
    var rightHalf=cx>w/2,anchor=rightHalf?'end':'start',rectW=78,rectH=26;
    var textX=rightHalf?cx-12:cx+12;
    var rectX=rightHalf?textX-(rectW-8):textX-5;
    var rectY=(cy<30)?cy+12:cy-12-rectH;                 // punto alto (cerca del techo) -> tooltip ABAJO; si no, arriba
    rectY=Math.max(2,Math.min(rectY,hgt-rectH-2));        // clamp vertical (textos relativos a rectY -> sin desync)
    tip={cx:cx,cy:cy,tLab:tLab,tVal:tVal,anchor:anchor,textX:textX,rectX:rectX,rectW:rectW,rectH:rectH,rectY:rectY};
  }
  return h('svg',{width:w,height:hgt,viewBox:'0 0 '+w+' '+hgt,style:Object.assign({display:'block',overflow:'hidden'},props.style||{})},
    h('defs',null,
      h('linearGradient',{id:gid,x1:'0',y1:'0',x2:'0',y2:'1'},
        h('stop',{offset:'0%',style:{stopColor:stroke,stopOpacity:.24}}),
        h('stop',{offset:'100%',style:{stopColor:stroke,stopOpacity:0}}))),
    hGrid.map(function(y,i){return h('line',{key:'h'+i,x1:plotL,y1:y,x2:plotR,y2:y,stroke:'var(--border)',strokeWidth:1,strokeDasharray:'2,4',opacity:.5});}),
    pts.map(function(p,i){return (!labels.length||labels[i])?h('line',{key:'v'+i,x1:p[0],y1:plotT,x2:p[0],y2:plotB,stroke:'var(--border)',strokeWidth:1,strokeDasharray:'2,4',opacity:.5}):null;}),
    h('path',{d:area,fill:'url(#'+gid+')',stroke:'none'}),
    h('line',{x1:plotL,y1:plotT,x2:plotL,y2:plotB,stroke:'var(--border)',strokeWidth:1}),
    h('line',{x1:plotL,y1:plotB,x2:plotR,y2:plotB,stroke:'var(--border)',strokeWidth:1}),
    h('path',{d:line,fill:'none',stroke:stroke,strokeWidth:2,strokeLinecap:'round',strokeLinejoin:'round'}),
    tip&&h('line',{x1:tip.cx,y1:tip.cy,x2:tip.cx,y2:plotB,stroke:stroke,strokeWidth:1,strokeDasharray:'2,2',opacity:.55}),
    pts.map(function(p,i){
      var act=i===hoveredIndex,on=data[i]>0;   // on = periodo con actividad (>0) -> dorado; si es 0 -> invisible pero interactivo
      return on
        ? h('circle',{key:'pt'+i,cx:p[0],cy:p[1],r:act?rBase+2:rBase,fill:'var(--gold)',stroke:'var(--bg2)',strokeWidth:act?1.5:1,opacity:act?1:(dense?.6:.9),pointerEvents:'all',style:{cursor:'pointer'},onMouseEnter:function(){setHoveredIndex(i);},onMouseLeave:function(){setHoveredIndex(null);}})
        : h('circle',{key:'pt'+i,cx:p[0],cy:p[1],r:dense?3.2:4,fill:'transparent',pointerEvents:'all',style:{cursor:'pointer'},onMouseEnter:function(){setHoveredIndex(i);},onMouseLeave:function(){setHoveredIndex(null);}});
    }),
    h('text',{x:plotL-4,y:plotT+3,textAnchor:'end',style:lblStyle},fmtSpark(max)),
    h('text',{x:plotL-4,y:plotB,textAnchor:'end',style:lblStyle},fmtSpark(min)),
    labels.length===n&&pts.map(function(p,i){return labels[i]?h('text',{key:'m'+i,x:p[0],y:plotB+13,textAnchor:'middle',style:lblStyle},labels[i]):null;}),
    tip&&h('g',{style:{pointerEvents:'none'}},
      h('rect',{x:tip.rectX,y:tip.rectY,width:tip.rectW,height:tip.rectH,rx:4,ry:4,fill:'var(--bg4)',stroke:'var(--border)',strokeWidth:1}),
      h('text',{x:tip.textX,y:tip.rectY+10,textAnchor:tip.anchor,style:{fill:'var(--text3)',fontSize:8.5,fontFamily:mono}},tip.tLab),
      h('text',{x:tip.textX,y:tip.rectY+21,textAnchor:tip.anchor,style:{fill:'var(--text)',fontSize:10,fontWeight:700,fontFamily:mono}},tip.tVal)));
}

function DashView(props){
  var metrics=props.metrics,isEmpty=props.isEmpty,onNav=props.onNav,loans=props.loans||[],pays=props.pays||[],onNameClick=props.onNameClick,onNewLoan=props.onNewLoan;
  var loanMap={};loans.forEach(function(l){loanMap[l.id]=l;});
  var pct=metrics.esperado>0?Math.round(metrics.recibido/metrics.esperado*100):0;
  var _recOpen=useState(false);var recaudoOpen=_recOpen[0];var setRecaudoOpen=_recOpen[1];
  // ── Selector de mes en la tarjeta "Recaudo" ────────────────────────────────
  // Solo ESTA tarjeta pagina; el KPI "Cobros del Mes" sigue fijo en el mes actual
  // (usa el metrics global). El default es el mes en curso.
  var _selM=useState(nowStr().slice(0,7));var selMonth=_selM[0];var setSelMonth=_selM[1];
  function shiftMonth(delta){
    var y=parseInt(selMonth.slice(0,4),10),m=parseInt(selMonth.slice(5,7),10)-1+delta;
    var dd=new Date(y,m,1);
    setSelMonth(dd.getFullYear()+'-'+String(dd.getMonth()+1).padStart(2,'0'));
  }
  var MESES_ES=['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
  var selMonthLabel=MESES_ES[parseInt(selMonth.slice(5,7),10)-1]+' De '+selMonth.slice(0,4);
  // Recaudo del mes seleccionado (hibrido aprobado): cuotas Pagadas se cuentan por fecha
  // de transaccion (fechaRecaudo) -> la mora vieja cobrada este mes cuenta este mes; los
  // parciales EN CURSO se cuentan por fechaPago (unica fecha disponible para un parcial).
  var recaudoMes=useMemo(function(){
    var noAb=function(p){return p.id.indexOf('-ab-')===-1;};
    var dueMes=pays.filter(function(p){return noAb(p)&&p.fechaPago.startsWith(selMonth);});
    var paidMes=pays.filter(function(p){return noAb(p)&&p.estadoPago==='Pagado'&&p.fechaRecaudo&&p.fechaRecaudo.startsWith(selMonth);});
    var esperado=dueMes.reduce(function(s,p){return s+p.cuotaTotal;},0);
    var recibA=paidMes.reduce(function(s,p){return s+(p.montoCOPRecibido||p.cuotaTotal);},0);
    var recibB=dueMes.reduce(function(s,p){return p.estadoPago!=='Pagado'?s+(p.partialPaid||0):s;},0);
    var seen={},list=[];
    dueMes.concat(paidMes).forEach(function(p){if(!seen[p.id]){seen[p.id]=1;list.push(p);}});
    list.sort(function(a,b){return a.fechaPago.localeCompare(b.fechaPago)||a.nombreCliente.localeCompare(b.nombreCliente);});
    return {esperado:esperado,recibido:recibA+recibB,list:list};
  },[pays,selMonth]);
  var hayMeta=recaudoMes.esperado>0;
  var pctMes=hayMeta?Math.round(recaudoMes.recibido/recaudoMes.esperado*100):0;
  var pctTxt=hayMeta?pctMes+'%':'—';
  var hayReg=pays.some(function(p){return p.id.indexOf('-ab-')===-1;});
  // v1.9.x — Metricas adicionales calculadas desde loans/pays
  var activos=loans.filter(function(l){return l.estado==='Activo';});
  var capOriginal=activos.reduce(function(s,l){return s+(l.moneda==='USD'?Math.round(l.montoOrigen*l.trmAcordada):Math.round(l.montoOrigen));},0);
  var deudoresUnicos=(function(){var set={};activos.forEach(function(l){set[l.nombre.trim().toLowerCase()]=1;});return Object.keys(set).length;})();
  var prestamosCOP=activos.filter(function(l){return l.moneda==='COP';}).length;
  var prestamosUSD=activos.filter(function(l){return l.moneda==='USD';}).length;
  // Saldo real por prestamo (formula confiable: originalCOP - capitalPagado - partialPaid)
  var loanSaldoMap={};
  loans.forEach(function(l){
    if(l.estado!=='Activo'){loanSaldoMap[l.id]=0;return;}
    var lp=pays.filter(function(p){return p.prestamoId===l.id;});
    var orig=l.moneda==='USD'?Math.round(l.montoOrigen*l.trmAcordada):Math.round(l.montoOrigen);
    // Fase 3: capital vivo por capital IMPUTADO (mismo criterio que el KPI del Inicio, el perfil
    // del deudor y Rendimiento). Alimenta el "Saldo: $X" de las cards de Vence Hoy / Proximos 7
    // dias / Mora, que antes restaban el parcial completo y discrepaban del resto de la app.
    var capImp=lp.reduce(function(a,p){return a+imputarCobros(p).totales.capital;},0);
    loanSaldoMap[l.id]=Math.max(0,orig-Math.round(capImp));
  });
  // Transacciones del mes: TODOS los pagos Pagados (cuotas regulares + abonos) cuya fecha de recaudo
  // cae en el mes actual, ordenados por paidAt (hora real) desc. La card tiene scroll interno.
  var thisMonthTx=nowStr().slice(0,7);
  // v2.1 FIX — la tarjeta lista EVENTOS DE CAJA reales (ledger `recibos`, via cobrosDe), no
  // cuotas marcadas 'Pagado'. Antes exigia `estadoPago==='Pagado'` y, sin fechaRecaudo, caia a
  // `fechaPago` (que es la fecha de VENCIMIENTO, no la de recaudo). Consecuencia: un PAGO PARCIAL
  // en curso —que NO cambia estadoPago ni escribe fechaRecaudo/paidAt— jamas aparecia, pese a ser
  // dinero realmente recibido; y cualquier fila sin fechaRecaudo se ubicaba por su vencimiento.
  // Ahora comparte fuente con el KPI "Cobros del Mes" y con sparkCobros: los tres iteran cobrosDe,
  // asi que cuadran POR CONSTRUCCION. Cada evento del ledger es su propia fila, en la fecha REAL
  // en que entro el dinero (un parcial hoy + el remanente manana = dos transacciones distintas).
  var monthTxs=[];
  pays.forEach(function(p){
    var evs=cobrosDe(p);
    evs.forEach(function(ev,k){
      if(String(ev.fecha).slice(0,7)!==thisMonthTx) return;
      monthTxs.push({pay:p,fecha:ev.fecha,cop:ev.cop,k:k,nEv:evs.length});
    });
  });
  monthTxs.sort(function(a,b){
    var c=String(b.fecha).localeCompare(String(a.fecha));            // fecha real del movimiento
    if(c!==0) return c;
    return String(b.pay.paidAt||'').localeCompare(String(a.pay.paidAt||'')); // hora real (v1.11.1)
  });
  // Sparkline "Ganancias": ganancia recibida por mes (ultimos 12 meses), agrupada por fechaRecaudo.
  // Misma definicion de ganancia que el KPI total: USD -> montoCOPRecibido - (cuotaTotal - interesPeriodo); COP -> interesPeriodo. Excluye abonos.
  var sparkGanancias=useMemo(function(){
    var moneda={};loans.forEach(function(l){moneda[l.id]=l.moneda;});
    var byMonth={};
    pays.forEach(function(p){
      if(p.estadoPago!=='Pagado'||!p.fechaRecaudo||p.id.indexOf('-ab-')!==-1) return;
      var ym=p.fechaRecaudo.slice(0,7);
      var g=(moneda[p.prestamoId]==='USD'&&p.montoCOPRecibido>0)?(p.montoCOPRecibido-(p.cuotaTotal-p.interesPeriodo)):p.interesPeriodo;
      byMonth[ym]=(byMonth[ym]||0)+g;
    });
    var base=new Date(nowStr()+'T12:00:00'),vals=[],labs=[],tips=[];
    for(var i=11;i>=0;i--){
      var d=new Date(base.getFullYear(),base.getMonth()-i,1);
      var ab=MESES_ES[d.getMonth()].slice(0,3);
      vals.push(Math.round(byMonth[d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')]||0));
      // 12 meses: etiqueta X cada 2 (incluye el mes actual) para no amontonar; el tooltip los tiene todos
      labs.push((vals.length-1)%2===1 ? ab : '');
      tips.push(ab+' '+d.getFullYear());
    }
    return {values:vals,labels:labs,tipLabels:tips};
  },[pays,loans]);
  // Sparkline "Cobros del Mes": evolucion DIARIA del mes EN CURSO (fijo — ignora selMonth).
  // Suma por dia los eventos de caja via cobrosDe(): ledger de recibos (cada parcial en su dia +
  // pago final) con fallback a fechaRecaudo. Incluye parciales en curso y abonos a capital. Misma
  // base que el KPI metrics.recibido -> el total del KPI == suma de los puntos de este grafico.
  var sparkCobros=useMemo(function(){
    var curM=nowStr().slice(0,7);
    var y=parseInt(curM.slice(0,4),10),mo=parseInt(curM.slice(5,7),10),dim=new Date(y,mo,0).getDate();
    var byDay={};
    pays.forEach(function(p){
      cobrosDe(p).forEach(function(e){
        if(e.fecha.slice(0,7)!==curM) return;
        var dd=parseInt(e.fecha.slice(8,10),10);
        byDay[dd]=(byDay[dd]||0)+e.cop;
      });
    });
    var monAb=MESES_ES[mo-1].slice(0,3);
    var keyDays={1:1,8:1,15:1,22:1,29:1},vals=[],labs=[],tips=[];
    for(var d=1;d<=dim;d++){vals.push(Math.round(byDay[d]||0));labs.push(keyDays[d]?String(d):'');tips.push(d+' '+monAb);}
    return {values:vals,labels:labs,tipLabels:tips};
  },[pays]);
  // KPIs (v1.9.x — diferenciados sin redundancia: ORIGINAL (historico) vs PENDIENTE (actual))
  var kpis=[
    {icon:'briefcase',label:'Capital Original',val:fmt(capOriginal),sub:'Total prestado · '+activos.length+' activo'+(activos.length===1?'':'s'),accent:'blue'},
    {icon:'dollar',   label:'Cobros del Mes',val:fmt(metrics.recibido),sub:pct+'% de $'+fmtN(metrics.esperado)+' esperado',accent:'green',spark:sparkCobros,sparkColor:'var(--green)'},
    {icon:'clock',    label:'Saldo Pendiente',val:fmt(metrics.totalCartera),sub:'Capital por recuperar (actual)',accent:'yellow'},
    {icon:'trending', label:'Ganancias',val:fmt(metrics.totalInteresesRecibidos),sub:'Historico total',accent:'green',spark:sparkGanancias,sparkColor:'var(--green)'}
  ];
  // Acciones rapidas
  var quickActions=[
    {icon:'plus',label:'Nuevo',color:'var(--green)',onClick:function(){if(onNewLoan)onNewLoan();else onNav('cartera');}},
    {icon:'dollar',label:'Pagos',color:'var(--blue)',onClick:function(){onNav('pagos');}},
    {icon:'users',label:'Deudores',color:'var(--yellow)',onClick:function(){onNav('deudores');}},
    {icon:'calc',label:'Calculadora',color:'var(--text)',onClick:function(){onNav('calculadora');}}
  ];
  // Estilo unificado para chips compactos
  var chipStyle={display:'inline-flex',alignItems:'center',gap:5,padding:'5px 10px',background:'var(--bg2)',border:'1px solid var(--border)',borderRadius:99,fontSize:11,fontWeight:600,color:'var(--text2)'};
  // Helper: tipo de transaccion para mostrar en Transacciones Recientes
  function tipoTx(p,l){
    if(p.id&&p.id.indexOf('-ab-')!==-1) return 'Abono a capital';
    if(!l) return 'Cuota '+p.cuotaN;
    if(l.modalidad==='Intereses') return 'Cuota intereses #'+p.cuotaN;
    if(l.modalidad==='Prestamo') return 'Devolucion capital';
    if(l.modalidad==='Pago Unico') return 'Pago unico';
    return 'Cuota #'+p.cuotaN;
  }
  // Helper: empty state centrado vertical y horizontal. Toma 100% de la altura del
  // contenedor padre (.dash-list-body con height fijo 300px) y centra el mensaje con flex.
  function emptyMsg(text){
    return h('div',{style:{height:'100%',width:'100%',padding:'12px',textAlign:'center',color:'var(--text3)',fontSize:12,fontWeight:500,opacity:.75,fontStyle:'italic',display:'flex',alignItems:'center',justifyContent:'center'}},text);
  }
  return h('div',{className:'fade-in dash-container'},
    // ── KPI CARDS (2x2 grid) ────────────────────────────────────────────
    h('div',{style:{display:'grid',gridTemplateColumns:'repeat(2,1fr)',gap:10,marginBottom:14}},
      kpis.map(function(k){
        return h('div',{key:k.label,style:{position:'relative',overflow:'hidden',background:'var(--bg2)',borderRadius:14,padding:'14px',border:'1px solid var(--border)',boxShadow:'var(--shadow)',transition:'all .15s',minHeight:120}},
          h('div',{style:{position:'relative',zIndex:1,display:'flex',alignItems:'center',gap:8,marginBottom:10}},
            h('div',{style:{width:32,height:32,borderRadius:9,background:'var(--'+k.accent+'-bg)',display:'flex',alignItems:'center',justifyContent:'center',flexShrink:0}},
              h(Ico,{name:k.icon,size:16,color:'var(--'+k.accent+')',sw:2.2})),
            h('div',{style:{fontSize:10,fontWeight:700,color:'var(--text3)',letterSpacing:.6,textTransform:'uppercase'}},k.label)),
          h('div',{style:{position:'relative',zIndex:1,maxWidth:k.spark?'calc(100% - 322px)':'none'}},
            h('div',{className:'mono',style:{fontSize:17,fontWeight:700,color:'var(--text)',letterSpacing:-.3,lineHeight:1.1,whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis'}},k.val),
            h('div',{style:{fontSize:11,color:'var(--text3)',marginTop:4,whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis'}},k.sub)),
          k.spark&&h('div',{style:{position:'absolute',right:16,bottom:10,zIndex:3}},
            h(SparklineChart,{data:k.spark.values,labels:k.spark.labels,tipLabels:k.spark.tipLabels,color:k.sparkColor||'var(--green)',id:k.label,width:298,height:98})));
      })),
    // ── ACCIONES RAPIDAS (4 cols grid) ──────────────────────────────────
    h('div',{style:{display:'grid',gridTemplateColumns:'repeat(4,1fr)',gap:8,marginBottom:14}},
      quickActions.map(function(a){
        return h('button',{key:a.label,onClick:a.onClick,style:{padding:'12px 6px',background:'var(--bg2)',border:'1px solid var(--border)',borderRadius:12,cursor:'pointer',display:'flex',flexDirection:'column',alignItems:'center',gap:6,fontFamily:'inherit',transition:'all .15s'}},
          h('div',{style:{width:36,height:36,borderRadius:10,background:'var(--bg3)',display:'flex',alignItems:'center',justifyContent:'center'}},
            h(Ico,{name:a.icon,size:18,color:a.color,sw:2.2})),
          h('div',{style:{fontSize:11,fontWeight:600,color:'var(--text2)'}},a.label));
      })),
    // ── STATS CHIPS (compactos) ─────────────────────────────────────────
    activos.length>0&&h('div',{style:{display:'flex',gap:6,flexWrap:'wrap',marginBottom:16}},
      h('div',{style:chipStyle},h(Ico,{name:'users',size:11,color:'var(--text3)',sw:2}),' ',deudoresUnicos+' '+(deudoresUnicos===1?'deudor':'deudores')),
      prestamosCOP>0&&h('div',{style:chipStyle},prestamosCOP+(prestamosCOP===1?' COP':' en COP')),
      prestamosUSD>0&&h('div',{style:Object.assign({},chipStyle,{color:'var(--blue)',background:'var(--blue-bg)',border:'1px solid var(--blue-bd)'})},prestamosUSD+(prestamosUSD===1?' USD':' en USD')),
      metrics.mora.length>0&&h('div',{style:Object.assign({},chipStyle,{color:'var(--red)',background:'var(--red-bg)',border:'1px solid var(--red-bd)'})},h(Ico,{name:'alert',size:10,color:'var(--red)',sw:2.2}),' ',metrics.mora.length+(metrics.mora.length===1?' cuota mora':' cuotas mora'))),
    // ── RECAUDO DEL MES (progress bar collapsible) ──────────────────────
    // v1.9.x — si pct > 100 (se supero la meta gracias a mora recuperada), la barra se capa
    // visualmente al 100% pero el % real se renderiza y se cambia el color a dorado.
    hayReg&&function(){
      var sobrecumplido=hayMeta&&pctMes>100;
      var barGradient=sobrecumplido?'linear-gradient(90deg,#bb8009,var(--yellow))':'linear-gradient(90deg,#2ea043,#3fb950)';
      var pctColor=sobrecumplido?'var(--yellow)':hayMeta?'var(--green)':'var(--text3)';
      return h('div',{style:{background:'var(--bg2)',borderRadius:14,padding:'13px 14px',border:'1px solid '+(sobrecumplido?'var(--yellow)':'var(--border)'),marginBottom:16,transition:'border-color .3s'}},
        h('div',{style:{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:10,gap:8}},
          h('div',{onClick:function(){setRecaudoOpen(!recaudoOpen);},style:{display:'flex',alignItems:'center',gap:8,cursor:'pointer',minWidth:0}},
            h('span',{style:{fontWeight:600,fontSize:14,color:'var(--text)'}},'Recaudo'),
            sobrecumplido&&h('span',{style:{fontSize:10,fontWeight:700,color:'var(--yellow)',background:'var(--yellow-bg)',padding:'2px 7px',borderRadius:99,letterSpacing:.4}},'META SUPERADA'),
            h(Ico,{name:recaudoOpen?'chevron-up':'chevron-down',size:14,color:'var(--text3)',sw:2})),
          h('div',{style:{display:'flex',alignItems:'center',gap:10,flexShrink:0}},
            h('div',{onClick:function(e){e.stopPropagation();},style:{display:'inline-flex',alignItems:'center',gap:1,background:'var(--bg4)',borderRadius:99,padding:'2px 3px'}},
              h('button',{onClick:function(e){e.stopPropagation();shiftMonth(-1);},title:'Mes anterior',style:{display:'flex',alignItems:'center',background:'none',border:'none',cursor:'pointer',padding:3,borderRadius:99,fontFamily:'inherit'}},h(Ico,{name:'chevleft',size:14,color:'var(--blue)',sw:2.5})),
              h('span',{style:{fontSize:12,fontWeight:700,color:'var(--blue)',minWidth:108,textAlign:'center',userSelect:'none'}},selMonthLabel),
              h('button',{onClick:function(e){e.stopPropagation();shiftMonth(1);},title:'Mes siguiente',style:{display:'flex',alignItems:'center',background:'none',border:'none',cursor:'pointer',padding:3,borderRadius:99,fontFamily:'inherit'}},h(Ico,{name:'chevright',size:14,color:'var(--blue)',sw:2.5}))),
            h('span',{className:'mono',style:{fontWeight:700,fontSize:16,color:pctColor,transition:'color .3s'}},pctTxt))),
        h('div',{style:{height:8,background:'var(--bg4)',borderRadius:99,overflow:'hidden'}},
          h('div',{style:{height:'100%',width:(hayMeta?Math.min(pctMes,100):0)+'%',maxWidth:'100%',background:barGradient,borderRadius:99,transition:'width .6s ease, background .3s'}})),
        h('div',{style:{display:'flex',justifyContent:'space-between',marginTop:6,fontSize:12,color:'var(--text3)'}},
          h('span',null,'Recibido: '+fmt(recaudoMes.recibido)),
          h('span',null,hayMeta?('Esperado: '+fmt(recaudoMes.esperado)):'Sin vencimientos este mes')),
      recaudoOpen&&recaudoMes.list.length>0&&h('div',{style:{marginTop:12,borderTop:'1px solid var(--border)',paddingTop:10}},
        recaudoMes.list.map(function(p,i){
          var pl=loanMap[p.prestamoId];
          var isU=pl&&pl.moneda==='USD';
          var pagado=p.estadoPago==='Pagado';
          var enMora=p.estadoPago==='En Mora';
          var hasPartial=(p.partialPaid||0)>0&&!pagado;
          var valor=pagado?p.cuotaTotal:pendCuota(p);
          var tipo=pl?(pl.modalidad==='Intereses'?'intereses':pl.modalidad==='Capital + Intereses'?'capital + intereses':pl.modalidad==='Prestamo'?'capital':pl.modalidad==='Pago Unico'?'pago unico':''):'';
          return h('div',{key:p.id,style:{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'6px 0',borderTop:i>0?'1px solid var(--border-light, rgba(255,255,255,.06))':'none',opacity:pagado?.55:1}},
            h('div',{style:{minWidth:0,flex:1}},
              h('div',{style:{display:'flex',alignItems:'center',gap:6}},
                pagado&&h(Ico,{name:'check',size:11,color:'var(--green)',sw:2.5}),
                enMora&&h(Ico,{name:'alert',size:11,color:'var(--red)',sw:2}),
                h('span',{onClick:function(){onNameClick(p.nombreCliente);},style:{fontWeight:500,fontSize:13,color:'var(--text)',cursor:'pointer',textDecoration:'underline',textDecorationColor:'var(--bg4)',textUnderlineOffset:2}},p.nombreCliente),
                hasPartial&&h('span',{className:'tag',style:{background:'var(--blue-bg)',color:'var(--blue)',fontSize:9,padding:'1px 5px'}},'PARCIAL')),
              h('div',{style:{fontSize:11,color:enMora?'var(--red)':'var(--text3)',marginTop:1}},
                fmtD(p.fechaPago)+' \u2022 '+tipo+(enMora?' \u2022 en mora':'')),
              hasPartial&&h('div',{className:'mono',style:{fontSize:10,color:'var(--blue)',marginTop:1}},'Abonado '+fmt(p.partialPaid)+' de '+fmt(p.cuotaTotal))),
            h('div',{style:{textAlign:'right',flexShrink:0}},
              h('div',{className:'mono',style:{fontWeight:300,fontSize:13,color:pagado?'var(--green)':enMora?'var(--red)':hasPartial?'var(--blue)':'var(--text)'}},fmt(valor)),
              isU&&h('div',{className:'mono',style:{fontSize:11,color:'var(--blue)'}},copToUsd(valor,pl.trmAcordada))));
        })));
    }(),
    // ── GRID 2x2 (v1.9.x — wrapper responsivo, 2 cols ESTRICTAS desktop).
    // Las 4 secciones SIEMPRE se renderizan (con empty state si no hay datos)
    // para preservar la cuadricula 2x2 perfecta.
    h('div',{className:'dash-lists'},
      // ── VENCE HOY ─────────────────────────────────────────────────────
      h('div',{className:'dash-card',style:{background:'rgba(187,128,9,.08)',border:'1px solid var(--yellow)'}},
        h('div',{className:'dash-card-header'},
          h('div',{style:{display:'flex',alignItems:'center',gap:6}},
            h(Ico,{name:'calendar',size:14,color:'var(--yellow)'}),
            h('span',{style:{fontWeight:700,fontSize:14,color:'var(--yellow)'}},'Vence Hoy')),
          metrics.hoy.length>0&&h('span',{className:'mono',style:{fontSize:12,fontWeight:500,color:'var(--yellow)',opacity:.8}},'Total: '+fmt(metrics.hoy.reduce(function(s,p){return s+pendCuota(p);},0)))),
        h('div',{className:'dash-list-body'},
        metrics.hoy.length===0
          ? emptyMsg('¡No hay cuotas por vencer hoy!')
          : metrics.hoy.map(function(p,i){
              var pl=loanMap[p.prestamoId];var isU=pl&&pl.moneda==='USD';
              var hasPartial=(p.partialPaid||0)>0;var val=pendCuota(p);
              var saldoL=loanSaldoMap[p.prestamoId]||0;
              return h('div',{key:p.id,style:{display:'flex',justifyContent:'space-between',alignItems:'flex-start',padding:'10px 0',borderTop:i>0?'1px solid rgba(187,128,9,.15)':'none',gap:10}},
                h('div',{style:{minWidth:0,flex:1}},
                  h('div',{style:{display:'flex',alignItems:'center',gap:6,flexWrap:'wrap'}},
                    h('span',{onClick:function(){onNameClick(p.nombreCliente);},style:{fontWeight:600,fontSize:14,color:'var(--text)',cursor:'pointer',textDecoration:'underline',textDecorationColor:'var(--bg4)',textUnderlineOffset:2}},p.nombreCliente),
                    hasPartial&&h('span',{className:'tag',style:{background:'var(--blue-bg)',color:'var(--blue)',fontSize:9,padding:'1px 5px'}},'PARCIAL')),
                  h('div',{style:{fontSize:11,color:'var(--text3)',marginTop:2}},'Cuota '+p.cuotaN+' · Cobrar hoy'),
                  hasPartial&&h('div',{className:'mono',style:{fontSize:10,color:'var(--blue)',marginTop:1}},'Abonado '+fmt(p.partialPaid)+' de '+fmt(p.cuotaTotal))),
                h('div',{style:{textAlign:'right',flexShrink:0}},
                  h('div',{className:'mono',style:{fontWeight:700,fontSize:19,color:'var(--yellow)',lineHeight:1.1,letterSpacing:-.3}},fmt(val)),
                  isU&&h('div',{className:'mono',style:{fontSize:11,color:'var(--blue)',marginTop:1}},copToUsd(val,pl.trmAcordada)),
                  saldoL>0&&h('div',{className:'mono',style:{fontSize:10,fontWeight:400,color:'var(--text3)',marginTop:3}},'Saldo: '+fmt(saldoL))));
            }))),
      // ── PROXIMOS 7 DIAS ───────────────────────────────────────────────
      h('div',{className:'dash-card',style:{background:'rgba(187,128,9,.04)',border:'1px solid rgba(187,128,9,.3)'}},
        h('div',{className:'dash-card-header'},
          h('div',{style:{display:'flex',alignItems:'center',gap:6}},
            h(Ico,{name:'clock',size:14,color:'var(--yellow)'}),
            h('span',{style:{fontWeight:700,fontSize:14,color:'var(--yellow)'}},'Proximos 7 dias')),
          metrics.proximos.length>0&&h('span',{className:'mono',style:{fontSize:12,fontWeight:500,color:'var(--yellow)',opacity:.8}},metrics.proximos.length+' '+(metrics.proximos.length===1?'cuota':'cuotas'))),
        h('div',{className:'dash-list-body'},
        metrics.proximos.length===0
          ? emptyMsg('¡No hay cuotas próximas a vencer!')
          : metrics.proximos.slice(0,8).map(function(p,i){
              var pl=loanMap[p.prestamoId];var isU=pl&&pl.moneda==='USD';
              var dias=Math.ceil((new Date(p.fechaPago+'T12:00:00')-new Date(nowStr()+'T12:00:00'))/86400000);
              var hasPartial=(p.partialPaid||0)>0;var val=pendCuota(p);
              var saldoL=loanSaldoMap[p.prestamoId]||0;
              return h('div',{key:p.id,style:{display:'flex',justifyContent:'space-between',alignItems:'flex-start',padding:'10px 0',borderTop:i>0?'1px solid rgba(187,128,9,.12)':'none',gap:10}},
                h('div',{style:{minWidth:0,flex:1}},
                  h('div',{style:{display:'flex',alignItems:'center',gap:6,flexWrap:'wrap'}},
                    h('span',{onClick:function(){onNameClick(p.nombreCliente);},style:{fontWeight:600,fontSize:14,color:'var(--text)',cursor:'pointer',textDecoration:'underline',textDecorationColor:'var(--bg4)',textUnderlineOffset:2}},p.nombreCliente),
                    hasPartial&&h('span',{className:'tag',style:{background:'var(--blue-bg)',color:'var(--blue)',fontSize:9,padding:'1px 5px'}},'PARCIAL')),
                  h('div',{style:{fontSize:11,color:'var(--text3)',marginTop:2}},'Cuota '+p.cuotaN+' · en '+dias+' dia'+(dias>1?'s':'')),
                  hasPartial&&h('div',{className:'mono',style:{fontSize:10,color:'var(--blue)',marginTop:1}},'Abonado '+fmt(p.partialPaid)+' de '+fmt(p.cuotaTotal))),
                h('div',{style:{textAlign:'right',flexShrink:0}},
                  h('div',{className:'mono',style:{fontWeight:700,fontSize:19,color:'var(--yellow)',lineHeight:1.1,letterSpacing:-.3}},fmt(val)),
                  isU&&h('div',{className:'mono',style:{fontSize:11,color:'var(--blue)',marginTop:1}},copToUsd(val,pl.trmAcordada)),
                  saldoL>0&&h('div',{className:'mono',style:{fontSize:10,fontWeight:400,color:'var(--text3)',marginTop:3}},'Saldo: '+fmt(saldoL))));
            }))),
      // ── PAGOS EN MORA ─────────────────────────────────────────────────
      h('div',{className:'dash-card',style:{background:'var(--red-bg)',border:'1px solid var(--red-bd)'}},
        h('div',{className:'dash-card-header'},
          h('div',{style:{display:'flex',alignItems:'center',gap:6}},
            h(Ico,{name:'alert',size:14,color:'var(--red)',sw:2.2}),
            h('span',{style:{fontWeight:700,fontSize:14,color:'var(--red)'}},'Pagos en Mora')),
          metrics.mora.length>0&&h('button',{onClick:function(){onNav('pagos');},style:{fontSize:12,color:'var(--red)',fontWeight:600,background:'none',border:'none',cursor:'pointer',fontFamily:'inherit'}},'Ver todos →')),
        h('div',{className:'dash-list-body'},
        metrics.mora.length===0
          ? emptyMsg('¡Excelente! No hay pagos en mora.')
          : metrics.mora.map(function(p,i){
              var pl=loanMap[p.prestamoId];var isU=pl&&pl.moneda==='USD';
              var hasPartial=(p.partialPaid||0)>0;var val=pendCuota(p);
              var saldoL=loanSaldoMap[p.prestamoId]||0;
              return h('div',{key:p.id,style:{display:'flex',justifyContent:'space-between',alignItems:'flex-start',padding:'10px 0',borderTop:i>0?'1px solid rgba(248,81,73,.15)':'none',gap:10}},
                h('div',{style:{minWidth:0,flex:1}},
                  h('div',{style:{display:'flex',alignItems:'center',gap:6,flexWrap:'wrap'}},
                    h('span',{onClick:function(){onNameClick(p.nombreCliente);},style:{fontWeight:600,fontSize:14,color:'var(--text)',cursor:'pointer',textDecoration:'underline',textDecorationColor:'var(--bg4)',textUnderlineOffset:2}},p.nombreCliente),
                    hasPartial&&h('span',{className:'tag',style:{background:'var(--blue-bg)',color:'var(--blue)',fontSize:9,padding:'1px 5px'}},'PARCIAL')),
                  h('div',{style:{fontSize:11,color:'var(--text3)',marginTop:2}},'Cuota '+p.cuotaN+' · Vencio '+fmtD(p.fechaPago)),
                  hasPartial&&h('div',{className:'mono',style:{fontSize:10,color:'var(--blue)',marginTop:1}},'Abonado '+fmt(p.partialPaid)+' de '+fmt(p.cuotaTotal))),
                h('div',{style:{textAlign:'right',flexShrink:0}},
                  h('div',{className:'mono',style:{fontWeight:700,fontSize:19,color:'var(--red)',lineHeight:1.1,letterSpacing:-.3}},fmt(val)),
                  isU&&h('div',{className:'mono',style:{fontSize:11,color:'var(--blue)',marginTop:1}},copToUsd(val,pl.trmAcordada)),
                  saldoL>0&&h('div',{className:'mono',style:{fontSize:10,fontWeight:400,color:'var(--text3)',marginTop:3}},'Saldo: '+fmt(saldoL))));
            }))),
      // ── TRANSACCIONES DEL MES ─────────────────────────────────────────
      h('div',{className:'dash-card',style:{background:'var(--bg2)',border:'1px solid var(--border)',boxShadow:'var(--shadow)'}},
        h('div',{className:'dash-card-header'},
          h('div',{style:{display:'flex',alignItems:'center',gap:6}},
            h(Ico,{name:'activity',size:14,color:'var(--green)',sw:2.2}),
            h('span',{style:{fontSize:14,fontWeight:700,color:'var(--text)'}},'Transacciones del Mes')),
          h('button',{onClick:function(){onNav('historial');},style:{fontSize:12,color:'var(--text3)',fontWeight:600,background:'none',border:'none',cursor:'pointer',fontFamily:'inherit'}},'Ver historial →')),
        h('div',{className:'dash-list-body'},
          monthTxs.length===0
            ? emptyMsg('Sin transacciones este mes.')
            : monthTxs.map(function(t,i){
                var p=t.pay;
                var pl=loanMap[p.prestamoId];var isU=pl&&pl.moneda==='USD';
                var esAbono=p.id&&p.id.indexOf('-ab-')!==-1;
                // Parcial EN CURSO: hubo caja pero la cuota sigue sin saldarse -> se marca en ambar
                // para no leerse como una cuota ya cubierta.
                var esParcial=!esAbono&&p.estadoPago!=='Pagado';
                var monto=t.cop;      // monto del EVENTO, no el acumulado de la cuota
                var fecha=t.fecha;    // fecha REAL en que entro el dinero
                var iconAccent=esAbono?'blue':(esParcial?'yellow':'green');
                // USD: si la cuota tiene un solo evento se muestra el USD realmente recibido
                // (doctrina del Bug #23); con varios eventos se convierte el monto de ESTE evento
                // para no repetir el total en cada fila.
                var usdTxt=(t.nEv===1&&+p.montoUSDRecibido>0)?fmtUSD(p.montoUSDRecibido):copToUsd(monto,pl&&pl.trmAcordada);
                return h('div',{key:p.id+'|'+t.fecha+'|'+t.k,style:{display:'flex',alignItems:'center',gap:10,padding:'10px 0',borderTop:i>0?'1px solid var(--border)':'none'}},
                  h('div',{style:{width:24,height:24,borderRadius:6,background:'var(--'+iconAccent+'-bg)',display:'flex',alignItems:'center',justifyContent:'center',flexShrink:0}},
                    h(Ico,{name:esAbono?'dollar':'check',size:11,color:'var(--'+iconAccent+')',sw:2.4})),
                  h('div',{style:{flex:1,minWidth:0}},
                    h('div',{style:{fontSize:13,fontWeight:600,color:'var(--text)',cursor:'pointer',textOverflow:'ellipsis',overflow:'hidden',whiteSpace:'nowrap'},onClick:function(){onNameClick(p.nombreCliente);}},p.nombreCliente),
                    h('div',{style:{fontSize:11,color:'var(--text3)',marginTop:2}},tipoTx(p,pl)+(esParcial?' · abono parcial':'')+' · '+fmtD(fecha))),
                  h('div',{style:{textAlign:'right',flexShrink:0}},
                    h('div',{className:'mono',style:{fontSize:15,fontWeight:700,color:'var(--text)'}},fmt(monto)),
                    isU&&h('div',{className:'mono',style:{fontSize:10,color:'var(--blue)',marginTop:1}},usdTxt)));
              })))),
    // ── EMPTY STATE ─────────────────────────────────────────────────────
    isEmpty&&h('div',{style:{textAlign:'center',padding:'44px 0',color:'var(--text3)'}},
      h('div',{style:{marginBottom:12}},h(Ico,{name:'briefcase',size:48,color:'var(--text3)'})),
      h('p',{style:{fontWeight:600,color:'var(--text2)',marginBottom:4}},'Sin prestamos aun'),
      h('p',{style:{fontSize:13}},'Ve a Cartera para registrar el primero')));
}

// ── Cartera ───────────────────────────────────────────────────────────────────
function CarteraView(props){
  var loans=props.loans,pays=props.pays,onAdd=props.onAdd,onEdit=props.onEdit,onDelete=props.onDelete,onAbono=props.onAbono,onForceClose=props.onForceClose;
  var es=useState(null); var exp=es[0]; var setExp=es[1];
  var ft=useState('Activo'); var filtro=ft[0]; var setFiltro=ft[1];
  var active=loans.filter(function(l){return l.estado==='Activo';});
  // "Finalizados" agrupa los dos estados terminales: éxito (Finalizado) y cierre forzoso (Cancelado)
  var finalized=loans.filter(function(l){return l.estado==='Finalizado'||l.estado==='Cancelado';});
  var filtered=filtro==='Activo'?active:finalized;
  return h('div',{className:'fade-in',style:{padding:16}},
    h('div',{style:{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:14}},
      h('div',null,
        h('div',{style:{fontWeight:700,fontSize:17,color:'var(--text)'}},'Mis Prestamos'),
        h('div',{style:{fontSize:13,color:'var(--text2)',marginTop:2}},active.length+' activos - '+fmt(active.reduce(function(s,l){
          // Fase 3: total del encabezado = SALDO CON CAJA APLICADA, via el unico helper. Antes
          // replicaba inline el saldo del MOTOR y quedaba congelado ante un parcial en curso,
          // contradiciendo al KPI del Inicio y a la lista de Deudores.
          return s+saldoConCaja(l,pays.filter(function(p){return p.prestamoId===l.id;}));
        },0)))),
      h('button',{onClick:onAdd,style:{display:'flex',alignItems:'center',gap:6,background:'var(--green2)',color:'white',border:'none',borderRadius:10,padding:'8px 14px',fontSize:14,fontWeight:600,cursor:'pointer'}},
        h(Ico,{name:'plus',size:15,color:'white'}),' Nuevo')),
    h('div',{style:{display:'flex',gap:6,marginBottom:12}},
      [['Activo','Activos',active.length],['Finalizados','Finalizados',finalized.length]].map(function(t){
        var isActive=filtro===t[0];
        return h('button',{key:t[0],onClick:function(){setFiltro(t[0]);},style:{flex:1,padding:'8px 0',borderRadius:10,border:'1.5px solid '+(isActive?(t[0]==='Activo'?'var(--green)':'var(--blue)'):'var(--border)'),background:isActive?(t[0]==='Activo'?'var(--green-bg)':'var(--blue-bg)'):'transparent',color:isActive?(t[0]==='Activo'?'var(--green)':'var(--blue)'):'var(--text3)',fontSize:13,fontWeight:isActive?700:500,cursor:'pointer',display:'flex',alignItems:'center',justifyContent:'center',gap:5}},
          t[1],h('span',{style:{background:isActive?'rgba(255,255,255,.12)':'var(--bg3)',padding:'1px 6px',borderRadius:99,fontSize:11,fontWeight:700}},t[2]));
      })),
    loans.length===0&&h('div',{style:{textAlign:'center',padding:'48px 0',color:'var(--text3)'}},
      h('div',{style:{marginBottom:12}},h(Ico,{name:'clipboard',size:44,color:'var(--text3)'})),
      h('p',{style:{fontWeight:600,color:'var(--text2)'}},'Sin prestamos registrados')),
    filtered.length===0&&loans.length>0&&h('div',{style:{textAlign:'center',padding:'40px 0',color:'var(--text3)'}},
      h('div',{style:{marginBottom:10}},h(Ico,{name:filtro==='Finalizados'?'check':'clipboard',size:36,color:'var(--text3)'})),
      h('p',{style:{fontWeight:600,color:'var(--text2)'}},'Sin prestamos '+(filtro==='Finalizados'?'finalizados':'activos'))),
    h('div',{style:{display:'flex',flexDirection:'column',gap:10}},
      filtered.slice().sort(function(a,b){return b.fechaInicio.localeCompare(a.fechaInicio);}).map(function(loan){
        var lp=pays.filter(function(p){return p.prestamoId===loan.id;});
        var regs=lp.filter(function(p){return p.id.indexOf('-ab-')===-1;});
        var paid=regs.filter(function(p){return p.estadoPago==='Pagado';}).length;
        var mora=regs.filter(function(p){return p.estadoPago==='En Mora';}).length;
        var isExp=exp===loan.id;
        // Barra de progreso por MONTO (considera abonos parciales):
        var totEsp=regs.reduce(function(s,p){return s+p.cuotaTotal;},0);
        var totRec=regs.reduce(function(s,p){
          if(p.estadoPago==='Pagado') return s+p.cuotaTotal;
          return s+(p.partialPaid||0);
        },0);
        var pct=totEsp>0?Math.round(totRec/totEsp*100):0;
        return h('div',{key:loan.id,className:'loan-card',style:{background:'var(--bg2)',borderRadius:14,border:'1px solid '+(mora>0?'var(--red-bd)':'var(--border)'),boxShadow:'var(--shadow)',overflow:'hidden',transition:'border-color .15s'}},
          h('div',{style:{padding:'13px 14px 11px'}},
            h('div',{style:{display:'flex',alignItems:'flex-start',justifyContent:'space-between',gap:8}},
              h('div',{style:{flex:1,minWidth:0}},
                h('div',{style:{display:'flex',alignItems:'center',gap:6,flexWrap:'wrap'}},
                  h('span',{style:{fontWeight:700,fontSize:14,color:'var(--text)'}},loan.nombre),
                  function(){
                    var st=loan.estado;
                    var bg=st==='Activo'?'var(--green-bg)':st==='Cancelado'?'var(--red-bg)':'var(--green-bg)';
                    var co=st==='Activo'?'var(--green)':st==='Cancelado'?'var(--red)':'var(--green)';
                    var ic=st==='Cancelado'?'x':st==='Finalizado'?'check':null;
                    return h('span',{className:'tag',style:{background:bg,color:co,display:'inline-flex',alignItems:'center',gap:3}},
                      ic&&h(Ico,{name:ic,size:10,color:co,sw:2.4}),st);
                  }(),
                  loan.modalidad==='Intereses'&&h('span',{className:'tag',style:{background:'var(--blue-bg)',color:'var(--blue)'}},'\u221E Indefinido'),
                  loan.modalidad==='Prestamo'&&h('span',{className:'tag',style:{background:'var(--yellow-bg)',color:'var(--yellow)'}},'Sin interes'),
                  loan.modalidad==='Pago Unico'&&h('span',{className:'tag',style:{background:'var(--green-bg)',color:'var(--green)'}},'Pago unico'),
                  mora>0&&h('span',{className:'tag',style:{background:'var(--red-bg)',color:'var(--red)'}},mora+' mora')),
                h('div',{style:{display:'flex',gap:8,marginTop:5,flexWrap:'wrap',alignItems:'center'}},
                  h('span',{className:'mono',style:{fontSize:13,color:'var(--green)',fontWeight:600}},loan.moneda==='USD'?'$'+fmtN(loan.montoOrigen)+' USD | '+fmt(Math.round(loan.montoOrigen*loan.trmAcordada)):fmt(Math.round(loan.montoOrigen))),
                  h('span',{style:{fontSize:13,color:'var(--border2)'}},' | '),
                  h('span',{style:{fontSize:13,color:'var(--text2)'}},loan.tasaMensual+'% mens.'),
                  h('span',{style:{fontSize:13,color:'var(--border2)'}},' | '),
                  h('span',{style:{fontSize:13,color:'var(--text2)'}},freqLabel(loan))),
                h('div',{style:{fontSize:12,color:'var(--text3)',marginTop:3}},loan.modalidad+' - '+paid+' pagadas')),
              h('div',{style:{display:'flex',gap:5,flexShrink:0}},
                loan.estado==='Activo'&&h('button',{onClick:function(){onAbono(loan);},title:'Abono a capital',style:{padding:7,background:'var(--green-bg)',border:'none',borderRadius:8,cursor:'pointer',display:'flex'}},h(Ico,{name:'dollar',size:14,color:'var(--green)',sw:1.8})),
                loan.estado==='Activo'&&onForceClose&&h('button',{onClick:function(){onForceClose(loan);},title:'Cerrar prestamo (forzar)',style:{padding:7,background:'var(--yellow-bg)',border:'none',borderRadius:8,cursor:'pointer',display:'flex'}},h(Ico,{name:'xCircle',size:14,color:'var(--yellow)',sw:1.8})),
                h('button',{onClick:function(){onEdit(loan);},title:'Editar',style:{padding:7,background:'var(--blue-bg)',border:'none',borderRadius:8,cursor:'pointer',display:'flex'}},h(Ico,{name:'edit',size:14,color:'var(--blue)',sw:1.8})),
                h('button',{onClick:function(){onDelete(loan.id);},title:'Eliminar prestamo',style:{padding:7,background:'var(--red-bg)',border:'none',borderRadius:8,cursor:'pointer',display:'flex'}},h(Ico,{name:'trash',size:14,color:'var(--red)',sw:1.8})))),
            lp.length>0&&(loan.modalidad==='Intereses'?h('div',{style:{marginTop:10,fontSize:10,color:'var(--text3)'}},paid+' cuotas pagadas \u2022 \u221E'):h('div',{style:{marginTop:10,display:'flex',alignItems:'center',gap:8}},
              h('div',{style:{flex:1,height:5,background:'var(--bg4)',borderRadius:99,overflow:'hidden'}},
                h('div',{style:{height:'100%',width:pct+'%',background:'linear-gradient(90deg,#2ea043,#3fb950)',borderRadius:99}})),
              h('span',{className:'mono',style:{fontSize:15,fontWeight:700,color:'var(--green)',flexShrink:0,minWidth:42,textAlign:'right'}},pct+'%'))),
            h('button',{onClick:function(){setExp(isExp?null:loan.id);},style:{marginTop:8,background:'none',border:'none',cursor:'pointer',color:'var(--green)',fontSize:12,fontWeight:600,display:'flex',alignItems:'center',gap:4,padding:0}},
              isExp?'Ocultar cronograma':'Ver cronograma')),
          isExp&&function(){
            // Cronograma unificado con DebtorModal, el Recibo de Abono y el PDF:
            // # / Vence / Interes / Abono a capital / Valor cuota / Saldo / Estado
            var cuotasReg=lp.filter(function(p){return p.id.indexOf('-ab-')===-1;}).filter(function(p){return loan.modalidad!=='Intereses'||p.estadoPago!=='Pendiente';});
            var abonos=lp.filter(function(p){return p.id.indexOf('-ab-')!==-1;});
            var esUSD=loan.moneda==='USD';
            var cronoItems=cuotasReg.slice().sort(function(a,b){return a.cuotaN-b.cuotaN;});
            // Linea de tiempo unica: cuotas + abonos intercalados por fecha, con la MISMA regla
            // de orden que generateCronogramaPDF (fechaPago y, a igualdad, cuotaN) para que la
            // app y el PDF muestren siempre la misma secuencia.
            var timeline=cronoItems.concat(abonos).sort(function(a,b){
              var c=String(a.fechaPago).localeCompare(String(b.fechaPago));
              return c!==0?c:a.cuotaN-b.cuotaN;
            });
            // La columna SALDO lee p.saldoFinal (saldo de CIERRE persistido por el backend),
            // unificada con el Recibo de Abono y el cronograma PDF. Sustituye a la antigua
            // "Deuda", que era un acumulador local del saldo de APERTURA: mostraba el saldo
            // ANTES de cada cuota (corrido un renglon respecto del resto de documentos) y
            // derivaba hasta 1 peso por recalcular en vez de leer el dato persistido.
            var cronoCols='32px 1fr 1fr 1fr 1fr 1fr 60px';
            return h('div',{style:{borderTop:'1px solid var(--bg3)'}},
              h('div',{style:{padding:'8px 10px'}},
                h('div',{style:{borderRadius:8,overflow:'hidden',border:'1px solid var(--border)'}},
                  h('div',{style:{display:'grid',gridTemplateColumns:cronoCols,background:'var(--bg4)',padding:'6px 8px',fontSize:10,fontWeight:700,color:'var(--text3)',gap:4}},
                    h('span',null,'#'),
                    h('span',null,'Vence'),
                    h('span',{style:{textAlign:'right'}},'Interes'),
                    h('span',{style:{textAlign:'right'}},'Abono a capital'),
                    h('span',{style:{textAlign:'right'}},'Valor cuota'),
                    h('span',{style:{textAlign:'right'}},'Saldo'),
                    h('span',{style:{textAlign:'center'}},'Estado')),
                  timeline.map(function(p,idx){
                    // Fila de ABONO intercalada (regla canonica '-ab-'), espejo de la del PDF:
                    // sin numero de cuota ni interes, el monto en ABONO A CAPITAL y VALOR CUOTA,
                    // y el saldo que quedo inmediatamente despues del abono.
                    if(p.id.indexOf('-ab-')!==-1){
                      return h('div',{key:p.id,style:{display:'grid',gridTemplateColumns:cronoCols,padding:'5px 8px',fontSize:11,gap:4,borderTop:'1px solid var(--blue-bd)',background:'var(--blue-bg)'}},
                        h('span',{style:{color:'var(--blue)',fontWeight:600}},'-'),
                        h('span',{style:{color:'var(--blue)',fontStyle:'italic'}},fmtD(p.fechaPago),
                          p.observaciones&&h('div',{style:{fontSize:9,color:'var(--text3)',fontStyle:'italic'}},p.observaciones)),
                        h('span',{style:{textAlign:'right',color:'var(--text3)'}},'—'),
                        h('span',{className:'mono',style:{textAlign:'right',color:'var(--blue)',fontWeight:600}},fmt(p.abonoCapital),esUSD&&h('div',{style:{fontSize:9,color:'var(--blue)',fontWeight:400}},copToUsd(p.abonoCapital,loan.trmAcordada))),
                        h('span',{className:'mono',style:{textAlign:'right',color:'var(--blue)',fontWeight:600}},fmt(p.cuotaTotal),esUSD&&h('div',{style:{fontSize:9,color:'var(--blue)',fontWeight:400}},copToUsd(p.cuotaTotal,loan.trmAcordada))),
                        h('span',{className:'mono',style:{textAlign:'right',color:'var(--blue)',fontWeight:600}},fmt(p.saldoFinal),esUSD&&h('div',{style:{fontSize:9,color:'var(--blue)',fontWeight:400}},copToUsd(p.saldoFinal,loan.trmAcordada))),
                        h('span',{style:{textAlign:'center'}},h('span',{style:{fontSize:9,padding:'2px 6px',borderRadius:99,background:'var(--blue-bd)',color:'var(--blue)',fontWeight:600}},'Abono')));
                    }
                    var stColor=p.estadoPago==='Pagado'?'var(--green)':p.estadoPago==='En Mora'?'var(--red)':'var(--yellow)';
                    var stBg=p.estadoPago==='Pagado'?'var(--green-bg)':p.estadoPago==='En Mora'?'var(--red-bg)':'var(--yellow-bg)';
                    var hasPartial=(p.partialPaid||0)>0&&p.estadoPago!=='Pagado';
                    // Capital reconciliado (= Valor cuota - Interes), no p.abonoCapital crudo:
                    // en modalidad Prestamo el backend lo persiste en 0 (Bug #2) y la fila
                    // mostraria "0 + 0 = cuota". Ver misma doctrina en generateCronogramaPDF.
                    var capRec=Math.max(0,p.cuotaTotal-p.interesPeriodo);
                    // La sub-linea USD se reconcilia en centavos de dolar: convertir el capital
                    // en COP por separado descuadra 1 centavo (363.25 + 96.74 = 459.99 != 460.00).
                    var _trm=loan.trmAcordada||1;
                    var capRecUSD=esUSD?Math.max(0,(Math.round(p.cuotaTotal/_trm*100)-Math.round(p.interesPeriodo/_trm*100))/100):0;
                    return h('div',{key:p.id,style:{display:'grid',gridTemplateColumns:cronoCols,padding:'5px 8px',fontSize:11,gap:4,borderTop:'1px solid var(--border)',background:idx%2===0?'transparent':'var(--bg3)'}},
                      h('span',{style:{color:'var(--text3)',fontWeight:600}},p.cuotaN),
                      h('span',{style:{color:'var(--text2)'}},fmtD(p.fechaPago)),
                      h('span',{className:'mono',style:{textAlign:'right',color:'var(--text2)',fontWeight:500}},fmt(p.interesPeriodo),esUSD&&p.interesPeriodo>0&&h('div',{style:{fontSize:9,color:'var(--blue)',fontWeight:400}},copToUsd(p.interesPeriodo,loan.trmAcordada))),
                      h('span',{className:'mono',style:{textAlign:'right',color:'var(--text2)',fontWeight:500}},fmt(capRec),esUSD&&capRec>0&&h('div',{style:{fontSize:9,color:'var(--blue)',fontWeight:400}},fmtUSD(capRecUSD))),
                      h('span',{className:'mono',style:{textAlign:'right',color:'var(--text)',fontWeight:600}},fmt(p.cuotaTotal),hasPartial&&h('div',{style:{fontSize:9,color:'var(--blue)',fontWeight:600}},'-'+fmt(p.partialPaid)),esUSD&&h('div',{style:{fontSize:9,color:'var(--blue)',fontWeight:400}},copToUsd(p.cuotaTotal,loan.trmAcordada))),
                      h('span',{className:'mono',style:{textAlign:'right',color:'var(--text)',fontWeight:600}},fmt(p.saldoFinal),esUSD&&h('div',{style:{fontSize:9,color:'var(--blue)',fontWeight:400}},copToUsd(p.saldoFinal,loan.trmAcordada))),
                      h('span',{style:{textAlign:'center'}},h('span',{style:{fontSize:9,padding:'2px 6px',borderRadius:99,background:stBg,color:stColor,fontWeight:600}},p.estadoPago==='Pagado'?'Pagado':p.estadoPago==='En Mora'?'Mora':hasPartial?'Parc.':'Pend.')));
                  }))),
              // El bloque "HISTORIAL DE ABONOS A CAPITAL" que iba aqui se retiro: con los abonos
              // ya intercalados en la linea de tiempo, repetirlos abajo mostraba cada movimiento
              // dos veces. Su unico dato exclusivo (observaciones) viaja ahora como sub-linea de
              // la fila del abono, asi que no se pierde informacion.
              loan.estado==='Activo'&&function(){
                var esUSD=loan.moneda==='USD';
                var regsPag=cuotasReg.filter(function(p){return p.estadoPago==='Pagado';});
                var abonosPag=abonos.filter(function(p){return p.estadoPago==='Pagado';});
                var parcialesVivos=cuotasReg.filter(function(p){return p.estadoPago!=='Pagado'&&(p.partialPaid||0)>0;});
                if(regsPag.length===0&&abonosPag.length===0&&parcialesVivos.length===0)return null; // aun no se cobra nada
                var trm=loan.trmAcordada;
                // Fase 2: gemelo del bloque del perfil del deudor. Los rubros salen de la
                // IMPUTACION (cascada interes -> capital) sobre TODOS los pagos del prestamo, de
                // modo que un parcial en curso deja de ser invisible aqui. El gate de arriba
                // tambien tuvo que admitirlos: antes exigia al menos una cuota Pagada, asi que un
                // prestamo cuyo unico cobro fuera un parcial no mostraba el bloque en absoluto.
                var impC=cuotasReg.concat(abonos).reduce(function(a,p){var t=imputarCobros(p).totales;
                  a.cobrado+=t.cobrado; a.interes+=t.interes; a.capital+=t.capital; a.ajuste+=t.ajuste; return a;},
                  {cobrado:0,interes:0,capital:0,ajuste:0});
                var intCobrados=Math.round(impC.interes);
                var capRecHoy=Math.round(impC.capital);
                var gananciaTRM=Math.round(impC.ajuste);
                var totalRecibidoCOP=Math.round(impC.cobrado); // caja real == capital+interes+ajuste
                var gananciaTotalCOP=intCobrados+gananciaTRM;
                var efectoTRMUSD=esUSD&&trm>0?(regsPag.filter(function(p){return p.montoUSDRecibido&&p.montoUSDRecibido>0;}).reduce(function(s,p){return s+(p.montoUSDRecibido-p.cuotaTotal/trm);},0)+abonosPag.filter(function(p){return p.montoUSDRecibido&&p.montoUSDRecibido>0;}).reduce(function(s,p){return s+(p.montoUSDRecibido-p.abonoCapital/trm);},0)):0;
                var capitalUSD=esUSD&&trm>0?capRecHoy/trm:0;
                var intUSD=esUSD&&trm>0?intCobrados/trm:0;
                var totalRecibidoUSD=capitalUSD+intUSD+efectoTRMUSD;
                var gananciaTotalUSD=intUSD+efectoTRMUSD;
                function rowItem(label,value,valColor,subUSD,opts){
                  opts=opts||{};
                  var bt=opts.topBorder===false?'none':(opts.accentTop?'2px solid var(--green)':'1px solid var(--bg3)');
                  return h('div',{style:{display:'flex',justifyContent:'space-between',alignItems:opts.note?'flex-start':'center',padding:opts.master?'4px 0 10px':'8px 0',borderTop:bt,marginTop:opts.accentTop?3:0}},
                    h('div',null,
                      h('div',{style:{fontSize:opts.master?12:10,color:opts.master?'var(--text)':'var(--text3)',fontWeight:opts.master?700:600,letterSpacing:.5}},label),
                      opts.note&&h('div',{style:{fontSize:9,color:'var(--text3)',marginTop:2,fontWeight:400,letterSpacing:.2}},opts.note)),
                    h('div',{style:{textAlign:'right'}},
                      h('div',{className:'mono',style:{fontSize:opts.master?16:(opts.strong?14:13),fontWeight:(opts.master||opts.strong)?700:500,color:valColor||'var(--text)'}},value),
                      subUSD&&h('div',{className:'mono',style:{fontSize:opts.master?11:10,color:'var(--blue)',fontWeight:400}},subUSD)));
                }
                return h('div',{style:{borderTop:'1px solid var(--bg3)',padding:'12px',background:'transparent'}},
                  h('div',{style:{fontSize:11,fontWeight:600,color:'var(--green)',marginBottom:8,display:'flex',alignItems:'center',gap:6,letterSpacing:.5}},
                    h(Ico,{name:'dollar',size:13,color:'var(--green)',sw:2.4}),'RECAUDADO A LA FECHA'),
                  rowItem('TOTAL RECIBIDO',fmt(totalRecibidoCOP),'var(--text)',esUSD?fmtUSD(totalRecibidoUSD):null,{master:true,topBorder:false}),
                  rowItem('CAPITAL RECUPERADO',fmt(capRecHoy),'var(--text)',esUSD?copToUsd(capRecHoy,trm):null),
                  rowItem('INTERESES COBRADOS',(intCobrados>0?'+':'')+fmt(intCobrados),intCobrados>0?'var(--green)':'var(--text2)',esUSD&&intCobrados>0?copToUsd(intCobrados,trm):null),
                  esUSD&&rowItem('EFECTO TRM',(gananciaTRM>0?'+':gananciaTRM<0?'-':'')+fmt(Math.abs(gananciaTRM)),gananciaTRM>0?'var(--green)':gananciaTRM<0?'var(--red)':'var(--text2)',null,{note:gananciaTRM>0?'TRM subio al cobrar':gananciaTRM<0?'TRM bajo al cobrar':'Sin efecto cambiario'}),
                  esUSD&&rowItem(loan.modalidad==='Prestamo'?'RESULTADO TOTAL':'GANANCIA TOTAL',(gananciaTotalCOP<0?'-':'+')+fmt(Math.abs(gananciaTotalCOP)),gananciaTotalCOP<0?'var(--red)':gananciaTotalCOP>0?'var(--green)':'var(--text2)',(gananciaTotalUSD<0?'-':'+')+fmtUSD(Math.abs(gananciaTotalUSD)),{accentTop:true,strong:true}));
              }(),
              loan.estado!=='Activo'&&function(){
                var esCanc=loan.estado==='Cancelado';
                var esUSD=loan.moneda==='USD';
                var regsPag=cuotasReg.filter(function(p){return p.estadoPago==='Pagado';});
                var abonosPag=abonos.filter(function(p){return p.estadoPago==='Pagado';});
                var intCobrados=Math.round(regsPag.reduce(function(s,p){return s+p.interesPeriodo;},0));
                var capAbonosCOP=Math.round(abonosPag.reduce(function(s,p){return s+p.abonoCapital;},0));
                var origCOP=esUSD?Math.round(loan.montoOrigen*loan.trmAcordada):Math.round(loan.montoOrigen);
                var capPerd=Math.round(loan.capitalPerdido||0);
                var intPerd=Math.round(loan.interesesPerdidos||0);
                var totPerd=capPerd+intPerd;
                // Capital efectivamente recuperado (bruto): monto original menos lo perdido en cierre forzoso.
                var capRecuperado=esCanc?Math.max(0,origCOP-capPerd):origCOP;
                // Efecto TRM en COP (medido): diferencia entre lo cobrado en COP y el valor contractual (TRM acordada).
                //   - Cuotas regulares pagadas: montoCOPRecibido - cuotaTotal
                //   - Abonos pagados con USD:   montoCOPRecibido - (montoUSDRecibido * trmAcordada)
                var gananciaTRMReg=esUSD?regsPag.filter(function(p){return p.montoCOPRecibido&&p.montoCOPRecibido>0;}).reduce(function(s,p){return s+(p.montoCOPRecibido-p.cuotaTotal);},0):0;
                var gananciaTRMAb=esUSD?abonosPag.filter(function(p){return p.montoUSDRecibido&&p.montoUSDRecibido>0;}).reduce(function(s,p){return s+(p.montoCOPRecibido-(p.montoUSDRecibido*loan.trmAcordada));},0):0;
                var gananciaTRM=Math.round(gananciaTRMReg+gananciaTRMAb);
                // Flujo de caja COP: TOTAL RECIBIDO = capital recuperado + intereses cobrados +/- efecto TRM
                // (derivado: la suma SIEMPRE cuadra con las filas mostradas, aun en datos sin montoCOPRecibido).
                var totalRecibidoCOP=capRecuperado+intCobrados+gananciaTRM;
                var gananciaTotalCOP=intCobrados+gananciaTRM; // utilidad = total recibido - capital
                // Columna USD (Bug #25): capital/intereses contractuales + efecto TRM en USD (residual ~0:
                // los dolares llegan completos, la perdida es solo de pesos). TOTAL USD = USD realmente recibido.
                var trm=loan.trmAcordada;
                var efectoTRMUSD=esUSD&&trm>0?(regsPag.filter(function(p){return p.montoUSDRecibido&&p.montoUSDRecibido>0;}).reduce(function(s,p){return s+(p.montoUSDRecibido-p.cuotaTotal/trm);},0)+abonosPag.filter(function(p){return p.montoUSDRecibido&&p.montoUSDRecibido>0;}).reduce(function(s,p){return s+(p.montoUSDRecibido-p.abonoCapital/trm);},0)):0;
                var capitalUSD=esUSD&&trm>0?capRecuperado/trm:0;
                var intUSD=esUSD&&trm>0?intCobrados/trm:0;
                var totalRecibidoUSD=capitalUSD+intUSD+efectoTRMUSD;
                var gananciaTotalUSD=intUSD+efectoTRMUSD;
                var cuotasPagCnt=regsPag.length;
                var denomCuotas=loan.modalidad==='Intereses'?'∞':(loan.plazoMeses||cuotasReg.length||'-');
                var acento=esCanc?'var(--red)':'var(--green)';
                function rowItem(label,value,valColor,subUSD,opts){
                  opts=opts||{};
                  var bt=opts.topBorder===false?'none':(opts.accentTop?'2px solid '+acento:'1px solid var(--bg3)');
                  return h('div',{style:{display:'flex',justifyContent:'space-between',alignItems:opts.note?'flex-start':'center',padding:opts.master?'4px 0 10px':'8px 0',borderTop:bt,marginTop:opts.accentTop?3:0}},
                    h('div',null,
                      h('div',{style:{fontSize:opts.master?12:10,color:opts.master?'var(--text)':'var(--text3)',fontWeight:opts.master?700:600,letterSpacing:.5}},label),
                      opts.note&&h('div',{style:{fontSize:9,color:'var(--text3)',marginTop:2,fontWeight:400,letterSpacing:.2}},opts.note)),
                    h('div',{style:{textAlign:'right'}},
                      h('div',{className:'mono',style:{fontSize:opts.master?16:(opts.strong?14:13),fontWeight:(opts.master||opts.strong)?700:500,color:valColor||'var(--text)'}},value),
                      subUSD&&h('div',{className:'mono',style:{fontSize:opts.master?11:10,color:'var(--blue)',fontWeight:400}},subUSD)));
                }
                return h('div',{style:{borderTop:'1px solid var(--bg3)',padding:'12px',background:'transparent'}},
                  h('div',{style:{fontSize:11,fontWeight:600,color:acento,marginBottom:8,display:'flex',alignItems:'center',gap:6,letterSpacing:.5}},
                    h(Ico,{name:esCanc?'x':'check',size:13,color:acento,sw:2.4}),'RESUMEN '+(esCanc?'(CIERRE FORZOSO)':'(FINALIZADO)')),
                  // Dato maestro: TOTAL RECIBIDO (flujo de caja real)
                  rowItem('TOTAL RECIBIDO',fmt(totalRecibidoCOP),'var(--text)',esUSD?fmtUSD(totalRecibidoUSD):null,{master:true,topBorder:false}),
                  // Desglose que compone el total
                  rowItem(esCanc?'CAPITAL RECUPERADO':'CAPITAL PRESTADO',fmt(capRecuperado),'var(--text)',esUSD?copToUsd(capRecuperado,trm):null),
                  rowItem('INTERESES COBRADOS',(intCobrados>0?'+':'')+fmt(intCobrados),intCobrados>0?'var(--green)':'var(--text2)',esUSD&&intCobrados>0?copToUsd(intCobrados,trm):null),
                  esUSD&&rowItem('EFECTO TRM',(gananciaTRM>0?'+':gananciaTRM<0?'-':'')+fmt(Math.abs(gananciaTRM)),gananciaTRM>0?'var(--green)':gananciaTRM<0?'var(--red)':'var(--text2)',null,{note:gananciaTRM>0?'TRM subio al cobrar':gananciaTRM<0?'TRM bajo al cobrar':'Sin efecto cambiario'}),
                  // Subtotal de utilidad (solo USD; en COP la ganancia = intereses, seria redundante)
                  esUSD&&rowItem(loan.modalidad==='Prestamo'?'RESULTADO TOTAL':'GANANCIA TOTAL',(gananciaTotalCOP<0?'-':'+')+fmt(Math.abs(gananciaTotalCOP)),gananciaTotalCOP<0?'var(--red)':gananciaTotalCOP>0?'var(--green)':'var(--text2)',(gananciaTotalUSD<0?'-':'+')+fmtUSD(Math.abs(gananciaTotalUSD)),{accentTop:true,strong:true}),
                  rowItem('CUOTAS PAGADAS',cuotasPagCnt+(loan.modalidad==='Intereses'?'':'/'+denomCuotas)),
                  capAbonosCOP>0&&rowItem('TOTAL ABONOS A CAPITAL',fmt(capAbonosCOP),'var(--blue)',esUSD?copToUsd(capAbonosCOP,trm):null),
                  esCanc&&rowItem('CAPITAL DEBIENDO',fmt(capPerd),capPerd>0?'var(--red)':'var(--text2)',esUSD&&capPerd>0?copToUsd(capPerd,trm):null),
                  esCanc&&rowItem('INTERESES DEBIENDO',fmt(intPerd),intPerd>0?'var(--red)':'var(--text2)',esUSD&&intPerd>0?copToUsd(intPerd,trm):null),
                  esCanc&&h('div',{style:{marginTop:12,padding:'10px 12px',background:'var(--bg3)',borderRadius:8,borderLeft:'3px solid var(--red)',display:'flex',justifyContent:'space-between',alignItems:'center'}},
                    h('div',null,
                      h('div',{style:{fontSize:10,color:'var(--text2)',fontWeight:600,letterSpacing:.5}},'MONTO TOTAL PERDIDO'),
                      h('div',{style:{fontSize:10,color:'var(--text3)',marginTop:2}},'Capital + intereses en mora')),
                    h('div',{className:'mono',style:{fontSize:16,fontWeight:700,color:'var(--red)'}},'-'+fmt(totPerd))));
              }());
          }());
      })));
}

// ── Deudores ──────────────────────────────────────────────────────────────────
function DeudoresView(props){
  var deudores=props.deudores,pays=props.pays,onSelect=props.onSelect,onAdd=props.onAdd;
  var sq=useState(''); var searchQ=sq[0]; var setSearchQ=sq[1];
  var filtered=deudores.filter(function(d){
    return !searchQ||d.nombre.toLowerCase().indexOf(searchQ.toLowerCase())!==-1;
  });
  return h('div',{className:'fade-in',style:{padding:16}},
    h('div',{style:{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:14}},
      h('div',null,
        h('div',{style:{fontWeight:700,fontSize:17,color:'var(--text)'}},'Mis Deudores'),
        h('div',{style:{fontSize:13,color:'var(--text2)',marginTop:2}},deudores.length+' personas')),
      h('button',{onClick:onAdd,style:{display:'flex',alignItems:'center',gap:6,background:'var(--green2)',color:'white',border:'none',borderRadius:10,padding:'8px 14px',fontSize:14,fontWeight:600,cursor:'pointer'}},
        h(Ico,{name:'plus',size:15,color:'white'}),' Nuevo')),
    h('div',{style:{position:'relative',marginBottom:12}},
      h('div',{style:{position:'absolute',left:11,top:'50%',transform:'translateY(-50%)',display:'flex'}},h(Ico,{name:'search',size:14,color:'var(--text3)'})),
      h('input',{value:searchQ,onChange:function(e){setSearchQ(e.target.value);},placeholder:'Buscar deudor...',className:'inp',style:{paddingLeft:33}})),
    deudores.length===0&&h('div',{style:{textAlign:'center',padding:'48px 0',color:'var(--text3)'}},
      h('div',{style:{marginBottom:12}},h(Ico,{name:'users',size:44,color:'var(--text3)'})),
      h('p',{style:{fontWeight:600,color:'var(--text2)'}},'Sin deudores registrados')),
    h('div',{style:{display:'flex',flexDirection:'column',gap:10}},
      (function(){
        var activos=filtered.filter(function(d){return d.loans.some(function(l){return l.estado==='Activo';});});
        var inactivos=filtered.filter(function(d){return !d.loans.some(function(l){return l.estado==='Activo';});});
        var items=[];
        activos.forEach(function(d){items.push({type:'card',d:d});});
        if(inactivos.length>0){
          items.push({type:'separator'});
          inactivos.forEach(function(d){items.push({type:'card',d:d});});
        }
        return items.map(function(item,i){
          if(item.type==='separator') return h('div',{key:'sep',style:{display:'flex',alignItems:'center',gap:10,margin:'10px 0'}},
            h('div',{style:{flex:1,height:1,background:'var(--border)'}}),
            h('span',{style:{fontSize:12,fontWeight:600,color:'var(--text3)',letterSpacing:1,textTransform:'uppercase'}},'Inactivos'),
            h('div',{style:{flex:1,height:1,background:'var(--border)'}}));
          var d=item.d;
          var activosCount=d.loans.filter(function(l){return l.estado==='Activo';}).length;
          return h('button',{key:d.nombre,className:'debtor-card',onClick:function(){onSelect(d);},
          style:{background:'var(--bg2)',border:'1px solid '+(d.mora>0?'var(--red-bd)':'var(--border)'),borderRadius:14,padding:'14px',textAlign:'left',cursor:'pointer',width:'100%',boxShadow:'var(--shadow)',transition:'border-color .15s'}},
          h('div',{style:{display:'flex',justifyContent:'space-between',alignItems:'flex-start'}},
            h('div',null,
              h('div',{style:{display:'flex',alignItems:'center',gap:8,marginBottom:6}},
                h('div',{style:{width:36,height:36,borderRadius:99,background:'var(--bg3)',border:'1px solid var(--border2)',display:'flex',alignItems:'center',justifyContent:'center',fontSize:16,flexShrink:0}},
                  d.nombre.charAt(0).toUpperCase()),
                h('div',null,
                  h('div',{style:{fontWeight:700,fontSize:14,color:'var(--text)'}},d.nombre),
                  d.cedula&&d.cedula!=='0'&&h('div',{style:{fontSize:12,color:'var(--text3)'}},'CC '+d.cedula))),
              h('div',{style:{display:'flex',gap:8,flexWrap:'wrap',alignItems:'center',marginTop:4}},
                d.telefono&&d.telefono!=='0'&&h('div',{style:{display:'flex',alignItems:'center',gap:4,fontSize:12,color:'var(--text2)'}},
                  h(Ico,{name:'phone',size:12,color:'var(--text3)'}),d.telefono),
                h('span',{className:'tag',style:{background:'var(--bg3)',color:'var(--text2)'}},activosCount+' prestamo'+(activosCount!==1?'s':'')),
                d.mora>0&&h('span',{className:'tag',style:{background:'var(--red-bg)',color:'var(--red)'}},d.mora+' mora'))),
            h('div',{style:{textAlign:'right'}},
              h('div',{className:'mono',style:{fontWeight:500,fontSize:15,color:'var(--green)'}},fmt(d.totalSaldo)),
              d.totalSaldoUSD>0&&h('div',{className:'mono',style:{fontSize:13,color:'var(--blue)',marginTop:1}},fmtUSD(d.totalSaldoUSD)),
              h('div',{style:{fontSize:12,color:'var(--text3)',marginTop:3}},'saldo total'))));
        });
      }())));
}

// ── DebtorModal ───────────────────────────────────────────────────────────────
function DebtorModal(props){
  var d=props.deudor,pays=props.pays,loans=props.loans,onClose=props.onClose,onNewLoan=props.onNewLoan,onAbono=props.onAbono,onRequestLiquidar=props.onRequestLiquidar,onReload=props.onReload,onReestructurar=props.onReestructurar;
  var ex=useState(null); var expLoan=ex[0]; var setExpLoan=ex[1];
  var cr=useState(null); var cronoLoan=cr[0]; var setCronoLoan=cr[1];
  // v2.0.0 — confirmLiq / incluyeProxMes / liqSending se movieron al componente LiquidarModal
  // (nivel App) para que el CTA de AbonoModal tambien pueda invocar la liquidacion. Aqui solo
  // queda el disparador: onRequestLiquidar(l).
  var cf=useState(null); var cambioFecha=cf[0]; var setCambioFecha=cf[1];
  var cfs=useState(false); var cfSending=cfs[0]; var setCfSending=cfs[1];   // v1.18.1: guarda anti doble-submit del cambio de fecha
  var ceu=useState(null); var comprasExp=ceu[0]; var setComprasExp=ceu[1];
  // Pagos de este deudor (por nombre, a traves de sus prestamos)
  var deudorPays=pays.filter(function(p){
    var loan=null;
    for(var i=0;i<loans.length;i++){if(loans[i].id===p.prestamoId){loan=loans[i];break;}}
    return loan&&loan.nombre===d.nombre;
  });
  // Fase 2: intereses REALMENTE cobrados, via imputacion — incluye la parte de interes que ya
  // cubrio un pago parcial en curso. Antes solo contaba cuotas con estadoPago==='Pagado', asi que
  // esta cifra de la cabecera contradecia al bloque RECAUDADO A LA FECHA del mismo perfil.
  var interesesPagados=deudorPays.reduce(function(s,p){return s+imputarCobros(p).totales.interes;},0);
  // Ultimo pago real: solo los que tienen fechaRecaudo definida
  var ultimoPago=deudorPays.filter(function(p){return p.estadoPago==='Pagado'&&p.fechaRecaudo;})
    .sort(function(a,b){return b.fechaRecaudo.localeCompare(a.fechaRecaudo);});
  // Cuotas en mora de este deudor (con detalle)
  var cuotasMora=deudorPays.filter(function(p){return p.estadoPago==='En Mora';})
    .sort(function(a,b){return a.fechaPago.localeCompare(b.fechaPago);});
  if(cambioFecha){
    var cfLoan=cambioFecha.loan;
    var cfEsUSD=cfLoan.moneda==='USD';
    var diaActual=cfLoan.diaPago;
    var nuevoDia=parseInt(cambioFecha.nuevoDia,10);
    var validNuevo=nuevoDia>=1&&nuevoDia<=31&&nuevoDia!==diaActual;
    var tasaMensual=+cfLoan.tasaMensual||0;
    // Cuota transitoria: interes prorrateado a los DIAS REALES del primer periodo (desde la
    // ultima cuota pagada / fechaInicio hasta la nueva fecha). Replica el calculo del backend.
    function _payDate(startISO,cuotaN,dp){var d=new Date(startISO+'T12:00:00');d.setDate(1);d.setMonth(d.getMonth()+cuotaN);d.setDate(Math.min(dp,new Date(d.getFullYear(),d.getMonth()+1,0).getDate()));return d.toISOString().split('T')[0];}
    function _addMes(iso){var d=new Date(iso+'T12:00:00');d.setDate(1);d.setMonth(d.getMonth()+1);return d.toISOString().split('T')[0];}
    function _fLarga(iso){if(!iso)return '';var d=new Date(iso+'T12:00:00');var M=['ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic'];return d.getDate()+' de '+M[d.getMonth()]+' de '+d.getFullYear();}
    var _base=cfLoan.fechaBaseCronograma||cfLoan.fechaInicio;
    var _lastSettled=cambioFecha.lastSettled||cfLoan.fechaInicio;
    var _nextN=(cambioFecha.regularConsumed||0)+1;
    var diasReales=0,intProrrateado=0,_first='';
    if(validNuevo){
      // Misma regla "nunca adelantar" que el backend: si el nuevo dia caeria antes de la cuota ya
      // agendada (dia menor en el mismo mes), la 1a cuota se proyecta al mes siguiente.
      var _origNext=_payDate(_base,_nextN,diaActual);
      var _naive=_payDate(_base,_nextN,nuevoDia);
      var _baseCron=_naive<_origNext?_addMes(_base):_base;
      _first=_payDate(_baseCron,_nextN,nuevoDia);
      diasReales=Math.max(1,Math.round((new Date(_first+'T12:00:00')-new Date(_lastSettled+'T12:00:00'))/86400000));
      intProrrateado=Math.round(cambioFecha.saldo*(tasaMensual/100)*diasReales/30);
    }
    var intMesNormal=Math.round(cambioFecha.saldo*tasaMensual/100);
    // Capital de la cuota (misma logica que buildSchedule): 0 en Intereses; en C+I = PMT - interes normal.
    var _r=tasaMensual/100;
    var _n=Math.max(1,(+cfLoan.plazoMeses||12)-(cambioFecha.regularConsumed||0));
    var _pmt=_r===0?cambioFecha.saldo/_n:cambioFecha.saldo*_r*Math.pow(1+_r,_n)/(Math.pow(1+_r,_n)-1);
    var capitalCuota=cfLoan.modalidad==='Intereses'?0:Math.max(0,Math.round(_pmt-intMesNormal));
    var moraConsolidada=cambioFecha.intMora;
    var primeraCuotaTotal=capitalCuota+intProrrateado+moraConsolidada;
    var cuotaRecurrente=cfLoan.modalidad==='Intereses'?intMesNormal:Math.round(_pmt);

    // Render del estado SUCCESS (comprobante post-éxito)
    if(cambioFecha.step==='success'){
      var rs=cambioFecha.resultado||{};
      return h(Modal,{onClose:function(){setCambioFecha(null);}},
        h('div',{style:{display:'flex',alignItems:'center',gap:8,marginBottom:6}},
          h('div',{style:{width:32,height:32,borderRadius:99,background:'var(--green-bg)',display:'flex',alignItems:'center',justifyContent:'center'}},h(Ico,{name:'check',size:18,color:'var(--green)',sw:2.5})),
          h('div',{style:{fontWeight:700,fontSize:16,color:'var(--text)'}},'Fecha de pago actualizada')),
        h('div',{style:{fontSize:12,color:'var(--text3)',marginBottom:14}},cfLoan.nombre+' • '+cfLoan.modalidad),
        h('div',{style:{background:'var(--green-bg)',border:'1px solid var(--green-bd)',borderRadius:12,padding:'14px',marginBottom:12}},
          h('div',{style:{fontSize:10,color:'var(--green)',fontWeight:600,letterSpacing:.5,marginBottom:4}},'PROXIMA CUOTA'),
          h('div',{style:{display:'flex',justifyContent:'space-between',alignItems:'flex-end',gap:10}},
            h('div',null,
              h('div',{style:{fontSize:13,color:'var(--text)',fontWeight:600}},(rs.primeraCuota&&rs.primeraCuota.fechaPago)?_fLarga(rs.primeraCuota.fechaPago):('Dia '+rs.nuevoDia)),
              h('div',{style:{fontSize:11,color:'var(--text3)',marginTop:2}},'Primer cobro · luego el dia '+rs.nuevoDia+' de cada mes')),
            h('div',{style:{textAlign:'right'}},
              h('div',{className:'mono',style:{fontSize:22,fontWeight:700,color:'var(--green)'}},fmt(rs.primeraCuota&&rs.primeraCuota.cuotaTotal||primeraCuotaTotal)),
              cfEsUSD&&h('div',{className:'mono',style:{fontSize:11,color:'var(--blue)'}},copToUsd(rs.primeraCuota&&rs.primeraCuota.cuotaTotal||primeraCuotaTotal,cfLoan.trmAcordada))))),
        h('div',{style:{background:'var(--bg3)',borderRadius:12,padding:'4px 14px',marginBottom:12,border:'1px solid var(--border)'}},
          h('div',{style:{fontSize:10,color:'var(--text3)',fontWeight:600,letterSpacing:.5,padding:'10px 0 6px'}},'DESGLOSE DE LA CUOTA TRANSITORIA'),
          (rs.capitalCuota||0)>0&&h('div',{style:{display:'flex',justifyContent:'space-between',padding:'7px 0',borderTop:'1px solid var(--bg)',fontSize:12}},
            h('span',{style:{color:'var(--text2)'}},'Capital de la cuota'),
            h('span',{className:'mono',style:{color:'var(--text)',fontWeight:500}},fmt(rs.capitalCuota))),
          h('div',{style:{display:'flex',justifyContent:'space-between',padding:'7px 0',borderTop:'1px solid var(--bg)',fontSize:12}},
            h('span',{style:{color:'var(--text2)'}},'Intereses prorrateados ('+(rs.diasReales||diasReales)+' dias)'),
            h('span',{className:'mono',style:{color:'var(--yellow)',fontWeight:500}},fmt(rs.prorrateo||intProrrateado))),
          (rs.moraConsolidada||0)>0&&h('div',{style:{display:'flex',justifyContent:'space-between',padding:'7px 0',borderTop:'1px solid var(--bg)',fontSize:12}},
            h('span',{style:{color:'var(--text2)'}},rs.moraCount+' cuota'+(rs.moraCount>1?'s':'')+' en mora'),
            h('span',{className:'mono',style:{color:'var(--text)',fontWeight:500}},fmt(rs.moraConsolidada))),
          h('div',{style:{display:'flex',justifyContent:'space-between',padding:'9px 0 4px',borderTop:'2px solid var(--border)',fontSize:13}},
            h('span',{style:{color:'var(--text)',fontWeight:700}},'Total cuota transitoria'),
            h('span',{className:'mono',style:{color:'var(--green)',fontWeight:700}},fmt(rs.cuotaTotalTransitoria||(rs.primeraCuota&&rs.primeraCuota.cuotaTotal)||primeraCuotaTotal)))),
        h('div',{style:{background:'var(--bg3)',borderRadius:10,padding:'10px 12px',marginBottom:14,fontSize:12,color:'var(--text2)',display:'flex',justifyContent:'space-between',alignItems:'center'}},
          h('span',null,'Cuotas siguientes (cada dia '+rs.nuevoDia+')'),
          h('span',{className:'mono',style:{color:'var(--text)',fontWeight:600}},fmt(rs.cuotasRecurrentes||cuotaRecurrente))),
        h('button',{onClick:function(){setCambioFecha(null);},className:'btn-primary',style:{background:'var(--green2)',color:'#fff',border:'none'}},'Cerrar'));
    }

    // Render del estado FORM
    return h(Modal,{onClose:function(){setCambioFecha(null);}},
      h('div',{style:{fontWeight:700,fontSize:17,color:'var(--text)',marginBottom:2,display:'flex',alignItems:'center',gap:8}},
        h(Ico,{name:'calendar',size:16,color:'var(--blue)',sw:2}),'Cambiar fecha de pago'),
      h('div',{style:{fontSize:12,color:'var(--text3)',marginBottom:14}},cfLoan.nombre+' • '+cfLoan.modalidad+' • '+tasaMensual+'% mensual'),
      h('div',{style:{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10,marginBottom:12}},
        h('div',{style:{background:'var(--bg3)',borderRadius:10,padding:'10px 12px',border:'1px solid var(--border)'}},
          h('div',{style:{fontSize:10,color:'var(--text3)',fontWeight:600,letterSpacing:.5}},'DIA ACTUAL'),
          h('div',{style:{fontSize:18,fontWeight:700,color:'var(--text)',marginTop:2}},diaActual)),
        h('div',{style:{background:'var(--blue-bg)',borderRadius:10,padding:'10px 12px',border:'1px solid var(--blue-bd)'}},
          h('div',{style:{fontSize:10,color:'var(--blue)',fontWeight:600,letterSpacing:.5}},'NUEVO DIA'),
          h('input',{type:'number',min:1,max:31,value:cambioFecha.nuevoDia,onChange:function(e){setCambioFecha(Object.assign({},cambioFecha,{nuevoDia:e.target.value}));},placeholder:'1-31',autoFocus:true,style:{width:'100%',background:'transparent',border:'none',outline:'none',fontSize:18,fontWeight:700,color:'var(--blue)',marginTop:2,padding:0,fontFamily:'inherit'}}))),
      cambioFecha.moraCount>0&&h('div',{style:{background:'var(--red-bg)',border:'1px solid var(--red-bd)',borderRadius:10,padding:'10px 12px',marginBottom:12,fontSize:11,color:'var(--text2)',lineHeight:1.5}},
        h('div',{style:{fontWeight:700,color:'var(--red)',marginBottom:4,display:'flex',alignItems:'center',gap:5}},h(Ico,{name:'alert',size:12,color:'var(--red)',sw:2.4}),' '+cambioFecha.moraCount+' CUOTA'+(cambioFecha.moraCount>1?'S':'')+' EN MORA'),
        'Se consolidaran en la primera cuota nueva ('+fmt(moraConsolidada)+' en intereses).'),
      validNuevo?h('div',{style:{background:'var(--bg3)',borderRadius:12,padding:'4px 14px',marginBottom:12,border:'1px solid var(--border)'}},
        h('div',{style:{fontSize:10,color:'var(--text3)',fontWeight:600,letterSpacing:.5,padding:'10px 0 6px'}},'DESGLOSE DE LA CUOTA TRANSITORIA'),
        capitalCuota>0&&h('div',{style:{display:'flex',justifyContent:'space-between',padding:'7px 0',borderTop:'1px solid var(--bg)',fontSize:12}},
          h('div',null,
            h('div',{style:{color:'var(--text2)'}},'Capital de la cuota'),
            h('div',{style:{fontSize:10,color:'var(--text3)',marginTop:1}},'Amortizacion (igual que una cuota normal)')),
          h('span',{className:'mono',style:{color:'var(--text)',fontWeight:500}},fmt(capitalCuota))),
        h('div',{style:{display:'flex',justifyContent:'space-between',padding:'7px 0',borderTop:'1px solid var(--bg)',fontSize:12}},
          h('div',null,
            h('div',{style:{color:'var(--text2)'}},'Intereses prorrateados ('+diasReales+' dias)'),
            h('div',{style:{fontSize:10,color:'var(--text3)',marginTop:1}},'Saldo × ('+tasaMensual+'%/30) × '+diasReales+' dias')),
          h('span',{className:'mono',style:{color:'var(--yellow)',fontWeight:500}},fmt(intProrrateado))),
        moraConsolidada>0&&h('div',{style:{display:'flex',justifyContent:'space-between',padding:'7px 0',borderTop:'1px solid var(--bg)',fontSize:12}},
          h('span',{style:{color:'var(--text2)'}},'Mora consolidada'),
          h('span',{className:'mono',style:{color:'var(--text)',fontWeight:500}},fmt(moraConsolidada))),
        h('div',{style:{display:'flex',justifyContent:'space-between',padding:'9px 0 4px',borderTop:'2px solid var(--border)',fontSize:13}},
          h('span',{style:{color:'var(--text)',fontWeight:700}},'Total cuota transitoria'),
          h('span',{className:'mono',style:{color:'var(--green)',fontWeight:700}},fmt(primeraCuotaTotal)))):
        h('div',{style:{background:'var(--bg3)',borderRadius:10,padding:'14px',marginBottom:12,fontSize:12,color:'var(--text3)',textAlign:'center'}},'Ingresa un nuevo dia (1-31) distinto al actual para ver el desglose'),
      validNuevo&&h('div',{style:{background:'var(--green-bg)',border:'1px solid var(--green-bd)',borderRadius:12,padding:'12px 14px',marginBottom:12,display:'flex',justifyContent:'space-between',alignItems:'center'}},
        h('div',null,
          h('div',{style:{fontSize:10,color:'var(--green)',fontWeight:600,letterSpacing:.5}},'PRIMERA CUOTA ('+_fLarga(_first)+')'),
          h('div',{style:{fontSize:10,color:'var(--text3)',marginTop:2}},'A partir de la 2a cuota: '+fmt(cuotaRecurrente)+' el dia '+nuevoDia+' de cada mes')),
        h('div',{style:{textAlign:'right'}},
          h('div',{className:'mono',style:{fontSize:20,fontWeight:700,color:'var(--green)'}},fmt(primeraCuotaTotal)),
          cfEsUSD&&h('div',{className:'mono',style:{fontSize:11,color:'var(--blue)'}},copToUsd(primeraCuotaTotal,cfLoan.trmAcordada)))),
      // v1.18.1 — GUARDA ANTI DOBLE-SUBMIT. El endpoint no es idempotente: con el payload
      // identico el backend rechaza el 2o intento, pero el input de dia (arriba) sigue
      // editable mientras el POST viaja, asi que un usuario impaciente puede cambiar el dia
      // y reconfirmar; ese 2o request SI pasa el filtro y rueda `fechaBaseCronograma` un mes
      // extra, reescribiendo la cuota transitoria con un prorrateo inflado.
      h('button',{onClick:function(){
        if(cfSending) return;
        if(!validNuevo){showError('Ingresa un dia valido (1-31, distinto al actual)');return;}
        setCfSending(true);
        API.post('/api/loans/'+cfLoan.id+'/cambiar-dia-pago',{
          nuevoDia:nuevoDia
        }).then(function(r){
          // API.post nunca rechaza (atrapa y resuelve null), asi que TODAS las salidas
          // pasan por aqui: liberamos siempre antes de decidir que hacer.
          setCfSending(false);
          if(!r)return;
          if(r.error){showError(r.error);return;}
          setCambioFecha(Object.assign({},cambioFecha,{step:'success',resultado:r}));
          if(onReload)onReload();
        },function(){setCfSending(false);});
      },disabled:!validNuevo||cfSending,className:'btn-primary',style:{background:(validNuevo&&!cfSending)?'var(--blue-bg)':'var(--bg3)',border:'1px solid '+((validNuevo&&!cfSending)?'var(--blue-bd)':'var(--border)'),color:(validNuevo&&!cfSending)?'var(--blue)':'var(--text3)',marginBottom:6,cursor:(validNuevo&&!cfSending)?'pointer':'not-allowed'}},cfSending?'Procesando...':'Confirmar cambio'),
      h('button',{onClick:function(){setCambioFecha(null);},className:'btn-primary',style:{background:'var(--bg3)',border:'1px solid var(--border)',color:'var(--text2)'}},'Cancelar'));
  }
  return h(Modal,{onClose:onClose,wide:true,tall:true},
    h('div',{style:{display:'flex',alignItems:'center',gap:12,marginBottom:16}},
      h('div',{style:{width:48,height:48,borderRadius:99,background:'var(--bg3)',border:'1px solid var(--border2)',display:'flex',alignItems:'center',justifyContent:'center',fontSize:22,flexShrink:0}},
        d.nombre.charAt(0).toUpperCase()),
      h('div',null,
        h('div',{style:{fontWeight:700,fontSize:17,color:'var(--text)'}},d.nombre),
        d.cedula&&d.cedula!=='0'&&h('div',{style:{fontSize:12,color:'var(--text2)'}},'CC '+d.cedula))),
    d.telefono&&d.telefono!=='0'&&h('div',{style:{display:'flex',alignItems:'center',gap:8,background:'var(--bg3)',borderRadius:10,padding:'10px 12px',marginBottom:4}},
      h(Ico,{name:'phone',size:14,color:'var(--blue)'}),
      h('span',{style:{fontSize:13,color:'var(--text)'}},d.telefono)),
    h('div',{style:{display:'grid',gridTemplateColumns:'1fr 1fr',gap:8,marginTop:8}},
      h('div',{style:{background:'var(--bg3)',borderRadius:12,padding:'12px'}},
        h('div',{style:{fontSize:10,color:'var(--text3)',fontWeight:600,marginBottom:4}},'SALDO ACTUAL'),
        h('div',{className:'mono',style:{fontSize:14,fontWeight:600,color:'var(--green)'}},fmt(d.totalSaldo))),
      h('div',{style:{background:'var(--bg3)',borderRadius:12,padding:'12px'}},
        h('div',{style:{fontSize:10,color:'var(--text3)',fontWeight:600,marginBottom:4}},'INTERESES PAGADOS'),
        h('div',{className:'mono',style:{fontSize:14,fontWeight:600,color:'var(--blue)'}},fmt(interesesPagados))),
      h('div',{style:{background:'var(--bg3)',borderRadius:12,padding:'12px'}},
        h('div',{style:{fontSize:10,color:'var(--text3)',fontWeight:600,marginBottom:4}},'PRESTAMOS'),
        h('div',{style:{fontSize:14,fontWeight:600,color:'var(--text)'}},d.loans.length+' ('+d.loans.filter(function(l){return l.estado==='Activo';}).length+' activos)')),
      h('div',{style:{background:d.mora>0?'var(--red-bg)':'var(--bg3)',borderRadius:12,padding:'12px',border:d.mora>0?'1px solid var(--red-bd)':'none'}},
        h('div',{style:{fontSize:10,color:d.mora>0?'var(--red)':'var(--text3)',fontWeight:600,marginBottom:4}},'CUOTAS EN MORA'),
        h('div',{style:{fontSize:14,fontWeight:600,color:d.mora>0?'var(--red)':'var(--text)'}},d.mora))),
    cuotasMora.length>0&&h('div',{style:{marginTop:8,background:'var(--red-bg)',borderRadius:10,padding:'10px 12px',border:'1px solid var(--red-bd)'}},
      cuotasMora.map(function(p,i){
        var pend=pendCuota(p);var hasPartial=(p.partialPaid||0)>0;
        return h('div',{key:p.id,style:{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'6px 0',borderTop:i>0?'1px solid rgba(248,81,73,.15)':'none'}},
          h('div',null,
            h('div',{style:{fontSize:12,fontWeight:500,color:'var(--text)'}},p.nombreCliente),
            h('div',{style:{fontSize:11,color:'var(--red)',marginTop:1}},'Cuota '+p.cuotaN+' - Vencida el '+fmtD(p.fechaPago)),
            hasPartial&&h('div',{className:'mono',style:{fontSize:10,color:'var(--blue)',marginTop:1}},'Abonado '+fmt(p.partialPaid)+' de '+fmt(p.cuotaTotal))),
          h('div',{style:{textAlign:'right'}},
            h('div',{className:'mono',style:{fontSize:12,fontWeight:300,color:'var(--red)'}},fmt(pend)),
            function(){var pl=null;for(var j=0;j<loans.length;j++){if(loans[j].id===p.prestamoId){pl=loans[j];break;}}
              return pl&&pl.moneda==='USD'?h('div',{className:'mono',style:{fontSize:10,color:'var(--blue)'}},copToUsd(pend,pl.trmAcordada)):null;}()));
      })),
    h('div',{style:{marginTop:8,padding:'10px 12px',background:'var(--bg3)',borderRadius:10,fontSize:12,color:'var(--text2)'}},
      ultimoPago.length>0?'Ultimo pago: '+fmtD(ultimoPago[0].fechaRecaudo):'Sin pagos realizados'),
    h('div',{style:{marginTop:12}},
      h('div',{style:{fontSize:11,fontWeight:600,color:'var(--text3)',marginBottom:8}},'PRESTAMOS ACTIVOS'),
      h('button',{onClick:function(){onNewLoan(d);},style:{width:'100%',background:'var(--green2)',color:'white',border:'none',borderRadius:10,padding:'10px',fontSize:12,fontWeight:600,cursor:'pointer',display:'flex',alignItems:'center',justifyContent:'center',gap:5,fontFamily:'inherit',marginBottom:10}},h(Ico,{name:'plus',size:13,color:'white'}),' Nuevo prestamo a '+d.nombre),
      d.loans.filter(function(l){return l.estado==='Activo';}).length===0&&h('div',{style:{fontSize:12,color:'var(--text3)',padding:'8px 0',fontStyle:'italic'}},'Sin prestamos activos'),
      d.loans.filter(function(l){return l.estado==='Activo';}).slice().sort(function(a,b){return b.fechaInicio.localeCompare(a.fechaInicio);}).map(function(l){
        var lp=pays.filter(function(p){return p.prestamoId===l.id;});
        var esAbono=function(p){return p.id.indexOf('-ab-')!==-1;};
        var regulares=lp.filter(function(p){return !esAbono(p);});
        var abonosList=lp.filter(function(p){return esAbono(p);});
        var pagadas=regulares.filter(function(p){return p.estadoPago==='Pagado';}).length;
        var enMora=regulares.filter(function(p){return p.estadoPago==='En Mora';});
        var pendientes=regulares.filter(function(p){return p.estadoPago==='Pendiente';});
        var totalReg=regulares.length;
        var pct=totalReg>0?Math.round(pagadas/totalReg*100):0;
        // Saldo real: monto original - todo capital pagado (cuotas + abonos)
        var capAbonos=abonosList.filter(function(p){return p.estadoPago==='Pagado';}).reduce(function(s,p){return s+p.abonoCapital;},0);
        var origCOP=l.moneda==='USD'?Math.round(l.montoOrigen*l.trmAcordada):Math.round(l.montoOrigen);
        var todoCapPag=lp.filter(function(p){return p.estadoPago==='Pagado';}).reduce(function(s,p){return s+p.abonoCapital;},0);
        var saldo=Math.max(0,origCOP-todoCapPag);
        var intCobrados=regulares.filter(function(p){return p.estadoPago==='Pagado';}).reduce(function(s,p){return s+p.interesPeriodo;},0);
        var partialPend=regulares.filter(function(p){return p.estadoPago!=='Pagado';}).reduce(function(s,p){return s+(p.partialPaid||0);},0);
        // Fase 2: imputacion agregada del prestamo (cascada interes -> capital, ver imputarCobros).
        // Es la base de TODA cifra de "lo cobrado" que se muestra abajo, de modo que el bloque
        // RECAUDADO A LA FECHA y el panel de Flujo de Caja no puedan contradecirse: los dos
        // iteran los mismos eventos de caja.
        var impLoan=lp.reduce(function(a,p){var t=imputarCobros(p).totales;
          a.cobrado+=t.cobrado; a.interes+=t.interes; a.capital+=t.capital; a.ajuste+=t.ajuste; return a;},
          {cobrado:0,interes:0,capital:0,ajuste:0});
        // SALDO MOSTRADO: capital vivo descontando el capital que YA cubrieron los parciales en
        // curso. Antes restaba el parcial COMPLETO (`saldo - partialPend`), lo que descontaba de
        // una cifra de capital una plata que en parte era interes -> restaba de mas.
        // OJO: `saldo` (canonico) NO se toca; gobierna liquidacion, techo del abono y recalculo.
        var saldoDisplay=Math.max(0,origCOP-Math.round(impLoan.capital));
        var esUSD=l.moneda==='USD';
        // Desglose de ganancia USD: separa intereses puros de la utilidad cambiaria (diferencia de TRM al cobro).
        // gananciaTRM = sum(montoCOPRecibido - cuotaTotal) por cuota pagada que tiene montoCOPRecibido > 0
        // Ganancia/Perdida TRM = diferencia entre COP recibido y "valor contractual" (a TRM acordada)
        //   - Cuotas regulares: montoCOPRecibido - cuotaTotal (cuotaTotal ya esta en COP con TRM acordada)
        //   - Abonos a capital: montoCOPRecibido - (montoUSDRecibido * trmAcordada) — solo si el abono se registro con USD
        var gananciaTRMReg=esUSD?regulares.filter(function(p){return p.estadoPago==='Pagado'&&p.montoCOPRecibido&&p.montoCOPRecibido>0;}).reduce(function(s,p){return s+(p.montoCOPRecibido-p.cuotaTotal);},0):0;
        var gananciaTRMAb=esUSD?lp.filter(function(p){return p.id.indexOf('-ab-')!==-1&&p.estadoPago==='Pagado'&&p.montoUSDRecibido&&p.montoUSDRecibido>0;}).reduce(function(s,p){return s+(p.montoCOPRecibido-(p.montoUSDRecibido*l.trmAcordada));},0):0;
        var gananciaTRM=Math.round(gananciaTRMReg+gananciaTRMAb);
        var gananciaTotal=intCobrados+gananciaTRM;
        var isExp=expLoan===l.id;
        // Próxima cuota
        var proxCuota=pendientes.sort(function(a,b){return a.fechaPago.localeCompare(b.fechaPago);})[0];
        return h('div',{key:l.id,style:{background:'var(--bg2)',borderRadius:12,border:'1px solid '+(enMora.length>0?'var(--red-bd)':'var(--border)'),marginBottom:8,overflow:'hidden'}},
          h('div',{onClick:function(){setExpLoan(isExp?null:l.id);},style:{padding:'11px 13px',cursor:'pointer',display:'flex',justifyContent:'space-between',alignItems:'center'}},
            h('div',{style:{flex:1,minWidth:0}},
              h('div',{style:{display:'flex',alignItems:'center',gap:6,flexWrap:'wrap'}},
                h('span',{style:{fontWeight:700,fontSize:13,color:'var(--text)'}},l.modalidad),
                esUSD&&h('span',{className:'tag',style:{background:'var(--blue-bg)',color:'var(--blue)'}},'USD'),
                enMora.length>0&&h('span',{className:'tag',style:{background:'var(--red-bg)',color:'var(--red)'}},enMora.length+' mora'),
                partialPend>0&&h('span',{className:'tag',style:{background:'var(--blue-bg)',color:'var(--blue)'}},'Parcial'),
                l.modalidad==='Intereses'?h('span',{className:'tag',style:{background:'var(--blue-bg)',color:'var(--blue)'}},'\u221E'):l.modalidad==='Prestamo'?h('span',{className:'tag',style:{background:'var(--yellow-bg)',color:'var(--yellow)'}},'Sin interes'):l.modalidad==='Pago Unico'?h('span',{className:'tag',style:{background:'var(--green-bg)',color:'var(--green)'}},'Pago unico'):h('span',{className:'tag',style:{background:'var(--green-bg)',color:'var(--green)'}},pct+'%')),
              h('div',{style:{fontSize:11,color:'var(--text3)',marginTop:3}},fmtD(l.fechaInicio)+' \u2022 '+l.tasaMensual+'% \u2022 '+(freqLabel(l))),
              partialPend>0&&h('div',{className:'mono',style:{fontSize:10,color:'var(--blue)',marginTop:2}},'Abonado '+fmt(partialPend)+' de '+fmt(saldo))),
            h('div',{style:{textAlign:'right',marginLeft:8}},
              h('div',{className:'mono',style:{fontSize:14,fontWeight:600,color:'var(--green)'}},fmt(saldoDisplay)),
              esUSD&&h('div',{className:'mono',style:{fontSize:10,color:'var(--blue)'}},copToUsd(saldoDisplay,l.trmAcordada)))),
          isExp&&function(){
            // Unificado con el helper centralizado computeLiquidacion (doctrina "un solo helper",
            // v1.19.0): esta tarjeta era la última superficie que aún recalculaba la fórmula inline.
            var _Lq=computeLiquidacion(l,lp,{});
            var intMoraTotal=_Lq.intMora;
            var liquidacion=_Lq.total;
            var origCOPDisplay=esUSD?Math.round(l.montoOrigen*l.trmAcordada):Math.round(l.montoOrigen);
            // Parse comprasUSD una sola vez
            var lotes=null;
            if(esUSD&&l.comprasUSD){try{var parsed=typeof l.comprasUSD==='string'?JSON.parse(l.comprasUSD):l.comprasUSD;if(Array.isArray(parsed)&&parsed.length>0)lotes=parsed;}catch(_){}}
            var lotesUSD=lotes?lotes.reduce(function(s,c){return s+(+c.monto||0);},0):0;
            var lotesCOP=lotes?lotes.reduce(function(s,c){return s+(+c.monto||0)*(+c.tasa||0);},0):0;
            var lotesTRMProm=lotes&&lotesUSD>0?Math.round(lotesCOP/lotesUSD):0;
            // ── Recaudado a la fecha (flujo de caja parcial) ──
            // Fase 2: los tres rubros salen de la IMPUTACION, no de filtrar por estadoPago==='Pagado'.
            // Antes un parcial en curso era INVISIBLE aqui: el cliente abonaba $400.000 y ni el
            // capital, ni los intereses, ni el total se movian — mientras el panel de Flujo de Caja,
            // justo debajo, si contaba el dinero. En el caso real que lo destapo, la contradiccion entre
            // los dos bloques del MISMO recuadro fue de $400.000 exactos.
            var recCapHoy=Math.round(impLoan.capital);   // capital recuperado (incluye parciales)
            var recIntHoy=Math.round(impLoan.interes);   // intereses cobrados (incluye parciales)
            var recTRMHoy=Math.round(impLoan.ajuste);    // efecto cambiario, ya aislado por la imputacion
            var recGanHoy=recIntHoy+recTRMHoy;           // ganancia = interes + efecto TRM
            // TOTAL = caja real. Por construccion == capital + interes + ajuste, asi que las filas
            // SUMAN el total y ademas coincide con el total del panel de Flujo de Caja.
            var recTotalHoy=Math.round(impLoan.cobrado);
            var trm=l.trmAcordada;
            var recRegPag=regulares.filter(function(p){return p.estadoPago==='Pagado';});
            var recAboPag=abonosList.filter(function(p){return p.estadoPago==='Pagado';});
            var efectoTRMUSDHoy=esUSD&&trm>0?(recRegPag.filter(function(p){return p.montoUSDRecibido&&p.montoUSDRecibido>0;}).reduce(function(s,p){return s+(p.montoUSDRecibido-p.cuotaTotal/trm);},0)+recAboPag.filter(function(p){return p.montoUSDRecibido&&p.montoUSDRecibido>0;}).reduce(function(s,p){return s+(p.montoUSDRecibido-p.abonoCapital/trm);},0)):0;
            var recCapUSD=esUSD&&trm>0?recCapHoy/trm:0;
            var recTotalUSD=recCapUSD+(esUSD&&trm>0?recIntHoy/trm:0)+efectoTRMUSDHoy;
            var ganTotUSDHoy=recTotalUSD-recCapUSD; // = interes USD + efecto TRM USD (real, Bug #25)
            // Helper row: label izquierda, valor derecha. divider=true \u2192 linea entre filas internas.
            function row(label,value,sub,opts){
              opts=opts||{};
              return h('div',{style:{display:'flex',justifyContent:'space-between',alignItems:'flex-start',padding:'7px 0',borderTop:opts.first?'none':'1px solid var(--bg3)'}},
                h('div',{style:{flex:1,minWidth:0,paddingRight:8}},
                  h('div',{style:{fontSize:12,color:'var(--text2)',fontWeight:opts.strong?600:500}},label),
                  sub&&h('div',{style:{fontSize:10,color:'var(--text3)',marginTop:1}},sub)),
                h('div',{style:{textAlign:'right',flexShrink:0}},value));
            }
            // Estilo de separador entre GRUPOS (mas prominente que entre filas)
            var grupoStyle={paddingTop:12,marginTop:12,borderTop:'1px solid var(--bg2)'};
            return h('div',{style:{borderTop:'1px solid var(--border)',padding:'12px 13px',background:'var(--bg3)'}},
              // \u2500\u2500 GRUPO 1: SALDO PENDIENTE (hero) \u2500\u2500
              h('div',{style:{display:'flex',justifyContent:'space-between',alignItems:'flex-end',padding:'2px 0 12px',borderBottom:'1px solid var(--bg2)'}},
                h('div',null,
                  h('div',{style:{fontSize:10,color:'var(--text3)',fontWeight:600,letterSpacing:.5}},'SALDO PENDIENTE'),
                  partialPend>0&&h('div',{className:'mono',style:{fontSize:10,color:'var(--blue)',marginTop:2}},'Abonado parcial: '+fmt(partialPend))),
                h('div',{style:{textAlign:'right'}},
                  h('div',{className:'mono',style:{fontSize:20,fontWeight:600,color:enMora.length>0?'var(--red)':saldoDisplay===0?'var(--text3)':'var(--text)'}},fmt(saldoDisplay)),
                  esUSD&&h('div',{className:'mono',style:{fontSize:12,color:'var(--blue)',fontWeight:400}},copToUsd(saldoDisplay,l.trmAcordada)))),
              // \u2500\u2500 GRUPO 2: INFORMACION DEL PRESTAMO \u2500\u2500
              h('div',{style:{paddingTop:10}},
                row('Capital prestado',
                  h('div',null,
                    h('div',{className:'mono',style:{fontSize:13,color:'var(--text)',fontWeight:500}},esUSD?'USD $'+fmtN(l.montoOrigen):fmt(l.montoOrigen)),
                    esUSD&&h('div',{className:'mono',style:{fontSize:10,color:'var(--text3)'}},fmt(origCOPDisplay)+' \u00B7 TRM $'+fmtN(l.trmAcordada))),
                  null,{first:true}),
                row('Cuotas pagadas',h('div',{style:{fontSize:13,color:'var(--text)',fontWeight:500}},pagadas+' / '+(l.modalidad==='Intereses'?'\u221E':totalReg)))),
              // \u2500\u2500 GRUPO 3: RECAUDADO A LA FECHA (flujo de caja parcial + ganancia) \u2500\u2500
              // El gate incluye impLoan.cobrado para que un prestamo cuyo unico cobro sea un pago
              // parcial en curso tambien muestre el bloque (antes exigia una cuota ya Pagada).
              (pagadas>0||capAbonos>0||impLoan.cobrado>0)&&h('div',{style:grupoStyle},
                h('div',{style:{fontSize:10,color:'var(--text3)',fontWeight:600,letterSpacing:.5,marginBottom:4}},'RECAUDADO A LA FECHA'),
                h('div',{style:{display:'flex',justifyContent:'space-between',alignItems:'flex-start',padding:'2px 0 9px',borderBottom:'1px solid var(--bg2)'}},
                  h('div',null,
                    h('div',{style:{fontSize:12,color:'var(--text)',fontWeight:600,letterSpacing:.3}},'TOTAL RECIBIDO'),
                    h('div',{style:{fontSize:10,color:'var(--text3)',marginTop:1}},'Lo cobrado hasta hoy')),
                  h('div',{style:{textAlign:'right'}},
                    h('div',{className:'mono',style:{fontSize:16,fontWeight:600,color:'var(--text)'}},fmt(recTotalHoy)),
                    esUSD&&h('div',{className:'mono',style:{fontSize:11,color:'var(--blue)'}},fmtUSD(recTotalUSD)))),
                row('Capital recuperado',
                  h('div',null,
                    h('div',{className:'mono',style:{fontSize:13,color:'var(--text)',fontWeight:500}},fmt(recCapHoy)),
                    esUSD&&h('div',{className:'mono',style:{fontSize:10,color:'var(--blue)'}},copToUsd(recCapHoy,l.trmAcordada))),
                  null,{first:true}),
                row('Intereses cobrados',
                  h('div',null,
                    h('div',{className:'mono',style:{fontSize:13,color:recIntHoy>0?'var(--green)':'var(--text3)',fontWeight:500}},(recIntHoy>0?'+':'')+fmt(recIntHoy)),
                    esUSD&&recIntHoy>0&&h('div',{className:'mono',style:{fontSize:10,color:'var(--blue)'}},copToUsd(recIntHoy,l.trmAcordada)))),
                esUSD&&row(recTRMHoy<0?'Perdida por TRM':'Ganancia por TRM',
                  h('div',{className:'mono',style:{fontSize:13,color:recTRMHoy>0?'var(--green)':recTRMHoy<0?'var(--red)':'var(--text3)',fontWeight:500}},(recTRMHoy>0?'+':recTRMHoy<0?'-':'')+fmt(Math.abs(recTRMHoy))),
                  recTRMHoy===0?'Sin datos de TRM al cobro':recTRMHoy>0?'TRM subio al cobrar':'TRM bajo al cobrar'),
                esUSD&&row(l.modalidad==='Prestamo'?'Resultado total':'Ganancia total',
                  h('div',null,
                    h('div',{className:'mono',style:{fontSize:14,color:recGanHoy<0?'var(--red)':'var(--green)',fontWeight:600}},(recGanHoy<0?'-':'+')+fmt(Math.abs(recGanHoy))),
                    h('div',{className:'mono',style:{fontSize:10,color:'var(--blue)',fontWeight:400}},(ganTotUSDHoy<0?'-':'+')+fmtUSD(Math.abs(ganTotUSDHoy)))),
                  null,{strong:true}),
                capAbonos>0&&row('Abonos a capital recibidos',
                  h('div',null,
                    h('div',{className:'mono',style:{fontSize:13,color:'var(--blue)',fontWeight:500}},fmt(capAbonos)),
                    esUSD&&h('div',{className:'mono',style:{fontSize:10,color:'var(--blue)'}},copToUsd(capAbonos,l.trmAcordada)))),
                // v2.2.0 — mismo panel que en los creditos cerrados: lo cobrado hasta HOY,
                // movimiento por movimiento, en la fecha real en que entro cada peso.
                h(FlujoCajaPanel,{loan:l,pays:pays})),
              // \u2500\u2500 GRUPO 4: ESTADO (mora + proxima + liquidacion) \u2500\u2500
              (enMora.length>0||proxCuota||(l.estado==='Activo'&&saldo>0))&&h('div',{style:grupoStyle},
                h('div',{style:{fontSize:10,color:'var(--text3)',fontWeight:600,letterSpacing:.5,marginBottom:2}},'ESTADO'),
                enMora.length>0&&h('div',{style:{display:'flex',justifyContent:'space-between',alignItems:'flex-start',padding:'7px 0'}},
                  h('div',{style:{flex:1,minWidth:0}},
                    h('div',{style:{fontSize:12,color:'var(--red)',fontWeight:500,display:'flex',alignItems:'center',gap:5}},
                      h(Ico,{name:'alert',size:11,color:'var(--red)',sw:2.4}),
                      enMora.length+' cuota'+(enMora.length>1?'s':'')+' en mora'),
                    h('div',{style:{fontSize:10,color:'var(--text3)',marginTop:1}},enMora.map(function(p){return 'Cuota '+p.cuotaN+' \u00B7 '+fmtD(p.fechaPago);}).join(' \u2022 '))),
                  h('div',{style:{textAlign:'right'}},
                    h('div',{className:'mono',style:{fontSize:13,color:'var(--red)',fontWeight:500}},fmt(enMora.reduce(function(s,p){return s+pendCuota(p);},0))),
                    esUSD&&h('div',{className:'mono',style:{fontSize:10,color:'var(--blue)'}},copToUsd(enMora.reduce(function(s,p){return s+pendCuota(p);},0),l.trmAcordada)))),
                proxCuota&&h('div',{style:{display:'flex',justifyContent:'space-between',alignItems:'flex-start',padding:'7px 0',borderTop:enMora.length>0?'1px solid var(--bg3)':'none'}},
                  h('div',null,
                    h('div',{style:{fontSize:12,color:'var(--green)',fontWeight:500,display:'flex',alignItems:'center',gap:5}},
                      h(Ico,{name:'calendar',size:11,color:'var(--green)',sw:2.4}),
                      'Proxima cuota'),
                    h('div',{style:{fontSize:10,color:'var(--text3)',marginTop:1}},'Cuota '+proxCuota.cuotaN+' \u2022 '+fmtD(proxCuota.fechaPago))),
                  h('div',{style:{textAlign:'right'}},
                    h('div',{className:'mono',style:{fontSize:13,color:'var(--green)',fontWeight:500}},fmt(proxCuota.cuotaTotal)),
                    esUSD&&h('div',{className:'mono',style:{fontSize:10,color:'var(--blue)'}},copToUsd(proxCuota.cuotaTotal,l.trmAcordada)))),
                l.estado==='Activo'&&saldo>0&&h('div',{style:{display:'flex',justifyContent:'space-between',alignItems:'flex-start',padding:'7px 0',borderTop:(enMora.length>0||proxCuota)?'1px solid var(--bg3)':'none'}},
                  h('div',null,
                    h('div',{style:{fontSize:12,color:'var(--yellow)',fontWeight:500,display:'flex',alignItems:'center',gap:5}},
                      h(Ico,{name:'dollar',size:11,color:'var(--yellow)',sw:2.4}),
                      'Liquidacion total'),
                    h('div',{style:{fontSize:10,color:'var(--text3)',marginTop:1}},'Capital'+(intMoraTotal>0?' + intereses en mora':'')+(partialPend>0?' - parciales':''))),
                  h('div',{style:{textAlign:'right'}},
                    h('div',{className:'mono',style:{fontSize:13,color:'var(--yellow)',fontWeight:500}},fmt(liquidacion)),
                    esUSD&&h('div',{className:'mono',style:{fontSize:10,color:'var(--blue)'}},copToUsd(liquidacion,l.trmAcordada))))),
              // \u2500\u2500 GRUPO 5: COMPRAS USD (colapsable, solo USD con lotes) \u2500\u2500
              lotes&&h('div',{style:grupoStyle},
                h('button',{onClick:function(e){e.stopPropagation();setComprasExp(comprasExp===l.id?null:l.id);},style:{width:'100%',background:'transparent',border:'none',cursor:'pointer',padding:'2px 0',display:'flex',justifyContent:'space-between',alignItems:'center',color:'var(--blue)',fontSize:11,fontWeight:600,letterSpacing:.5,fontFamily:'inherit'}},
                  h('span',null,'COMPRAS USD ('+lotes.length+' lote'+(lotes.length>1?'s':'')+' \u00B7 TRM prom $'+fmtN(lotesTRMProm)+')'),
                  h('span',{style:{fontSize:10,color:'var(--text3)',fontWeight:400}},comprasExp===l.id?'Ocultar \u25B2':'Ver detalle \u25BC')),
                comprasExp===l.id&&h('div',{style:{marginTop:8}},
                  lotes.map(function(c,i){
                    return h('div',{key:i,style:{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'5px 0',fontSize:11,borderTop:'1px solid var(--bg3)'}},
                      h('span',{style:{color:'var(--text2)'}},'Compra '+(i+1)+': '+fmtN(+c.monto)+' USD'),
                      h('span',{className:'mono',style:{color:'var(--text3)',fontWeight:300}},'@ '+fmt(+c.tasa)));
                  }),
                  h('div',{style:{display:'flex',justifyContent:'space-between',padding:'7px 0 2px',fontSize:11,borderTop:'1px solid var(--bg3)',marginTop:2}},
                    h('span',{style:{color:'var(--text3)'}},'Total invertido en COP'),
                    h('span',{className:'mono',style:{color:'var(--text)',fontWeight:500}},fmt(lotesCOP))))),
              // \u2500\u2500 GRUPO 5b: PROYECCION DE GANANCIAS \u2500\u2500
              l.modalidad!=='Prestamo'&&h('div',{style:grupoStyle},
                h('div',{style:{fontSize:10,color:'var(--text3)',fontWeight:600,letterSpacing:.5,marginBottom:2}},'PROYECCION DE GANANCIAS'),
                (function(){
                  if(l.modalidad==='Intereses'){
                    var rentaMensual=Math.round(saldo*(+l.tasaMensual||0)/100);
                    return [
                      row('Cobrado hasta hoy',
                        h('div',null,
                          h('div',{className:'mono',style:{fontSize:13,color:'var(--green)',fontWeight:500}},'+'+fmt(intCobrados)),
                          esUSD&&intCobrados>0&&h('div',{className:'mono',style:{fontSize:10,color:'var(--blue)'}},copToUsd(intCobrados,l.trmAcordada))),
                        'Ganancia acumulada por intereses',{first:true,key:'proy-cob'}),
                      row('Renta mensual',
                        h('div',null,
                          h('div',{className:'mono',style:{fontSize:13,color:'var(--text)',fontWeight:500}},'+'+fmt(rentaMensual)),
                          esUSD&&rentaMensual>0&&h('div',{className:'mono',style:{fontSize:10,color:'var(--blue)'}},copToUsd(rentaMensual,l.trmAcordada))),
                        'Saldo '+fmt(saldo)+' x '+l.tasaMensual+'%',{key:'proy-renta'})
                    ];
                  }
                  var gananciaEsperada=l.modalidad==='Pago Unico'?(+l.gananciaFija||0):regulares.reduce(function(s,p){return s+p.interesPeriodo;},0);
                  var pctProy=gananciaEsperada>0?Math.min(100,Math.round(intCobrados/gananciaEsperada*100)):0;
                  return [
                    h('div',{key:'proy-bar',style:{padding:'8px 0 4px'}},
                      h('div',{style:{display:'flex',justifyContent:'space-between',fontSize:11,marginBottom:4}},
                        h('span',{style:{color:'var(--green)',fontWeight:600}},pctProy+'% cobrado'),
                        h('span',{className:'mono',style:{color:'var(--text3)',fontWeight:400}},fmt(intCobrados)+' / '+fmt(gananciaEsperada))),
                      h('div',{style:{height:6,borderRadius:3,background:'var(--bg4)',overflow:'hidden'}},
                        h('div',{style:{height:'100%',borderRadius:3,background:'var(--green2)',width:pctProy+'%',transition:'width .3s'}}))),
                    row('Ganancia esperada',
                      h('div',null,
                        h('div',{className:'mono',style:{fontSize:13,color:'var(--text)',fontWeight:500}},fmt(gananciaEsperada)),
                        esUSD&&gananciaEsperada>0&&h('div',{className:'mono',style:{fontSize:10,color:'var(--blue)'}},copToUsd(gananciaEsperada,l.trmAcordada))),
                      'Total de intereses del cronograma',{key:'proy-esp'}),
                    row('Cobrado',
                      h('div',null,
                        h('div',{className:'mono',style:{fontSize:13,color:'var(--green)',fontWeight:500}},'+'+fmt(intCobrados)),
                        esUSD&&intCobrados>0&&h('div',{className:'mono',style:{fontSize:10,color:'var(--blue)'}},copToUsd(intCobrados,l.trmAcordada))),
                      null,{key:'proy-cob'}),
                    gananciaEsperada>intCobrados&&row('Pendiente por cobrar',
                      h('div',null,
                        h('div',{className:'mono',style:{fontSize:13,color:'var(--yellow)',fontWeight:500}},fmt(gananciaEsperada-intCobrados)),
                        esUSD&&h('div',{className:'mono',style:{fontSize:10,color:'var(--blue)'}},copToUsd(gananciaEsperada-intCobrados,l.trmAcordada))),
                      null,{key:'proy-pend'})
                  ];
                })()),
              // \u2500\u2500 GRUPO 6: ACCIONES (botones) \u2500\u2500
              h('div',{style:grupoStyle},
            (function(){
              var isActive=l.estado==='Activo'&&saldo>0;
              var canAbonar=isActive&&onAbono;
              var canReestructurar=isActive&&l.modalidad==='Capital + Intereses'&&onReestructurar;
              // v1.10.0: Pago Unico no tiene dia de pago periodico — excluir igual que Prestamo
              var canCambiarFecha=isActive&&l.modalidad!=='Prestamo'&&l.modalidad!=='Pago Unico';
              var imora=enMora.reduce(function(s,p){return s+p.interesPeriodo;},0); // usado por Cambiar fecha
              var labelStyle={fontSize:9,fontWeight:700,color:'var(--text3)',letterSpacing:1.2,textTransform:'uppercase',marginBottom:6};
              var btnBase={width:'100%',padding:'10px 12px',borderRadius:10,fontSize:13,fontWeight:700,cursor:'pointer',display:'flex',alignItems:'center',justifyContent:'center',gap:8,fontFamily:'inherit',transition:'all .15s'};
              var btnPrimary=Object.assign({},btnBase,{background:'var(--green2)',border:'1px solid var(--green2)',color:'#fff'});
              var btnSecondary=Object.assign({},btnBase,{background:'var(--green-bg)',border:'1px solid var(--green-bd)',color:'var(--green)'});
              var btnNeutral=Object.assign({},btnBase,{background:'transparent',border:'1px solid var(--border)',color:'var(--text2)',fontWeight:600});
              var btnGhost={flex:1,padding:'9px 10px',borderRadius:8,fontSize:12,fontWeight:600,cursor:'pointer',display:'flex',alignItems:'center',justifyContent:'center',gap:6,fontFamily:'inherit',background:'transparent',border:'1px dashed var(--border)',color:'var(--text3)',transition:'all .15s'};
              var sects=[];
              // Tier 1: COBRAR
              if(canAbonar){
                sects.push(h('div',{key:'g1'},
                  h('div',{style:labelStyle},'Cobrar'),
                  h('button',{onClick:function(e){e.stopPropagation();onAbono(l);},style:btnPrimary},
                    h(Ico,{name:'dollar',size:15,color:'#fff',sw:2.2}),'Registrar abono'),
                  h('button',{onClick:function(e){e.stopPropagation();onRequestLiquidar(l);},style:Object.assign({},btnSecondary,{marginTop:6})},
                    h(Ico,{name:'check',size:15,color:'var(--green)',sw:2.4}),'Liquidar deuda')));
              }
              // Tier 2: AJUSTAR CRONOGRAMA
              if(canReestructurar||canCambiarFecha){
                var ajs=[h('div',{key:'lbl',style:labelStyle},'Ajustar cronograma')];
                if(canReestructurar) ajs.push(h('button',{key:'r',onClick:function(e){e.stopPropagation();onReestructurar(l);},style:btnNeutral},
                  h(Ico,{name:'calc',size:14,color:'var(--text2)',sw:2}),'Reestructurar cuotas'));
                if(canCambiarFecha) ajs.push(h('button',{key:'f',onClick:function(e){e.stopPropagation();var _pg=lp.filter(function(p){return p.id.indexOf('-ab-')===-1&&p.estadoPago==='Pagado';});var _pgf=_pg.map(function(p){return p.fechaPago;}).sort();setCambioFecha({loan:l,saldo:saldo,intMora:imora,moraCount:enMora.length,lastSettled:_pgf.length?_pgf[_pgf.length-1]:l.fechaInicio,regularConsumed:_pg.length,step:'form',nuevoDia:''});},style:Object.assign({},btnNeutral,{marginTop:canReestructurar?6:0})},
                  h(Ico,{name:'calendar',size:14,color:'var(--text2)',sw:2}),'Cambiar fecha de pago'));
                sects.push(h('div',{key:'g2',style:{marginTop:14}},ajs));
              }
              // Tier 3: CRONOGRAMA (Ver detalle + Descargar PDF pareados)
              var cronoExp=cronoLoan===l.id;
              sects.push(h('div',{key:'g3',style:{marginTop:14}},
                h('div',{style:labelStyle},'Cronograma'),
                h('div',{style:{display:'grid',gridTemplateColumns:l.estado==='Activo'?'1fr 1fr':'1fr',gap:6}},
                  h('button',{onClick:function(e){e.stopPropagation();setCronoLoan(cronoExp?null:l.id);},style:btnGhost},
                    h(Ico,{name:cronoExp?'x':'calendar',size:13,color:'var(--text3)'}),cronoExp?'Ocultar detalle':'Ver detalle'),
                  l.estado==='Activo'&&h('button',{onClick:function(e){e.stopPropagation();generateCronogramaPDF(l,lp,document.documentElement.getAttribute('data-theme')==='dark');},style:btnGhost},
                    h(Ico,{name:'download',size:13,color:'var(--text3)'}),'Descargar PDF'))));
              return sects;
            })(),
            cronoLoan===l.id&&function(){
              var cronoItems=regulares.filter(function(p){return l.modalidad!=='Intereses'||p.estadoPago!=='Pendiente';}).slice().sort(function(a,b){return a.cuotaN-b.cuotaN;});
              // Linea de tiempo unica: cuotas + abonos intercalados por fecha, con la MISMA regla
              // de orden que generateCronogramaPDF. Gemela de la de CarteraView.
              var timeline=cronoItems.concat(abonosList).sort(function(a,b){
                var c=String(a.fechaPago).localeCompare(String(b.fechaPago));
                return c!==0?c:a.cuotaN-b.cuotaN;
              });
              // La columna SALDO lee p.saldoFinal (saldo de CIERRE persistido por el backend),
              // unificada con el Recibo de Abono y el cronograma PDF. Sustituye a la antigua
              // "Deuda", que era un acumulador local del saldo de APERTURA (corrido un renglon
              // respecto del resto de documentos). Gemela de la tabla de CarteraView.
              var cronoCols='32px 1fr 1fr 1fr 1fr 1fr 60px';
              return h('div',{style:{marginTop:6,borderRadius:8,overflow:'hidden',border:'1px solid var(--border)'}},
                h('div',{style:{display:'grid',gridTemplateColumns:cronoCols,background:'var(--bg4)',padding:'6px 8px',fontSize:10,fontWeight:700,color:'var(--text3)',gap:4}},
                  h('span',null,'#'),
                  h('span',null,'Vence'),
                  h('span',{style:{textAlign:'right'}},'Interes'),
                  h('span',{style:{textAlign:'right'}},'Abono a capital'),
                  h('span',{style:{textAlign:'right'}},'Valor cuota'),
                  h('span',{style:{textAlign:'right'}},'Saldo'),
                  h('span',{style:{textAlign:'center'}},'Estado')),
                timeline.map(function(p,idx){
                  // Fila de ABONO intercalada; espejo de la del PDF y de la de CarteraView.
                  if(p.id.indexOf('-ab-')!==-1){
                    return h('div',{key:p.id,style:{display:'grid',gridTemplateColumns:cronoCols,padding:'5px 8px',fontSize:11,gap:4,borderTop:'1px solid var(--blue-bd)',background:'var(--blue-bg)'}},
                      h('span',{style:{color:'var(--blue)',fontWeight:600}},'-'),
                      h('span',{style:{color:'var(--blue)',fontStyle:'italic'}},fmtD(p.fechaPago),
                        p.observaciones&&h('div',{style:{fontSize:9,color:'var(--text3)',fontStyle:'italic'}},p.observaciones)),
                      h('span',{style:{textAlign:'right',color:'var(--text3)'}},'—'),
                      h('span',{className:'mono',style:{textAlign:'right',color:'var(--blue)',fontWeight:600}},fmt(p.abonoCapital),esUSD&&h('div',{style:{fontSize:9,color:'var(--blue)',fontWeight:400}},copToUsd(p.abonoCapital,l.trmAcordada))),
                      h('span',{className:'mono',style:{textAlign:'right',color:'var(--blue)',fontWeight:600}},fmt(p.cuotaTotal),esUSD&&h('div',{style:{fontSize:9,color:'var(--blue)',fontWeight:400}},copToUsd(p.cuotaTotal,l.trmAcordada))),
                      h('span',{className:'mono',style:{textAlign:'right',color:'var(--blue)',fontWeight:600}},fmt(p.saldoFinal),esUSD&&h('div',{style:{fontSize:9,color:'var(--blue)',fontWeight:400}},copToUsd(p.saldoFinal,l.trmAcordada))),
                      h('span',{style:{textAlign:'center'}},h('span',{style:{fontSize:9,padding:'2px 6px',borderRadius:99,background:'var(--blue-bd)',color:'var(--blue)',fontWeight:600}},'Abono')));
                  }
                  var stColor=p.estadoPago==='Pagado'?'var(--green)':p.estadoPago==='En Mora'?'var(--red)':'var(--yellow)';
                  var stBg=p.estadoPago==='Pagado'?'var(--green-bg)':p.estadoPago==='En Mora'?'var(--red-bg)':'var(--yellow-bg)';
                  var hasPartial=(p.partialPaid||0)>0&&p.estadoPago!=='Pagado';
                  // Capital reconciliado (= Valor cuota - Interes); ver nota en CarteraView.
                  var capRec=Math.max(0,p.cuotaTotal-p.interesPeriodo);
                  var _trm=l.trmAcordada||1;
                  var capRecUSD=esUSD?Math.max(0,(Math.round(p.cuotaTotal/_trm*100)-Math.round(p.interesPeriodo/_trm*100))/100):0;
                  return h('div',{key:p.id,style:{display:'grid',gridTemplateColumns:cronoCols,padding:'5px 8px',fontSize:11,gap:4,borderTop:'1px solid var(--border)',background:idx%2===0?'transparent':'var(--bg3)'}},
                    h('span',{style:{color:'var(--text3)',fontWeight:600}},p.cuotaN),
                    h('span',{style:{color:'var(--text2)'}},fmtD(p.fechaPago)),
                    h('span',{className:'mono',style:{textAlign:'right',color:'var(--text2)',fontWeight:500}},fmt(p.interesPeriodo),esUSD&&p.interesPeriodo>0&&h('div',{style:{fontSize:9,color:'var(--blue)',fontWeight:400}},copToUsd(p.interesPeriodo,l.trmAcordada))),
                    h('span',{className:'mono',style:{textAlign:'right',color:'var(--text2)',fontWeight:500}},fmt(capRec),esUSD&&capRec>0&&h('div',{style:{fontSize:9,color:'var(--blue)',fontWeight:400}},fmtUSD(capRecUSD))),
                    h('span',{className:'mono',style:{textAlign:'right',color:'var(--text)',fontWeight:600}},fmt(p.cuotaTotal),hasPartial&&h('div',{style:{fontSize:9,color:'var(--blue)',fontWeight:600}},'-'+fmt(p.partialPaid)),esUSD&&h('div',{style:{fontSize:9,color:'var(--blue)',fontWeight:400}},copToUsd(p.cuotaTotal,l.trmAcordada))),
                    h('span',{className:'mono',style:{textAlign:'right',color:'var(--text)',fontWeight:600}},fmt(p.saldoFinal),esUSD&&h('div',{style:{fontSize:9,color:'var(--blue)',fontWeight:400}},copToUsd(p.saldoFinal,l.trmAcordada))),
                    h('span',{style:{textAlign:'center'}},h('span',{style:{fontSize:9,padding:'2px 6px',borderRadius:99,background:stBg,color:stColor,fontWeight:600}},p.estadoPago==='Pagado'?'Pagado':p.estadoPago==='En Mora'?'Mora':hasPartial?'Parc.':'Pend.')));
                }));
              // El bloque "ABONOS A CAPITAL" que iba aqui se retiro: los abonos ya aparecen
              // intercalados en la linea de tiempo y repetirlos abajo los mostraba dos veces.
            }(),
            l.modalidad==='Intereses'?h('div',{style:{marginTop:8,display:'flex',alignItems:'center',gap:6}},
              h('span',{style:{fontSize:10,color:'var(--text3)'}},pagadas+' cuotas pagadas'),
              h('span',{style:{fontSize:10,color:'var(--blue)'}},'\u221E')):h('div',{style:{marginTop:8,height:5,background:'var(--bg4)',borderRadius:99,overflow:'hidden'}},
              h('div',{style:{height:'100%',width:pct+'%',background:enMora.length>0?'var(--red)':'var(--green)',borderRadius:99}}))))}());
      })),
    d.loans.filter(function(l){return l.estado==='Finalizado'||l.estado==='Cancelado';}).length>0&&h('div',{style:{marginTop:16}},
      h('div',{style:{display:'flex',alignItems:'center',gap:8,marginBottom:10}},
        h('div',{style:{flex:1,height:1,background:'var(--border)'}}),
        h('span',{style:{fontSize:10,fontWeight:600,color:'var(--text3)',letterSpacing:1}},'HISTORIAL DE CREDITOS'),
        h('div',{style:{flex:1,height:1,background:'var(--border)'}})),
      d.loans.filter(function(l){return l.estado==='Finalizado'||l.estado==='Cancelado';}).slice().sort(function(a,b){return b.fechaInicio.localeCompare(a.fechaInicio);}).map(function(l){
        var lPays=pays.filter(function(p){return p.prestamoId===l.id;});
        var regulares=lPays.filter(function(p){return p.id.indexOf('-ab-')===-1;});
        var abonos=lPays.filter(function(p){return p.id.indexOf('-ab-')!==-1&&p.estadoPago==='Pagado';});
        var totalCuotas=regulares.length;
        var cuotasPagadas=regulares.filter(function(p){return p.estadoPago==='Pagado';}).length;
        var intPagados=regulares.filter(function(p){return p.estadoPago==='Pagado';}).reduce(function(s,p){return s+p.interesPeriodo;},0);
        var capAbonos=abonos.reduce(function(s,p){return s+p.abonoCapital;},0);
        var ultPago=lPays.filter(function(p){return p.estadoPago==='Pagado';}).sort(function(a,b){return (b.fechaRecaudo||'').localeCompare(a.fechaRecaudo||'');});
        var fechaFin=ultPago.length>0?(ultPago[0].fechaRecaudo||ultPago[0].fechaPago):null;
        var esUSD=l.moneda==='USD';
        var isExp=expLoan===l.id;
        var esCancelado=l.estado==='Cancelado';
        var capPerd=Math.round(l.capitalPerdido||0);
        var intPerd=Math.round(l.interesesPerdidos||0);
        var totalPerdido=capPerd+intPerd;
        // Desglose USD: ganancia/perdida TRM y ganancia total real
        // Ganancia/Perdida TRM: cuotas regulares + abonos USD (ambos con registro de COP/USD recibido)
        var gananciaTRMRegHist=esUSD?regulares.filter(function(p){return p.estadoPago==='Pagado'&&p.montoCOPRecibido&&p.montoCOPRecibido>0;}).reduce(function(s,p){return s+(p.montoCOPRecibido-p.cuotaTotal);},0):0;
        var gananciaTRMAbHist=esUSD?lPays.filter(function(p){return p.id.indexOf('-ab-')!==-1&&p.estadoPago==='Pagado'&&p.montoUSDRecibido&&p.montoUSDRecibido>0;}).reduce(function(s,p){return s+(p.montoCOPRecibido-(p.montoUSDRecibido*l.trmAcordada));},0):0;
        var gananciaTRMHist=Math.round(gananciaTRMRegHist+gananciaTRMAbHist);
        var gananciaTotalHist=Math.round(intPagados+gananciaTRMHist);
        var bandaColor=esCancelado?'var(--red)':'var(--green)';
        // KPI del header: para USD usa ganancia total (incluye TRM); para COP solo intereses
        var kpiValor=esCancelado?totalPerdido:(esUSD?gananciaTotalHist:Math.round(intPagados));
        var kpiColor=esCancelado?'var(--red)':(esUSD&&gananciaTotalHist<0?'var(--red)':'var(--green)');
        var kpiLabel=esCancelado?'PERDIDA':((esUSD&&l.modalidad==='Prestamo')?'EFECTO TRM':'GANANCIA');
        var origCOP=esUSD?Math.round(l.montoOrigen*l.trmAcordada):Math.round(l.montoOrigen);
        // Calcular duración
        var duracion='';
        if(fechaFin){
          var fi=new Date(l.fechaInicio+'T12:00:00');var ff=new Date(fechaFin+'T12:00:00');
          var meses=Math.round((ff-fi)/(30.44*24*60*60*1000));
          duracion=meses>=12?Math.floor(meses/12)+' año'+(Math.floor(meses/12)>1?'s':'')+' '+(meses%12>0?(meses%12)+' mes'+(meses%12>1?'es':''):''):meses+' mes'+(meses>1?'es':'');
        }
        return h('div',{key:l.id,style:{background:'var(--bg3)',borderRadius:10,marginBottom:8,border:'1px solid '+(esCancelado?'var(--red-bd)':'var(--border)'),overflow:'hidden'}},
          h('div',{style:{height:4,background:bandaColor}}),
          h('div',{onClick:function(){setExpLoan(isExp?null:l.id);},style:{padding:'12px',cursor:'pointer',display:'flex',justifyContent:'space-between',alignItems:'flex-start',gap:10}},
            h('div',{style:{flex:1,minWidth:0}},
              h('div',{style:{display:'flex',alignItems:'center',gap:6,flexWrap:'wrap'}},
                h('span',{style:{fontSize:13,color:'var(--text)',fontWeight:600}},l.modalidad),
                esCancelado
                  ?h('span',{className:'tag',style:{background:'var(--red-bg)',color:'var(--red)',display:'inline-flex',alignItems:'center',gap:3}},h(Ico,{name:'x',size:10,color:'var(--red)',sw:2.4}),' Cancelado')
                  :h('span',{className:'tag',style:{background:'var(--green-bg)',color:'var(--green)',display:'inline-flex',alignItems:'center',gap:3}},h(Ico,{name:'check',size:10,color:'var(--green)'}),' Finalizado')),
              h('div',{className:'mono',style:{fontSize:14,color:'var(--text)',fontWeight:600,marginTop:4}},esUSD?'USD $'+fmtN(l.montoOrigen):fmt(origCOP),
                esUSD&&h('span',{style:{fontSize:10,color:'var(--text3)',fontWeight:400,marginLeft:6}},fmt(origCOP))),
              h('div',{style:{fontSize:11,color:'var(--text3)',marginTop:2}},fmtD(l.fechaInicio)+(fechaFin?' \u2192 '+fmtD(fechaFin):'')+' \u2022 '+(l.modalidad==='Intereses'?'\u221E':totalCuotas+' cuotas'))),
            h('div',{style:{textAlign:'right',flexShrink:0}},
              h('div',{className:'mono',style:{fontSize:16,fontWeight:700,color:kpiColor,whiteSpace:'nowrap'}},(esCancelado||kpiValor<0?'-':'+')+fmt(Math.abs(kpiValor))),
              h('div',{style:{fontSize:9,color:kpiColor,fontWeight:600,letterSpacing:.5}},kpiLabel))),
          isExp&&h('div',{style:{borderTop:'1px solid var(--border)',padding:'12px',background:'var(--bg)'}},
            h('div',{style:{display:'grid',gridTemplateColumns:'1fr 1fr',gap:'10px 12px',marginBottom:10}},
              h('div',null,
                h('div',{style:{fontSize:9,color:'var(--text3)',fontWeight:600,letterSpacing:.5}},'CAPITAL PRESTADO'),
                h('div',{className:'mono',style:{fontSize:13,fontWeight:500,color:'var(--text)'}},esUSD?'USD $'+fmtN(l.montoOrigen):fmt(origCOP)),
                esUSD&&h('div',{className:'mono',style:{fontSize:10,color:'var(--text3)'}},fmt(origCOP)+' (TRM $'+fmtN(l.trmAcordada)+')')),
              h('div',null,
                h('div',{style:{fontSize:9,color:'var(--text3)',fontWeight:600,letterSpacing:.5}},esUSD?'GANANCIA INTERES':'GANANCIA OBTENIDA'),
                h('div',{className:'mono',style:{fontSize:13,fontWeight:500,color:'var(--green)'}},fmt(intPagados)),
                esUSD&&h('div',{className:'mono',style:{fontSize:10,color:'var(--blue)'}},copToUsd(intPagados,l.trmAcordada))),
              esCancelado&&h('div',null,
                h('div',{style:{fontSize:9,color:'var(--text3)',fontWeight:600,letterSpacing:.5}},'CAPITAL DEBIENDO'),
                h('div',{className:'mono',style:{fontSize:13,fontWeight:500,color:'var(--red)'}},fmt(capPerd)),
                esUSD&&capPerd>0&&h('div',{className:'mono',style:{fontSize:10,color:'var(--blue)'}},copToUsd(capPerd,l.trmAcordada))),
              esCancelado&&h('div',null,
                h('div',{style:{fontSize:9,color:'var(--text3)',fontWeight:600,letterSpacing:.5}},'INTERESES DEBIENDO'),
                h('div',{className:'mono',style:{fontSize:13,fontWeight:500,color:'var(--red)'}},fmt(intPerd)),
                esUSD&&intPerd>0&&h('div',{className:'mono',style:{fontSize:10,color:'var(--blue)'}},copToUsd(intPerd,l.trmAcordada))),
              h('div',null,
                h('div',{style:{fontSize:9,color:'var(--text3)',fontWeight:600,letterSpacing:.5}},'CUOTAS PAGADAS'),
                h('div',{style:{fontSize:13,fontWeight:500,color:'var(--text)'}},cuotasPagadas+(l.modalidad==='Intereses'?'':'/'+totalCuotas))),
              h('div',null,
                h('div',{style:{fontSize:9,color:'var(--text3)',fontWeight:600,letterSpacing:.5}},'TASA'),
                h('div',{style:{fontSize:13,fontWeight:500,color:'var(--text2)'}},l.tasaMensual>0?l.tasaMensual+'% mensual':'Sin interes')),
              h('div',null,
                h('div',{style:{fontSize:9,color:'var(--text3)',fontWeight:600,letterSpacing:.5}},'DURACION'),
                h('div',{style:{fontSize:13,fontWeight:500,color:'var(--text2)'}},duracion||'N/A')),
              h('div',null,
                h('div',{style:{fontSize:9,color:'var(--text3)',fontWeight:600,letterSpacing:.5}},esCancelado?'FECHA DE CIERRE':'ULTIMO PAGO'),
                h('div',{style:{fontSize:13,fontWeight:500,color:'var(--text2)'}},fechaFin?fmtD(fechaFin):'N/A'))),
            esUSD&&(intPagados>0||gananciaTRMHist!==0)&&(function(){
              var regsPagH=regulares.filter(function(p){return p.estadoPago==='Pagado';});
              var capRecH=esCancelado?Math.max(0,origCOP-capPerd):origCOP;
              var totRecCOP=capRecH+Math.round(intPagados)+gananciaTRMHist;
              var trm=l.trmAcordada;
              // Efecto TRM en USD = residual (~0): los dolares llegan completos, la perdida es de pesos.
              var efectoTRMUSD=trm>0?(regsPagH.filter(function(p){return p.montoUSDRecibido&&p.montoUSDRecibido>0;}).reduce(function(s,p){return s+(p.montoUSDRecibido-p.cuotaTotal/trm);},0)+abonos.filter(function(p){return p.montoUSDRecibido&&p.montoUSDRecibido>0;}).reduce(function(s,p){return s+(p.montoUSDRecibido-p.abonoCapital/trm);},0)):0;
              var capUSD=trm>0?capRecH/trm:0;
              var intUSD=trm>0?intPagados/trm:0;
              var totRecUSD=capUSD+intUSD+efectoTRMUSD; // = USD realmente recibido
              var ganTotUSD=intUSD+efectoTRMUSD;
              var esPrestamo=l.modalidad==='Prestamo';
              function drow(label,value,valColor,subUSD,opts){
                opts=opts||{};
                return h('div',{style:{display:'flex',justifyContent:'space-between',alignItems:opts.note?'flex-start':'center',padding:opts.master?'2px 0 7px':'5px 0',borderTop:opts.topBorder===false?'none':(opts.accentTop?'1px solid var(--blue-bd)':'1px solid rgba(88,166,255,.12)'),marginTop:opts.accentTop?3:0}},
                  h('div',null,
                    h('div',{style:{fontSize:11,color:opts.master?'var(--text)':opts.accentTop?'var(--blue)':'var(--text2)',fontWeight:opts.master?700:opts.accentTop?600:400,letterSpacing:opts.master||opts.accentTop?.3:0}},label),
                    opts.note&&h('div',{style:{fontSize:9,color:'var(--text3)',marginTop:1}},opts.note)),
                  h('div',{style:{textAlign:'right'}},
                    h('span',{className:'mono',style:{fontSize:opts.master?14:(opts.accentTop?13:11),color:valColor||'var(--text)',fontWeight:(opts.master||opts.accentTop)?600:300}},value),
                    subUSD&&h('div',{className:'mono',style:{fontSize:9,color:'var(--blue)',fontWeight:400}},subUSD)));
              }
              return h('div',{style:{marginBottom:capAbonos>0||esCancelado?10:0,padding:'10px 12px',background:'rgba(88,166,255,.04)',borderRadius:8,border:'1px solid var(--blue-bd)'}},
                h('div',{style:{fontSize:10,color:'var(--blue)',fontWeight:600,letterSpacing:.5,marginBottom:6,display:'flex',alignItems:'center',gap:5}},
                  h(Ico,{name:'dollar',size:11,color:'var(--blue)'}),' DESGLOSE DE CAJA (USD)'),
                drow('TOTAL RECIBIDO',fmt(totRecCOP),'var(--text)',fmtUSD(totRecUSD),{master:true,topBorder:false}),
                drow(esCancelado?'Capital recuperado':'Capital prestado',fmt(capRecH),'var(--text2)',copToUsd(capRecH,trm)),
                drow('Intereses cobrados',(intPagados>0?'+':'')+fmt(intPagados),intPagados>0?'var(--green)':'var(--text2)',intPagados>0?copToUsd(intPagados,trm):null),
                drow('Efecto TRM',(gananciaTRMHist>0?'+':gananciaTRMHist<0?'-':'')+fmt(Math.abs(gananciaTRMHist)),gananciaTRMHist>0?'var(--green)':gananciaTRMHist<0?'var(--red)':'var(--text3)',null,{note:gananciaTRMHist===0?'Sin datos de TRM al cobro':gananciaTRMHist>0?'TRM subio al cobrar':'TRM bajo al cobrar'}),
                drow(esPrestamo?'RESULTADO TOTAL':'GANANCIA TOTAL',(gananciaTotalHist<0?'-':'+')+fmt(Math.abs(gananciaTotalHist)),gananciaTotalHist>=0?'var(--green)':'var(--red)',(ganTotUSD<0?'-':'+')+fmtUSD(Math.abs(ganTotUSD)),{accentTop:true}));
            })(),
            esCancelado&&h('div',{style:{padding:'10px 12px',background:'var(--bg3)',borderRadius:8,borderLeft:'3px solid var(--red)',marginBottom:capAbonos>0?8:0,display:'flex',justifyContent:'space-between',alignItems:'center'}},
              h('div',null,
                h('div',{style:{fontSize:10,color:'var(--text2)',fontWeight:600,letterSpacing:.5}},'MONTO TOTAL PERDIDO'),
                h('div',{style:{fontSize:10,color:'var(--text3)',marginTop:2}},'Capital + intereses en mora')),
              h('div',{className:'mono',style:{fontSize:16,fontWeight:700,color:'var(--red)'}},'-'+fmt(totalPerdido))),
            capAbonos>0&&h('div',{style:{padding:'8px 10px',background:'rgba(88,166,255,.06)',borderRadius:8,border:'1px solid var(--blue-bd)',display:'flex',justifyContent:'space-between',alignItems:'center'}},
              h('div',{style:{fontSize:10,color:'var(--blue)',fontWeight:600,letterSpacing:.5}},'ABONOS A CAPITAL REALIZADOS'),
              h('div',{className:'mono',style:{fontSize:13,fontWeight:600,color:'var(--blue)'}},fmt(capAbonos),
                esUSD&&h('span',{style:{fontSize:10,fontWeight:400,marginLeft:6}},copToUsd(capAbonos,l.trmAcordada)))),
            // v2.2.0 — flujo de caja real del credito ya cerrado
            h(FlujoCajaPanel,{loan:l,pays:pays}))
        );
      })));
}

// ── Pagos ─────────────────────────────────────────────────────────────────────
function PagosView(props){
  var pays=props.pays,allPays=props.allPays||[],loans=props.loans||[],searchQ=props.searchQ,setSearchQ=props.setSearchQ;
  var fMonth=props.fMonth,setFMonth=props.setFMonth,onSelect=props.onSelect,onQuickPay=props.onQuickPay,onNameClick=props.onNameClick,datosPago=props.datosPago;
  var tabSt=useState('pendientes'); var pagosTab=tabSt[0]; var setPagosTab=tabSt[1];
  var today=new Date(nowStr()+'T12:00:00');
  function diasMora(fp){var d=new Date(fp+'T12:00:00');return Math.max(0,Math.floor((today-d)/86400000));}
  // Mapa rápido de préstamo por id para lookup de moneda/trm
  var loanMap={};loans.forEach(function(l){loanMap[l.id]=l;});
  var todayStr=nowStr();
  var moraPays=pays.filter(function(p){return p.estadoPago==='En Mora';});
  var hoyPays=pays.filter(function(p){return p.estadoPago==='Pendiente'&&p.fechaPago===todayStr;});
  // Próximas a vencer: pendientes dentro de 3 días (sin incluir hoy)
  var tres=new Date(today); tres.setDate(tres.getDate()+3);
  var tresStr=tres.toISOString().split('T')[0];
  var prontoPays=pays.filter(function(p){return p.estadoPago==='Pendiente'&&p.fechaPago>todayStr&&p.fechaPago<=tresStr;});
  var pendPays=pays.filter(function(p){return p.estadoPago==='Pendiente'&&p.fechaPago>tresStr;});
  var totalPronto=prontoPays.reduce(function(s,p){return s+pendCuota(p);},0);
  var totalMora=moraPays.reduce(function(s,p){return s+pendCuota(p);},0);
  var totalHoy=hoyPays.reduce(function(s,p){return s+pendCuota(p);},0);
  // Pagos cobrados del mes actual (o mes seleccionado)
  var mesFilter=fMonth||nowStr().slice(0,7);
  var cobrados=allPays.filter(function(p){
    if(p.estadoPago!=='Pagado') return false;
    if(p.id.indexOf('-ab-')!==-1) return false;
    var fRef=p.fechaRecaudo||p.fechaPago;
    if(fRef.indexOf(mesFilter)!==0) return false;
    if(searchQ&&!payMatchesQuery(p,searchQ)) return false;
    return true;
  }).sort(function(a,b){return (b.fechaRecaudo||b.fechaPago).localeCompare(a.fechaRecaudo||a.fechaPago);});
  var totalCobrado=cobrados.reduce(function(s,p){return s+(p.montoCOPRecibido||p.cuotaTotal);},0);

  function renderRow(p,type){
    var isMora=type==='mora';
    var isHoy=type==='hoy';
    var isPronto=type==='pronto';
    var dm=isMora?diasMora(p.fechaPago):0;
    var pl=loanMap[p.prestamoId];
    var esUSD=pl&&pl.moneda==='USD';
    var trm=pl?pl.trmAcordada:0;
    var yaPag=+p.partialPaid||0;
    var hasPartial=yaPag>0;
    var restante=Math.max(0,p.cuotaTotal-yaPag);
    var borderColor=hasPartial?'var(--blue)':isMora?'var(--red-bd)':isHoy||isPronto?'var(--yellow)':'var(--border)';
    var valColor=hasPartial?'var(--blue)':isMora?'var(--red)':isHoy||isPronto?'var(--yellow)':'var(--text)';
    return h('div',{key:p.id,style:{background:hasPartial?'rgba(33,129,219,.06)':isHoy?'rgba(187,128,9,.06)':'var(--bg2)',border:'1px solid '+borderColor,borderRadius:12,padding:'11px 13px',transition:'background .1s'}},
      h('div',{style:{display:'flex',justifyContent:'space-between',alignItems:'center'}},
        h('div',{style:{flex:1,minWidth:0,cursor:'pointer'},onClick:function(){onSelect(p);}},
          h('div',{style:{display:'flex',alignItems:'center',gap:6}},
            h('span',{onClick:function(e){e.stopPropagation();onNameClick(p.nombreCliente);},style:{fontWeight:500,fontSize:14,color:'var(--text)',cursor:'pointer',textDecoration:'underline',textDecorationColor:'var(--bg4)',textUnderlineOffset:2}},p.nombreCliente),
            hasPartial&&h('span',{className:'tag',style:{background:'var(--blue-bg)',color:'var(--blue)',fontSize:10,padding:'2px 6px'}},'PARCIAL')),
          h('div',{style:{fontSize:12,color:isPronto?'var(--yellow)':'var(--text3)',marginTop:2}},'Cuota '+p.cuotaN+(isHoy?' - Vence HOY':isPronto?' - en '+Math.ceil((new Date(p.fechaPago+'T12:00:00')-today)/86400000)+' dia'+(Math.ceil((new Date(p.fechaPago+'T12:00:00')-today)/86400000)>1?'s':''):' - Vence '+fmtD(p.fechaPago))),
          isMora&&dm>0&&h('div',{style:{fontSize:12,color:'var(--red)',fontWeight:600,marginTop:2}},dm+' dia'+(dm>1?'s':'')+' de mora'),
          hasPartial&&h('div',{className:'mono',style:{fontSize:11,color:'var(--blue)',fontWeight:600,marginTop:2}},'Abonado '+fmt(yaPag)+' de '+fmt(p.cuotaTotal))),
        h('div',{style:{display:'flex',alignItems:'center',gap:8}},
          h('div',{style:{textAlign:'right'},onClick:function(){onSelect(p);},cursor:'pointer'},
            h('span',{className:'mono',style:{fontWeight:300,fontSize:14,color:valColor}},fmt(hasPartial?restante:p.cuotaTotal)),
            esUSD&&h('div',{className:'mono',style:{fontSize:11,color:'var(--blue)',fontWeight:400}},copToUsd(hasPartial?restante:p.cuotaTotal,trm))),
          h('button',{className:'quick-pay',onClick:function(e){e.stopPropagation();var ln=loanMap[p.prestamoId];if(ln)generateFacturaCobro(p,ln,allPays,datosPago);},style:{background:'var(--bg3)',color:'var(--text2)',border:'1px solid var(--border)'},title:'Recibo de cobro (PDF)'},h(Ico,{name:'receipt',size:14,color:'var(--text2)'})),
          h('button',{className:'quick-pay',onClick:function(e){e.stopPropagation();onQuickPay(p);},style:{background:'var(--green-bg)',color:'var(--green)',border:'1px solid var(--green-bd)'},title:'Pago rapido'},h(Ico,{name:'check',size:14,color:'var(--green)'})))));
  }

  return h('div',{className:'fade-in',style:{display:'flex',flexDirection:'column',height:'100%'}},
    h('div',{style:{background:'var(--bg2)',borderBottom:'1px solid var(--border)',padding:'12px 14px',flexShrink:0}},
      h('div',{style:{position:'relative',marginBottom:8}},
        h('div',{style:{position:'absolute',left:11,top:'50%',transform:'translateY(-50%)',display:'flex'}},h(Ico,{name:'search',size:14,color:'var(--text3)'})),
        h('input',{value:searchQ,onChange:function(e){setSearchQ(e.target.value);},placeholder:'Buscar cliente...',className:'inp',style:{paddingLeft:33}})),
      h('div',{style:{display:'flex',gap:8}},
        h('input',{type:'month',value:fMonth,onChange:function(e){setFMonth(e.target.value);},className:'inp',style:{flex:1}}),
        fMonth&&h('button',{onClick:function(){setFMonth('');},style:{background:'var(--bg3)',border:'1px solid var(--border)',borderRadius:10,padding:'0 12px',fontSize:11,color:'var(--text3)',cursor:'pointer'}},'Limpiar')),
      h('div',{style:{display:'flex',gap:6,marginTop:8,flexWrap:'wrap'}},
        moraPays.length>0&&h('span',{className:'tag',style:{background:'var(--red-bg)',color:'var(--red)'}},moraPays.length+' en mora'),
        hoyPays.length>0&&h('span',{className:'tag',style:{background:'var(--yellow-bg)',color:'var(--yellow)'}},hoyPays.length+' hoy'),
        prontoPays.length>0&&h('span',{className:'tag',style:{background:'var(--yellow-bg)',color:'var(--yellow)'}},prontoPays.length+' por vencer'),
        h('span',{className:'tag',style:{background:'var(--bg3)',color:'var(--text2)'}},pendPays.length+' proximas')),
      h('div',{style:{display:'flex',gap:0,marginTop:10,borderBottom:'2px solid var(--border)'}},
        h('button',{onClick:function(){setPagosTab('pendientes');},style:{flex:1,padding:'8px 0',background:'none',border:'none',borderBottom:pagosTab==='pendientes'?'2px solid var(--green)':'2px solid transparent',color:pagosTab==='pendientes'?'var(--green)':'var(--text3)',fontWeight:700,fontSize:13,cursor:'pointer',marginBottom:-2}},'Pendientes'),
        h('button',{onClick:function(){setPagosTab('cobrados');},style:{flex:1,padding:'8px 0',background:'none',border:'none',borderBottom:pagosTab==='cobrados'?'2px solid var(--green)':'2px solid transparent',color:pagosTab==='cobrados'?'var(--green)':'var(--text3)',fontWeight:700,fontSize:13,cursor:'pointer',marginBottom:-2}},'Cobrados'))),
    pagosTab==='pendientes'?h('div',{style:{flex:1,overflowY:'auto',padding:'12px 14px',display:'flex',flexDirection:'column',gap:12}},
      moraPays.length===0&&hoyPays.length===0&&prontoPays.length===0&&pendPays.length===0&&h('div',{style:{textAlign:'center',padding:'50px 0',color:'var(--text3)'}},
        h('div',{style:{marginBottom:10}},h(Ico,{name:'check',size:36,color:'var(--green)'})),
        h('p',{style:{fontWeight:600,fontSize:14}},'Todo al dia'),
        h('p',{style:{fontSize:12,marginTop:4}},'No hay cuotas pendientes de cobro')),
      hoyPays.length>0&&h('div',null,
        h('div',{style:{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:8}},
          h('div',{style:{display:'flex',alignItems:'center',gap:6}},
            h(Ico,{name:'calendar',size:14,color:'var(--yellow)'}),
            h('span',{style:{fontSize:13,fontWeight:600,color:'var(--yellow)'}},'VENCE HOY')),
          h('span',{className:'mono',style:{fontSize:15,fontWeight:600,color:'var(--yellow)'}},fmt(totalHoy))),
        h('div',{style:{display:'flex',flexDirection:'column',gap:8}},
          hoyPays.map(function(p){return renderRow(p,'hoy');}))),
      prontoPays.length>0&&h('div',null,
        h('div',{style:{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:8}},
          h('div',{style:{display:'flex',alignItems:'center',gap:6}},
            h(Ico,{name:'clock',size:14,color:'var(--yellow)'}),
            h('span',{style:{fontSize:13,fontWeight:600,color:'var(--yellow)'}},'PROXIMAS A VENCER')),
          h('span',{className:'mono',style:{fontSize:15,fontWeight:600,color:'var(--yellow)'}},fmt(totalPronto))),
        h('div',{style:{display:'flex',flexDirection:'column',gap:8}},
          prontoPays.map(function(p){return renderRow(p,'pronto');}))),
      moraPays.length>0&&h('div',null,
        h('div',{style:{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:8}},
          h('div',{style:{display:'flex',alignItems:'center',gap:6}},
            h(Ico,{name:'alert',size:14,color:'var(--red)'}),
            h('span',{style:{fontSize:13,fontWeight:600,color:'var(--red)'}},'EN MORA')),
          h('span',{className:'mono',style:{fontSize:15,fontWeight:600,color:'var(--red)'}},fmt(totalMora))),
        h('div',{style:{display:'flex',flexDirection:'column',gap:8}},
          moraPays.map(function(p){return renderRow(p,'mora');}))),
      pendPays.length>0&&h('div',null,
        h('div',{style:{display:'flex',alignItems:'center',gap:6,marginBottom:8}},
          h(Ico,{name:'clock',size:14,color:'var(--text3)'}),
          h('span',{style:{fontSize:13,fontWeight:600,color:'var(--text2)'}},'PROXIMAS A COBRAR')),
        h('div',{style:{display:'flex',flexDirection:'column',gap:8}},
          pendPays.map(function(p){return renderRow(p,'pend');}))))
    :h('div',{style:{flex:1,overflowY:'auto',padding:'12px 14px',display:'flex',flexDirection:'column',gap:6}},
      h('div',{style:{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:8}},
        h('span',{style:{fontSize:13,fontWeight:600,color:'var(--text2)'}},'Cobrados en '+(fMonth||nowStr().slice(0,7))),
        h('span',{className:'mono',style:{fontSize:15,fontWeight:600,color:'var(--green)'}},fmt(totalCobrado))),
      cobrados.length===0&&h('div',{style:{textAlign:'center',padding:'40px 0',color:'var(--text3)'}},
        h('p',{style:{fontSize:13}},'Sin pagos cobrados este mes')),
      cobrados.map(function(p){
        var pl=loanMap[p.prestamoId];var esUSD=pl&&pl.moneda==='USD';var trm=pl?pl.trmAcordada:0;
        return h('div',{key:p.id,onClick:function(){onSelect(p);},style:{background:'var(--bg2)',border:'1px solid var(--green-bd)',borderRadius:10,padding:'9px 12px',cursor:'pointer',display:'flex',justifyContent:'space-between',alignItems:'center'}},
          h('div',{style:{minWidth:0}},
            h('div',{style:{fontWeight:500,fontSize:13,color:'var(--text)'}},p.nombreCliente),
            h('div',{style:{fontSize:11,color:'var(--text3)',marginTop:1}},'Cuota '+p.cuotaN+' \u2022 '+fmtD(p.fechaRecaudo||p.fechaPago))),
          h('div',{style:{textAlign:'right'}},
            h('div',{className:'mono',style:{fontWeight:300,fontSize:14,color:'var(--green)'}},fmt(p.montoCOPRecibido||p.cuotaTotal)),
            esUSD&&h('div',{className:'mono',style:{fontSize:11,color:'var(--blue)'}},(+p.montoUSDRecibido>0?fmtUSD(p.montoUSDRecibido):copToUsd(p.montoCOPRecibido||p.cuotaTotal,trm)))));
      })));
}

// ── Rendimiento (Portfolio Performance) ───────────────────────────────────────
function PortfolioView(props){
  var loans=props.loans,pays=props.pays;
  var ft=useState('Activo'); var filtro=ft[0]; var setFiltro=ft[1];
  var loanMetrics=useMemo(function(){
    return loans.map(function(loan){
      var lp=pays.filter(function(p){return p.prestamoId===loan.id;});
      var paid=lp.filter(function(p){return p.estadoPago==='Pagado';});
      var esUSD=loan.moneda==='USD';
      // Identificar abonos reales (id contiene '-ab-')
      var esAbono=function(p){return p.id.indexOf('-ab-')!==-1;};
      // Regulares = cuotas normales del cronograma (no abonos)
      var regulares=lp.filter(function(p){return !esAbono(p);});
      var regularesPaid=paid.filter(function(p){return !esAbono(p);});
      var abonosPaid=paid.filter(function(p){return esAbono(p);});

      // ── GANANCIA REAL: COP recibido menos capital amortizado ──
      // Para COP: equivale a interesPeriodo (no hay TRM en juego).
      // Para USD: si el usuario registro montoCOPRecibido al cobrar, se usa eso
      // (incluye ganancia cambiaria por subida de TRM). Si no, fallback a interesPeriodo.
      var ganancia;
      if(esUSD){
        ganancia=regularesPaid.reduce(function(s,p){
          if(p.montoCOPRecibido&&p.montoCOPRecibido>0){
            // Capital robusto: cuotaTotal-interesPeriodo (en Prestamo abonoCapital=0,
            // de lo contrario el COP recibido se contaria entero como ganancia fantasma).
            return s+(p.montoCOPRecibido-(p.cuotaTotal-p.interesPeriodo));
          }
          return s+p.interesPeriodo;
        },0);
      } else {
        ganancia=paid.reduce(function(s,p){return s+p.interesPeriodo;},0);
      }

      // ── GANANCIA EN USD REAL (Bug #23 / v1.12.6): el USD efectivamente recibido como utilidad,
      // NO copToUsd(gananciaCOP) que reconvierte por TRM y recontaria la perdida/ganancia cambiaria.
      // Por cuota pagada: USD recibido - capital en USD (abonoCapital a TRM acordada).
      // Fallback (sin montoUSDRecibido): interes contractual en USD = interesPeriodo / trmAcordada.
      var gananciaUSD=esUSD?regularesPaid.reduce(function(s,p){
        var trm=loan.trmAcordada>0?loan.trmAcordada:1;
        // Capital en USD robusto para las 4 modalidades: cuotaTotal-interesPeriodo
        // (en Prestamo abonoCapital se guarda en 0, no sirve como base).
        var capUSD=(p.cuotaTotal-p.interesPeriodo)/trm;
        if(p.montoUSDRecibido&&p.montoUSDRecibido>0) return s+(p.montoUSDRecibido-capUSD);
        return s+(p.interesPeriodo/trm);
      },0):0;

      // ── CAPITAL RECUPERADO: via imputacion (Fase 3) ──────────────────────────
      // Incluye el capital que ya cubrio un pago parcial en curso, ademas del de las cuotas
      // saldadas y los abonos. Antes solo contaba cuotas con estadoPago==='Pagado'.
      var capRec=Math.round(lp.reduce(function(s,p){return s+imputarCobros(p).totales.capital;},0));
      // Se conservan para las filas INFORMATIVAS de la tarjeta ("Abonos a capital recibidos" y
      // "Abonos parciales recibidos"); ya NO participan del saldo, que sale del capital imputado.
      var capitalAbonos=abonosPaid.reduce(function(s,p){return s+p.abonoCapital;},0);
      var parcialesPend=regulares.filter(function(p){return p.estadoPago!=='Pagado';}).reduce(function(s,p){return s+(p.partialPaid||0);},0);

      // ── SALDO PENDIENTE: monto original - capital efectivamente recuperado ────
      // Antes restaba ADEMAS `parcialesPend` (el parcial COMPLETO), lo que rompia la identidad
      // documentada "Colocado = Recuperado + Saldo": el interes contenido en el parcial
      // desaparecia de los dos lados. Con el capital imputado la identidad se cumple exacta.
      var saldo;
      if(loan.estado!=='Activo'){
        saldo=0;
      } else {
        var origR=loan.moneda==='USD'?Math.round(loan.montoOrigen*loan.trmAcordada):Math.round(loan.montoOrigen);
        saldo=Math.max(0,origR-capRec);
      }

      // ── CUOTAS: solo regulares ──
      var cuotasPaid=regularesPaid.length;
      var cuotasTotal=regulares.length||1;

      // ── Progreso por MONTO (incluye abonos parciales) ──
      var totEspRec=regulares.reduce(function(s,p){return s+p.cuotaTotal;},0);
      var totCobRec=regulares.reduce(function(s,p){
        if(p.estadoPago==='Pagado') return s+p.cuotaTotal;
        return s+(p.partialPaid||0);
      },0);
      var pctMonto=totEspRec>0?Math.round(totCobRec/totEspRec*100):0;

      // ── MORA: tiene cuotas en mora? ──
      var enMora=lp.some(function(p){return p.estadoPago==='En Mora';});

      // ── FECHA DE FINALIZACION (derivada): ultimo pago registrado ──
      // No hay columna fechaFinalizado; se infiere del pago mas reciente:
      // paidAt (timestamp real v1.11.1) > fechaRecaudo > fechaPago; fallback fechaInicio.
      var fechaFin=paid.reduce(function(mx,p){var d=p.paidAt||p.fechaRecaudo||p.fechaPago||'';return d>mx?d:mx;},'')||loan.fechaInicio;

      return {loan:loan,ganancia:Math.round(ganancia),capRec:Math.round(capRec),saldo:saldo,
        cuotasPaid:cuotasPaid,cuotasTotal:cuotasTotal,enMora:enMora,capitalAbonos:Math.round(capitalAbonos),
        pctMonto:pctMonto,parcialesPend:Math.round(parcialesPend),fechaFin:fechaFin,gananciaUSD:gananciaUSD};
    }).sort(function(a,b){
      var aAct=a.loan.estado==='Activo',bAct=b.loan.estado==='Activo';
      if(aAct!==bAct) return aAct?-1:1;
      // Activos: por fecha de inicio desc. Finalizados/Cancelados: por fecha de finalizacion desc
      // (el ultimo finalizado arriba), con fechaInicio como desempate.
      if(aAct) return b.loan.fechaInicio.localeCompare(a.loan.fechaInicio);
      return b.fechaFin.localeCompare(a.fechaFin)||b.loan.fechaInicio.localeCompare(a.loan.fechaInicio);
    });
  },[loans,pays]);
  // Ganancia Obtenida: historica (incluye finalizados/cancelados — ya realizada).
  var totalGanancia=loanMetrics.reduce(function(s,m){return s+m.ganancia;},0);
  // Capital Colocado / Recuperado: SOLO prestamos Activos, para coincidir con el KPI
  // "Capital Original" del Dashboard (misma formula+filtro) y cumplir la identidad contable
  // Colocado = Recuperado + Saldo. Saldo ya esta acotado a activos (saldo=0 si no Activo).
  var activosR=loans.filter(function(l){return l.estado==='Activo';});
  var totalColocado=activosR.reduce(function(s,l){return s+(l.moneda==='USD'?Math.round(l.montoOrigen*l.trmAcordada):Math.round(l.montoOrigen));},0);
  var totalCapRec=loanMetrics.reduce(function(s,m){return m.loan.estado==='Activo'?s+m.capRec:s;},0);
  var totalSaldo=loanMetrics.reduce(function(s,m){return s+m.saldo;},0);

  function kpi(label,val,sub,color,bd){
    return h('div',{style:{background:'var(--bg2)',borderRadius:12,padding:'12px 14px',border:'1px solid '+bd}},
      h('div',{style:{fontSize:11,color:color,fontWeight:700,marginBottom:4}},label),
      h('div',{className:'mono',style:{fontWeight:700,fontSize:17,color:color}},val),
      h('div',{style:{fontSize:12,color:'var(--text3)',marginTop:3}},sub));
  }

  return h('div',{className:'fade-in',style:{padding:16}},
    h('div',{style:{fontWeight:700,fontSize:17,color:'var(--text)',marginBottom:2,display:'flex',alignItems:'center',gap:6}},h(Ico,{name:'trending',size:16,color:'var(--green)'}),' Rendimiento del Portafolio'),
    h('div',{style:{fontSize:13,color:'var(--text2)',marginBottom:14}},'Ganancias obtenidas y estado del capital'),
    h('div',{style:{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10,marginBottom:16}},
      kpi('GANANCIA OBTENIDA',fmt(totalGanancia),'Intereses cobrados','var(--green)','var(--green-bd)'),
      kpi('CAP. COLOCADO (ACTIVOS)',fmt(totalColocado),'Total invertido · solo activos','var(--blue)','var(--blue-bd)'),
      kpi('CAP. RECUPERADO (ACTIVOS)',fmt(totalCapRec),'Capital + abonos · solo activos','var(--blue)','var(--blue-bd)'),
      kpi('SALDO PENDIENTE',fmt(totalSaldo),'Capital expuesto','var(--yellow)','var(--border)')),
    h('div',{style:{display:'flex',gap:0,marginBottom:12,background:'var(--bg2)',borderRadius:10,border:'1px solid var(--border)',overflow:'hidden'}},
      [['Activo','Activo'],['Finalizados','Finalizados']].map(function(t){
        var val=t[0],label=t[1];
        var active=filtro===val;
        var cnt=loanMetrics.filter(function(m){return val==='Activo'?m.loan.estado==='Activo':(m.loan.estado==='Finalizado'||m.loan.estado==='Cancelado');}).length;
        return h('button',{key:val,onClick:function(){setFiltro(val);},style:{flex:1,padding:'9px 0',fontSize:13,fontWeight:700,cursor:'pointer',border:'none',
          background:active?'var(--green)':'transparent',color:active?'#fff':'var(--text3)',transition:'all .15s'}},
          label+' ('+cnt+')');
      })),
    loanMetrics.filter(function(m){return filtro==='Activo'?m.loan.estado==='Activo':(m.loan.estado==='Finalizado'||m.loan.estado==='Cancelado');}).length===0&&h('div',{style:{textAlign:'center',padding:'40px 0',color:'var(--text3)'}},
      h('div',{style:{marginBottom:10}},h(Ico,{name:filtro==='Activo'?'briefcase':'check',size:36,color:'var(--text3)'})),
      h('p',null,filtro==='Activo'?'Sin prestamos activos':'Sin prestamos finalizados')),
    h('div',{style:{display:'flex',flexDirection:'column',gap:10}},
      loanMetrics.filter(function(m){return filtro==='Activo'?m.loan.estado==='Activo':(m.loan.estado==='Finalizado'||m.loan.estado==='Cancelado');}).map(function(m){
        var l=m.loan;
        var esUSD=l.moneda==='USD';
        var pct=m.cuotasTotal>0?Math.round(m.cuotasPaid/m.cuotasTotal*100):0;
        var esCancelado=l.estado==='Cancelado';
        var stColor=l.estado==='Activo'?'var(--green)':esCancelado?'var(--red)':'var(--text3)';
        var stBg=l.estado==='Activo'?'var(--green-bg)':esCancelado?'var(--red-bg)':'var(--bg3)';
        // Color del saldo: naranja si hay mora, amarillo si activo, rojo si cancelado, gris si finalizado
        var saldoColor=esCancelado?'var(--red)':l.estado!=='Activo'?'var(--text3)':m.enMora?'var(--red)':'var(--yellow)';
        var perdidaTotal=esCancelado?Math.round((l.capitalPerdido||0)+(l.interesesPerdidos||0)):0;
        return h('div',{key:l.id,style:{background:'var(--bg2)',borderRadius:14,padding:'13px 14px',border:'1px solid '+(m.enMora&&l.estado==='Activo'?'var(--red-bd)':'var(--border)')}},
          h('div',{style:{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:6}},
            h('div',{style:{fontWeight:700,fontSize:14,color:'var(--text)'}},l.nombre),
            h('div',{style:{display:'flex',gap:5,alignItems:'center'}},
              m.enMora&&l.estado==='Activo'&&h('span',{style:{background:'var(--red-bg)',color:'var(--red)',fontSize:9,fontWeight:700,padding:'2px 7px',borderRadius:99}},'MORA'),
              h('span',{style:{background:stBg,color:stColor,fontSize:10,fontWeight:700,padding:'2px 9px',borderRadius:99}},l.estado))),
          h('div',{style:{display:'flex',gap:5,flexWrap:'wrap',fontSize:12,color:'var(--text3)',marginBottom:4}},
            h('span',null,fmtD(l.fechaInicio)),
            h('span',null,'\u2022'),
            h('span',null,l.modalidad),
            l.tasaMensual>0&&h('span',null,'\u2022'),
            l.tasaMensual>0&&h('span',null,l.tasaMensual+'% mensual')),
          h('div',{style:{fontSize:12,color:'var(--text3)',marginBottom:10}},
            'Capital: '+(esUSD?'USD $'+fmtN(l.montoOrigen)+' ('+fmt(Math.round(l.montoOrigen*l.trmAcordada))+')':fmt(Math.round(l.montoOrigen)))),
          h('div',{style:{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10,marginBottom:10}},
            h('div',null,
              h('div',{style:{fontSize:11,color:m.ganancia<0?'var(--red)':'var(--green)',fontWeight:600}},(esUSD&&l.modalidad==='Prestamo')?'Efecto TRM':'Ganancia obtenida'),
              h('div',{className:'mono',style:{fontSize:15,fontWeight:600,color:m.ganancia<0?'var(--red)':'var(--green)'}},fmt(m.ganancia)),
              esUSD&&h('div',{className:'mono',style:{fontSize:11,color:'var(--blue)'}},fmtUSD(m.gananciaUSD)),
              (esUSD&&l.modalidad==='Prestamo')&&h('div',{style:{fontSize:9,color:'var(--text3)',marginTop:1,fontStyle:'italic'}},m.ganancia<0?'Sin interes · TRM bajo al cobrar':m.ganancia>0?'Sin interes · TRM subio al cobrar':'Sin interes · sin variacion TRM')),
            h('div',null,
              h('div',{style:{fontSize:11,color:saldoColor,fontWeight:600}},esCancelado?'Perdida total':'Saldo pendiente'),
              h('div',{className:'mono',style:{fontSize:15,fontWeight:600,color:saldoColor}},l.estado==='Activo'?fmt(m.saldo):esCancelado?'-'+fmt(perdidaTotal):'Saldado'),
              esUSD&&l.estado==='Activo'&&h('div',{className:'mono',style:{fontSize:11,color:'var(--blue)'}},copToUsd(m.saldo,l.trmAcordada)),
              esCancelado&&(function(){
                var capP=Math.round(l.capitalPerdido||0),intP=Math.round(l.interesesPerdidos||0);
                if(capP>0&&intP>0) return h('div',{style:{marginTop:3,fontSize:9,lineHeight:1.6}},
                  h('div',{style:{color:'var(--text3)'}},'Capital ',h('span',{className:'mono',style:{color:'var(--red)'}},'-'+fmt(capP))),
                  h('div',{style:{color:'var(--text3)'}},'Intereses ',h('span',{className:'mono',style:{color:'var(--red)'}},'-'+fmt(intP))));
                if(capP>0) return h('div',{style:{marginTop:2,fontSize:9,color:'var(--text3)',fontStyle:'italic'}},'Solo capital no recuperado');
                if(intP>0) return h('div',{style:{marginTop:2,fontSize:9,color:'var(--text3)',fontStyle:'italic'}},'Solo intereses no cobrados');
                return null;
              })()),
            m.capitalAbonos>0&&h('div',{style:{gridColumn:'1/3',marginTop:2}},
              h('div',{style:{fontSize:11,color:'var(--blue)',fontWeight:600}},'Abonos a capital'),
              h('div',{className:'mono',style:{fontSize:14,fontWeight:500,color:'var(--blue)'}},fmt(m.capitalAbonos),
                esUSD&&h('span',{style:{fontSize:11,fontWeight:400,marginLeft:6}},copToUsd(m.capitalAbonos,l.trmAcordada)))),
            m.parcialesPend>0&&h('div',{style:{gridColumn:'1/3',marginTop:2}},
              h('div',{style:{fontSize:11,color:'var(--blue)',fontWeight:600}},'Abonos parciales recibidos'),
              h('div',{className:'mono',style:{fontSize:13,fontWeight:500,color:'var(--blue)'}},fmt(m.parcialesPend)),
              h('div',{style:{fontSize:10,color:'var(--text3)',marginTop:1,fontStyle:'italic'}},'Pendiente de completar cuota para reconocer ganancia'))),
          l.modalidad==='Intereses'?h('div',{style:{display:'flex',alignItems:'center',gap:6,fontSize:11,color:'var(--text3)'}},
            h('span',null,m.cuotasPaid+' cuotas pagadas'),
            h('span',{style:{color:'var(--blue)'}},'\u221E')):h('div',{style:{display:'flex',alignItems:'center',gap:8}},
            h('div',{style:{flex:1,height:6,background:'var(--bg3)',borderRadius:3,overflow:'hidden',position:'relative'}},
              h('div',{style:{width:m.pctMonto+'%',height:'100%',background:m.enMora&&l.estado==='Activo'?'var(--red)':'var(--green)',borderRadius:3,transition:'width .3s'}})),
            h('span',{style:{fontSize:11,color:'var(--text3)',whiteSpace:'nowrap'}},m.cuotasPaid+'/'+m.cuotasTotal+' ('+m.pctMonto+'%)')));
      })));
}

// ── Calculadora (Simulador) ───────────────────────────────────────────────
function CalcView(props){
  var onConfirm=props.onConfirm;
  var s1=useState(''); var monto=s1[0]; var setMonto=s1[1];
  var s2=useState('Intereses'); var modalidad=s2[0]; var setModalidad=s2[1];
  var s3=useState(''); var tasa=s3[0]; var setTasa=s3[1];
  var s4=useState(''); var plazo=s4[0]; var setPlazo=s4[1];
  var s5=useState(false); var showCrono=s5[0]; var setShowCrono=s5[1];
  var s6=useState('COP'); var moneda=s6[0]; var setMoneda=s6[1];
  var s7=useState(''); var trmCalc=s7[0]; var setTrmCalc=s7[1];
  var s8=useState('Mensual'); var frecCalc=s8[0]; var setFrecCalc=s8[1];

  var montoCOP=moneda==='USD'?Math.round((+monto||0)*(+trmCalc||1)):(+monto||0);

  var sim=useMemo(function(){
    var pv=moneda==='USD'?Math.round((+monto||0)*(+trmCalc||1)):(+monto||0);
    var rMensual=(+tasa||0)/100;
    var r=frecCalc==='Semanal'?rMensual/4.33:frecCalc==='Quincenal'?rMensual/2:rMensual;
    var n=+plazo||12;
    if(!pv||!r) return null;
    var cuota,intP,capP;
    if(modalidad==='Intereses'){
      intP=Math.round(pv*r); capP=0; cuota=intP;
    } else {
      cuota=Math.round(pmt(r,n,pv));
      intP=Math.round(pv*r); capP=cuota-intP;
    }
    var rows=[]; var saldo=pv;
    var nCuotas=modalidad==='Intereses'?Math.min(n||12,24):n;
    for(var i=0;i<nCuotas;i++){
      var intI=Math.round(saldo*r);
      var isLast=i===nCuotas-1;
      var capI,cuotaI;
      if(modalidad==='Intereses'){
        capI=0; cuotaI=intI;
      } else {
        capI=isLast?Math.round(saldo):Math.round(cuota-intI);
        cuotaI=isLast?Math.round(intI+saldo):cuota;
      }
      var sf=Math.max(0,Math.round(saldo-capI));
      rows.push({n:i+1,interes:intI,capital:capI,cuota:cuotaI,saldo:sf});
      saldo=sf;
    }
    var totalInt=rows.reduce(function(s,r){return s+r.interes;},0);
    var totalPagar=rows.reduce(function(s,r){return s+r.cuota;},0);
    return {cuota:cuota,intP:intP,capP:capP,rows:rows,totalInt:totalInt,totalPagar:totalPagar,montoCOP:pv};
  },[monto,modalidad,tasa,plazo,moneda,trmCalc,frecCalc]);

  function limpiar(){setMonto('');setModalidad('Intereses');setTasa('');setPlazo('');setShowCrono(false);setMoneda('COP');setTrmCalc('');setFrecCalc('Mensual');}

  function confirmar(){
    if(!sim){showError('Ingresa datos validos para simular');return;}
    var data={montoOrigen:+monto,modalidad:modalidad,tasaMensual:+tasa,plazoMeses:+plazo||12,frecuencia:frecCalc};
    if(moneda==='USD'){data.moneda='USD';data.trmAcordada=+trmCalc||1;}
    onConfirm(data);
  }

  return h('div',{className:'fade-in',style:{padding:16}},
    h('div',{style:{fontWeight:700,fontSize:17,color:'var(--text)',marginBottom:2,display:'flex',alignItems:'center',gap:6}},h(Ico,{name:'calc',size:16,color:'var(--green)'}),' Calculadora de Prestamos'),
    h('div',{style:{fontSize:13,color:'var(--text2)',marginBottom:14}},'Simula antes de registrar oficialmente'),
    h(Fld,{label:'Moneda'},h('select',{value:moneda,onChange:function(e){setMoneda(e.target.value);},className:'inp'},
      h('option',{value:'COP'},'COP - Pesos'),h('option',{value:'USD'},'USD - Dolares'))),
    moneda==='USD'&&h(Fld,{label:'TRM acordada *'},
      h('input',{type:'text',inputMode:'numeric',value:fmtNumInput(trmCalc),onChange:function(e){setTrmCalc(parseNum(e.target.value));},placeholder:'Ej: 4.200',className:'inp'})),
    h(Fld,{label:'Valor del prestamo ('+(moneda)+') *'},
      h('input',{type:'text',inputMode:'numeric',value:fmtNumInput(monto),onChange:function(e){setMonto(parseNum(e.target.value));},placeholder:moneda==='USD'?'Ej: 1.000':'Ej: 5.000.000',className:'inp'})),
    moneda==='USD'&&monto&&trmCalc&&h('div',{style:{fontSize:12,color:'var(--blue)',marginTop:2,marginBottom:14,paddingLeft:4}},'Equivalente COP: '+fmt(montoCOP)),
    h(Fld,{label:h('span',{style:{display:'flex',alignItems:'center',gap:6}},'Modalidad',
      h('span',{style:{position:'relative',display:'inline-flex'},className:'tooltip-wrap'},
        h('span',{style:{display:'inline-flex',alignItems:'center',justifyContent:'center',width:16,height:16,borderRadius:'50%',border:'1.5px solid var(--text3)',fontSize:10,fontWeight:700,color:'var(--text3)',cursor:'help',lineHeight:1}},'i'),
        h('span',{className:'tooltip-box'},
          h('b',null,'Intereses:'),' Solo paga intereses mensuales. El capital se devuelve al final. Plazo indefinido.',h('br',null),h('br',null),
          h('b',null,'Capital + Intereses:'),' Cuota fija mensual (amortizacion francesa). Cada cuota incluye intereses + parte del capital. Plazo fijo.',h('br',null),h('br',null),
          h('span',{style:{color:'var(--text3)',fontStyle:'italic'}},'En todas las modalidades se pueden hacer abonos a capital para reducir el saldo.'))))},
      h('select',{value:modalidad,onChange:function(e){setModalidad(e.target.value);},className:'inp'},
      h('option',null,'Intereses'),h('option',null,'Capital + Intereses'))),
    h(Fld,{label:'Frecuencia de cobro'},h('select',{value:frecCalc,onChange:function(e){setFrecCalc(e.target.value);},className:'inp'},
      h('option',null,'Semanal'),h('option',null,'Quincenal'),h('option',null,'Mensual'))),
    h('div',{style:{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10}},
      h(Fld,{label:'Tasa mensual (%) *'},h('input',{type:'number',step:'0.01',value:tasa,onChange:function(e){setTasa(e.target.value);},placeholder:'Ej: 2',className:'inp'})),
      h(Fld,{label:modalidad==='Intereses'?'Simular cuotas (\u221E)':(frecCalc==='Semanal'?'Plazo (semanas)':frecCalc==='Quincenal'?'Plazo (quincenas)':'Plazo (meses)')},h('input',{type:'number',value:plazo,onChange:function(e){setPlazo(e.target.value);},placeholder:modalidad==='Intereses'?'12 (simulacion)':'12',className:'inp'}))),
    sim&&h('div',{style:{background:'var(--green-bg)',border:'1px solid var(--green-bd)',borderRadius:14,padding:'14px',marginTop:14}},
      h('div',{style:{fontSize:11,color:'var(--green)',fontWeight:700,marginBottom:10}},'RESUMEN DE SIMULACION'),
      moneda==='USD'&&h('div',{style:{fontSize:11,color:'var(--blue)',marginBottom:10,padding:'6px 10px',background:'rgba(56,139,253,.08)',borderRadius:8,border:'1px solid rgba(56,139,253,.2)'}},
        'USD $'+fmtN(+monto||0)+' x TRM $'+fmtN(+trmCalc||0)+' = COP '+fmt(sim.montoCOP)),
      h('div',{style:{display:'grid',gridTemplateColumns:'1fr 1fr 1fr',gap:8}},
        h('div',{style:{textAlign:'center'}},
          h('div',{style:{fontSize:10,color:'var(--text3)',marginBottom:3}},modalidad==='Intereses'?'Cuota mensual':'Cuota total'),
          h('div',{className:'mono',style:{fontSize:14,fontWeight:700,color:'var(--green)'}},fmt(sim.cuota)),
          moneda==='USD'&&h('div',{className:'mono',style:{fontSize:10,color:'var(--blue)'}},copToUsd(sim.cuota,+trmCalc))),
        h('div',{style:{textAlign:'center'}},
          h('div',{style:{fontSize:10,color:'var(--text3)',marginBottom:3}},'Intereses 1er mes'),
          h('div',{className:'mono',style:{fontSize:14,fontWeight:700,color:'var(--yellow)'}},fmt(sim.intP)),
          moneda==='USD'&&h('div',{className:'mono',style:{fontSize:10,color:'var(--blue)'}},copToUsd(sim.intP,+trmCalc))),
        h('div',{style:{textAlign:'center'}},
          h('div',{style:{fontSize:10,color:'var(--text3)',marginBottom:3}},'Abono capital 1er mes'),
          h('div',{className:'mono',style:{fontSize:14,fontWeight:700,color:'var(--blue)'}},fmt(sim.capP)),
          moneda==='USD'&&h('div',{className:'mono',style:{fontSize:10,color:'var(--blue)'}},copToUsd(sim.capP,+trmCalc)))),
      h('div',{style:{marginTop:10,padding:'10px 12px',background:'rgba(63,185,80,.08)',borderRadius:10,border:'1px solid var(--green-bd)'}},
        h('div',{style:{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:6}},
          h('span',{style:{fontSize:12,color:'var(--text2)'}},'Ganancia en intereses'),
          h('div',{style:{textAlign:'right'}},
            h('div',{className:'mono',style:{fontSize:15,fontWeight:700,color:'var(--green)'}},fmt(sim.totalInt)),
            moneda==='USD'&&h('div',{className:'mono',style:{fontSize:10,color:'var(--blue)'}},copToUsd(sim.totalInt,+trmCalc)))),
        h('div',{style:{display:'flex',justifyContent:'space-between',alignItems:'center'}},
          h('span',{style:{fontSize:12,color:'var(--text2)'}},'Total a recibir'),
          h('div',{style:{textAlign:'right'}},
            h('div',{className:'mono',style:{fontSize:13,fontWeight:600,color:'var(--text)'}},fmt(sim.totalPagar)),
            moneda==='USD'&&h('div',{className:'mono',style:{fontSize:10,color:'var(--blue)'}},copToUsd(sim.totalPagar,+trmCalc))))),
      h('button',{onClick:function(){setShowCrono(!showCrono);},style:{marginTop:12,background:'none',border:'none',cursor:'pointer',color:'var(--green)',fontSize:12,fontWeight:600,display:'flex',alignItems:'center',gap:4,padding:0}},
        showCrono?'Ocultar cronograma':'Ver cronograma tentativo'),
      showCrono&&h('div',{style:{marginTop:10,borderTop:'1px solid var(--green-bd)',paddingTop:10,overflowX:'auto'}},
        h('table',{style:{width:'100%',borderCollapse:'collapse',fontSize:11}},
          h('thead',null,h('tr',{style:{background:'rgba(63,185,80,.1)'}},
            ['#','Interes','Abono a capital','Valor cuota','Saldo'].map(function(hd){
              return h('th',{key:hd,style:{padding:'6px 8px',textAlign:hd==='#'?'center':'right',fontWeight:600,color:'var(--text2)',whiteSpace:'nowrap'}},hd);}))),
          h('tbody',null,sim.rows.map(function(r){
            var t=+trmCalc||1;
            return h('tr',{key:r.n,style:{borderTop:'1px solid rgba(63,185,80,.12)'}},
              h('td',{style:{padding:'5px 8px',textAlign:'center',color:'var(--text3)'}},r.n),
              h('td',{className:'mono',style:{padding:'5px 8px',textAlign:'right',color:'var(--yellow)'}},fmtN(r.interes),
                moneda==='USD'&&h('div',{style:{fontSize:9,color:'var(--blue)'}},copToUsd(r.interes,t))),
              h('td',{className:'mono',style:{padding:'5px 8px',textAlign:'right',color:'var(--blue)'}},fmtN(r.capital),
                moneda==='USD'&&h('div',{style:{fontSize:9,color:'var(--blue)'}},copToUsd(r.capital,t))),
              h('td',{className:'mono',style:{padding:'5px 8px',textAlign:'right',color:'var(--green)',fontWeight:600}},fmtN(r.cuota),
                moneda==='USD'&&h('div',{style:{fontSize:9,color:'var(--blue)',fontWeight:400}},copToUsd(r.cuota,t))),
              h('td',{className:'mono',style:{padding:'5px 8px',textAlign:'right',color:'var(--text3)',fontSize:10}},fmtN(r.saldo),
                moneda==='USD'&&h('div',{style:{fontSize:9,color:'var(--blue)'}},copToUsd(r.saldo,t))));
          }))))),
    h('div',{style:{display:'flex',gap:10,marginTop:16}},
      h('button',{onClick:confirmar,className:'btn-primary',style:{flex:1,display:'flex',alignItems:'center',justifyContent:'center',gap:6}},h(Ico,{name:'check',size:14,color:'#fff'}),' Confirmar y crear'),
      h('button',{onClick:limpiar,style:{flex:1,background:'var(--bg3)',color:'var(--text2)',border:'1px solid var(--border2)',borderRadius:12,padding:13,fontSize:14,fontWeight:700,cursor:'pointer',fontFamily:'inherit',display:'flex',alignItems:'center',justifyContent:'center',gap:6}},h(Ico,{name:'x',size:14,color:'var(--red)'}),' Limpiar')));
}

// ── PayModal ──────────────────────────────────────────────────────────────────
function PayModal(props){
  var pay=props.pay,loan=props.loan,allPays=props.allPays||[],onMark=props.onMark,onPartial=props.onPartial,onClose=props.onClose;
  var yaPagado=+pay.partialPaid||0;
  var restante=Math.max(0,pay.cuotaTotal-yaPagado);
  var s1=useState(nowStr()); var fecha=s1[0]; var setFecha=s1[1];
  var s2=useState(pay.observaciones||''); var obs=s2[0]; var setObs=s2[1];
  var s3=useState(restante||''); var copRec=s3[0]; var setCopRec=s3[1];
  var s4=useState(pay.montoUSDRecibido||''); var usdRec=s4[0]; var setUsdRec=s4[1];
  var s5=useState(false); var genRecibo=s5[0]; var setGenRecibo=s5[1];
  var s6=useState('completo'); var tipoPago=s6[0]; var setTipoPago=s6[1];
  var s7=useState(''); var montoParcial=s7[0]; var setMontoParcial=s7[1];
  var s8=useState(''); var parcialUSD=s8[0]; var setParcialUSD=s8[1];
  var s9=useState(false); var sending=s9[0]; var setSending=s9[1];   // v1.18.1: guarda anti doble-submit
  var so=ST[pay.estadoPago]||{bg:'var(--bg3)',color:'var(--text2)',icon:'?'};
  var esUSD=loan&&loan.moneda==='USD';
  // Abono real = id con '-ab-' (regla canonica). NO usar la heuristica interes===0 && capital>0:
  // la cuota unica de un Prestamo (o un Pago Unico sin ganancia) tambien la cumple y bloqueaba el pago.
  var esAbono=pay.id&&pay.id.indexOf('-ab-')!==-1;
  if(esAbono) return h(Modal,{onClose:onClose},
    h('div',{style:{fontWeight:700,fontSize:16,color:'var(--text)',marginBottom:12}},'Detalle Abono Capital'),
    h('div',{style:{background:'var(--bg3)',borderRadius:12,padding:'14px',border:'1px solid var(--border)'}},
      h('div',{style:{fontWeight:700,color:'var(--text)',marginBottom:4}},pay.nombreCliente),
      h('div',{style:{fontSize:12,color:'var(--text2)',marginBottom:8}},fmtD(pay.fechaRecaudo||pay.fechaPago)),
      h('div',{className:'mono',style:{fontSize:20,fontWeight:700,color:'var(--blue)',marginBottom:4}},'Abono: '+fmt(pay.abonoCapital),
        esUSD&&h('span',{style:{fontSize:13,fontWeight:600,marginLeft:8}},copToUsd(pay.abonoCapital,loan.trmAcordada))),
      h('div',{className:'mono',style:{fontSize:13,color:'var(--text2)'}},'Saldo tras abono: '+fmt(pay.saldoFinal),
        esUSD&&h('span',{style:{marginLeft:6}},copToUsd(pay.saldoFinal,loan.trmAcordada))),
      pay.observaciones&&h('div',{style:{fontSize:11,color:'var(--text3)',marginTop:8,fontStyle:'italic'}},pay.observaciones)));

  // v1.18.1 — GUARDA ANTI DOBLE-SUBMIT (misma doctrina del Bug #29 en AbonoModal). Aqui el
  // riesgo es mayor: PUT /api/payments/:id y POST /partial no son idempotentes, y un pago
  // duplicado contamina montoCOPRecibido, el ledger `recibos` y con ello los KPI de Cobros
  // del Mes y Ganancias. Se libera al resolver la promesa; ante un fallo de API la promesa
  // RESUELVE (API.put/post atrapan el error y devuelven null), nunca rechaza, por eso el
  // release va en el .then y no en un .catch.
  function _run(fn){ _submitGuard(sending,setSending,fn); }
  function submitParcial(){
    if(sending) return;
    var m=+montoParcial||0;
    if(m<=0){showError('Ingresa el monto del pago parcial');return;}
    if(m>restante){showError('El monto supera el saldo pendiente ('+fmt(restante)+')');return;}
    // v2.3.0: el recibo se emite DESPUES de confirmar la escritura. Antes se imprimia primero, asi
    // que un fallo de red dejaba en manos del deudor el comprobante de un pago NUNCA registrado.
    // `allPays` se captura aqui a proposito: es el estado PREVIO, que es el que generateRecibo
    // necesita para calcular el saldo resultante.
    _run(function(){return onPartial(pay.id,m,fecha,obs,+parcialUSD||0).then(function(r){
      if(r&&genRecibo&&loan) generateRecibo(pay,loan,m,+parcialUSD||0,allPays,{yaAbonadoPrev:yaPagado,fechaRecaudo:fecha});
      return r;
    });});
  }
  function submitCompleto(){
    if(sending) return;
    if(esUSD&&(!copRec||+copRec<=0)){showError('Ingresa el monto COP recibido para prestamos en USD');return;}
    if(yaPagado>0){
      // Habia pagos parciales: el recibo es "Pago final" que completa la cuota
      _run(function(){return onPartial(pay.id,restante,fecha,obs,+usdRec||0).then(function(r){
        if(r&&genRecibo) generateRecibo(pay,loan,restante,+usdRec||0,allPays,{yaAbonadoPrev:yaPagado,fechaRecaudo:fecha});
        return r;
      });});
    } else {
      _run(function(){return onMark(pay.id,'Pagado',fecha,obs,+copRec||pay.cuotaTotal,+usdRec||0).then(function(r){
        if(r&&genRecibo) generateRecibo(pay,loan,+copRec||pay.cuotaTotal,+usdRec||0,allPays,{fechaRecaudo:fecha});
        return r;
      });});
    }
  }

  return h(Modal,{onClose:onClose},
    h('div',{style:{fontWeight:700,fontSize:16,color:'var(--text)',marginBottom:14}},'Actualizar Pago'),
    h('div',{style:{background:'var(--bg3)',borderRadius:12,padding:'13px 14px',marginBottom:16,border:'1px solid var(--border)'}},
      h('div',{style:{fontWeight:700,fontSize:14,color:'var(--text)'}},pay.nombreCliente),
      h('div',{style:{fontSize:12,color:'var(--text2)',marginTop:3}},'Cuota '+pay.cuotaN+' - '+fmtD(pay.fechaPago)),
      h('div',{className:'mono',style:{fontWeight:700,fontSize:20,color:'var(--green)',marginTop:6}},fmt(pay.cuotaTotal),
        esUSD&&h('span',{style:{fontSize:13,fontWeight:600,color:'var(--blue)',marginLeft:8}},copToUsd(pay.cuotaTotal,loan.trmAcordada))),
      yaPagado>0&&pay.estadoPago!=='Pagado'&&h('div',{style:{marginTop:8,padding:'8px 10px',background:'rgba(63,185,80,.08)',border:'1px solid var(--green-bd)',borderRadius:8}},
        h('div',{className:'mono',style:{fontSize:12,color:'var(--green)',fontWeight:700}},'Ya abonado: '+fmt(yaPagado)+' / '+fmt(pay.cuotaTotal)),
        h('div',{className:'mono',style:{fontSize:13,color:'var(--yellow)',fontWeight:700,marginTop:2}},'Pendiente: '+fmt(restante))),
      esUSD&&h('div',{style:{fontSize:11,color:'var(--blue)',marginTop:4}},'Prestamo USD (TRM $'+fmtN(loan.trmAcordada)+') - ingresa COP recibidos'),
      h('div',{style:{marginTop:8}},h('span',{style:{background:so.bg,color:so.color,fontSize:11,fontWeight:700,padding:'3px 10px',borderRadius:99}},so.icon+' '+pay.estadoPago))),

    // Toggle Completo / Parcial — solo si la cuota no esta Pagada
    pay.estadoPago!=='Pagado'&&h('div',{style:{display:'flex',gap:6,marginBottom:12,background:'var(--bg3)',border:'1px solid var(--border)',borderRadius:10,padding:3}},
      h('button',{type:'button',onClick:function(){setTipoPago('completo');},style:{flex:1,padding:'8px 10px',border:'none',borderRadius:8,cursor:'pointer',fontWeight:700,fontSize:12,background:tipoPago==='completo'?'var(--green2)':'transparent',color:tipoPago==='completo'?'#fff':'var(--text2)',transition:'all .15s'}},'Pago completo'),
      h('button',{type:'button',onClick:function(){setTipoPago('parcial');},style:{flex:1,padding:'8px 10px',border:'none',borderRadius:8,cursor:'pointer',fontWeight:700,fontSize:12,background:tipoPago==='parcial'?'var(--yellow)':'transparent',color:tipoPago==='parcial'?'#fff':'var(--text2)',transition:'all .15s'}},'Pago parcial')),

    h(Fld,{label:'Fecha de recaudo'},h('input',{type:'date',value:fecha,onChange:function(e){setFecha(e.target.value);},className:'inp'})),

    // ── Modo Parcial ──
    tipoPago==='parcial'&&pay.estadoPago!=='Pagado'&&h('div',{style:{background:'rgba(187,128,9,.08)',border:'1px solid var(--yellow)',borderRadius:12,padding:'10px 12px',marginBottom:4}},
      h(Fld,{label:'Monto del pago parcial (COP) *'},
        h('input',{type:'text',inputMode:'numeric',value:fmtNumInput(montoParcial),onChange:function(e){setMontoParcial(parseNum(e.target.value));},placeholder:'0',className:'inp',style:{border:'1px solid var(--yellow)'}}),
        montoParcial>0&&h('div',{style:{fontSize:11,marginTop:4,fontFamily:'monospace',color:+montoParcial>=restante?'var(--green)':'var(--text2)'}},
          +montoParcial>=restante?'Con este pago la cuota quedaria COMPLETA':'Quedarian pendientes: '+fmt(restante-(+montoParcial||0)))),
      esUSD&&h(Fld,{label:'USD recibidos (opcional)'},
        h('input',{type:'text',inputMode:'decimal',value:parcialUSD,onChange:function(e){setParcialUSD(parseDecimalInput(e.target.value));},placeholder:'Ej: 6.50',className:'inp',style:{border:'1px solid var(--blue)'}}))),

    // ── Modo Completo (USD fields) ──
    tipoPago==='completo'&&esUSD&&pay.estadoPago!=='Pagado'&&h('div',{style:{background:'rgba(187,128,9,.1)',border:'1px solid var(--yellow)',borderRadius:12,padding:'10px 12px',marginBottom:4}},
      h(Fld,{label:'COP realmente recibidos *'},
        h('input',{type:'text',inputMode:'numeric',value:fmtNumInput(copRec),onChange:function(e){setCopRec(parseNum(e.target.value));},placeholder:'Monto en pesos recibido',className:'inp',style:{border:'1px solid var(--yellow)'}})),
      h(Fld,{label:'USD recibidos (opcional)'},
        h('input',{type:'text',inputMode:'decimal',value:usdRec,onChange:function(e){setUsdRec(parseDecimalInput(e.target.value));},placeholder:'Ej: 6.50',className:'inp',style:{border:'1px solid var(--blue)'}}))),

    h(Fld,{label:'Observaciones'},h('input',{value:obs,onChange:function(e){setObs(e.target.value);},placeholder:'Notas opcionales...',className:'inp'})),
    pay.estadoPago!=='Pagado'&&h('label',{style:{display:'flex',alignItems:'center',gap:8,marginTop:14,cursor:'pointer',fontSize:12,color:'var(--text2)'}},
      h('input',{type:'checkbox',checked:genRecibo,onChange:function(){setGenRecibo(!genRecibo);},style:{width:16,height:16,accentColor:'var(--green)',cursor:'pointer'}}),
      'Generar recibo de pago'),
    // Los 4 botones escriben en BD y comparten la MISMA guarda: mientras una operacion esta
    // en vuelo ninguno acepta clicks (evita tanto el doble submit como disparar dos cambios
    // de estado contradictorios sobre la misma cuota).
    h('div',{style:{display:'flex',gap:8,marginTop:14}},
      pay.estadoPago!=='Pagado'&&tipoPago==='completo'&&h(ABtn,{color:'var(--green2)',disabled:sending,onClick:submitCompleto,icon:'check', label:sending?'Registrando...':(yaPagado>0?'Completar':'Pagado')}),
      pay.estadoPago!=='Pagado'&&tipoPago==='parcial' &&h(ABtn,{color:'var(--yellow)', disabled:sending,onClick:submitParcial, icon:'check', label:sending?'Registrando...':'Registrar parcial'}),
      pay.estadoPago!=='En Mora'   &&h(ABtn,{color:'#b91c1c',     disabled:sending,onClick:function(){_run(function(){return onMark(pay.id,'En Mora',  null, obs,0,0);});}, icon:'alert', label:sending?'...':'En Mora'}),
      pay.estadoPago!=='Pendiente' &&h(ABtn,{color:'var(--bg4)',   disabled:sending,onClick:function(){_run(function(){return onMark(pay.id,'Pendiente',null, obs,0,0);});}, icon:'clock', label:sending?'...':'Pendiente'})));
}

// ── PreflightMoraModal (v1.9.0) ───────────────────────────────────────────────
// Modal de advertencia previo a abono/reestructurar cuando hay cuotas Pendientes
// con fechaPago - hoy <= 5 dias. El usuario elige: marcar en mora (preservar como
// deuda independiente), continuar sin marcar (se absorben), o cancelar.
//
// Helper: detecta cuotas en riesgo (fechaPago entre hoy y hoy+5 dias, estadoPago=Pendiente,
// y NO es un registro de abono).
function _cuotasEnRiesgo(allPays,loanId){
  var hoy=new Date(nowStr()+'T12:00:00').getTime();
  var limite=hoy+5*24*60*60*1000;
  return allPays.filter(function(p){
    if(String(p.prestamoId)!==String(loanId)) return false;
    if(p.estadoPago!=='Pendiente') return false;
    if(p.id&&p.id.indexOf('-ab-')!==-1) return false;
    var t=new Date(p.fechaPago+'T12:00:00').getTime();
    return t>=hoy&&t<=limite;
  }).sort(function(a,b){return a.cuotaN-b.cuotaN;});
}
function PreflightMoraModal(props){
  var cuotas=props.cuotas||[],loan=props.loan,onMarkMora=props.onMarkMora,onContinue=props.onContinue,onCancel=props.onCancel;
  var esUSD=loan&&loan.moneda==='USD';
  var hoy=new Date(nowStr()+'T12:00:00').getTime();
  // v1.18.1 — Guarda anti doble-submit. Este modal es el eslabon que faltaba del Bug #29:
  // intercepta los flujos de abono y reestructuracion, y sus dos botones disparan escrituras
  // (N x PUT /payments/:id en "Marcar en Mora", y el POST de abono/reestructurar en ambos).
  // Sin guarda, un doble clic aqui reintroducia exactamente el bug que se cerro en AbonoModal.
  var pfs=useState(false); var pfSending=pfs[0]; var setPfSending=pfs[1];
  return h(Modal,{onClose:onCancel},
    h('div',{style:{fontWeight:700,fontSize:16,color:'var(--text)',marginBottom:4,display:'flex',alignItems:'center',gap:8}},
      h(Ico,{name:'alert',size:18,color:'var(--yellow)',sw:2.4}),
      'Cuotas proximas a vencer'),
    h('div',{style:{fontSize:12,color:'var(--text2)',lineHeight:1.5,marginBottom:12,marginTop:4}},
      'Hay '+cuotas.length+' cuota'+(cuotas.length>1?'s':'')+' que vence'+(cuotas.length>1?'n':'')+' en los proximos 5 dias. Antes de continuar, decide que hacer con ',
      h('b',null,'ellas'),':'),
    h('div',{style:{background:'var(--bg3)',border:'1px solid var(--border)',borderRadius:10,padding:'10px 12px',marginBottom:14,maxHeight:160,overflowY:'auto'}},
      cuotas.map(function(p,i){
        var t=new Date(p.fechaPago+'T12:00:00').getTime();
        var dias=Math.max(0,Math.round((t-hoy)/(24*60*60*1000)));
        return h('div',{key:p.id,style:{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'6px 0',borderTop:i>0?'1px solid var(--border)':'none',fontSize:12}},
          h('div',null,
            h('div',{style:{color:'var(--text)',fontWeight:600}},'Cuota #'+p.cuotaN),
            h('div',{style:{fontSize:10,color:'var(--text3)',marginTop:1}},fmtD(p.fechaPago)+' · vence en '+(dias===0?'hoy':dias+' dia'+(dias!==1?'s':'')))),
          h('div',{className:'mono',style:{textAlign:'right'}},
            h('div',{style:{color:'var(--green)',fontWeight:600}},fmt(p.cuotaTotal)),
            esUSD&&h('div',{style:{fontSize:10,color:'var(--blue)'}},copToUsd(p.cuotaTotal,loan.trmAcordada))));
      })),
    h('button',{onClick:function(){_submitGuard(pfSending,setPfSending,function(){return onMarkMora();});},disabled:pfSending,className:'btn-primary',style:{width:'100%',marginBottom:8,background:pfSending?'var(--bg3)':'var(--yellow-bg)',border:'1px solid '+(pfSending?'var(--border)':'var(--yellow)'),color:pfSending?'var(--text3)':'var(--yellow)',cursor:pfSending?'not-allowed':'pointer',display:'flex',alignItems:'center',justifyContent:'center',gap:6}},
      h(Ico,{name:'alert',size:14,color:pfSending?'var(--text3)':'var(--yellow)'}),pfSending?' Procesando...':' Marcar en Mora primero (recomendado)'),
    h('div',{style:{fontSize:10,color:'var(--text3)',textAlign:'center',marginBottom:10,padding:'0 8px'}},
      'Las cuotas se preservan como deuda independiente. Podras cobrarlas desde Pagos.'),
    h('button',{onClick:function(){_submitGuard(pfSending,setPfSending,function(){return onContinue();});},disabled:pfSending,style:{width:'100%',padding:13,background:'var(--bg3)',border:'1px solid var(--border)',borderRadius:12,color:'var(--text2)',fontSize:13,fontWeight:600,cursor:pfSending?'not-allowed':'pointer',opacity:pfSending?.6:1,fontFamily:'inherit',marginBottom:8}},
      pfSending?'Procesando...':'Continuar sin marcar'),
    h('div',{style:{fontSize:10,color:'var(--text3)',textAlign:'center',marginBottom:10,padding:'0 8px'}},
      'Las cuotas se absorberan en el nuevo cronograma.'),
    // Cancelar no escribe: se deja siempre habilitado para no atrapar al usuario si algo se cuelga.
    h('button',{onClick:onCancel,style:{width:'100%',padding:11,background:'transparent',border:'1px solid var(--border2)',borderRadius:12,color:'var(--text3)',fontSize:12,fontWeight:600,cursor:'pointer',fontFamily:'inherit'}},
      'Cancelar'));
}

// ── AbonoModal ────────────────────────────────────────────────────────────────
// Helper: PMT (cuota fija de amortizacion francesa)
function _pmt(r,n,pv){if(r===0)return pv/n;return pv*r*Math.pow(1+r,n)/(Math.pow(1+r,n)-1);}
function _tasaPeriodo(tasaMensual,frecuencia){if(frecuencia==='Semanal')return tasaMensual/4.33;if(frecuencia==='Quincenal')return tasaMensual/2;return tasaMensual;}
// NPER: numero de cuotas dado PMT, r, pv. Devuelve null si PMT <= pv*r (impossible).
function _nper(r,pmtVal,pv){var int1=pv*r;if(pmtVal<=int1)return null;return Math.log(pmtVal/(pmtVal-int1))/Math.log(1+r);}

function AbonoModal(props){
  var loan=props.loan,allPays=props.pays||[],onSave=props.onSave,onClose=props.onClose,onRequestLiquidar=props.onRequestLiquidar;
  var esUSD=loan.moneda==='USD';
  var esCapInt=loan.modalidad==='Capital + Intereses';
  var s1=useState(''); var monto=s1[0]; var setMonto=s1[1];
  var s2=useState(nowStr()); var fecha=s2[0]; var setFecha=s2[1];
  var s3=useState(''); var obs=s3[0]; var setObs=s3[1];
  var s4=useState(''); var montoUSD=s4[0]; var setMontoUSD=s4[1];
  var s4b=useState(''); var copRecibido=s4b[0]; var setCopRecibido=s4b[1];       // v2.0.0: COP realmente recibidos (solo USD)
  var sRec=useState(true); var genRecibo=sRec[0]; var setGenRecibo=sRec[1];      // v1.17.1: PDF opcional
  var sSend=useState(false); var sending=sSend[0]; var setSending=sSend[1];      // v1.17.1: guarda anti doble-submit
  // Opciones de recalculo (solo para Capital + Intereses)
  var sm=useState('mantener'); var recalcMode=sm[0]; var setRecalcMode=sm[1];
  var sp=useState(''); var nuevoPlazo=sp[0]; var setNuevoPlazo=sp[1];
  var sc=useState(''); var nuevaCuotaFija=sc[0]; var setNuevaCuotaFija=sc[1];
  var scu=useState(''); var nuevaCuotaFijaUSD=scu[0]; var setNuevaCuotaFijaUSD=scu[1];
  // Cuota fija efectiva en COP (la que se usa para calcular). Para USD se deriva de USD x trmAcordada.
  var cuotaFijaEfectivaCOP=esUSD?Math.round((+nuevaCuotaFijaUSD||0)*(+loan.trmAcordada||1)):(+nuevaCuotaFija||0);
  var originalCOP=esUSD?Math.round(loan.montoOrigen*loan.trmAcordada):Math.round(loan.montoOrigen);
  var loanPays=allPays.filter(function(p){return String(p.prestamoId)===String(loan.id);});
  var todoCapPagado=loanPays.filter(function(p){return p.estadoPago==='Pagado';}).reduce(function(s,p){return s+p.abonoCapital;},0);
  var saldoActual=Math.max(0,originalCOP-todoCapPagado);
  var intMora=loanPays.filter(function(p){return p.estadoPago==='En Mora'&&p.id.indexOf('-ab-')===-1;}).reduce(function(s,p){return s+p.interesPeriodo;},0);
  // ── v2.0.0 — TECHO REAL DEL ABONO: espejo EXACTO del saldoReal que se computa dentro de POST /api/loans/:id/abono ──
  // saldoActual (identico al capitalPendienteLiq del backend) es TODO el capital que se debe:
  // el del cronograma futuro MAS el atrapado en cuotas En Mora. Pero un abono normal (no
  // liquidacion) solo puede tocar el capital FUTURO: el backend valida contra saldoReal, que SI
  // resta el capital En Mora (deuda independiente amortizada aparte, Bug #21). Sin este espejo el
  // modal aceptaba montos en la ventana (saldoReal, capitalPendienteLiq] que el backend rechazaba
  // con 400 "El abono supera el saldo actual" — el usuario pagaba justo lo que la pantalla decia.
  // Prestamo / Pago Unico (esSingleCuota) NO restan su mora: alli abonoCapital ES el saldo vivo.
  var esSingleCuota=loan.modalidad==='Prestamo'||loan.modalidad==='Pago Unico';
  var moraRows=loanPays.filter(function(p){return p.estadoPago==='En Mora';}); // sin filtro '-ab-': espejo del backend
  var moraCap=moraRows.reduce(function(s,p){return s+p.abonoCapital;},0);
  var moraCount=moraRows.filter(function(p){return p.id.indexOf('-ab-')===-1;}).length;
  var saldoAbonable=esSingleCuota?Math.max(0,originalCOP-todoCapPagado):Math.max(0,originalCOP-todoCapPagado-moraCap);
  var capEnMora=Math.max(0,saldoActual-saldoAbonable); // capital que solo se cobra liquidando o pagando esas cuotas
  // v2.3.0 — puente con el saldo que muestra el perfil. `saldoActual` es capital CONTRACTUAL
  // (no baja con parciales); `saldoCajaModal` es el mismo capital con la caja ya aplicada. Su
  // diferencia ES, por algebra, el capital imputado de los parciales que siguen en curso: en las
  // cuotas Pagadas el capital imputado coincide con `abonoCapital`, asi que solo sobreviven las
  // no Pagadas. Ambas son de PRESENTACION; el techo del abono no depende de esto.
  var saldoCajaModal=saldoConCaja(loan,loanPays);
  var capImputadoVivo=Math.max(0,saldoActual-saldoCajaModal);
  var parcialVivo=loanPays.filter(function(p){return p.id.indexOf('-ab-')===-1&&p.estadoPago!=='Pagado';})
    .reduce(function(s,p){return s+(p.partialPaid||0);},0);
  var liquidacion=computeLiquidacion(loan,loanPays,{}).total; // v1.19.0: helper centralizado
  // ── v2.0.0 — DOBLE ENTRADA OBLIGATORIA EN PRESTAMOS USD ──────────────────────────────
  // La deuda esta denominada en DOLARES y el ledger la lleva en COP a la TRM PACTADA
  // (originalCOP = montoOrigen x trmAcordada). Por eso el CAPITAL que se descuenta lo manda el
  // campo USD:  montoCapCOP = montoUSD x trmAcordada.
  // Los COP realmente recibidos NO tocan el capital (dependen de la TRM del dia): son la caja
  // real y sirven para medir el efecto TRM. Usar los COP de caja como capital descontaria de
  // MENOS cuando la TRM baja y dejaria capital fantasma vivo pese a que el cliente ya entrego
  // todos los dolares pactados (misma doctrina del pago bimonetario, Bug #23).
  var copRecNum=Math.round(+copRecibido||0);
  // Techo expresado en dolares. Como el usuario teclea USD con 2 decimales, redondear
  // (usd x trm) casi nunca da EXACTAMENTE saldoAbonable: sobrarian unos pesos de capital
  // fantasma que impedirian dejar el capital futuro en cero. Si el USD tecleado ES el techo
  // (tolerancia de medio centavo, misma doctrina que completaUSD en /partial), el capital se
  // ancla al techo exacto. Por encima de esa tolerancia NO se ancla, para que excedeAbonable
  // siga disparando el CTA de liquidacion en vez de capar el monto en silencio.
  var techoUSD=(esUSD&&+loan.trmAcordada>0)?Math.round(saldoAbonable/(+loan.trmAcordada)*100)/100:0;
  var cubreTechoUSD=esUSD&&(+montoUSD>0)&&Math.abs((+montoUSD)-techoUSD)<0.005;
  var montoCapCOP=esUSD
    ?(cubreTechoUSD?saldoAbonable:Math.round((+montoUSD||0)*(+loan.trmAcordada||0)))
    :Math.round(+monto||0);
  var trmImplicita=(esUSD&&(+montoUSD||0)>0&&copRecNum>0)?Math.round(copRecNum/(+montoUSD)):0;
  var efectoTRM=(esUSD&&copRecNum>0&&montoCapCOP>0)?copRecNum-montoCapCOP:0;
  // El backend recalcula desde (saldoReal - monto) -> el preview debe partir de saldoAbonable.
  var saldoTras=saldoAbonable-montoCapCOP;
  var saldoUSDTras=esUSD?saldoTras/loan.trmAcordada:0;
  // Monto que supera el techo real pero sigue dentro del capital total: no es un error del
  // usuario, es dinero que corresponde a la LIQUIDACION -> se ofrece el CTA en vez de un 400.
  var excedeAbonable=montoCapCOP>saldoAbonable;
  var ctaLiquidar=excedeAbonable&&capEnMora>0;
  // Cuotas regulares ya consumidas (pagadas + en mora, excluyendo abonos)
  var regulares=loanPays.filter(function(p){return p.id.indexOf('-ab-')===-1;});
  var regularConsumed=regulares.filter(function(p){return p.estadoPago==='Pagado'||p.estadoPago==='En Mora';}).length;
  var plazoOriginal=+loan.plazoMeses||12;
  var cuotasRestantesActuales=Math.max(1,plazoOriginal-regularConsumed);
  // Preview en vivo de la opcion seleccionada
  var preview=function(){
    if(!esCapInt||montoCapCOP<=0||saldoTras<=0) return null;
    var r=_tasaPeriodo((+loan.tasaMensual||0)/100,loan.frecuencia||'Mensual');
    var interesPrimerPeriodo=Math.round(saldoTras*r);
    if(recalcMode==='mantener'){
      var n=cuotasRestantesActuales;
      var pmtVal=Math.round(_pmt(r,n,saldoTras));
      return {modo:'mantener',cuota:pmtVal,nCuotas:n,interesP:interesPrimerPeriodo,error:null,ultimaResidual:0};
    }
    if(recalcMode==='modificarPlazo'){
      var nN=parseInt(nuevoPlazo,10);
      if(!nN||nN<1) return {modo:'modificarPlazo',cuota:0,nCuotas:0,interesP:interesPrimerPeriodo,error:'Ingresa un numero de cuotas valido (>= 1).',ultimaResidual:0};
      var pmtMod=Math.round(_pmt(r,nN,saldoTras));
      return {modo:'modificarPlazo',cuota:pmtMod,nCuotas:nN,interesP:interesPrimerPeriodo,error:null,ultimaResidual:0};
    }
    if(recalcMode==='fijarCuota'){
      var pmtFijo=cuotaFijaEfectivaCOP;
      if(pmtFijo<=0) return {modo:'fijarCuota',cuota:0,nCuotas:0,interesP:interesPrimerPeriodo,error:'Ingresa una cuota valida (> 0).',ultimaResidual:0};
      if(pmtFijo<=interesPrimerPeriodo) return {modo:'fijarCuota',cuota:pmtFijo,nCuotas:0,interesP:interesPrimerPeriodo,error:'La cuota debe ser mayor a '+fmt(interesPrimerPeriodo)+(esUSD?' ('+copToUsd(interesPrimerPeriodo,loan.trmAcordada)+')':'')+' que son los intereses del primer periodo. Con esta cuota nunca se saldaria la deuda.',ultimaResidual:0};
      var nCalc=_nper(r,pmtFijo,saldoTras);
      var nEnt=Math.ceil(nCalc);
      // Calcular saldo despues de (nEnt - 1) cuotas iguales para conocer la ultima residual
      var sR=saldoTras,resid=0;
      for(var i=0;i<nEnt-1;i++){var intI=sR*r;var capI=pmtFijo-intI;sR=sR-capI;}
      if(sR>0){resid=Math.round((sR+sR*r)*100)/100;}
      return {modo:'fijarCuota',cuota:pmtFijo,nCuotas:nEnt,interesP:interesPrimerPeriodo,error:null,ultimaResidual:resid};
    }
    return null;
  }();
  function submit(){
    // v1.17.1 — GUARDA ANTI DOBLE-SUBMIT. Sin esto, dos clicks (o un doble evento) disparaban
    // dos POST /abono con ~60 ms de diferencia y el backend, que es atomico pero NO idempotente,
    // aplicaba el abono DOS VECES (bug detectado en produccion el 18-jul-2026).
    if(sending) return;
    // v2.0.0 — USD exige DOS entradas: los dolares definen el capital, los COP la caja real.
    if(esUSD){
      if(!(+montoUSD>0)){showError('Ingresa el monto del abono en USD (define el capital que se descuenta)');return;}
      if(!(copRecNum>0)){showError('Ingresa los COP realmente recibidos (miden el efecto de la TRM)');return;}
    } else if(!monto||+monto<=0){showError('Ingresa un monto valido');return;}
    // v2.0.0 — el techo es saldoAbonable (capital del cronograma futuro), NO saldoActual.
    // Defense-in-depth: el boton ya se deshabilita, pero si algo fallara el submit tampoco
    // debe enviar un monto que el backend rechazaria con 400.
    if(montoCapCOP>saldoAbonable){
      var _techo=esUSD?copToUsd(saldoAbonable,loan.trmAcordada):fmt(saldoAbonable);
      var _mora=esUSD?copToUsd(capEnMora,loan.trmAcordada):fmt(capEnMora);
      showError(capEnMora>0
        ?'El abono maximo a capital es '+_techo+'. Los '+_mora+' restantes estan en '+moraCount+' cuota'+(moraCount!==1?'s':'')+' en mora: se cobran liquidando la deuda o pagando esas cuotas.'
        :'El abono maximo es '+_techo+' (solo capital). Los intereses en mora se cobran por separado.');
      return;
    }
    if(esCapInt&&preview&&preview.error){showError(preview.error);return;}
    var mode=esCapInt?recalcMode:null;
    var valor=null;
    if(mode==='modificarPlazo') valor=parseInt(nuevoPlazo,10);
    else if(mode==='fijarCuota') valor=cuotaFijaEfectivaCOP; // siempre en COP (auto-conv de USD)
    // v1.18.1: se delega en el helper compartido _submitGuard (misma semantica que tenia
    // aqui inline). Se libera al resolver, al rechazar o si onSave no devuelve promesa
    // (rama de pre-flight); en exito el modal ya se desmonto.
    // v2.0.0 — se envia el CAPITAL en COP a TRM pactada (montoCapCOP) y, aparte, la caja real
    // (copRecNum) para que el backend registre el desfase cambiario sin tocar el capital.
    _submitGuard(sending,setSending,function(){return onSave(loan.id,montoCapCOP,fecha,obs,+montoUSD||0,false,mode,valor,genRecibo,undefined,esUSD?copRecNum:0);});
  }
  // v2.0.0 — el boton se apaga cuando el monto excede el capital amortizable (alli la accion
  // correcta es el CTA de liquidacion, no forzar un POST que el backend va a rechazar) y, en
  // prestamos USD, mientras falte cualquiera de las dos entradas obligatorias.
  var faltanCamposUSD=esUSD&&(!(+montoUSD>0)||!(copRecNum>0));
  var btnOff=(esCapInt&&preview&&!!preview.error)||excedeAbonable||faltanCamposUSD||sending;
  // El rojo se reserva para "el prestamo quedaria SALDADO". Cubrir todo el capital amortizable
  // dejando mora viva es un estado NORMAL, no una alarma -> ambar.
  var lineaSaldoTras=montoCapCOP>0&&!excedeAbonable&&h('div',{style:{fontSize:11,marginTop:4,fontFamily:'monospace',color:saldoTras<=0?(capEnMora>0?'var(--yellow)':'var(--red)'):'var(--text2)'}},
    saldoTras<=0
      ?(capEnMora>0
          ?'Cubre todo el capital amortizable ('+(moraCount===1?'queda 1 cuota':'quedan '+moraCount+' cuotas')+' en mora)'
          :'El prestamo quedaria SALDADO')
      :'Saldo tras abono: '+fmt(saldoTras)+(esUSD?' ('+copToUsd(saldoTras,loan.trmAcordada)+')':''));
  return h(Modal,{onClose:onClose},
    h('div',{style:{fontWeight:700,fontSize:16,color:'var(--text)',marginBottom:4}},'Abono a Capital'),
    h('div',{style:{background:'var(--bg3)',borderRadius:12,padding:'13px 14px',marginBottom:16,border:'1px solid var(--border)'}},
      h('div',{style:{fontWeight:700,fontSize:14,color:'var(--text)'}},loan.nombre),
      h('div',{style:{fontSize:12,color:'var(--text2)',marginTop:3}},loan.modalidad),
      h('div',{className:'mono',style:{fontWeight:700,fontSize:18,color:'var(--green)',marginTop:6}},'Saldo actual: '+fmt(saldoActual),
        esUSD&&h('span',{style:{fontSize:13,fontWeight:600,color:'var(--blue)',marginLeft:8}},copToUsd(saldoActual,loan.trmAcordada))),
      // v2.0.0 — cuando hay capital atrapado en mora, "Saldo actual" (capital total) y el techo
      // del abono NO coinciden: se desglosa para que el numero del tope no parezca arbitrario.
      capEnMora>0&&h('div',{style:{fontSize:11,color:'var(--text3)',marginTop:4}},
        'Abonable a capital: ',h('span',{className:'mono',style:{fontWeight:700,color:'var(--text2)'}},fmt(saldoAbonable)),
        '  •  en mora: ',h('span',{className:'mono',style:{fontWeight:700,color:'var(--yellow)'}},fmt(capEnMora))),
      // v2.3.0 — "Saldo actual" es el capital CONTRACTUAL (base del motor): no baja con un pago
      // parcial, porque un parcial no re-amortiza. El perfil del deudor, en cambio, ya muestra el
      // saldo CON CAJA APLICADA. Mientras un parcial esta en vuelo y ya supero el interes del
      // periodo, las dos cifras difieren por el capital imputado y sin esta linea pareceria una
      // inconsistencia. NO se toca `saldoActual`: alimenta `capEnMora` (desglose de la mora) y
      // el techo del abono sigue siendo el espejo exacto del backend (Bug #36).
      capImputadoVivo>0&&h('div',{style:{fontSize:11,color:'var(--text3)',marginTop:4,lineHeight:1.5}},
        'Abonado en curso: ',h('span',{className:'mono',style:{fontWeight:700,color:'var(--blue)'}},fmt(parcialVivo)),
        ' (',fmt(capImputadoVivo),' a capital)',
        h('div',null,'Saldo con esos pagos aplicados: ',
          h('span',{className:'mono',style:{fontWeight:700,color:'var(--text2)'}},fmt(saldoCajaModal)),
          h('span',{style:{color:'var(--text3)'}},' — es el que ves en el perfil'))),
      intMora>0&&h('div',{className:'mono',style:{fontSize:13,color:'var(--yellow)',marginTop:4}},'Valor de liquidacion: '+fmt(liquidacion)+(esUSD?' '+copToUsd(liquidacion,loan.trmAcordada):''),
        h('div',{style:{fontSize:10,color:'var(--text3)',fontFamily:'var(--font)',marginTop:1}},'(incluye intereses en mora)'))),
    function(){
      var hayMora=intMora>0;
      var esPrestamo=loan.modalidad==='Prestamo';
      var esPagoUnicoLocal=loan.modalidad==='Pago Unico'; // v1.10.0
      var esIntereses=loan.modalidad==='Intereses';
      var titulo,partes;
      if(hayMora&&esPrestamo){
        titulo='Como se aplica este abono';
        partes=[
          {t:'Este abono reduce directamente el saldo del prestamo.'},
          {t:'La cuota en mora se actualiza automaticamente al nuevo saldo (porque es un prestamo sin interes).'}
        ];
      } else if(hayMora&&esPagoUnicoLocal){
        titulo='Como se aplica este abono';
        partes=[
          {t:'Este abono reduce el capital del prestamo.'},
          {t:'La ganancia pactada NO cambia: se conserva al mismo monto y se cobra junto con el capital restante en la fecha de pago.'},
          {t:'La cuota en mora se actualiza al nuevo saldo (capital + ganancia pactada).'}
        ];
      } else if(hayMora&&!esPrestamo){
        titulo='Como se aplica este abono';
        partes=[
          {t:'El monto se aplica 100% al ',b:'capital pendiente',t2:'. NO descuenta intereses en mora.'},
          {t:'Los intereses en mora ('+fmt(intMora)+') quedan como deuda independiente.'},
          {t:'Para cobrar la mora usa el boton ',b:'Liquidar deuda',t2:' o paga cada cuota desde la seccion Pagos.'}
        ];
      } else if(!hayMora&&esIntereses){
        titulo='Como se aplica este abono';
        partes=[
          {t:'El monto reduce el ',b:'capital pendiente',t2:' del prestamo.'},
          {t:'Las proximas cuotas de interes se calcularan sobre el nuevo saldo, por lo que el interes mensual baja.'}
        ];
      } else {
        titulo='Como se aplica este abono';
        partes=[
          {t:'El monto reduce el ',b:'capital pendiente',t2:' del prestamo.'},
          {t:'Las cuotas futuras se recalculan automaticamente sobre el nuevo saldo.'}
        ];
      }
      return h('div',{style:{background:'rgba(88,166,255,.06)',border:'1px solid var(--blue-bd)',borderRadius:12,padding:'10px 12px',marginBottom:12,marginTop:-8}},
        h('div',{style:{fontSize:10,fontWeight:700,color:'var(--blue)',letterSpacing:.5,marginBottom:6,display:'flex',alignItems:'center',gap:5}},
          h(Ico,{name:'alert',size:11,color:'var(--blue)',sw:2.4}),titulo.toUpperCase()),
        partes.map(function(p,i){
          return h('div',{key:i,style:{fontSize:11,color:'var(--text2)',lineHeight:1.5,marginTop:i>0?4:0,paddingLeft:10,position:'relative'}},
            h('span',{style:{position:'absolute',left:0,top:0,color:'var(--blue)'}},'•'),
            p.t,
            p.b&&h('span',{style:{fontWeight:700,color:'var(--text)'}},p.b),
            p.t2);
        }));
    }(),
    // ── v2.0.0 — ENTRADA DEL ABONO ───────────────────────────────────────────────────
    // USD: DOBLE ENTRADA OBLIGATORIA. Los dolares definen el capital (a TRM pactada) y los COP
    // la caja real del dia; su diferencia es el efecto TRM, que antes era imposible de registrar
    // porque el unico campo (COP) hacia las dos veces. COP: campo unico de siempre.
    esUSD
      ?h('div',{style:{background:'rgba(63,185,80,.08)',border:'1px solid var(--green-bd)',borderRadius:12,padding:'10px 12px',marginBottom:4}},
        h(Fld,{label:'Monto del abono (USD) *'},
          h('input',{type:'text',inputMode:'decimal',value:montoUSD,onChange:function(e){setMontoUSD(parseDecimalInput(e.target.value));},placeholder:'Ej: 250.00',className:'inp',style:{border:'1px solid var(--green)'}}),
          h('div',{style:{fontSize:11,marginTop:3,color:'var(--text3)'}},
            (+montoUSD>0)
              ?'Descuenta '+fmt(montoCapCOP)+' de capital (TRM pactada $'+fmtN(loan.trmAcordada)+')'
              :'Define el capital que se descuenta. Maximo '+copToUsd(saldoAbonable,loan.trmAcordada))),
        h(Fld,{label:'COP realmente recibidos *'},
          h('input',{type:'text',inputMode:'numeric',value:fmtNumInput(copRecibido),onChange:function(e){setCopRecibido(parseNum(e.target.value));},placeholder:'0',className:'inp',style:{border:'1px solid var(--green)'}}),
          h('div',{style:{fontSize:11,marginTop:3,color:'var(--text3)'}},'Caja real del dia. No altera el capital: mide el efecto de la TRM.')),
        trmImplicita>0&&h('div',{style:{fontSize:11,marginTop:7,paddingTop:7,borderTop:'1px solid var(--bg3)',color:efectoTRM<0?'var(--red)':'var(--green)'}},
          'TRM implicita $'+fmtN(trmImplicita)+' vs pactada $'+fmtN(loan.trmAcordada)+'  →  efecto TRM '+(efectoTRM>=0?'+':'-')+fmt(Math.abs(efectoTRM))),
        lineaSaldoTras)
      :h('div',{style:{background:'rgba(63,185,80,.08)',border:'1px solid var(--green-bd)',borderRadius:12,padding:'10px 12px',marginBottom:4}},
        h(Fld,{label:'Monto del abono (COP) *'},
          h('input',{type:'text',inputMode:'numeric',value:fmtNumInput(monto),onChange:function(e){setMonto(parseNum(e.target.value));},placeholder:'0',className:'inp',style:{border:'1px solid var(--green)'}}),
          lineaSaldoTras)),
    // ── v2.0.0 — CTA "Liquidar deuda" ────────────────────────────────────────────
    // El monto excede el capital amortizable porque hay capital atrapado en cuotas En Mora.
    // Antes este monto viajaba al backend y rebotaba con un 400 criptico ("El abono supera el
    // saldo actual") aunque el usuario pagara justo lo que la pantalla decia que debia. Ahora
    // se explica el porque y se ofrece la herramienta correcta: la liquidacion, que SI cobra
    // capital futuro + capital en mora + intereses de mora en un solo movimiento.
    ctaLiquidar&&h('div',{style:{background:'var(--yellow-bg)',border:'1px solid var(--yellow)',borderRadius:12,padding:'12px 13px',marginTop:8,marginBottom:4}},
      h('div',{style:{fontSize:10,fontWeight:700,color:'var(--yellow)',letterSpacing:.5,marginBottom:7,display:'flex',alignItems:'center',gap:5}},
        h(Ico,{name:'alert',size:11,color:'var(--yellow)',sw:2.4}),'ESE MONTO SUPERA EL ABONO A CAPITAL'),
      h('div',{style:{fontSize:11,color:'var(--text2)',lineHeight:1.55}},
        'Un abono solo reduce el capital del cronograma futuro, que hoy es ',
        h('span',{style:{fontWeight:700,color:'var(--text)'}},fmt(saldoAbonable)),
        '. Los ',
        h('span',{style:{fontWeight:700,color:'var(--text)'}},fmt(capEnMora)),
        ' restantes estan en ',
        h('span',{style:{fontWeight:700,color:'var(--text)'}},moraCount+' cuota'+(moraCount!==1?'s':'')+' en mora'),
        ', que se cobran aparte junto con sus intereses.'),
      h('div',{style:{fontSize:11,color:'var(--text3)',lineHeight:1.5,marginTop:7}},
        'Para cobrar todo de una vez usa la liquidacion (capital + intereses en mora):'),
      onRequestLiquidar&&h('button',{onClick:function(){onRequestLiquidar(loan);},style:{width:'100%',marginTop:9,padding:'10px 12px',borderRadius:10,fontSize:13,fontWeight:700,cursor:'pointer',display:'flex',alignItems:'center',justifyContent:'center',gap:8,fontFamily:'inherit',background:'transparent',border:'1px solid var(--yellow)',color:'var(--yellow)',transition:'all .15s'}},
        h(Ico,{name:'dollar',size:14,color:'var(--yellow)',sw:2.4}),'Liquidar deuda ('+(esUSD?copToUsd(liquidacion,loan.trmAcordada):fmt(liquidacion))+')')),
    // ── OPCIONES DE RECALCULO (solo Capital + Intereses y con monto válido) ──
    esCapInt&&montoCapCOP>0&&saldoTras>0&&h('div',{style:{background:'rgba(88,166,255,.04)',border:'1px solid var(--blue-bd)',borderRadius:12,padding:'12px',marginTop:4,marginBottom:4}},
      h('div',{style:{fontSize:10,fontWeight:700,color:'var(--blue)',letterSpacing:.5,marginBottom:8,display:'flex',alignItems:'center',gap:5}},
        h(Ico,{name:'calc',size:11,color:'var(--blue)'}),' OPCIONES DE RECALCULO'),
      // Radio: Mantener plazo
      h('label',{style:{display:'flex',alignItems:'flex-start',gap:8,padding:'6px 0',cursor:'pointer'}},
        h('input',{type:'radio',name:'recalcMode',value:'mantener',checked:recalcMode==='mantener',onChange:function(){setRecalcMode('mantener');},style:{marginTop:2,accentColor:'var(--blue)',cursor:'pointer'}}),
        h('div',{style:{flex:1}},
          h('div',{style:{fontSize:12,color:'var(--text)',fontWeight:500}},'Mantener plazo (default)'),
          h('div',{style:{fontSize:10,color:'var(--text3)',marginTop:1}},'Conserva las '+cuotasRestantesActuales+' cuota'+(cuotasRestantesActuales!==1?'s':'')+' restantes. La cuota mensual baja.'))),
      // Radio: Modificar plazo
      h('label',{style:{display:'flex',alignItems:'flex-start',gap:8,padding:'6px 0',cursor:'pointer'}},
        h('input',{type:'radio',name:'recalcMode',value:'modificarPlazo',checked:recalcMode==='modificarPlazo',onChange:function(){setRecalcMode('modificarPlazo');},style:{marginTop:2,accentColor:'var(--blue)',cursor:'pointer'}}),
        h('div',{style:{flex:1}},
          h('div',{style:{fontSize:12,color:'var(--text)',fontWeight:500}},'Modificar plazo'),
          h('div',{style:{fontSize:10,color:'var(--text3)',marginTop:1}},'Tu eliges el nuevo numero de cuotas restantes.'),
          recalcMode==='modificarPlazo'&&h('input',{type:'text',inputMode:'numeric',value:nuevoPlazo,onChange:function(e){setNuevoPlazo(parseIntInput(e.target.value));},placeholder:'Ej: '+cuotasRestantesActuales,className:'inp',style:{marginTop:6,fontSize:13,border:'1px solid var(--blue)'}}))),
      // Radio: Fijar cuota
      h('label',{style:{display:'flex',alignItems:'flex-start',gap:8,padding:'6px 0',cursor:'pointer'}},
        h('input',{type:'radio',name:'recalcMode',value:'fijarCuota',checked:recalcMode==='fijarCuota',onChange:function(){setRecalcMode('fijarCuota');},style:{marginTop:2,accentColor:'var(--blue)',cursor:'pointer'}}),
        h('div',{style:{flex:1}},
          h('div',{style:{fontSize:12,color:'var(--text)',fontWeight:500}},'Fijar valor de cuota'),
          h('div',{style:{fontSize:10,color:'var(--text3)',marginTop:1}},'Tu eliges cuanto pagar de cuota; el plazo se ajusta.'),
          recalcMode==='fijarCuota'&&(esUSD
            ?h('div',{style:{marginTop:6}},
                h('input',{type:'text',inputMode:'decimal',value:nuevaCuotaFijaUSD,onChange:function(e){setNuevaCuotaFijaUSD(parseDecimalInput(e.target.value));},placeholder:'Cuota en USD (ej: 50.00)',className:'inp',style:{fontSize:13,border:'1px solid var(--blue)'}}),
                (+nuevaCuotaFijaUSD)>0&&h('div',{style:{fontSize:11,marginTop:4,color:'var(--text3)',fontFamily:'monospace'}},'Equivale a '+fmt(cuotaFijaEfectivaCOP)+' COP (TRM $'+fmtN(loan.trmAcordada)+')'))
            :h('input',{type:'text',inputMode:'numeric',value:fmtNumInput(nuevaCuotaFija),onChange:function(e){setNuevaCuotaFija(parseNum(e.target.value));},placeholder:'Cuota en COP',className:'inp',style:{marginTop:6,fontSize:13,border:'1px solid var(--blue)'}})))),
      // PREVIEW
      preview&&h('div',{style:{marginTop:10,paddingTop:10,borderTop:'1px solid var(--bg2)'}},
        preview.error?h('div',{style:{background:'var(--red-bg)',border:'1px solid var(--red-bd)',borderRadius:8,padding:'8px 10px',fontSize:11,color:'var(--red)',display:'flex',alignItems:'flex-start',gap:6}},
          h(Ico,{name:'alert',size:12,color:'var(--red)',sw:2.4}),
          h('span',null,preview.error)):
        h('div',null,
          h('div',{style:{fontSize:10,color:'var(--text3)',fontWeight:600,letterSpacing:.5,marginBottom:6}},'PREVIEW'),
          h('div',{style:{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'5px 0',fontSize:12,borderTop:'1px solid var(--bg3)'}},
            h('span',{style:{color:'var(--text2)'}},'Saldo restante'),
            h('div',{style:{textAlign:'right'}},
              h('div',{className:'mono',style:{color:'var(--text)',fontWeight:500}},fmt(saldoTras)),
              esUSD&&h('div',{className:'mono',style:{fontSize:10,color:'var(--blue)'}},copToUsd(saldoTras,loan.trmAcordada)))),
          h('div',{style:{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'5px 0',fontSize:12,borderTop:'1px solid var(--bg3)'}},
            h('span',{style:{color:'var(--text2)'}},'Nueva cuota mensual'),
            h('div',{style:{textAlign:'right'}},
              h('div',{className:'mono',style:{color:'var(--green)',fontWeight:500}},fmt(preview.cuota)),
              esUSD&&h('div',{className:'mono',style:{fontSize:10,color:'var(--blue)'}},copToUsd(preview.cuota,loan.trmAcordada)))),
          h('div',{style:{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'5px 0',fontSize:12,borderTop:'1px solid var(--bg3)'}},
            h('span',{style:{color:'var(--text2)'}},'Cuotas restantes'),
            h('span',{style:{color:'var(--text)',fontWeight:500}},preview.nCuotas)),
          preview.ultimaResidual>0&&preview.ultimaResidual<preview.cuota&&h('div',{style:{display:'flex',justifyContent:'space-between',alignItems:'flex-start',padding:'5px 0',fontSize:12,borderTop:'1px solid var(--bg3)'}},
            h('div',null,
              h('div',{style:{color:'var(--text2)'}},'Ultima cuota (ajuste)'),
              h('div',{style:{fontSize:10,color:'var(--text3)',marginTop:1}},'Saldo residual exacto')),
            h('div',{style:{textAlign:'right'}},
              h('div',{className:'mono',style:{color:'var(--yellow)',fontWeight:500}},fmt(preview.ultimaResidual)),
              esUSD&&h('div',{className:'mono',style:{fontSize:10,color:'var(--blue)'}},copToUsd(preview.ultimaResidual,loan.trmAcordada))))))),
    h(Fld,{label:'Fecha del abono'},h('input',{type:'date',value:fecha,onChange:function(e){setFecha(e.target.value);},className:'inp'})),
    h(Fld,{label:'Observaciones'},h('input',{value:obs,onChange:function(e){setObs(e.target.value);},placeholder:'Notas opcionales...',className:'inp'})),
    // v1.17.1 — el usuario decide si quiere el PDF (mismo patron que PayModal :4256)
    h('label',{style:{display:'flex',alignItems:'center',gap:8,marginTop:14,cursor:'pointer',fontSize:12,color:'var(--text2)'}},
      h('input',{type:'checkbox',checked:genRecibo,onChange:function(){setGenRecibo(!genRecibo);},style:{width:16,height:16,accentColor:'var(--blue)',cursor:'pointer'}}),
      'Generar recibo de abono'),
    h('button',{onClick:submit,disabled:btnOff,className:'btn-primary',style:{marginTop:8,background:btnOff?'var(--bg3)':'var(--blue-bg)',border:'1px solid '+(btnOff?'var(--border)':'var(--blue)'),color:btnOff?'var(--text3)':'var(--blue)',cursor:btnOff?'not-allowed':'pointer'}},sending?'Registrando...':'Registrar abono'));
}

// ── LiquidarModal (v2.0.0) ────────────────────────────────────────────────────
// ELEVADO desde DebtorModal a nivel App. Antes su estado (confirmLiq) vivia dentro
// de DebtorModal, asi que era inalcanzable desde AbonoModal (componente hermano; y
// cuando AbonoModal esta abierto, DebtorModal esta desmontado). Al subirlo:
//   - AbonoModal puede ofrecer el CTA "Liquidar deuda" cuando el abono excede el
//     capital amortizable por tener capital atrapado en cuotas En Mora (v2.0.0).
//   - Queda disponible para invocarse desde cualquier vista (p.ej. Cartera) a futuro.
// La UI y el calculo son IDENTICOS a v1.19.0: todo el desglose sale del helper
// centralizado computeLiquidacion (unica fuente de verdad del valor de liquidacion).
function LiquidarModal(props){
  var cLoan=props.loan,pays=props.pays||[],onConfirm=props.onConfirm,onClose=props.onClose;
  var ipm=useState(false); var incluyeProxMes=ipm[0]; var setIncluyeProxMes=ipm[1];
  var lqs=useState(false); var liqSending=lqs[0]; var setLiqSending=lqs[1]; // v1.18.1: guarda anti doble-submit
  var cEsUSD=cLoan.moneda==='USD';
  // v1.19.0 — TODO el desglose viene del helper centralizado computeLiquidacion (misma fuente
  // de verdad que la tarjeta, el cronograma PDF y el recibo de abono -> no pueden divergir).
  var L=computeLiquidacion(cLoan,pays,{incluyeProxMes:incluyeProxMes});
  var aplicaInteres=L.aplicaInteres;
  var mesTxt=fmt(L.moraValorMes)+'/mes'+(L.moraUniforme?'':' prom.');
  function rowLine(label,sublabel,monto,color,opaque){
    return h('div',{style:{display:'flex',justifyContent:'space-between',alignItems:'flex-start',padding:'10px 0',borderTop:'1px solid var(--bg3)',opacity:opaque?.45:1,transition:'opacity .2s'}},
      h('div',{style:{flex:1,paddingRight:8}},
        h('div',{style:{fontSize:12,color:'var(--text)',fontWeight:500}},label),
        sublabel&&h('div',{style:{fontSize:10,color:'var(--text3)',marginTop:2}},sublabel)),
      h('div',{style:{textAlign:'right'}},
        h('div',{className:'mono',style:{fontSize:13,fontWeight:600,color:color||'var(--text)'}},fmt(monto)),
        cEsUSD&&monto>0&&h('div',{className:'mono',style:{fontSize:10,color:'var(--blue)',fontWeight:400}},copToUsd(monto,cLoan.trmAcordada))));
  }
  return h(Modal,{onClose:onClose},
    h('div',{style:{fontWeight:700,fontSize:17,color:'var(--text)',marginBottom:2,display:'flex',alignItems:'center',gap:8}},
      h(Ico,{name:'dollar',size:16,color:'var(--red)',sw:2.4}),'Liquidar deuda'),
    h('div',{style:{fontSize:12,color:'var(--text3)',marginBottom:14}},cLoan.nombre+' • '+cLoan.modalidad+(aplicaInteres?' • '+cLoan.tasaMensual+'% mensual':'')),
    h('div',{style:{background:'var(--bg3)',borderRadius:12,padding:'4px 14px',border:'1px solid var(--border)',marginBottom:12}},
      rowLine('Capital pendiente','Saldo de la deuda',L.capitalPendiente,'var(--text)'),
      L.moraCount>0&&rowLine('Intereses atrasados',L.moraCount+' cuota'+(L.moraCount>1?'s':'')+' a '+mesTxt,L.intMora,'var(--yellow)'),
      L.partialPend>0&&rowLine('Abonos parciales','Ya recibidos',-Math.abs(L.partialPend),'var(--blue)'),
      L.incluyeProxMes&&rowLine('Interes adicional','1 mes a '+fmt(L.intProxMes)+'/mes ('+cLoan.tasaMensual+'% sobre el capital)',L.intProxMes,'var(--yellow)')),
    aplicaInteres&&h('label',{style:{display:'flex',alignItems:'center',gap:10,background:'var(--bg3)',border:'1px solid '+(incluyeProxMes?'var(--yellow)':'var(--border)'),borderRadius:10,padding:'10px 12px',marginBottom:12,cursor:'pointer',transition:'border-color .2s'}},
      h('input',{type:'checkbox',checked:incluyeProxMes,onChange:function(){setIncluyeProxMes(!incluyeProxMes);},style:{width:16,height:16,accentColor:'var(--yellow)',cursor:'pointer',margin:0}}),
      h('span',{style:{fontSize:13,color:'var(--text)',fontWeight:500}},'¿Incluir 1 mes de interes adicional? (+'+fmt(L.intProxMes)+')')),
    h('div',{style:{background:'var(--red-bg)',border:'1px solid var(--red-bd)',borderRadius:12,padding:'12px 14px',marginBottom:14,display:'flex',justifyContent:'space-between',alignItems:'center'}},
      h('div',null,
        h('div',{style:{fontSize:10,color:'var(--red)',fontWeight:600,letterSpacing:.5}},'TOTAL A LIQUIDAR'),
        h('div',{style:{fontSize:10,color:'var(--text3)',marginTop:2}},'Lo que debe entregarte el deudor')),
      h('div',{style:{textAlign:'right'}},
        h('div',{className:'mono',style:{fontSize:20,fontWeight:700,color:'var(--red)'}},fmt(L.total)),
        cEsUSD&&h('div',{className:'mono',style:{fontSize:11,color:'var(--blue)',fontWeight:500}},copToUsd(L.total,cLoan.trmAcordada)))),
    h('div',{style:{fontSize:11,color:'var(--text3)',marginBottom:14,lineHeight:1.5}},'Al confirmar, las cuotas pendientes y en mora se marcaran como pagadas y el prestamo se cerrara.'),
    h('button',{onClick:function(){_submitGuard(liqSending,setLiqSending,function(){return onConfirm(cLoan.id,L.capitalPendiente,L.intExtra);});},disabled:liqSending,className:'btn-primary',style:{background:liqSending?'var(--bg3)':'var(--red-bg)',border:'1px solid '+(liqSending?'var(--border)':'var(--red-bd)'),color:liqSending?'var(--text3)':'var(--red)',cursor:liqSending?'not-allowed':'pointer',marginBottom:6}},liqSending?'Procesando...':'Confirmar liquidacion'),
    h('button',{onClick:onClose,className:'btn-primary',style:{background:'var(--bg3)',border:'1px solid var(--border)',color:'var(--text2)'}},'Cancelar'));
}

// ── RestructureModal (v1.9.0) ─────────────────────────────────────────────────
// Permite reestructurar el cronograma de cuotas FUTURAS sin necesidad de hacer un
// abono a capital. Solo aplica para modalidad Capital + Intereses. Cuotas Pagadas
// y En Mora NO se tocan (deuda independiente). Reusa la logica de _pmt/_nper y los
// patrones visuales de AbonoModal.
function RestructureModal(props){
  var loan=props.loan,allPays=props.pays||[],onSave=props.onSave,onClose=props.onClose;
  var esUSD=loan.moneda==='USD';
  var sm=useState('modificarPlazo'); var recalcMode=sm[0]; var setRecalcMode=sm[1];
  var sp=useState(''); var nuevoPlazo=sp[0]; var setNuevoPlazo=sp[1];
  var sc=useState(''); var nuevaCuotaFija=sc[0]; var setNuevaCuotaFija=sc[1];
  var scu=useState(''); var nuevaCuotaFijaUSD=scu[0]; var setNuevaCuotaFijaUSD=scu[1];
  var sub=useState(false); var isSubmitting=sub[0]; var setIsSubmitting=sub[1];
  // Cuota fija efectiva en COP (auto-convertida de USD cuando aplica)
  var cuotaFijaEfectivaCOP=esUSD?Math.round((+nuevaCuotaFijaUSD||0)*(+loan.trmAcordada||1)):(+nuevaCuotaFija||0);
  // Saldo real (sin abono, no se toca el capital)
  var originalCOP=esUSD?Math.round(loan.montoOrigen*loan.trmAcordada):Math.round(loan.montoOrigen);
  var loanPays=allPays.filter(function(p){return String(p.prestamoId)===String(loan.id);});
  var todoCapPagado=loanPays.filter(function(p){return p.estadoPago==='Pagado';}).reduce(function(s,p){return s+p.abonoCapital;},0);
  var saldoActual=Math.max(0,originalCOP-todoCapPagado);
  var intMora=loanPays.filter(function(p){return p.estadoPago==='En Mora'&&p.id.indexOf('-ab-')===-1;}).reduce(function(s,p){return s+p.interesPeriodo;},0);
  // Cuotas consumidas (Pagado + Mora, excluyendo abonos) — define el nextRegularN
  var regulares=loanPays.filter(function(p){return p.id.indexOf('-ab-')===-1;});
  var regularConsumed=regulares.filter(function(p){return p.estadoPago==='Pagado'||p.estadoPago==='En Mora';}).length;
  var plazoOriginal=+loan.plazoMeses||12;
  var cuotasRestantesActuales=Math.max(1,plazoOriginal-regularConsumed);
  // Preview en vivo
  var preview=function(){
    if(saldoActual<=0) return null;
    var r=_tasaPeriodo((+loan.tasaMensual||0)/100,loan.frecuencia||'Mensual');
    var interesPrimerPeriodo=Math.round(saldoActual*r);
    if(recalcMode==='modificarPlazo'){
      var nN=parseInt(nuevoPlazo,10);
      if(!nN||nN<1) return {modo:'modificarPlazo',cuota:0,nCuotas:0,interesP:interesPrimerPeriodo,error:'Ingresa un numero de cuotas valido (>= 1).',ultimaResidual:0};
      var pmtMod=Math.round(_pmt(r,nN,saldoActual));
      return {modo:'modificarPlazo',cuota:pmtMod,nCuotas:nN,interesP:interesPrimerPeriodo,error:null,ultimaResidual:0};
    }
    if(recalcMode==='fijarCuota'){
      var pmtFijo=cuotaFijaEfectivaCOP;
      if(pmtFijo<=0) return {modo:'fijarCuota',cuota:0,nCuotas:0,interesP:interesPrimerPeriodo,error:'Ingresa una cuota valida (> 0).',ultimaResidual:0};
      if(pmtFijo<=interesPrimerPeriodo) return {modo:'fijarCuota',cuota:pmtFijo,nCuotas:0,interesP:interesPrimerPeriodo,error:'La cuota debe ser mayor a '+fmt(interesPrimerPeriodo)+(esUSD?' ('+copToUsd(interesPrimerPeriodo,loan.trmAcordada)+')':'')+' que son los intereses del primer periodo. Con esta cuota nunca se saldaria la deuda.',ultimaResidual:0};
      var nCalc=_nper(r,pmtFijo,saldoActual);
      var nEnt=Math.ceil(nCalc);
      var sR=saldoActual,resid=0;
      for(var i=0;i<nEnt-1;i++){var intI=sR*r;var capI=pmtFijo-intI;sR=sR-capI;}
      if(sR>0){resid=Math.round((sR+sR*r)*100)/100;}
      return {modo:'fijarCuota',cuota:pmtFijo,nCuotas:nEnt,interesP:interesPrimerPeriodo,error:null,ultimaResidual:resid};
    }
    return null;
  }();
  function submit(){
    if(isSubmitting) return;
    if(saldoActual<=0){showError('El prestamo no tiene saldo pendiente');return;}
    if(preview&&preview.error){showError(preview.error);return;}
    var valor=null;
    if(recalcMode==='modificarPlazo') valor=parseInt(nuevoPlazo,10);
    else if(recalcMode==='fijarCuota') valor=cuotaFijaEfectivaCOP;
    if(!valor||valor<=0){showError('Completa el valor');return;}
    // v1.18.1 — la liberacion se ata a la PROMESA, no a un setTimeout de 5s. El timer era
    // una guarda con fecha de caducidad: si el POST tardaba mas de 5 segundos el boton se
    // rehabilitaba con la peticion aun en vuelo y el doble submit volvia a ser posible.
    // Si onSave devuelve undefined (rama de pre-flight de mora) se libera de inmediato,
    // porque el control pasa al PreflightMoraModal y este modal ya no decide nada.
    _submitGuard(isSubmitting,setIsSubmitting,function(){return onSave(loan.id,recalcMode,valor);});
  }
  return h(Modal,{onClose:onClose},
    h('div',{style:{fontWeight:700,fontSize:16,color:'var(--text)',marginBottom:4,display:'flex',alignItems:'center',gap:8}},
      h(Ico,{name:'calc',size:18,color:'var(--blue)'}),' Reestructurar cuotas'),
    h('div',{style:{background:'var(--bg3)',borderRadius:12,padding:'13px 14px',marginBottom:14,border:'1px solid var(--border)'}},
      h('div',{style:{fontWeight:700,fontSize:14,color:'var(--text)'}},loan.nombre),
      h('div',{style:{fontSize:12,color:'var(--text2)',marginTop:3}},loan.modalidad),
      h('div',{className:'mono',style:{fontWeight:700,fontSize:18,color:'var(--green)',marginTop:6}},'Saldo de capital: '+fmt(saldoActual),
        esUSD&&h('span',{style:{fontSize:13,fontWeight:600,color:'var(--blue)',marginLeft:8}},copToUsd(saldoActual,loan.trmAcordada))),
      intMora>0&&h('div',{className:'mono',style:{fontSize:11,color:'var(--yellow)',marginTop:4}},'Intereses en mora (no se tocan): '+fmt(intMora))),
    // Info box
    h('div',{style:{background:'rgba(88,166,255,.06)',border:'1px solid var(--blue-bd)',borderRadius:12,padding:'10px 12px',marginBottom:12}},
      h('div',{style:{fontSize:10,fontWeight:700,color:'var(--blue)',letterSpacing:.5,marginBottom:6,display:'flex',alignItems:'center',gap:5}},
        h(Ico,{name:'alert',size:11,color:'var(--blue)',sw:2.4}),'COMO FUNCIONA'),
      h('div',{style:{fontSize:11,color:'var(--text2)',lineHeight:1.5}},
        '• Solo se recalculan las cuotas ',h('b',null,'Pendientes'),' (futuras).',h('br',null),
        '• Las cuotas ',h('b',null,'Pagadas y En Mora'),' quedan intactas como deuda independiente.',h('br',null),
        '• El saldo de capital pendiente ',h('b',null,'no cambia'),' (no hay abono).')),
    // Radios
    h('div',{style:{background:'rgba(88,166,255,.04)',border:'1px solid var(--blue-bd)',borderRadius:12,padding:'12px',marginBottom:12}},
      h('div',{style:{fontSize:10,fontWeight:700,color:'var(--blue)',letterSpacing:.5,marginBottom:8,display:'flex',alignItems:'center',gap:5}},
        h(Ico,{name:'calc',size:11,color:'var(--blue)'}),' OPCIONES'),
      h('label',{style:{display:'flex',alignItems:'flex-start',gap:8,padding:'6px 0',cursor:'pointer'}},
        h('input',{type:'radio',name:'reestrMode',value:'modificarPlazo',checked:recalcMode==='modificarPlazo',onChange:function(){setRecalcMode('modificarPlazo');},style:{marginTop:2,accentColor:'var(--blue)',cursor:'pointer'}}),
        h('div',{style:{flex:1}},
          h('div',{style:{fontSize:12,color:'var(--text)',fontWeight:500}},'Modificar plazo'),
          h('div',{style:{fontSize:10,color:'var(--text3)',marginTop:1}},'Tu eliges el nuevo numero de cuotas restantes (actual: '+cuotasRestantesActuales+').'),
          recalcMode==='modificarPlazo'&&h('input',{type:'text',inputMode:'numeric',value:nuevoPlazo,onChange:function(e){setNuevoPlazo(parseIntInput(e.target.value));},placeholder:'Ej: '+cuotasRestantesActuales,className:'inp',style:{marginTop:6,fontSize:13,border:'1px solid var(--blue)'}}))),
      h('label',{style:{display:'flex',alignItems:'flex-start',gap:8,padding:'6px 0',cursor:'pointer'}},
        h('input',{type:'radio',name:'reestrMode',value:'fijarCuota',checked:recalcMode==='fijarCuota',onChange:function(){setRecalcMode('fijarCuota');},style:{marginTop:2,accentColor:'var(--blue)',cursor:'pointer'}}),
        h('div',{style:{flex:1}},
          h('div',{style:{fontSize:12,color:'var(--text)',fontWeight:500}},'Fijar valor de cuota'),
          h('div',{style:{fontSize:10,color:'var(--text3)',marginTop:1}},'Tu eliges cuanto pagar de cuota; el plazo se ajusta.'),
          recalcMode==='fijarCuota'&&(esUSD
            ?h('div',{style:{marginTop:6}},
                h('input',{type:'text',inputMode:'decimal',value:nuevaCuotaFijaUSD,onChange:function(e){setNuevaCuotaFijaUSD(parseDecimalInput(e.target.value));},placeholder:'Cuota en USD (ej: 50.00)',className:'inp',style:{fontSize:13,border:'1px solid var(--blue)'}}),
                (+nuevaCuotaFijaUSD)>0&&h('div',{style:{fontSize:11,marginTop:4,color:'var(--text3)',fontFamily:'monospace'}},'Equivale a '+fmt(cuotaFijaEfectivaCOP)+' COP (TRM $'+fmtN(loan.trmAcordada)+')'))
            :h('input',{type:'text',inputMode:'numeric',value:fmtNumInput(nuevaCuotaFija),onChange:function(e){setNuevaCuotaFija(parseNum(e.target.value));},placeholder:'Cuota en COP',className:'inp',style:{marginTop:6,fontSize:13,border:'1px solid var(--blue)'}})))),
      // PREVIEW
      preview&&h('div',{style:{marginTop:10,paddingTop:10,borderTop:'1px solid var(--bg2)'}},
        preview.error?h('div',{style:{background:'var(--red-bg)',border:'1px solid var(--red-bd)',borderRadius:8,padding:'8px 10px',fontSize:11,color:'var(--red)',display:'flex',alignItems:'flex-start',gap:6}},
          h(Ico,{name:'alert',size:12,color:'var(--red)',sw:2.4}),
          h('span',null,preview.error)):
        h('div',null,
          h('div',{style:{fontSize:10,color:'var(--text3)',fontWeight:600,letterSpacing:.5,marginBottom:6}},'PREVIEW'),
          h('div',{style:{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'5px 0',fontSize:12,borderTop:'1px solid var(--bg3)'}},
            h('span',{style:{color:'var(--text2)'}},'Saldo de capital (no cambia)'),
            h('div',{style:{textAlign:'right'}},
              h('div',{className:'mono',style:{color:'var(--text)',fontWeight:500}},fmt(saldoActual)),
              esUSD&&h('div',{className:'mono',style:{fontSize:10,color:'var(--blue)'}},copToUsd(saldoActual,loan.trmAcordada)))),
          h('div',{style:{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'5px 0',fontSize:12,borderTop:'1px solid var(--bg3)'}},
            h('span',{style:{color:'var(--text2)'}},'Nueva cuota'),
            h('div',{style:{textAlign:'right'}},
              h('div',{className:'mono',style:{color:'var(--green)',fontWeight:500}},fmt(preview.cuota)),
              esUSD&&h('div',{className:'mono',style:{fontSize:10,color:'var(--blue)'}},copToUsd(preview.cuota,loan.trmAcordada)))),
          h('div',{style:{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'5px 0',fontSize:12,borderTop:'1px solid var(--bg3)'}},
            h('span',{style:{color:'var(--text2)'}},'Cuotas restantes'),
            h('span',{style:{color:'var(--text)',fontWeight:500}},preview.nCuotas)),
          preview.ultimaResidual>0&&preview.ultimaResidual<preview.cuota&&h('div',{style:{display:'flex',justifyContent:'space-between',alignItems:'flex-start',padding:'5px 0',fontSize:12,borderTop:'1px solid var(--bg3)'}},
            h('div',null,
              h('div',{style:{color:'var(--text2)'}},'Ultima cuota (ajuste)'),
              h('div',{style:{fontSize:10,color:'var(--text3)',marginTop:1}},'Saldo residual exacto')),
            h('div',{style:{textAlign:'right'}},
              h('div',{className:'mono',style:{color:'var(--yellow)',fontWeight:500}},fmt(preview.ultimaResidual)),
              esUSD&&h('div',{className:'mono',style:{fontSize:10,color:'var(--blue)'}},copToUsd(preview.ultimaResidual,loan.trmAcordada))))))),
    h('button',{onClick:submit,disabled:isSubmitting||(preview&&!!preview.error),className:'btn-primary',style:{marginTop:8,opacity:isSubmitting?.6:1,background:(preview&&preview.error)?'var(--bg3)':'var(--blue-bg)',border:'1px solid '+((preview&&preview.error)?'var(--border)':'var(--blue)'),color:(preview&&preview.error)?'var(--text3)':'var(--blue)',cursor:(isSubmitting||(preview&&preview.error))?'not-allowed':'pointer'}},isSubmitting?'Reestructurando...':'Aplicar reestructuracion'));
}

// ── LoanModal ─────────────────────────────────────────────────────────────────
function LoanModal(props){
  var loan=props.loan,trm=props.trm,onSave=props.onSave,onClose=props.onClose;
  var allPays=props.pays||[];
  var prefill=loan&&loan._prefill||{};
  var calcPre=loan&&loan._calcPrefill||{};
  // v1.9.0 — Bloqueo de campos sensibles: si el prestamo tiene actividad financiera
  // (cuotas pagadas, abonos a capital o cuotas en mora), los campos que afectan a la
  // amortizacion (PMT/NPER/fechas/TRM) quedan deshabilitados para preservar la integridad
  // matematica del cronograma ya pactado con el deudor.
  var hasActivity=(function(){
    if(!loan||!loan.id) return false;
    return allPays.some(function(p){
      if(String(p.prestamoId)!==String(loan.id)) return false;
      if(p.estadoPago==='Pagado') return true;          // cuotas pagadas o abonos a capital
      if(p.estadoPago==='En Mora') return true;          // cuotas en mora (deuda causada)
      return false;
    });
  })();
  var lockSens=hasActivity&&!(loan&&(loan._prefill||loan._calcPrefill)); // solo bloquea en edicion real, no en prefill desde calc
  var fs=useState({
    nombre:prefill.nombre||loan&&loan.nombre||'',cedula:prefill.cedula||loan&&loan.cedula||'',telefono:prefill.telefono||loan&&loan.telefono||'',
    moneda:calcPre.moneda||loan&&loan.moneda||'COP',montoOrigen:calcPre.montoOrigen||loan&&loan.montoOrigen||'',
    trmAcordada:calcPre.trmAcordada||loan&&loan.trmAcordada||trm,tasaMensual:calcPre.tasaMensual||loan&&loan.tasaMensual||'',
    plazoMeses:calcPre.plazoMeses||loan&&loan.plazoMeses||'',modalidad:calcPre.modalidad||(loan&&loan.modalidad==='Intereses Indefinido'?'Intereses':(loan&&loan.modalidad||'Intereses')),
    frecuencia:calcPre.frecuencia||loan&&loan.frecuencia||'Mensual',
    fechaInicio:loan&&loan.fechaInicio||nowStr(),
    fechaDevolucion:loan&&loan.fechaDevolucion||'',
    // v1.10.0 — campos para modalidad Pago Unico
    // gananciaFija siempre se persiste en COP; gananciaInput es el valor visible (puede ser % o COP)
    gananciaFija:loan&&loan.gananciaFija||0,
    // v1.12.x FIX: al EDITAR un Pago Unico con ganancia guardada, reconstruir el modo. Solo se
    // persiste gananciaFija (COP absoluto), NO el modo original -> lo representamos como "monto
    // fijo" (exacto, sin perdida). El input va en la moneda del prestamo (USD = gananciaFija/TRM).
    // Antes quedaba fijo en 'pct' con el COP absoluto en el input -> calculaba 25000% del capital.
    gananciaMode:(loan&&loan.modalidad==='Pago Unico'&&(+loan.gananciaFija||0)>0)?'monto':'pct',
    gananciaInput:(loan&&(+loan.gananciaFija||0)>0)
      ?String(Math.round((loan.moneda==='USD'&&(+loan.trmAcordada||0)>0)?(+loan.gananciaFija/+loan.trmAcordada):+loan.gananciaFija))
      :'',
    estado:loan&&loan.estado||'Activo',notas:loan&&loan.notas||''
  });
  var f=fs[0]; var setF=fs[1];
  var isNew=!loan||!!loan._prefill||!!loan._calcPrefill;
  function set(k,v){setF(function(p){var n=Object.assign({},p);n[k]=v;return n;});}
  // v1.11.x — Selector "Cliente nuevo / existente" (solo al dar de alta un prestamo). La app asocia por
  // NOMBRE (no hay persona_id): elegir un cliente existente reusa su nombre/cedula/telefono y el backend
  // lo consolida en el mismo perfil (identico a crear el prestamo desde el perfil del deudor).
  var clientes=props.clientes||[];
  var coS=useState(false); var clientOpen=coS[0]; var setClientOpen=coS[1];
  // QA7: elegir una sugerencia prefilla los datos del cliente existente (asocia por nombre; el
  // backend lo consolida igual que crear el prestamo desde el perfil del deudor).
  function pickCliente(c){
    setF(function(p){return Object.assign({},p,{nombre:c.nombre,cedula:c.cedula||'',telefono:c.telefono||''});});
    setClientOpen(false);
  }
  // Autocompletado hibrido sobre el campo Nombre: filtra clientes por substring; oculto si el input
  // esta vacio o coincide exacto con un cliente (mismo patron que DebtModal).
  var cliQ=(f.nombre||'').trim(), cliQL=cliQ.toLowerCase();
  var cliExact=clientes.some(function(c){return (c.nombre||'').toLowerCase()===cliQL;});
  var clientesMatch=(cliQ&&!cliExact)?clientes.filter(function(c){return (c.nombre||'').toLowerCase().indexOf(cliQL)!==-1;}).slice(0,8):[];
  var cliOpen=clientOpen&&clientesMatch.length>0;
  // Compras fraccionadas de USD
  var comprasIniciales=function(){
    if(loan&&loan.comprasUSD){try{var p=typeof loan.comprasUSD==='string'?JSON.parse(loan.comprasUSD):loan.comprasUSD;if(Array.isArray(p)&&p.length>0)return p.map(function(c){return {monto:c.monto,tasa:c.tasa,totalCOP:((+c.monto)>0&&(+c.tasa)>0)?Math.round((+c.monto)*(+c.tasa)):''};});}catch(_){}}
    return [{monto:'',tasa:'',totalCOP:''},{monto:'',tasa:'',totalCOP:''}];
  };
  var cus=useState(comprasIniciales()); var compras=cus[0]; var setCompras=cus[1];
  var cfs=useState(!!(loan&&loan.comprasUSD&&loan.comprasUSD.length>2)); var compraFrac=cfs[0]; var setCompraFrac=cfs[1];
  // v1.11.x — "Total pagado en COP" del modo simple: auxiliar de UI (NO se persiste). Init derivado al editar.
  var tcS=useState(loan&&loan.moneda==='USD'&&(+loan.trmAcordada)>0&&(+loan.montoOrigen)>0?Math.round((+loan.montoOrigen)*(+loan.trmAcordada)):''); var totalCOPInput=tcS[0]; var setTotalCOPInput=tcS[1];
  // Cálculo ponderado en vivo (solo filas con valores válidos)
  var comprasValidas=compras.filter(function(c){return (+c.monto)>0&&(+c.tasa)>0;});
  var totalUSDComprado=comprasValidas.reduce(function(s,c){return s+(+c.monto);},0);
  var totalCOPInvertido=comprasValidas.reduce(function(s,c){return s+(+c.monto)*(+c.tasa);},0);
  var tasaPromedio=totalUSDComprado>0?Math.round(totalCOPInvertido/totalUSDComprado):0;
  var aplicaFracc=f.moneda==='USD'&&compraFrac;
  // Cuando hay compras fraccionadas válidas, la trmAcordada efectiva es la promedio
  var trmEfectiva=aplicaFracc&&tasaPromedio>0?tasaPromedio:(+f.trmAcordada||0);
  var excedeMonto=aplicaFracc&&(+f.montoOrigen||0)>0&&totalUSDComprado>(+f.montoOrigen||0);
  var faltaUSD=aplicaFracc&&(+f.montoOrigen||0)>0&&totalUSDComprado>0&&totalUSDComprado<(+f.montoOrigen||0);
  function setCompra(i,k,v){setCompras(function(prev){var n=prev.slice();n[i]=Object.assign({},n[i]);n[i][k]=v;return n;});}
  // Derivacion por fila: monto USD + (tasa | totalCOP) -> calcula el faltante. Todo sincronico (sin useEffect).
  function setCompraField(i,field,value){
    setCompras(function(prev){
      var n=prev.slice(); var row=Object.assign({},n[i]); row[field]=value;
      var usd=+row.monto||0;
      if(field==='totalCOP'){ if(usd>0) row.tasa=(+value)>0?Math.round((+value)/usd):''; }
      else if(field==='tasa'){ if(usd>0) row.totalCOP=(+value)>0?Math.round((+value)*usd):''; }
      else if(field==='monto'){ if(usd>0){ if((+row.tasa)>0) row.totalCOP=Math.round((+row.tasa)*usd); else if((+row.totalCOP)>0) row.tasa=Math.round((+row.totalCOP)/usd); } }
      n[i]=row; return n;
    });
  }
  function addCompra(){setCompras(function(prev){return prev.concat([{monto:'',tasa:'',totalCOP:''}]);});}
  function delCompra(i){setCompras(function(prev){if(prev.length<=1)return prev;var n=prev.slice();n.splice(i,1);return n;});}
  // Modo simple: Tasa <-> Total COP derivados via Capital USD (todo sincronico, sin useEffect -> sin loops)
  function syncSimpleFromTasa(v){ set('trmAcordada',v); var usd=+f.montoOrigen||0; if(usd>0) setTotalCOPInput((+v)>0?Math.round((+v)*usd):''); }
  function syncSimpleFromTotal(v){ setTotalCOPInput(v); var usd=+f.montoOrigen||0; if(usd>0) set('trmAcordada',(+v)>0?Math.round((+v)/usd):''); }
  function syncMonto(raw){ var v=parseNum(raw); set('montoOrigen',v); if(f.moneda==='USD'&&!compraFrac){ var usd=+v||0; if(usd>0){ if((+f.trmAcordada)>0) setTotalCOPInput(Math.round((+f.trmAcordada)*usd)); else if((+totalCOPInput)>0) set('trmAcordada',Math.round((+totalCOPInput)/usd)); } } }
  var esSI=f.modalidad==='Intereses';
  var esUnaCuota=f.modalidad==='Prestamo'||f.modalidad==='Pago Unico'; // v1.10.0: ambas son 1 cuota
  var montoCOP=f.moneda==='USD'?Math.round((+f.montoOrigen||0)*(trmEfectiva||1)):(+f.montoOrigen||0);
  // v1.10.0 — Calculo de ganancia para Pago Unico segun modo elegido
  // gananciaCOPCalc es el valor efectivo en COP que se va a persistir/mostrar
  var gananciaCOPCalc=(function(){
    if(f.modalidad!=='Pago Unico') return 0;
    var val=+f.gananciaInput||0;
    if(val<=0) return 0;
    if(f.gananciaMode==='pct') return Math.round(montoCOP*val/100);
    // modo 'monto': si la moneda es USD el input son USD → convertir a COP con TRM
    if(f.moneda==='USD'&&trmEfectiva>0) return Math.round(val*trmEfectiva);
    return Math.round(val);
  })();
  // % implicito derivado para el indicador de equivalencia
  var gananciaPctImpl=montoCOP>0?Math.round(gananciaCOPCalc/montoCOP*10000)/100:0;
  var preview=useMemo(function(){
    if(!montoCOP) return {cuota:0,totalInt:0,rows:[],totalPagar:0};
    var n=+f.plazoMeses||12;
    var rMensual=+f.tasaMensual/100;
    var freq=f.frecuencia||'Mensual';
    var r=freq==='Semanal'?rMensual/4.33:freq==='Quincenal'?rMensual/2:rMensual;
    var c;
    if(f.modalidad==='Prestamo'){c=montoCOP;}
    else if(f.modalidad==='Pago Unico'){c=montoCOP+gananciaCOPCalc;}
    else if(f.modalidad==='Intereses'){c=Math.round(montoCOP*r);}
    else{c=Math.round(pmt(r,n,montoCOP));}
    // Cronograma tentativo (mismo algoritmo que CalcView)
    var rows=[];
    if(c>0){
      if(f.modalidad==='Prestamo'){
        rows.push({n:1,interes:0,capital:montoCOP,cuota:montoCOP,saldo:0});
      } else if(f.modalidad==='Pago Unico'){
        // v1.10.0 — 1 cuota: interes = ganancia, capital = montoCOP
        rows.push({n:1,interes:gananciaCOPCalc,capital:montoCOP,cuota:montoCOP+gananciaCOPCalc,saldo:0});
      } else {
        var saldoSim=montoCOP;
        var nFilas=f.modalidad==='Intereses'?Math.min(n||12,24):n;
        for(var i=0;i<nFilas;i++){
          var intI=Math.round(saldoSim*r);
          var isLast=i===nFilas-1;
          var capI,cuotaI;
          if(f.modalidad==='Intereses'){
            capI=0; cuotaI=intI;
          } else {
            capI=isLast?Math.round(saldoSim):Math.round(c-intI);
            cuotaI=isLast?Math.round(intI+saldoSim):c;
          }
          var sf=Math.max(0,Math.round(saldoSim-capI));
          rows.push({n:i+1,interes:intI,capital:capI,cuota:cuotaI,saldo:sf});
          saldoSim=sf;
        }
      }
    }
    var totalInt=rows.reduce(function(s,r){return s+r.interes;},0);
    var totalPagar=rows.reduce(function(s,r){return s+r.cuota;},0);
    return {cuota:c,totalInt:totalInt,rows:rows,totalPagar:totalPagar};
  },[montoCOP,f.tasaMensual,f.plazoMeses,f.modalidad,f.frecuencia,gananciaCOPCalc]);
  var scs=useState(false); var showCronoLoan=scs[0]; var setShowCronoLoan=scs[1];
  // Anti-doble-clic: bloquea el boton tras el primer click para evitar duplicados
  var sub=useState(false); var isSubmitting=sub[0]; var setIsSubmitting=sub[1];
  function submit(){
    if(isSubmitting) return; // bloqueo defensivo
    var needsPlazo=f.modalidad==='Capital + Intereses';
    var errores=[];
    if(!f.nombre.trim()) errores.push('Nombre');
    if(!f.montoOrigen||+f.montoOrigen<=0) errores.push('Monto');
    if(needsPlazo&&(!f.plazoMeses||+f.plazoMeses<=0)) errores.push('Plazo');
    if(errores.length>0){showError('Falta completar: '+errores.join(', '));return;}
    if(aplicaFracc&&comprasValidas.length===0){showError('Agrega al menos una compra valida o desactiva las compras fraccionadas');return;}
    if(aplicaFracc&&excedeMonto){showError('El total de compras ('+Math.round(totalUSDComprado).toLocaleString('es-CO')+' USD) excede el monto del prestamo');return;}
    var esPrestamo=f.modalidad==='Prestamo';
    var esPagoUnico=f.modalidad==='Pago Unico';
    var esUnaCuotaSubmit=esPrestamo||esPagoUnico;
    if(esUnaCuotaSubmit&&!f.fechaDevolucion){showError('Falta la fecha de pago');return;}
    // v1.10.0 — Pago Unico debe tener ganancia >= 0 (puede ser 0 si el user quiere sin ganancia)
    if(esPagoUnico&&(+f.gananciaInput||0)<0){showError('La ganancia no puede ser negativa');return;}
    var base=isNew?{}:(loan||{});
    var diaPagoAuto=new Date(f.fechaInicio+'T12:00:00').getDate();
    var trmFinal=aplicaFracc&&tasaPromedio>0?tasaPromedio:(+f.trmAcordada||0);
    var comprasFinal=aplicaFracc&&comprasValidas.length>0?JSON.stringify(comprasValidas.map(function(c){return {monto:+c.monto,tasa:+c.tasa};})):'';
    var extra={
      montoOrigen:+f.montoOrigen,trmAcordada:trmFinal,montoCOP:montoCOP,
      tasaMensual:esUnaCuotaSubmit?0:(+f.tasaMensual||0),
      plazoMeses:esUnaCuotaSubmit?1:(+f.plazoMeses||0),
      diaPago:diaPagoAuto,
      frecuencia:esUnaCuotaSubmit?'Mensual':(f.frecuencia||'Mensual'),
      comprasUSD:comprasFinal,
      gananciaFija:esPagoUnico?gananciaCOPCalc:0
    };
    if(esUnaCuotaSubmit&&f.fechaDevolucion) extra.fechaDevolucion=f.fechaDevolucion;
    // Defense-in-depth (v1.9.0): si los campos sensibles estan bloqueados, sobrescribir
    // con los valores ORIGINALES del prestamo antes de enviar al backend. Asi, aunque el
    // `disabled` falle por algun bug de UI, la BD nunca se corrompe.
    // (Object.assign({},base,f,extra) hace que `extra` gane sobre `f` — sufuciente.)
    if(lockSens&&loan){
      extra.moneda=loan.moneda;
      extra.montoOrigen=loan.montoOrigen;
      extra.trmAcordada=loan.trmAcordada;
      extra.montoCOP=loan.montoCOP;
      extra.tasaMensual=loan.tasaMensual;
      extra.plazoMeses=loan.plazoMeses;
      extra.modalidad=loan.modalidad;
      extra.frecuencia=loan.frecuencia;
      extra.fechaInicio=loan.fechaInicio;
      extra.fechaDevolucion=loan.fechaDevolucion||'';
      extra.comprasUSD=loan.comprasUSD||'';
      // v1.10.0: gananciaFija tambien queda bloqueada si hay actividad
      extra.gananciaFija=loan.gananciaFija||0;
    }
    setIsSubmitting(true);
    onSave(Object.assign({},base,f,extra));
    // Safety net: si por alguna razon el modal sigue abierto despues de 5s, re-habilitar el boton
    setTimeout(function(){setIsSubmitting(false);},5000);
  }
  return h(Modal,{onClose:onClose,tall:true,wide:true},
    h('div',{style:{fontWeight:700,fontSize:16,color:'var(--text)',marginBottom:4}},!isNew?'Editar Prestamo':'Nuevo Prestamo'),
    // v1.9.0 — Banner de campos bloqueados (solo en edicion con actividad)
    lockSens&&h('div',{style:{background:'var(--yellow-bg)',border:'1px solid var(--yellow)',borderRadius:10,padding:'10px 12px',marginBottom:10,display:'flex',alignItems:'flex-start',gap:8}},
      h(Ico,{name:'alert',size:14,color:'var(--yellow)',sw:2.4}),
      h('div',{style:{flex:1}},
        h('div',{style:{fontSize:12,color:'var(--yellow)',fontWeight:700,marginBottom:2}},'Algunos campos estan bloqueados'),
        h('div',{style:{fontSize:11,color:'var(--text2)',lineHeight:1.4}},'Este prestamo ya registra pagos, abonos o cuotas en mora. Para preservar la integridad del cronograma pactado, los campos que afectan a la amortizacion no se pueden modificar.'))),
    // QA7 — Cliente: input unico con autocompletado hibrido (reemplaza las pestañas nuevo/existente).
    // Texto libre = cliente nuevo; elegir una sugerencia prefilla nombre/cedula/telefono (existente)
    // y el backend lo consolida por nombre (saveLoan auto-vincula). Misma estetica que DebtModal.
    h(Fld,{label:'Nombre del cliente *'},
      h('div',{style:{position:'relative'}},
        h('input',{value:f.nombre,onChange:function(e){set('nombre',e.target.value);setClientOpen(true);},onFocus:function(){setClientOpen(true);},onBlur:function(){setClientOpen(false);},placeholder:'Nombre completo',className:'inp',autoFocus:isNew,autoComplete:'off'}),
        cliOpen?h('div',{style:{position:'absolute',top:'100%',left:0,right:0,zIndex:30,marginTop:4,background:'var(--bg3)',border:'1px solid var(--border)',borderRadius:10,boxShadow:'0 8px 24px rgba(0,0,0,.35)',overflow:'hidden',maxHeight:200,overflowY:'auto'}},
          clientesMatch.map(function(c){
            var sub=[c.cedula&&c.cedula!=='0'?'CC '+c.cedula:'',c.telefono&&c.telefono!=='0'?c.telefono:''].filter(Boolean).join('  ·  ');
            return h('div',{key:c.nombre,onMouseDown:function(e){e.preventDefault();pickCliente(c);},onMouseEnter:function(e){e.currentTarget.style.background='var(--bg4)';},onMouseLeave:function(e){e.currentTarget.style.background='transparent';},style:{padding:'9px 12px',cursor:'pointer',transition:'background .12s',display:'flex',alignItems:'center',gap:8}},
              h(Ico,{name:'users',size:13,color:'var(--text3)'}),
              h('div',{style:{minWidth:0}},
                h('div',{style:{fontSize:13,fontWeight:600,color:'var(--text)',whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis'}},c.nombre),
                sub?h('div',{style:{fontSize:11,color:'var(--text3)',marginTop:1,whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis'}},sub):null));
          })):null)),
    h('div',{style:{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10}},
      h(Fld,{label:'Cedula / ID'},h('input',{value:f.cedula,  onChange:function(e){set('cedula',  e.target.value);},placeholder:'0000000',className:'inp'})),
      h(Fld,{label:'Telefono'},   h('input',{value:f.telefono,onChange:function(e){set('telefono',e.target.value);},placeholder:'+57...',  className:'inp'}))),
    h('div',{style:{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10}},
      h(Fld,{label:'Moneda'},h('select',{value:f.moneda,onChange:function(e){set('moneda',e.target.value);},className:'inp',disabled:lockSens,style:lockSens?{background:'var(--bg3)',color:'var(--text3)',cursor:'not-allowed'}:{}},h('option',null,'COP'),h('option',null,'USD'))),
      h(Fld,{label:f.moneda==='USD'?'Monto original (USD) *':'Monto (COP) *'},h('input',{type:'text',inputMode:'numeric',value:fmtNumInput(f.montoOrigen),onChange:function(e){if(!lockSens)syncMonto(e.target.value);},placeholder:'0',className:'inp',disabled:lockSens,style:lockSens?{background:'var(--bg3)',color:'var(--text3)',cursor:'not-allowed'}:{}}))),
    // Modo simple (una compra): Tasa <-> Total pagado en COP sincronizados por derivacion
    f.moneda==='USD'&&!aplicaFracc&&h('div',{style:{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10}},
      h(Fld,{label:'Tasa de cambio (COP x 1 USD)'},
        h('input',{type:'text',inputMode:'numeric',value:fmtNumInput(f.trmAcordada),onChange:function(e){if(!lockSens)syncSimpleFromTasa(parseNum(e.target.value));},placeholder:'0',className:'inp',disabled:lockSens,style:lockSens?{background:'var(--bg3)',color:'var(--text3)',cursor:'not-allowed'}:{}})),
      h(Fld,{label:'Total pagado en COP'},
        h('input',{type:'text',inputMode:'numeric',value:fmtNumInput(totalCOPInput),onChange:function(e){if(!lockSens)syncSimpleFromTotal(parseNum(e.target.value));},placeholder:'0',className:'inp',disabled:lockSens,style:lockSens?{background:'var(--bg3)',color:'var(--text3)',cursor:'not-allowed'}:{}}))),
    // Modo fraccionado: la tasa es la promedio ponderada (solo lectura)
    f.moneda==='USD'&&aplicaFracc&&h(Fld,{label:'Tasa de compra de USD (COP x 1 USD) — calculada automaticamente'},
      h('input',{type:'text',inputMode:'numeric',value:tasaPromedio>0?fmtNumInput(tasaPromedio):'',onChange:function(){},className:'inp',disabled:true,placeholder:'Llena el desglose abajo',style:{background:'var(--bg3)',color:'var(--text3)',cursor:'not-allowed'}})),
    f.moneda==='USD'&&h('div',{style:{fontSize:11,color:'var(--blue)',marginTop:4,marginBottom:8,fontFamily:'monospace'}},'Capital en COP: '+fmt(montoCOP)),
    f.moneda==='USD'&&h('label',{style:{display:'flex',alignItems:'center',gap:10,background:'var(--bg3)',border:'1px solid '+(compraFrac?'var(--blue)':'var(--border)'),borderRadius:10,padding:'10px 12px',marginBottom:8,cursor:lockSens?'not-allowed':'pointer',transition:'border-color .2s',opacity:lockSens?.5:1}},
      h('input',{type:'checkbox',checked:compraFrac,onChange:function(){if(!lockSens)setCompraFrac(!compraFrac);},disabled:lockSens,style:{width:16,height:16,accentColor:'var(--blue)',cursor:lockSens?'not-allowed':'pointer',margin:0}}),
      h('span',{style:{fontSize:13,color:'var(--text)',fontWeight:500}},'¿Compraste el USD en varias partes/tasas?')),
    f.moneda==='USD'&&compraFrac&&h('div',{style:{background:'rgba(88,166,255,.04)',border:'1px solid var(--blue-bd)',borderRadius:12,padding:'12px',marginBottom:8}},
      h('div',{style:{fontSize:10,fontWeight:700,color:'var(--blue)',letterSpacing:.5,marginBottom:8,display:'flex',alignItems:'center',gap:5}},
        h(Ico,{name:'dollar',size:11,color:'var(--blue)'}),' DESGLOSE DE COMPRAS DE USD'),
      compras.map(function(c,i){
        return h('div',{key:i,style:{display:'flex',gap:8,alignItems:'flex-end',marginBottom:8}},
          h('div',{style:{flex:1}},
            h('div',{style:{fontSize:10,color:'var(--text3)',fontWeight:600,marginBottom:3}},'Compra '+(i+1)+' (USD)'),
            h('input',{type:'text',inputMode:'numeric',value:fmtNumInput(c.monto),onChange:function(e){if(!lockSens)setCompraField(i,'monto',parseNum(e.target.value));},placeholder:'0',className:'inp',disabled:lockSens,style:lockSens?{background:'var(--bg3)',color:'var(--text3)',cursor:'not-allowed'}:{}})),
          h('div',{style:{flex:1}},
            h('div',{style:{fontSize:10,color:'var(--text3)',fontWeight:600,marginBottom:3}},'Tasa (COP)'),
            h('input',{type:'text',inputMode:'numeric',value:fmtNumInput(c.tasa),onChange:function(e){if(!lockSens)setCompraField(i,'tasa',parseNum(e.target.value));},placeholder:'0',className:'inp',disabled:lockSens,style:lockSens?{background:'var(--bg3)',color:'var(--text3)',cursor:'not-allowed'}:{}})),
          h('div',{style:{flex:1}},
            h('div',{style:{fontSize:10,color:'var(--text3)',fontWeight:600,marginBottom:3}},'Total pagado (COP)'),
            h('input',{type:'text',inputMode:'numeric',value:fmtNumInput(c.totalCOP),onChange:function(e){if(!lockSens)setCompraField(i,'totalCOP',parseNum(e.target.value));},placeholder:'0',className:'inp',disabled:lockSens,style:lockSens?{background:'var(--bg3)',color:'var(--text3)',cursor:'not-allowed'}:{}})),
          h('button',{onClick:function(){if(!lockSens)delCompra(i);},disabled:lockSens||compras.length<=1,title:'Eliminar fila',style:{flexShrink:0,padding:'9px 10px',background:'var(--bg3)',border:'1px solid var(--border)',borderRadius:8,color:'var(--red)',cursor:(lockSens||compras.length<=1)?'not-allowed':'pointer',opacity:(lockSens||compras.length<=1)?.4:1,display:'flex',alignItems:'center'}},h(Ico,{name:'x',size:13,color:'var(--red)',sw:2.4})));
      }),
      h('button',{onClick:function(){if(!lockSens)addCompra();},disabled:lockSens,style:{width:'100%',padding:'8px 0',background:'transparent',border:'1px dashed var(--blue)',borderRadius:8,color:'var(--blue)',fontSize:12,fontWeight:600,cursor:lockSens?'not-allowed':'pointer',display:'flex',alignItems:'center',justifyContent:'center',gap:6,marginBottom:10,opacity:lockSens?.5:1}},
        h(Ico,{name:'plus',size:12,color:'var(--blue)',sw:2.4}),' Añadir otra compra'),
      h('div',{style:{borderTop:'1px solid var(--blue-bd)',paddingTop:10,marginTop:4}},
        excedeMonto&&h('div',{style:{background:'var(--red-bg)',border:'1px solid var(--red-bd)',borderRadius:8,padding:'8px 10px',marginBottom:8,fontSize:11,color:'var(--red)',display:'flex',alignItems:'center',gap:6}},
          h(Ico,{name:'alert',size:12,color:'var(--red)',sw:2.4}),' El total de compras excede el monto del prestamo'),
        faltaUSD&&h('div',{style:{background:'var(--yellow-bg)',border:'1px solid var(--yellow)',borderRadius:8,padding:'8px 10px',marginBottom:8,fontSize:11,color:'var(--yellow)'}},
          'Faltan '+fmtN(Math.max(0,(+f.montoOrigen||0)-totalUSDComprado))+' USD por registrar'),
        h('div',{style:{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'6px 0',fontSize:12}},
          h('span',{style:{color:'var(--text3)'}},'Total USD comprado'),
          h('span',{className:'mono',style:{color:excedeMonto?'var(--red)':'var(--text)',fontWeight:500}},fmtN(totalUSDComprado)+' USD')),
        h('div',{style:{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'6px 0',fontSize:12,borderTop:'1px solid var(--bg3)'}},
          h('span',{style:{color:'var(--text3)'}},'Total invertido en COP'),
          h('span',{className:'mono',style:{color:'var(--text)',fontWeight:500}},fmt(totalCOPInvertido))),
        h('div',{style:{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'8px 0 4px',borderTop:'1px solid var(--bg3)'}},
          h('span',{style:{color:'var(--blue)',fontSize:11,fontWeight:600,letterSpacing:.5}},'TASA PROMEDIO PONDERADA'),
          h('span',{className:'mono',style:{color:'var(--blue)',fontWeight:600,fontSize:15}},tasaPromedio>0?fmt(tasaPromedio):'-')))),
    h(Fld,{label:h('span',{style:{display:'flex',alignItems:'center',gap:6}},'Modalidad',
      h('span',{style:{position:'relative',display:'inline-flex'},className:'tooltip-wrap'},
        h('span',{style:{display:'inline-flex',alignItems:'center',justifyContent:'center',width:16,height:16,borderRadius:'50%',border:'1.5px solid var(--text3)',fontSize:10,fontWeight:700,color:'var(--text3)',cursor:'help',lineHeight:1}},'i'),
        h('span',{className:'tooltip-box'},
          h('b',null,'Intereses:'),' Solo paga intereses mensuales. El capital se devuelve al final. Plazo indefinido.',h('br',null),h('br',null),
          h('b',null,'Capital + Intereses:'),' Cuota fija mensual (amortizacion francesa). Cada cuota incluye intereses + parte del capital. Plazo fijo.',h('br',null),h('br',null),
          h('b',null,'Prestamo:'),' Sin intereses. Se presta un monto y se paga en una sola cuota.',h('br',null),h('br',null),
          h('b',null,'Pago Unico:'),' Una sola cuota en fecha exacta + ganancia personalizable (por % o monto fijo). Ideal para negocios cortos.',h('br',null),h('br',null),
          h('span',{style:{color:'var(--text3)',fontStyle:'italic'}},'En todas las modalidades se pueden hacer abonos a capital para reducir el saldo.'))))},
      h('select',{value:f.modalidad,onChange:function(e){var m=e.target.value;set('modalidad',m);if(m==='Prestamo'||m==='Pago Unico'){set('tasaMensual','0');set('plazoMeses','1');}},className:'inp',disabled:lockSens,style:lockSens?{background:'var(--bg3)',color:'var(--text3)',cursor:'not-allowed'}:{}},
      h('option',null,'Intereses'),
      h('option',null,'Capital + Intereses'),
      h('option',null,'Prestamo'),
      h('option',null,'Pago Unico'))),
    !esUnaCuota&&h(Fld,{label:'Frecuencia de cobro'},h('select',{value:f.frecuencia,onChange:function(e){set('frecuencia',e.target.value);},className:'inp',disabled:lockSens,style:lockSens?{background:'var(--bg3)',color:'var(--text3)',cursor:'not-allowed'}:{}},
      h('option',null,'Semanal'),h('option',null,'Quincenal'),h('option',null,'Mensual'))),
    !esUnaCuota&&h('div',{style:{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10}},
      h(Fld,{label:'Tasa mensual (%)'},
        h('input',{type:'text',inputMode:'decimal',value:f.tasaMensual,onChange:function(e){set('tasaMensual',parseDecimalInput(e.target.value));},placeholder:'0.00',className:'inp',disabled:lockSens,style:lockSens?{background:'var(--bg3)',color:'var(--text3)',cursor:'not-allowed'}:{}}),
        (+f.tasaMensual)>0&&h('div',{style:{fontSize:11,marginTop:4,color:'var(--text3)',fontFamily:'monospace'}},'Se aplicara: '+(+f.tasaMensual)+'% mensual')),
      h(Fld,{label:f.modalidad==='Capital + Intereses'?(f.frecuencia==='Semanal'?'Plazo (semanas) *':f.frecuencia==='Quincenal'?'Plazo (quincenas) *':'Plazo (meses) *'):'\u221E Plazo indefinido'},
        h('input',{type:'text',inputMode:'numeric',value:f.plazoMeses,onChange:function(e){set('plazoMeses',parseIntInput(e.target.value));},placeholder:f.modalidad==='Capital + Intereses'?'12':'\u221E',className:'inp',disabled:lockSens||f.modalidad==='Intereses',style:lockSens?{background:'var(--bg3)',color:'var(--text3)',cursor:'not-allowed'}:{}}))),
    esUnaCuota?h('div',{style:{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10}},
      h(Fld,{label:f.modalidad==='Pago Unico'?'Fecha del prestamo':'Fecha del prestamo'},h('input',{type:'date',value:f.fechaInicio,onChange:function(e){set('fechaInicio',e.target.value);},className:'inp',disabled:lockSens,style:lockSens?{background:'var(--bg3)',color:'var(--text3)',cursor:'not-allowed'}:{}})),
      h(Fld,{label:f.modalidad==='Pago Unico'?'Fecha exacta de pago':'Fecha de devolucion'},h('input',{type:'date',value:f.fechaDevolucion||'',onChange:function(e){set('fechaDevolucion',e.target.value);},className:'inp',min:f.fechaInicio,disabled:lockSens,style:lockSens?{background:'var(--bg3)',color:'var(--text3)',cursor:'not-allowed'}:{}})))
    :h(Fld,{label:'Fecha de inicio'},h('input',{type:'date',value:f.fechaInicio,onChange:function(e){set('fechaInicio',e.target.value);},className:'inp',disabled:lockSens,style:lockSens?{background:'var(--bg3)',color:'var(--text3)',cursor:'not-allowed'}:{}})),
    // v1.10.0 — Bloque Ganancia para modalidad Pago Unico: toggle %/monto + indicador de equivalencia
    f.modalidad==='Pago Unico'&&h('div',{style:{background:'rgba(63,185,80,.04)',border:'1px solid var(--green-bd)',borderRadius:12,padding:'12px 14px',marginBottom:8}},
      h('div',{style:{fontSize:10,fontWeight:700,color:'var(--green)',letterSpacing:.5,marginBottom:10,display:'flex',alignItems:'center',gap:5}},
        h(Ico,{name:'dollar',size:11,color:'var(--green)'}),' GANANCIA PACTADA'),
      // Toggle de modo: pct vs monto
      h('div',{style:{display:'flex',gap:8,marginBottom:10}},
        h('label',{style:{flex:1,display:'flex',alignItems:'center',gap:6,padding:'8px 10px',border:'1px solid '+(f.gananciaMode==='pct'?'var(--green)':'var(--border)'),borderRadius:8,cursor:lockSens?'not-allowed':'pointer',background:f.gananciaMode==='pct'?'rgba(63,185,80,.08)':'transparent',transition:'all .15s',opacity:lockSens?.5:1}},
          h('input',{type:'radio',name:'gananciaMode',checked:f.gananciaMode==='pct',onChange:function(){if(!lockSens){set('gananciaMode','pct');set('gananciaInput','');}},disabled:lockSens,style:{accentColor:'var(--green)',cursor:lockSens?'not-allowed':'pointer'}}),
          h('span',{style:{fontSize:12,color:'var(--text)',fontWeight:500}},'Por porcentaje')),
        h('label',{style:{flex:1,display:'flex',alignItems:'center',gap:6,padding:'8px 10px',border:'1px solid '+(f.gananciaMode==='monto'?'var(--green)':'var(--border)'),borderRadius:8,cursor:lockSens?'not-allowed':'pointer',background:f.gananciaMode==='monto'?'rgba(63,185,80,.08)':'transparent',transition:'all .15s',opacity:lockSens?.5:1}},
          h('input',{type:'radio',name:'gananciaMode',checked:f.gananciaMode==='monto',onChange:function(){if(!lockSens){set('gananciaMode','monto');set('gananciaInput','');}},disabled:lockSens,style:{accentColor:'var(--green)',cursor:lockSens?'not-allowed':'pointer'}}),
          h('span',{style:{fontSize:12,color:'var(--text)',fontWeight:500}},'Por monto fijo'))),
      // Input principal
      f.gananciaMode==='pct'?h(Fld,{label:'Porcentaje sobre el capital (%)'},
        h('input',{type:'text',inputMode:'decimal',value:f.gananciaInput,onChange:function(e){if(!lockSens)set('gananciaInput',parseDecimalInput(e.target.value));},placeholder:'10.00',className:'inp',disabled:lockSens,style:lockSens?{background:'var(--bg3)',color:'var(--text3)',cursor:'not-allowed'}:{}}),
        gananciaCOPCalc>0&&h('div',{style:{fontSize:11,color:'var(--text3)',marginTop:4,fontFamily:'monospace'}},'Equivale a '+fmt(gananciaCOPCalc)+' sobre '+fmt(montoCOP))
      ):h(Fld,{label:f.moneda==='USD'?'Monto fijo de ganancia (USD)':'Monto fijo de ganancia (COP)'},
        h('input',{type:'text',inputMode:'numeric',value:fmtNumInput(f.gananciaInput),onChange:function(e){if(!lockSens)set('gananciaInput',parseNum(e.target.value));},placeholder:'0',className:'inp',disabled:lockSens,style:lockSens?{background:'var(--bg3)',color:'var(--text3)',cursor:'not-allowed'}:{}}),
        gananciaCOPCalc>0&&h('div',{style:{fontSize:11,color:'var(--text3)',marginTop:4,fontFamily:'monospace'}},
          f.moneda==='USD'?'Equivale a '+fmt(gananciaCOPCalc)+' COP ('+gananciaPctImpl+'% del capital)':'Equivale al '+gananciaPctImpl+'% del capital'))),
    !isNew&&h(Fld,{label:'Estado'},h('select',{value:f.estado,onChange:function(e){set('estado',e.target.value);},className:'inp'},
      h('option',{value:'Activo'},'Activo'),
      h('option',{value:'Finalizado'},'Finalizado'),
      h('option',{value:'Cancelado'},'Cancelado (cierre forzoso)'))),
    h(Fld,{label:'Notas'},h('textarea',{value:f.notas,onChange:function(e){set('notas',e.target.value);},placeholder:'Observaciones opcionales...',rows:2,className:'inp',style:{resize:'none'}})),
    preview.cuota>0&&h('div',{style:{background:'var(--green-bg)',border:'1px solid var(--green-bd)',borderRadius:12,padding:'12px 14px'}},
      h('div',{style:{fontSize:11,color:'var(--green)',fontWeight:700,marginBottom:8}},'Resumen'),
      h('div',{style:{display:'flex',justifyContent:'space-between',marginBottom:5}},
        h('span',{style:{fontSize:12,color:'var(--text2)'}},f.modalidad==='Prestamo'?'Monto a devolver':f.modalidad==='Pago Unico'?'Total a cobrar (capital + ganancia)':f.modalidad==='Intereses'?'Cuota de interes'+(f.frecuencia==='Semanal'?' semanal':f.frecuencia==='Quincenal'?' quincenal':' mensual'):'Cuota '+(f.frecuencia==='Semanal'?'semanal':f.frecuencia==='Quincenal'?'quincenal':'mensual')),
        h('span',{className:'mono',style:{fontSize:12,fontWeight:700,color:f.modalidad==='Prestamo'?'var(--blue)':'var(--green)'}},fmt(preview.cuota))),
      f.moneda==='USD'&&trmEfectiva>0&&h('div',{style:{display:'flex',justifyContent:'space-between'}},
        h('span',{style:{fontSize:12,color:'var(--text2)'}},'Cuota '+freqCuotaLabel(f.frecuencia)+' en USD'),
        h('span',{className:'mono',style:{fontSize:12,fontWeight:700,color:'var(--yellow)'}},fmtUSD(preview.cuota/(trmEfectiva||1)))),
      f.modalidad==='Intereses'&&h('div',{style:{fontSize:11,color:'var(--blue)',marginTop:6}},'\u221E Plazo indefinido - paga intereses hasta abonar todo el capital'),
      f.modalidad==='Prestamo'&&f.fechaDevolucion&&h('div',{style:{fontSize:11,color:'var(--yellow)',marginTop:6}},'Sin intereses - devolucion: '+fmtD(f.fechaDevolucion)),
      f.modalidad==='Pago Unico'&&f.fechaDevolucion&&h('div',{style:{fontSize:11,color:'var(--green)',marginTop:6}},'Vence el '+fmtD(f.fechaDevolucion)+' \u2014 capital '+fmt(montoCOP)+' + ganancia '+fmt(gananciaCOPCalc)),
      preview.rows&&preview.rows.length>0&&h('button',{onClick:function(){setShowCronoLoan(!showCronoLoan);},style:{marginTop:10,background:'none',border:'none',cursor:'pointer',color:'var(--green)',fontSize:12,fontWeight:600,display:'flex',alignItems:'center',gap:4,padding:0}},
        showCronoLoan?'Ocultar cronograma':'Ver cronograma tentativo'),
      showCronoLoan&&preview.rows&&preview.rows.length>0&&h('div',{style:{marginTop:10,borderTop:'1px solid var(--green-bd)',paddingTop:10,overflowX:'auto'}},
        h('table',{style:{width:'100%',borderCollapse:'collapse',fontSize:11}},
          h('thead',null,h('tr',{style:{background:'rgba(63,185,80,.1)'}},
            ['#','Interes','Abono a capital','Valor cuota','Saldo'].map(function(hd){
              return h('th',{key:hd,style:{padding:'6px 8px',textAlign:hd==='#'?'center':'right',fontWeight:600,color:'var(--text2)',whiteSpace:'nowrap'}},hd);}))),
          h('tbody',null,preview.rows.map(function(r){
            var t=trmEfectiva||1;
            return h('tr',{key:r.n,style:{borderTop:'1px solid rgba(63,185,80,.12)'}},
              h('td',{style:{padding:'5px 8px',textAlign:'center',color:'var(--text3)'}},r.n),
              h('td',{className:'mono',style:{padding:'5px 8px',textAlign:'right',color:'var(--yellow)'}},fmtN(r.interes),
                f.moneda==='USD'&&h('div',{style:{fontSize:9,color:'var(--blue)'}},copToUsd(r.interes,t))),
              h('td',{className:'mono',style:{padding:'5px 8px',textAlign:'right',color:'var(--blue)'}},fmtN(r.capital),
                f.moneda==='USD'&&h('div',{style:{fontSize:9,color:'var(--blue)'}},copToUsd(r.capital,t))),
              h('td',{className:'mono',style:{padding:'5px 8px',textAlign:'right',color:'var(--green)',fontWeight:600}},fmtN(r.cuota),
                f.moneda==='USD'&&h('div',{style:{fontSize:9,color:'var(--blue)',fontWeight:400}},copToUsd(r.cuota,t))),
              h('td',{className:'mono',style:{padding:'5px 8px',textAlign:'right',color:'var(--text3)',fontSize:10}},fmtN(r.saldo),
                f.moneda==='USD'&&h('div',{style:{fontSize:9,color:'var(--blue)'}},copToUsd(r.saldo,t))));
          }))))),
    h('button',{onClick:submit,disabled:isSubmitting,className:'btn-primary',style:{marginTop:8,opacity:isSubmitting?.6:1,cursor:isSubmitting?'not-allowed':'pointer'}},isSubmitting?(isNew?'Creando...':'Guardando...'):(!isNew?'Guardar cambios':'Crear prestamo')));
}

// ── FlujoCajaPanel (v2.2.0) ───────────────────────────────────────────────────
// Panel expandible con el historial REAL de movimientos de un prestamo (no el cronograma
// teorico). Se usa en el perfil del deudor, tanto en creditos cerrados como en activos.
// Estado propio: cada tarjeta abre y cierra el suyo sin que el padre tenga que enhebrarlo.
function FlujoCajaPanel(props){
  var loan=props.loan,pays=props.pays||[];
  var op=useState(false); var abierto=op[0]; var setAbierto=op[1];
  var fj=flujoCajaDe(loan,pays);
  if(!fj.eventos.length) return null;
  var esUSD=loan.moneda==='USD';
  var trm=loan.trmAcordada||1;
  // Efecto TRM: hueco entre la caja y la composicion de la cuota (Fase 2). Solo se materializa
  // en prestamos USD; el filtro de $5 descarta el residuo de redondeo de las filas legacy del
  // Bug #43, que no es informacion para el usuario sino ruido historico de 1-3 pesos.
  var hayAjuste=fj.eventos.some(function(e){return Math.abs(e.ajuste)>5;});
  var uSub=function(cop){return esUSD?h('div',{className:'mono',style:{fontSize:9,color:'var(--blue)',fontWeight:400}},copToUsd(cop,trm)):null;};
  var th=function(txt,alin,w){return h('th',{style:{textAlign:alin||'left',padding:'5px 4px',color:'var(--text3)',fontWeight:600,fontSize:9,letterSpacing:.3,width:w}},txt);};
  var td=function(kids,alin,color,extra){return h('td',{style:Object.assign({padding:'6px 4px',textAlign:alin||'left',color:color||'var(--text)',verticalAlign:'top'},extra||{})},kids);};

  return h('div',{style:{marginTop:8}},
    h('button',{onClick:function(){setAbierto(!abierto);},
      style:{display:'flex',alignItems:'center',gap:6,padding:'7px 11px',borderRadius:8,fontSize:12,fontWeight:600,fontFamily:'inherit',
        background:abierto?'var(--blue-bg)':'transparent',border:'1px solid '+(abierto?'var(--blue)':'var(--border)'),
        color:abierto?'var(--blue)':'var(--text2)',cursor:'pointer',transition:'all .15s'}},
      h(Ico,{name:abierto?'chevdown':'chevright',size:13,color:abierto?'var(--blue)':'var(--text2)',sw:2.2}),
      abierto?'Ocultar flujo de caja':'Ver flujo de caja'),

    abierto&&h('div',{style:{marginTop:9}},
      h('div',{style:{fontSize:9,color:'var(--text3)',fontWeight:600,letterSpacing:.5,marginBottom:5}},
        'FLUJO DE CAJA REAL · '+fj.eventos.length+' movimiento'+(fj.eventos.length!==1?'s':'')),
      h('div',{style:{overflowX:'auto'}},
        h('table',{style:{width:'100%',borderCollapse:'collapse',fontSize:11}},
          h('thead',null,h('tr',{style:{borderBottom:'1px solid var(--border2)'}},
            th('#','left',22),th('Recaudado','left',72),th('Concepto'),
            th('Interes','right',62),th('Capital','right',62),
            // La columna solo aparece cuando hay desfase cambiario que explicar (prestamos USD
            // cuya cuota quedo Pagada con menos COP de los proyectados). En COP nunca se muestra.
            hayAjuste?th('Efecto TRM','right',66):null,
            th('Ingreso','right',68),th('Saldo','right',66))),
          h('tbody',{className:'mono'},
            fj.eventos.map(function(e){
              // Concepto: el tipo de movimiento + su referencia. Los abonos guardan un cuotaN
              // artificial (maxN+1), asi que NO se muestra como numero de cuota.
              var concepto=e.esAbono
                ? (/liquidacion/i.test(e.obs)?'Liquidacion':'Abono a capital')
                : (e.parcialEnCurso?'Pago parcial cuota #'+e.cuotaN:'Cuota #'+e.cuotaN);
              var nota=null;
              if(e.parcialEnCurso) nota=h('div',{style:{fontSize:9,color:'var(--yellow)',marginTop:1,fontFamily:'var(--font)'}},'no salda la cuota');
              else if(e.atraso!==null&&e.atraso>0) nota=h('div',{style:{fontSize:9,color:e.atraso>7?'var(--red)':'var(--yellow)',marginTop:1,fontFamily:'var(--font)'}},'vencia '+fmtD(e.vence).replace(/ de \d+$/,'')+' · +'+e.atraso+' dia'+(e.atraso!==1?'s':''));
              else if(e.atraso!==null&&e.atraso<=0) nota=h('div',{style:{fontSize:9,color:'var(--green)',marginTop:1,fontFamily:'var(--font)'}},e.atraso<0?'anticipado':'puntual');
              return h('tr',{key:e.n,style:{borderBottom:'1px solid var(--bg3)'}},
                td(String(e.n),'left','var(--text3)'),
                td(fmtD(e.fecha).replace(/ de /g,' '),'left','var(--text2)'),
                td([h('div',{key:'c',style:{fontFamily:'var(--font)',color:'var(--text)'}},concepto),nota],'left'),
                td(fmtN(e.interes),'right','var(--yellow)'),
                td(fmtN(e.capital),'right','var(--blue)'),
                hayAjuste?td(e.ajuste===0?'—':fmtN(e.ajuste),'right',e.ajuste<0?'var(--red)':(e.ajuste>0?'var(--green)':'var(--text3)')):null,
                td([h('span',{key:'v',style:{fontWeight:600}},fmtN(e.cop)),
                    e.inferido?h('span',{key:'a',style:{color:'var(--text3)'}},'*'):null,
                    esUSD?uSub(e.cop):null],'right','var(--green)'),
                td(fmtN(e.saldo),'right',e.saldo===0?'var(--green)':'var(--text3)'));
            }),
            h('tr',{style:{borderTop:'1px solid var(--border2)'}},
              td('Totales','left','var(--text2)',{fontFamily:'var(--font)',fontWeight:600}),
              td('','left'),td('','left'),
              td(fmtN(fj.totales.interes),'right','var(--yellow)',{fontWeight:600}),
              td(fmtN(fj.totales.capital),'right','var(--blue)',{fontWeight:600}),
              hayAjuste?td(fmtN(fj.totales.ajuste),'right',fj.totales.ajuste<0?'var(--red)':'var(--green)',{fontWeight:600}):null,
              td([h('span',{key:'t',style:{fontWeight:600}},fmtN(fj.totales.ingreso)),esUSD?uSub(fj.totales.ingreso):null],'right','var(--green)'),
              td('','right'))))),
      (fj.inferidos>0||hayAjuste)&&h('div',{style:{fontSize:9,color:'var(--text3)',lineHeight:1.5,marginTop:7,borderTop:'1px solid var(--bg3)',paddingTop:6}},
        fj.inferidos>0?h('div',{key:'inf'},
          h('span',{style:{color:'var(--text2)'}},'*'),' Monto reconstruido del valor de la cuota: son cobros anteriores a que la app registrara el efectivo exacto. La fecha si es la real de recaudo.'):null,
        hayAjuste?h('div',{key:'trm',style:{marginTop:fj.inferidos>0?4:0}},
          h('span',{style:{color:'var(--text2)'}},'Efecto TRM: '),'diferencia entre los pesos que entraron y el valor de la cuota a la TRM pactada. El cliente entrego los dolares completos; la brecha es cambiaria, no un saldo por cobrar. Interes + Capital + Efecto TRM = Ingreso.'):null)));
}

// ── Historial de acciones ─────────────────────────────────────────────────────
function HistorialView(props){
  var log=props.actLog||[];
  var undoLog=props.undoLog||[];
  var onUndo=props.onUndo;
  var onRefresh=props.onRefresh;
  var tipoIcon={prestamo:'plus',edicion:'edit',eliminacion:'trash',pago:'check',abono:'dollar',reestructuracion:'calc',cierre:'alert',deshacer:'refresh','cambio-fecha':'calendar',deuda:'briefcase'};
  // v2.1 — 'deshacer' en purpura: las acciones compensatorias deben destacar de un vistazo sin
  // confundirse con un error (rojo) ni con un cobro (verde).
  var tipoColor={prestamo:'var(--green)',edicion:'var(--blue)',eliminacion:'var(--red)',pago:'var(--green)',abono:'var(--yellow)',reestructuracion:'var(--blue)',cierre:'var(--red)',deshacer:'var(--purple)','cambio-fecha':'var(--blue)',deuda:'var(--text2)'};
  var tipoLabel={prestamo:'Nuevo prestamo',edicion:'Edicion',eliminacion:'Eliminacion',pago:'Pago',abono:'Abono',reestructuracion:'Reestructuracion',cierre:'Cierre forzoso',deshacer:'Deshecho','cambio-fecha':'Cambio de fecha',deuda:'Mis deudas'};

  function fmtFecha(f){
    if(!f)return '';
    var d=new Date(f);
    var meses=['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'];
    return d.getDate()+' '+meses[d.getMonth()]+' '+d.getFullYear()+' '+d.getHours().toString().padStart(2,'0')+':'+d.getMinutes().toString().padStart(2,'0');
  }

  // ── CANDADO A (LIFO) EN LA UI ───────────────────────────────────────────────
  // El backend solo acepta deshacer la entrada 'disponible' MAS RECIENTE de cada agregado
  // (409 en cualquier otra). La UI refleja exactamente esa regla: se calcula el "head" por
  // scope y solo esa fila ofrece el boton activo. Las demas lo muestran apagado, explicando
  // cual hay que deshacer primero — mejor que ocultarlo, que dejaria al usuario sin saber por
  // que una operacion no se puede revertir.
  var ujById={}, headByScope={};
  undoLog.forEach(function(u){
    ujById[u.id]=u;
    var k=u.scope_tipo+'|'+u.scope_id;
    // GET /api/undo llega ordenado por rowid DESC -> la primera 'disponible' de cada scope es el head.
    if(u.estado==='disponible'&&!headByScope[k]) headByScope[k]=u.id;
  });

  return h('div',{style:{padding:16}},
    h('div',{style:{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:16}},
      h('h2',{style:{color:'var(--text)',fontSize:18,fontWeight:700}},'Historial de acciones'),
      h('button',{onClick:onRefresh,style:{background:'var(--bg3)',border:'1px solid var(--border)',borderRadius:8,padding:'6px 12px',cursor:'pointer',color:'var(--text)',fontSize:13,display:'flex',alignItems:'center',gap:6}},
        h(Ico,{name:'refresh',size:14,color:'var(--text2)'}),'Actualizar')),
    log.length===0?
      h('div',{style:{textAlign:'center',padding:40,color:'var(--text3)'}},
        h(Ico,{name:'activity',size:32,color:'var(--text3)'}),
        h('p',{style:{marginTop:12,fontSize:13}},'No hay acciones registradas aun')):
      h('div',{style:{display:'flex',flexDirection:'column',gap:8}},
        log.map(function(item){
          var icon=tipoIcon[item.tipo]||'activity';
          var color=tipoColor[item.tipo]||'var(--text2)';
          var label=tipoLabel[item.tipo]||item.tipo;
          var uj=item.undo_id?ujById[item.undo_id]:null;
          var esHead=uj&&uj.estado==='disponible'&&headByScope[uj.scope_tipo+'|'+uj.scope_id]===uj.id;
          var bloqueada=uj&&uj.estado==='disponible'&&!esHead;
          var yaDeshecha=uj&&uj.estado==='deshecho';
          // Cual es la operacion que hay que deshacer PRIMERO en este agregado (para el tooltip).
          var headEntry=uj?ujById[headByScope[uj.scope_tipo+'|'+uj.scope_id]]:null;
          var motivo=bloqueada&&headEntry
            ? 'Primero debes deshacer la operacion mas reciente de este '+(uj.scope_tipo==='debt'?'registro':'prestamo')+': "'+headEntry.descripcion+'"'
            : '';
          return h('div',{key:item.id,style:{background:'var(--bg2)',border:'1px solid '+(yaDeshecha?'var(--purple-bd)':'var(--border)'),borderRadius:10,padding:'12px 14px',display:'flex',alignItems:'flex-start',gap:12,opacity:yaDeshecha?.72:1}},
            h('div',{style:{background:color+'20',borderRadius:8,padding:8,display:'flex',flexShrink:0}},
              h(Ico,{name:icon,size:16,color:color})),
            h('div',{style:{flex:1,minWidth:0}},
              h('div',{style:{display:'flex',alignItems:'center',gap:8,marginBottom:4,flexWrap:'wrap'}},
                h('span',{style:{fontSize:11,fontWeight:600,color:color,textTransform:'uppercase',letterSpacing:'.5px'}},label),
                h('span',{style:{fontSize:11,color:'var(--text3)'}},fmtFecha(item.fecha)),
                yaDeshecha&&h('span',{style:{fontSize:10,fontWeight:700,color:'var(--purple)',background:'var(--purple-bg)',border:'1px solid var(--purple-bd)',borderRadius:5,padding:'1px 6px',letterSpacing:'.3px'}},'REVERTIDA')),
              h('div',{style:{fontSize:14,color:'var(--text)',lineHeight:'1.4',textDecoration:yaDeshecha?'line-through':'none'}},item.mensaje),
              // El motivo del bloqueo se muestra tambien inline: el tooltip nativo no existe en tactil.
              bloqueada&&h('div',{style:{fontSize:11,color:'var(--text3)',marginTop:5,display:'flex',alignItems:'flex-start',gap:5,lineHeight:1.45}},
                h(Ico,{name:'clock',size:11,color:'var(--text3)',sw:2.2}),
                h('span',null,motivo))),
            // ── Accion de deshacer (solo el head LIFO la ofrece activa) ──
            (esHead||bloqueada)&&h('div',{style:{flexShrink:0}},
              h('button',{
                onClick:esHead?function(){onUndo(uj);}:null,
                disabled:!esHead,
                title:esHead?'Revertir esta operacion':motivo,
                style:{display:'flex',alignItems:'center',gap:6,padding:'7px 11px',borderRadius:8,fontSize:12,fontWeight:600,fontFamily:'inherit',
                  background:esHead?'var(--purple-bg)':'transparent',
                  border:'1px solid '+(esHead?'var(--purple)':'var(--border)'),
                  color:esHead?'var(--purple)':'var(--text3)',
                  cursor:esHead?'pointer':'not-allowed',opacity:esHead?1:.6,transition:'all .15s'}},
                h(Ico,{name:'refresh',size:13,color:esHead?'var(--purple)':'var(--text3)',sw:2.2}),'Deshacer')));
        })));
}

// ── Mis Deudas (deudas propias, registro manual — Bloque 2) ───────────────────
function DebtsView(props){
  var debts=props.debts||[];
  var onReload=props.onReload;
  var onNew=props.onNew;
  var onPay=props.onPay;
  var onEdit=props.onEdit;
  var onDelete=props.onDelete;
  var onHistory=props.onHistory;
  var sExp=useState({}); var expanded=sExp[0]; var setExpanded=sExp[1];
  function toggleExpand(key){ setExpanded(function(prev){ var n=Object.assign({},prev); n[key]=!n[key]; return n; }); }

  // KPIs globales: gran total, visibles en todo momento.
  var stats=useMemo(function(){
    var activas=debts.filter(function(d){return d.estado==='Activa';});
    var totalActiva=activas.reduce(function(s,d){return s+(+d.saldo_pendiente||0);},0);
    return {totalActiva:totalActiva,count:debts.length,activas:activas.length,pagadas:debts.length-activas.length};
  },[debts]);

  // Agrupacion por acreedor (case-insensitive); nombre en Proper Case.
  var grupos=useMemo(function(){
    // timestamp robusto desde "YYYY-MM-DD HH:MM:SS" o "YYYY-MM-DD" (0 si invalido).
    function parseTs(s){ var t=new Date(String(s||'').replace(' ','T')).getTime(); return isNaN(t)?0:t; }
    var map={};
    debts.forEach(function(d){
      var key=(d.acreedor||'').trim().toLowerCase();
      if(!map[key]) map[key]={key:key,nombre:properCase(d.acreedor),deudas:[],totalActiva:0,activas:0,pagadas:0,oldestTs:Infinity};
      var g=map[key];
      g.deudas.push(d);
      g.oldestTs=Math.min(g.oldestTs, parseTs(d.fecha_creacion)); // deuda mas antigua del acreedor
      if(d.estado==='Activa'){ g.totalActiva+=(+d.saldo_pendiente||0); g.activas++; } else { g.pagadas++; }
    });
    // Orden DESC por la deuda mas antigua: el acreedor con la deuda mas reciente arriba, el mas antiguo abajo.
    return Object.keys(map).map(function(k){return map[k];})
      .sort(function(a,b){return b.oldestTs-a.oldestTs || a.nombre.localeCompare(b.nombre);});
  },[debts]);

  function estadoBadge(estado){
    var c=estado==='Pagada'?'var(--green)':'var(--yellow)';
    return h('span',{style:{fontSize:11,fontWeight:700,color:c,background:c+'20',padding:'3px 10px',borderRadius:99,whiteSpace:'nowrap'}},estado);
  }
  function kpi(iconName,iconColor,label,value,sub){
    return h('div',{style:{background:'var(--bg2)',border:'1px solid var(--border)',borderRadius:12,padding:'14px 16px'}},
      h('div',{style:{display:'flex',alignItems:'center',gap:8,marginBottom:8}},
        h('div',{style:{background:iconColor+'20',borderRadius:8,padding:7,display:'flex'}},h(Ico,{name:iconName,size:16,color:iconColor})),
        h('div',{style:{fontSize:11,fontWeight:700,color:'var(--text3)',textTransform:'uppercase',letterSpacing:'.5px'}},label)),
      h('div',{className:'mono',style:{fontSize:24,fontWeight:700,color:'var(--text)'}},value),
      h('div',{style:{fontSize:12,color:'var(--text3)',marginTop:2}},sub));
  }
  function avatar(nombre,size){
    return h('div',{style:{width:size,height:size,borderRadius:99,background:'var(--bg3)',display:'flex',alignItems:'center',justifyContent:'center',flexShrink:0,fontWeight:700,fontSize:Math.round(size*0.4),color:'var(--text2)'}},(nombre||'?').charAt(0).toUpperCase());
  }
  function subProfiles(g){
    return g.activas+' deuda'+(g.activas===1?'':'s')+' activa'+(g.activas===1?'':'s')+(g.pagadas>0?' · '+g.pagadas+' pagada'+(g.pagadas===1?'':'s'):'');
  }
  function iconBtn(icon,title,onClick,color){
    return h('button',{onClick:onClick,title:title,style:{background:'var(--bg3)',border:'1px solid var(--border)',borderRadius:8,width:32,height:32,cursor:'pointer',display:'flex',alignItems:'center',justifyContent:'center',flexShrink:0}},
      h(Ico,{name:icon,size:15,color:color||'var(--text2)'}));
  }

  // Tarjeta de UNA deuda: barra de progreso (% pagado) + montos + acciones.
  // Separador sutil de categoria (Activas / Finalizadas) dentro del acordeon.
  function catLabel(text,key){
    return h('div',{key:key,style:{display:'flex',alignItems:'center',gap:8,marginTop:4}},
      h('span',{style:{fontSize:11,fontWeight:700,color:'var(--text3)',textTransform:'uppercase',letterSpacing:'.5px'}},text),
      h('div',{style:{flex:1,height:1,background:'var(--border)'}}));
  }

  function debtCard(d){
    // QA5: base dinamica = monto_original + cargos (deuda total acumulada). pct = abonos / base.
    // Asi nunca da negativo aunque los cargos superen el monto original.
    var baseDeuda=(+d.monto_original||0)+(+d.total_cargos||0);
    var pct=baseDeuda>0?Math.max(0,Math.min(100,Math.round(((+d.total_abonos||0)/baseDeuda)*100))):0;
    return h('div',{key:d.id,style:{background:'var(--bg2)',border:'1px solid var(--border)',borderRadius:12,padding:'13px 15px'}},
      h('div',{style:{display:'flex',alignItems:'flex-start',justifyContent:'space-between',gap:10,marginBottom:10}},
        h('div',{style:{minWidth:0}},
          h('div',{style:{fontWeight:700,fontSize:15,color:'var(--text)',whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis'}},d.titulo||d.concepto||'Deuda'),
          (d.titulo&&d.concepto)?h('div',{style:{fontSize:12,color:'var(--text3)',marginTop:2,whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis'}},d.concepto):null,
          h('div',{style:{fontSize:11,color:'var(--text3)',marginTop:2}},'Registrada '+fmtD((d.fecha_creacion||'').slice(0,10)))),
        estadoBadge(d.estado)),
      // Barra de progreso: % pagado = (monto_original - saldo_pendiente) / monto_original
      h('div',{style:{marginBottom:10}},
        h('div',{style:{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:4}},
          h('span',{style:{fontSize:11,color:'var(--text3)'}},'Pagado'),
          h('span',{className:'mono',style:{fontSize:11,fontWeight:700,color:'var(--green)'}},pct+'%')),
        h('div',{style:{height:6,background:'var(--bg3)',borderRadius:99,overflow:'hidden'}},
          h('div',{style:{width:pct+'%',height:'100%',background:'var(--green)',borderRadius:99,transition:'width .3s'}}))),
      h('div',{style:{display:'flex',justifyContent:'space-between',alignItems:'flex-end',gap:12}},
        h('div',null,
          h('div',{style:{fontSize:11,color:'var(--text3)',marginBottom:2}},'Monto original'),
          h('div',{className:'mono',style:{fontSize:13,color:'var(--text2)',fontWeight:600}},fmt(d.monto_original))),
        h('div',{style:{textAlign:'right'}},
          h('div',{style:{fontSize:11,color:'var(--text3)',marginBottom:2}},'Saldo pendiente'),
          h('div',{className:'mono',style:{fontSize:16,fontWeight:700,color:d.estado==='Pagada'?'var(--green)':'var(--yellow)'}},fmt(d.saldo_pendiente)))),
      // Acciones: Ver pagos / Editar / Eliminar (+ Abonar si esta Activa)
      h('div',{style:{display:'flex',alignItems:'center',gap:6,marginTop:12}},
        iconBtn('clipboard','Ver pagos',function(){onHistory(d);}),
        iconBtn('edit','Editar',function(){onEdit(d);}),
        iconBtn('trash','Eliminar',function(){onDelete(d);},'var(--red)'),
        h('div',{style:{flex:1}}),
        d.estado==='Activa'?h('button',{onClick:function(){onPay(d);},style:{background:'var(--green2)',border:'none',borderRadius:8,padding:'7px 16px',cursor:'pointer',color:'#fff',fontSize:13,fontWeight:700,display:'flex',alignItems:'center',gap:6}},
          h(Ico,{name:'dollar',size:14,color:'#fff'}),'Abonar'):null));
  }

  // Encabezado de PERFIL (acordeon): clic alterna la expansion in-place (otros siguen visibles).
  function profileHeader(g){
    var open=!!expanded[g.key];
    return h('div',{onClick:function(){toggleExpand(g.key);},style:{background:'var(--bg2)',border:'1px solid var(--border)',borderRadius:12,padding:'13px 15px',cursor:'pointer',display:'flex',alignItems:'center',justifyContent:'space-between',gap:12}},
      h('div',{style:{display:'flex',alignItems:'center',gap:12,minWidth:0}},
        avatar(g.nombre,42),
        h('div',{style:{minWidth:0}},
          h('div',{style:{fontWeight:700,fontSize:15,color:'var(--text)',whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis'}},g.nombre),
          h('div',{style:{fontSize:12,color:'var(--text3)',marginTop:2}},subProfiles(g)))),
      h('div',{style:{display:'flex',alignItems:'center',gap:10,flexShrink:0}},
        h('div',{style:{textAlign:'right'}},
          h('div',{style:{fontSize:11,color:'var(--text3)'}},'Deuda total'),
          h('div',{className:'mono',style:{fontSize:16,fontWeight:700,color:g.totalActiva>0?'var(--yellow)':'var(--green)'}},fmt(g.totalActiva))),
        h(Ico,{name:open?'chevdown':'chevright',size:18,color:'var(--text3)'})));
  }

  // Bloque de un acreedor: cabecera-acordeon + (al expandir) sus deudas categorizadas.
  function groupBlock(g){
    var open=!!expanded[g.key];
    var act=g.deudas.filter(function(d){return d.estado==='Activa';}).sort(function(a,b){return (+b.saldo_pendiente||0)-(+a.saldo_pendiente||0);});
    var fin=g.deudas.filter(function(d){return d.estado!=='Activa';});
    var detalle=[];
    if(act.length){ detalle.push(catLabel('Activas','a-'+g.key)); act.forEach(function(d){detalle.push(debtCard(d));}); }
    if(fin.length){ detalle.push(catLabel('Finalizadas','f-'+g.key)); fin.forEach(function(d){detalle.push(debtCard(d));}); }
    return h('div',{key:g.key},
      profileHeader(g),
      open?h('div',{style:{display:'flex',flexDirection:'column',gap:8,marginTop:8,paddingLeft:12}},detalle):null);
  }

  // Nivel 1 dividido en Activos (>=1 deuda Activa) e Inactivos (todas Pagadas). Cada bloque hereda
  // el orden del memo `grupos` (desc por la deuda mas antigua del acreedor). Separador solo si hay.
  var activos=grupos.filter(function(g){return g.activas>0;});
  var inactivos=grupos.filter(function(g){return g.activas===0;});
  var perfiles=[];
  if(activos.length){ perfiles.push(catLabel('Activos','sec-act')); activos.forEach(function(g){perfiles.push(groupBlock(g));}); }
  if(inactivos.length){ perfiles.push(catLabel('Inactivos','sec-fin')); inactivos.forEach(function(g){perfiles.push(groupBlock(g));}); }

  return h('div',{style:{padding:16,maxWidth:1180,margin:'0 auto'}},
    // Cabecera: titulo + acciones (siempre visible)
    h('div',{style:{display:'flex',alignItems:'center',justifyContent:'space-between',gap:12,marginBottom:16,flexWrap:'wrap'}},
      h('div',{style:{display:'flex',alignItems:'center',gap:8}},
        h(Ico,{name:'wallet',size:20,color:'var(--green)'}),
        h('h2',{style:{color:'var(--text)',fontSize:18,fontWeight:700,margin:0}},'Mis Deudas')),
      h('div',{style:{display:'flex',gap:8}},
        h('button',{onClick:onReload,title:'Actualizar',style:{background:'var(--bg3)',border:'1px solid var(--border)',borderRadius:8,padding:'8px 12px',cursor:'pointer',color:'var(--text)',fontSize:13,display:'flex',alignItems:'center',gap:6}},
          h(Ico,{name:'refresh',size:14,color:'var(--text2)'}),'Actualizar'),
        h('button',{onClick:onNew,style:{background:'var(--green2)',border:'none',borderRadius:8,padding:'8px 14px',cursor:'pointer',color:'#fff',fontSize:13,fontWeight:700,display:'flex',alignItems:'center',gap:6}},
          h(Ico,{name:'plus',size:15,color:'#fff'}),'Nueva Deuda'))),

    // KPIs globales (siempre visibles, gran total)
    h('div',{style:{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(210px,1fr))',gap:12,marginBottom:18}},
      kpi('wallet','var(--yellow)','Deuda Total Activa',fmt(stats.totalActiva),stats.activas+' deuda'+(stats.activas===1?'':'s')+' activa'+(stats.activas===1?'':'s')),
      kpi('clipboard','var(--blue)','Cantidad de Deudas',String(stats.count),stats.activas+' activas · '+stats.pagadas+' pagadas')),

    // Cuerpo: vacio / acordeon de acreedores (los perfiles NO desaparecen al expandir)
    debts.length===0?
      h('div',{style:{textAlign:'center',padding:40,color:'var(--text3)'}},
        h(Ico,{name:'wallet',size:32,color:'var(--text3)'}),
        h('p',{style:{marginTop:12,fontSize:13}},'No tienes deudas registradas aun'),
        h('p',{style:{marginTop:4,fontSize:12,color:'var(--text3)'}},'Usa "Nueva Deuda" para agregar la primera'))
    :
      h('div',{style:{display:'flex',flexDirection:'column',gap:8}},perfiles));
}

// ── Modales de Mis Deudas (Bloque 3) ──────────────────────────────────────────
function DebtModal(props){
  var debt=props.debt; // null = crear, objeto = editar
  var editing=!!debt;
  // Proteccion contable: si ya hay abonos (monto_original > saldo_pendiente) no se permite tocar el monto.
  var lockMonto=editing&&(+debt.monto_original>+debt.saldo_pendiente);
  var onSave=props.onSave,onClose=props.onClose;
  var existingAcreedores=props.existingAcreedores||[];
  var sSug=useState(false); var showSug=sSug[0]; var setShowSug=sSug[1];
  var s0=useState(editing?(debt.titulo||''):''); var titulo=s0[0]; var setTitulo=s0[1];
  var s1=useState(editing?(debt.acreedor||''):''); var acreedor=s1[0]; var setAcreedor=s1[1];
  var s2=useState(editing?String(Math.round(debt.monto_original||0)):''); var monto=s2[0]; var setMonto=s2[1];
  var s3=useState(''); var interes=s3[0]; var setInteres=s3[1];
  var s4=useState(editing?(debt.concepto||''):''); var concepto=s4[0]; var setConcepto=s4[1];
  var s5=useState(editing?((debt.fecha_creacion||'').slice(0,10)||nowStr()):nowStr()); var fecha=s5[0]; var setFecha=s5[1];
  var s6=useState(false); var sending=s6[0]; var setSending=s6[1];   // v1.18.1: guarda anti doble-submit

  function submit(){
    // v1.18.1 — POST /api/debts no es idempotente: un doble clic creaba DOS deudas identicas.
    if(sending) return;
    var tit=titulo.trim();
    var acr=acreedor.trim();
    var m=Math.round(+monto||0);
    if(!tit){showError('Ingresa el titulo de la deuda');return;}
    if(!acr){showError('Ingresa el acreedor');return;}
    if(m<=0){showError('Ingresa un monto original valido');return;}
    // UX: no hay columna de interes en la BD -> concatenamos "Tasa - Descripcion" en concepto.
    // El titulo viaja limpio en su propio campo.
    var conceptoFinal=[interes.trim(),concepto.trim()].filter(Boolean).join(' - ');
    var payload={titulo:tit,acreedor:acr,monto_original:m,concepto:conceptoFinal,fecha_creacion:fecha};
    if(editing) payload.id=debt.id; // -> el handler hace PUT en vez de POST
    _submitGuard(sending,setSending,function(){return onSave(payload);});
  }

  // QA6: sugerencias de acreedores existentes. Oculto si el input esta vacio o si coincide exacto.
  var acrQ=acreedor.trim(), acrQL=acrQ.toLowerCase();
  var acrExact=existingAcreedores.some(function(n){return n.toLowerCase()===acrQL;});
  var acrSugeridos=(acrQ&&!acrExact)?existingAcreedores.filter(function(n){return n.toLowerCase().indexOf(acrQL)!==-1;}).slice(0,6):[];
  var acrOpen=showSug&&acrSugeridos.length>0;

  return h(Modal,{onClose:onClose},
    h('div',{style:{fontWeight:700,fontSize:16,color:'var(--text)'}},editing?'Editar Deuda':'Nueva Deuda'),
    h('div',{style:{fontSize:12,color:'var(--text3)'}},editing?'Actualiza los datos de esta deuda.':'Registra una deuda que tienes con un tercero.'),
    h(Fld,{label:'Acreedor *'},
      h('div',{style:{position:'relative'}},
        h('input',{value:acreedor,onChange:function(e){setAcreedor(e.target.value);setShowSug(true);},onFocus:function(){setShowSug(true);},onBlur:function(){setShowSug(false);},placeholder:'A quien le debes',className:'inp',autoFocus:true,autoComplete:'off'}),
        acrOpen?h('div',{style:{position:'absolute',top:'100%',left:0,right:0,zIndex:5,marginTop:4,background:'var(--bg3)',border:'1px solid var(--border)',borderRadius:10,boxShadow:'0 8px 24px rgba(0,0,0,.35)',overflow:'hidden',maxHeight:182,overflowY:'auto'}},
          acrSugeridos.map(function(n){
            return h('div',{key:n,onMouseDown:function(e){e.preventDefault();setAcreedor(n);setShowSug(false);},onMouseEnter:function(e){e.currentTarget.style.background='var(--bg4)';},onMouseLeave:function(e){e.currentTarget.style.background='transparent';},style:{padding:'9px 12px',cursor:'pointer',fontSize:13,color:'var(--text)',display:'flex',alignItems:'center',gap:8,transition:'background .12s'}},
              h(Ico,{name:'users',size:13,color:'var(--text3)'}),n);
          })):null)),
    h(Fld,{label:'Titulo *'},h('input',{value:titulo,onChange:function(e){setTitulo(e.target.value);},placeholder:'Ej: Tarjeta Visa, Prestamo carro',className:'inp'})),
    h(Fld,{label:'Monto original (COP) *'},
      h('input',{type:'text',inputMode:'numeric',value:fmtNumInput(monto),onChange:function(e){if(!lockMonto)setMonto(parseNum(e.target.value));},placeholder:'0',className:'inp',disabled:lockMonto,style:lockMonto?{background:'var(--bg3)',color:'var(--text3)',cursor:'not-allowed'}:{}}),
      lockMonto?h('div',{style:{fontSize:11,color:'var(--text3)',marginTop:4}},'No se puede modificar el monto porque ya existen abonos registrados.'):null),
    h(Fld,{label:'Fecha de inicio'},h('input',{type:'date',value:fecha,onChange:function(e){setFecha(e.target.value);},className:'inp'})),
    h(Fld,{label:'Interes / Tasa pactada (opcional)'},h('input',{value:interes,onChange:function(e){setInteres(e.target.value);},placeholder:editing?'Se antepone a la descripcion':'Ej: 5% mensual',className:'inp'})),
    h(Fld,{label:'Descripcion (opcional)'},h('textarea',{value:concepto,onChange:function(e){setConcepto(e.target.value);},placeholder:'Ej: Pago de tarjeta, cubrir intereses',className:'inp',rows:2,style:{resize:'vertical',minHeight:58,fontFamily:'inherit'}})),
    (interes.trim()&&concepto.trim())?h('div',{style:{fontSize:11,color:'var(--text3)',fontStyle:'italic'}},'Se guardara como: "'+[interes.trim(),concepto.trim()].filter(Boolean).join(' - ')+'"'):null,
    (editing&&!lockMonto)?h('div',{style:{fontSize:11,color:'var(--text3)'}},'El saldo pendiente se recalcula automaticamente (monto - lo ya pagado).'):null,
    h('div',{style:{display:'flex',gap:8,marginTop:8}},
      h(ABtn,{color:'var(--green2)',disabled:sending,onClick:submit,icon:'check',label:sending?'Guardando...':(editing?'Guardar cambios':'Crear deuda')})));
}

function DebtPayModal(props){
  var debt=props.debt,onSave=props.onSave,onClose=props.onClose;
  var saldo=Math.round(+debt.saldo_pendiente||0);
  var s0=useState('abono'); var tipo=s0[0]; var setTipo=s0[1];
  var s1=useState(nowStr()); var fecha=s1[0]; var setFecha=s1[1];
  var s2=useState(''); var monto=s2[0]; var setMonto=s2[1];
  var s3=useState(''); var notas=s3[0]; var setNotas=s3[1];
  var s4=useState(false); var sending=s4[0]; var setSending=s4[1];   // v1.18.1: guarda anti doble-submit
  var m=Math.round(+monto||0);
  var esCargo=tipo==='cargo';
  var excede=!esCargo&&m>saldo;            // QA5: solo el abono tiene tope; el cargo no
  var valido=m>0&&!excede;
  var nuevoSaldo=esCargo?(saldo+m):(saldo-m);

  function submit(){
    // v1.18.1 — GEMELO EXACTO del Bug #29 en "Mis Deudas": POST /api/debts/:id/pay inserta
    // una fila nueva en el ledger `pagos_deudas` por cada request (genId() propio, sin clave
    // de idempotencia) y el saldo se RECALCULA desde ese ledger. Un doble clic duplicaba el
    // movimiento y dejaba el saldo mal de verdad, no solo la vista.
    if(sending) return;
    if(m<=0){showError('Ingresa el monto del movimiento');return;}
    if(excede){showError('El abono supera el saldo pendiente ('+fmt(saldo)+')');return;}
    _submitGuard(sending,setSending,function(){return onSave(debt.id,{monto_pagado:m,fecha_pago:fecha,notas:notas.trim(),tipo:tipo});});
  }
  function tipoBtn(val,label,activeColor){
    var on=tipo===val;
    return h('button',{type:'button',onClick:function(){setTipo(val);},style:{flex:1,padding:'9px 10px',border:'none',borderRadius:8,cursor:'pointer',fontWeight:700,fontSize:13,background:on?activeColor:'transparent',color:on?'#fff':'var(--text2)',transition:'all .15s'}},label);
  }

  return h(Modal,{onClose:onClose},
    h('div',{style:{fontWeight:700,fontSize:16,color:'var(--text)'}},'Registrar Movimiento'),
    h('div',{style:{background:'var(--bg3)',borderRadius:12,padding:'12px 14px',border:'1px solid var(--border)'}},
      h('div',{style:{fontWeight:700,color:'var(--text)'}},properCase(debt.acreedor)),
      (debt.titulo||debt.concepto)?h('div',{style:{fontSize:12,color:'var(--text3)',marginTop:2}},debt.titulo||debt.concepto):null,
      h('div',{style:{fontSize:11,color:'var(--text3)',marginTop:8,textTransform:'uppercase',letterSpacing:'.5px'}},'Saldo pendiente'),
      h('div',{className:'mono',style:{fontSize:20,fontWeight:700,color:'var(--yellow)'}},fmt(saldo))),
    h('div',{style:{marginTop:6}},
      h('div',{style:{fontSize:12,fontWeight:600,color:'var(--text2)',marginBottom:5}},'Tipo de movimiento'),
      h('div',{style:{display:'flex',gap:6,background:'var(--bg3)',border:'1px solid var(--border)',borderRadius:10,padding:3}},
        tipoBtn('abono','Abono (-)','var(--green2)'),
        tipoBtn('cargo','Cargo (+)','#b91c1c')),
      h('div',{style:{fontSize:11,color:'var(--text3)',marginTop:5}},esCargo?'Aumenta la deuda (te prestaron mas dinero).':'Disminuye la deuda (pagaste / abonaste).')),
    h(Fld,{label:'Fecha'},h('input',{type:'date',value:fecha,onChange:function(e){setFecha(e.target.value);},className:'inp'})),
    h(Fld,{label:(esCargo?'Monto del cargo':'Monto a abonar')+' (COP) *'},
      h('input',{type:'text',inputMode:'numeric',value:fmtNumInput(monto),onChange:function(e){setMonto(parseNum(e.target.value));},placeholder:'0',className:'inp',style:excede?{border:'1px solid var(--red)'}:{}}),
      (m>0)?h('div',{style:{fontSize:11,marginTop:4,fontFamily:'monospace',color:excede?'var(--red)':'var(--text2)'}},
        excede?('Supera el saldo por '+fmt(m-saldo)):(esCargo?('La deuda subiria a '+fmt(nuevoSaldo)):(m>=saldo?'Con este abono la deuda quedaria SALDADA':'Quedaria pendiente: '+fmt(saldo-m)))):null),
    h(Fld,{label:'Notas (opcional)'},h('input',{value:notas,onChange:function(e){setNotas(e.target.value);},placeholder:'Detalles del movimiento...',className:'inp'})),
    h('div',{style:{display:'flex',gap:8,marginTop:8}},
      h(ABtn,{color:valido?(esCargo?'#b91c1c':'var(--green2)'):'var(--bg4)',disabled:sending,onClick:valido?submit:function(){},icon:'check',label:sending?'Registrando...':(esCargo?'Registrar cargo':'Registrar abono')})));
}

// Historial de pagos de una deuda. Consume GET /api/debts/:id (incluye su ledger pagos_deudas).
function DebtHistoryModal(props){
  var debt=props.debt,onClose=props.onClose;
  var s1=useState(null); var data=s1[0]; var setData=s1[1];
  var s2=useState(true); var loading=s2[0]; var setLoading=s2[1];
  useEffect(function(){
    var alive=true;
    API.get('/api/debts/'+debt.id).then(function(r){ if(!alive) return; setData(r||null); setLoading(false); });
    return function(){ alive=false; };
  },[debt.id]);
  var pagos=(data&&data.pagos)||[];
  var saldo=data?data.saldo_pendiente:debt.saldo_pendiente;
  var totAbonos=pagos.reduce(function(s,p){return s+(p.tipo==='cargo'?0:(+p.monto_pagado||0));},0);
  var totCargos=pagos.reduce(function(s,p){return s+(p.tipo==='cargo'?(+p.monto_pagado||0):0);},0);
  function fila(label,value,color){
    return h('div',{style:{display:'flex',justifyContent:'space-between',marginTop:3,fontSize:12}},
      h('span',{style:{color:'var(--text3)'}},label),
      h('span',{className:'mono',style:{color:color,fontWeight:700}},value));
  }

  return h(Modal,{onClose:onClose,tall:true},
    h('div',{style:{fontWeight:700,fontSize:16,color:'var(--text)'}},'Estado de cuenta'),
    h('div',{style:{background:'var(--bg3)',borderRadius:12,padding:'12px 14px',border:'1px solid var(--border)'}},
      h('div',{style:{fontWeight:700,color:'var(--text)'}},properCase(debt.acreedor)),
      (debt.titulo||debt.concepto)?h('div',{style:{fontSize:12,color:'var(--text3)',marginTop:2}},debt.titulo||debt.concepto):null,
      h('div',{style:{height:1,background:'var(--border)',margin:'8px 0'}}),
      fila('Abonos','− '+fmt(totAbonos),'var(--green)'),
      (totCargos>0)?fila('Cargos','+ '+fmt(totCargos),'var(--red)'):null,
      fila('Saldo pendiente',fmt(saldo),(saldo||0)>0?'var(--yellow)':'var(--green)')),
    loading?
      h('div',{style:{textAlign:'center',padding:24,color:'var(--text3)',fontSize:13}},'Cargando...')
    : pagos.length===0?
      h('div',{style:{textAlign:'center',padding:24,color:'var(--text3)'}},
        h(Ico,{name:'clipboard',size:28,color:'var(--text3)'}),
        h('p',{style:{marginTop:10,fontSize:13}},'Aun no hay movimientos registrados'))
    :
      h('div',{style:{display:'flex',flexDirection:'column',gap:8}},
        h('div',{style:{fontSize:11,fontWeight:700,color:'var(--text3)',textTransform:'uppercase',letterSpacing:'.5px'}},pagos.length+' movimiento'+(pagos.length===1?'':'s')),
        pagos.map(function(p){
          var esCargo=p.tipo==='cargo';
          var color=esCargo?'var(--red)':'var(--green)';
          return h('div',{key:p.id,style:{background:'var(--bg3)',border:'1px solid var(--border)',borderLeft:'3px solid '+color,borderRadius:10,padding:'10px 12px',display:'flex',justifyContent:'space-between',alignItems:'flex-start',gap:10}},
            h('div',{style:{minWidth:0}},
              h('div',{style:{display:'flex',alignItems:'center',gap:8,marginBottom:2}},
                h('span',{style:{fontSize:10,fontWeight:700,color:color,background:color+'20',padding:'2px 7px',borderRadius:99,textTransform:'uppercase',letterSpacing:'.5px'}},esCargo?'Cargo':'Abono'),
                h('span',{style:{fontSize:13,color:'var(--text)',fontWeight:600}},fmtD((p.fecha_pago||'').slice(0,10)))),
              p.notas?h('div',{style:{fontSize:12,color:'var(--text3)'}},p.notas):null),
            h('div',{className:'mono',style:{fontSize:14,fontWeight:700,color:color,whiteSpace:'nowrap'}},(esCargo?'+ ':'− ')+fmt(p.monto_pagado)));
        })));
}

// Confirmacion de borrado de deuda (reemplaza window.confirm; estetica de la app, dark-mode).
function DeleteDebtModal(props){
  var debt=props.debt,onConfirm=props.onConfirm,onClose=props.onClose;
  var titulo=debt.titulo||debt.concepto||'esta deuda';
  return h(Modal,{onClose:onClose},
    h('div',{style:{display:'flex',alignItems:'center',gap:10}},
      h('div',{style:{background:'var(--red)20',borderRadius:10,padding:9,display:'flex',flexShrink:0}},h(Ico,{name:'alert',size:18,color:'var(--red)'})),
      h('div',{style:{fontWeight:700,fontSize:16,color:'var(--text)'}},'Eliminar deuda')),
    h('div',{style:{fontSize:14,color:'var(--text)',lineHeight:'1.5'}},'¿Eliminar la deuda "'+titulo+'" con '+properCase(debt.acreedor)+'?'),
    h('div',{style:{fontSize:12,color:'var(--text3)',lineHeight:'1.5'}},'Se borrara tambien su historial de pagos. Esta accion no se puede deshacer.'),
    h('div',{style:{display:'flex',gap:8,marginTop:14}},
      h('button',{onClick:onClose,style:{flex:1,background:'var(--bg3)',border:'1px solid var(--border)',borderRadius:12,padding:'12px 8px',fontSize:13,fontWeight:700,cursor:'pointer',color:'var(--text2)',fontFamily:'inherit'}},'Cancelar'),
      h('button',{onClick:onConfirm,style:{flex:1,background:'var(--red)',border:'none',borderRadius:12,padding:'12px 8px',fontSize:13,fontWeight:700,cursor:'pointer',color:'#fff',fontFamily:'inherit',display:'flex',alignItems:'center',justifyContent:'center',gap:6}},
        h(Ico,{name:'trash',size:15,color:'#fff',sw:2.2}),'Eliminar')));
}

// ── Desarrollador ─────────────────────────────────────────────────────────────
function DevView(props){
  var showToast=props.showToast;
  var isMac=props.isMac;
  var onNeedsRestart=props.onNeedsRestart;
  var onSync=props.onSync;
  var s1=useState(''); var dbPath=s1[0]; var setDbPath=s1[1];
  var s2=useState(false); var loading=s2[0]; var setLoading=s2[1];
  var s3=useState(''); var appVersion=s3[0]; var setAppVersion=s3[1];
  var s4=useState(null); var updateInfo=s4[0]; var setUpdateInfo=s4[1];
  var s5=useState(props.datosPago||''); var datosPago=s5[0]; var setDatosPago=s5[1];
  var s6=useState(false); var savingPago=s6[0]; var setSavingPago=s6[1];
  var hasAPI=typeof window.electronAPI!=='undefined';

  function saveDatosPago(){
    if(!props.onSaveConfig) return;
    setSavingPago(true);
    Promise.resolve(props.onSaveConfig({datos_pago:datosPago})).then(function(){
      setSavingPago(false);
      showToast('Datos de pago guardados');
    }).catch(function(){ setSavingPago(false); });
  }

  useEffect(function(){
    if(!hasAPI) return;
    window.electronAPI.getDbPath().then(setDbPath);
    window.electronAPI.getAppVersion().then(setAppVersion);
    var unsub=window.electronAPI.onUpdateStatus(function(data){setUpdateInfo(data);});
    return unsub;
  },[]);

  function pickFolder(){
    if(!hasAPI) return;
    setLoading(true);
    window.electronAPI.pickDbFolder().then(function(folder){
      if(!folder){setLoading(false);return;}
      return window.electronAPI.setDbPath(folder).then(function(res){
        if(res && res.ok){
          setDbPath(res.path);
          setLoading(false);
          onNeedsRestart();
        } else {
          setLoading(false);
          showError(res && res.error ? res.error : 'Error al mover la base de datos');
        }
      });
    }).catch(function(){setLoading(false);showError('Error al mover la base de datos');});
  }

  function resetPath(){
    if(!hasAPI) return;
    props.onConfirm({title:'Restaurar ubicacion',message:'Volver a la ruta por defecto? La app usara la carpeta nativa del sistema.',okLabel:'Restaurar',okColor:'var(--yellow)',onConfirm:function(){
      window.electronAPI.resetDbPath().then(function(res){
        if(res && res.ok){
          setDbPath(res.path);
          onNeedsRestart();
        } else {
          showError(res && res.error ? res.error : 'Error al restaurar la base de datos');
        }
      });
    }});
  }

  return h('div',{className:'fade-in',style:{padding:'16px 14px'}},
    h('div',{style:{fontWeight:700,fontSize:18,color:'var(--text)',marginBottom:4,display:'flex',alignItems:'center',gap:6}},h(Ico,{name:'settings',size:18,color:'var(--text2)'}),' Desarrollador'),
    h('div',{style:{fontSize:12,color:'var(--text3)',marginBottom:16}},'Configuracion avanzada'),

    h('div',{style:{background:'var(--bg2)',borderRadius:14,padding:'16px',border:'1px solid var(--border)',marginBottom:12}},
      h('div',{style:{display:'flex',alignItems:'center',gap:8,marginBottom:12}},
        h(Ico,{name:'folder',size:18,color:'var(--blue)'}),
        h('span',{style:{fontWeight:700,fontSize:14,color:'var(--text)'}},'Ubicacion de la base de datos')),
      h('div',{style:{fontSize:11,color:'var(--text3)',marginBottom:12}},'Puedes guardar tu base de datos en cualquier carpeta (ej: iCloud Drive, OneDrive, Dropbox). Solo la BD se mueve, los archivos de la app quedan en su lugar.'),
      h('div',{style:{background:'var(--bg3)',borderRadius:10,padding:'10px 12px',border:'1px solid var(--border)',marginBottom:12,wordBreak:'break-all'}},
        h('div',{style:{fontSize:9,color:'var(--text3)',fontWeight:600,marginBottom:3}},'RUTA ACTUAL'),
        h('div',{className:'mono',style:{fontSize:11,color:'var(--blue)'}},dbPath||'Cargando...')),
      h('div',{style:{display:'flex',gap:8}},
        h('button',{onClick:pickFolder,disabled:loading||!hasAPI,style:{flex:1,background:'var(--blue-bg)',color:'var(--blue)',border:'1px solid var(--blue-bd)',borderRadius:10,padding:'10px',fontSize:12,fontWeight:600,cursor:hasAPI?'pointer':'not-allowed',fontFamily:'inherit',display:'flex',alignItems:'center',justifyContent:'center',gap:6}},
          h(Ico,{name:'folder',size:13,color:'var(--blue)'}),loading?'Moviendo...':'Cambiar ubicacion'),
        h('button',{onClick:resetPath,disabled:!hasAPI,style:{background:'var(--bg3)',color:'var(--text2)',border:'1px solid var(--border)',borderRadius:10,padding:'10px 14px',fontSize:12,fontWeight:600,cursor:hasAPI?'pointer':'not-allowed',fontFamily:'inherit'}},'Restaurar')),
      !hasAPI&&h('div',{style:{marginTop:10,fontSize:11,color:'var(--yellow)',background:'var(--yellow-bg)',borderRadius:8,padding:'8px 10px',border:'1px solid var(--yellow)'}},'Esta funcion solo esta disponible en la app de escritorio (Electron). En el navegador no se puede acceder al sistema de archivos.')),

    h('div',{style:{background:'var(--bg2)',borderRadius:14,padding:'16px',border:'1px solid var(--border)',marginBottom:12}},
      h('div',{style:{display:'flex',alignItems:'center',gap:8,marginBottom:8}},
        h(Ico,{name:'alert',size:16,color:'var(--yellow)'}),
        h('span',{style:{fontWeight:700,fontSize:14,color:'var(--text)'}},'Importante')),
      h('ul',{style:{fontSize:12,color:'var(--text2)',margin:0,paddingLeft:20,lineHeight:1.8}},
        h('li',null,'Al cambiar la ubicacion, la BD actual se ',h('strong',null,'copia'),' a la nueva carpeta.'),
        h('li',null,'Debes ',h('strong',null,'reiniciar la app'),' despues de cambiar la ruta.'),
        h('li',null,'Si usas una carpeta en la nube (iCloud, OneDrive), tu BD se sincroniza automaticamente.'),
        h('li',null,'No abras la app en dos dispositivos al mismo tiempo.'))),

    h('div',{style:{background:'var(--bg2)',borderRadius:14,padding:'16px',border:'1px solid var(--border)',marginBottom:12}},
      h('div',{style:{fontWeight:600,fontSize:13,color:'var(--text)',marginBottom:8}},'Info del sistema'),
      h('div',{style:{display:'grid',gridTemplateColumns:'1fr 1fr',gap:6}},
        h('div',{style:{fontSize:10,color:'var(--text3)'}},'Version'),
        h('div',{className:'mono',style:{fontSize:10,color:'var(--text2)'}},appVersion||'...'),
        h('div',{style:{fontSize:10,color:'var(--text3)'}},'Motor'),
        h('div',{className:'mono',style:{fontSize:10,color:'var(--text2)'}},'Electron + Express'),
        h('div',{style:{fontSize:10,color:'var(--text3)'}},'Base de datos'),
        h('div',{className:'mono',style:{fontSize:10,color:'var(--text2)'}},'SQLite (better-sqlite3)'),
        h('div',{style:{fontSize:10,color:'var(--text3)'}},'Frontend'),
        h('div',{className:'mono',style:{fontSize:10,color:'var(--text2)'}},'React 18 UMD'))),

    h('div',{style:{background:'var(--bg2)',borderRadius:14,padding:'16px',border:'1px solid var(--border)'}},
      h('div',{style:{display:'flex',alignItems:'center',gap:8,marginBottom:12}},
        h(Ico,{name:'download',size:18,color:'var(--green)'}),
        h('span',{style:{fontWeight:700,fontSize:14,color:'var(--text)'}},'Actualizaciones')),

      !updateInfo||updateInfo.status==='not-available'?
        h('div',null,
          h('div',{style:{fontSize:12,color:'var(--text2)',marginBottom:10}},'Tu app esta al dia.'),
          h('button',{onClick:function(){if(hasAPI)window.electronAPI.checkForUpdates();setUpdateInfo({status:'checking'});},disabled:!hasAPI,style:{background:'var(--bg3)',color:'var(--text)',border:'1px solid var(--border)',borderRadius:10,padding:'10px 16px',fontSize:12,fontWeight:600,cursor:'pointer',fontFamily:'inherit',display:'flex',alignItems:'center',gap:6}},
            h(Ico,{name:'refresh',size:13,color:'var(--text2)'}),'Buscar actualizaciones')):

      updateInfo.status==='checking'?
        h('div',{style:{fontSize:12,color:'var(--text2)',display:'flex',alignItems:'center',gap:8}},
          h('div',{className:'spinner'}),
          'Buscando actualizaciones...'):

      updateInfo.status==='dev-mode'?
        h('div',{style:{fontSize:12,color:'var(--yellow)'}},'Modo desarrollo — las actualizaciones solo funcionan en la app instalada.'):

      updateInfo.status==='available'?
        h('div',null,
          h('div',{style:{fontSize:12,color:'var(--green)',marginBottom:10,fontWeight:600}},'Nueva version disponible: v'+updateInfo.version),
          h('button',{onClick:function(){window.electronAPI.downloadUpdate();},style:{background:'var(--green-bg)',color:'var(--green)',border:'1px solid var(--green-bd)',borderRadius:10,padding:'10px 16px',fontSize:12,fontWeight:600,cursor:'pointer',fontFamily:'inherit',display:'flex',alignItems:'center',gap:6}},
            h(Ico,{name:'download',size:13,color:'var(--green)'}),'Descargar actualizacion')):

      updateInfo.status==='downloading'?
        h('div',null,
          h('div',{style:{fontSize:12,color:'var(--blue)',marginBottom:8}},'Descargando... '+(updateInfo.percent||0)+'%'),
          h('div',{style:{background:'var(--bg3)',borderRadius:6,height:6,overflow:'hidden'}},
            h('div',{style:{width:(updateInfo.percent||0)+'%',height:'100%',background:'var(--blue)',borderRadius:6,transition:'width .3s'}}))):

      updateInfo.status==='downloaded'?
        h('div',null,
          h('div',{style:{fontSize:12,color:'var(--green)',marginBottom:10,fontWeight:600}},'v'+updateInfo.version+' lista para instalar'),
          h('button',{onClick:function(){window.electronAPI.installUpdate();},style:{background:'var(--green2)',color:'#fff',border:'none',borderRadius:10,padding:'10px 16px',fontSize:12,fontWeight:600,cursor:'pointer',fontFamily:'inherit',display:'flex',alignItems:'center',gap:6}},
            h(Ico,{name:'refresh',size:13,color:'#fff'}),'Reiniciar e instalar')):

      updateInfo.status==='error'?
        h('div',null,
          h('div',{style:{fontSize:12,color:'var(--red)',marginBottom:10}},'Error: '+(updateInfo.message||'No se pudo verificar')),
          h('button',{onClick:function(){if(hasAPI)window.electronAPI.checkForUpdates();setUpdateInfo({status:'checking'});},style:{background:'var(--bg3)',color:'var(--text)',border:'1px solid var(--border)',borderRadius:10,padding:'10px 16px',fontSize:12,fontWeight:600,cursor:'pointer',fontFamily:'inherit'}},'Reintentar')):null),

    h('div',{style:{background:'var(--bg2)',borderRadius:14,padding:'16px',border:'1px solid var(--border)',marginBottom:12}},
      h('div',{style:{display:'flex',alignItems:'center',gap:8,marginBottom:8}},
        h(Ico,{name:'download',size:18,color:'var(--green)'}),
        h('span',{style:{fontWeight:700,fontSize:14,color:'var(--text)'}},'Reporte de prestamos')),
      h('div',{style:{fontSize:11,color:'var(--text3)',marginBottom:12}},'Descarga un PDF con todos los prestamos activos (deudor, modalidad, tasa, saldo pendiente y estado). Las cuotas en mora se detallan bajo cada prestamo y al final se totaliza el capital en la calle.'),
      h('button',{onClick:function(){
        var activos=(props.loans||[]).filter(function(l){return l.estado==='Activo';});
        if(activos.length===0){showToast('No hay prestamos activos para el reporte','error');return;}
        generateReportePrestamosPDF(props.loans,props.pays,document.documentElement.getAttribute('data-theme')==='dark');
      },style:{background:'var(--green-bg)',color:'var(--green)',border:'1px solid var(--green-bd)',borderRadius:10,padding:'10px 16px',fontSize:12,fontWeight:600,cursor:'pointer',fontFamily:'inherit',display:'flex',alignItems:'center',gap:6}},
        h(Ico,{name:'download',size:13,color:'var(--green)'}),'Descargar Reporte de Prestamos (PDF)')),

    h('div',{style:{background:'var(--bg2)',borderRadius:14,padding:'16px',border:'1px solid var(--border)',marginBottom:12}},
      h('div',{style:{display:'flex',alignItems:'center',gap:8,marginBottom:8}},
        h(Ico,{name:'receipt',size:18,color:'var(--blue)'}),
        h('span',{style:{fontWeight:700,fontSize:14,color:'var(--text)'}},'Datos de pago (recibo de cobro)')),
      h('div',{style:{fontSize:11,color:'var(--text3)',marginBottom:10}},'Este texto aparece en el bloque "Como pagar" del Recibo de Cobro (Factura) que generas desde la vista Pagos. Ej: cuentas, Nequi/Daviplata, a nombre de quien. Si lo dejas vacio, el bloque no se muestra.'),
      h('textarea',{value:datosPago,onChange:function(e){setDatosPago(e.target.value);},rows:4,placeholder:'Transferencia / Nequi / Daviplata\nA nombre de ...\nCel. ...',style:{width:'100%',resize:'vertical',fontFamily:'inherit',fontSize:12,color:'var(--text)',background:'var(--bg3)',border:'1px solid var(--border)',borderRadius:10,padding:'10px 12px',boxSizing:'border-box'}}),
      h('button',{onClick:saveDatosPago,disabled:savingPago,style:{marginTop:10,background:'var(--blue-bg)',color:'var(--blue)',border:'1px solid var(--blue-bd)',borderRadius:10,padding:'10px 16px',fontSize:12,fontWeight:600,cursor:'pointer',fontFamily:'inherit',display:'flex',alignItems:'center',gap:6}},
        h(Ico,{name:'check',size:13,color:'var(--blue)'}),savingPago?'Guardando...':'Guardar datos de pago')),

    h('div',{style:{background:'var(--bg2)',borderRadius:14,padding:'16px',border:'1px solid var(--border)'}},
      h('div',{style:{display:'flex',alignItems:'center',gap:8,marginBottom:8}},
        h(Ico,{name:'refresh',size:18,color:'var(--yellow)'}),
        h('span',{style:{fontWeight:700,fontSize:14,color:'var(--text)'}},'Sincronizar datos')),
      h('div',{style:{fontSize:11,color:'var(--text3)',marginBottom:12}},'Recalcula todos los cronogramas activos. Se ejecuta automaticamente al abrir la app. Usa este boton solo si notas inconsistencias.'),
      h('button',{onClick:function(){onSync();showToast('Cronogramas recalculados');},style:{background:'var(--bg3)',color:'var(--text)',border:'1px solid var(--border)',borderRadius:10,padding:'10px 16px',fontSize:12,fontWeight:600,cursor:'pointer',fontFamily:'inherit',display:'flex',alignItems:'center',gap:6}},
        h(Ico,{name:'refresh',size:13,color:'var(--text2)'}),'Sincronizar manualmente')));
}

// ── Shared ────────────────────────────────────────────────────────────────────
function Modal(props){
  var children=props.children,onClose=props.onClose,tall=props.tall,wide=props.wide;
  // QA3: el backdrop ya NO cierra el modal (proteccion contra perdida de datos). Solo cierran la X o los botones de accion.
  return h('div',{style:{position:'fixed',inset:0,background:'rgba(0,0,0,.75)',display:'flex',alignItems:'center',justifyContent:'center',zIndex:100,backdropFilter:'blur(4px)'}},
    h('div',{className:'modal-sheet',style:{background:'var(--bg2)',border:'1px solid var(--border)',width:'90%',maxWidth:wide?700:560,borderRadius:16,maxHeight:tall?'90vh':'80vh',display:'flex',flexDirection:'column',boxShadow:'0 8px 32px rgba(0,0,0,.4)'}},
      h('div',{style:{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'16px 20px 0',flexShrink:0}},
        h('div',null),
        h('button',{onClick:onClose,style:{background:'var(--bg3)',border:'1px solid var(--border)',borderRadius:99,width:30,height:30,display:'flex',alignItems:'center',justifyContent:'center',cursor:'pointer'}},
          h(Ico,{name:'x',size:14,color:'var(--text2)',sw:2.5}))),
      h('div',{style:{overflowY:'auto',padding:'12px 20px 24px',display:'flex',flexDirection:'column',gap:12,flex:1}},children)));
}
function Fld(props){return h('div',{style:{marginTop:6}},h('div',{style:{fontSize:12,fontWeight:600,color:'var(--text2)',marginBottom:5}},props.label),props.children);}
// v1.18.1 — prop opcional `disabled` (para las guardas anti doble-submit). Sin ella el
// componente se comporta exactamente igual que antes, asi que los usos existentes no cambian.
function ABtn(props){
  var dis=!!props.disabled;
  return h('button',{onClick:dis?undefined:props.onClick,disabled:dis,style:{flex:1,background:dis?'var(--bg3)':props.color,color:dis?'var(--text3)':'white',border:'none',borderRadius:12,padding:'12px 8px',fontSize:13,fontWeight:700,cursor:dis?'not-allowed':'pointer',display:'flex',alignItems:'center',justifyContent:'center',gap:6,opacity:dis?.75:1}},h(Ico,{name:props.icon,size:15,color:dis?'var(--text3)':'white',sw:2.2}),props.label);
}
// ── ConfirmUndoModal (v2.1 — "La Bestia" Fase 2) ──────────────────────────────
// Confirmacion de deshacer. NUNCA se revierte con un solo clic: deshacer una operacion
// financiera puede contradecir un documento que el deudor ya tiene en la mano, asi que el
// usuario debe ver QUE se va a revertir y con que riesgos antes de decidir.
// Candado C (tiempo): advierte si la operacion tiene mas de 24 h. No BLOQUEA — el Candado A
//   (LIFO) ya garantiza que nada se construyo encima, y un error se detecta igual al dia
//   siguiente; poner un limite duro seria friccion sin seguridad real.
// Candado D (recibo): si la operacion movio caja (afecta_caja, declarado por el backend en el
//   journal), avisa que probablemente exista un recibo PDF en manos del cliente.
function ConfirmUndoModal(props){
  var e=props.entry||{};
  var onConfirm=props.onConfirm,onClose=props.onClose;
  var sS=useState(false); var sending=sS[0]; var setSending=sS[1];   // guarda anti doble-submit

  // created_at viene como 'YYYY-MM-DD HH:MM:SS' en hora LOCAL (datetime('now','localtime')).
  var creada=e.created_at?new Date(String(e.created_at).replace(' ','T')):null;
  var horas=creada?Math.floor((Date.now()-creada.getTime())/36e5):0;
  var esVieja=horas>=24;
  var antiguedad=!creada?'':(horas<1?'hace menos de una hora':(horas<24?'hace '+horas+' hora'+(horas!==1?'s':''):'hace '+Math.floor(horas/24)+' dia'+(Math.floor(horas/24)!==1?'s':'')));
  var afectaCaja=!!(+e.afecta_caja);
  var esDeuda=e.scope_tipo==='debt';

  function aviso(color,bg,bd,icono,titulo,cuerpo){
    return h('div',{style:{background:bg,border:'1px solid '+bd,borderRadius:10,padding:'10px 12px',marginTop:10,display:'flex',gap:9,alignItems:'flex-start'}},
      h(Ico,{name:icono,size:14,color:color,sw:2.4}),
      h('div',{style:{flex:1,minWidth:0}},
        h('div',{style:{fontSize:11,fontWeight:700,color:color,letterSpacing:'.3px',marginBottom:2}},titulo),
        h('div',{style:{fontSize:11,color:'var(--text2)',lineHeight:1.5}},cuerpo)));
  }

  return h(Modal,{onClose:onClose},
    h('div',{style:{fontWeight:700,fontSize:16,color:'var(--text)',marginBottom:3,display:'flex',alignItems:'center',gap:8}},
      h(Ico,{name:'refresh',size:16,color:'var(--purple)',sw:2.4}),'Deshacer operacion'),
    h('div',{style:{fontSize:12,color:'var(--text3)',marginBottom:13}},'Se restaurara el estado exacto anterior a esta operacion.'),

    // Resumen de lo que se revierte
    h('div',{style:{background:'var(--bg3)',border:'1px solid var(--border)',borderRadius:12,padding:'12px 14px'}},
      h('div',{style:{fontSize:10,fontWeight:700,color:'var(--text3)',letterSpacing:'.5px',marginBottom:6}},'SE VA A REVERTIR'),
      h('div',{style:{fontSize:13,color:'var(--text)',lineHeight:1.5,fontWeight:500}},e.descripcion||'(sin descripcion)'),
      creada&&h('div',{style:{fontSize:11,color:'var(--text3)',marginTop:6,display:'flex',alignItems:'center',gap:5}},
        h(Ico,{name:'clock',size:11,color:'var(--text3)',sw:2.2}),
        String(e.created_at).slice(0,16)+' · '+antiguedad)),

    // ── CANDADO C — antigüedad ──
    esVieja&&aviso('var(--yellow)','var(--yellow-bg)','var(--yellow)','alert','OPERACION ANTIGUA',
      'Se registro '+antiguedad+'. Revisa que no hayas construido nada sobre ella (reportes enviados, cierres de caja o conciliaciones ya hechas).'),

    // ── CANDADO D — recibo probablemente entregado ──
    afectaCaja&&aviso('var(--red)','var(--red-bg)','var(--red-bd)','receipt','DINERO YA REGISTRADO',
      esDeuda
        ? 'Este movimiento registro dinero real. Al revertirlo, el saldo de la deuda volvera a su valor anterior: confirma que el pago efectivamente no ocurrio.'
        : 'Es probable que el cliente YA tenga en sus manos un recibo PDF con esta informacion. Si lo deshaces, tu sistema dejara de coincidir con ese documento. Asegurate de acordarlo con el deudor.'),

    // Nota permanente: el historial es append-only
    h('div',{style:{fontSize:11,color:'var(--text3)',lineHeight:1.5,marginTop:12}},
      'La operacion quedara marcada como revertida en el historial. El registro NO se borra: queda la huella de que ocurrio y de que se deshizo.'),

    h('div',{style:{display:'flex',gap:10,marginTop:16}},
      h('button',{onClick:function(){_submitGuard(sending,setSending,function(){return onConfirm(e);});},disabled:sending,
        style:{flex:1,background:sending?'var(--bg3)':'var(--purple-bg)',color:sending?'var(--text3)':'var(--purple)',
          border:'1px solid '+(sending?'var(--border)':'var(--purple)'),borderRadius:10,padding:'11px 0',fontSize:13,fontWeight:700,
          cursor:sending?'not-allowed':'pointer',fontFamily:'inherit'}},sending?'Deshaciendo...':'Si, deshacer'),
      h('button',{onClick:onClose,style:{flex:1,background:'var(--bg3)',color:'var(--text2)',border:'1px solid var(--border)',borderRadius:10,padding:'11px 0',fontSize:13,fontWeight:700,cursor:'pointer',fontFamily:'inherit'}},'Cancelar')));
}

function ConfirmModal(props){
  var title=props.title||'Confirmar';var msg=props.message||'';var detail=props.detail;
  var onOk=props.onConfirm;var onNo=props.onCancel;var okLabel=props.okLabel||'Aceptar';var okColor=props.okColor||'var(--green2)';
  var chk=useState(false);var checked=chk[0];var setChecked=chk[1];
  return h('div',{style:{position:'fixed',inset:0,background:'rgba(0,0,0,.75)',display:'flex',alignItems:'center',justifyContent:'center',zIndex:200,backdropFilter:'blur(4px)'},onClick:onNo},
    h('div',{style:{background:'var(--bg2)',border:'1px solid var(--border)',borderRadius:16,padding:'20px 22px',maxWidth:360,width:'90%',boxShadow:'0 8px 32px rgba(0,0,0,.4)'},onClick:function(e){e.stopPropagation();}},
      h('div',{style:{fontWeight:700,fontSize:15,color:'var(--text)',marginBottom:8}},title),
      h('div',{style:{fontSize:13,color:'var(--text2)',lineHeight:'1.5',whiteSpace:'pre-line'}},msg),
      detail&&h('div',{className:'mono',style:{fontSize:16,fontWeight:700,color:'var(--green)',marginTop:8}},detail),
      props.checkLabel&&h('label',{style:{display:'flex',alignItems:'center',gap:8,marginTop:12,cursor:'pointer',fontSize:12,color:'var(--text2)'}},
        h('input',{type:'checkbox',checked:checked,onChange:function(){setChecked(!checked);},style:{width:16,height:16,accentColor:'var(--green)',cursor:'pointer'}}),
        props.checkLabel),
      h('div',{style:{display:'flex',gap:10,marginTop:18}},
        h('button',{onClick:function(){onOk(checked);},style:{flex:1,background:okColor,color:'white',border:'none',borderRadius:10,padding:'10px 0',fontSize:13,fontWeight:700,cursor:'pointer'}},okLabel),
        h('button',{onClick:onNo,style:{flex:1,background:'var(--bg3)',color:'var(--text2)',border:'1px solid var(--border)',borderRadius:10,padding:'10px 0',fontSize:13,fontWeight:700,cursor:'pointer'}},'Cancelar'))));
}

createRoot(document.getElementById('root')).render(h(App,null));
