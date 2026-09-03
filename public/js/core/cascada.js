// public/js/core/cascada.js — imputacion en CASCADA de un cobro sobre un credito.
//
// Responde a UNA pregunta: "el cliente entrego X, ¿contra que se aplica?".
// Devuelve un PLAN — una lista de pasos, cada uno con el endpoint que lo ejecuta
// y el desglose que se le muestra al usuario. NO ejecuta nada y NO toca React.
//
// ── POR QUE EXISTE ────────────────────────────────────────────────────────────
// Hasta v2.6.2 el dinero que entraba se registraba por una de tres puertas y cada
// una imputaba distinto: `/abono` mandaba el 100% a capital, `/partial` cobraba
// contra UNA cuota concreta, y `Liquidar` cerraba todo de golpe. Elegir mal no
// perdia plata —el capital adeudado sale igual en los tres casos— pero SI cambiaba
// que parte de la deuda quedaba rindiendo interes: un abono puro amortiza el
// capital vivo (que rinde la tasa pactada) y deja intacto el interes de mora ya
// causado (que NO rinde nada, porque una fila En Mora esta congelada: la auto-mora
// solo cambia `estadoPago`, no existe interes moratorio en el motor). Es decir, se
// pagaba primero el activo que rendia y se dejaba vivo el que no.
//
// El orden que implementa este modulo es el del art. 1653 del Codigo Civil
// ("el pago se imputara primeramente a los intereses") y es el mismo que
// `imputarCobros` ya aplicaba para PRESENTAR un parcial. La asimetria era que la
// cascada existia al mostrar el dinero pero no al recibirlo.
//
// ── LO QUE ESTE MODULO NO HACE (a proposito) ─────────────────────────────────
// No inventa matematica nueva ni toca el motor. La cascada es (a) el ORDEN en que
// se llaman endpoints que YA existen y (b) el desglose que se muestra. En
// particular `/partial` no recibe un reparto interes/capital: recibe un monto y
// acumula `partialPaid`; el reparto lo deriva despues `imputarCobros` con esta
// MISMA cascada, asi que el desglose del preview y el que vera el usuario en el
// Flujo de Caja coinciden por construccion, no por coincidencia.
//
// Tampoco cascadea CAPITAL hacia las cuotas En Mora por la via del abono: eso es
// exactamente la Opcion B que el Bug #36 rechazo, porque contaria el capital dos
// veces (en la fila '-ab-' y en el `abonoCapital` de la cuota En Mora). Aqui la
// mora se cobra con `/partial`, que es la herramienta que el proyecto ya designo
// para eso, y el abono recibe SOLO el remanente.

import { esAbono } from './ids.js';

// Suma con redondeo a peso entero (doctrina de enteros de v2.2.0, Bug #43).
function r0(n){ return Math.round(n||0); }
// Redondeo a centavo de dolar.
function r2(n){ return Math.round((n||0)*100)/100; }

