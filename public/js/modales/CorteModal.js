// public/js/modales/CorteModal.js — registrar un CORTE de un credito de interes diario.
//
// El corte es el UNICO evento economico de un credito abierto: el cliente paga los
// intereses devengados, abona a capital, o ambas cosas en el mismo movimiento.
// Sustituye a `AbonoModal` y a `PayModal` para esta modalidad — de hecho `/abono`
// la rechaza, porque crearia una fila que el motor del devengo no mira.
//
// Las validaciones son ESPEJO de las del backend (`POST /api/loans/:id/corte`).
// No es redundancia: el backend es la autoridad y rechaza igual, pero apagar el
// boton y explicar por que ANTES de enviar evita que el usuario descubra el limite
// con un mensaje de error. Defense-in-depth, convencion #4.
//
// El calculo del devengo NO se replica aqui: sale de `estadoDiario`, el mismo
// espejo del motor que usa el resto del frontend y que la suite verifica contra la
// implementacion del backend.

import { Fld, Modal } from '../componentes/base.js';
import { Ico } from '../componentes/iconos.js';
import { estadoDiario } from '../core/dominio.js';
import { copToUsd, fmt, fmtNumInput, parseNum } from '../core/format.js';
import { h, useState } from '../core/react.js';
import { _submitGuard, nowStr } from '../core/ui.js';

