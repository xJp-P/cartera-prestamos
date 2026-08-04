// public/js/modales/DebtorModal.js — Perfil del deudor: prestamos, cronograma, cobros y acciones.
//
// Extraido de `app.js` en la Etapa 3 (B7) del refactor. Codigo VERBATIM.
//
// El estado global sigue en `App` y baja por PROPS; los callbacks suben igual.
// Sin Context API y sin store.

import { FlujoCajaPanel } from '../componentes/FlujoCajaPanel.js';
import { Modal } from '../componentes/base.js';
import { Ico } from '../componentes/iconos.js';
import { API, showError } from '../core/api.js';
import { _pmt } from '../core/calculo.js';
import { computeLiquidacion, imputarCobros, pendCuota } from '../core/dominio.js';
import { copToUsd, fmt, fmtD, fmtN, fmtUSD } from '../core/format.js';
import { h, useState } from '../core/react.js';
import { freqLabel } from '../core/ui.js';
import { generateCronogramaPDF } from '../pdf/cronograma.js';
import { esAbono } from '../core/ids.js';

// ── DebtorModal ───────────────────────────────────────────────────────────────
export function DebtorModal(props){
  var d=props.deudor,pays=props.pays,loans=props.loans,onClose=props.onClose,onNewLoan=props.onNewLoan,onAbono=props.onAbono,onRequestLiquidar=props.onRequestLiquidar,onReload=props.onReload,onReestructurar=props.onReestructurar;
  var ex=useState(null); var expLoan=ex[0]; var setExpLoan=ex[1];
  var cr=useState(null); var cronoLoan=cr[0]; var setCronoLoan=cr[1];
  // v2.0.0 — confirmLiq / incluyeProxMes / liqSending se movieron al componente LiquidarModal
  // (nivel App) para que el CTA de AbonoModal tambien pueda invocar la liquidacion. Aqui solo
  // queda el disparador: onRequestLiquidar(l).
  var cf=useState(null); var cambioFecha=cf[0]; var setCambioFecha=cf[1];
  var cfs=useState(false); var cfSending=cfs[0]; var setCfSending=cfs[1];   // v1.18.1: guarda anti doble-submit del cambio de fecha
  var ceu=useState(null); var comprasExp=ceu[0]; var setComprasExp=ceu[1];
  // Pagos de este deudor (por nombre, a traves de sus prestamos)
  var deudorPays=pays.filter(function(p){
    var loan=null;
    for(var i=0;i<loans.length;i++){if(loans[i].id===p.prestamoId){loan=loans[i];break;}}
    return loan&&loan.nombre===d.nombre;
  });
  // Fase 2: intereses REALMENTE cobrados, via imputacion — incluye la parte de interes que ya
  // cubrio un pago parcial en curso. Antes solo contaba cuotas con estadoPago==='Pagado', asi que
  // esta cifra de la cabecera contradecia al bloque RECAUDADO A LA FECHA del mismo perfil.
  var interesesPagados=deudorPays.reduce(function(s,p){return s+imputarCobros(p).totales.interes;},0);
  // Ultimo pago real: solo los que tienen fechaRecaudo definida
  var ultimoPago=deudorPays.filter(function(p){return p.estadoPago==='Pagado'&&p.fechaRecaudo;})
    .sort(function(a,b){return b.fechaRecaudo.localeCompare(a.fechaRecaudo);});
  // Cuotas en mora de este deudor (con detalle)
  var cuotasMora=deudorPays.filter(function(p){return p.estadoPago==='En Mora';})
    .sort(function(a,b){return a.fechaPago.localeCompare(b.fechaPago);});
  if(cambioFecha){
    var cfLoan=cambioFecha.loan;
    var cfEsUSD=cfLoan.moneda==='USD';
    var diaActual=cfLoan.diaPago;
    var nuevoDia=parseInt(cambioFecha.nuevoDia,10);
    var validNuevo=nuevoDia>=1&&nuevoDia<=31&&nuevoDia!==diaActual;
    var tasaMensual=+cfLoan.tasaMensual||0;
    // Cuota transitoria: interes prorrateado a los DIAS REALES del primer periodo (desde la
    // ultima cuota pagada / fechaInicio hasta la nueva fecha). Replica el calculo del backend.
    function _payDate(startISO,cuotaN,dp){var d=new Date(startISO+'T12:00:00');d.setDate(1);d.setMonth(d.getMonth()+cuotaN);d.setDate(Math.min(dp,new Date(d.getFullYear(),d.getMonth()+1,0).getDate()));return d.toISOString().split('T')[0];}
    function _addMes(iso){var d=new Date(iso+'T12:00:00');d.setDate(1);d.setMonth(d.getMonth()+1);return d.toISOString().split('T')[0];}
    function _fLarga(iso){if(!iso)return '';var d=new Date(iso+'T12:00:00');var M=['ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic'];return d.getDate()+' de '+M[d.getMonth()]+' de '+d.getFullYear();}
    var _base=cfLoan.fechaBaseCronograma||cfLoan.fechaInicio;
    var _lastSettled=cambioFecha.lastSettled||cfLoan.fechaInicio;
    var _nextN=(cambioFecha.regularConsumed||0)+1;
    var diasReales=0,intProrrateado=0,_first='';
    if(validNuevo){
      // Misma regla "nunca adelantar" que el backend: si el nuevo dia caeria antes de la cuota ya
      // agendada (dia menor en el mismo mes), la 1a cuota se proyecta al mes siguiente.
      var _origNext=_payDate(_base,_nextN,diaActual);
      var _naive=_payDate(_base,_nextN,nuevoDia);
      var _baseCron=_naive<_origNext?_addMes(_base):_base;
      _first=_payDate(_baseCron,_nextN,nuevoDia);
      diasReales=Math.max(1,Math.round((new Date(_first+'T12:00:00')-new Date(_lastSettled+'T12:00:00'))/86400000));
      intProrrateado=Math.round(cambioFecha.saldo*(tasaMensual/100)*diasReales/30);
    }
    var intMesNormal=Math.round(cambioFecha.saldo*tasaMensual/100);
    // Capital de la cuota (misma logica que buildSchedule): 0 en Intereses; en C+I = PMT - interes normal.
    var _r=tasaMensual/100;
    var _n=Math.max(1,(+cfLoan.plazoMeses||12)-(cambioFecha.regularConsumed||0));
    var _pmt=_r===0?cambioFecha.saldo/_n:cambioFecha.saldo*_r*Math.pow(1+_r,_n)/(Math.pow(1+_r,_n)-1);
    var capitalCuota=cfLoan.modalidad==='Intereses'?0:Math.max(0,Math.round(_pmt-intMesNormal));
    var moraConsolidada=cambioFecha.intMora;
    var primeraCuotaTotal=capitalCuota+intProrrateado+moraConsolidada;
    var cuotaRecurrente=cfLoan.modalidad==='Intereses'?intMesNormal:Math.round(_pmt);

    // Render del estado SUCCESS (comprobante post-éxito)
    if(cambioFecha.step==='success'){
      var rs=cambioFecha.resultado||{};
      return h(Modal,{onClose:function(){setCambioFecha(null);}},
        h('div',{style:{display:'flex',alignItems:'center',gap:8,marginBottom:6}},
          h('div',{style:{width:32,height:32,borderRadius:99,background:'var(--green-bg)',display:'flex',alignItems:'center',justifyContent:'center'}},h(Ico,{name:'check',size:18,color:'var(--green)',sw:2.5})),
          h('div',{style:{fontWeight:700,fontSize:16,color:'var(--text)'}},'Fecha de pago actualizada')),
        h('div',{style:{fontSize:12,color:'var(--text3)',marginBottom:14}},cfLoan.nombre+' • '+cfLoan.modalidad),
        h('div',{style:{background:'var(--green-bg)',border:'1px solid var(--green-bd)',borderRadius:12,padding:'14px',marginBottom:12}},
          h('div',{style:{fontSize:10,color:'var(--green)',fontWeight:600,letterSpacing:.5,marginBottom:4}},'PROXIMA CUOTA'),
          h('div',{style:{display:'flex',justifyContent:'space-between',alignItems:'flex-end',gap:10}},
            h('div',null,
              h('div',{style:{fontSize:13,color:'var(--text)',fontWeight:600}},(rs.primeraCuota&&rs.primeraCuota.fechaPago)?_fLarga(rs.primeraCuota.fechaPago):('Dia '+rs.nuevoDia)),
              h('div',{style:{fontSize:11,color:'var(--text3)',marginTop:2}},'Primer cobro · luego el dia '+rs.nuevoDia+' de cada mes')),
            h('div',{style:{textAlign:'right'}},
              h('div',{className:'mono',style:{fontSize:22,fontWeight:700,color:'var(--green)'}},fmt(rs.primeraCuota&&rs.primeraCuota.cuotaTotal||primeraCuotaTotal)),
              cfEsUSD&&h('div',{className:'mono',style:{fontSize:11,color:'var(--blue)'}},copToUsd(rs.primeraCuota&&rs.primeraCuota.cuotaTotal||primeraCuotaTotal,cfLoan.trmAcordada))))),
        h('div',{style:{background:'var(--bg3)',borderRadius:12,padding:'4px 14px',marginBottom:12,border:'1px solid var(--border)'}},
          h('div',{style:{fontSize:10,color:'var(--text3)',fontWeight:600,letterSpacing:.5,padding:'10px 0 6px'}},'DESGLOSE DE LA CUOTA TRANSITORIA'),
          (rs.capitalCuota||0)>0&&h('div',{style:{display:'flex',justifyContent:'space-between',padding:'7px 0',borderTop:'1px solid var(--bg)',fontSize:12}},
            h('span',{style:{color:'var(--text2)'}},'Capital de la cuota'),
            h('span',{className:'mono',style:{color:'var(--text)',fontWeight:500}},fmt(rs.capitalCuota))),
          h('div',{style:{display:'flex',justifyContent:'space-between',padding:'7px 0',borderTop:'1px solid var(--bg)',fontSize:12}},
            h('span',{style:{color:'var(--text2)'}},'Intereses prorrateados ('+(rs.diasReales||diasReales)+' dias)'),
            h('span',{className:'mono',style:{color:'var(--yellow)',fontWeight:500}},fmt(rs.prorrateo||intProrrateado))),
          (rs.moraConsolidada||0)>0&&h('div',{style:{display:'flex',justifyContent:'space-between',padding:'7px 0',borderTop:'1px solid var(--bg)',fontSize:12}},
            h('span',{style:{color:'var(--text2)'}},rs.moraCount+' cuota'+(rs.moraCount>1?'s':'')+' en mora'),
            h('span',{className:'mono',style:{color:'var(--text)',fontWeight:500}},fmt(rs.moraConsolidada))),
          h('div',{style:{display:'flex',justifyContent:'space-between',padding:'9px 0 4px',borderTop:'2px solid var(--border)',fontSize:13}},
            h('span',{style:{color:'var(--text)',fontWeight:700}},'Total cuota transitoria'),
            h('span',{className:'mono',style:{color:'var(--green)',fontWeight:700}},fmt(rs.cuotaTotalTransitoria||(rs.primeraCuota&&rs.primeraCuota.cuotaTotal)||primeraCuotaTotal)))),
        h('div',{style:{background:'var(--bg3)',borderRadius:10,padding:'10px 12px',marginBottom:14,fontSize:12,color:'var(--text2)',display:'flex',justifyContent:'space-between',alignItems:'center'}},
          h('span',null,'Cuotas siguientes (cada dia '+rs.nuevoDia+')'),
          h('span',{className:'mono',style:{color:'var(--text)',fontWeight:600}},fmt(rs.cuotasRecurrentes||cuotaRecurrente))),
        h('button',{onClick:function(){setCambioFecha(null);},className:'btn-primary',style:{background:'var(--green2)',color:'#fff',border:'none'}},'Cerrar'));
    }

    // Render del estado FORM
    return h(Modal,{onClose:function(){setCambioFecha(null);}},
      h('div',{style:{fontWeight:700,fontSize:17,color:'var(--text)',marginBottom:2,display:'flex',alignItems:'center',gap:8}},
        h(Ico,{name:'calendar',size:16,color:'var(--blue)',sw:2}),'Cambiar fecha de pago'),
      h('div',{style:{fontSize:12,color:'var(--text3)',marginBottom:14}},cfLoan.nombre+' • '+cfLoan.modalidad+' • '+tasaMensual+'% mensual'),
      h('div',{style:{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10,marginBottom:12}},
        h('div',{style:{background:'var(--bg3)',borderRadius:10,padding:'10px 12px',border:'1px solid var(--border)'}},
          h('div',{style:{fontSize:10,color:'var(--text3)',fontWeight:600,letterSpacing:.5}},'DIA ACTUAL'),
          h('div',{style:{fontSize:18,fontWeight:700,color:'var(--text)',marginTop:2}},diaActual)),
        h('div',{style:{background:'var(--blue-bg)',borderRadius:10,padding:'10px 12px',border:'1px solid var(--blue-bd)'}},
          h('div',{style:{fontSize:10,color:'var(--blue)',fontWeight:600,letterSpacing:.5}},'NUEVO DIA'),
          h('input',{type:'number',min:1,max:31,value:cambioFecha.nuevoDia,onChange:function(e){setCambioFecha(Object.assign({},cambioFecha,{nuevoDia:e.target.value}));},placeholder:'1-31',autoFocus:true,style:{width:'100%',background:'transparent',border:'none',outline:'none',fontSize:18,fontWeight:700,color:'var(--blue)',marginTop:2,padding:0,fontFamily:'inherit'}}))),
      cambioFecha.moraCount>0&&h('div',{style:{background:'var(--red-bg)',border:'1px solid var(--red-bd)',borderRadius:10,padding:'10px 12px',marginBottom:12,fontSize:11,color:'var(--text2)',lineHeight:1.5}},
        h('div',{style:{fontWeight:700,color:'var(--red)',marginBottom:4,display:'flex',alignItems:'center',gap:5}},h(Ico,{name:'alert',size:12,color:'var(--red)',sw:2.4}),' '+cambioFecha.moraCount+' CUOTA'+(cambioFecha.moraCount>1?'S':'')+' EN MORA'),
        'Se consolidaran en la primera cuota nueva ('+fmt(moraConsolidada)+' en intereses).'),
      validNuevo?h('div',{style:{background:'var(--bg3)',borderRadius:12,padding:'4px 14px',marginBottom:12,border:'1px solid var(--border)'}},
        h('div',{style:{fontSize:10,color:'var(--text3)',fontWeight:600,letterSpacing:.5,padding:'10px 0 6px'}},'DESGLOSE DE LA CUOTA TRANSITORIA'),
        capitalCuota>0&&h('div',{style:{display:'flex',justifyContent:'space-between',padding:'7px 0',borderTop:'1px solid var(--bg)',fontSize:12}},
          h('div',null,
            h('div',{style:{color:'var(--text2)'}},'Capital de la cuota'),
            h('div',{style:{fontSize:10,color:'var(--text3)',marginTop:1}},'Amortizacion (igual que una cuota normal)')),
          h('span',{className:'mono',style:{color:'var(--text)',fontWeight:500}},fmt(capitalCuota))),
        h('div',{style:{display:'flex',justifyContent:'space-between',padding:'7px 0',borderTop:'1px solid var(--bg)',fontSize:12}},
          h('div',null,
            h('div',{style:{color:'var(--text2)'}},'Intereses prorrateados ('+diasReales+' dias)'),
            h('div',{style:{fontSize:10,color:'var(--text3)',marginTop:1}},'Saldo × ('+tasaMensual+'%/30) × '+diasReales+' dias')),
          h('span',{className:'mono',style:{color:'var(--yellow)',fontWeight:500}},fmt(intProrrateado))),
        moraConsolidada>0&&h('div',{style:{display:'flex',justifyContent:'space-between',padding:'7px 0',borderTop:'1px solid var(--bg)',fontSize:12}},
          h('span',{style:{color:'var(--text2)'}},'Mora consolidada'),
          h('span',{className:'mono',style:{color:'var(--text)',fontWeight:500}},fmt(moraConsolidada))),
        h('div',{style:{display:'flex',justifyContent:'space-between',padding:'9px 0 4px',borderTop:'2px solid var(--border)',fontSize:13}},
          h('span',{style:{color:'var(--text)',fontWeight:700}},'Total cuota transitoria'),
          h('span',{className:'mono',style:{color:'var(--green)',fontWeight:700}},fmt(primeraCuotaTotal)))):
        h('div',{style:{background:'var(--bg3)',borderRadius:10,padding:'14px',marginBottom:12,fontSize:12,color:'var(--text3)',textAlign:'center'}},'Ingresa un nuevo dia (1-31) distinto al actual para ver el desglose'),
      validNuevo&&h('div',{style:{background:'var(--green-bg)',border:'1px solid var(--green-bd)',borderRadius:12,padding:'12px 14px',marginBottom:12,display:'flex',justifyContent:'space-between',alignItems:'center'}},
        h('div',null,
          h('div',{style:{fontSize:10,color:'var(--green)',fontWeight:600,letterSpacing:.5}},'PRIMERA CUOTA ('+_fLarga(_first)+')'),
          h('div',{style:{fontSize:10,color:'var(--text3)',marginTop:2}},'A partir de la 2a cuota: '+fmt(cuotaRecurrente)+' el dia '+nuevoDia+' de cada mes')),
        h('div',{style:{textAlign:'right'}},
          h('div',{className:'mono',style:{fontSize:20,fontWeight:700,color:'var(--green)'}},fmt(primeraCuotaTotal)),
          cfEsUSD&&h('div',{className:'mono',style:{fontSize:11,color:'var(--blue)'}},copToUsd(primeraCuotaTotal,cfLoan.trmAcordada)))),
      // v1.18.1 — GUARDA ANTI DOBLE-SUBMIT. El endpoint no es idempotente: con el payload
      // identico el backend rechaza el 2o intento, pero el input de dia (arriba) sigue
      // editable mientras el POST viaja, asi que un usuario impaciente puede cambiar el dia
      // y reconfirmar; ese 2o request SI pasa el filtro y rueda `fechaBaseCronograma` un mes
      // extra, reescribiendo la cuota transitoria con un prorrateo inflado.
      h('button',{onClick:function(){
        if(cfSending) return;
        if(!validNuevo){showError('Ingresa un dia valido (1-31, distinto al actual)');return;}
        setCfSending(true);
        API.post('/api/loans/'+cfLoan.id+'/cambiar-dia-pago',{
          nuevoDia:nuevoDia
        }).then(function(r){
          // API.post nunca rechaza (atrapa y resuelve null), asi que TODAS las salidas
          // pasan por aqui: liberamos siempre antes de decidir que hacer.
          setCfSending(false);
          if(!r)return;
          if(r.error){showError(r.error);return;}
          setCambioFecha(Object.assign({},cambioFecha,{step:'success',resultado:r}));
          if(onReload)onReload();
        },function(){setCfSending(false);});
      },disabled:!validNuevo||cfSending,className:'btn-primary',style:{background:(validNuevo&&!cfSending)?'var(--blue-bg)':'var(--bg3)',border:'1px solid '+((validNuevo&&!cfSending)?'var(--blue-bd)':'var(--border)'),color:(validNuevo&&!cfSending)?'var(--blue)':'var(--text3)',marginBottom:6,cursor:(validNuevo&&!cfSending)?'pointer':'not-allowed'}},cfSending?'Procesando...':'Confirmar cambio'),
      h('button',{onClick:function(){setCambioFecha(null);},className:'btn-primary',style:{background:'var(--bg3)',border:'1px solid var(--border)',color:'var(--text2)'}},'Cancelar'));
  }
  return h(Modal,{onClose:onClose,wide:true,tall:true},
    h('div',{style:{display:'flex',alignItems:'center',gap:12,marginBottom:16}},
      h('div',{style:{width:48,height:48,borderRadius:99,background:'var(--bg3)',border:'1px solid var(--border2)',display:'flex',alignItems:'center',justifyContent:'center',fontSize:22,flexShrink:0}},
        d.nombre.charAt(0).toUpperCase()),
      h('div',null,
        h('div',{style:{fontWeight:700,fontSize:17,color:'var(--text)'}},d.nombre),
        d.cedula&&d.cedula!=='0'&&h('div',{style:{fontSize:12,color:'var(--text2)'}},'CC '+d.cedula))),
    d.telefono&&d.telefono!=='0'&&h('div',{style:{display:'flex',alignItems:'center',gap:8,background:'var(--bg3)',borderRadius:10,padding:'10px 12px',marginBottom:4}},
      h(Ico,{name:'phone',size:14,color:'var(--blue)'}),
      h('span',{style:{fontSize:13,color:'var(--text)'}},d.telefono)),
    h('div',{style:{display:'grid',gridTemplateColumns:'1fr 1fr',gap:8,marginTop:8}},
      h('div',{style:{background:'var(--bg3)',borderRadius:12,padding:'12px'}},
        h('div',{style:{fontSize:10,color:'var(--text3)',fontWeight:600,marginBottom:4}},'SALDO ACTUAL'),
        h('div',{className:'mono',style:{fontSize:14,fontWeight:600,color:'var(--green)'}},fmt(d.totalSaldo))),
      h('div',{style:{background:'var(--bg3)',borderRadius:12,padding:'12px'}},
        h('div',{style:{fontSize:10,color:'var(--text3)',fontWeight:600,marginBottom:4}},'INTERESES PAGADOS'),
        h('div',{className:'mono',style:{fontSize:14,fontWeight:600,color:'var(--blue)'}},fmt(interesesPagados))),
      h('div',{style:{background:'var(--bg3)',borderRadius:12,padding:'12px'}},
        h('div',{style:{fontSize:10,color:'var(--text3)',fontWeight:600,marginBottom:4}},'PRESTAMOS'),
        h('div',{style:{fontSize:14,fontWeight:600,color:'var(--text)'}},d.loans.length+' ('+d.loans.filter(function(l){return l.estado==='Activo';}).length+' activos)')),
      h('div',{style:{background:d.mora>0?'var(--red-bg)':'var(--bg3)',borderRadius:12,padding:'12px',border:d.mora>0?'1px solid var(--red-bd)':'none'}},
        h('div',{style:{fontSize:10,color:d.mora>0?'var(--red)':'var(--text3)',fontWeight:600,marginBottom:4}},'CUOTAS EN MORA'),
        h('div',{style:{fontSize:14,fontWeight:600,color:d.mora>0?'var(--red)':'var(--text)'}},d.mora))),
    cuotasMora.length>0&&h('div',{style:{marginTop:8,background:'var(--red-bg)',borderRadius:10,padding:'10px 12px',border:'1px solid var(--red-bd)'}},
      cuotasMora.map(function(p,i){
        var pend=pendCuota(p);var hasPartial=(p.partialPaid||0)>0;
        return h('div',{key:p.id,style:{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'6px 0',borderTop:i>0?'1px solid rgba(248,81,73,.15)':'none'}},
          h('div',null,
            h('div',{style:{fontSize:12,fontWeight:500,color:'var(--text)'}},p.nombreCliente),
            h('div',{style:{fontSize:11,color:'var(--red)',marginTop:1}},'Cuota '+p.cuotaN+' - Vencida el '+fmtD(p.fechaPago)),
            hasPartial&&h('div',{className:'mono',style:{fontSize:10,color:'var(--blue)',marginTop:1}},'Abonado '+fmt(p.partialPaid)+' de '+fmt(p.cuotaTotal))),
          h('div',{style:{textAlign:'right'}},
            h('div',{className:'mono',style:{fontSize:12,fontWeight:300,color:'var(--red)'}},fmt(pend)),
            function(){var pl=null;for(var j=0;j<loans.length;j++){if(loans[j].id===p.prestamoId){pl=loans[j];break;}}
              return pl&&pl.moneda==='USD'?h('div',{className:'mono',style:{fontSize:10,color:'var(--blue)'}},copToUsd(pend,pl.trmAcordada)):null;}()));
      })),
    h('div',{style:{marginTop:8,padding:'10px 12px',background:'var(--bg3)',borderRadius:10,fontSize:12,color:'var(--text2)'}},
      ultimoPago.length>0?'Ultimo pago: '+fmtD(ultimoPago[0].fechaRecaudo):'Sin pagos realizados'),
    h('div',{style:{marginTop:12}},
      h('div',{style:{fontSize:11,fontWeight:600,color:'var(--text3)',marginBottom:8}},'PRESTAMOS ACTIVOS'),
      h('button',{onClick:function(){onNewLoan(d);},style:{width:'100%',background:'var(--green2)',color:'white',border:'none',borderRadius:10,padding:'10px',fontSize:12,fontWeight:600,cursor:'pointer',display:'flex',alignItems:'center',justifyContent:'center',gap:5,fontFamily:'inherit',marginBottom:10}},h(Ico,{name:'plus',size:13,color:'white'}),' Nuevo prestamo a '+d.nombre),
      d.loans.filter(function(l){return l.estado==='Activo';}).length===0&&h('div',{style:{fontSize:12,color:'var(--text3)',padding:'8px 0',fontStyle:'italic'}},'Sin prestamos activos'),
      d.loans.filter(function(l){return l.estado==='Activo';}).slice().sort(function(a,b){return b.fechaInicio.localeCompare(a.fechaInicio);}).map(function(l){
        var lp=pays.filter(function(p){return p.prestamoId===l.id;});
        var regulares=lp.filter(function(p){return !esAbono(p);});
        var abonosList=lp.filter(function(p){return esAbono(p);});
        var pagadas=regulares.filter(function(p){return p.estadoPago==='Pagado';}).length;
        var enMora=regulares.filter(function(p){return p.estadoPago==='En Mora';});
        var pendientes=regulares.filter(function(p){return p.estadoPago==='Pendiente';});
        var totalReg=regulares.length;
        var pct=totalReg>0?Math.round(pagadas/totalReg*100):0;
        // Saldo real: monto original - todo capital pagado (cuotas + abonos)
        var capAbonos=abonosList.filter(function(p){return p.estadoPago==='Pagado';}).reduce(function(s,p){return s+p.abonoCapital;},0);
        var origCOP=l.moneda==='USD'?Math.round(l.montoOrigen*l.trmAcordada):Math.round(l.montoOrigen);
        var todoCapPag=lp.filter(function(p){return p.estadoPago==='Pagado';}).reduce(function(s,p){return s+p.abonoCapital;},0);
        var saldo=Math.max(0,origCOP-todoCapPag);
        var intCobrados=regulares.filter(function(p){return p.estadoPago==='Pagado';}).reduce(function(s,p){return s+p.interesPeriodo;},0);
        var partialPend=regulares.filter(function(p){return p.estadoPago!=='Pagado';}).reduce(function(s,p){return s+(p.partialPaid||0);},0);
        // Fase 2: imputacion agregada del prestamo (cascada interes -> capital, ver imputarCobros).
        // Es la base de TODA cifra de "lo cobrado" que se muestra abajo, de modo que el bloque
        // RECAUDADO A LA FECHA y el panel de Flujo de Caja no puedan contradecirse: los dos
        // iteran los mismos eventos de caja.
        var impLoan=lp.reduce(function(a,p){var t=imputarCobros(p).totales;
          a.cobrado+=t.cobrado; a.interes+=t.interes; a.capital+=t.capital; a.ajuste+=t.ajuste; return a;},
          {cobrado:0,interes:0,capital:0,ajuste:0});
        // SALDO MOSTRADO: capital vivo descontando el capital que YA cubrieron los parciales en
        // curso. Antes restaba el parcial COMPLETO (`saldo - partialPend`), lo que descontaba de
        // una cifra de capital una plata que en parte era interes -> restaba de mas.
        // OJO: `saldo` (canonico) NO se toca; gobierna liquidacion, techo del abono y recalculo.
        var saldoDisplay=Math.max(0,origCOP-Math.round(impLoan.capital));
        var esUSD=l.moneda==='USD';
        // Desglose de ganancia USD: separa intereses puros de la utilidad cambiaria (diferencia de TRM al cobro).
        // gananciaTRM = sum(montoCOPRecibido - cuotaTotal) por cuota pagada que tiene montoCOPRecibido > 0
        // Ganancia/Perdida TRM = diferencia entre COP recibido y "valor contractual" (a TRM acordada)
        //   - Cuotas regulares: montoCOPRecibido - cuotaTotal (cuotaTotal ya esta en COP con TRM acordada)
        //   - Abonos a capital: montoCOPRecibido - (montoUSDRecibido * trmAcordada) — solo si el abono se registro con USD
        var gananciaTRMReg=esUSD?regulares.filter(function(p){return p.estadoPago==='Pagado'&&p.montoCOPRecibido&&p.montoCOPRecibido>0;}).reduce(function(s,p){return s+(p.montoCOPRecibido-p.cuotaTotal);},0):0;
        var gananciaTRMAb=esUSD?lp.filter(function(p){return esAbono(p)&&p.estadoPago==='Pagado'&&p.montoUSDRecibido&&p.montoUSDRecibido>0;}).reduce(function(s,p){return s+(p.montoCOPRecibido-(p.montoUSDRecibido*l.trmAcordada));},0):0;
        var gananciaTRM=Math.round(gananciaTRMReg+gananciaTRMAb);
        var gananciaTotal=intCobrados+gananciaTRM;
        var isExp=expLoan===l.id;
        // Próxima cuota
        var proxCuota=pendientes.sort(function(a,b){return a.fechaPago.localeCompare(b.fechaPago);})[0];
        return h('div',{key:l.id,style:{background:'var(--bg2)',borderRadius:12,border:'1px solid '+(enMora.length>0?'var(--red-bd)':'var(--border)'),marginBottom:8,overflow:'hidden'}},
          h('div',{onClick:function(){setExpLoan(isExp?null:l.id);},style:{padding:'11px 13px',cursor:'pointer',display:'flex',justifyContent:'space-between',alignItems:'center'}},
            h('div',{style:{flex:1,minWidth:0}},
              h('div',{style:{display:'flex',alignItems:'center',gap:6,flexWrap:'wrap'}},
                h('span',{style:{fontWeight:700,fontSize:13,color:'var(--text)'}},l.modalidad),
                esUSD&&h('span',{className:'tag',style:{background:'var(--blue-bg)',color:'var(--blue)'}},'USD'),
                enMora.length>0&&h('span',{className:'tag',style:{background:'var(--red-bg)',color:'var(--red)'}},enMora.length+' mora'),
                partialPend>0&&h('span',{className:'tag',style:{background:'var(--blue-bg)',color:'var(--blue)'}},'Parcial'),
                l.modalidad==='Intereses'?h('span',{className:'tag',style:{background:'var(--blue-bg)',color:'var(--blue)'}},'\u221E'):l.modalidad==='Prestamo'?h('span',{className:'tag',style:{background:'var(--yellow-bg)',color:'var(--yellow)'}},'Sin interes'):l.modalidad==='Pago Unico'?h('span',{className:'tag',style:{background:'var(--green-bg)',color:'var(--green)'}},'Pago unico'):h('span',{className:'tag',style:{background:'var(--green-bg)',color:'var(--green)'}},pct+'%')),
              h('div',{style:{fontSize:11,color:'var(--text3)',marginTop:3}},fmtD(l.fechaInicio)+' \u2022 '+l.tasaMensual+'% \u2022 '+(freqLabel(l))),
              partialPend>0&&h('div',{className:'mono',style:{fontSize:10,color:'var(--blue)',marginTop:2}},'Abonado '+fmt(partialPend)+' de '+fmt(saldo))),
            h('div',{style:{textAlign:'right',marginLeft:8}},
              h('div',{className:'mono',style:{fontSize:14,fontWeight:600,color:'var(--green)'}},fmt(saldoDisplay)),
              esUSD&&h('div',{className:'mono',style:{fontSize:10,color:'var(--blue)'}},copToUsd(saldoDisplay,l.trmAcordada)))),
          isExp&&function(){
            // Unificado con el helper centralizado computeLiquidacion (doctrina "un solo helper",
            // v1.19.0): esta tarjeta era la última superficie que aún recalculaba la fórmula inline.
            var _Lq=computeLiquidacion(l,lp,{});
            var intMoraTotal=_Lq.intMora;
            var liquidacion=_Lq.total;
            var origCOPDisplay=esUSD?Math.round(l.montoOrigen*l.trmAcordada):Math.round(l.montoOrigen);
            // Parse comprasUSD una sola vez
            var lotes=null;
            if(esUSD&&l.comprasUSD){try{var parsed=typeof l.comprasUSD==='string'?JSON.parse(l.comprasUSD):l.comprasUSD;if(Array.isArray(parsed)&&parsed.length>0)lotes=parsed;}catch(_){}}
            var lotesUSD=lotes?lotes.reduce(function(s,c){return s+(+c.monto||0);},0):0;
            var lotesCOP=lotes?lotes.reduce(function(s,c){return s+(+c.monto||0)*(+c.tasa||0);},0):0;
            var lotesTRMProm=lotes&&lotesUSD>0?Math.round(lotesCOP/lotesUSD):0;
            // ── Recaudado a la fecha (flujo de caja parcial) ──
            // Fase 2: los tres rubros salen de la IMPUTACION, no de filtrar por estadoPago==='Pagado'.
            // Antes un parcial en curso era INVISIBLE aqui: el cliente abonaba $400.000 y ni el
            // capital, ni los intereses, ni el total se movian — mientras el panel de Flujo de Caja,
            // justo debajo, si contaba el dinero. En el caso real que lo destapo, la contradiccion
            // entre los dos bloques del MISMO recuadro fue de $400.000 exactos.
            var recCapHoy=Math.round(impLoan.capital);   // capital recuperado (incluye parciales)
            var recIntHoy=Math.round(impLoan.interes);   // intereses cobrados (incluye parciales)
            var recTRMHoy=Math.round(impLoan.ajuste);    // efecto cambiario, ya aislado por la imputacion
            var recGanHoy=recIntHoy+recTRMHoy;           // ganancia = interes + efecto TRM
            // TOTAL = caja real. Por construccion == capital + interes + ajuste, asi que las filas
            // SUMAN el total y ademas coincide con el total del panel de Flujo de Caja.
            var recTotalHoy=Math.round(impLoan.cobrado);
            var trm=l.trmAcordada;
            var recRegPag=regulares.filter(function(p){return p.estadoPago==='Pagado';});
            var recAboPag=abonosList.filter(function(p){return p.estadoPago==='Pagado';});
            var efectoTRMUSDHoy=esUSD&&trm>0?(recRegPag.filter(function(p){return p.montoUSDRecibido&&p.montoUSDRecibido>0;}).reduce(function(s,p){return s+(p.montoUSDRecibido-p.cuotaTotal/trm);},0)+recAboPag.filter(function(p){return p.montoUSDRecibido&&p.montoUSDRecibido>0;}).reduce(function(s,p){return s+(p.montoUSDRecibido-p.abonoCapital/trm);},0)):0;
            var recCapUSD=esUSD&&trm>0?recCapHoy/trm:0;
            var recTotalUSD=recCapUSD+(esUSD&&trm>0?recIntHoy/trm:0)+efectoTRMUSDHoy;
            var ganTotUSDHoy=recTotalUSD-recCapUSD; // = interes USD + efecto TRM USD (real, Bug #25)
            // Helper row: label izquierda, valor derecha. divider=true \u2192 linea entre filas internas.
            function row(label,value,sub,opts){
              opts=opts||{};
              return h('div',{style:{display:'flex',justifyContent:'space-between',alignItems:'flex-start',padding:'7px 0',borderTop:opts.first?'none':'1px solid var(--bg3)'}},
                h('div',{style:{flex:1,minWidth:0,paddingRight:8}},
                  h('div',{style:{fontSize:12,color:'var(--text2)',fontWeight:opts.strong?600:500}},label),
                  sub&&h('div',{style:{fontSize:10,color:'var(--text3)',marginTop:1}},sub)),
                h('div',{style:{textAlign:'right',flexShrink:0}},value));
            }
            // Estilo de separador entre GRUPOS (mas prominente que entre filas)
            var grupoStyle={paddingTop:12,marginTop:12,borderTop:'1px solid var(--bg2)'};
            return h('div',{style:{borderTop:'1px solid var(--border)',padding:'12px 13px',background:'var(--bg3)'}},
              // \u2500\u2500 GRUPO 1: SALDO PENDIENTE (hero) \u2500\u2500
              h('div',{style:{display:'flex',justifyContent:'space-between',alignItems:'flex-end',padding:'2px 0 12px',borderBottom:'1px solid var(--bg2)'}},
                h('div',null,
                  h('div',{style:{fontSize:10,color:'var(--text3)',fontWeight:600,letterSpacing:.5}},'SALDO PENDIENTE'),
                  partialPend>0&&h('div',{className:'mono',style:{fontSize:10,color:'var(--blue)',marginTop:2}},'Abonado parcial: '+fmt(partialPend))),
                h('div',{style:{textAlign:'right'}},
                  h('div',{className:'mono',style:{fontSize:20,fontWeight:600,color:enMora.length>0?'var(--red)':saldoDisplay===0?'var(--text3)':'var(--text)'}},fmt(saldoDisplay)),
                  esUSD&&h('div',{className:'mono',style:{fontSize:12,color:'var(--blue)',fontWeight:400}},copToUsd(saldoDisplay,l.trmAcordada)))),
              // \u2500\u2500 GRUPO 2: INFORMACION DEL PRESTAMO \u2500\u2500
              h('div',{style:{paddingTop:10}},
                row('Capital prestado',
                  h('div',null,
                    h('div',{className:'mono',style:{fontSize:13,color:'var(--text)',fontWeight:500}},esUSD?'USD $'+fmtN(l.montoOrigen):fmt(l.montoOrigen)),
                    esUSD&&h('div',{className:'mono',style:{fontSize:10,color:'var(--text3)'}},fmt(origCOPDisplay)+' \u00B7 TRM $'+fmtN(l.trmAcordada))),
                  null,{first:true}),
                row('Cuotas pagadas',h('div',{style:{fontSize:13,color:'var(--text)',fontWeight:500}},pagadas+' / '+(l.modalidad==='Intereses'?'\u221E':totalReg)))),
              // \u2500\u2500 GRUPO 3: RECAUDADO A LA FECHA (flujo de caja parcial + ganancia) \u2500\u2500
              // El gate incluye impLoan.cobrado para que un prestamo cuyo unico cobro sea un pago
              // parcial en curso tambien muestre el bloque (antes exigia una cuota ya Pagada).
              (pagadas>0||capAbonos>0||impLoan.cobrado>0)&&h('div',{style:grupoStyle},
                h('div',{style:{fontSize:10,color:'var(--text3)',fontWeight:600,letterSpacing:.5,marginBottom:4}},'RECAUDADO A LA FECHA'),
                h('div',{style:{display:'flex',justifyContent:'space-between',alignItems:'flex-start',padding:'2px 0 9px',borderBottom:'1px solid var(--bg2)'}},
                  h('div',null,
                    h('div',{style:{fontSize:12,color:'var(--text)',fontWeight:600,letterSpacing:.3}},'TOTAL RECIBIDO'),
                    h('div',{style:{fontSize:10,color:'var(--text3)',marginTop:1}},'Lo cobrado hasta hoy')),
                  h('div',{style:{textAlign:'right'}},
                    h('div',{className:'mono',style:{fontSize:16,fontWeight:600,color:'var(--text)'}},fmt(recTotalHoy)),
                    esUSD&&h('div',{className:'mono',style:{fontSize:11,color:'var(--blue)'}},fmtUSD(recTotalUSD)))),
                row('Capital recuperado',
                  h('div',null,
                    h('div',{className:'mono',style:{fontSize:13,color:'var(--text)',fontWeight:500}},fmt(recCapHoy)),
                    esUSD&&h('div',{className:'mono',style:{fontSize:10,color:'var(--blue)'}},copToUsd(recCapHoy,l.trmAcordada))),
                  null,{first:true}),
                row('Intereses cobrados',
                  h('div',null,
                    h('div',{className:'mono',style:{fontSize:13,color:recIntHoy>0?'var(--green)':'var(--text3)',fontWeight:500}},(recIntHoy>0?'+':'')+fmt(recIntHoy)),
                    esUSD&&recIntHoy>0&&h('div',{className:'mono',style:{fontSize:10,color:'var(--blue)'}},copToUsd(recIntHoy,l.trmAcordada)))),
                esUSD&&row(recTRMHoy<0?'Perdida por TRM':'Ganancia por TRM',
                  h('div',{className:'mono',style:{fontSize:13,color:recTRMHoy>0?'var(--green)':recTRMHoy<0?'var(--red)':'var(--text3)',fontWeight:500}},(recTRMHoy>0?'+':recTRMHoy<0?'-':'')+fmt(Math.abs(recTRMHoy))),
                  recTRMHoy===0?'Sin datos de TRM al cobro':recTRMHoy>0?'TRM subio al cobrar':'TRM bajo al cobrar'),
                esUSD&&row(l.modalidad==='Prestamo'?'Resultado total':'Ganancia total',
                  h('div',null,
                    h('div',{className:'mono',style:{fontSize:14,color:recGanHoy<0?'var(--red)':'var(--green)',fontWeight:600}},(recGanHoy<0?'-':'+')+fmt(Math.abs(recGanHoy))),
                    h('div',{className:'mono',style:{fontSize:10,color:'var(--blue)',fontWeight:400}},(ganTotUSDHoy<0?'-':'+')+fmtUSD(Math.abs(ganTotUSDHoy)))),
                  null,{strong:true}),
                capAbonos>0&&row('Abonos a capital recibidos',
                  h('div',null,
                    h('div',{className:'mono',style:{fontSize:13,color:'var(--blue)',fontWeight:500}},fmt(capAbonos)),
                    esUSD&&h('div',{className:'mono',style:{fontSize:10,color:'var(--blue)'}},copToUsd(capAbonos,l.trmAcordada)))),
                // v2.2.0 — mismo panel que en los creditos cerrados: lo cobrado hasta HOY,
                // movimiento por movimiento, en la fecha real en que entro cada peso.
                h(FlujoCajaPanel,{loan:l,pays:pays})),
              // \u2500\u2500 GRUPO 4: ESTADO (mora + proxima + liquidacion) \u2500\u2500
              (enMora.length>0||proxCuota||(l.estado==='Activo'&&saldo>0))&&h('div',{style:grupoStyle},
                h('div',{style:{fontSize:10,color:'var(--text3)',fontWeight:600,letterSpacing:.5,marginBottom:2}},'ESTADO'),
                enMora.length>0&&h('div',{style:{display:'flex',justifyContent:'space-between',alignItems:'flex-start',padding:'7px 0'}},
                  h('div',{style:{flex:1,minWidth:0}},
                    h('div',{style:{fontSize:12,color:'var(--red)',fontWeight:500,display:'flex',alignItems:'center',gap:5}},
                      h(Ico,{name:'alert',size:11,color:'var(--red)',sw:2.4}),
                      enMora.length+' cuota'+(enMora.length>1?'s':'')+' en mora'),
                    h('div',{style:{fontSize:10,color:'var(--text3)',marginTop:1}},enMora.map(function(p){return 'Cuota '+p.cuotaN+' \u00B7 '+fmtD(p.fechaPago);}).join(' \u2022 '))),
                  h('div',{style:{textAlign:'right'}},
                    h('div',{className:'mono',style:{fontSize:13,color:'var(--red)',fontWeight:500}},fmt(enMora.reduce(function(s,p){return s+pendCuota(p);},0))),
                    esUSD&&h('div',{className:'mono',style:{fontSize:10,color:'var(--blue)'}},copToUsd(enMora.reduce(function(s,p){return s+pendCuota(p);},0),l.trmAcordada)))),
                proxCuota&&h('div',{style:{display:'flex',justifyContent:'space-between',alignItems:'flex-start',padding:'7px 0',borderTop:enMora.length>0?'1px solid var(--bg3)':'none'}},
                  h('div',null,
                    h('div',{style:{fontSize:12,color:'var(--green)',fontWeight:500,display:'flex',alignItems:'center',gap:5}},
                      h(Ico,{name:'calendar',size:11,color:'var(--green)',sw:2.4}),
                      'Proxima cuota'),
                    h('div',{style:{fontSize:10,color:'var(--text3)',marginTop:1}},'Cuota '+proxCuota.cuotaN+' \u2022 '+fmtD(proxCuota.fechaPago))),
                  h('div',{style:{textAlign:'right'}},
                    h('div',{className:'mono',style:{fontSize:13,color:'var(--green)',fontWeight:500}},fmt(proxCuota.cuotaTotal)),
                    esUSD&&h('div',{className:'mono',style:{fontSize:10,color:'var(--blue)'}},copToUsd(proxCuota.cuotaTotal,l.trmAcordada)))),
                l.estado==='Activo'&&saldo>0&&h('div',{style:{display:'flex',justifyContent:'space-between',alignItems:'flex-start',padding:'7px 0',borderTop:(enMora.length>0||proxCuota)?'1px solid var(--bg3)':'none'}},
                  h('div',null,
                    h('div',{style:{fontSize:12,color:'var(--yellow)',fontWeight:500,display:'flex',alignItems:'center',gap:5}},
                      h(Ico,{name:'dollar',size:11,color:'var(--yellow)',sw:2.4}),
                      'Liquidacion total'),
                    h('div',{style:{fontSize:10,color:'var(--text3)',marginTop:1}},'Capital'+(intMoraTotal>0?' + intereses en mora':'')+(partialPend>0?' - parciales':''))),
                  h('div',{style:{textAlign:'right'}},
                    h('div',{className:'mono',style:{fontSize:13,color:'var(--yellow)',fontWeight:500}},fmt(liquidacion)),
                    esUSD&&h('div',{className:'mono',style:{fontSize:10,color:'var(--blue)'}},copToUsd(liquidacion,l.trmAcordada))))),
              // \u2500\u2500 GRUPO 5: COMPRAS USD (colapsable, solo USD con lotes) \u2500\u2500
              lotes&&h('div',{style:grupoStyle},
                h('button',{onClick:function(e){e.stopPropagation();setComprasExp(comprasExp===l.id?null:l.id);},style:{width:'100%',background:'transparent',border:'none',cursor:'pointer',padding:'2px 0',display:'flex',justifyContent:'space-between',alignItems:'center',color:'var(--blue)',fontSize:11,fontWeight:600,letterSpacing:.5,fontFamily:'inherit'}},
                  h('span',null,'COMPRAS USD ('+lotes.length+' lote'+(lotes.length>1?'s':'')+' \u00B7 TRM prom $'+fmtN(lotesTRMProm)+')'),
                  h('span',{style:{fontSize:10,color:'var(--text3)',fontWeight:400}},comprasExp===l.id?'Ocultar \u25B2':'Ver detalle \u25BC')),
                comprasExp===l.id&&h('div',{style:{marginTop:8}},
                  lotes.map(function(c,i){
                    return h('div',{key:i,style:{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'5px 0',fontSize:11,borderTop:'1px solid var(--bg3)'}},
                      h('span',{style:{color:'var(--text2)'}},'Compra '+(i+1)+': '+fmtN(+c.monto)+' USD'),
                      h('span',{className:'mono',style:{color:'var(--text3)',fontWeight:300}},'@ '+fmt(+c.tasa)));
                  }),
                  h('div',{style:{display:'flex',justifyContent:'space-between',padding:'7px 0 2px',fontSize:11,borderTop:'1px solid var(--bg3)',marginTop:2}},
                    h('span',{style:{color:'var(--text3)'}},'Total invertido en COP'),
                    h('span',{className:'mono',style:{color:'var(--text)',fontWeight:500}},fmt(lotesCOP))))),
              // \u2500\u2500 GRUPO 5b: PROYECCION DE GANANCIAS \u2500\u2500
              l.modalidad!=='Prestamo'&&h('div',{style:grupoStyle},
                h('div',{style:{fontSize:10,color:'var(--text3)',fontWeight:600,letterSpacing:.5,marginBottom:2}},'PROYECCION DE GANANCIAS'),
                (function(){
                  if(l.modalidad==='Intereses'){
                    var rentaMensual=Math.round(saldo*(+l.tasaMensual||0)/100);
                    return [
                      row('Cobrado hasta hoy',
                        h('div',null,
                          h('div',{className:'mono',style:{fontSize:13,color:'var(--green)',fontWeight:500}},'+'+fmt(intCobrados)),
                          esUSD&&intCobrados>0&&h('div',{className:'mono',style:{fontSize:10,color:'var(--blue)'}},copToUsd(intCobrados,l.trmAcordada))),
                        'Ganancia acumulada por intereses',{first:true,key:'proy-cob'}),
                      row('Renta mensual',
                        h('div',null,
                          h('div',{className:'mono',style:{fontSize:13,color:'var(--text)',fontWeight:500}},'+'+fmt(rentaMensual)),
                          esUSD&&rentaMensual>0&&h('div',{className:'mono',style:{fontSize:10,color:'var(--blue)'}},copToUsd(rentaMensual,l.trmAcordada))),
                        'Saldo '+fmt(saldo)+' x '+l.tasaMensual+'%',{key:'proy-renta'})
                    ];
                  }
                  var gananciaEsperada=l.modalidad==='Pago Unico'?(+l.gananciaFija||0):regulares.reduce(function(s,p){return s+p.interesPeriodo;},0);
                  var pctProy=gananciaEsperada>0?Math.min(100,Math.round(intCobrados/gananciaEsperada*100)):0;
                  return [
                    h('div',{key:'proy-bar',style:{padding:'8px 0 4px'}},
                      h('div',{style:{display:'flex',justifyContent:'space-between',fontSize:11,marginBottom:4}},
                        h('span',{style:{color:'var(--green)',fontWeight:600}},pctProy+'% cobrado'),
                        h('span',{className:'mono',style:{color:'var(--text3)',fontWeight:400}},fmt(intCobrados)+' / '+fmt(gananciaEsperada))),
                      h('div',{style:{height:6,borderRadius:3,background:'var(--bg4)',overflow:'hidden'}},
                        h('div',{style:{height:'100%',borderRadius:3,background:'var(--green2)',width:pctProy+'%',transition:'width .3s'}}))),
                    row('Ganancia esperada',
                      h('div',null,
                        h('div',{className:'mono',style:{fontSize:13,color:'var(--text)',fontWeight:500}},fmt(gananciaEsperada)),
                        esUSD&&gananciaEsperada>0&&h('div',{className:'mono',style:{fontSize:10,color:'var(--blue)'}},copToUsd(gananciaEsperada,l.trmAcordada))),
                      'Total de intereses del cronograma',{key:'proy-esp'}),
                    row('Cobrado',
                      h('div',null,
                        h('div',{className:'mono',style:{fontSize:13,color:'var(--green)',fontWeight:500}},'+'+fmt(intCobrados)),
                        esUSD&&intCobrados>0&&h('div',{className:'mono',style:{fontSize:10,color:'var(--blue)'}},copToUsd(intCobrados,l.trmAcordada))),
                      null,{key:'proy-cob'}),
                    gananciaEsperada>intCobrados&&row('Pendiente por cobrar',
                      h('div',null,
                        h('div',{className:'mono',style:{fontSize:13,color:'var(--yellow)',fontWeight:500}},fmt(gananciaEsperada-intCobrados)),
                        esUSD&&h('div',{className:'mono',style:{fontSize:10,color:'var(--blue)'}},copToUsd(gananciaEsperada-intCobrados,l.trmAcordada))),
                      null,{key:'proy-pend'})
                  ];
                })()),
              // \u2500\u2500 GRUPO 6: ACCIONES (botones) \u2500\u2500
              h('div',{style:grupoStyle},
            (function(){
              var isActive=l.estado==='Activo'&&saldo>0;
              var canAbonar=isActive&&onAbono;
              var canReestructurar=isActive&&l.modalidad==='Capital + Intereses'&&onReestructurar;
              // v1.10.0: Pago Unico no tiene dia de pago periodico — excluir igual que Prestamo
              var canCambiarFecha=isActive&&l.modalidad!=='Prestamo'&&l.modalidad!=='Pago Unico';
              var imora=enMora.reduce(function(s,p){return s+p.interesPeriodo;},0); // usado por Cambiar fecha
              var labelStyle={fontSize:9,fontWeight:700,color:'var(--text3)',letterSpacing:1.2,textTransform:'uppercase',marginBottom:6};
              var btnBase={width:'100%',padding:'10px 12px',borderRadius:10,fontSize:13,fontWeight:700,cursor:'pointer',display:'flex',alignItems:'center',justifyContent:'center',gap:8,fontFamily:'inherit',transition:'all .15s'};
              var btnPrimary=Object.assign({},btnBase,{background:'var(--green2)',border:'1px solid var(--green2)',color:'#fff'});
              var btnSecondary=Object.assign({},btnBase,{background:'var(--green-bg)',border:'1px solid var(--green-bd)',color:'var(--green)'});
              var btnNeutral=Object.assign({},btnBase,{background:'transparent',border:'1px solid var(--border)',color:'var(--text2)',fontWeight:600});
              var btnGhost={flex:1,padding:'9px 10px',borderRadius:8,fontSize:12,fontWeight:600,cursor:'pointer',display:'flex',alignItems:'center',justifyContent:'center',gap:6,fontFamily:'inherit',background:'transparent',border:'1px dashed var(--border)',color:'var(--text3)',transition:'all .15s'};
              var sects=[];
              // Tier 1: COBRAR
              if(canAbonar){
                sects.push(h('div',{key:'g1'},
                  h('div',{style:labelStyle},'Cobrar'),
                  h('button',{onClick:function(e){e.stopPropagation();onAbono(l);},style:btnPrimary},
                    h(Ico,{name:'dollar',size:15,color:'#fff',sw:2.2}),'Registrar abono'),
                  h('button',{onClick:function(e){e.stopPropagation();onRequestLiquidar(l);},style:Object.assign({},btnSecondary,{marginTop:6})},
                    h(Ico,{name:'check',size:15,color:'var(--green)',sw:2.4}),'Liquidar deuda')));
              }
              // Tier 2: AJUSTAR CRONOGRAMA
              if(canReestructurar||canCambiarFecha){
                var ajs=[h('div',{key:'lbl',style:labelStyle},'Ajustar cronograma')];
                if(canReestructurar) ajs.push(h('button',{key:'r',onClick:function(e){e.stopPropagation();onReestructurar(l);},style:btnNeutral},
                  h(Ico,{name:'calc',size:14,color:'var(--text2)',sw:2}),'Reestructurar cuotas'));
                if(canCambiarFecha) ajs.push(h('button',{key:'f',onClick:function(e){e.stopPropagation();var _pg=lp.filter(function(p){return !esAbono(p)&&p.estadoPago==='Pagado';});var _pgf=_pg.map(function(p){return p.fechaPago;}).sort();setCambioFecha({loan:l,saldo:saldo,intMora:imora,moraCount:enMora.length,lastSettled:_pgf.length?_pgf[_pgf.length-1]:l.fechaInicio,regularConsumed:_pg.length,step:'form',nuevoDia:''});},style:Object.assign({},btnNeutral,{marginTop:canReestructurar?6:0})},
                  h(Ico,{name:'calendar',size:14,color:'var(--text2)',sw:2}),'Cambiar fecha de pago'));
                sects.push(h('div',{key:'g2',style:{marginTop:14}},ajs));
              }
              // Tier 3: CRONOGRAMA (Ver detalle + Descargar PDF pareados)
              var cronoExp=cronoLoan===l.id;
              sects.push(h('div',{key:'g3',style:{marginTop:14}},
                h('div',{style:labelStyle},'Cronograma'),
                h('div',{style:{display:'grid',gridTemplateColumns:l.estado==='Activo'?'1fr 1fr':'1fr',gap:6}},
                  h('button',{onClick:function(e){e.stopPropagation();setCronoLoan(cronoExp?null:l.id);},style:btnGhost},
                    h(Ico,{name:cronoExp?'x':'calendar',size:13,color:'var(--text3)'}),cronoExp?'Ocultar detalle':'Ver detalle'),
                  l.estado==='Activo'&&h('button',{onClick:function(e){e.stopPropagation();generateCronogramaPDF(l,lp,document.documentElement.getAttribute('data-theme')==='dark');},style:btnGhost},
                    h(Ico,{name:'download',size:13,color:'var(--text3)'}),'Descargar PDF'))));
              return sects;
            })(),
            cronoLoan===l.id&&function(){
              var cronoItems=regulares.filter(function(p){return l.modalidad!=='Intereses'||p.estadoPago!=='Pendiente';}).slice().sort(function(a,b){return a.cuotaN-b.cuotaN;});
              // Linea de tiempo unica: cuotas + abonos intercalados por fecha, con la MISMA regla
              // de orden que generateCronogramaPDF. Gemela de la de CarteraView.
              var timeline=cronoItems.concat(abonosList).sort(function(a,b){
                var c=String(a.fechaPago).localeCompare(String(b.fechaPago));
                return c!==0?c:a.cuotaN-b.cuotaN;
              });
              // La columna SALDO lee p.saldoFinal (saldo de CIERRE persistido por el backend),
              // unificada con el Recibo de Abono y el cronograma PDF. Sustituye a la antigua
              // "Deuda", que era un acumulador local del saldo de APERTURA (corrido un renglon
              // respecto del resto de documentos). Gemela de la tabla de CarteraView.
              var cronoCols='32px 1fr 1fr 1fr 1fr 1fr 60px';
              return h('div',{style:{marginTop:6,borderRadius:8,overflow:'hidden',border:'1px solid var(--border)'}},
                h('div',{style:{display:'grid',gridTemplateColumns:cronoCols,background:'var(--bg4)',padding:'6px 8px',fontSize:10,fontWeight:700,color:'var(--text3)',gap:4}},
                  h('span',null,'#'),
                  h('span',null,'Vence'),
                  h('span',{style:{textAlign:'right'}},'Interes'),
                  h('span',{style:{textAlign:'right'}},'Abono a capital'),
                  h('span',{style:{textAlign:'right'}},'Valor cuota'),
                  h('span',{style:{textAlign:'right'}},'Saldo'),
                  h('span',{style:{textAlign:'center'}},'Estado')),
                timeline.map(function(p,idx){
                  // Fila de ABONO intercalada; espejo de la del PDF y de la de CarteraView.
                  if(esAbono(p)){
                    return h('div',{key:p.id,style:{display:'grid',gridTemplateColumns:cronoCols,padding:'5px 8px',fontSize:11,gap:4,borderTop:'1px solid var(--blue-bd)',background:'var(--blue-bg)'}},
                      h('span',{style:{color:'var(--blue)',fontWeight:600}},'-'),
                      h('span',{style:{color:'var(--blue)',fontStyle:'italic'}},fmtD(p.fechaPago),
                        p.observaciones&&h('div',{style:{fontSize:9,color:'var(--text3)',fontStyle:'italic'}},p.observaciones)),
                      h('span',{style:{textAlign:'right',color:'var(--text3)'}},'—'),
                      h('span',{className:'mono',style:{textAlign:'right',color:'var(--blue)',fontWeight:600}},fmt(p.abonoCapital),esUSD&&h('div',{style:{fontSize:9,color:'var(--blue)',fontWeight:400}},copToUsd(p.abonoCapital,l.trmAcordada))),
                      h('span',{className:'mono',style:{textAlign:'right',color:'var(--blue)',fontWeight:600}},fmt(p.cuotaTotal),esUSD&&h('div',{style:{fontSize:9,color:'var(--blue)',fontWeight:400}},copToUsd(p.cuotaTotal,l.trmAcordada))),
                      h('span',{className:'mono',style:{textAlign:'right',color:'var(--blue)',fontWeight:600}},fmt(p.saldoFinal),esUSD&&h('div',{style:{fontSize:9,color:'var(--blue)',fontWeight:400}},copToUsd(p.saldoFinal,l.trmAcordada))),
                      h('span',{style:{textAlign:'center'}},h('span',{style:{fontSize:9,padding:'2px 6px',borderRadius:99,background:'var(--blue-bd)',color:'var(--blue)',fontWeight:600}},'Abono')));
                  }
                  var stColor=p.estadoPago==='Pagado'?'var(--green)':p.estadoPago==='En Mora'?'var(--red)':'var(--yellow)';
                  var stBg=p.estadoPago==='Pagado'?'var(--green-bg)':p.estadoPago==='En Mora'?'var(--red-bg)':'var(--yellow-bg)';
                  var hasPartial=(p.partialPaid||0)>0&&p.estadoPago!=='Pagado';
                  // Capital reconciliado (= Valor cuota - Interes); ver nota en CarteraView.
                  var capRec=Math.max(0,p.cuotaTotal-p.interesPeriodo);
                  var _trm=l.trmAcordada||1;
                  var capRecUSD=esUSD?Math.max(0,(Math.round(p.cuotaTotal/_trm*100)-Math.round(p.interesPeriodo/_trm*100))/100):0;
                  return h('div',{key:p.id,style:{display:'grid',gridTemplateColumns:cronoCols,padding:'5px 8px',fontSize:11,gap:4,borderTop:'1px solid var(--border)',background:idx%2===0?'transparent':'var(--bg3)'}},
                    h('span',{style:{color:'var(--text3)',fontWeight:600}},p.cuotaN),
                    h('span',{style:{color:'var(--text2)'}},fmtD(p.fechaPago)),
                    h('span',{className:'mono',style:{textAlign:'right',color:'var(--text2)',fontWeight:500}},fmt(p.interesPeriodo),esUSD&&p.interesPeriodo>0&&h('div',{style:{fontSize:9,color:'var(--blue)',fontWeight:400}},copToUsd(p.interesPeriodo,l.trmAcordada))),
                    h('span',{className:'mono',style:{textAlign:'right',color:'var(--text2)',fontWeight:500}},fmt(capRec),esUSD&&capRec>0&&h('div',{style:{fontSize:9,color:'var(--blue)',fontWeight:400}},fmtUSD(capRecUSD))),
                    h('span',{className:'mono',style:{textAlign:'right',color:'var(--text)',fontWeight:600}},fmt(p.cuotaTotal),hasPartial&&h('div',{style:{fontSize:9,color:'var(--blue)',fontWeight:600}},'-'+fmt(p.partialPaid)),esUSD&&h('div',{style:{fontSize:9,color:'var(--blue)',fontWeight:400}},copToUsd(p.cuotaTotal,l.trmAcordada))),
                    h('span',{className:'mono',style:{textAlign:'right',color:'var(--text)',fontWeight:600}},fmt(p.saldoFinal),esUSD&&h('div',{style:{fontSize:9,color:'var(--blue)',fontWeight:400}},copToUsd(p.saldoFinal,l.trmAcordada))),
                    h('span',{style:{textAlign:'center'}},h('span',{style:{fontSize:9,padding:'2px 6px',borderRadius:99,background:stBg,color:stColor,fontWeight:600}},p.estadoPago==='Pagado'?'Pagado':p.estadoPago==='En Mora'?'Mora':hasPartial?'Parc.':'Pend.')));
                }));
              // El bloque "ABONOS A CAPITAL" que iba aqui se retiro: los abonos ya aparecen
              // intercalados en la linea de tiempo y repetirlos abajo los mostraba dos veces.
            }(),
            l.modalidad==='Intereses'?h('div',{style:{marginTop:8,display:'flex',alignItems:'center',gap:6}},
              h('span',{style:{fontSize:10,color:'var(--text3)'}},pagadas+' cuotas pagadas'),
              h('span',{style:{fontSize:10,color:'var(--blue)'}},'\u221E')):h('div',{style:{marginTop:8,height:5,background:'var(--bg4)',borderRadius:99,overflow:'hidden'}},
              h('div',{style:{height:'100%',width:pct+'%',background:enMora.length>0?'var(--red)':'var(--green)',borderRadius:99}}))))}());
      })),
    d.loans.filter(function(l){return l.estado==='Finalizado'||l.estado==='Cancelado';}).length>0&&h('div',{style:{marginTop:16}},
      h('div',{style:{display:'flex',alignItems:'center',gap:8,marginBottom:10}},
        h('div',{style:{flex:1,height:1,background:'var(--border)'}}),
        h('span',{style:{fontSize:10,fontWeight:600,color:'var(--text3)',letterSpacing:1}},'HISTORIAL DE CREDITOS'),
        h('div',{style:{flex:1,height:1,background:'var(--border)'}})),
      d.loans.filter(function(l){return l.estado==='Finalizado'||l.estado==='Cancelado';}).slice().sort(function(a,b){return b.fechaInicio.localeCompare(a.fechaInicio);}).map(function(l){
        var lPays=pays.filter(function(p){return p.prestamoId===l.id;});
        var regulares=lPays.filter(function(p){return !esAbono(p);});
        var abonos=lPays.filter(function(p){return esAbono(p)&&p.estadoPago==='Pagado';});
        var totalCuotas=regulares.length;
        var cuotasPagadas=regulares.filter(function(p){return p.estadoPago==='Pagado';}).length;
        var intPagados=regulares.filter(function(p){return p.estadoPago==='Pagado';}).reduce(function(s,p){return s+p.interesPeriodo;},0);
        var capAbonos=abonos.reduce(function(s,p){return s+p.abonoCapital;},0);
        var ultPago=lPays.filter(function(p){return p.estadoPago==='Pagado';}).sort(function(a,b){return (b.fechaRecaudo||'').localeCompare(a.fechaRecaudo||'');});
        var fechaFin=ultPago.length>0?(ultPago[0].fechaRecaudo||ultPago[0].fechaPago):null;
        var esUSD=l.moneda==='USD';
        var isExp=expLoan===l.id;
        var esCancelado=l.estado==='Cancelado';
        var capPerd=Math.round(l.capitalPerdido||0);
        var intPerd=Math.round(l.interesesPerdidos||0);
        var totalPerdido=capPerd+intPerd;
        // Desglose USD: ganancia/perdida TRM y ganancia total real
        // Ganancia/Perdida TRM: cuotas regulares + abonos USD (ambos con registro de COP/USD recibido)
        var gananciaTRMRegHist=esUSD?regulares.filter(function(p){return p.estadoPago==='Pagado'&&p.montoCOPRecibido&&p.montoCOPRecibido>0;}).reduce(function(s,p){return s+(p.montoCOPRecibido-p.cuotaTotal);},0):0;
        var gananciaTRMAbHist=esUSD?lPays.filter(function(p){return esAbono(p)&&p.estadoPago==='Pagado'&&p.montoUSDRecibido&&p.montoUSDRecibido>0;}).reduce(function(s,p){return s+(p.montoCOPRecibido-(p.montoUSDRecibido*l.trmAcordada));},0):0;
        var gananciaTRMHist=Math.round(gananciaTRMRegHist+gananciaTRMAbHist);
        var gananciaTotalHist=Math.round(intPagados+gananciaTRMHist);
        var bandaColor=esCancelado?'var(--red)':'var(--green)';
        // KPI del header: para USD usa ganancia total (incluye TRM); para COP solo intereses
        var kpiValor=esCancelado?totalPerdido:(esUSD?gananciaTotalHist:Math.round(intPagados));
        var kpiColor=esCancelado?'var(--red)':(esUSD&&gananciaTotalHist<0?'var(--red)':'var(--green)');
        var kpiLabel=esCancelado?'PERDIDA':((esUSD&&l.modalidad==='Prestamo')?'EFECTO TRM':'GANANCIA');
        var origCOP=esUSD?Math.round(l.montoOrigen*l.trmAcordada):Math.round(l.montoOrigen);
        // Calcular duración
        var duracion='';
        if(fechaFin){
          var fi=new Date(l.fechaInicio+'T12:00:00');var ff=new Date(fechaFin+'T12:00:00');
          var meses=Math.round((ff-fi)/(30.44*24*60*60*1000));
          duracion=meses>=12?Math.floor(meses/12)+' año'+(Math.floor(meses/12)>1?'s':'')+' '+(meses%12>0?(meses%12)+' mes'+(meses%12>1?'es':''):''):meses+' mes'+(meses>1?'es':'');
        }
        return h('div',{key:l.id,style:{background:'var(--bg3)',borderRadius:10,marginBottom:8,border:'1px solid '+(esCancelado?'var(--red-bd)':'var(--border)'),overflow:'hidden'}},
          h('div',{style:{height:4,background:bandaColor}}),
          h('div',{onClick:function(){setExpLoan(isExp?null:l.id);},style:{padding:'12px',cursor:'pointer',display:'flex',justifyContent:'space-between',alignItems:'flex-start',gap:10}},
            h('div',{style:{flex:1,minWidth:0}},
              h('div',{style:{display:'flex',alignItems:'center',gap:6,flexWrap:'wrap'}},
                h('span',{style:{fontSize:13,color:'var(--text)',fontWeight:600}},l.modalidad),
                esCancelado
                  ?h('span',{className:'tag',style:{background:'var(--red-bg)',color:'var(--red)',display:'inline-flex',alignItems:'center',gap:3}},h(Ico,{name:'x',size:10,color:'var(--red)',sw:2.4}),' Cancelado')
                  :h('span',{className:'tag',style:{background:'var(--green-bg)',color:'var(--green)',display:'inline-flex',alignItems:'center',gap:3}},h(Ico,{name:'check',size:10,color:'var(--green)'}),' Finalizado')),
              h('div',{className:'mono',style:{fontSize:14,color:'var(--text)',fontWeight:600,marginTop:4}},esUSD?'USD $'+fmtN(l.montoOrigen):fmt(origCOP),
                esUSD&&h('span',{style:{fontSize:10,color:'var(--text3)',fontWeight:400,marginLeft:6}},fmt(origCOP))),
              h('div',{style:{fontSize:11,color:'var(--text3)',marginTop:2}},fmtD(l.fechaInicio)+(fechaFin?' \u2192 '+fmtD(fechaFin):'')+' \u2022 '+(l.modalidad==='Intereses'?'\u221E':totalCuotas+' cuotas'))),
            h('div',{style:{textAlign:'right',flexShrink:0}},
              h('div',{className:'mono',style:{fontSize:16,fontWeight:700,color:kpiColor,whiteSpace:'nowrap'}},(esCancelado||kpiValor<0?'-':'+')+fmt(Math.abs(kpiValor))),
              h('div',{style:{fontSize:9,color:kpiColor,fontWeight:600,letterSpacing:.5}},kpiLabel))),
          isExp&&h('div',{style:{borderTop:'1px solid var(--border)',padding:'12px',background:'var(--bg)'}},
            h('div',{style:{display:'grid',gridTemplateColumns:'1fr 1fr',gap:'10px 12px',marginBottom:10}},
              h('div',null,
                h('div',{style:{fontSize:9,color:'var(--text3)',fontWeight:600,letterSpacing:.5}},'CAPITAL PRESTADO'),
                h('div',{className:'mono',style:{fontSize:13,fontWeight:500,color:'var(--text)'}},esUSD?'USD $'+fmtN(l.montoOrigen):fmt(origCOP)),
                esUSD&&h('div',{className:'mono',style:{fontSize:10,color:'var(--text3)'}},fmt(origCOP)+' (TRM $'+fmtN(l.trmAcordada)+')')),
              h('div',null,
                h('div',{style:{fontSize:9,color:'var(--text3)',fontWeight:600,letterSpacing:.5}},esUSD?'GANANCIA INTERES':'GANANCIA OBTENIDA'),
                h('div',{className:'mono',style:{fontSize:13,fontWeight:500,color:'var(--green)'}},fmt(intPagados)),
                esUSD&&h('div',{className:'mono',style:{fontSize:10,color:'var(--blue)'}},copToUsd(intPagados,l.trmAcordada))),
              esCancelado&&h('div',null,
                h('div',{style:{fontSize:9,color:'var(--text3)',fontWeight:600,letterSpacing:.5}},'CAPITAL DEBIENDO'),
                h('div',{className:'mono',style:{fontSize:13,fontWeight:500,color:'var(--red)'}},fmt(capPerd)),
                esUSD&&capPerd>0&&h('div',{className:'mono',style:{fontSize:10,color:'var(--blue)'}},copToUsd(capPerd,l.trmAcordada))),
              esCancelado&&h('div',null,
                h('div',{style:{fontSize:9,color:'var(--text3)',fontWeight:600,letterSpacing:.5}},'INTERESES DEBIENDO'),
                h('div',{className:'mono',style:{fontSize:13,fontWeight:500,color:'var(--red)'}},fmt(intPerd)),
                esUSD&&intPerd>0&&h('div',{className:'mono',style:{fontSize:10,color:'var(--blue)'}},copToUsd(intPerd,l.trmAcordada))),
              h('div',null,
                h('div',{style:{fontSize:9,color:'var(--text3)',fontWeight:600,letterSpacing:.5}},'CUOTAS PAGADAS'),
                h('div',{style:{fontSize:13,fontWeight:500,color:'var(--text)'}},cuotasPagadas+(l.modalidad==='Intereses'?'':'/'+totalCuotas))),
              h('div',null,
                h('div',{style:{fontSize:9,color:'var(--text3)',fontWeight:600,letterSpacing:.5}},'TASA'),
                h('div',{style:{fontSize:13,fontWeight:500,color:'var(--text2)'}},l.tasaMensual>0?l.tasaMensual+'% mensual':'Sin interes')),
              h('div',null,
                h('div',{style:{fontSize:9,color:'var(--text3)',fontWeight:600,letterSpacing:.5}},'DURACION'),
                h('div',{style:{fontSize:13,fontWeight:500,color:'var(--text2)'}},duracion||'N/A')),
              h('div',null,
                h('div',{style:{fontSize:9,color:'var(--text3)',fontWeight:600,letterSpacing:.5}},esCancelado?'FECHA DE CIERRE':'ULTIMO PAGO'),
                h('div',{style:{fontSize:13,fontWeight:500,color:'var(--text2)'}},fechaFin?fmtD(fechaFin):'N/A'))),
            esUSD&&(intPagados>0||gananciaTRMHist!==0)&&(function(){
              var regsPagH=regulares.filter(function(p){return p.estadoPago==='Pagado';});
              var capRecH=esCancelado?Math.max(0,origCOP-capPerd):origCOP;
              var totRecCOP=capRecH+Math.round(intPagados)+gananciaTRMHist;
              var trm=l.trmAcordada;
              // Efecto TRM en USD = residual (~0): los dolares llegan completos, la perdida es de pesos.
              var efectoTRMUSD=trm>0?(regsPagH.filter(function(p){return p.montoUSDRecibido&&p.montoUSDRecibido>0;}).reduce(function(s,p){return s+(p.montoUSDRecibido-p.cuotaTotal/trm);},0)+abonos.filter(function(p){return p.montoUSDRecibido&&p.montoUSDRecibido>0;}).reduce(function(s,p){return s+(p.montoUSDRecibido-p.abonoCapital/trm);},0)):0;
              var capUSD=trm>0?capRecH/trm:0;
              var intUSD=trm>0?intPagados/trm:0;
              var totRecUSD=capUSD+intUSD+efectoTRMUSD; // = USD realmente recibido
              var ganTotUSD=intUSD+efectoTRMUSD;
              var esPrestamo=l.modalidad==='Prestamo';
              function drow(label,value,valColor,subUSD,opts){
                opts=opts||{};
                return h('div',{style:{display:'flex',justifyContent:'space-between',alignItems:opts.note?'flex-start':'center',padding:opts.master?'2px 0 7px':'5px 0',borderTop:opts.topBorder===false?'none':(opts.accentTop?'1px solid var(--blue-bd)':'1px solid rgba(88,166,255,.12)'),marginTop:opts.accentTop?3:0}},
                  h('div',null,
                    h('div',{style:{fontSize:11,color:opts.master?'var(--text)':opts.accentTop?'var(--blue)':'var(--text2)',fontWeight:opts.master?700:opts.accentTop?600:400,letterSpacing:opts.master||opts.accentTop?.3:0}},label),
                    opts.note&&h('div',{style:{fontSize:9,color:'var(--text3)',marginTop:1}},opts.note)),
                  h('div',{style:{textAlign:'right'}},
                    h('span',{className:'mono',style:{fontSize:opts.master?14:(opts.accentTop?13:11),color:valColor||'var(--text)',fontWeight:(opts.master||opts.accentTop)?600:300}},value),
                    subUSD&&h('div',{className:'mono',style:{fontSize:9,color:'var(--blue)',fontWeight:400}},subUSD)));
              }
              return h('div',{style:{marginBottom:capAbonos>0||esCancelado?10:0,padding:'10px 12px',background:'rgba(88,166,255,.04)',borderRadius:8,border:'1px solid var(--blue-bd)'}},
                h('div',{style:{fontSize:10,color:'var(--blue)',fontWeight:600,letterSpacing:.5,marginBottom:6,display:'flex',alignItems:'center',gap:5}},
                  h(Ico,{name:'dollar',size:11,color:'var(--blue)'}),' DESGLOSE DE CAJA (USD)'),
                drow('TOTAL RECIBIDO',fmt(totRecCOP),'var(--text)',fmtUSD(totRecUSD),{master:true,topBorder:false}),
                drow(esCancelado?'Capital recuperado':'Capital prestado',fmt(capRecH),'var(--text2)',copToUsd(capRecH,trm)),
                drow('Intereses cobrados',(intPagados>0?'+':'')+fmt(intPagados),intPagados>0?'var(--green)':'var(--text2)',intPagados>0?copToUsd(intPagados,trm):null),
                drow('Efecto TRM',(gananciaTRMHist>0?'+':gananciaTRMHist<0?'-':'')+fmt(Math.abs(gananciaTRMHist)),gananciaTRMHist>0?'var(--green)':gananciaTRMHist<0?'var(--red)':'var(--text3)',null,{note:gananciaTRMHist===0?'Sin datos de TRM al cobro':gananciaTRMHist>0?'TRM subio al cobrar':'TRM bajo al cobrar'}),
                drow(esPrestamo?'RESULTADO TOTAL':'GANANCIA TOTAL',(gananciaTotalHist<0?'-':'+')+fmt(Math.abs(gananciaTotalHist)),gananciaTotalHist>=0?'var(--green)':'var(--red)',(ganTotUSD<0?'-':'+')+fmtUSD(Math.abs(ganTotUSD)),{accentTop:true}));
            })(),
            esCancelado&&h('div',{style:{padding:'10px 12px',background:'var(--bg3)',borderRadius:8,borderLeft:'3px solid var(--red)',marginBottom:capAbonos>0?8:0,display:'flex',justifyContent:'space-between',alignItems:'center'}},
              h('div',null,
                h('div',{style:{fontSize:10,color:'var(--text2)',fontWeight:600,letterSpacing:.5}},'MONTO TOTAL PERDIDO'),
                h('div',{style:{fontSize:10,color:'var(--text3)',marginTop:2}},'Capital + intereses en mora')),
              h('div',{className:'mono',style:{fontSize:16,fontWeight:700,color:'var(--red)'}},'-'+fmt(totalPerdido))),
            capAbonos>0&&h('div',{style:{padding:'8px 10px',background:'rgba(88,166,255,.06)',borderRadius:8,border:'1px solid var(--blue-bd)',display:'flex',justifyContent:'space-between',alignItems:'center'}},
              h('div',{style:{fontSize:10,color:'var(--blue)',fontWeight:600,letterSpacing:.5}},'ABONOS A CAPITAL REALIZADOS'),
              h('div',{className:'mono',style:{fontSize:13,fontWeight:600,color:'var(--blue)'}},fmt(capAbonos),
                esUSD&&h('span',{style:{fontSize:10,fontWeight:400,marginLeft:6}},copToUsd(capAbonos,l.trmAcordada)))),
            // v2.2.0 — flujo de caja real del credito ya cerrado
            h(FlujoCajaPanel,{loan:l,pays:pays}))
        );
      })));
}
