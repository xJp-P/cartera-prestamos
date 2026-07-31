// public/js/modales/ConfirmModal.js — Confirmacion generica reutilizable.
//
// Extraido de `app.js` en la Etapa 3 (B7) del refactor. Codigo VERBATIM.
//
// El estado global sigue en `App` y baja por PROPS; los callbacks suben igual.
// Sin Context API y sin store.

import { h, useState } from '../core/react.js';

export function ConfirmModal(props){
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
