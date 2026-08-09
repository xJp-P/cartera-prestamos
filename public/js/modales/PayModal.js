// public/js/modales/PayModal.js — Registrar un pago (completo o parcial) sobre una cuota.
//
// Extraido de `app.js` en la Etapa 3 (B7) del refactor. Codigo VERBATIM.
//
// El estado global sigue en `App` y baja por PROPS; los callbacks suben igual.
// Sin Context API y sin store.

import { ABtn, Fld, Modal } from '../componentes/base.js';
import { ST } from '../componentes/iconos.js';
import { showError } from '../core/api.js';
import {
  copToUsd, fmt, fmtD, fmtN, fmtNumInput, parseDecimalInput, parseNum,
} from '../core/format.js';
import { h, useState } from '../core/react.js';
import { _submitGuard, nowStr } from '../core/ui.js';
import { generateRecibo } from '../pdf/recibo-pago.js';
import { esAbono } from '../core/ids.js';

// ── PayModal ──────────────────────────────────────────────────────────────────
export function PayModal(props){
  var pay=props.pay,loan=props.loan,allPays=props.allPays||[],onMark=props.onMark,onPartial=props.onPartial,onClose=props.onClose;
  var yaPagado=+pay.partialPaid||0;
  var restante=Math.max(0,pay.cuotaTotal-yaPagado);
  var s1=useState(nowStr()); var fecha=s1[0]; var setFecha=s1[1];
  var s2=useState(pay.observaciones||''); var obs=s2[0]; var setObs=s2[1];
  var s3=useState(restante||''); var copRec=s3[0]; var setCopRec=s3[1];
  var s4=useState(pay.montoUSDRecibido||''); var usdRec=s4[0]; var setUsdRec=s4[1];
  var s5=useState(false); var genRecibo=s5[0]; var setGenRecibo=s5[1];
  var s6=useState('completo'); var tipoPago=s6[0]; var setTipoPago=s6[1];
  var s7=useState(''); var montoParcial=s7[0]; var setMontoParcial=s7[1];
  var s8=useState(''); var parcialUSD=s8[0]; var setParcialUSD=s8[1];
  var s9=useState(false); var sending=s9[0]; var setSending=s9[1];   // v1.18.1: guarda anti doble-submit
  var so=ST[pay.estadoPago]||{bg:'var(--bg3)',color:'var(--text2)',icon:'?'};
  var esUSD=loan&&loan.moneda==='USD';
  // Abono real = id con '-ab-' (regla canonica). NO usar la heuristica interes===0 && capital>0:
  // la cuota unica de un Prestamo (o un Pago Unico sin ganancia) tambien la cumple y bloqueaba el pago.
  var filaEsAbono=esAbono(pay);
  if(filaEsAbono) return h(Modal,{onClose:onClose},
    h('div',{style:{fontWeight:700,fontSize:16,color:'var(--text)',marginBottom:12}},'Detalle Abono Capital'),
    h('div',{style:{background:'var(--bg3)',borderRadius:12,padding:'14px',border:'1px solid var(--border)'}},
      h('div',{style:{fontWeight:700,color:'var(--text)',marginBottom:4}},pay.nombreCliente),
      h('div',{style:{fontSize:12,color:'var(--text2)',marginBottom:8}},fmtD(pay.fechaRecaudo||pay.fechaPago)),
      h('div',{className:'mono',style:{fontSize:20,fontWeight:700,color:'var(--blue)',marginBottom:4}},'Abono: '+fmt(pay.abonoCapital),
        esUSD&&h('span',{style:{fontSize:13,fontWeight:600,marginLeft:8}},copToUsd(pay.abonoCapital,loan.trmAcordada))),
      h('div',{className:'mono',style:{fontSize:13,color:'var(--text2)'}},'Saldo tras abono: '+fmt(pay.saldoFinal),
        esUSD&&h('span',{style:{marginLeft:6}},copToUsd(pay.saldoFinal,loan.trmAcordada))),
      pay.observaciones&&h('div',{style:{fontSize:11,color:'var(--text3)',marginTop:8,fontStyle:'italic'}},pay.observaciones)));

  // v1.18.1 — GUARDA ANTI DOBLE-SUBMIT (misma doctrina del Bug #29 en AbonoModal). Aqui el
  // riesgo es mayor: PUT /api/payments/:id y POST /partial no son idempotentes, y un pago
  // duplicado contamina montoCOPRecibido, el ledger `recibos` y con ello los KPI de Cobros
  // del Mes y Ganancias. Se libera al resolver la promesa; ante un fallo de API la promesa
  // RESUELVE (API.put/post atrapan el error y devuelven null), nunca rechaza, por eso el
  // release va en el .then y no en un .catch.
  function _run(fn){ _submitGuard(sending,setSending,fn); }
  function submitParcial(){
    if(sending) return;
    var m=+montoParcial||0;
    if(m<=0){showError('Ingresa el monto del pago parcial');return;}
    // En un prestamo USD el dolar NO es opcional: es lo que define cuanta DEUDA se extingue
    // (se valua a la TRM pactada). Sin el, el backend cae a los COP de caja y la deuda baja
    // de menos cuando la TRM del dia esta por debajo de la pactada — el cliente entrega los
    // dolares pactados y le queda deuda fantasma. Misma doctrina que AbonoModal (v2.0.0).
    if(esUSD&&(+parcialUSD||0)<=0){showError('Ingresa los USD recibidos: en prestamos en dolares son los que definen cuanta deuda se abona');return;}
    // La obligacion se mide en la MISMA moneda que el restante (ambos a TRM pactada).
    if(esUSD){
      if(Math.round((+parcialUSD||0)*loan.trmAcordada)>restante+1){showError('Los USD ingresados superan el saldo pendiente ('+copToUsd(restante,loan.trmAcordada)+')');return;}
    } else if(m>restante){showError('El monto supera el saldo pendiente ('+fmt(restante)+')');return;}
    // v2.3.0: el recibo se emite DESPUES de confirmar la escritura. Antes se imprimia primero, asi
    // que un fallo de red dejaba en manos del deudor el comprobante de un pago NUNCA registrado.
    // `allPays` se captura aqui a proposito: es el estado PREVIO, que es el que generateRecibo
    // necesita para calcular el saldo resultante.
    _run(function(){return onPartial(pay.id,m,fecha,obs,+parcialUSD||0).then(function(r){
      if(r&&genRecibo&&loan) generateRecibo(pay,loan,m,+parcialUSD||0,allPays,{yaAbonadoPrev:yaPagado,fechaRecaudo:fecha});
      return r;
    });});
  }
  function submitCompleto(){
    if(sending) return;
    if(esUSD&&(!copRec||+copRec<=0)){showError('Ingresa el monto COP recibido para prestamos en USD');return;}
    // Mismo motivo que en el parcial: sin el dolar declarado, el efecto cambiario de este
    // cobro es irregistrable y la cuota se valua con los COP del dia.
    if(esUSD&&(+usdRec||0)<=0){showError('Ingresa los USD recibidos: son los que confirman que la cuota quedo cubierta en dolares');return;}
    if(yaPagado>0){
      // Habia pagos parciales: el recibo es "Pago final" que completa la cuota
      _run(function(){return onPartial(pay.id,restante,fecha,obs,+usdRec||0).then(function(r){
        if(r&&genRecibo) generateRecibo(pay,loan,restante,+usdRec||0,allPays,{yaAbonadoPrev:yaPagado,fechaRecaudo:fecha});
        return r;
      });});
    } else {
      _run(function(){return onMark(pay.id,'Pagado',fecha,obs,+copRec||pay.cuotaTotal,+usdRec||0).then(function(r){
        if(r&&genRecibo) generateRecibo(pay,loan,+copRec||pay.cuotaTotal,+usdRec||0,allPays,{fechaRecaudo:fecha});
        return r;
      });});
    }
  }

  return h(Modal,{onClose:onClose},
    h('div',{style:{fontWeight:700,fontSize:16,color:'var(--text)',marginBottom:14}},'Actualizar Pago'),
    h('div',{style:{background:'var(--bg3)',borderRadius:12,padding:'13px 14px',marginBottom:16,border:'1px solid var(--border)'}},
      h('div',{style:{fontWeight:700,fontSize:14,color:'var(--text)'}},pay.nombreCliente),
      h('div',{style:{fontSize:12,color:'var(--text2)',marginTop:3}},'Cuota '+pay.cuotaN+' - '+fmtD(pay.fechaPago)),
      h('div',{className:'mono',style:{fontWeight:700,fontSize:20,color:'var(--green)',marginTop:6}},fmt(pay.cuotaTotal),
        esUSD&&h('span',{style:{fontSize:13,fontWeight:600,color:'var(--blue)',marginLeft:8}},copToUsd(pay.cuotaTotal,loan.trmAcordada))),
      yaPagado>0&&pay.estadoPago!=='Pagado'&&h('div',{style:{marginTop:8,padding:'8px 10px',background:'rgba(63,185,80,.08)',border:'1px solid var(--green-bd)',borderRadius:8}},
        h('div',{className:'mono',style:{fontSize:12,color:'var(--green)',fontWeight:700}},'Ya abonado: '+fmt(yaPagado)+' / '+fmt(pay.cuotaTotal)),
        h('div',{className:'mono',style:{fontSize:13,color:'var(--yellow)',fontWeight:700,marginTop:2}},'Pendiente: '+fmt(restante))),
      esUSD&&h('div',{style:{fontSize:11,color:'var(--blue)',marginTop:4}},'Prestamo USD (TRM $'+fmtN(loan.trmAcordada)+') - ingresa COP recibidos'),
      h('div',{style:{marginTop:8}},h('span',{style:{background:so.bg,color:so.color,fontSize:11,fontWeight:700,padding:'3px 10px',borderRadius:99}},so.icon+' '+pay.estadoPago))),

    // Toggle Completo / Parcial — solo si la cuota no esta Pagada
    pay.estadoPago!=='Pagado'&&h('div',{style:{display:'flex',gap:6,marginBottom:12,background:'var(--bg3)',border:'1px solid var(--border)',borderRadius:10,padding:3}},
      h('button',{type:'button',onClick:function(){setTipoPago('completo');},style:{flex:1,padding:'8px 10px',border:'none',borderRadius:8,cursor:'pointer',fontWeight:700,fontSize:12,background:tipoPago==='completo'?'var(--green2)':'transparent',color:tipoPago==='completo'?'#fff':'var(--text2)',transition:'all .15s'}},'Pago completo'),
      h('button',{type:'button',onClick:function(){setTipoPago('parcial');},style:{flex:1,padding:'8px 10px',border:'none',borderRadius:8,cursor:'pointer',fontWeight:700,fontSize:12,background:tipoPago==='parcial'?'var(--yellow)':'transparent',color:tipoPago==='parcial'?'#fff':'var(--text2)',transition:'all .15s'}},'Pago parcial')),

    h(Fld,{label:'Fecha de recaudo'},h('input',{type:'date',value:fecha,onChange:function(e){setFecha(e.target.value);},className:'inp'})),

    // ── Modo Parcial ──
    tipoPago==='parcial'&&pay.estadoPago!=='Pagado'&&h('div',{style:{background:'rgba(187,128,9,.08)',border:'1px solid var(--yellow)',borderRadius:12,padding:'10px 12px',marginBottom:4}},
      h(Fld,{label:'Monto del pago parcial (COP) *'},
        h('input',{type:'text',inputMode:'numeric',value:fmtNumInput(montoParcial),onChange:function(e){setMontoParcial(parseNum(e.target.value));},placeholder:'0',className:'inp',style:{border:'1px solid var(--yellow)'}}),
        montoParcial>0&&h('div',{style:{fontSize:11,marginTop:4,fontFamily:'monospace',color:+montoParcial>=restante?'var(--green)':'var(--text2)'}},
          +montoParcial>=restante?'Con este pago la cuota quedaria COMPLETA':'Quedarian pendientes: '+fmt(restante-(+montoParcial||0)))),
      esUSD&&h(Fld,{label:'USD recibidos *'},
        h('input',{type:'text',inputMode:'decimal',value:parcialUSD,onChange:function(e){setParcialUSD(parseDecimalInput(e.target.value));},placeholder:'Ej: 120.00',className:'inp',style:{border:'1px solid var(--blue)'}})),
      // Doble entrada visible: el dolar define la deuda que se extingue, los COP son la caja
      // real. La diferencia entre ambos ES el efecto cambiario, y aqui se ve antes de guardar.
      esUSD&&(+parcialUSD||0)>0&&(+montoParcial||0)>0&&(function(){
        var oblig=Math.round((+parcialUSD)*loan.trmAcordada);
        var efecto=(+montoParcial)-oblig;
        var trmImp=Math.round((+montoParcial)/(+parcialUSD));
        return h('div',{style:{fontSize:10.5,color:'var(--text3)',marginTop:6,lineHeight:1.5}},
          'Abona '+fmt(oblig)+' de deuda (TRM pactada $'+fmtN(loan.trmAcordada)+'). ',
          'TRM implicita $'+fmtN(trmImp)+' — ',
          h('span',{style:{color:efecto<0?'var(--red)':'var(--green)',fontWeight:600}},
            (efecto<0?'perdida':'ganancia')+' por TRM '+fmt(Math.abs(efecto))));
      })()),

    // ── Modo Completo (USD fields) ──
    tipoPago==='completo'&&esUSD&&pay.estadoPago!=='Pagado'&&h('div',{style:{background:'rgba(187,128,9,.1)',border:'1px solid var(--yellow)',borderRadius:12,padding:'10px 12px',marginBottom:4}},
      h(Fld,{label:'COP realmente recibidos *'},
        h('input',{type:'text',inputMode:'numeric',value:fmtNumInput(copRec),onChange:function(e){setCopRec(parseNum(e.target.value));},placeholder:'Monto en pesos recibido',className:'inp',style:{border:'1px solid var(--yellow)'}})),
      h(Fld,{label:'USD recibidos *'},
        h('input',{type:'text',inputMode:'decimal',value:usdRec,onChange:function(e){setUsdRec(parseDecimalInput(e.target.value));},placeholder:'Ej: 250.00',className:'inp',style:{border:'1px solid var(--blue)'}}))),

    h(Fld,{label:'Observaciones'},h('input',{value:obs,onChange:function(e){setObs(e.target.value);},placeholder:'Notas opcionales...',className:'inp'})),
    pay.estadoPago!=='Pagado'&&h('label',{style:{display:'flex',alignItems:'center',gap:8,marginTop:14,cursor:'pointer',fontSize:12,color:'var(--text2)'}},
      h('input',{type:'checkbox',checked:genRecibo,onChange:function(){setGenRecibo(!genRecibo);},style:{width:16,height:16,accentColor:'var(--green)',cursor:'pointer'}}),
      'Generar recibo de pago'),
    // Los 4 botones escriben en BD y comparten la MISMA guarda: mientras una operacion esta
    // en vuelo ninguno acepta clicks (evita tanto el doble submit como disparar dos cambios
    // de estado contradictorios sobre la misma cuota).
    h('div',{style:{display:'flex',gap:8,marginTop:14}},
      pay.estadoPago!=='Pagado'&&tipoPago==='completo'&&h(ABtn,{color:'var(--green2)',disabled:sending,onClick:submitCompleto,icon:'check', label:sending?'Registrando...':(yaPagado>0?'Completar':'Pagado')}),
      pay.estadoPago!=='Pagado'&&tipoPago==='parcial' &&h(ABtn,{color:'var(--yellow)', disabled:sending,onClick:submitParcial, icon:'check', label:sending?'Registrando...':'Registrar parcial'}),
      pay.estadoPago!=='En Mora'   &&h(ABtn,{color:'#b91c1c',     disabled:sending,onClick:function(){_run(function(){return onMark(pay.id,'En Mora',  null, obs,0,0);});}, icon:'alert', label:sending?'...':'En Mora'}),
      pay.estadoPago!=='Pendiente' &&h(ABtn,{color:'var(--bg4)',   disabled:sending,onClick:function(){_run(function(){return onMark(pay.id,'Pendiente',null, obs,0,0);});}, icon:'clock', label:sending?'...':'Pendiente'})));
}
