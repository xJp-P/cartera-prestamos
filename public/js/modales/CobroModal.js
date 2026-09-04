// public/js/modales/CobroModal.js — Registrar cobro con imputacion en CASCADA.
//
// UNA sola puerta para el dinero que entra: el usuario escribe cuanto recibio y la
// app decide contra que se aplica, en el orden del art. 1653 (intereses vencidos ->
// capital vencido -> abono extraordinario a capital).
//
// ── QUE HACE Y QUE NO ─────────────────────────────────────────────────────────
// NO calcula nada por su cuenta: el plan sale entero de `planCascada` y el preview
// del cronograma de `filasPreview`, que es el espejo verificado de `buildSchedule`
// (v2.6.2). Este archivo es formulario + presentacion del plan.
//
// NO ejecuta: `onConfirm` sube al orquestador de `app.js`, que recorre los pasos EN
// SERIE contra los endpoints que ya existen (`/partial` para la mora, `/abono` para
// el remanente). Ninguna matematica nueva viaja al backend.
//
// ── DOBLE ENTRADA EN CREDITOS USD (doctrina CAJA vs OBLIGACION) ──────────────
// Los dolares definen cuanta DEUDA se extingue (se valuan a la TRM PACTADA); los
// pesos son la CAJA real que entro ese dia. Son dos cifras distintas y las dos
// hacen falta: sin el dolar la deuda se extingue mal (Bug #50), sin el peso el
// efecto cambiario es irregistrable (Bug #37). Por eso ambos campos son
// obligatorios aqui, igual que en AbonoModal y PayModal.
//
// ── ARITMETICA EN LA MONEDA VISIBLE ──────────────────────────────────────────
// Todo rubro que deba SUMAR con otro se calcula en la unidad que se imprime
// (centavos de dolar en USD, pesos en COP) y el capital se deriva restando:
// `capital = obligacion - interes`. Convertir cada rubro por separado descuadra
// un centavo (Bug #31) y hacia que esta pantalla y el Recibo de Cobro —el papel
// que sale de ella— imprimieran cifras distintas en la linea que el usuario
// compara. Es la MISMA reconciliacion de `generateReciboCobro`, a proposito:
// asi los dos coinciden por construccion y no por coincidencia.
//
// ── LA PUERTA UNICA (v2.9.6) ─────────────────────────────────────────────────
// Este modal absorbio lo que hacia "Abono directo a capital", que ya no existe. Lo
// que antes eran dos ventanas con dos criterios distintos ahora son tres decisiones
// dentro de una sola:
//   1. `omitirMora`        — manda todo a capital sin cobrar lo vencido. Es la
//      imputacion que el art. 1653 permite CONSENTIR al acreedor, y era la unica
//      capacidad del modal viejo que la cascada no cubria.
//   2. `incluirInteresMes` — cobra por adelantado el interes del periodo en curso.
//   3. Las OPCIONES DE RECALCULO (mantener / modificar plazo / fijar cuota), que
//      solo aplican si sobra dinero para un abono extraordinario; sin abono el
//      cronograma no cambia y el bloque no se dibuja.
// Los tres viajan al mismo `planCascada` y al mismo `/abono`, asi que hay una sola
// matematica y un solo recibo.

import { ABtn, Fld, Modal } from '../componentes/base.js';
import { Ico } from '../componentes/iconos.js';
import { cobrableTotal, planCascada, proyeccionCobro } from '../core/cascada.js';
import { generatePropuestaAbono } from '../pdf/propuesta-abono.js';
import { _tasaPeriodo, filasPreview, previewRecalculo } from '../core/calculo.js';
import { fmt, fmtD, fmtNumInput, fmtUSD, parseDecimalInput, parseIntInput, parseNum } from '../core/format.js';
import { h, useState } from '../core/react.js';
import { _submitGuard, nowStr } from '../core/ui.js';
import { esAbono } from '../core/ids.js';

