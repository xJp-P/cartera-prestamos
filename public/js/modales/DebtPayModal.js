// public/js/modales/DebtPayModal.js — Registrar un movimiento de deuda propia (abono o cargo).
//
// Extraido de `app.js` en la Etapa 3 (B7) del refactor. Codigo VERBATIM.
//
// El estado global sigue en `App` y baja por PROPS; los callbacks suben igual.
// Sin Context API y sin store.

import { ABtn, Fld, Modal } from '../componentes/base.js';
import { showError } from '../core/api.js';
import { fmt, fmtNumInput, parseNum } from '../core/format.js';
import { h, useState } from '../core/react.js';
import { _submitGuard, nowStr, properCase } from '../core/ui.js';

export function DebtPayModal(props){
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
