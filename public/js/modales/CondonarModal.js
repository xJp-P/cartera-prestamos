// public/js/modales/CondonarModal.js — Condonar intereses en mora.
//
// El acuerdo que este modal ejecuta: "devuelveme el capital y te perdono los
// intereses". Lo que hace NO es registrar un pago: MODIFICA LA OBLIGACION. El
// interes vencido deja de deberse, el capital sigue intacto, y no entra ni sale
// un peso de caja.
//
// ── POR QUE HACIA FALTA UNA HERRAMIENTA PROPIA ────────────────────────────────
// Los tres caminos que ya existian mentian de formas distintas. El peor era
// `Liquidar`, que es el mas tentador porque es el unico que cierra limpio: registra
// como RECIBIDO el interes que en realidad se perdono, inflando a la vez "Cobros del
// Mes" y "Ganancias". `Abono` deja las cuotas vencidas vivas y el credito no cierra
// nunca. Y `abono + cierre forzoso` da los numeros exactos pero marca el credito
// 'Cancelado', que Rendimiento pinta como "Perdida total" aunque se haya recuperado
// el 100% del capital.
//
// ── QUE NO HACE ESTE MODAL ────────────────────────────────────────────────────
// No cobra. Despues de condonar, el capital se cobra por la via normal (Registrar
// cobro), y el credito cierra como 'Finalizado' por la rama de siempre. Esa es la
// razon de ser del diseno: fuera de este endpoint, el motor no se entera de nada.

import { ABtn, Fld, Modal } from '../componentes/base.js';
import { copToUsd, fmt, fmtD } from '../core/format.js';
import { esDiario, estadoDiario } from '../core/dominio.js';
import { h, useState } from '../core/react.js';
import { _submitGuard, nowStr } from '../core/ui.js';
import { esAbono } from '../core/ids.js';