// ── Contexto economico del credito, en la MISMA base que valida el backend ────
// Espejo de la FASE 1 de POST /api/loans/:id/abono. Si esto y el backend
// divergen, el usuario ve un techo y recibe un 400 (esa fue la clase de falla del
// Bug #36), asi que se calcula con las mismas reglas y los mismos filtros.
export function contextoCascada(loan, allPays){
  var lp=(allPays||[]).filter(function(p){ return String(p.prestamoId)===String(loan.id); });
  var esUSD=loan.moneda==='USD';
  var trm=+loan.trmAcordada||0;
  var originalCOP=esUSD?r0(loan.montoOrigen*trm):r0(loan.montoOrigen);
  // esSingleCuota: en Prestamo/Pago Unico el `abonoCapital` de una fila En Mora es el
  // SALDO VIVO, no capital ya pagado -> no se resta (misma excepcion que el backend).
  var esSingleCuota=loan.modalidad==='Prestamo'||loan.modalidad==='Pago Unico';
  var capPagadas=lp.filter(function(p){ return p.estadoPago==='Pagado'; })
    .reduce(function(s,p){ return s+p.abonoCapital; },0);
  // Sin filtro '-ab-', igual que el backend: cualquier fila En Mora cuenta.
  var moraRows=lp.filter(function(p){ return p.estadoPago==='En Mora'; });
  var moraCap=moraRows.reduce(function(s,p){ return s+p.abonoCapital; },0);
  var saldoAbonable=esSingleCuota
    ? Math.max(0, originalCOP-capPagadas)
    : Math.max(0, originalCOP-capPagadas-moraCap);
  // Las cuotas que la cascada puede cobrar: regulares En Mora, mas antigua primero.
  // Se excluyen los '-ab-' porque /partial los rechaza explicitamente.
  var moraCuotas=moraRows.filter(function(p){ return !esAbono(p); })
    .sort(function(a,b){
      var d=String(a.fechaPago||'').localeCompare(String(b.fechaPago||''));
      return d!==0?d:((a.cuotaN||0)-(b.cuotaN||0));
    });
  var regularConsumed=lp.filter(function(p){
    return !esAbono(p)&&(p.estadoPago==='Pagado'||p.estadoPago==='En Mora');
  }).length;
  // La cuota del PERIODO EN CURSO: la regular Pendiente mas proxima. Es la unica
  // contra la que tiene sentido cobrar "el interes del mes" — ese interes es suyo,
  // no una obligacion nueva, asi que se cobra como un parcial sobre ella y no como
  // un cargo inventado. Si estuviera En Mora ya la recoge el paso A.
  var proximaCuota=lp.filter(function(p){ return !esAbono(p)&&p.estadoPago==='Pendiente'; })
    .sort(function(a,b){
      var d=String(a.fechaPago||'').localeCompare(String(b.fechaPago||''));
      return d!==0?d:((a.cuotaN||0)-(b.cuotaN||0));
    })[0]||null;
  // Lo que queda por cobrar de INTERES en esa cuota. Se descuenta lo ya abonado con
  // la misma cascada que usa `imputarCobros` (interes primero), para no cobrar dos
  // veces un interes que un parcial anterior ya cubrio.
  var interesMesPend=0;
  if(proximaCuota){
    var intTot=r0(proximaCuota.interesPeriodo);
    var yaPag=r0(proximaCuota.partialPaid||0);
    interesMesPend=Math.max(0, intTot-Math.min(yaPag, intTot));
  }
  return {
    lp:lp, esUSD:esUSD, trm:trm, originalCOP:originalCOP, esSingleCuota:esSingleCuota,
    capPagadas:capPagadas, moraCap:moraCap, saldoAbonable:saldoAbonable,
    moraCuotas:moraCuotas, regularConsumed:regularConsumed,
    proximaCuota:proximaCuota, interesMesPend:interesMesPend,
    capitalPendiente:Math.max(0, originalCOP-capPagadas),
  };
}

