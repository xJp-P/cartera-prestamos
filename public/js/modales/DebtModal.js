// public/js/modales/DebtModal.js — Crear o editar una deuda propia (Mis Deudas).
//
// Extraido de `app.js` en la Etapa 3 (B7) del refactor. Codigo VERBATIM.
//
// El estado global sigue en `App` y baja por PROPS; los callbacks suben igual.
// Sin Context API y sin store.

import { ABtn, Fld, Modal } from '../componentes/base.js';
import { Ico } from '../componentes/iconos.js';
import { showError } from '../core/api.js';
import { fmtNumInput, parseNum } from '../core/format.js';
import { h, useState } from '../core/react.js';
import { _submitGuard, nowStr } from '../core/ui.js';

// ── Modales de Mis Deudas (Bloque 3) ──────────────────────────────────────────
export function DebtModal(props){
  var debt=props.debt; // null = crear, objeto = editar
  var editing=!!debt;
  // Proteccion contable: si ya hay abonos (monto_original > saldo_pendiente) no se permite tocar el monto.
  var lockMonto=editing&&(+debt.monto_original>+debt.saldo_pendiente);
  var onSave=props.onSave,onClose=props.onClose;
  var existingAcreedores=props.existingAcreedores||[];
  var sSug=useState(false); var showSug=sSug[0]; var setShowSug=sSug[1];
  var s0=useState(editing?(debt.titulo||''):''); var titulo=s0[0]; var setTitulo=s0[1];
  var s1=useState(editing?(debt.acreedor||''):''); var acreedor=s1[0]; var setAcreedor=s1[1];
  var s2=useState(editing?String(Math.round(debt.monto_original||0)):''); var monto=s2[0]; var setMonto=s2[1];
  var s3=useState(''); var interes=s3[0]; var setInteres=s3[1];
  var s4=useState(editing?(debt.concepto||''):''); var concepto=s4[0]; var setConcepto=s4[1];
  var s5=useState(editing?((debt.fecha_creacion||'').slice(0,10)||nowStr()):nowStr()); var fecha=s5[0]; var setFecha=s5[1];
  var s6=useState(false); var sending=s6[0]; var setSending=s6[1];   // v1.18.1: guarda anti doble-submit

  function submit(){
    // v1.18.1 — POST /api/debts no es idempotente: un doble clic creaba DOS deudas identicas.
    if(sending) return;
    var tit=titulo.trim();
    var acr=acreedor.trim();
    var m=Math.round(+monto||0);
    if(!tit){showError('Ingresa el titulo de la deuda');return;}
    if(!acr){showError('Ingresa el acreedor');return;}
    if(m<=0){showError('Ingresa un monto original valido');return;}
    // UX: no hay columna de interes en la BD -> concatenamos "Tasa - Descripcion" en concepto.
    // El titulo viaja limpio en su propio campo.
    var conceptoFinal=[interes.trim(),concepto.trim()].filter(Boolean).join(' - ');
    var payload={titulo:tit,acreedor:acr,monto_original:m,concepto:conceptoFinal,fecha_creacion:fecha};
    if(editing) payload.id=debt.id; // -> el handler hace PUT en vez de POST
    _submitGuard(sending,setSending,function(){return onSave(payload);});
  }

  // QA6: sugerencias de acreedores existentes. Oculto si el input esta vacio o si coincide exacto.
  var acrQ=acreedor.trim(), acrQL=acrQ.toLowerCase();
  var acrExact=existingAcreedores.some(function(n){return n.toLowerCase()===acrQL;});
  var acrSugeridos=(acrQ&&!acrExact)?existingAcreedores.filter(function(n){return n.toLowerCase().indexOf(acrQL)!==-1;}).slice(0,6):[];
  var acrOpen=showSug&&acrSugeridos.length>0;

  return h(Modal,{onClose:onClose},
    h('div',{style:{fontWeight:700,fontSize:16,color:'var(--text)'}},editing?'Editar Deuda':'Nueva Deuda'),
    h('div',{style:{fontSize:12,color:'var(--text3)'}},editing?'Actualiza los datos de esta deuda.':'Registra una deuda que tienes con un tercero.'),
    h(Fld,{label:'Acreedor *'},
      h('div',{style:{position:'relative'}},
        h('input',{value:acreedor,onChange:function(e){setAcreedor(e.target.value);setShowSug(true);},onFocus:function(){setShowSug(true);},onBlur:function(){setShowSug(false);},placeholder:'A quien le debes',className:'inp',autoFocus:true,autoComplete:'off'}),
        acrOpen?h('div',{style:{position:'absolute',top:'100%',left:0,right:0,zIndex:5,marginTop:4,background:'var(--bg3)',border:'1px solid var(--border)',borderRadius:10,boxShadow:'0 8px 24px rgba(0,0,0,.35)',overflow:'hidden',maxHeight:182,overflowY:'auto'}},
          acrSugeridos.map(function(n){
            return h('div',{key:n,onMouseDown:function(e){e.preventDefault();setAcreedor(n);setShowSug(false);},onMouseEnter:function(e){e.currentTarget.style.background='var(--bg4)';},onMouseLeave:function(e){e.currentTarget.style.background='transparent';},style:{padding:'9px 12px',cursor:'pointer',fontSize:13,color:'var(--text)',display:'flex',alignItems:'center',gap:8,transition:'background .12s'}},
              h(Ico,{name:'users',size:13,color:'var(--text3)'}),n);
          })):null)),
    h(Fld,{label:'Titulo *'},h('input',{value:titulo,onChange:function(e){setTitulo(e.target.value);},placeholder:'Ej: Tarjeta Visa, Prestamo carro',className:'inp'})),
    h(Fld,{label:'Monto original (COP) *'},
      h('input',{type:'text',inputMode:'numeric',value:fmtNumInput(monto),onChange:function(e){if(!lockMonto)setMonto(parseNum(e.target.value));},placeholder:'0',className:'inp',disabled:lockMonto,style:lockMonto?{background:'var(--bg3)',color:'var(--text3)',cursor:'not-allowed'}:{}}),
      lockMonto?h('div',{style:{fontSize:11,color:'var(--text3)',marginTop:4}},'No se puede modificar el monto porque ya existen abonos registrados.'):null),
    h(Fld,{label:'Fecha de inicio'},h('input',{type:'date',value:fecha,onChange:function(e){setFecha(e.target.value);},className:'inp'})),
    h(Fld,{label:'Interes / Tasa pactada (opcional)'},h('input',{value:interes,onChange:function(e){setInteres(e.target.value);},placeholder:editing?'Se antepone a la descripcion':'Ej: 5% mensual',className:'inp'})),
    h(Fld,{label:'Descripcion (opcional)'},h('textarea',{value:concepto,onChange:function(e){setConcepto(e.target.value);},placeholder:'Ej: Pago de tarjeta, cubrir intereses',className:'inp',rows:2,style:{resize:'vertical',minHeight:58,fontFamily:'inherit'}})),
    (interes.trim()&&concepto.trim())?h('div',{style:{fontSize:11,color:'var(--text3)',fontStyle:'italic'}},'Se guardara como: "'+[interes.trim(),concepto.trim()].filter(Boolean).join(' - ')+'"'):null,
    (editing&&!lockMonto)?h('div',{style:{fontSize:11,color:'var(--text3)'}},'El saldo pendiente se recalcula automaticamente (monto - lo ya pagado).'):null,
    h('div',{style:{display:'flex',gap:8,marginTop:8}},
      h(ABtn,{color:'var(--green2)',disabled:sending,onClick:submit,icon:'check',label:sending?'Guardando...':(editing?'Guardar cambios':'Crear deuda')})));
}
