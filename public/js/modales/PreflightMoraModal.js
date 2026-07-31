// public/js/modales/PreflightMoraModal.js — Aviso previo: cuotas a punto de entrar en mora antes de recalcular.
//
// Extraido de `app.js` en la Etapa 3 (B7) del refactor. Codigo VERBATIM.
//
// El estado global sigue en `App` y baja por PROPS; los callbacks suben igual.
// Sin Context API y sin store.

import { Modal } from '../componentes/base.js';
import { Ico } from '../componentes/iconos.js';
import { copToUsd, fmt, fmtD } from '../core/format.js';
import { h, useState } from '../core/react.js';
import { _submitGuard, nowStr } from '../core/ui.js';

export function PreflightMoraModal(props){
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