// ── EL PLAN ───────────────────────────────────────────────────────────────────
// `entrada` = { obligacionCOP, obligacionUSD, cajaCOP }
//   - obligacion: cuanta DEUDA extingue el pago. En un credito USD la deuda esta
//     denominada en dolares y se valua a la TRM PACTADA (doctrina CAJA vs
//     OBLIGACION, Bugs #37 y #50), asi que la manda el campo USD.
//   - caja: los pesos que entraron de verdad, a la TRM del dia. Solo alimenta el
//     ledger `recibos` / "Cobros del Mes"; NUNCA decide cuanta deuda se extingue.
//
// En creditos USD la aritmetica de la cascada se hace EN DOLARES (centavos) y el
// COP se deriva al final con `round(usd*trm)` — la MISMA formula que aplica el
// backend sobre el mismo input. Hacerlo al reves (cascada en COP y luego dividir)
// deja al backend recalculando una obligacion distinta de la planeada, que en el
// borde de "saldar la cuota exacta" se pasa por unos pesos y produce un 400.
// `opts` — los DOS overrides que la fusion del modal trajo del abono directo:
//   omitirMora        : salta el paso A y manda todo a capital. Es la imputacion que
//                       el art. 1653 permite CONSENTIR al acreedor, y la unica cosa
//                       que el boton "Abono directo a capital" hacia y la cascada no.
//                       Queda como decision explicita y auditable, no como un camino
//                       paralelo escondido en otro modal.
//   incluirInteresMes : cobra por adelantado el interes del periodo EN CURSO, que aun
//                       no vence. Va en direccion CONTRARIA al override anterior: no
//                       exceptua el 1653, lo refuerza cobrando mas interes antes del
//                       capital.
// Los dos son opcionales y por defecto `false`: sin ellos el plan es identico al de
// v2.7.0, que es lo que mantiene verdes las secciones A-G de `cascada-cobro`.
export function planCascada(loan, allPays, entrada, opts){
  var ctx=contextoCascada(loan, allPays);
  var esUSD=ctx.esUSD, trm=ctx.trm;
  var o=opts||{};
  var omitirMora=!!o.omitirMora;
  var incluirInteresMes=!!o.incluirInteresMes;
  var pasos=[];
  var err=null;

  // Unidad de trabajo: dolares (2 decimales) en USD, pesos enteros en COP.
  var restante=esUSD ? r2(entrada.obligacionUSD) : r0(entrada.obligacionCOP);
  var totalObl=restante;
  if(!(totalObl>0)) return vacio(ctx, 'El monto debe ser mayor a 0');
  if(esUSD&&!(trm>0)) return vacio(ctx, 'El credito no tiene TRM pactada valida');

  var aUSD=function(cop){ return r2(cop/trm); };
  var aCOP=function(usd){ return r0(usd*trm); };
  // `cero` en la unidad de trabajo: medio centavo en USD, medio peso en COP.
  var EPS=esUSD?0.005:0.5;

  // ── PASO A — cuotas En Mora, de la mas antigua a la mas nueva ──────────────
  // Dentro de cada cuota el reparto es interes -> capital. No se le manda al
  // backend: se calcula aqui SOLO para mostrarlo, y `imputarCobros` lo reproduce
  // con la misma regla cuando la fila ya este persistida.
  var moraPagadaCap=0;   // capital de cuotas que quedaran SALDADAS (cambia de bucket)
  for(var i=0;omitirMora?false:(i<ctx.moraCuotas.length&&restante>EPS);i++){
    var p=ctx.moraCuotas[i];
    var pendCOP=Math.max(0, r0(p.cuotaTotal)-r0(p.partialPaid||0));
    if(pendCOP<=0) continue;
    var pendU=esUSD?aUSD(pendCOP):pendCOP;
    var aplica=Math.min(restante, pendU);
    // Si lo que queda cubre la cuota salvo por ruido de redondeo, se salda ENTERA.
    // Sin esto un residuo de centavos dejaria la cuota En Mora por unos pesos y
    // ademas se perderia la exencion `completaUSD` del backend.
    var salda=(pendU-aplica)<=EPS;
    if(salda) aplica=pendU;

    // Reparto interes -> capital (misma cascada que imputarCobros).
    var yaPag=r0(p.partialPaid||0);
    var intTot=r0(p.interesPeriodo);
    var capTot=r0(p.abonoCapital);
    if(capTot<=0&&(r0(p.cuotaTotal)-intTot)>0) capTot=r0(p.cuotaTotal)-intTot; // capital fantasma (Bugs #30/#34)
    var intYa=Math.min(yaPag, intTot);
    var capYa=Math.max(0, yaPag-intYa);
    // ANCLAJE AL SALDAR (espejo de la rama `completa` de /partial, que escribe
    // `partialPaid = cuotaTotal`). Como el usuario teclea dolares con 2 decimales,
    // `round(usd*trm)` no cae en el peso exacto de la cuota: medido en el caso real
    // de una cuota de USD 361,25 se pasa 12 pesos. Sin anclar, el plan afirmaria
    // haber extinguido mas obligacion de la que existe y el desglose interes+capital
    // no cuadraria contra la cuota. El backend descarta ese sobrante via `completaUSD`,
    // asi que la obligacion realmente extinguida ES `pendCOP`.
    var aplicaCOP=salda?pendCOP:(esUSD?aCOP(aplica):aplica);
    var aInt=Math.min(aplicaCOP, Math.max(0, intTot-intYa));
    var aCap=Math.min(aplicaCOP-aInt, Math.max(0, capTot-capYa));

    pasos.push({
      tipo:'partial', payId:p.id, cuotaN:p.cuotaN, fechaPago:p.fechaPago,
      obligacionCOP:aplicaCOP,
      // En USD se manda el dolar exacto de la cuota cuando salda: es lo que
      // dispara `completaUSD` en el backend y evita el 400 por centavos.
      obligacionUSD:esUSD?aplica:0,
      interes:aInt, capital:aCap, salda:salda,
      restanteCuota:Math.max(0, pendCOP-aplicaCOP),
    });
    restante=r2(restante-aplica);
    if(salda) moraPagadaCap+=r0(p.abonoCapital);
  }

  // ── PASO A2 — interes del periodo EN CURSO (opcional) ──────────────────────
  // Se cobra como un PARCIAL sobre la proxima cuota, no como una obligacion nueva:
  // ese interes YA existe dentro de esa cuota, asi que pagarlo por adelantado es
  // literalmente abonar a ella. Modelarlo de otra forma —por ejemplo colgandolo de
  // la fila del abono, como hace la liquidacion con `intExtra`— lo COBRARIA DOS
  // VECES: la cuota regenerada seguiria pidiendo su interes completo.
  //
  // Va DESPUES de la mora y ANTES del abono: el orden que pidio el negocio, y el
  // unico coherente con el art. 1653 (todo el interes exigible antes que el capital).
  if(incluirInteresMes&&ctx.proximaCuota&&ctx.interesMesPend>0&&restante>EPS){
    var intMesCOP=ctx.interesMesPend;
    var intMesU=esUSD?aUSD(intMesCOP):intMesCOP;
    var apMes=Math.min(restante, intMesU);
    var cubreMes=(intMesU-apMes)<=EPS;
    if(cubreMes) apMes=intMesU;
    // NO se ancla al peso del interes. El anclaje solo es legitimo donde el backend
    // va a forzar `partialPaid = cuotaTotal` (rama `completaUSD` de /partial), y este
    // paso NUNCA completa la cuota: solo cubre su interes. El backend valua la
    // obligacion como `round(montoUSD * trm)`, asi que el plan declara EXACTAMENTE
    // esa formula sobre el mismo input. Medido en una prueba real con anclaje: el
    // plan prometia 147.739 y el backend extinguia 147.755 — 16 pesos de deriva
    // entre lo que el recibo afirmaba y lo que quedaba en la base.
    var apMesCOP=esUSD?aCOP(apMes):apMes;
    var pendProxCOP=Math.max(0, r0(ctx.proximaCuota.cuotaTotal)-r0(ctx.proximaCuota.partialPaid||0));
    pasos.push({
      tipo:'partial', esInteresMes:true,
      payId:ctx.proximaCuota.id, cuotaN:ctx.proximaCuota.cuotaN, fechaPago:ctx.proximaCuota.fechaPago,
      obligacionCOP:apMesCOP, obligacionUSD:esUSD?apMes:0,
      interes:apMesCOP, capital:0,
      // Cobrar el interes NO salda la cuota: su capital sigue debiendose.
      salda:false, restanteCuota:Math.max(0, pendProxCOP-apMesCOP),
    });
    restante=r2(restante-apMes);
  }

  // ── Techo del abono DESPUES del paso A ─────────────────────────────────────
  // En Capital + Intereses e Intereses el techo es INVARIANTE: saldar una cuota En
  // Mora solo mueve su capital del bucket "mora" al bucket "pagadas", y el backend
  // resta los dos. En Prestamo / Pago Unico la mora NO se resta, asi que ahi si
  // baja. Se recalcula en vez de asumirlo para que las cuatro modalidades salgan
  // por el mismo camino.
  var capPagDespues=ctx.capPagadas+moraPagadaCap;
  var capMoraDespues=ctx.esSingleCuota?0:Math.max(0, ctx.moraCap-moraPagadaCap);
  var saldoAbonableDespues=Math.max(0, ctx.originalCOP-capPagDespues-capMoraDespues);

  // ── PASO B — remanente al abono extraordinario a capital ───────────────────
  var techoU=esUSD?aUSD(saldoAbonableDespues):saldoAbonableDespues;
  if(restante>EPS&&techoU>0){
    var abo=Math.min(restante, techoU);
    var cubreTecho=(techoU-abo)<=EPS;
    if(cubreTecho) abo=techoU;
    // Anclaje del techo (doctrina v2.0.0): si el dolar cubre el techo, el capital
    // se ancla al peso exacto. Sin esto sobrarian unos pesos de capital fantasma
    // imposibles de saldar, porque round(usd*trm) casi nunca da el techo justo.
    var aboCOP=esUSD?(cubreTecho?saldoAbonableDespues:aCOP(abo)):abo;
    pasos.push({
      tipo:'abono', obligacionCOP:aboCOP, obligacionUSD:esUSD?abo:0,
      interes:0, capital:aboCOP, anclado:cubreTecho,
    });
    restante=r2(restante-abo);
  }

  // ── Sobrante: dinero que no cabe en ninguna obligacion viva ────────────────
  var sobranteCOP=restante>EPS?(esUSD?aCOP(restante):r0(restante)):0;
  if(sobranteCOP>0){
    err='El monto supera todo lo que este credito debe hoy. Sobran '+
        (esUSD?('USD '+r2(restante).toFixed(2)):('$'+sobranteCOP.toLocaleString('es-CO')))+
        '. Revisa el valor recibido o usa Liquidar deuda.';
  }

  // ── Reparto de la CAJA entre los pasos ─────────────────────────────────────
  // La caja se reparte proporcional a la obligacion de cada paso y el ULTIMO paso
  // absorbe el residuo, para que la suma sea EXACTAMENTE lo que el usuario dijo
  // haber recibido. Si no cuadrara al peso, "Cobros del Mes" quedaria descuadrado.
  // En creditos COP caja == obligacion y esto es identidad.
  var aplicadoCOP=pasos.reduce(function(s,x){ return s+x.obligacionCOP; },0);
  var cajaTotal=esUSD?r0(entrada.cajaCOP):aplicadoCOP;
  if(pasos.length&&cajaTotal>0&&aplicadoCOP>0){
    var acum=0;
    for(var k=0;k<pasos.length;k++){
      if(k===pasos.length-1){ pasos[k].cajaCOP=Math.max(0, cajaTotal-acum); }
      else { pasos[k].cajaCOP=r0(cajaTotal*pasos[k].obligacionCOP/aplicadoCOP); acum+=pasos[k].cajaCOP; }
    }
  } else {
    pasos.forEach(function(x){ x.cajaCOP=x.obligacionCOP; });
  }

  // El interes del mes se totaliza APARTE del vencido: en el desglose y en el recibo
  // son rubros distintos (uno estaba exigible, el otro no) y confundirlos haria que
  // el papel afirmara que se cobro mora que no existia.
  var totIntMora=pasos.filter(function(x){ return x.tipo==='partial'&&!x.esInteresMes; })
    .reduce(function(s,x){ return s+x.interes; },0);
  var totIntMes=pasos.filter(function(x){ return x.esInteresMes; })
    .reduce(function(s,x){ return s+x.interes; },0);
  var totInt=totIntMora+totIntMes;
  var totCapMora=pasos.filter(function(x){ return x.tipo==='partial'; }).reduce(function(s,x){ return s+x.capital; },0);
  var totAbono=pasos.filter(function(x){ return x.tipo==='abono'; }).reduce(function(s,x){ return s+x.obligacionCOP; },0);

  return {
    ok:!err, error:err, pasos:pasos, ctx:ctx,
    totales:{
      interesMora:totIntMora, interesMes:totIntMes, capitalMora:totCapMora, abonoCapital:totAbono,
      aplicado:aplicadoCOP, sobrante:sobranteCOP,
      caja:esUSD?r0(entrada.cajaCOP):aplicadoCOP,
    },
    // Estado en que queda el credito (alimenta el preview del cronograma).
    saldoAbonableDespues:saldoAbonableDespues,
    saldoTrasCascada:Math.max(0, saldoAbonableDespues-totAbono),
    moraRestante:ctx.moraCuotas.reduce(function(s,p){
      var paso=pasos.filter(function(x){ return x.payId===p.id; })[0];
      var pend=Math.max(0, r0(p.cuotaTotal)-r0(p.partialPaid||0));
      return s+(paso?paso.restanteCuota:pend);
    },0),
  };
}

