// public/js/core/dominio.js — EL CORAZON FINANCIERO DEL FRONTEND.
//
// Extraido de `app.js` en la Etapa 3 (B4) del refactor. Codigo VERBATIM: ni una
// constante, ni un redondeo, ni un `>=` cambiaron. Un cambio de comportamiento
// aqui no seria un bug de refactor, seria plata mal contada.
//
// Estos 6 helpers son la UNICA implementacion de sus reglas. La app tuvo tres
// doctrinas conviviendo para lo mismo (ignorar el parcial, contarlo como caja
// bruta, o volcarlo entero en el evento que saldaba la cuota) y de ahi salieron
// los Bugs #44 y #45. Nunca reimplementar ninguna de estas formulas inline.
//
// LO QUE SOSTIENEN, y que no se toca al moverlas:
//
//  cobrosDe(p)          Fuente de verdad del flujo de caja: ledger `recibos` CON
//                       FALLBACK EXCLUYENTE a fechaRecaudo. Ledger O fallback,
//                       jamas los dos -> por construccion no hay doble conteo.
//
//  imputarCobros(pay)   Reparte cada evento de caja en cascada INTERES -> CAPITAL
//                       (Codigo Civil art. 1653; decision de negocio del usuario).
//                       Invariante: interes + capital + ajuste === cop en CADA
//                       evento. `ajuste` es el hueco entre caja y composicion: en
//                       USD es el efecto cambiario; en COP, el residuo de
//                       redondeo de las filas legacy del Bug #43.
//                       NUNCA filtrar por estadoPago==='Pagado' para decidir si un
//                       pago cuenta: eso es lo que hacia invisibles los parciales.
//
//  saldoConCaja()       El saldo CON CAJA APLICADA, que es el que se MUESTRA.
//                       Distinto del saldo del MOTOR (que gobierna decisiones y
//                       vive en el backend). Un parcial NO re-amortiza, asi que el
//                       del motor no baja; este si. Son dos cosas con dos nombres
//                       a proposito — confundirlos es la clase de falla de los
//                       Bugs #35 y #19.
//
//  computeLiquidacion() Unica fuente del "Valor de liquidacion", consumida por 5
//                       superficies. Resta los parciales APARTE del total; por eso
//                       los PDF no pueden migrarla a saldoConCaja (los restaria
//                       dos veces).
//
// Cubierto por tests/props-dominio.js: 116 asertos de invariantes sobre las 157
// cuotas y los 26 prestamos reales.

// v1.11.4: eventos de caja reales de un pago. Devuelve [{fecha:'YYYY-MM-DD', cop:int}].
// Fuente de verdad = ledger payments.recibos (cada parcial en su fecha + el pago final). Si la fila
// no tiene ledger (historico previo, abonos a capital, liquidaciones de mora) cae al FALLBACK: un
// unico evento en fechaRecaudo por (montoCOPRecibido||cuotaTotal). metrics.recibido y sparkCobros
// usan ESTA funcion -> el KPI y la suma del grafico cuadran por construccion, sin doble conteo.
export function cobrosDe(p){
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
export function imputarCobros(pay){
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
export function saldoConCaja(loan, loanPays){
  if(!loan) return 0;
  var origCOP=loan.moneda==='USD'?Math.round(loan.montoOrigen*loan.trmAcordada):Math.round(loan.montoOrigen);
  var lp=(loanPays||[]).filter(function(p){return String(p.prestamoId)===String(loan.id);});
  var cap=lp.reduce(function(s,p){return s+imputarCobros(p).totales.capital;},0);
  return Math.max(0,origCOP-Math.round(cap));
}
// Rubros que AUN se deben de una cuota, tras aplicar lo ya abonado en cascada interes -> capital.
// Los PDFs prospectivos (factura de cobro) deben exigir esto, no la composicion nominal: si no,
// el documento cobra un interes que el parcial ya cubrio y sus filas no suman el total exigido.
export function pendienteDeCuota(pay){
  var intTot=Math.round(pay.interesPeriodo||0);
  var capTot=Math.max(0,Math.round(pay.cuotaTotal||0)-intTot);
  var imp=imputarCobros(pay).totales;
  return {interes:Math.max(0,intTot-imp.interes), capital:Math.max(0,capTot-imp.capital)};
}

// ── FLUJO DE CAJA REAL de un prestamo (v2.2.0) ────────────────────────────────
// Reconstruye lo que REALMENTE entro, cuando entro, a partir de la unica fuente fiable:
// los eventos de caja de cobrosDe(p) — el ledger `recibos` con fallback a fechaRecaudo.
// Se descartaron las alternativas: activity_log es texto libre sin FK ni montos estructurados,
// y undo_journal solo guarda 200 entradas / 90 dias (no existe para prestamos historicos).
// Auditado sobre la BD real: NINGUNA cuota pagada carece de fechaRecaudo, asi que esta fuente
// cubre el 100% de la historia. Cada evento se enriquece con los metadatos de su fila padre:
// el ledger aporta CUANDO y CUANTO, la fila aporta QUE era.
export function flujoCajaDe(loan, loanPays){
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
export function computeLiquidacion(loan, loanPays, opts){
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

// Saldo restante de una cuota considerando pagos parciales.
// Convive con `pendienteDeCuota` (arriba), que hace el mismo calculo por otra via.
// NO se consolidan: la duplicacion es preexistente y unificarla seria cambiar logica.
// Saldo restante de una cuota considerando pagos parciales
export function pendCuota(p){ return Math.max(0,(p.cuotaTotal||0)-(p.partialPaid||0)); }
