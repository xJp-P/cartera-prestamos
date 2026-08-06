// public/js/modales/LiquidarModal.js — Liquidar la deuda completa. Vive a nivel App, no dentro del perfil.
//
// Extraido de `app.js` en la Etapa 3 (B7) del refactor. Codigo VERBATIM.
//
// El estado global sigue en `App` y baja por PROPS; los callbacks suben igual.
// Sin Context API y sin store.

import { Modal } from '../componentes/base.js';
import { Ico } from '../componentes/iconos.js';
import { computeLiquidacion } from '../core/dominio.js';
import { copToUsd, fmt } from '../core/format.js';
import { generateEstadoLiquidacion } from '../pdf/estado-liquidacion.js';
import { h, useState } from '../core/react.js';
import { _submitGuard, nowStr } from '../core/ui.js';

// ── LiquidarModal (v2.0.0) ────────────────────────────────────────────────────
// ELEVADO desde DebtorModal a nivel App. Antes su estado (confirmLiq) vivia dentro
// de DebtorModal, asi que era inalcanzable desde AbonoModal (componente hermano; y
// cuando AbonoModal esta abierto, DebtorModal esta desmontado). Al subirlo:
//   - AbonoModal puede ofrecer el CTA "Liquidar deuda" cuando el abono excede el
//     capital amortizable por tener capital atrapado en cuotas En Mora (v2.0.0).
//   - Queda disponible para invocarse desde cualquier vista (p.ej. Cartera) a futuro.
// La UI y el calculo son IDENTICOS a v1.19.0: todo el desglose sale del helper
// centralizado computeLiquidacion (unica fuente de verdad del valor de liquidacion).
export function LiquidarModal(props){
  var cLoan=props.loan,pays=props.pays||[],onConfirm=props.onConfirm,onClose=props.onClose;
  var datosPago=props.datosPago;
  var ipm=useState(false); var incluyeProxMes=ipm[0]; var setIncluyeProxMes=ipm[1];
  var lqs=useState(false); var liqSending=lqs[0]; var setLiqSending=lqs[1]; // v1.18.1: guarda anti doble-submit
  var pdf=useState(false); var pdfBusy=pdf[0]; var setPdfBusy=pdf[1];
  var cEsUSD=cLoan.moneda==='USD';
  // v1.19.0 — TODO el desglose viene del helper centralizado computeLiquidacion (misma fuente
  // de verdad que la tarjeta, el cronograma PDF y el recibo de abono -> no pueden divergir).
  var L=computeLiquidacion(cLoan,pays,{incluyeProxMes:incluyeProxMes});
  var aplicaInteres=L.aplicaInteres;
  var mesTxt=fmt(L.moraValorMes)+'/mes'+(L.moraUniforme?'':' prom.');
  // En un credito abierto el devengo ya corre al dia, asi que el mes opcional es un
  // cobro HACIA ADELANTE; en los de cuotas es el mes en curso que aun no se facturo.
  var lblExtra=L.esDiario?'Interes del proximo mes':'Interes del mes en curso';
  function rowLine(label,sublabel,monto,color,opaque){
    return h('div',{style:{display:'flex',justifyContent:'space-between',alignItems:'flex-start',padding:'10px 0',borderTop:'1px solid var(--bg3)',opacity:opaque?.45:1,transition:'opacity .2s'}},
      h('div',{style:{flex:1,paddingRight:8}},
        h('div',{style:{fontSize:12,color:'var(--text)',fontWeight:500}},label),
        sublabel&&h('div',{style:{fontSize:10,color:'var(--text3)',marginTop:2}},sublabel)),
      h('div',{style:{textAlign:'right'}},
        h('div',{className:'mono',style:{fontSize:13,fontWeight:600,color:color||'var(--text)'}},fmt(monto)),
        cEsUSD&&monto>0&&h('div',{className:'mono',style:{fontSize:10,color:'var(--blue)',fontWeight:400}},copToUsd(monto,cLoan.trmAcordada))));
  }
  return h(Modal,{onClose:onClose},
    h('div',{style:{fontWeight:700,fontSize:17,color:'var(--text)',marginBottom:2,display:'flex',alignItems:'center',gap:8}},
      h(Ico,{name:'dollar',size:16,color:'var(--red)',sw:2.4}),'Liquidar deuda'),
    h('div',{style:{fontSize:12,color:'var(--text3)',marginBottom:14}},cLoan.nombre+' • '+cLoan.modalidad+(aplicaInteres?' • '+cLoan.tasaMensual+'% mensual':'')),
    h('div',{style:{background:'var(--bg3)',borderRadius:12,padding:'4px 14px',border:'1px solid var(--border)',marginBottom:12}},
      rowLine('Capital pendiente','Saldo de la deuda',L.capitalPendiente,'var(--text)'),
      L.moraCount>0&&rowLine('Intereses atrasados',L.moraCount+' cuota'+(L.moraCount>1?'s':'')+' a '+mesTxt,L.intMora,'var(--yellow)'),
      // Credito abierto: su interes NO vive en ninguna fila (se deriva del tiempo), asi
      // que sin esta linea el TOTAL incluia un devengo que el desglose no explicaba.
      L.esDiario&&L.interesDevengado>0&&rowLine('Interes acumulado',L.diasDevengados+' dia(s) a '+fmt(L.interesDia)+'/dia',L.interesDevengado,'var(--yellow)'),
      L.partialPend>0&&rowLine('Abonos parciales','Ya recibidos',-Math.abs(L.partialPend),'var(--blue)'),
      L.incluyeProxMes&&rowLine(lblExtra,cLoan.tasaMensual+'% sobre el capital pendiente',L.intProxMes,'var(--yellow)')),
    // El texto viejo ("¿Incluir 1 mes de interes adicional?") preguntaba sin dar contexto:
    // no decia de donde sale ese mes ni cuando corresponde cobrarlo. Ahora dice QUE se
    // cobra, POR QUE existe (se liquida a mitad de ciclo) y CUANDO activarlo.
    aplicaInteres&&h('label',{style:{display:'flex',alignItems:'flex-start',gap:10,background:'var(--bg3)',border:'1px solid '+(incluyeProxMes?'var(--yellow)':'var(--border)'),borderRadius:10,padding:'11px 12px',marginBottom:12,cursor:'pointer',transition:'border-color .2s'}},
      h('input',{type:'checkbox',checked:incluyeProxMes,onChange:function(){setIncluyeProxMes(!incluyeProxMes);},style:{width:16,height:16,accentColor:'var(--yellow)',cursor:'pointer',margin:'1px 0 0',flex:'none'}}),
      h('span',{style:{flex:1}},
        h('span',{style:{display:'flex',justifyContent:'space-between',gap:8}},
          h('span',{style:{fontSize:13,color:'var(--text)',fontWeight:500}},'Cobrar el '+lblExtra.toLowerCase()),
          h('span',{className:'mono',style:{fontSize:12,color:'var(--yellow)',whiteSpace:'nowrap'}},'+ '+fmt(L.intProxMes))),
        h('span',{style:{display:'block',fontSize:11,color:'var(--text3)',marginTop:4,lineHeight:1.45}},
          L.esDiario
            ? 'El interes ya esta cobrado al dia de hoy. Activalo solo si pactaste cobrarle ademas el mes siguiente.'
            : 'El credito se cierra antes del proximo vencimiento, asi que ese mes aun no se ha facturado. Activalo solo si lo pactaste con el deudor.'))),
    h('div',{style:{background:'var(--red-bg)',border:'1px solid var(--red-bd)',borderRadius:12,padding:'12px 14px',marginBottom:14,display:'flex',justifyContent:'space-between',alignItems:'center'}},
      h('div',null,
        h('div',{style:{fontSize:10,color:'var(--red)',fontWeight:600,letterSpacing:.5}},'TOTAL A LIQUIDAR'),
        h('div',{style:{fontSize:10,color:'var(--text3)',marginTop:2}},'Lo que debe entregarte el deudor')),
      h('div',{style:{textAlign:'right'}},
        h('div',{className:'mono',style:{fontSize:20,fontWeight:700,color:'var(--red)'}},fmt(L.total)),
        cEsUSD&&h('div',{className:'mono',style:{fontSize:11,color:'var(--blue)',fontWeight:500}},copToUsd(L.total,cLoan.trmAcordada)))),
    // Documento PREVIO al cobro: se entrega, el deudor paga, y solo entonces se confirma.
    // Lleva el monto en la etiqueta para que el vinculo con la casilla se vea sin explicarlo.
    // NO escribe en BD, asi que no necesita _submitGuard; la guarda local solo evita que un
    // doble clic abra dos ventanas de impresion.
    h('button',{onClick:function(){
        if(pdfBusy) return;
        setPdfBusy(true);
        try{ generateEstadoLiquidacion(cLoan,pays,datosPago,{incluyeProxMes:incluyeProxMes,hasta:nowStr()}); }
        finally{ setTimeout(function(){setPdfBusy(false);},600); }
      },disabled:pdfBusy,className:'btn-primary',style:{background:'transparent',border:'1px solid var(--border)',color:'var(--text2)',cursor:pdfBusy?'wait':'pointer',marginBottom:14,display:'flex',alignItems:'center',justifyContent:'center',gap:8}},
      h(Ico,{name:'receipt',size:15,color:'var(--text3)',sw:2}),
      'Generar PDF de liquidacion • '+fmt(L.total)),
    h('div',{style:{fontSize:11,color:'var(--text3)',marginBottom:14,lineHeight:1.5}},'Al confirmar, las cuotas pendientes y en mora se marcaran como pagadas y el prestamo se cerrara.'),
    h('button',{onClick:function(){_submitGuard(liqSending,setLiqSending,function(){return onConfirm(cLoan.id,L.capitalPendiente,L.intExtra);});},disabled:liqSending,className:'btn-primary',style:{background:liqSending?'var(--bg3)':'var(--red-bg)',border:'1px solid '+(liqSending?'var(--border)':'var(--red-bd)'),color:liqSending?'var(--text3)':'var(--red)',cursor:liqSending?'not-allowed':'pointer',marginBottom:6}},liqSending?'Procesando...':'Confirmar liquidacion'),
    h('button',{onClick:onClose,className:'btn-primary',style:{background:'var(--bg3)',border:'1px solid var(--border)',color:'var(--text2)'}},'Cancelar'));
}
