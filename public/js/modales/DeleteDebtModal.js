// public/js/modales/DeleteDebtModal.js — Confirmacion de borrado de una deuda propia.
//
// Extraido de `app.js` en la Etapa 3 (B7) del refactor. Codigo VERBATIM.
//
// El estado global sigue en `App` y baja por PROPS; los callbacks suben igual.
// Sin Context API y sin store.

import { Modal } from '../componentes/base.js';
import { Ico } from '../componentes/iconos.js';
import { h } from '../core/react.js';
import { properCase } from '../core/ui.js';

// Confirmacion de borrado de deuda (reemplaza window.confirm; estetica de la app, dark-mode).
export function DeleteDebtModal(props){
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
