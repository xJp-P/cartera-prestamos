// public/js/modales/ConfirmUndoModal.js — Confirmacion de Deshacer, con los candados C (tiempo) y D (caja).
//
// Extraido de `app.js` en la Etapa 3 (B7) del refactor. Codigo VERBATIM.
//
// El estado global sigue en `App` y baja por PROPS; los callbacks suben igual.
// Sin Context API y sin store.

import { Modal } from '../componentes/base.js';
import { Ico } from '../componentes/iconos.js';
import { h, useState } from '../core/react.js';
import { _submitGuard } from '../core/ui.js';

// ── ConfirmUndoModal (v2.1 — "La Bestia" Fase 2) ──────────────────────────────
// Confirmacion de deshacer. NUNCA se revierte con un solo clic: deshacer una operacion
// financiera puede contradecir un documento que el deudor ya tiene en la mano, asi que el
// usuario debe ver QUE se va a revertir y con que riesgos antes de decidir.
// Candado C (tiempo): advierte si la operacion tiene mas de 24 h. No BLOQUEA — el Candado A
//   (LIFO) ya garantiza que nada se construyo encima, y un error se detecta igual al dia
//   siguiente; poner un limite duro seria friccion sin seguridad real.
// Candado D (recibo): si la operacion movio caja (afecta_caja, declarado por el backend en el
//   journal), avisa que probablemente exista un recibo PDF en manos del cliente.
export function ConfirmUndoModal(props){
  var e=props.entry||{};
  var onConfirm=props.onConfirm,onClose=props.onClose;
  var sS=useState(false); var sending=sS[0]; var setSending=sS[1];   // guarda anti doble-submit

  // created_at viene como 'YYYY-MM-DD HH:MM:SS' en hora LOCAL (datetime('now','localtime')).
  var creada=e.created_at?new Date(String(e.created_at).replace(' ','T')):null;
  var horas=creada?Math.floor((Date.now()-creada.getTime())/36e5):0;
  var esVieja=horas>=24;
  var antiguedad=!creada?'':(horas<1?'hace menos de una hora':(horas<24?'hace '+horas+' hora'+(horas!==1?'s':''):'hace '+Math.floor(horas/24)+' dia'+(Math.floor(horas/24)!==1?'s':'')));
  var afectaCaja=!!(+e.afecta_caja);
  var esDeuda=e.scope_tipo==='debt';

  function aviso(color,bg,bd,icono,titulo,cuerpo){
    return h('div',{style:{background:bg,border:'1px solid '+bd,borderRadius:10,padding:'10px 12px',marginTop:10,display:'flex',gap:9,alignItems:'flex-start'}},
      h(Ico,{name:icono,size:14,color:color,sw:2.4}),
      h('div',{style:{flex:1,minWidth:0}},
        h('div',{style:{fontSize:11,fontWeight:700,color:color,letterSpacing:'.3px',marginBottom:2}},titulo),
        h('div',{style:{fontSize:11,color:'var(--text2)',lineHeight:1.5}},cuerpo)));
  }

  return h(Modal,{onClose:onClose},
    h('div',{style:{fontWeight:700,fontSize:16,color:'var(--text)',marginBottom:3,display:'flex',alignItems:'center',gap:8}},
      h(Ico,{name:'refresh',size:16,color:'var(--purple)',sw:2.4}),'Deshacer operacion'),
    h('div',{style:{fontSize:12,color:'var(--text3)',marginBottom:13}},'Se restaurara el estado exacto anterior a esta operacion.'),

    // Resumen de lo que se revierte
    h('div',{style:{background:'var(--bg3)',border:'1px solid var(--border)',borderRadius:12,padding:'12px 14px'}},
      h('div',{style:{fontSize:10,fontWeight:700,color:'var(--text3)',letterSpacing:'.5px',marginBottom:6}},'SE VA A REVERTIR'),
      h('div',{style:{fontSize:13,color:'var(--text)',lineHeight:1.5,fontWeight:500}},e.descripcion||'(sin descripcion)'),
      creada&&h('div',{style:{fontSize:11,color:'var(--text3)',marginTop:6,display:'flex',alignItems:'center',gap:5}},
        h(Ico,{name:'clock',size:11,color:'var(--text3)',sw:2.2}),
        String(e.created_at).slice(0,16)+' · '+antiguedad)),

    // ── CANDADO C — antigüedad ──
    esVieja&&aviso('var(--yellow)','var(--yellow-bg)','var(--yellow)','alert','OPERACION ANTIGUA',
      'Se registro '+antiguedad+'. Revisa que no hayas construido nada sobre ella (reportes enviados, cierres de caja o conciliaciones ya hechas).'),

    // ── CANDADO D — recibo probablemente entregado ──
    afectaCaja&&aviso('var(--red)','var(--red-bg)','var(--red-bd)','receipt','DINERO YA REGISTRADO',
      esDeuda
        ? 'Este movimiento registro dinero real. Al revertirlo, el saldo de la deuda volvera a su valor anterior: confirma que el pago efectivamente no ocurrio.'
        : 'Es probable que el cliente YA tenga en sus manos un recibo PDF con esta informacion. Si lo deshaces, tu sistema dejara de coincidir con ese documento. Asegurate de acordarlo con el deudor.'),

    // Nota permanente: el historial es append-only
    h('div',{style:{fontSize:11,color:'var(--text3)',lineHeight:1.5,marginTop:12}},
      'La operacion quedara marcada como revertida en el historial. El registro NO se borra: queda la huella de que ocurrio y de que se deshizo.'),

    h('div',{style:{display:'flex',gap:10,marginTop:16}},
      h('button',{onClick:function(){_submitGuard(sending,setSending,function(){return onConfirm(e);});},disabled:sending,
        style:{flex:1,background:sending?'var(--bg3)':'var(--purple-bg)',color:sending?'var(--text3)':'var(--purple)',
          border:'1px solid '+(sending?'var(--border)':'var(--purple)'),borderRadius:10,padding:'11px 0',fontSize:13,fontWeight:700,
          cursor:sending?'not-allowed':'pointer',fontFamily:'inherit'}},sending?'Deshaciendo...':'Si, deshacer'),
      h('button',{onClick:onClose,style:{flex:1,background:'var(--bg3)',color:'var(--text2)',border:'1px solid var(--border)',borderRadius:10,padding:'11px 0',fontSize:13,fontWeight:700,cursor:'pointer',fontFamily:'inherit'}},'Cancelar')));
}
