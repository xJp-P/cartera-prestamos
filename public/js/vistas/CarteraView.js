// public/js/vistas/CarteraView.js — Lista de prestamos con cronograma expandible y abonos intercalados.
//
// Extraido de `app.js` en la Etapa 3 (B7) del refactor. Codigo VERBATIM.
//
// El estado global sigue viviendo en `App` y baja por PROPS, igual que antes.
// Sin Context API y sin store: eso seria rediseno, no refactor.

import { Ico } from '../componentes/iconos.js';
import { imputarCobros, saldoConCaja } from '../core/dominio.js';
import { copToUsd, fmt, fmtD, fmtN, fmtUSD } from '../core/format.js';
import { h, useState } from '../core/react.js';
import { freqLabel } from '../core/ui.js';
import { esAbono } from '../core/ids.js';

// ── Cartera ───────────────────────────────────────────────────────────────────
export function CarteraView(props){
  var loans=props.loans,pays=props.pays,onAdd=props.onAdd,onEdit=props.onEdit,onDelete=props.onDelete,onAbono=props.onAbono,onForceClose=props.onForceClose;
  var es=useState(null); var exp=es[0]; var setExp=es[1];
  var ft=useState('Activo'); var filtro=ft[0]; var setFiltro=ft[1];
  var active=loans.filter(function(l){return l.estado==='Activo';});
  // "Finalizados" agrupa los dos estados terminales: éxito (Finalizado) y cierre forzoso (Cancelado)
  var finalized=loans.filter(function(l){return l.estado==='Finalizado'||l.estado==='Cancelado';});
  var filtered=filtro==='Activo'?active:finalized;
  return h('div',{className:'fade-in',style:{padding:16}},
    h('div',{style:{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:14}},
      h('div',null,
        h('div',{style:{fontWeight:700,fontSize:17,color:'var(--text)'}},'Mis Prestamos'),
        h('div',{style:{fontSize:13,color:'var(--text2)',marginTop:2}},active.length+' activos - '+fmt(active.reduce(function(s,l){
          // Fase 3: total del encabezado = SALDO CON CAJA APLICADA, via el unico helper. Antes
          // replicaba inline el saldo del MOTOR y quedaba congelado ante un parcial en curso,
          // contradiciendo al KPI del Inicio y a la lista de Deudores.
          return s+saldoConCaja(l,pays.filter(function(p){return p.prestamoId===l.id;}));
        },0)))),
      h('button',{onClick:onAdd,style:{display:'flex',alignItems:'center',gap:6,background:'var(--green2)',color:'white',border:'none',borderRadius:10,padding:'8px 14px',fontSize:14,fontWeight:600,cursor:'pointer'}},
        h(Ico,{name:'plus',size:15,color:'white'}),' Nuevo')),
    h('div',{style:{display:'flex',gap:6,marginBottom:12}},
      [['Activo','Activos',active.length],['Finalizados','Finalizados',finalized.length]].map(function(t){
        var isActive=filtro===t[0];
        return h('button',{key:t[0],onClick:function(){setFiltro(t[0]);},style:{flex:1,padding:'8px 0',borderRadius:10,border:'1.5px solid '+(isActive?(t[0]==='Activo'?'var(--green)':'var(--blue)'):'var(--border)'),background:isActive?(t[0]==='Activo'?'var(--green-bg)':'var(--blue-bg)'):'transparent',color:isActive?(t[0]==='Activo'?'var(--green)':'var(--blue)'):'var(--text3)',fontSize:13,fontWeight:isActive?700:500,cursor:'pointer',display:'flex',alignItems:'center',justifyContent:'center',gap:5}},
          t[1],h('span',{style:{background:isActive?'rgba(255,255,255,.12)':'var(--bg3)',padding:'1px 6px',borderRadius:99,fontSize:11,fontWeight:700}},t[2]));
      })),
    loans.length===0&&h('div',{style:{textAlign:'center',padding:'48px 0',color:'var(--text3)'}},
      h('div',{style:{marginBottom:12}},h(Ico,{name:'clipboard',size:44,color:'var(--text3)'})),
      h('p',{style:{fontWeight:600,color:'var(--text2)'}},'Sin prestamos registrados')),
    filtered.length===0&&loans.length>0&&h('div',{style:{textAlign:'center',padding:'40px 0',color:'var(--text3)'}},
      h('div',{style:{marginBottom:10}},h(Ico,{name:filtro==='Finalizados'?'check':'clipboard',size:36,color:'var(--text3)'})),
      h('p',{style:{fontWeight:600,color:'var(--text2)'}},'Sin prestamos '+(filtro==='Finalizados'?'finalizados':'activos'))),
    h('div',{style:{display:'flex',flexDirection:'column',gap:10}},
      filtered.slice().sort(function(a,b){return b.fechaInicio.localeCompare(a.fechaInicio);}).map(function(loan){
        var lp=pays.filter(function(p){return p.prestamoId===loan.id;});
        var regs=lp.filter(function(p){return !esAbono(p);});
        var paid=regs.filter(function(p){return p.estadoPago==='Pagado';}).length;
        var mora=regs.filter(function(p){return p.estadoPago==='En Mora';}).length;
        var isExp=exp===loan.id;
        // Barra de progreso por MONTO (considera abonos parciales):
        var totEsp=regs.reduce(function(s,p){return s+p.cuotaTotal;},0);
        var totRec=regs.reduce(function(s,p){
          if(p.estadoPago==='Pagado') return s+p.cuotaTotal;
          return s+(p.partialPaid||0);
        },0);
        var pct=totEsp>0?Math.round(totRec/totEsp*100):0;
        return h('div',{key:loan.id,className:'loan-card',style:{background:'var(--bg2)',borderRadius:14,border:'1px solid '+(mora>0?'var(--red-bd)':'var(--border)'),boxShadow:'var(--shadow)',overflow:'hidden',transition:'border-color .15s'}},
          h('div',{style:{padding:'13px 14px 11px'}},
            h('div',{style:{display:'flex',alignItems:'flex-start',justifyContent:'space-between',gap:8}},
              h('div',{style:{flex:1,minWidth:0}},
                h('div',{style:{display:'flex',alignItems:'center',gap:6,flexWrap:'wrap'}},
                  h('span',{style:{fontWeight:700,fontSize:14,color:'var(--text)'}},loan.nombre),
                  function(){
                    var st=loan.estado;
                    var bg=st==='Activo'?'var(--green-bg)':st==='Cancelado'?'var(--red-bg)':'var(--green-bg)';
                    var co=st==='Activo'?'var(--green)':st==='Cancelado'?'var(--red)':'var(--green)';
                    var ic=st==='Cancelado'?'x':st==='Finalizado'?'check':null;
                    return h('span',{className:'tag',style:{background:bg,color:co,display:'inline-flex',alignItems:'center',gap:3}},
                      ic&&h(Ico,{name:ic,size:10,color:co,sw:2.4}),st);
                  }(),
                  loan.modalidad==='Intereses'&&h('span',{className:'tag',style:{background:'var(--blue-bg)',color:'var(--blue)'}},'\u221E Indefinido'),
                  loan.modalidad==='Prestamo'&&h('span',{className:'tag',style:{background:'var(--yellow-bg)',color:'var(--yellow)'}},'Sin interes'),
                  loan.modalidad==='Pago Unico'&&h('span',{className:'tag',style:{background:'var(--green-bg)',color:'var(--green)'}},'Pago unico'),
                  mora>0&&h('span',{className:'tag',style:{background:'var(--red-bg)',color:'var(--red)'}},mora+' mora')),
                h('div',{style:{display:'flex',gap:8,marginTop:5,flexWrap:'wrap',alignItems:'center'}},
                  h('span',{className:'mono',style:{fontSize:13,color:'var(--green)',fontWeight:600}},loan.moneda==='USD'?'$'+fmtN(loan.montoOrigen)+' USD | '+fmt(Math.round(loan.montoOrigen*loan.trmAcordada)):fmt(Math.round(loan.montoOrigen))),
                  h('span',{style:{fontSize:13,color:'var(--border2)'}},' | '),
                  h('span',{style:{fontSize:13,color:'var(--text2)'}},loan.tasaMensual+'% mens.'),
                  h('span',{style:{fontSize:13,color:'var(--border2)'}},' | '),
                  h('span',{style:{fontSize:13,color:'var(--text2)'}},freqLabel(loan))),
                h('div',{style:{fontSize:12,color:'var(--text3)',marginTop:3}},loan.modalidad+' - '+paid+' pagadas')),
              h('div',{style:{display:'flex',gap:5,flexShrink:0}},
                loan.estado==='Activo'&&h('button',{onClick:function(){onAbono(loan);},title:'Abono a capital',style:{padding:7,background:'var(--green-bg)',border:'none',borderRadius:8,cursor:'pointer',display:'flex'}},h(Ico,{name:'dollar',size:14,color:'var(--green)',sw:1.8})),
                loan.estado==='Activo'&&onForceClose&&h('button',{onClick:function(){onForceClose(loan);},title:'Cerrar prestamo (forzar)',style:{padding:7,background:'var(--yellow-bg)',border:'none',borderRadius:8,cursor:'pointer',display:'flex'}},h(Ico,{name:'xCircle',size:14,color:'var(--yellow)',sw:1.8})),
                h('button',{onClick:function(){onEdit(loan);},title:'Editar',style:{padding:7,background:'var(--blue-bg)',border:'none',borderRadius:8,cursor:'pointer',display:'flex'}},h(Ico,{name:'edit',size:14,color:'var(--blue)',sw:1.8})),
                h('button',{onClick:function(){onDelete(loan.id);},title:'Eliminar prestamo',style:{padding:7,background:'var(--red-bg)',border:'none',borderRadius:8,cursor:'pointer',display:'flex'}},h(Ico,{name:'trash',size:14,color:'var(--red)',sw:1.8})))),
            lp.length>0&&(loan.modalidad==='Intereses'?h('div',{style:{marginTop:10,fontSize:10,color:'var(--text3)'}},paid+' cuotas pagadas \u2022 \u221E'):h('div',{style:{marginTop:10,display:'flex',alignItems:'center',gap:8}},
              h('div',{style:{flex:1,height:5,background:'var(--bg4)',borderRadius:99,overflow:'hidden'}},
                h('div',{style:{height:'100%',width:pct+'%',background:'linear-gradient(90deg,#2ea043,#3fb950)',borderRadius:99}})),
              h('span',{className:'mono',style:{fontSize:15,fontWeight:700,color:'var(--green)',flexShrink:0,minWidth:42,textAlign:'right'}},pct+'%'))),
            h('button',{onClick:function(){setExp(isExp?null:loan.id);},style:{marginTop:8,background:'none',border:'none',cursor:'pointer',color:'var(--green)',fontSize:12,fontWeight:600,display:'flex',alignItems:'center',gap:4,padding:0}},
              isExp?'Ocultar cronograma':'Ver cronograma')),
          isExp&&function(){
            // Cronograma unificado con DebtorModal, el Recibo de Abono y el PDF:
            // # / Vence / Interes / Abono a capital / Valor cuota / Saldo / Estado
            var cuotasReg=lp.filter(function(p){return !esAbono(p);}).filter(function(p){return loan.modalidad!=='Intereses'||p.estadoPago!=='Pendiente';});
            var abonos=lp.filter(function(p){return esAbono(p);});
            var esUSD=loan.moneda==='USD';
            var cronoItems=cuotasReg.slice().sort(function(a,b){return a.cuotaN-b.cuotaN;});
            // Linea de tiempo unica: cuotas + abonos intercalados por fecha, con la MISMA regla
            // de orden que generateCronogramaPDF (fechaPago y, a igualdad, cuotaN) para que la
            // app y el PDF muestren siempre la misma secuencia.
            var timeline=cronoItems.concat(abonos).sort(function(a,b){
              var c=String(a.fechaPago).localeCompare(String(b.fechaPago));
              return c!==0?c:a.cuotaN-b.cuotaN;
            });
            // La columna SALDO lee p.saldoFinal (saldo de CIERRE persistido por el backend),
            // unificada con el Recibo de Abono y el cronograma PDF. Sustituye a la antigua
            // "Deuda", que era un acumulador local del saldo de APERTURA: mostraba el saldo
            // ANTES de cada cuota (corrido un renglon respecto del resto de documentos) y
            // derivaba hasta 1 peso por recalcular en vez de leer el dato persistido.
            var cronoCols='32px 1fr 1fr 1fr 1fr 1fr 60px';
            return h('div',{style:{borderTop:'1px solid var(--bg3)'}},
              h('div',{style:{padding:'8px 10px'}},
                h('div',{style:{borderRadius:8,overflow:'hidden',border:'1px solid var(--border)'}},
                  h('div',{style:{display:'grid',gridTemplateColumns:cronoCols,background:'var(--bg4)',padding:'6px 8px',fontSize:10,fontWeight:700,color:'var(--text3)',gap:4}},
                    h('span',null,'#'),
                    h('span',null,'Vence'),
                    h('span',{style:{textAlign:'right'}},'Interes'),
                    h('span',{style:{textAlign:'right'}},'Abono a capital'),
                    h('span',{style:{textAlign:'right'}},'Valor cuota'),
                    h('span',{style:{textAlign:'right'}},'Saldo'),
                    h('span',{style:{textAlign:'center'}},'Estado')),
                  timeline.map(function(p,idx){
                    // Fila de ABONO intercalada (regla canonica '-ab-'), espejo de la del PDF:
                    // sin numero de cuota ni interes, el monto en ABONO A CAPITAL y VALOR CUOTA,
                    // y el saldo que quedo inmediatamente despues del abono.
                    if(esAbono(p)){
                      return h('div',{key:p.id,style:{display:'grid',gridTemplateColumns:cronoCols,padding:'5px 8px',fontSize:11,gap:4,borderTop:'1px solid var(--blue-bd)',background:'var(--blue-bg)'}},
                        h('span',{style:{color:'var(--blue)',fontWeight:600}},'-'),
                        h('span',{style:{color:'var(--blue)',fontStyle:'italic'}},fmtD(p.fechaPago),
                          p.observaciones&&h('div',{style:{fontSize:9,color:'var(--text3)',fontStyle:'italic'}},p.observaciones)),
                        h('span',{style:{textAlign:'right',color:'var(--text3)'}},'—'),
                        h('span',{className:'mono',style:{textAlign:'right',color:'var(--blue)',fontWeight:600}},fmt(p.abonoCapital),esUSD&&h('div',{style:{fontSize:9,color:'var(--blue)',fontWeight:400}},copToUsd(p.abonoCapital,loan.trmAcordada))),
                        h('span',{className:'mono',style:{textAlign:'right',color:'var(--blue)',fontWeight:600}},fmt(p.cuotaTotal),esUSD&&h('div',{style:{fontSize:9,color:'var(--blue)',fontWeight:400}},copToUsd(p.cuotaTotal,loan.trmAcordada))),
                        h('span',{className:'mono',style:{textAlign:'right',color:'var(--blue)',fontWeight:600}},fmt(p.saldoFinal),esUSD&&h('div',{style:{fontSize:9,color:'var(--blue)',fontWeight:400}},copToUsd(p.saldoFinal,loan.trmAcordada))),
                        h('span',{style:{textAlign:'center'}},h('span',{style:{fontSize:9,padding:'2px 6px',borderRadius:99,background:'var(--blue-bd)',color:'var(--blue)',fontWeight:600}},'Abono')));
                    }
                    var stColor=p.estadoPago==='Pagado'?'var(--green)':p.estadoPago==='En Mora'?'var(--red)':'var(--yellow)';
                    var stBg=p.estadoPago==='Pagado'?'var(--green-bg)':p.estadoPago==='En Mora'?'var(--red-bg)':'var(--yellow-bg)';
                    var hasPartial=(p.partialPaid||0)>0&&p.estadoPago!=='Pagado';
                    // Capital reconciliado (= Valor cuota - Interes), no p.abonoCapital crudo:
                    // en modalidad Prestamo el backend lo persiste en 0 (Bug #2) y la fila
                    // mostraria "0 + 0 = cuota". Ver misma doctrina en generateCronogramaPDF.
                    var capRec=Math.max(0,p.cuotaTotal-p.interesPeriodo);
                    // La sub-linea USD se reconcilia en centavos de dolar: convertir el capital
                    // en COP por separado descuadra 1 centavo (363.25 + 96.74 = 459.99 != 460.00).
                    var _trm=loan.trmAcordada||1;
                    var capRecUSD=esUSD?Math.max(0,(Math.round(p.cuotaTotal/_trm*100)-Math.round(p.interesPeriodo/_trm*100))/100):0;
                    return h('div',{key:p.id,style:{display:'grid',gridTemplateColumns:cronoCols,padding:'5px 8px',fontSize:11,gap:4,borderTop:'1px solid var(--border)',background:idx%2===0?'transparent':'var(--bg3)'}},
                      h('span',{style:{color:'var(--text3)',fontWeight:600}},p.cuotaN),
                      h('span',{style:{color:'var(--text2)'}},fmtD(p.fechaPago)),
                      h('span',{className:'mono',style:{textAlign:'right',color:'var(--text2)',fontWeight:500}},fmt(p.interesPeriodo),esUSD&&p.interesPeriodo>0&&h('div',{style:{fontSize:9,color:'var(--blue)',fontWeight:400}},copToUsd(p.interesPeriodo,loan.trmAcordada))),
                      h('span',{className:'mono',style:{textAlign:'right',color:'var(--text2)',fontWeight:500}},fmt(capRec),esUSD&&capRec>0&&h('div',{style:{fontSize:9,color:'var(--blue)',fontWeight:400}},fmtUSD(capRecUSD))),
                      h('span',{className:'mono',style:{textAlign:'right',color:'var(--text)',fontWeight:600}},fmt(p.cuotaTotal),hasPartial&&h('div',{style:{fontSize:9,color:'var(--blue)',fontWeight:600}},'-'+fmt(p.partialPaid)),esUSD&&h('div',{style:{fontSize:9,color:'var(--blue)',fontWeight:400}},copToUsd(p.cuotaTotal,loan.trmAcordada))),
                      h('span',{className:'mono',style:{textAlign:'right',color:'var(--text)',fontWeight:600}},fmt(p.saldoFinal),esUSD&&h('div',{style:{fontSize:9,color:'var(--blue)',fontWeight:400}},copToUsd(p.saldoFinal,loan.trmAcordada))),
                      h('span',{style:{textAlign:'center'}},h('span',{style:{fontSize:9,padding:'2px 6px',borderRadius:99,background:stBg,color:stColor,fontWeight:600}},p.estadoPago==='Pagado'?'Pagado':p.estadoPago==='En Mora'?'Mora':hasPartial?'Parc.':'Pend.')));
                  }))),
              // El bloque "HISTORIAL DE ABONOS A CAPITAL" que iba aqui se retiro: con los abonos
              // ya intercalados en la linea de tiempo, repetirlos abajo mostraba cada movimiento
              // dos veces. Su unico dato exclusivo (observaciones) viaja ahora como sub-linea de
              // la fila del abono, asi que no se pierde informacion.
              loan.estado==='Activo'&&function(){
                var esUSD=loan.moneda==='USD';
                var regsPag=cuotasReg.filter(function(p){return p.estadoPago==='Pagado';});
                var abonosPag=abonos.filter(function(p){return p.estadoPago==='Pagado';});
                var parcialesVivos=cuotasReg.filter(function(p){return p.estadoPago!=='Pagado'&&(p.partialPaid||0)>0;});
                if(regsPag.length===0&&abonosPag.length===0&&parcialesVivos.length===0)return null; // aun no se cobra nada
                var trm=loan.trmAcordada;
                // Fase 2: gemelo del bloque del perfil del deudor. Los rubros salen de la
                // IMPUTACION (cascada interes -> capital) sobre TODOS los pagos del prestamo, de
                // modo que un parcial en curso deja de ser invisible aqui. El gate de arriba
                // tambien tuvo que admitirlos: antes exigia al menos una cuota Pagada, asi que un
                // prestamo cuyo unico cobro fuera un parcial no mostraba el bloque en absoluto.
                var impC=cuotasReg.concat(abonos).reduce(function(a,p){var t=imputarCobros(p).totales;
                  a.cobrado+=t.cobrado; a.interes+=t.interes; a.capital+=t.capital; a.ajuste+=t.ajuste; return a;},
                  {cobrado:0,interes:0,capital:0,ajuste:0});
                var intCobrados=Math.round(impC.interes);
                var capRecHoy=Math.round(impC.capital);
                var gananciaTRM=Math.round(impC.ajuste);
                var totalRecibidoCOP=Math.round(impC.cobrado); // caja real == capital+interes+ajuste
                var gananciaTotalCOP=intCobrados+gananciaTRM;
                var efectoTRMUSD=esUSD&&trm>0?(regsPag.filter(function(p){return p.montoUSDRecibido&&p.montoUSDRecibido>0;}).reduce(function(s,p){return s+(p.montoUSDRecibido-p.cuotaTotal/trm);},0)+abonosPag.filter(function(p){return p.montoUSDRecibido&&p.montoUSDRecibido>0;}).reduce(function(s,p){return s+(p.montoUSDRecibido-p.abonoCapital/trm);},0)):0;
                var capitalUSD=esUSD&&trm>0?capRecHoy/trm:0;
                var intUSD=esUSD&&trm>0?intCobrados/trm:0;
                var totalRecibidoUSD=capitalUSD+intUSD+efectoTRMUSD;
                var gananciaTotalUSD=intUSD+efectoTRMUSD;
                function rowItem(label,value,valColor,subUSD,opts){
                  opts=opts||{};
                  var bt=opts.topBorder===false?'none':(opts.accentTop?'2px solid var(--green)':'1px solid var(--bg3)');
                  return h('div',{style:{display:'flex',justifyContent:'space-between',alignItems:opts.note?'flex-start':'center',padding:opts.master?'4px 0 10px':'8px 0',borderTop:bt,marginTop:opts.accentTop?3:0}},
                    h('div',null,
                      h('div',{style:{fontSize:opts.master?12:10,color:opts.master?'var(--text)':'var(--text3)',fontWeight:opts.master?700:600,letterSpacing:.5}},label),
                      opts.note&&h('div',{style:{fontSize:9,color:'var(--text3)',marginTop:2,fontWeight:400,letterSpacing:.2}},opts.note)),
                    h('div',{style:{textAlign:'right'}},
                      h('div',{className:'mono',style:{fontSize:opts.master?16:(opts.strong?14:13),fontWeight:(opts.master||opts.strong)?700:500,color:valColor||'var(--text)'}},value),
                      subUSD&&h('div',{className:'mono',style:{fontSize:opts.master?11:10,color:'var(--blue)',fontWeight:400}},subUSD)));
                }
                return h('div',{style:{borderTop:'1px solid var(--bg3)',padding:'12px',background:'transparent'}},
                  h('div',{style:{fontSize:11,fontWeight:600,color:'var(--green)',marginBottom:8,display:'flex',alignItems:'center',gap:6,letterSpacing:.5}},
                    h(Ico,{name:'dollar',size:13,color:'var(--green)',sw:2.4}),'RECAUDADO A LA FECHA'),
                  rowItem('TOTAL RECIBIDO',fmt(totalRecibidoCOP),'var(--text)',esUSD?fmtUSD(totalRecibidoUSD):null,{master:true,topBorder:false}),
                  rowItem('CAPITAL RECUPERADO',fmt(capRecHoy),'var(--text)',esUSD?copToUsd(capRecHoy,trm):null),
                  rowItem('INTERESES COBRADOS',(intCobrados>0?'+':'')+fmt(intCobrados),intCobrados>0?'var(--green)':'var(--text2)',esUSD&&intCobrados>0?copToUsd(intCobrados,trm):null),
                  esUSD&&rowItem('EFECTO TRM',(gananciaTRM>0?'+':gananciaTRM<0?'-':'')+fmt(Math.abs(gananciaTRM)),gananciaTRM>0?'var(--green)':gananciaTRM<0?'var(--red)':'var(--text2)',null,{note:gananciaTRM>0?'TRM subio al cobrar':gananciaTRM<0?'TRM bajo al cobrar':'Sin efecto cambiario'}),
                  esUSD&&rowItem(loan.modalidad==='Prestamo'?'RESULTADO TOTAL':'GANANCIA TOTAL',(gananciaTotalCOP<0?'-':'+')+fmt(Math.abs(gananciaTotalCOP)),gananciaTotalCOP<0?'var(--red)':gananciaTotalCOP>0?'var(--green)':'var(--text2)',(gananciaTotalUSD<0?'-':'+')+fmtUSD(Math.abs(gananciaTotalUSD)),{accentTop:true,strong:true}));
              }(),
              loan.estado!=='Activo'&&function(){
                var esCanc=loan.estado==='Cancelado';
                var esUSD=loan.moneda==='USD';
                var regsPag=cuotasReg.filter(function(p){return p.estadoPago==='Pagado';});
                var abonosPag=abonos.filter(function(p){return p.estadoPago==='Pagado';});
                var intCobrados=Math.round(regsPag.reduce(function(s,p){return s+p.interesPeriodo;},0));
                var capAbonosCOP=Math.round(abonosPag.reduce(function(s,p){return s+p.abonoCapital;},0));
                var origCOP=esUSD?Math.round(loan.montoOrigen*loan.trmAcordada):Math.round(loan.montoOrigen);
                var capPerd=Math.round(loan.capitalPerdido||0);
                var intPerd=Math.round(loan.interesesPerdidos||0);
                var totPerd=capPerd+intPerd;
                // Capital efectivamente recuperado (bruto): monto original menos lo perdido en cierre forzoso.
                var capRecuperado=esCanc?Math.max(0,origCOP-capPerd):origCOP;
                // Efecto TRM en COP (medido): diferencia entre lo cobrado en COP y el valor contractual (TRM acordada).
                //   - Cuotas regulares pagadas: montoCOPRecibido - cuotaTotal
                //   - Abonos pagados con USD:   montoCOPRecibido - (montoUSDRecibido * trmAcordada)
                var gananciaTRMReg=esUSD?regsPag.filter(function(p){return p.montoCOPRecibido&&p.montoCOPRecibido>0;}).reduce(function(s,p){return s+(p.montoCOPRecibido-p.cuotaTotal);},0):0;
                var gananciaTRMAb=esUSD?abonosPag.filter(function(p){return p.montoUSDRecibido&&p.montoUSDRecibido>0;}).reduce(function(s,p){return s+(p.montoCOPRecibido-(p.montoUSDRecibido*loan.trmAcordada));},0):0;
                var gananciaTRM=Math.round(gananciaTRMReg+gananciaTRMAb);
                // Flujo de caja COP: TOTAL RECIBIDO = capital recuperado + intereses cobrados +/- efecto TRM
                // (derivado: la suma SIEMPRE cuadra con las filas mostradas, aun en datos sin montoCOPRecibido).
                var totalRecibidoCOP=capRecuperado+intCobrados+gananciaTRM;
                var gananciaTotalCOP=intCobrados+gananciaTRM; // utilidad = total recibido - capital
                // Columna USD (Bug #25): capital/intereses contractuales + efecto TRM en USD (residual ~0:
                // los dolares llegan completos, la perdida es solo de pesos). TOTAL USD = USD realmente recibido.
                var trm=loan.trmAcordada;
                var efectoTRMUSD=esUSD&&trm>0?(regsPag.filter(function(p){return p.montoUSDRecibido&&p.montoUSDRecibido>0;}).reduce(function(s,p){return s+(p.montoUSDRecibido-p.cuotaTotal/trm);},0)+abonosPag.filter(function(p){return p.montoUSDRecibido&&p.montoUSDRecibido>0;}).reduce(function(s,p){return s+(p.montoUSDRecibido-p.abonoCapital/trm);},0)):0;
                var capitalUSD=esUSD&&trm>0?capRecuperado/trm:0;
                var intUSD=esUSD&&trm>0?intCobrados/trm:0;
                var totalRecibidoUSD=capitalUSD+intUSD+efectoTRMUSD;
                var gananciaTotalUSD=intUSD+efectoTRMUSD;
                var cuotasPagCnt=regsPag.length;
                var denomCuotas=loan.modalidad==='Intereses'?'∞':(loan.plazoMeses||cuotasReg.length||'-');
                var acento=esCanc?'var(--red)':'var(--green)';
                function rowItem(label,value,valColor,subUSD,opts){
                  opts=opts||{};
                  var bt=opts.topBorder===false?'none':(opts.accentTop?'2px solid '+acento:'1px solid var(--bg3)');
                  return h('div',{style:{display:'flex',justifyContent:'space-between',alignItems:opts.note?'flex-start':'center',padding:opts.master?'4px 0 10px':'8px 0',borderTop:bt,marginTop:opts.accentTop?3:0}},
                    h('div',null,
                      h('div',{style:{fontSize:opts.master?12:10,color:opts.master?'var(--text)':'var(--text3)',fontWeight:opts.master?700:600,letterSpacing:.5}},label),
                      opts.note&&h('div',{style:{fontSize:9,color:'var(--text3)',marginTop:2,fontWeight:400,letterSpacing:.2}},opts.note)),
                    h('div',{style:{textAlign:'right'}},
                      h('div',{className:'mono',style:{fontSize:opts.master?16:(opts.strong?14:13),fontWeight:(opts.master||opts.strong)?700:500,color:valColor||'var(--text)'}},value),
                      subUSD&&h('div',{className:'mono',style:{fontSize:opts.master?11:10,color:'var(--blue)',fontWeight:400}},subUSD)));
                }
                return h('div',{style:{borderTop:'1px solid var(--bg3)',padding:'12px',background:'transparent'}},
                  h('div',{style:{fontSize:11,fontWeight:600,color:acento,marginBottom:8,display:'flex',alignItems:'center',gap:6,letterSpacing:.5}},
                    h(Ico,{name:esCanc?'x':'check',size:13,color:acento,sw:2.4}),'RESUMEN '+(esCanc?'(CIERRE FORZOSO)':'(FINALIZADO)')),
                  // Dato maestro: TOTAL RECIBIDO (flujo de caja real)
                  rowItem('TOTAL RECIBIDO',fmt(totalRecibidoCOP),'var(--text)',esUSD?fmtUSD(totalRecibidoUSD):null,{master:true,topBorder:false}),
                  // Desglose que compone el total
                  rowItem(esCanc?'CAPITAL RECUPERADO':'CAPITAL PRESTADO',fmt(capRecuperado),'var(--text)',esUSD?copToUsd(capRecuperado,trm):null),
                  rowItem('INTERESES COBRADOS',(intCobrados>0?'+':'')+fmt(intCobrados),intCobrados>0?'var(--green)':'var(--text2)',esUSD&&intCobrados>0?copToUsd(intCobrados,trm):null),
                  esUSD&&rowItem('EFECTO TRM',(gananciaTRM>0?'+':gananciaTRM<0?'-':'')+fmt(Math.abs(gananciaTRM)),gananciaTRM>0?'var(--green)':gananciaTRM<0?'var(--red)':'var(--text2)',null,{note:gananciaTRM>0?'TRM subio al cobrar':gananciaTRM<0?'TRM bajo al cobrar':'Sin efecto cambiario'}),
                  // Subtotal de utilidad (solo USD; en COP la ganancia = intereses, seria redundante)
                  esUSD&&rowItem(loan.modalidad==='Prestamo'?'RESULTADO TOTAL':'GANANCIA TOTAL',(gananciaTotalCOP<0?'-':'+')+fmt(Math.abs(gananciaTotalCOP)),gananciaTotalCOP<0?'var(--red)':gananciaTotalCOP>0?'var(--green)':'var(--text2)',(gananciaTotalUSD<0?'-':'+')+fmtUSD(Math.abs(gananciaTotalUSD)),{accentTop:true,strong:true}),
                  rowItem('CUOTAS PAGADAS',cuotasPagCnt+(loan.modalidad==='Intereses'?'':'/'+denomCuotas)),
                  capAbonosCOP>0&&rowItem('TOTAL ABONOS A CAPITAL',fmt(capAbonosCOP),'var(--blue)',esUSD?copToUsd(capAbonosCOP,trm):null),
                  esCanc&&rowItem('CAPITAL DEBIENDO',fmt(capPerd),capPerd>0?'var(--red)':'var(--text2)',esUSD&&capPerd>0?copToUsd(capPerd,trm):null),
                  esCanc&&rowItem('INTERESES DEBIENDO',fmt(intPerd),intPerd>0?'var(--red)':'var(--text2)',esUSD&&intPerd>0?copToUsd(intPerd,trm):null),
                  esCanc&&h('div',{style:{marginTop:12,padding:'10px 12px',background:'var(--bg3)',borderRadius:8,borderLeft:'3px solid var(--red)',display:'flex',justifyContent:'space-between',alignItems:'center'}},
                    h('div',null,
                      h('div',{style:{fontSize:10,color:'var(--text2)',fontWeight:600,letterSpacing:.5}},'MONTO TOTAL PERDIDO'),
                      h('div',{style:{fontSize:10,color:'var(--text3)',marginTop:2}},'Capital + intereses en mora')),
                    h('div',{className:'mono',style:{fontSize:16,fontWeight:700,color:'var(--red)'}},'-'+fmt(totPerd))));
              }());
          }());
      })));
}
