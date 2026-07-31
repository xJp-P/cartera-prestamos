// public/js/modales/RestructureModal.js — Reestructurar el cronograma futuro sin abono.
//
// Extraido de `app.js` en la Etapa 3 (B7) del refactor. Codigo VERBATIM.
//
// El estado global sigue en `App` y baja por PROPS; los callbacks suben igual.
// Sin Context API y sin store.

import { Modal } from '../componentes/base.js';
import { Ico } from '../componentes/iconos.js';
import { showError } from '../core/api.js';
import { _nper, _pmt, _tasaPeriodo } from '../core/calculo.js';
import {
  copToUsd, fmt, fmtN, fmtNumInput, parseDecimalInput, parseIntInput, parseNum,
} from '../core/format.js';
import { h, useState } from '../core/react.js';
import { _submitGuard } from '../core/ui.js';

// ── RestructureModal (v1.9.0) ─────────────────────────────────────────────────
// Permite reestructurar el cronograma de cuotas FUTURAS sin necesidad de hacer un
// abono a capital. Solo aplica para modalidad Capital + Intereses. Cuotas Pagadas
// y En Mora NO se tocan (deuda independiente). Reusa la logica de _pmt/_nper y los
// patrones visuales de AbonoModal.
export function RestructureModal(props){
  var loan=props.loan,allPays=props.pays||[],onSave=props.onSave,onClose=props.onClose;
  var esUSD=loan.moneda==='USD';
  var sm=useState('modificarPlazo'); var recalcMode=sm[0]; var setRecalcMode=sm[1];
  var sp=useState(''); var nuevoPlazo=sp[0]; var setNuevoPlazo=sp[1];
  var sc=useState(''); var nuevaCuotaFija=sc[0]; var setNuevaCuotaFija=sc[1];
  var scu=useState(''); var nuevaCuotaFijaUSD=scu[0]; var setNuevaCuotaFijaUSD=scu[1];
  var sub=useState(false); var isSubmitting=sub[0]; var setIsSubmitting=sub[1];
  // Cuota fija efectiva en COP (auto-convertida de USD cuando aplica)
  var cuotaFijaEfectivaCOP=esUSD?Math.round((+nuevaCuotaFijaUSD||0)*(+loan.trmAcordada||1)):(+nuevaCuotaFija||0);
  // Saldo real (sin abono, no se toca el capital)
  var originalCOP=esUSD?Math.round(loan.montoOrigen*loan.trmAcordada):Math.round(loan.montoOrigen);
  var loanPays=allPays.filter(function(p){return String(p.prestamoId)===String(loan.id);});
  var todoCapPagado=loanPays.filter(function(p){return p.estadoPago==='Pagado';}).reduce(function(s,p){return s+p.abonoCapital;},0);
  var saldoActual=Math.max(0,originalCOP-todoCapPagado);
  var intMora=loanPays.filter(function(p){return p.estadoPago==='En Mora'&&p.id.indexOf('-ab-')===-1;}).reduce(function(s,p){return s+p.interesPeriodo;},0);
  // Cuotas consumidas (Pagado + Mora, excluyendo abonos) — define el nextRegularN
  var regulares=loanPays.filter(function(p){return p.id.indexOf('-ab-')===-1;});
  var regularConsumed=regulares.filter(function(p){return p.estadoPago==='Pagado'||p.estadoPago==='En Mora';}).length;
  var plazoOriginal=+loan.plazoMeses||12;
  var cuotasRestantesActuales=Math.max(1,plazoOriginal-regularConsumed);
  // Preview en vivo
  var preview=function(){
    if(saldoActual<=0) return null;
    var r=_tasaPeriodo((+loan.tasaMensual||0)/100,loan.frecuencia||'Mensual');
    var interesPrimerPeriodo=Math.round(saldoActual*r);
    if(recalcMode==='modificarPlazo'){
      var nN=parseInt(nuevoPlazo,10);
      if(!nN||nN<1) return {modo:'modificarPlazo',cuota:0,nCuotas:0,interesP:interesPrimerPeriodo,error:'Ingresa un numero de cuotas valido (>= 1).',ultimaResidual:0};
      var pmtMod=Math.round(_pmt(r,nN,saldoActual));
      return {modo:'modificarPlazo',cuota:pmtMod,nCuotas:nN,interesP:interesPrimerPeriodo,error:null,ultimaResidual:0};
    }
    if(recalcMode==='fijarCuota'){
      var pmtFijo=cuotaFijaEfectivaCOP;
      if(pmtFijo<=0) return {modo:'fijarCuota',cuota:0,nCuotas:0,interesP:interesPrimerPeriodo,error:'Ingresa una cuota valida (> 0).',ultimaResidual:0};
      if(pmtFijo<=interesPrimerPeriodo) return {modo:'fijarCuota',cuota:pmtFijo,nCuotas:0,interesP:interesPrimerPeriodo,error:'La cuota debe ser mayor a '+fmt(interesPrimerPeriodo)+(esUSD?' ('+copToUsd(interesPrimerPeriodo,loan.trmAcordada)+')':'')+' que son los intereses del primer periodo. Con esta cuota nunca se saldaria la deuda.',ultimaResidual:0};
      var nCalc=_nper(r,pmtFijo,saldoActual);
      var nEnt=Math.ceil(nCalc);
      var sR=saldoActual,resid=0;
      for(var i=0;i<nEnt-1;i++){var intI=sR*r;var capI=pmtFijo-intI;sR=sR-capI;}
      if(sR>0){resid=Math.round((sR+sR*r)*100)/100;}
      return {modo:'fijarCuota',cuota:pmtFijo,nCuotas:nEnt,interesP:interesPrimerPeriodo,error:null,ultimaResidual:resid};
    }
    return null;
  }();
  function submit(){
    if(isSubmitting) return;
    if(saldoActual<=0){showError('El prestamo no tiene saldo pendiente');return;}
    if(preview&&preview.error){showError(preview.error);return;}
    var valor=null;
    if(recalcMode==='modificarPlazo') valor=parseInt(nuevoPlazo,10);
    else if(recalcMode==='fijarCuota') valor=cuotaFijaEfectivaCOP;
    if(!valor||valor<=0){showError('Completa el valor');return;}
    // v1.18.1 — la liberacion se ata a la PROMESA, no a un setTimeout de 5s. El timer era
    // una guarda con fecha de caducidad: si el POST tardaba mas de 5 segundos el boton se
    // rehabilitaba con la peticion aun en vuelo y el doble submit volvia a ser posible.
    // Si onSave devuelve undefined (rama de pre-flight de mora) se libera de inmediato,
    // porque el control pasa al PreflightMoraModal y este modal ya no decide nada.
    _submitGuard(isSubmitting,setIsSubmitting,function(){return onSave(loan.id,recalcMode,valor);});
  }
  return h(Modal,{onClose:onClose},
    h('div',{style:{fontWeight:700,fontSize:16,color:'var(--text)',marginBottom:4,display:'flex',alignItems:'center',gap:8}},
      h(Ico,{name:'calc',size:18,color:'var(--blue)'}),' Reestructurar cuotas'),
    h('div',{style:{background:'var(--bg3)',borderRadius:12,padding:'13px 14px',marginBottom:14,border:'1px solid var(--border)'}},
      h('div',{style:{fontWeight:700,fontSize:14,color:'var(--text)'}},loan.nombre),
      h('div',{style:{fontSize:12,color:'var(--text2)',marginTop:3}},loan.modalidad),
      h('div',{className:'mono',style:{fontWeight:700,fontSize:18,color:'var(--green)',marginTop:6}},'Saldo de capital: '+fmt(saldoActual),
        esUSD&&h('span',{style:{fontSize:13,fontWeight:600,color:'var(--blue)',marginLeft:8}},copToUsd(saldoActual,loan.trmAcordada))),
      intMora>0&&h('div',{className:'mono',style:{fontSize:11,color:'var(--yellow)',marginTop:4}},'Intereses en mora (no se tocan): '+fmt(intMora))),
    // Info box
    h('div',{style:{background:'rgba(88,166,255,.06)',border:'1px solid var(--blue-bd)',borderRadius:12,padding:'10px 12px',marginBottom:12}},
      h('div',{style:{fontSize:10,fontWeight:700,color:'var(--blue)',letterSpacing:.5,marginBottom:6,display:'flex',alignItems:'center',gap:5}},
        h(Ico,{name:'alert',size:11,color:'var(--blue)',sw:2.4}),'COMO FUNCIONA'),
      h('div',{style:{fontSize:11,color:'var(--text2)',lineHeight:1.5}},
        '• Solo se recalculan las cuotas ',h('b',null,'Pendientes'),' (futuras).',h('br',null),
        '• Las cuotas ',h('b',null,'Pagadas y En Mora'),' quedan intactas como deuda independiente.',h('br',null),
        '• El saldo de capital pendiente ',h('b',null,'no cambia'),' (no hay abono).')),
    // Radios
    h('div',{style:{background:'rgba(88,166,255,.04)',border:'1px solid var(--blue-bd)',borderRadius:12,padding:'12px',marginBottom:12}},
      h('div',{style:{fontSize:10,fontWeight:700,color:'var(--blue)',letterSpacing:.5,marginBottom:8,display:'flex',alignItems:'center',gap:5}},
        h(Ico,{name:'calc',size:11,color:'var(--blue)'}),' OPCIONES'),
      h('label',{style:{display:'flex',alignItems:'flex-start',gap:8,padding:'6px 0',cursor:'pointer'}},
        h('input',{type:'radio',name:'reestrMode',value:'modificarPlazo',checked:recalcMode==='modificarPlazo',onChange:function(){setRecalcMode('modificarPlazo');},style:{marginTop:2,accentColor:'var(--blue)',cursor:'pointer'}}),
        h('div',{style:{flex:1}},
          h('div',{style:{fontSize:12,color:'var(--text)',fontWeight:500}},'Modificar plazo'),
          h('div',{style:{fontSize:10,color:'var(--text3)',marginTop:1}},'Tu eliges el nuevo numero de cuotas restantes (actual: '+cuotasRestantesActuales+').'),
          recalcMode==='modificarPlazo'&&h('input',{type:'text',inputMode:'numeric',value:nuevoPlazo,onChange:function(e){setNuevoPlazo(parseIntInput(e.target.value));},placeholder:'Ej: '+cuotasRestantesActuales,className:'inp',style:{marginTop:6,fontSize:13,border:'1px solid var(--blue)'}}))),
      h('label',{style:{display:'flex',alignItems:'flex-start',gap:8,padding:'6px 0',cursor:'pointer'}},
        h('input',{type:'radio',name:'reestrMode',value:'fijarCuota',checked:recalcMode==='fijarCuota',onChange:function(){setRecalcMode('fijarCuota');},style:{marginTop:2,accentColor:'var(--blue)',cursor:'pointer'}}),
        h('div',{style:{flex:1}},
          h('div',{style:{fontSize:12,color:'var(--text)',fontWeight:500}},'Fijar valor de cuota'),
          h('div',{style:{fontSize:10,color:'var(--text3)',marginTop:1}},'Tu eliges cuanto pagar de cuota; el plazo se ajusta.'),
          recalcMode==='fijarCuota'&&(esUSD
            ?h('div',{style:{marginTop:6}},
                h('input',{type:'text',inputMode:'decimal',value:nuevaCuotaFijaUSD,onChange:function(e){setNuevaCuotaFijaUSD(parseDecimalInput(e.target.value));},placeholder:'Cuota en USD (ej: 50.00)',className:'inp',style:{fontSize:13,border:'1px solid var(--blue)'}}),
                (+nuevaCuotaFijaUSD)>0&&h('div',{style:{fontSize:11,marginTop:4,color:'var(--text3)',fontFamily:'monospace'}},'Equivale a '+fmt(cuotaFijaEfectivaCOP)+' COP (TRM $'+fmtN(loan.trmAcordada)+')'))
            :h('input',{type:'text',inputMode:'numeric',value:fmtNumInput(nuevaCuotaFija),onChange:function(e){setNuevaCuotaFija(parseNum(e.target.value));},placeholder:'Cuota en COP',className:'inp',style:{marginTop:6,fontSize:13,border:'1px solid var(--blue)'}})))),
      // PREVIEW
      preview&&h('div',{style:{marginTop:10,paddingTop:10,borderTop:'1px solid var(--bg2)'}},
        preview.error?h('div',{style:{background:'var(--red-bg)',border:'1px solid var(--red-bd)',borderRadius:8,padding:'8px 10px',fontSize:11,color:'var(--red)',display:'flex',alignItems:'flex-start',gap:6}},
          h(Ico,{name:'alert',size:12,color:'var(--red)',sw:2.4}),
          h('span',null,preview.error)):
        h('div',null,
          h('div',{style:{fontSize:10,color:'var(--text3)',fontWeight:600,letterSpacing:.5,marginBottom:6}},'PREVIEW'),
          h('div',{style:{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'5px 0',fontSize:12,borderTop:'1px solid var(--bg3)'}},
            h('span',{style:{color:'var(--text2)'}},'Saldo de capital (no cambia)'),
            h('div',{style:{textAlign:'right'}},
              h('div',{className:'mono',style:{color:'var(--text)',fontWeight:500}},fmt(saldoActual)),
              esUSD&&h('div',{className:'mono',style:{fontSize:10,color:'var(--blue)'}},copToUsd(saldoActual,loan.trmAcordada)))),
          h('div',{style:{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'5px 0',fontSize:12,borderTop:'1px solid var(--bg3)'}},
            h('span',{style:{color:'var(--text2)'}},'Nueva cuota'),
            h('div',{style:{textAlign:'right'}},
              h('div',{className:'mono',style:{color:'var(--green)',fontWeight:500}},fmt(preview.cuota)),
              esUSD&&h('div',{className:'mono',style:{fontSize:10,color:'var(--blue)'}},copToUsd(preview.cuota,loan.trmAcordada)))),
          h('div',{style:{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'5px 0',fontSize:12,borderTop:'1px solid var(--bg3)'}},
            h('span',{style:{color:'var(--text2)'}},'Cuotas restantes'),
            h('span',{style:{color:'var(--text)',fontWeight:500}},preview.nCuotas)),
          preview.ultimaResidual>0&&preview.ultimaResidual<preview.cuota&&h('div',{style:{display:'flex',justifyContent:'space-between',alignItems:'flex-start',padding:'5px 0',fontSize:12,borderTop:'1px solid var(--bg3)'}},
            h('div',null,
              h('div',{style:{color:'var(--text2)'}},'Ultima cuota (ajuste)'),
              h('div',{style:{fontSize:10,color:'var(--text3)',marginTop:1}},'Saldo residual exacto')),
            h('div',{style:{textAlign:'right'}},
              h('div',{className:'mono',style:{color:'var(--yellow)',fontWeight:500}},fmt(preview.ultimaResidual)),
              esUSD&&h('div',{className:'mono',style:{fontSize:10,color:'var(--blue)'}},copToUsd(preview.ultimaResidual,loan.trmAcordada))))))),
    h('button',{onClick:submit,disabled:isSubmitting||(preview&&!!preview.error),className:'btn-primary',style:{marginTop:8,opacity:isSubmitting?.6:1,background:(preview&&preview.error)?'var(--bg3)':'var(--blue-bg)',border:'1px solid '+((preview&&preview.error)?'var(--border)':'var(--blue)'),color:(preview&&preview.error)?'var(--text3)':'var(--blue)',cursor:(isSubmitting||(preview&&preview.error))?'not-allowed':'pointer'}},isSubmitting?'Reestructurando...':'Aplicar reestructuracion'));
}
