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

import { ABtn, Fld, Modal } from '../componentes/base.js';
import { Ico } from '../componentes/iconos.js';
import { cobrableTotal, planCascada } from '../core/cascada.js';
import { _pmt, _tasaPeriodo, filasPreview } from '../core/calculo.js';
import { copToUsd, fmt, fmtD, fmtNumInput, parseDecimalInput, parseNum } from '../core/format.js';
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

  var loanPays=allPays.filter(function(p){ return String(p.prestamoId)===String(loan.id); });
  var cob=cobrableTotal(loan, allPays);
  var ctx=cob.ctx;

  // ── Entrada normalizada ────────────────────────────────────────────────────
  var oblUSD=esUSD?(parseNum(montoUSD)||0):0;
  var oblCOP=esUSD?0:(parseNum(montoCOP)||0);
  var cajaCOP=esUSD?(parseNum(copRecibido)||0):oblCOP;
  var hayEntrada=esUSD?(oblUSD>0):(oblCOP>0);
  var faltanCamposUSD=esUSD&&(oblUSD<=0||cajaCOP<=0);

  var plan=hayEntrada?planCascada(loan, allPays, {obligacionUSD:oblUSD, obligacionCOP:oblCOP, cajaCOP:cajaCOP}):null;
  var T=plan?plan.totales:null;

  // Efecto cambiario del cobro completo (solo informativo, no decide nada).
  var trmImplicita=(esUSD&&oblUSD>0&&cajaCOP>0)?Math.round(cajaCOP/oblUSD):0;
  var efectoTRM=(esUSD&&oblUSD>0&&cajaCOP>0)?(cajaCOP-Math.round(oblUSD*trm)):0;

  // ── Preview del cronograma resultante ──────────────────────────────────────
  // Solo tiene sentido donde hay amortizacion. `filasPreview` es el espejo del
  // motor; las FECHAS se toman de las cuotas Pendientes que ya existen (conservan
  // su `cuotaN`, y `getPayDate` las deriva de ahi) en vez de recalcular calendario:
  // asi el preview respeta solo cualquier prorroga o cambio de dia de pago.
  var cronoPreview=(function(){
    if(!plan||!plan.ok||!esCapInt) return null;
    var saldo=plan.saldoTrasCascada;
    var n=Math.max(0,(+loan.plazoMeses||0)-ctx.regularConsumed);
    if(n<=0) return {filas:[],saldado:saldo<=0,n:0};
    if(saldo<=0) return {filas:[],saldado:true,n:0};
    var r=_tasaPeriodo((+loan.tasaMensual||0)/100, loan.frecuencia||'Mensual');
    var nominal=Math.round(_pmt(r,n,saldo));
    var filas=filasPreview(saldo,r,n,false,nominal);
    var pend=loanPays.filter(function(p){ return !esAbono(p)&&p.estadoPago==='Pendiente'; })
      .sort(function(a,b){ return (a.cuotaN||0)-(b.cuotaN||0); });
    filas.forEach(function(f,i){
      f.cuotaN=ctx.regularConsumed+1+i;
      f.fecha=pend[i]?pend[i].fechaPago:null;
      f.antes=pend[i]?Math.round(pend[i].cuotaTotal):0;
    });
    return {filas:filas,saldado:false,n:n};
  })();

  var money=function(cop){ return esUSD?copToUsd(cop,trm):fmt(cop); };

  function submit(){
    if(!plan||!plan.ok||!plan.pasos.length) return;
    setFallo(null);
    return _submitGuard(sending,setSending,function(){
      return onConfirm(loan.id, plan, fecha, obs, genRecibo).then(function(res){
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
      return h('div',{key:i,style:{border:'1px solid var(--border)',borderRadius:10,padding:'9px 11px',background:'var(--bg3)'}},
        h('div',{style:{display:'flex',alignItems:'center',gap:7,marginBottom:5}},
          h('span',{style:{width:18,height:18,borderRadius:99,background:esMora?'var(--red-bg)':'var(--green-bg)',color:esMora?'var(--red)':'var(--green)',fontSize:10,fontWeight:800,display:'flex',alignItems:'center',justifyContent:'center',flexShrink:0}},String(i+1)),
          h('span',{style:{fontSize:12,fontWeight:700,color:'var(--text)'}},
            esMora?('Cuota #'+p.cuotaN+' vencida'):'Abono extraordinario a capital'),
          esMora&&(p.salda?chip('SE SALDA','var(--green)','var(--green-bg)'):chip('PARCIAL','var(--yellow)','var(--yellow-bg)')),
          h('span',{style:{flex:1}}),
          h('span',{className:'mono',style:{fontSize:12,fontWeight:800,color:'var(--text)'}},money(p.obligacionCOP))),
        esMora&&h('div',{style:{fontSize:11,color:'var(--text3)',paddingLeft:25,lineHeight:1.6}},
          'venció el ',fmtD(p.fechaPago),
          p.interes>0&&h('span',null,'  •  intereses ',h('b',{style:{color:'var(--red)'}},money(p.interes))),
          p.capital>0&&h('span',null,'  •  capital ',h('b',{style:{color:'var(--text2)'}},money(p.capital))),
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
      linea('Cuotas vencidas por cobrar', cob.mora>0?money(cob.mora):'—', cob.mora>0?'var(--red)':'var(--text3)'),
      linea('Capital amortizable', money(cob.abonable), 'var(--text2)'),
      h('div',{style:{height:1,background:'var(--border)',margin:'5px 0'}}),
      linea('Total que se puede cobrar hoy', money(cob.total), 'var(--text)', true)),

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
        T.interesMora>0&&linea('Intereses vencidos', money(T.interesMora),'var(--red)'),
        T.capitalMora>0&&linea('Capital de cuotas vencidas', money(T.capitalMora),'var(--text2)'),
        T.abonoCapital>0&&linea('Abono extraordinario a capital', money(T.abonoCapital),'var(--green)'),
        h('div',{style:{height:1,background:'var(--border)',margin:'5px 0'}}),
        linea('Total aplicado', money(T.aplicado),'var(--text)',true),
        esUSD&&linea('Caja registrada', fmt(T.caja),'var(--text3)'))),

    // Aviso de sobrante
    plan&&plan.error&&h('div',{style:{background:'var(--yellow-bg)',border:'1px solid var(--yellow-bd)',borderRadius:10,padding:'10px 12px',fontSize:12,color:'var(--yellow)',lineHeight:1.55}},
      h('b',null,'No cabe todo. '),plan.error,
      onRequestLiquidar&&h('div',{style:{marginTop:7}},
        h('button',{onClick:function(){ onRequestLiquidar(loan); },
          style:{background:'transparent',border:'1px solid var(--yellow-bd)',color:'var(--yellow)',borderRadius:8,padding:'6px 11px',fontSize:11,fontWeight:700,cursor:'pointer'}},
          'Ir a Liquidar deuda'))),

    // ── PREVIEW DEL CRONOGRAMA ──
    cronoPreview&&h('div',{style:{marginTop:4}},
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
                  return h('tr',{key:i,style:{borderTop:'1px solid var(--border)'}},
                    h('td',{style:{padding:'5px 7px',color:'var(--text2)',fontWeight:700}},f.cuotaN),
                    h('td',{style:{padding:'5px 7px',color:'var(--text3)',whiteSpace:'nowrap'}},f.fecha?fmtD(f.fecha):'—'),
                    h('td',{className:'mono',style:{padding:'5px 7px',textAlign:'right',color:'var(--text3)',whiteSpace:'nowrap'}},money(f.interes)),
                    h('td',{className:'mono',style:{padding:'5px 7px',textAlign:'right',color:'var(--text3)',whiteSpace:'nowrap'}},money(f.capital)),
                    h('td',{className:'mono',style:{padding:'5px 7px',textAlign:'right',color:'var(--text)',fontWeight:700,whiteSpace:'nowrap'}},money(f.cuota)),
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
        disabled:!plan||!plan.ok||!plan.pasos.length||faltanCamposUSD||sending,
        onClick:submit})));
}