export function CorteModal(props){
  var loan=props.loan, allPays=props.pays||[], onSave=props.onSave, onClose=props.onClose;
  var esUSD=loan.moneda==='USD';
  var hoy=nowStr();
  var s1=useState(hoy);  var fecha=s1[0];   var setFecha=s1[1];
  var s2=useState('');   var interes=s2[0]; var setInteres=s2[1];
  var s3=useState('');   var abono=s3[0];   var setAbono=s3[1];
  var s4=useState('');   var obs=s4[0];     var setObs=s4[1];
  var s5=useState(false);var sending=s5[0]; var setSending=s5[1];
  // Se marca cuando el usuario toca el campo de interes: hasta entonces se ofrece el
  // devengo completo, que es lo que se cobra en el 95% de los casos.
  var s6=useState(false);var intTocado=s6[0];var setIntTocado=s6[1];

  // Estado del credito A LA FECHA ELEGIDA (no a hoy): si el usuario registra un corte
  // con fecha de ayer, el interes devengado es el de ayer, no el de hoy.
  var dev=estadoDiario(loan, allPays, fecha);
  var cortes=(allPays||[]).filter(function(p){return String(p.prestamoId)===String(loan.id)&&String(p.id).indexOf('-ct-')!==-1;});
  var ultimaFecha=cortes.length?cortes.map(function(c){return c.fechaPago;}).sort().pop():loan.fechaInicio;

  var intNum=Math.round(parseNum(interes)||0);
  var abnNum=Math.round(parseNum(abono)||0);
  // Propuesta por defecto: cobrar todo el interes devengado.
  var intEfectivo=intTocado?intNum:dev.interesPendiente;
  var total=intEfectivo+abnNum;

  var capitalDespues=Math.max(0,dev.capitalVivo-abnNum);
  var interesDespues=Math.max(0,dev.interesPendiente-intEfectivo);
  var saldaCredito=capitalDespues===0&&interesDespues===0;
  var interesDia=Math.round(dev.capitalVivo*(+loan.tasaMensual||0)/100/30);

  // ── Validaciones, espejo exacto del backend ────────────────────────────────
  var err='';
  if(fecha>hoy) err='No se puede registrar un corte con fecha futura: devengaria intereses aun no causados.';
  else if(fecha<loan.fechaInicio) err='El corte no puede ser anterior al inicio del credito ('+loan.fechaInicio+').';
  else if(fecha<ultimaFecha) err='El corte no puede ser anterior al ultimo registrado ('+ultimaFecha+').';
  else if(intEfectivo<0||abnNum<0) err='Los montos no pueden ser negativos.';
  else if(intEfectivo===0&&abnNum===0) err='El corte debe registrar algo: intereses, abono a capital, o ambos.';
  else if(intEfectivo>dev.interesPendiente) err='El interes cobrado supera el devengado a esa fecha ('+fmt(dev.interesPendiente)+').';
  else if(abnNum>dev.capitalVivo) err='El abono supera el capital vivo ('+fmt(dev.capitalVivo)+').';
  var btnOff=!!err||sending;

  function submit(){
    _submitGuard(sending,setSending,function(){
      return onSave(loan.id,{
        fecha: fecha,
        interesPagado: intEfectivo,
        abonoCapital: abnNum,
        observaciones: obs,
      });
    });
  }

  var fila=function(k,v,color,sub){
    return h('div',{style:{display:'flex',justifyContent:'space-between',alignItems:'flex-start',padding:'5px 0',fontSize:12}},
      h('div',null,
        h('span',{style:{color:'var(--text2)'}},k),
        sub&&h('div',{style:{fontSize:10,color:'var(--text3)',marginTop:1}},sub)),
      h('div',{style:{textAlign:'right'}},
        h('div',{className:'mono',style:{color:color||'var(--text)',fontWeight:600}},fmt(v)),
        esUSD&&h('div',{className:'mono',style:{fontSize:10,color:'var(--blue)'}},copToUsd(v,loan.trmAcordada))));
  };

  return h(Modal,{onClose:onClose,title:'Registrar corte'},
    h('div',{style:{fontSize:12,color:'var(--text2)',marginBottom:4}},loan.nombre),

    // ── Estado del credito a la fecha elegida ────────────────────────────────
    h('div',{style:{background:'var(--bg3)',borderRadius:12,padding:'10px 12px',marginBottom:12}},
      h('div',{style:{fontSize:11,fontWeight:700,color:'var(--text3)',marginBottom:6,letterSpacing:'.03em'}},'ESTADO AL '+fecha),
      fila('Capital vivo',dev.capitalVivo),
      h('div',{style:{borderTop:'1px solid var(--border)',margin:'4px 0'}}),
      fila('Interes devengado por cobrar',dev.interesPendiente,'var(--blue)',
        dev.diasDesdeUltimoCorte+' dia(s) x '+fmt(interesDia)+'/dia · ultimo corte '+(cortes.length?ultimaFecha:'sin cortes'))),

    h(Fld,{label:'Fecha del corte'},
      h('input',{type:'date',value:fecha,max:hoy,min:loan.fechaInicio,onChange:function(e){setFecha(e.target.value);},className:'inp'})),

    h(Fld,{label:'Intereses que cobras'},
      h('input',{type:'text',inputMode:'numeric',
        value:intTocado?fmtNumInput(interes):String(dev.interesPendiente),
        onChange:function(e){setIntTocado(true);setInteres(parseNum(e.target.value));},
        className:'inp'}),
      h('div',{style:{fontSize:11,marginTop:4,color:'var(--text3)'}},
        intTocado&&intEfectivo<dev.interesPendiente
          ? 'Quedaran '+fmt(dev.interesPendiente-intEfectivo)+' de interes sin cobrar (no se capitaliza: seguira devengando sobre el capital).'
          : 'Por defecto se cobra todo el interes devengado.')),

    h(Fld,{label:'Abono a capital'},
      h('input',{type:'text',inputMode:'numeric',value:fmtNumInput(abono),
        onChange:function(e){setAbono(parseNum(e.target.value));},placeholder:'0',className:'inp'}),
      h('div',{style:{fontSize:11,marginTop:4,color:'var(--text3)'}},
        'Reduce la base del interes desde este mismo dia. Maximo '+fmt(dev.capitalVivo)+'.')),

    // ── Lo que quedara tras el corte ─────────────────────────────────────────
    total>0&&!err&&h('div',{style:{background:'var(--green-bg)',border:'1px solid var(--green-bd)',borderRadius:12,padding:'10px 12px',margin:'12px 0'}},
      h('div',{style:{fontSize:11,fontWeight:700,color:'var(--green)',marginBottom:6,letterSpacing:'.03em'}},'DESPUES DEL CORTE'),
      fila('Total que recibes',total,'var(--green)'),
      h('div',{style:{borderTop:'1px solid var(--green-bd)',margin:'4px 0'}},null),
      fila('Capital vivo',capitalDespues),
      fila('Interes por cobrar',interesDespues,interesDespues>0?'var(--yellow)':'var(--text3)'),
      abnNum>0&&capitalDespues>0&&h('div',{style:{fontSize:11,color:'var(--text3)',marginTop:6}},
        'A partir de hoy devengara '+fmt(Math.round(capitalDespues*(+loan.tasaMensual||0)/100/30))+' por dia (antes '+fmt(interesDia)+').'),
      saldaCredito&&h('div',{style:{fontSize:12,color:'var(--green)',fontWeight:700,marginTop:8,display:'flex',alignItems:'center',gap:6}},
        h(Ico,{name:'check',size:14,color:'var(--green)'}),'El credito quedara SALDADO y pasara a Finalizado.')),

    err&&h('div',{style:{background:'var(--red-bg)',border:'1px solid var(--red-bd)',borderRadius:10,padding:'9px 11px',margin:'12px 0',fontSize:11.5,color:'var(--red)',lineHeight:1.45}},err),

    h(Fld,{label:'Observaciones'},
      h('input',{value:obs,onChange:function(e){setObs(e.target.value);},placeholder:'Notas opcionales...',className:'inp'})),

    h('button',{onClick:submit,disabled:btnOff,className:'btn-primary',
      style:{marginTop:8,background:btnOff?'var(--bg3)':'var(--green-bg)',border:'1px solid '+(btnOff?'var(--border)':'var(--green)'),color:btnOff?'var(--text3)':'var(--green)',cursor:btnOff?'not-allowed':'pointer'}},
      sending?'Registrando...':'Registrar corte'));
}