export function CondonarModal(props){
  var loan=props.loan, allPays=props.pays||[], onConfirm=props.onConfirm, onClose=props.onClose;
  var esUSD=loan.moneda==='USD';
  var trm=+loan.trmAcordada||0;
  var diario=esDiario(loan);
  var money=function(cop){ return esUSD?copToUsd(cop,trm):fmt(cop); };

  var loanPays=allPays.filter(function(p){ return String(p.prestamoId)===String(loan.id); });
  // Mismo filtro que el backend: regulares En Mora (los '-ab-' quedan fuera).
  var mora=loanPays.filter(function(p){ return p.estadoPago==='En Mora'&&!esAbono(p); })
    .sort(function(a,b){ return (a.cuotaN||0)-(b.cuotaN||0); });

  // En un credito abierto no hay cuotas: el interes se deriva del tiempo.
  var dev=diario?estadoDiario(loan, loanPays, nowStr()):null;

  // Seleccion: todas marcadas de entrada. El caso normal es condonar todo; poder
  // desmarcar existe para el acuerdo parcial ("te perdono los meses mas viejos").
  var s1=useState(mora.map(function(p){ return p.id; }));
  var sel=s1[0]; var setSel=s1[1];
  var s2=useState(''); var obs=s2[0]; var setObs=s2[1];
  var s3=useState(false); var sending=s3[0]; var setSending=s3[1];

  function toggle(id){
    setSel(sel.indexOf(id)!==-1?sel.filter(function(x){ return x!==id; }):sel.concat([id]));
  }

  var elegidas=mora.filter(function(p){ return sel.indexOf(p.id)!==-1; });
  var intCondonar=diario?Math.round(dev?dev.interesPendiente:0)
    :Math.round(elegidas.reduce(function(s,p){ return s+(p.interesPeriodo||0); },0));
  var capQueda=diario?Math.round(dev?dev.capitalVivo:0)
    :Math.round(elegidas.reduce(function(s,p){ return s+(p.abonoCapital||0); },0));
  // Lo que el deudor debia por estas cuotas antes de condonar.
  var deudaAntes=intCondonar+capQueda;

  // Espejo del rechazo del backend: una cuota con mas dinero encima del que va a
  // costar tras condonar dejaria un sobrante sin donde vivir. Se avisa aqui para no
  // mandar un POST que se sabe que rebota (defense-in-depth, no sustituto).
  var conflictiva=elegidas.filter(function(p){
    return Math.round(p.partialPaid||0)>Math.round(p.abonoCapital||0);
  })[0];

  var puede=intCondonar>0&&!conflictiva&&(diario||elegidas.length>0);

  function submit(){
    if(!puede) return;
    return _submitGuard(sending,setSending,function(){
      // En credito abierto no se manda seleccion: no hay cuotas que elegir.
      return onConfirm(loan.id, diario?null:elegidas.map(function(p){ return p.id; }), obs);
    });
  }

  function linea(label,valor,color,fuerte){
    return h('div',{style:{display:'flex',justifyContent:'space-between',alignItems:'baseline',gap:10,padding:'3px 0'}},
      h('span',{style:{fontSize:12,color:fuerte?'var(--text)':'var(--text2)',fontWeight:fuerte?700:500}},label),
      h('span',{className:'mono',style:{fontSize:fuerte?13:12,fontWeight:fuerte?800:600,color:color||'var(--text)'}},valor));
  }

  // ── Lista de cuotas vencidas, con su checkbox ──────────────────────────────
  var listaUI=!diario&&mora.length>0?h('div',{style:{display:'flex',flexDirection:'column',gap:6}},
    mora.map(function(p){
      var on=sel.indexOf(p.id)!==-1;
      var cap=Math.round(p.abonoCapital||0);
      return h('label',{key:p.id,style:{display:'flex',alignItems:'flex-start',gap:9,cursor:'pointer',
        border:'1px solid '+(on?'var(--yellow-bd)':'var(--border)'),borderRadius:10,padding:'9px 11px',
        background:on?'var(--yellow-bg)':'var(--bg3)',transition:'all .15s'}},
        h('input',{type:'checkbox',checked:on,onChange:function(){ toggle(p.id); },
          style:{width:16,height:16,marginTop:1,accentColor:'var(--yellow)',cursor:'pointer',flexShrink:0}}),
        h('div',{style:{flex:1,minWidth:0}},
          h('div',{style:{display:'flex',alignItems:'baseline',gap:7}},
            h('span',{style:{fontSize:12,fontWeight:700,color:'var(--text)'}},'Cuota #'+p.cuotaN),
            h('span',{style:{fontSize:11,color:'var(--text3)'}},'venció el '+fmtD(p.fechaPago)),
            h('span',{style:{flex:1}}),
            h('span',{className:'mono',style:{fontSize:12,fontWeight:800,color:'var(--red)'}},
              '−'+money(Math.round(p.interesPeriodo||0)))),
          h('div',{style:{fontSize:11,color:'var(--text3)',marginTop:2,lineHeight:1.5}},
            'intereses ',h('b',{style:{color:'var(--red)'}},money(Math.round(p.interesPeriodo||0))),
            cap>0?h('span',null,'  •  capital ',h('b',{style:{color:'var(--text2)'}},money(cap)),' (sigue debiéndose)')
                 :h('span',null,'  •  sin capital: la cuota queda saldada'),
            Math.round(p.partialPaid||0)>0&&h('div',{style:{color:'var(--yellow)'}},
              'ya abonado ',money(Math.round(p.partialPaid))))));
    })):null;

  return h(Modal,{onClose:onClose,tall:true,wide:true},
    h('div',{style:{fontSize:17,fontWeight:800,color:'var(--text)'}},'Condonar intereses'),
    h('div',{style:{fontSize:12,color:'var(--text2)',marginTop:-6}},
      loan.nombre,' · ',loan.modalidad,esUSD?' · USD':''),

    // ── Que es esto, dicho antes de nada ──
    // El aviso va ARRIBA a proposito: la confusion que este modal viene a eliminar es
    // creer que perdonar intereses es una forma de cobrarlos.
    h('div',{style:{background:'var(--yellow-bg)',border:'1px solid var(--yellow-bd)',borderRadius:10,
      padding:'10px 12px',fontSize:12,color:'var(--yellow)',lineHeight:1.55,marginTop:4}},
      h('b',null,'Esto no registra ningún pago. '),
      'Reduce lo que el deudor debe: los intereses vencidos dejan de cobrarse y el capital queda intacto. ',
      'No entra dinero, así que no aparece en Cobros del Mes.'),

    diario
      // ── Credito abierto: no hay cuotas, el interes se derivo del tiempo ──
      ? h('div',{style:{background:'var(--bg3)',border:'1px solid var(--border)',borderRadius:10,padding:'10px 12px',marginTop:10}},
          linea('Interés devengado pendiente', money(intCondonar),'var(--red)'),
          dev&&linea('Días devengados', String(dev.diasDesdeUltimoCorte)+' día'+(dev.diasDesdeUltimoCorte===1?'':'s'),'var(--text3)'),
          linea('Capital vivo', money(capQueda),'var(--text2)'),
          h('div',{style:{height:1,background:'var(--border)',margin:'5px 0'}}),
          linea('Quedaría debiendo', money(capQueda),'var(--text)',true))
      // ── Con cronograma: se eligen las cuotas ──
      : mora.length===0
        ? h('div',{style:{background:'var(--bg3)',border:'1px solid var(--border)',borderRadius:10,
            padding:'14px',fontSize:12,color:'var(--text3)',textAlign:'center',marginTop:10}},
            'Este crédito no tiene cuotas vencidas: no hay intereses que condonar.')
        : h('div',{style:{marginTop:10}},
            h('div',{style:{fontSize:11,fontWeight:800,color:'var(--text2)',letterSpacing:.5,marginBottom:7,
              display:'flex',alignItems:'center',gap:8}},
              'CUOTAS VENCIDAS',
              h('span',{style:{flex:1}}),
              h('button',{onClick:function(){ setSel(sel.length===mora.length?[]:mora.map(function(p){ return p.id; })); },
                style:{background:'transparent',border:'1px solid var(--border)',color:'var(--text3)',
                  borderRadius:7,padding:'3px 9px',fontSize:10,fontWeight:700,cursor:'pointer',letterSpacing:0}},
                sel.length===mora.length?'Ninguna':'Todas')),
            listaUI),

    // ── Resultado ──
    intCondonar>0&&h('div',{style:{background:'var(--bg3)',border:'1px solid var(--border)',borderRadius:10,padding:'9px 12px',marginTop:10}},
      linea('Deuda actual por lo vencido', money(deudaAntes),'var(--text2)'),
      linea('Intereses que perdonas', '−'+money(intCondonar),'var(--red)'),
      h('div',{style:{height:1,background:'var(--border)',margin:'5px 0'}}),
      linea(diario?'Capital que seguirá debiendo':'Capital vencido que seguirá debiendo',
        money(capQueda),'var(--text)',true)),

    // Espejo del 4xx del backend.
    conflictiva&&h('div',{style:{background:'var(--red-bg)',border:'1px solid var(--red-bd)',borderRadius:10,
      padding:'10px 12px',fontSize:12,color:'var(--red)',lineHeight:1.55,marginTop:10}},
      h('b',null,'La cuota #',conflictiva.cuotaN,' tiene un abono mayor al capital que quedaría. '),
      'Ya lleva ',money(Math.round(conflictiva.partialPaid)),' abonados y tras condonar costaría ',
      money(Math.round(conflictiva.abonoCapital)),'. Cóbrala o revierte ese abono antes de condonar sus intereses.'),

    h(Fld,{label:'Motivo del acuerdo'},
      h('input',{type:'text',value:obs,onChange:function(e){ setObs(e.target.value); },
        placeholder:'Opcional — queda registrado en la cuota y en el Historial',className:'inp'})),

    intCondonar>0&&h('div',{style:{fontSize:11,color:'var(--text3)',lineHeight:1.55,marginTop:2}},
      'Queda registrado en el Historial y se puede deshacer. ',
      diario?'Después podrás cobrar el capital normalmente.'
            :'Después cobra el capital con “Registrar cobro” y el crédito cerrará solo.'),

    h('div',{style:{display:'flex',gap:10,marginTop:10}},
      h('button',{onClick:onClose,style:{flex:1,background:'var(--bg3)',color:'var(--text2)',border:'1px solid var(--border)',borderRadius:12,padding:'12px 8px',fontSize:13,fontWeight:700,cursor:'pointer'}},'Cancelar'),
      h(ABtn,{color:'var(--yellow)',icon:'alert',
        label:sending?'Condonando…':(intCondonar>0?('Condonar '+money(intCondonar)):'Condonar intereses'),
        disabled:!puede||sending,
        onClick:submit})));
}
