// public/js/componentes/base.js — los tres primitivos de UI.
//
// Extraido de `app.js` en la Etapa 3 (B5) del refactor. Codigo VERBATIM.
//
// `Modal` (contenedor), `Fld` (etiqueta + campo) y `ABtn` (boton de accion) van
// juntos porque son el kit minimo con el que estan construidos los 14 modales de
// la app: se usan siempre en compania y ninguno llega a las 12 lineas. Un archivo
// por cabeza seria fragmentar por fragmentar.
//
// DOS DETALLES DE COMPORTAMIENTO QUE NO SE TOCAN:
//  - `Modal`: el backdrop NO cierra (QA3). Solo cierran la X y los botones de
//    accion, para no perder datos de un formulario a medio llenar por un clic.
//  - `ABtn`: la prop opcional `disabled` (v1.18.1) es la que permite a las guardas
//    anti doble-submit apagar el boton. Sin pasarla, se comporta igual que antes.

import { h } from '../core/react.js';
import { Ico } from './iconos.js';

// ── Shared ────────────────────────────────────────────────────────────────────
export function Modal(props){
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
export function Fld(props){return h('div',{style:{marginTop:6}},h('div',{style:{fontSize:12,fontWeight:600,color:'var(--text2)',marginBottom:5}},props.label),props.children);}
// v1.18.1 — prop opcional `disabled` (para las guardas anti doble-submit). Sin ella el
// componente se comporta exactamente igual que antes, asi que los usos existentes no cambian.
export function ABtn(props){
  var dis=!!props.disabled;
  return h('button',{onClick:dis?undefined:props.onClick,disabled:dis,style:{flex:1,background:dis?'var(--bg3)':props.color,color:dis?'var(--text3)':'white',border:'none',borderRadius:12,padding:'12px 8px',fontSize:13,fontWeight:700,cursor:dis?'not-allowed':'pointer',display:'flex',alignItems:'center',justifyContent:'center',gap:6,opacity:dis?.75:1}},h(Ico,{name:props.icon,size:15,color:dis?'var(--text3)':'white',sw:2.2}),props.label);
}