function vacio(ctx, msg){
  return { ok:false, error:msg, pasos:[], ctx:ctx,
    totales:{interesMora:0,interesMes:0,capitalMora:0,abonoCapital:0,aplicado:0,sobrante:0,caja:0},
    saldoAbonableDespues:ctx.saldoAbonable, saldoTrasCascada:ctx.saldoAbonable,
    moraRestante:ctx.moraCuotas.reduce(function(s,p){ return s+Math.max(0,(p.cuotaTotal||0)-(p.partialPaid||0)); },0) };
}

// ── Cobrable total ────────────────────────────────────────────────────────────
// Techo natural del cobro: toda la mora pendiente + todo el capital amortizable.
// Es lo maximo que la cascada puede colocar; por encima queda sobrante.
export function cobrableTotal(loan, allPays){
  var ctx=contextoCascada(loan, allPays);
  var mora=ctx.moraCuotas.reduce(function(s,p){
    return s+Math.max(0, Math.round(p.cuotaTotal)-Math.round(p.partialPaid||0));
  },0);
  // Techo del abono una vez saldada TODA la mora. La expresion es la misma en las
  // cuatro modalidades: al saldarse, el capital de la mora pasa al bucket "pagadas".
  // En Capital + Intereses e Intereses el resultado coincide con `ctx.saldoAbonable`
  // (invariante, porque el backend ya restaba ese capital); en Prestamo / Pago Unico
  // baja, porque alli la mora no se restaba.
  var capPagDespues=ctx.capPagadas+ctx.moraCuotas.reduce(function(s,p){ return s+Math.round(p.abonoCapital); },0);
  var techo=Math.max(0, ctx.originalCOP-capPagDespues);
  // `interesMes` NO entra en `total`: es OPCIONAL (depende de un checkbox), asi que
  // sumarlo al techo por defecto anunciaria como cobrable algo que el usuario todavia
  // no decidio cobrar. El modal lo suma cuando el check esta activo.
  return { mora:mora, abonable:techo, total:mora+techo, interesMes:ctx.interesMesPend, ctx:ctx };
}