export function CobroModal(props){
  var loan=props.loan, allPays=props.pays||[], onConfirm=props.onConfirm, onClose=props.onClose;
  var onRequestLiquidar=props.onRequestLiquidar;
  var esUSD=loan.moneda==='USD';
  var trm=+loan.trmAcordada||0;
  var esCapInt=loan.modalidad==='Capital + Intereses';

  var s1=useState(''); var montoCOP=s1[0]; var setMontoCOP=s1[1];       // credito COP: total recibido
  var s2=useState(''); var montoUSD=s2[0]; var setMontoUSD=s2[1];       // credito USD: obligacion
  var s3=useState(''); var copRecibido=s3[0]; var setCopRecibido=s3[1]; // credito USD: caja real
  var s4=useState(nowStr()); var fecha=s4[0]; var setFecha=s4[1];
  var s5=useState(''); var obs=s5[0]; var setObs=s5[1];
  var s6=useState(false); var sending=s6[0]; var setSending=s6[1];
  var s7=useState(true); var verCron=s7[0]; var setVerCron=s7[1];
  var s8=useState(null); var fallo=s8[0]; var setFallo=s8[1];           // resultado parcial si un paso falla
  var s9=useState(true); var genRecibo=s9[0]; var setGenRecibo=s9[1];    // recibo consolidado (mismo patron que PayModal/AbonoModal)
  // ── Estado de la FUSION. Va al FINAL a proposito: el orden de `useState` es
  // contrato con la seccion H de `cascada-cobro`, que siembra por POSICION.
  var s10=useState(false); var incMes=s10[0]; var setIncMes=s10[1];      // cobrar el interes del periodo en curso
  var s11=useState(false); var omitMora=s11[0]; var setOmitMora=s11[1];  // mandar todo a capital sin cobrar lo vencido
  var s12=useState('mantener'); var recalcMode=s12[0]; var setRecalcMode=s12[1];
  var s13=useState(''); var recalcInput=s13[0]; var setRecalcInput=s13[1];

  var loanPays=allPays.filter(function(p){ return String(p.prestamoId)===String(loan.id); });
  var cob=cobrableTotal(loan, allPays);
  var ctx=cob.ctx;

  // ── Entrada normalizada ────────────────────────────────────────────────────
  // `montoUSD` guarda lo que produjo `parseDecimalInput`, donde el punto es el
  // separador DECIMAL ('361.25'). `parseNum` esta hecha para los campos en pesos,
  // donde el punto es separador de MILES, y lo elimina: leia 361.25 como 36.125.
  // Se lee con `+`, igual que AbonoModal y PayModal. Ver Bug #56.
  var oblUSD=esUSD?(+montoUSD||0):0;
  var oblCOP=esUSD?0:(parseNum(montoCOP)||0);
  var cajaCOP=esUSD?(parseNum(copRecibido)||0):oblCOP;
  var hayEntrada=esUSD?(oblUSD>0):(oblCOP>0);
  var faltanCamposUSD=esUSD&&(oblUSD<=0||cajaCOP<=0);

  var plan=hayEntrada?planCascada(loan, allPays,
    {obligacionUSD:oblUSD, obligacionCOP:oblCOP, cajaCOP:cajaCOP},
    {incluirInteresMes:incMes, omitirMora:omitMora}):null;
  var T=plan?plan.totales:null;

  // ── Unidad de presentacion: centavos de dolar en USD, pesos en COP ─────────
  var uni=function(cop){ return esUSD?Math.round((cop||0)/trm*100):Math.round(cop||0); };
  var fmtUni=function(u){ return esUSD?fmtUSD((u||0)/100):fmt(u||0); };
  var money=function(cop){ return fmtUni(uni(cop)); };

  // El techo tambien se suma en la unidad visible: `cob.total` es `mora+abonable`
  // en COP, y convertir las tres cifras por separado imprimia sumandos que no
  // daban el total (visto en la app: 800.00 + 713.98 rotulado 1,513.99).
  var cobMoraU=uni(cob.mora), cobAbonableU=uni(cob.abonable);

  // Rubros del panel, DERIVADOS de los pasos igual que en el recibo: el capital
  // de mora se ancla al total de los pasos de mora (capital = cuota - interes,
  // doctrina v1.18.0) para que absorba el residuo de redondeo en vez de dejar
  // un descuadre visible entre los rubros y el "Total aplicado".
  var vis=(function(){
    if(!plan||!plan.pasos.length) return null;
    var oblPartialsU=plan.pasos.filter(function(p){ return p.tipo==='partial'; })
      .reduce(function(s,p){ return s+uni(p.obligacionCOP); },0);
    var intU=plan.pasos.filter(function(p){ return p.tipo==='partial'&&!p.esInteresMes; })
      .reduce(function(s,p){ return s+uni(p.interes); },0);
    // El interes del mes se declara APARTE: no estaba vencido, y mezclarlo con la
    // mora haria que el desglose (y el recibo) afirmaran un atraso que no existio.
    var mesU=plan.pasos.filter(function(p){ return p.esInteresMes; })
      .reduce(function(s,p){ return s+uni(p.interes); },0);
    var capMoraU=Math.max(0, oblPartialsU-intU-mesU);
    var abonoU=plan.pasos.filter(function(p){ return p.tipo==='abono'; })
      .reduce(function(s,p){ return s+uni(p.obligacionCOP); },0);
    return {intU:intU, mesU:mesU, capMoraU:capMoraU, abonoU:abonoU,
            aplicadoU:intU+mesU+capMoraU+abonoU};
  })();

  // Efecto cambiario del cobro completo (solo informativo, no decide nada).
  // Se mide contra la obligacion REALMENTE extinguida (`T.aplicado`), que va
  // ANCLADA al peso exacto de la cuota cuando un paso la salda. Calcularlo
  // contra la obligacion nominal (`oblUSD*trm`) se desviaba por ese anclaje
  // —medido: 12 pesos en produccion, 7 en el fixture— y en el caso en que la TRM
  // del dia coincide con la pactada llegaba a anunciar un efecto de CERO donde
  // si lo habia. Es ademas la misma cifra que `imputarCobros` reportara despues
  // como `ajuste` en el Flujo de Caja. Si el plan no cabe (`sobrante`) la linea
  // se calla: ahi la diferencia ya no seria solo cambiaria.
  var trmImplicita=(esUSD&&oblUSD>0&&cajaCOP>0)?Math.round(cajaCOP/oblUSD):0;
  var efectoTRM=(esUSD&&plan&&plan.ok&&plan.pasos.length>0&&cajaCOP>0)?(T.caja-T.aplicado):0;

  // ── Opciones de recalculo (heredadas del abono directo) ────────────────────
  // Solo tienen sentido si queda dinero para un abono extraordinario: sin abono el
  // capital no baja y el cronograma no se regenera. Por eso el bloque se dibuja
  // condicionado a `hayAbono`, y el modo cae a 'mantener' cuando no aplica — asi el
  // valor que viaja al backend nunca depende de un radio que el usuario no vio.
  // Valor de la cuota HOY: alimenta el antes/despues de la propuesta. Sale de la
  // primera Pendiente persistida, no de un calculo, para que respete cualquier
  // prorroga o cambio de dia de pago que el credito ya tenga encima.
  var cuotaActual=(function(){
    var p=loanPays.filter(function(x){ return !esAbono(x)&&x.estadoPago==='Pendiente'; })
      .sort(function(a,b){ return (a.cuotaN||0)-(b.cuotaN||0); })[0];
    return p?Math.round(p.cuotaTotal):0;
  })();
  var hayAbono=!!(plan&&plan.ok&&plan.totales&&plan.totales.abonoCapital>0);
  var aplicaRecalc=esCapInt&&hayAbono;
  var recalcModoEfectivo=aplicaRecalc?recalcMode:'mantener';
  // En `fijarCuota` el usuario teclea en la moneda visible; el backend siempre
  // espera COP (misma conversion que hacia AbonoModal).
  var recalcValorCOP=recalcModoEfectivo==='fijarCuota'
    ? (esUSD?Math.round((+recalcInput||0)*trm):(parseNum(recalcInput)||0))
    : (recalcModoEfectivo==='modificarPlazo'?(parseInt(recalcInput,10)||0):null);

  // ── Preview del cronograma resultante ──────────────────────────────────────
  // Solo tiene sentido donde hay amortizacion. `filasPreview` es el espejo del
  // motor; las FECHAS se toman de las cuotas Pendientes que ya existen (conservan
  // su `cuotaN`, y `getPayDate` las deriva de ahi) en vez de recalcular calendario:
  // asi el preview respeta solo cualquier prorroga o cambio de dia de pago.
  var cronoPreview=(function(){
    if(!plan||!plan.ok||!esCapInt) return null;
    var saldo=plan.saldoTrasCascada;
    var nActual=Math.max(0,(+loan.plazoMeses||0)-ctx.regularConsumed);
    if(nActual<=0) return {filas:[],saldado:saldo<=0,n:0};
    if(saldo<=0) return {filas:[],saldado:true,n:0};
    var r=_tasaPeriodo((+loan.tasaMensual||0)/100, loan.frecuencia||'Mensual');
    // El preview obedece a la opcion de recalculo elegida. `previewRecalculo` es el
    // MISMO helper que usaba el modal de abono, asi que las dos superficies no pueden
    // prometer cronogramas distintos para el mismo abono.
    var pv=previewRecalculo(saldo, r, nActual, recalcModoEfectivo, recalcValorCOP);
    if(!pv) return {filas:[],saldado:false,n:0};
    if(pv.error) return {filas:[],saldado:false,n:0,error:pv.error};
    var n=pv.nCuotas;
    var nominal=pv.cuota;
    var filas=filasPreview(saldo,r,n,false,nominal);
    var pend=loanPays.filter(function(p){ return !esAbono(p)&&p.estadoPago==='Pendiente'; })
      .sort(function(a,b){ return (a.cuotaN||0)-(b.cuotaN||0); });
    filas.forEach(function(f,i){
      f.cuotaN=ctx.regularConsumed+1+i;
      f.fecha=pend[i]?pend[i].fechaPago:null;
      f.antes=pend[i]?Math.round(pend[i].cuotaTotal):0;
    });
    return {filas:filas,saldado:false,n:n,ultimaResidual:pv.ultimaResidual};
  })();

  // ── Proyeccion para la propuesta ───────────────────────────────────────────
  // OJO CON EL ORDEN: esto va DESPUES de `cronoPreview`, y estuvo antes. El `var`
  // hoisted no da error: `cronoPreview` valia `undefined`, el helper recibia `null`
  // por filas, devolvia `totalDespues: null` y la tarjeta "Total por pagar"
  // simplemente NO se dibujaba en el PDF que va al cliente. Sin excepcion, sin aviso
  // en consola, sin nada roto a la vista.
  //
  // La matematica vive en `proyeccionCobro` (core/cascada.js), no aqui: la prueba que
  // ata este documento con el recibo llama al MISMO helper, asi que no puede quedar
  // verde sobre una copia.
  var pendOrden=loanPays.filter(function(p){ return !esAbono(p)&&p.estadoPago==='Pendiente'; })
    .sort(function(a,b){ return (a.cuotaN||0)-(b.cuotaN||0); });
  var proy=(plan&&plan.ok)
    ? proyeccionCobro(loan, allPays, plan, (cronoPreview&&cronoPreview.filas)||null, pendOrden)
    : {totalAntes:0,totalDespues:null,abonadoProxima:0};

  // ── Lo que el cliente va a GIRAR en la proxima fecha ────────────────────────
  // La tabla de abajo es la vista CONTRACTUAL y no se toca: sus columnas universales
  // sostienen la identidad INTERES + ABONO A CAPITAL = VALOR CUOTA, asi que VALOR CUOTA
  // tiene que seguir siendo `cuotaTotal` aunque esa cuota ya traiga abono encima. El
  // problema es que entonces la pantalla nunca dice cuanto se transfiere de verdad
  // — medido: la tabla mostraba 157.79 cuando el cliente iba a girar 117.65.
  // La caja va aparte, arriba, en su propia franja: es tesoreria, no contabilidad.
  //
  // OJO CON EL ORDEN (Bug #63): esto lee `cronoPreview` y `proy`, asi que va DESPUES de
  // los dos. Leerlo mas arriba no daria error por el hoisting de `var` — daria
  // `undefined` y la franja desapareceria en silencio.
  //
  // La resta se hace en COP y se convierte UNA vez, igual que `money(pendCuota(p))` en el
  // recibo, para que la pantalla y el papel no difieran un centavo en USD.
  var proxPago=(function(){
    if(!cronoPreview||cronoPreview.saldado||!cronoPreview.filas||!cronoPreview.filas.length) return null;
    var f=cronoPreview.filas[0];
    var cuota=Math.round(f.cuota||0);
    if(cuota<=0) return null;
    var ab=Math.max(0, Math.round(proy.abonadoProxima||0));
    return {cuota:cuota, abonado:ab, neto:Math.max(0, cuota-ab), fecha:f.fecha};
  })();

  function submit(){
    if(!plan||!plan.ok||!plan.pasos.length) return;
    setFallo(null);
    return _submitGuard(sending,setSending,function(){
      // `entrada` y `opts` viajan para que el orquestador pueda RE-PLANIFICAR si el
      // pre-flight marca cuotas en mora: eso mueve el techo del abono, y ejecutar el
      // plan viejo rebotaria con un 400 a mitad de la cadena.
      return onConfirm(loan.id, plan, fecha, obs, genRecibo, {
        modo:recalcModoEfectivo, valor:recalcValorCOP,
        entrada:{obligacionUSD:oblUSD, obligacionCOP:oblCOP, cajaCOP:cajaCOP},
        opts:{incluirInteresMes:incMes, omitirMora:omitMora},
      }).then(function(res){
        // El orquestador devuelve {ok, hechos, error, pasoFallido} — si algo fallo a
        // mitad, el modal SE QUEDA ABIERTO mostrando exactamente que si se aplico.
        // Cerrar en silencio dejaria al usuario sin saber en que estado quedo.
        if(res&&res.ok===false) setFallo(res);
        return res;
      });
    });
  }

  // ── Piezas de presentacion ─────────────────────────────────────────────────
  function chip(txt,col,bg){
    return h('span',{style:{fontSize:10,fontWeight:800,color:col,background:bg,padding:'2px 6px',borderRadius:5,letterSpacing:.3}},txt);
  }
  function linea(label,valor,color,fuerte){
    return h('div',{style:{display:'flex',justifyContent:'space-between',alignItems:'baseline',gap:10,padding:'3px 0'}},
      h('span',{style:{fontSize:12,color:fuerte?'var(--text)':'var(--text2)',fontWeight:fuerte?700:500}},label),
      h('span',{className:'mono',style:{fontSize:fuerte?13:12,fontWeight:fuerte?800:600,color:color||'var(--text)'}},valor));
  }

  var pasosUI=plan&&plan.pasos.length?h('div',{style:{display:'flex',flexDirection:'column',gap:8}},
    plan.pasos.map(function(p,i){
      var esMora=p.tipo==='partial';
      // Capital reconciliado en la moneda visible, NUNCA `p.capital` crudo.
      var totU=uni(p.obligacionCOP), pIntU=uni(p.interes);
      var pCapU=Math.max(0, totU-pIntU);
      return h('div',{key:i,style:{border:'1px solid var(--border)',borderRadius:10,padding:'9px 11px',background:'var(--bg3)'}},
        h('div',{style:{display:'flex',alignItems:'center',gap:7,marginBottom:5}},
          h('span',{style:{width:18,height:18,borderRadius:99,background:esMora?'var(--red-bg)':'var(--green-bg)',color:esMora?'var(--red)':'var(--green)',fontSize:10,fontWeight:800,display:'flex',alignItems:'center',justifyContent:'center',flexShrink:0}},String(i+1)),
          h('span',{style:{fontSize:12,fontWeight:700,color:'var(--text)'}},
            p.esInteresMes?('Interes del mes · cuota #'+p.cuotaN)
              :esMora?('Cuota #'+p.cuotaN+' vencida'):'Abono extraordinario a capital'),
          p.esInteresMes?chip('POR ADELANTADO','var(--blue)','var(--blue-bg)')
            :esMora&&(p.salda?chip('SE SALDA','var(--green)','var(--green-bg)'):chip('PARCIAL','var(--yellow)','var(--yellow-bg)')),
          h('span',{style:{flex:1}}),
          h('span',{className:'mono',style:{fontSize:12,fontWeight:800,color:'var(--text)'}},fmtUni(totU))),
        p.esInteresMes&&h('div',{style:{fontSize:11,color:'var(--text3)',paddingLeft:25,lineHeight:1.6}},
          'aun no vence (',fmtD(p.fechaPago),') · se cobra por adelantado, antes del abono a capital'),
        esMora&&!p.esInteresMes&&h('div',{style:{fontSize:11,color:'var(--text3)',paddingLeft:25,lineHeight:1.6}},
          'venció el ',fmtD(p.fechaPago),
          pIntU>0&&h('span',null,'  •  intereses ',h('b',{style:{color:'var(--red)'}},fmtUni(pIntU))),
          pCapU>0&&h('span',null,'  •  capital ',h('b',{style:{color:'var(--text2)'}},fmtUni(pCapU))),
          !p.salda&&p.restanteCuota>0&&h('div',{style:{color:'var(--yellow)'}},'queda debiendo ',money(p.restanteCuota),' de esta cuota')),
        !esMora&&h('div',{style:{fontSize:11,color:'var(--text3)',paddingLeft:25,lineHeight:1.6}},
          'reduce el capital vivo · se mantiene el plazo y baja la cuota'));
    })):null;

  return h(Modal,{onClose:onClose,tall:true,wide:true},
    h('div',{style:{fontSize:17,fontWeight:800,color:'var(--text)'}},'Registrar cobro'),
    h('div',{style:{fontSize:12,color:'var(--text2)',marginTop:-6}},
      loan.nombre,' · ',loan.modalidad,esUSD?' · USD':''),

    // ── Estado actual del credito ──
    h('div',{style:{background:'var(--bg3)',border:'1px solid var(--border)',borderRadius:10,padding:'10px 12px',marginTop:4}},
      linea('Cuotas vencidas por cobrar', cob.mora>0?fmtUni(cobMoraU):'—', cob.mora>0?'var(--red)':'var(--text3)'),
      cob.interesMes>0&&linea('Interes del mes en curso', fmtUni(uni(cob.interesMes)), 'var(--text3)'),
      linea('Capital amortizable', fmtUni(cobAbonableU), 'var(--text2)'),
      h('div',{style:{height:1,background:'var(--border)',margin:'5px 0'}}),
      // El interes del mes suma al techo SOLO si el usuario lo activo: es opcional, y
      // anunciarlo siempre inflaria lo cobrable con algo que todavia no decidio cobrar.
      linea('Total que se puede cobrar hoy',
        fmtUni(cobMoraU+cobAbonableU+(incMes?uni(cob.interesMes):0)), 'var(--text)', true)),

    // ── Entrada ──
    esUSD
      ? h('div',{style:{display:'flex',gap:10}},
          h('div',{style:{flex:1}},h(Fld,{label:'Dólares recibidos *'},
            h('input',{type:'text',inputMode:'decimal',value:montoUSD,autoFocus:true,
              onChange:function(e){ setMontoUSD(parseDecimalInput(e.target.value)); },
              placeholder:'0.00',className:'inp mono'}),
            h('div',{style:{fontSize:10,color:'var(--text3)',marginTop:3}},'Define cuánta deuda se extingue (TRM pactada ',fmt(trm),')'))),
          h('div',{style:{flex:1}},h(Fld,{label:'Pesos recibidos *'},
            h('input',{type:'text',inputMode:'numeric',value:fmtNumInput(copRecibido),
              onChange:function(e){ setCopRecibido(parseNum(e.target.value)); },
              placeholder:'0',className:'inp mono'}),
            h('div',{style:{fontSize:10,color:'var(--text3)',marginTop:3}},'Caja real del día'))))
      : h(Fld,{label:'Monto recibido *'},
          h('input',{type:'text',inputMode:'numeric',value:fmtNumInput(montoCOP),autoFocus:true,
            onChange:function(e){ setMontoCOP(parseNum(e.target.value)); },
            placeholder:'0',className:'inp mono'})),

    // TRM implicita / efecto cambiario
    esUSD&&trmImplicita>0&&h('div',{style:{fontSize:11,color:'var(--text3)',marginTop:-4}},
      'TRM implícita ',h('b',{className:'mono',style:{color:'var(--text2)'}},fmt(trmImplicita)),
      efectoTRM!==0&&h('span',null,'  •  efecto TRM ',
        h('b',{className:'mono',style:{color:efectoTRM<0?'var(--red)':'var(--green)'}},
          (efectoTRM>0?'+':'')+fmt(efectoTRM)))),

    // ── LOS DOS OVERRIDES ──
    // Van juntos y antes del desglose: los dos cambian el reparto, asi que el usuario
    // tiene que verlos ANTES de leer el resultado. Ambos nacen desmarcados — la
    // cascada del art. 1653 es el camino por defecto y estas son las excepciones.
    (cob.interesMes>0||cob.mora>0)&&h('div',{style:{display:'flex',flexDirection:'column',gap:7,marginTop:2}},
      cob.interesMes>0&&h('label',{style:{display:'flex',alignItems:'flex-start',gap:9,cursor:'pointer',
        background:'var(--blue-bg)',border:'1px solid var(--blue-bd)',borderRadius:10,padding:'9px 11px'}},
        h('input',{type:'checkbox',checked:incMes,onChange:function(){setIncMes(!incMes);},
          style:{marginTop:2,width:15,height:15,accentColor:'var(--blue)',cursor:'pointer'}}),
        h('span',null,
          h('span',{style:{fontSize:12,fontWeight:700,color:'var(--blue)'}},'Incluir intereses del mes actual'),
          h('span',{style:{display:'block',fontSize:11,color:'var(--text3)',marginTop:2,lineHeight:1.5}},
            'Cobra por adelantado el interes del periodo en curso (',fmtUni(uni(cob.interesMes)),
            ') antes de abonar a capital.'))),
      cob.mora>0&&h('label',{style:{display:'flex',alignItems:'flex-start',gap:9,cursor:'pointer',
        background:omitMora?'var(--yellow-bg)':'transparent',
        border:'1px solid '+(omitMora?'var(--yellow-bd)':'var(--border)'),borderRadius:10,padding:'9px 11px'}},
        h('input',{type:'checkbox',checked:omitMora,onChange:function(){setOmitMora(!omitMora);},
          style:{marginTop:2,width:15,height:15,accentColor:'var(--yellow)',cursor:'pointer'}}),
        h('span',null,
          h('span',{style:{fontSize:12,fontWeight:700,color:omitMora?'var(--yellow)':'var(--text2)'}},
            'No cobrar las cuotas vencidas — destinar todo a capital'),
          h('span',{style:{display:'block',fontSize:11,color:'var(--text3)',marginTop:2,lineHeight:1.5}},
            omitMora
              ? 'Las cuotas vencidas siguen debiendose con sus intereses. Es una imputacion que decides vos como acreedor (art. 1653).'
              : 'Por defecto el dinero cubre primero los intereses vencidos. Marca esto solo si pactaste imputar todo a capital.')))),

    h('div',{style:{display:'flex',gap:10}},
      h('div',{style:{flex:1}},h(Fld,{label:'Fecha del cobro'},
        h('input',{type:'date',value:fecha,onChange:function(e){ setFecha(e.target.value); },className:'inp'}))),
      h('div',{style:{flex:2}},h(Fld,{label:'Observaciones'},
        h('input',{type:'text',value:obs,onChange:function(e){ setObs(e.target.value); },
          placeholder:'Opcional',className:'inp'})))),

    // ── LA CASCADA ──
    plan&&plan.pasos.length>0&&h('div',{style:{marginTop:6}},
      h('div',{style:{fontSize:11,fontWeight:800,color:'var(--text2)',letterSpacing:.5,marginBottom:7}},
        'CÓMO SE APLICA ESTE DINERO'),
      pasosUI,
      h('div',{style:{background:'var(--bg3)',border:'1px solid var(--border)',borderRadius:10,padding:'9px 12px',marginTop:9}},
        vis.intU>0&&linea('Intereses vencidos', fmtUni(vis.intU),'var(--red)'),
        vis.mesU>0&&linea('Interes del mes en curso', fmtUni(vis.mesU),'var(--blue)'),
        vis.capMoraU>0&&linea('Capital de cuotas vencidas', fmtUni(vis.capMoraU),'var(--text2)'),
        vis.abonoU>0&&linea('Abono extraordinario a capital', fmtUni(vis.abonoU),'var(--green)'),
        h('div',{style:{height:1,background:'var(--border)',margin:'5px 0'}}),
        linea('Total aplicado', fmtUni(vis.aplicadoU),'var(--text)',true),
        esUSD&&linea('Caja registrada', fmt(T.caja),'var(--text3)'))),

    // Aviso de sobrante
    plan&&plan.error&&h('div',{style:{background:'var(--yellow-bg)',border:'1px solid var(--yellow-bd)',borderRadius:10,padding:'10px 12px',fontSize:12,color:'var(--yellow)',lineHeight:1.55}},
      h('b',null,'No cabe todo. '),plan.error,
      onRequestLiquidar&&h('div',{style:{marginTop:7}},
        h('button',{onClick:function(){ onRequestLiquidar(loan); },
          style:{background:'transparent',border:'1px solid var(--yellow-bd)',color:'var(--yellow)',borderRadius:8,padding:'6px 11px',fontSize:11,fontWeight:700,cursor:'pointer'}},
          'Ir a Liquidar deuda'))),

    // ── OPCIONES DE RECALCULO (absorbidas del abono directo) ──
    // Se dibujan SOLO si el cobro deja un abono extraordinario: sin abono el capital
    // no baja, el cronograma no se regenera y estos radios no decidirian nada.
    aplicaRecalc&&h('div',{style:{background:'var(--blue-bg)',border:'1px solid var(--blue-bd)',borderRadius:10,padding:'11px 12px'}},
      h('div',{style:{fontSize:11,fontWeight:800,color:'var(--blue)',letterSpacing:.5,marginBottom:3}},
        'QUE HACER CON EL CRONOGRAMA'),
      h('div',{style:{fontSize:11,color:'var(--text3)',marginBottom:6,lineHeight:1.5}},
        'El abono baja el capital. Elige como se reparte lo que queda.'),
      [['mantener','Mantener plazo','Conserva las cuotas restantes. La cuota mensual baja.'],
       ['modificarPlazo','Modificar plazo','Tu eliges el nuevo numero de cuotas restantes.'],
       ['fijarCuota','Fijar valor de cuota','Tu eliges cuanto pagar de cuota; el plazo se ajusta.']]
      .map(function(op){
        return h('label',{key:op[0],style:{display:'flex',alignItems:'flex-start',gap:8,padding:'5px 0',cursor:'pointer'}},
          h('input',{type:'radio',name:'cobroRecalc',checked:recalcMode===op[0],
            onChange:function(){ setRecalcMode(op[0]); setRecalcInput(''); },
            style:{marginTop:3,accentColor:'var(--blue)',cursor:'pointer'}}),
          h('span',null,
            h('span',{style:{fontSize:12,color:'var(--text)',fontWeight:600}},op[1]),
            h('span',{style:{display:'block',fontSize:10.5,color:'var(--text3)',marginTop:1}},op[2])));
      }),
      recalcMode==='modificarPlazo'&&h('input',{type:'text',inputMode:'numeric',value:recalcInput,
        onChange:function(e){ setRecalcInput(parseIntInput(e.target.value)); },
        placeholder:'Nuevo numero de cuotas (ej: 3)',className:'inp mono',style:{marginTop:5}}),
      recalcMode==='fijarCuota'&&h('div',null,
        h('input',{type:'text',inputMode:'decimal',value:recalcInput,
          onChange:function(e){ setRecalcInput(esUSD?parseDecimalInput(e.target.value):parseNum(e.target.value)); },
          placeholder:esUSD?'Cuota fija en USD (ej: 250.00)':'Cuota fija en COP',className:'inp mono',style:{marginTop:5}}),
        esUSD&&(+recalcInput)>0&&h('div',{style:{fontSize:10.5,color:'var(--text3)',marginTop:3}},
          'Equivale a ',fmt(recalcValorCOP),' (TRM ',fmt(trm),')')),
      cronoPreview&&cronoPreview.error&&h('div',{style:{marginTop:7,background:'var(--red-bg)',border:'1px solid var(--red-bd)',
        borderRadius:8,padding:'8px 10px',fontSize:11,color:'var(--red)',lineHeight:1.5}},cronoPreview.error)),

    // ── PREVIEW DEL CRONOGRAMA ──
    cronoPreview&&h('div',{style:{marginTop:4}},
      // Resumen ejecutivo de caja: se lee sin abrir la tabla y se le puede leer al
      // cliente tal cual. Va siempre que haya cuota proyectada, tenga abono encima o no.
      proxPago&&h('div',{style:{background:'var(--green-bg)',border:'1px solid var(--green-bd)',
        borderRadius:10,padding:'9px 12px',marginBottom:9,fontSize:12,color:'var(--green)',lineHeight:1.5}},
        h('div',null,'Tu cliente pagará ',
          h('b',{className:'mono',style:{fontSize:13.5}},money(proxPago.neto)),
          proxPago.fecha?' el '+fmtD(proxPago.fecha):''),
        proxPago.abonado>0&&h('div',{style:{opacity:.85,fontSize:11,marginTop:2}},
          'cuota de ',money(proxPago.cuota),' menos ',money(proxPago.abonado),
          ' que abona hoy por adelantado')),
      h('button',{onClick:function(){ setVerCron(!verCron); },
        style:{background:'transparent',border:'none',padding:0,cursor:'pointer',display:'flex',alignItems:'center',gap:6,marginBottom:7}},
        h(Ico,{name:verCron?'chevdown':'chevright',size:13,color:'var(--text2)',sw:2.5}),
        h('span',{style:{fontSize:11,fontWeight:800,color:'var(--text2)',letterSpacing:.5}},
          'CRONOGRAMA DESPUÉS DEL COBRO')),
      verCron&&(cronoPreview.saldado
        ? h('div',{style:{background:'var(--green-bg)',border:'1px solid var(--green-bd)',borderRadius:10,padding:'11px 13px',fontSize:12,color:'var(--green)',fontWeight:700}},
            'El crédito queda SALDADO: no quedan cuotas por cobrar.')
        : h('div',{style:{border:'1px solid var(--border)',borderRadius:10,overflow:'hidden'}},
            h('div',{style:{overflowX:'auto'}},
              h('table',{style:{width:'100%',borderCollapse:'collapse',fontSize:11}},
                h('thead',null,h('tr',{style:{background:'var(--bg3)'}},
                  ['#','VENCE','INTERÉS','ABONO A CAPITAL','VALOR CUOTA','SALDO'].map(function(t,i){
                    return h('th',{key:i,style:{padding:'6px 7px',textAlign:i<2?'left':'right',fontSize:9.5,fontWeight:800,color:'var(--text3)',letterSpacing:.4,whiteSpace:'nowrap'}},t);
                  }))),
                h('tbody',null,cronoPreview.filas.map(function(f,i){
                  // Columnas universales (v1.18.0): ABONO A CAPITAL = VALOR CUOTA - INTERES,
                  // reconciliado en la moneda visible para que la identidad cuadre a la vista.
                  var qU=uni(f.cuota), iU=uni(f.interes), cU=Math.max(0, qU-iU);
                  return h('tr',{key:i,style:{borderTop:'1px solid var(--border)'}},
                    h('td',{style:{padding:'5px 7px',color:'var(--text2)',fontWeight:700}},f.cuotaN),
                    h('td',{style:{padding:'5px 7px',color:'var(--text3)',whiteSpace:'nowrap'}},f.fecha?fmtD(f.fecha):'—'),
                    h('td',{className:'mono',style:{padding:'5px 7px',textAlign:'right',color:'var(--text3)',whiteSpace:'nowrap'}},fmtUni(iU)),
                    h('td',{className:'mono',style:{padding:'5px 7px',textAlign:'right',color:'var(--text3)',whiteSpace:'nowrap'}},fmtUni(cU)),
                    h('td',{className:'mono',style:{padding:'5px 7px',textAlign:'right',color:'var(--text)',fontWeight:700,whiteSpace:'nowrap'}},fmtUni(qU)),
                    h('td',{className:'mono',style:{padding:'5px 7px',textAlign:'right',color:'var(--text2)',whiteSpace:'nowrap'}},money(f.saldo)));
                })))),
            cronoPreview.filas.length>0&&cronoPreview.filas[0].antes>0&&
              h('div',{style:{padding:'7px 10px',borderTop:'1px solid var(--border)',fontSize:11,color:'var(--text3)',background:'var(--bg3)'}},
                'La cuota pasa de ',h('b',{className:'mono',style:{color:'var(--text2)'}},money(cronoPreview.filas[0].antes)),
                ' a ',h('b',{className:'mono',style:{color:'var(--green)'}},money(cronoPreview.filas[0].cuota)),
                ' · quedan ',h('b',null,cronoPreview.n),' cuota',cronoPreview.n===1?'':'s')))),

    // ── Fallo a mitad de la cadena ──
    fallo&&h('div',{style:{background:'var(--red-bg)',border:'1px solid var(--red-bd)',borderRadius:10,padding:'11px 13px',fontSize:12,color:'var(--red)',lineHeight:1.6}},
      h('b',null,'El cobro se aplicó solo en parte.'),
      h('div',{style:{marginTop:5}},fallo.error),
      fallo.hechos&&fallo.hechos.length>0&&h('div',{style:{marginTop:7,color:'var(--text2)'}},
        h('b',null,'Sí se registró:'),
        h('ul',{style:{margin:'4px 0 0',paddingLeft:17}},
          fallo.hechos.map(function(p,i){
            return h('li',{key:i,style:{marginBottom:2}},
              p.tipo==='partial'?('Cuota #'+p.cuotaN+' — '+money(p.obligacionCOP)):('Abono a capital — '+money(p.obligacionCOP)));
          }))),
      h('div',{style:{marginTop:7,color:'var(--text2)'}},
        'Lo demás NO se aplicó. Revisa el crédito antes de reintentar: si repites el cobro completo, lo ya registrado se duplicará.')),

    // ── PROPUESTA PARA EL CLIENTE ──
    // El caso real: el cliente pregunta "si te abono 400, como quedamos?". Este boton
    // le manda el papel SIN registrar nada. Va antes del check del recibo porque
    // ocurre antes en el tiempo: primero se propone, despues (si acepta) se cobra.
    //
    // Mismo patron que el boton secundario de `LiquidarModal`, que genera el Estado de
    // Liquidacion antes de confirmar. No lleva `_submitGuard`: no escribe nada, asi que
    // pulsarlo dos veces solo produce dos PDF identicos.
    plan&&plan.ok&&plan.pasos.length>0&&h('button',{
      onClick:function(){
        try{
          generatePropuestaAbono(loan, allPays, {
            fecha:fecha, plan:plan, cajaCOP:cajaCOP,
            proyeccion:{
              filas:(cronoPreview&&cronoPreview.filas)||[],
              n:(cronoPreview&&cronoPreview.n)||0,
              saldado:!!(cronoPreview&&cronoPreview.saldado),
              totalAntes:proy.totalAntes,
              totalDespues:proy.totalDespues,
              abonadoProxima:proy.abonadoProxima,
              cuotaAntes:cuotaActual,
            },
          });
        }catch(e){ /* un fallo del PDF no puede romper el modal */ }
      },
      style:{width:'100%',padding:'10px 12px',borderRadius:10,fontSize:12.5,fontWeight:700,cursor:'pointer',
        display:'flex',alignItems:'center',justifyContent:'center',gap:7,fontFamily:'inherit',
        background:'transparent',border:'1px solid var(--blue-bd)',color:'var(--blue)'}},
      h(Ico,{name:'receipt',size:14,color:'var(--blue)',sw:2.2}),
      'Enviar propuesta al cliente (no cobra)'),

    // ── Recibo consolidado ──
    // Un cobro en cascada son N movimientos, pero para el cliente fue UNA entrega:
    // se emite UN solo comprobante por el total, no uno por paso. El checkbox replica
    // el patron de PayModal y AbonoModal (por defecto activado).
    plan&&plan.ok&&plan.pasos.length>0&&h('div',null,
      plan.pasos.length>1&&h('div',{style:{fontSize:11,color:'var(--text3)',lineHeight:1.55,marginBottom:8}},
        'Este cobro se registra como ',h('b',null,plan.pasos.length),' movimientos, cada uno reversible por separado desde el Historial. Se emite ',
        h('b',{style:{color:'var(--text2)'}},'un solo recibo'),' por el total recibido.'),
      h('label',{style:{display:'flex',alignItems:'center',gap:8,cursor:'pointer',fontSize:12,color:'var(--text2)'}},
        h('input',{type:'checkbox',checked:genRecibo,onChange:function(){setGenRecibo(!genRecibo);},style:{width:16,height:16,accentColor:'var(--blue)',cursor:'pointer'}}),
        'Generar recibo de cobro')),

    // ── Acciones ──
    h('div',{style:{display:'flex',gap:10,marginTop:8}},
      h('button',{onClick:onClose,style:{flex:1,background:'var(--bg3)',color:'var(--text2)',border:'1px solid var(--border)',borderRadius:12,padding:'12px 8px',fontSize:13,fontWeight:700,cursor:'pointer'}},'Cancelar'),
      h(ABtn,{color:'var(--green)',icon:'check',
        label:sending?'Registrando…':(plan&&plan.pasos.length>1?('Registrar cobro ('+plan.pasos.length+' pasos)'):'Registrar cobro'),
        disabled:!plan||!plan.ok||!plan.pasos.length||faltanCamposUSD||sending||
          !!(cronoPreview&&cronoPreview.error),
        onClick:submit})));
}
