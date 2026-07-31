// public/js/modales/DebtHistoryModal.js — Estado de cuenta de una deuda propia.
//
// Extraido de `app.js` en la Etapa 3 (B7) del refactor. Codigo VERBATIM.
//
// El estado global sigue en `App` y baja por PROPS; los callbacks suben igual.
// Sin Context API y sin store.

import { Modal } from '../componentes/base.js';
import { Ico } from '../componentes/iconos.js';
import { API } from '../core/api.js';
import { fmt, fmtD } from '../core/format.js';
import { h, useEffect, useState } from '../core/react.js';
import { properCase } from '../core/ui.js';

// Historial de pagos de una deuda. Consume GET /api/debts/:id (incluye su ledger pagos_deudas).
export function DebtHistoryModal(props){
  var debt=props.debt,onClose=props.onClose;
  var s1=useState(null); var data=s1[0]; var setData=s1[1];
  var s2=useState(true); var loading=s2[0]; var setLoading=s2[1];
  useEffect(function(){
    var alive=true;
    API.get('/api/debts/'+debt.id).then(function(r){ if(!alive) return; setData(r||null); setLoading(false); });
    return function(){ alive=false; };
  },[debt.id]);
  var pagos=(data&&data.pagos)||[];
  var saldo=data?data.saldo_pendiente:debt.saldo_pendiente;
  var totAbonos=pagos.reduce(function(s,p){return s+(p.tipo==='cargo'?0:(+p.monto_pagado||0));},0);
  var totCargos=pagos.reduce(function(s,p){return s+(p.tipo==='cargo'?(+p.monto_pagado||0):0);},0);
  function fila(label,value,color){
    return h('div',{style:{display:'flex',justifyContent:'space-between',marginTop:3,fontSize:12}},
      h('span',{style:{color:'var(--text3)'}},label),
      h('span',{className:'mono',style:{color:color,fontWeight:700}},value));
  }

  return h(Modal,{onClose:onClose,tall:true},
    h('div',{style:{fontWeight:700,fontSize:16,color:'var(--text)'}},'Estado de cuenta'),
    h('div',{style:{background:'var(--bg3)',borderRadius:12,padding:'12px 14px',border:'1px solid var(--border)'}},
      h('div',{style:{fontWeight:700,color:'var(--text)'}},properCase(debt.acreedor)),
      (debt.titulo||debt.concepto)?h('div',{style:{fontSize:12,color:'var(--text3)',marginTop:2}},debt.titulo||debt.concepto):null,
      h('div',{style:{height:1,background:'var(--border)',margin:'8px 0'}}),
      fila('Abonos','− '+fmt(totAbonos),'var(--green)'),
      (totCargos>0)?fila('Cargos','+ '+fmt(totCargos),'var(--red)'):null,
      fila('Saldo pendiente',fmt(saldo),(saldo||0)>0?'var(--yellow)':'var(--green)')),
    loading?
      h('div',{style:{textAlign:'center',padding:24,color:'var(--text3)',fontSize:13}},'Cargando...')
    : pagos.length===0?
      h('div',{style:{textAlign:'center',padding:24,color:'var(--text3)'}},
        h(Ico,{name:'clipboard',size:28,color:'var(--text3)'}),
        h('p',{style:{marginTop:10,fontSize:13}},'Aun no hay movimientos registrados'))
    :
      h('div',{style:{display:'flex',flexDirection:'column',gap:8}},
        h('div',{style:{fontSize:11,fontWeight:700,color:'var(--text3)',textTransform:'uppercase',letterSpacing:'.5px'}},pagos.length+' movimiento'+(pagos.length===1?'':'s')),
        pagos.map(function(p){
          var esCargo=p.tipo==='cargo';
          var color=esCargo?'var(--red)':'var(--green)';
          return h('div',{key:p.id,style:{background:'var(--bg3)',border:'1px solid var(--border)',borderLeft:'3px solid '+color,borderRadius:10,padding:'10px 12px',display:'flex',justifyContent:'space-between',alignItems:'flex-start',gap:10}},
            h('div',{style:{minWidth:0}},
              h('div',{style:{display:'flex',alignItems:'center',gap:8,marginBottom:2}},
                h('span',{style:{fontSize:10,fontWeight:700,color:color,background:color+'20',padding:'2px 7px',borderRadius:99,textTransform:'uppercase',letterSpacing:'.5px'}},esCargo?'Cargo':'Abono'),
                h('span',{style:{fontSize:13,color:'var(--text)',fontWeight:600}},fmtD((p.fecha_pago||'').slice(0,10)))),
              p.notas?h('div',{style:{fontSize:12,color:'var(--text3)'}},p.notas):null),
            h('div',{className:'mono',style:{fontSize:14,fontWeight:700,color:color,whiteSpace:'nowrap'}},(esCargo?'+ ':'− ')+fmt(p.monto_pagado)));
        })));
}