// ── PROYECCION DE LO QUE QUEDARIA POR PAGAR ──────────────────────────────────
// Alimenta la Propuesta de Abono: "si abonas X, cuanto te queda debiendo".
//
// Declara el TOTAL POR PAGAR y NO un saldo de capital, y la diferencia importa. El
// saldo de capital sale de `saldoConCaja`, que depende de `imputarCobros`; proyectar
// esa imputacion sobre un cronograma que todavia no existe obliga a una segunda
// implementacion, y esa copia se desincronizo: la propuesta prometia un saldo y el
// recibo entregaba otro sobre el MISMO cobro. El borde que lo destapo es real — un
// parcial que sobrevive al recalculo puede quedar siendo MAYOR que la cuota nueva, y
// ahi ninguna resta ingenua describe la imputacion.
//
// El total por pagar, en cambio, es suma de (cuota - lo ya abonado en ella) sobre las
// filas que quedarian, mas la mora que sobreviva: sale DIRECTO de la proyeccion y es
// exactamente lo que el recibo totaliza despues en "Lo que queda por pagar". Las dos
// cifras coinciden por construccion.
//
//   `filas`     — las del preview (`filasPreview`), ya con su `cuota`.
//   `pendOrden` — las cuotas Pendientes de HOY, en el mismo orden que `filas`: son las
//                 que arrastran su abono a la fila proyectada correspondiente.
export function proyeccionCobro(loan, allPays, plan, filas, pendOrden){
  var lp=(allPays||[]).filter(function(p){ return String(p.prestamoId)===String(loan.id); });
  var reg=lp.filter(function(p){ return !esAbono(p)&&
    (p.estadoPago==='Pendiente'||p.estadoPago==='En Mora'); });
  var totalAntes=reg.reduce(function(s,p){
    return s+Math.max(0, r0(p.cuotaTotal)-r0(p.partialPaid||0)); },0);

  // Lo que cada cuota Pendiente llevara encima DESPUES del cobro: lo que ya tenia mas
  // lo que este cobro le suma (el paso del interes del mes apunta a una de ellas).
  function partialProy(p){
    var base=r0(p.partialPaid||0);
    var paso=(plan&&plan.pasos||[]).filter(function(x){ return x.payId===p.id; })[0];
    return base+(paso?r0(paso.obligacionCOP):0);
  }
  // Mora que SOBREVIVE al cobro: tambien es dinero por cobrar.
  var moraTras=(plan&&plan.ctx?plan.ctx.moraCuotas:[]).reduce(function(s,p){
    var paso=(plan.pasos||[]).filter(function(x){ return x.payId===p.id; })[0];
    var pend=Math.max(0, r0(p.cuotaTotal)-r0(p.partialPaid||0));
    return s+(paso?Math.max(0,paso.restanteCuota):pend);
  },0);

  var pend=pendOrden||[];
  var totalDespues=null;
  if(filas&&filas.length){
    totalDespues=moraTras;
    for(var i=0;i<filas.length;i++){
      var p=pend[i];
      totalDespues+=Math.max(0, r0(filas[i].cuota)-(p?partialProy(p):0));
    }
  }
  return {
    totalAntes:totalAntes, totalDespues:totalDespues,
    abonadoProxima:pend.length?partialProy(pend[0]):0,
  };
}
