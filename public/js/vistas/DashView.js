// public/js/vistas/DashView.js — Inicio: KPIs, acciones rapidas y las 4 tarjetas de seguimiento.
//
// Extraido de `app.js` en la Etapa 3 (B7) del refactor. Codigo VERBATIM.
//
// El estado global sigue viviendo en `App` y baja por PROPS, igual que antes.
// Sin Context API y sin store: eso seria rediseno, no refactor.

import { SparklineChart } from '../componentes/SparklineChart.js';
import { Ico } from '../componentes/iconos.js';
import { cobrosDe, imputarCobros, pendCuota } from '../core/dominio.js';
import { copToUsd, fmt, fmtD, fmtN, fmtUSD } from '../core/format.js';
import { h, useMemo, useState } from '../core/react.js';
import { nowStr } from '../core/ui.js';
import { esAbono } from '../core/ids.js';

export function DashView(props){
  var metrics=props.metrics,isEmpty=props.isEmpty,onNav=props.onNav,loans=props.loans||[],pays=props.pays||[],onNameClick=props.onNameClick,onNewLoan=props.onNewLoan;
  var loanMap={};loans.forEach(function(l){loanMap[l.id]=l;});
  var pct=metrics.esperado>0?Math.round(metrics.recibido/metrics.esperado*100):0;
  var _recOpen=useState(false);var recaudoOpen=_recOpen[0];var setRecaudoOpen=_recOpen[1];
  // ── Selector de mes en la tarjeta "Recaudo" ────────────────────────────────
  // Solo ESTA tarjeta pagina; el KPI "Cobros del Mes" sigue fijo en el mes actual
  // (usa el metrics global). El default es el mes en curso.
  var _selM=useState(nowStr().slice(0,7));var selMonth=_selM[0];var setSelMonth=_selM[1];
  function shiftMonth(delta){
    var y=parseInt(selMonth.slice(0,4),10),m=parseInt(selMonth.slice(5,7),10)-1+delta;
    var dd=new Date(y,m,1);
    setSelMonth(dd.getFullYear()+'-'+String(dd.getMonth()+1).padStart(2,'0'));
  }
  var MESES_ES=['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
  var selMonthLabel=MESES_ES[parseInt(selMonth.slice(5,7),10)-1]+' De '+selMonth.slice(0,4);
  // Recaudo del mes seleccionado (hibrido aprobado): cuotas Pagadas se cuentan por fecha
  // de transaccion (fechaRecaudo) -> la mora vieja cobrada este mes cuenta este mes; los
  // parciales EN CURSO se cuentan por fechaPago (unica fecha disponible para un parcial).
  var recaudoMes=useMemo(function(){
    var noAb=function(p){return !esAbono(p);};
    var dueMes=pays.filter(function(p){return noAb(p)&&p.fechaPago.startsWith(selMonth);});
    var paidMes=pays.filter(function(p){return noAb(p)&&p.estadoPago==='Pagado'&&p.fechaRecaudo&&p.fechaRecaudo.startsWith(selMonth);});
    var esperado=dueMes.reduce(function(s,p){return s+p.cuotaTotal;},0);
    var recibA=paidMes.reduce(function(s,p){return s+(p.montoCOPRecibido||p.cuotaTotal);},0);
    var recibB=dueMes.reduce(function(s,p){return p.estadoPago!=='Pagado'?s+(p.partialPaid||0):s;},0);
    var seen={},list=[];
    dueMes.concat(paidMes).forEach(function(p){if(!seen[p.id]){seen[p.id]=1;list.push(p);}});
    list.sort(function(a,b){return a.fechaPago.localeCompare(b.fechaPago)||a.nombreCliente.localeCompare(b.nombreCliente);});
    return {esperado:esperado,recibido:recibA+recibB,list:list};
  },[pays,selMonth]);
  var hayMeta=recaudoMes.esperado>0;
  var pctMes=hayMeta?Math.round(recaudoMes.recibido/recaudoMes.esperado*100):0;
  var pctTxt=hayMeta?pctMes+'%':'—';
  var hayReg=pays.some(function(p){return !esAbono(p);});
  // v1.9.x — Metricas adicionales calculadas desde loans/pays
  var activos=loans.filter(function(l){return l.estado==='Activo';});
  var capOriginal=activos.reduce(function(s,l){return s+(l.moneda==='USD'?Math.round(l.montoOrigen*l.trmAcordada):Math.round(l.montoOrigen));},0);
  var deudoresUnicos=(function(){var set={};activos.forEach(function(l){set[l.nombre.trim().toLowerCase()]=1;});return Object.keys(set).length;})();
  var prestamosCOP=activos.filter(function(l){return l.moneda==='COP';}).length;
  var prestamosUSD=activos.filter(function(l){return l.moneda==='USD';}).length;
  // Saldo real por prestamo (formula confiable: originalCOP - capitalPagado - partialPaid)
  var loanSaldoMap={};
  loans.forEach(function(l){
    if(l.estado!=='Activo'){loanSaldoMap[l.id]=0;return;}
    var lp=pays.filter(function(p){return p.prestamoId===l.id;});
    var orig=l.moneda==='USD'?Math.round(l.montoOrigen*l.trmAcordada):Math.round(l.montoOrigen);
    // Fase 3: capital vivo por capital IMPUTADO (mismo criterio que el KPI del Inicio, el perfil
    // del deudor y Rendimiento). Alimenta el "Saldo: $X" de las cards de Vence Hoy / Proximos 7
    // dias / Mora, que antes restaban el parcial completo y discrepaban del resto de la app.
    var capImp=lp.reduce(function(a,p){return a+imputarCobros(p).totales.capital;},0);
    loanSaldoMap[l.id]=Math.max(0,orig-Math.round(capImp));
  });
  // Transacciones del mes: TODOS los pagos Pagados (cuotas regulares + abonos) cuya fecha de recaudo
  // cae en el mes actual, ordenados por paidAt (hora real) desc. La card tiene scroll interno.
  var thisMonthTx=nowStr().slice(0,7);
  // v2.1 FIX — la tarjeta lista EVENTOS DE CAJA reales (ledger `recibos`, via cobrosDe), no
  // cuotas marcadas 'Pagado'. Antes exigia `estadoPago==='Pagado'` y, sin fechaRecaudo, caia a
  // `fechaPago` (que es la fecha de VENCIMIENTO, no la de recaudo). Consecuencia: un PAGO PARCIAL
  // en curso —que NO cambia estadoPago ni escribe fechaRecaudo/paidAt— jamas aparecia, pese a ser
  // dinero realmente recibido; y cualquier fila sin fechaRecaudo se ubicaba por su vencimiento.
  // Ahora comparte fuente con el KPI "Cobros del Mes" y con sparkCobros: los tres iteran cobrosDe,
  // asi que cuadran POR CONSTRUCCION. Cada evento del ledger es su propia fila, en la fecha REAL
  // en que entro el dinero (un parcial hoy + el remanente manana = dos transacciones distintas).
  var monthTxs=[];
  pays.forEach(function(p){
    var evs=cobrosDe(p);
    evs.forEach(function(ev,k){
      if(String(ev.fecha).slice(0,7)!==thisMonthTx) return;
      monthTxs.push({pay:p,fecha:ev.fecha,cop:ev.cop,k:k,nEv:evs.length});
    });
  });
  monthTxs.sort(function(a,b){
    var c=String(b.fecha).localeCompare(String(a.fecha));            // fecha real del movimiento
    if(c!==0) return c;
    return String(b.pay.paidAt||'').localeCompare(String(a.pay.paidAt||'')); // hora real (v1.11.1)
  });
  // Sparkline "Ganancias": ganancia recibida por mes (ultimos 12 meses), agrupada por fechaRecaudo.
  // Misma definicion de ganancia que el KPI total: USD -> montoCOPRecibido - (cuotaTotal - interesPeriodo); COP -> interesPeriodo. Excluye abonos.
  var sparkGanancias=useMemo(function(){
    var moneda={};loans.forEach(function(l){moneda[l.id]=l.moneda;});
    var byMonth={};
    pays.forEach(function(p){
      if(p.estadoPago!=='Pagado'||!p.fechaRecaudo||esAbono(p)) return;
      var ym=p.fechaRecaudo.slice(0,7);
      var g=(moneda[p.prestamoId]==='USD'&&p.montoCOPRecibido>0)?(p.montoCOPRecibido-(p.cuotaTotal-p.interesPeriodo)):p.interesPeriodo;
      byMonth[ym]=(byMonth[ym]||0)+g;
    });
    var base=new Date(nowStr()+'T12:00:00'),vals=[],labs=[],tips=[];
    for(var i=11;i>=0;i--){
      var d=new Date(base.getFullYear(),base.getMonth()-i,1);
      var ab=MESES_ES[d.getMonth()].slice(0,3);
      vals.push(Math.round(byMonth[d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')]||0));
      // 12 meses: etiqueta X cada 2 (incluye el mes actual) para no amontonar; el tooltip los tiene todos
      labs.push((vals.length-1)%2===1 ? ab : '');
      tips.push(ab+' '+d.getFullYear());
    }
    return {values:vals,labels:labs,tipLabels:tips};
  },[pays,loans]);
  // Sparkline "Cobros del Mes": evolucion DIARIA del mes EN CURSO (fijo — ignora selMonth).
  // Suma por dia los eventos de caja via cobrosDe(): ledger de recibos (cada parcial en su dia +
  // pago final) con fallback a fechaRecaudo. Incluye parciales en curso y abonos a capital. Misma
  // base que el KPI metrics.recibido -> el total del KPI == suma de los puntos de este grafico.
  var sparkCobros=useMemo(function(){
    var curM=nowStr().slice(0,7);
    var y=parseInt(curM.slice(0,4),10),mo=parseInt(curM.slice(5,7),10),dim=new Date(y,mo,0).getDate();
    var byDay={};
    pays.forEach(function(p){
      cobrosDe(p).forEach(function(e){
        if(e.fecha.slice(0,7)!==curM) return;
        var dd=parseInt(e.fecha.slice(8,10),10);
        byDay[dd]=(byDay[dd]||0)+e.cop;
      });
    });
    var monAb=MESES_ES[mo-1].slice(0,3);
    var keyDays={1:1,8:1,15:1,22:1,29:1},vals=[],labs=[],tips=[];
    for(var d=1;d<=dim;d++){vals.push(Math.round(byDay[d]||0));labs.push(keyDays[d]?String(d):'');tips.push(d+' '+monAb);}
    return {values:vals,labels:labs,tipLabels:tips};
  },[pays]);
  // KPIs (v1.9.x — diferenciados sin redundancia: ORIGINAL (historico) vs PENDIENTE (actual))
  var kpis=[
    {icon:'briefcase',label:'Capital Original',val:fmt(capOriginal),sub:'Total prestado · '+activos.length+' activo'+(activos.length===1?'':'s'),accent:'blue'},
    {icon:'dollar',   label:'Cobros del Mes',val:fmt(metrics.recibido),sub:pct+'% de $'+fmtN(metrics.esperado)+' esperado',accent:'green',spark:sparkCobros,sparkColor:'var(--green)'},
    {icon:'clock',    label:'Saldo Pendiente',val:fmt(metrics.totalCartera),sub:'Capital por recuperar (actual)',accent:'yellow'},
    {icon:'trending', label:'Ganancias',val:fmt(metrics.totalInteresesRecibidos),sub:'Historico total',accent:'green',spark:sparkGanancias,sparkColor:'var(--green)'}
  ];
  // Acciones rapidas
  var quickActions=[
    {icon:'plus',label:'Nuevo',color:'var(--green)',onClick:function(){if(onNewLoan)onNewLoan();else onNav('cartera');}},
    {icon:'dollar',label:'Pagos',color:'var(--blue)',onClick:function(){onNav('pagos');}},
    {icon:'users',label:'Deudores',color:'var(--yellow)',onClick:function(){onNav('deudores');}},
    {icon:'calc',label:'Calculadora',color:'var(--text)',onClick:function(){onNav('calculadora');}}
  ];
  // Estilo unificado para chips compactos
  var chipStyle={display:'inline-flex',alignItems:'center',gap:5,padding:'5px 10px',background:'var(--bg2)',border:'1px solid var(--border)',borderRadius:99,fontSize:11,fontWeight:600,color:'var(--text2)'};
  // Helper: tipo de transaccion para mostrar en Transacciones Recientes
  function tipoTx(p,l){
    if(esAbono(p)) return 'Abono a capital';
    if(!l) return 'Cuota '+p.cuotaN;
    if(l.modalidad==='Intereses') return 'Cuota intereses #'+p.cuotaN;
    if(l.modalidad==='Prestamo') return 'Devolucion capital';
    if(l.modalidad==='Pago Unico') return 'Pago unico';
    return 'Cuota #'+p.cuotaN;
  }
  // Helper: empty state centrado vertical y horizontal. Toma 100% de la altura del
  // contenedor padre (.dash-list-body con height fijo 300px) y centra el mensaje con flex.
  function emptyMsg(text){
    return h('div',{style:{height:'100%',width:'100%',padding:'12px',textAlign:'center',color:'var(--text3)',fontSize:12,fontWeight:500,opacity:.75,fontStyle:'italic',display:'flex',alignItems:'center',justifyContent:'center'}},text);
  }
  return h('div',{className:'fade-in dash-container'},
    // ── KPI CARDS (2x2 grid) ────────────────────────────────────────────
    h('div',{style:{display:'grid',gridTemplateColumns:'repeat(2,1fr)',gap:10,marginBottom:14}},
      kpis.map(function(k){
        return h('div',{key:k.label,style:{position:'relative',overflow:'hidden',background:'var(--bg2)',borderRadius:14,padding:'14px',border:'1px solid var(--border)',boxShadow:'var(--shadow)',transition:'all .15s',minHeight:120}},
          h('div',{style:{position:'relative',zIndex:1,display:'flex',alignItems:'center',gap:8,marginBottom:10}},
            h('div',{style:{width:32,height:32,borderRadius:9,background:'var(--'+k.accent+'-bg)',display:'flex',alignItems:'center',justifyContent:'center',flexShrink:0}},
              h(Ico,{name:k.icon,size:16,color:'var(--'+k.accent+')',sw:2.2})),
            h('div',{style:{fontSize:10,fontWeight:700,color:'var(--text3)',letterSpacing:.6,textTransform:'uppercase'}},k.label)),
          h('div',{style:{position:'relative',zIndex:1,maxWidth:k.spark?'calc(100% - 322px)':'none'}},
            h('div',{className:'mono',style:{fontSize:17,fontWeight:700,color:'var(--text)',letterSpacing:-.3,lineHeight:1.1,whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis'}},k.val),
            h('div',{style:{fontSize:11,color:'var(--text3)',marginTop:4,whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis'}},k.sub)),
          k.spark&&h('div',{style:{position:'absolute',right:16,bottom:10,zIndex:3}},
            h(SparklineChart,{data:k.spark.values,labels:k.spark.labels,tipLabels:k.spark.tipLabels,color:k.sparkColor||'var(--green)',id:k.label,width:298,height:98})));
      })),
    // ── ACCIONES RAPIDAS (4 cols grid) ──────────────────────────────────
    h('div',{style:{display:'grid',gridTemplateColumns:'repeat(4,1fr)',gap:8,marginBottom:14}},
      quickActions.map(function(a){
        return h('button',{key:a.label,onClick:a.onClick,style:{padding:'12px 6px',background:'var(--bg2)',border:'1px solid var(--border)',borderRadius:12,cursor:'pointer',display:'flex',flexDirection:'column',alignItems:'center',gap:6,fontFamily:'inherit',transition:'all .15s'}},
          h('div',{style:{width:36,height:36,borderRadius:10,background:'var(--bg3)',display:'flex',alignItems:'center',justifyContent:'center'}},
            h(Ico,{name:a.icon,size:18,color:a.color,sw:2.2})),
          h('div',{style:{fontSize:11,fontWeight:600,color:'var(--text2)'}},a.label));
      })),
    // ── STATS CHIPS (compactos) ─────────────────────────────────────────
    activos.length>0&&h('div',{style:{display:'flex',gap:6,flexWrap:'wrap',marginBottom:16}},
      h('div',{style:chipStyle},h(Ico,{name:'users',size:11,color:'var(--text3)',sw:2}),' ',deudoresUnicos+' '+(deudoresUnicos===1?'deudor':'deudores')),
      prestamosCOP>0&&h('div',{style:chipStyle},prestamosCOP+(prestamosCOP===1?' COP':' en COP')),
      prestamosUSD>0&&h('div',{style:Object.assign({},chipStyle,{color:'var(--blue)',background:'var(--blue-bg)',border:'1px solid var(--blue-bd)'})},prestamosUSD+(prestamosUSD===1?' USD':' en USD')),
      metrics.mora.length>0&&h('div',{style:Object.assign({},chipStyle,{color:'var(--red)',background:'var(--red-bg)',border:'1px solid var(--red-bd)'})},h(Ico,{name:'alert',size:10,color:'var(--red)',sw:2.2}),' ',metrics.mora.length+(metrics.mora.length===1?' cuota mora':' cuotas mora'))),
    // ── RECAUDO DEL MES (progress bar collapsible) ──────────────────────
    // v1.9.x — si pct > 100 (se supero la meta gracias a mora recuperada), la barra se capa
    // visualmente al 100% pero el % real se renderiza y se cambia el color a dorado.
    hayReg&&function(){
      var sobrecumplido=hayMeta&&pctMes>100;
      var barGradient=sobrecumplido?'linear-gradient(90deg,#bb8009,var(--yellow))':'linear-gradient(90deg,#2ea043,#3fb950)';
      var pctColor=sobrecumplido?'var(--yellow)':hayMeta?'var(--green)':'var(--text3)';
      return h('div',{style:{background:'var(--bg2)',borderRadius:14,padding:'13px 14px',border:'1px solid '+(sobrecumplido?'var(--yellow)':'var(--border)'),marginBottom:16,transition:'border-color .3s'}},
        h('div',{style:{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:10,gap:8}},
          h('div',{onClick:function(){setRecaudoOpen(!recaudoOpen);},style:{display:'flex',alignItems:'center',gap:8,cursor:'pointer',minWidth:0}},
            h('span',{style:{fontWeight:600,fontSize:14,color:'var(--text)'}},'Recaudo'),
            sobrecumplido&&h('span',{style:{fontSize:10,fontWeight:700,color:'var(--yellow)',background:'var(--yellow-bg)',padding:'2px 7px',borderRadius:99,letterSpacing:.4}},'META SUPERADA'),
            h(Ico,{name:recaudoOpen?'chevron-up':'chevron-down',size:14,color:'var(--text3)',sw:2})),
          h('div',{style:{display:'flex',alignItems:'center',gap:10,flexShrink:0}},
            h('div',{onClick:function(e){e.stopPropagation();},style:{display:'inline-flex',alignItems:'center',gap:1,background:'var(--bg4)',borderRadius:99,padding:'2px 3px'}},
              h('button',{onClick:function(e){e.stopPropagation();shiftMonth(-1);},title:'Mes anterior',style:{display:'flex',alignItems:'center',background:'none',border:'none',cursor:'pointer',padding:3,borderRadius:99,fontFamily:'inherit'}},h(Ico,{name:'chevleft',size:14,color:'var(--blue)',sw:2.5})),
              h('span',{style:{fontSize:12,fontWeight:700,color:'var(--blue)',minWidth:108,textAlign:'center',userSelect:'none'}},selMonthLabel),
              h('button',{onClick:function(e){e.stopPropagation();shiftMonth(1);},title:'Mes siguiente',style:{display:'flex',alignItems:'center',background:'none',border:'none',cursor:'pointer',padding:3,borderRadius:99,fontFamily:'inherit'}},h(Ico,{name:'chevright',size:14,color:'var(--blue)',sw:2.5}))),
            h('span',{className:'mono',style:{fontWeight:700,fontSize:16,color:pctColor,transition:'color .3s'}},pctTxt))),
        h('div',{style:{height:8,background:'var(--bg4)',borderRadius:99,overflow:'hidden'}},
          h('div',{style:{height:'100%',width:(hayMeta?Math.min(pctMes,100):0)+'%',maxWidth:'100%',background:barGradient,borderRadius:99,transition:'width .6s ease, background .3s'}})),
        h('div',{style:{display:'flex',justifyContent:'space-between',marginTop:6,fontSize:12,color:'var(--text3)'}},
          h('span',null,'Recibido: '+fmt(recaudoMes.recibido)),
          h('span',null,hayMeta?('Esperado: '+fmt(recaudoMes.esperado)):'Sin vencimientos este mes')),
      recaudoOpen&&recaudoMes.list.length>0&&h('div',{style:{marginTop:12,borderTop:'1px solid var(--border)',paddingTop:10}},
        recaudoMes.list.map(function(p,i){
          var pl=loanMap[p.prestamoId];
          var isU=pl&&pl.moneda==='USD';
          var pagado=p.estadoPago==='Pagado';
          var enMora=p.estadoPago==='En Mora';
          var hasPartial=(p.partialPaid||0)>0&&!pagado;
          var valor=pagado?p.cuotaTotal:pendCuota(p);
          var tipo=pl?(pl.modalidad==='Intereses'?'intereses':pl.modalidad==='Capital + Intereses'?'capital + intereses':pl.modalidad==='Prestamo'?'capital':pl.modalidad==='Pago Unico'?'pago unico':''):'';
          return h('div',{key:p.id,style:{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'6px 0',borderTop:i>0?'1px solid var(--border-light, rgba(255,255,255,.06))':'none',opacity:pagado?.55:1}},
            h('div',{style:{minWidth:0,flex:1}},
              h('div',{style:{display:'flex',alignItems:'center',gap:6}},
                pagado&&h(Ico,{name:'check',size:11,color:'var(--green)',sw:2.5}),
                enMora&&h(Ico,{name:'alert',size:11,color:'var(--red)',sw:2}),
                h('span',{onClick:function(){onNameClick(p.nombreCliente);},style:{fontWeight:500,fontSize:13,color:'var(--text)',cursor:'pointer',textDecoration:'underline',textDecorationColor:'var(--bg4)',textUnderlineOffset:2}},p.nombreCliente),
                hasPartial&&h('span',{className:'tag',style:{background:'var(--blue-bg)',color:'var(--blue)',fontSize:9,padding:'1px 5px'}},'PARCIAL')),
              h('div',{style:{fontSize:11,color:enMora?'var(--red)':'var(--text3)',marginTop:1}},
                fmtD(p.fechaPago)+' \u2022 '+tipo+(enMora?' \u2022 en mora':'')),
              hasPartial&&h('div',{className:'mono',style:{fontSize:10,color:'var(--blue)',marginTop:1}},'Abonado '+fmt(p.partialPaid)+' de '+fmt(p.cuotaTotal))),
            h('div',{style:{textAlign:'right',flexShrink:0}},
              h('div',{className:'mono',style:{fontWeight:300,fontSize:13,color:pagado?'var(--green)':enMora?'var(--red)':hasPartial?'var(--blue)':'var(--text)'}},fmt(valor)),
              isU&&h('div',{className:'mono',style:{fontSize:11,color:'var(--blue)'}},copToUsd(valor,pl.trmAcordada))));
        })));
    }(),
    // ── GRID 2x2 (v1.9.x — wrapper responsivo, 2 cols ESTRICTAS desktop).
    // Las 4 secciones SIEMPRE se renderizan (con empty state si no hay datos)
    // para preservar la cuadricula 2x2 perfecta.
    h('div',{className:'dash-lists'},
      // ── VENCE HOY ─────────────────────────────────────────────────────
      h('div',{className:'dash-card',style:{background:'rgba(187,128,9,.08)',border:'1px solid var(--yellow)'}},
        h('div',{className:'dash-card-header'},
          h('div',{style:{display:'flex',alignItems:'center',gap:6}},
            h(Ico,{name:'calendar',size:14,color:'var(--yellow)'}),
            h('span',{style:{fontWeight:700,fontSize:14,color:'var(--yellow)'}},'Vence Hoy')),
          metrics.hoy.length>0&&h('span',{className:'mono',style:{fontSize:12,fontWeight:500,color:'var(--yellow)',opacity:.8}},'Total: '+fmt(metrics.hoy.reduce(function(s,p){return s+pendCuota(p);},0)))),
        h('div',{className:'dash-list-body'},
        metrics.hoy.length===0
          ? emptyMsg('¡No hay cuotas por vencer hoy!')
          : metrics.hoy.map(function(p,i){
              var pl=loanMap[p.prestamoId];var isU=pl&&pl.moneda==='USD';
              var hasPartial=(p.partialPaid||0)>0;var val=pendCuota(p);
              var saldoL=loanSaldoMap[p.prestamoId]||0;
              return h('div',{key:p.id,style:{display:'flex',justifyContent:'space-between',alignItems:'flex-start',padding:'10px 0',borderTop:i>0?'1px solid rgba(187,128,9,.15)':'none',gap:10}},
                h('div',{style:{minWidth:0,flex:1}},
                  h('div',{style:{display:'flex',alignItems:'center',gap:6,flexWrap:'wrap'}},
                    h('span',{onClick:function(){onNameClick(p.nombreCliente);},style:{fontWeight:600,fontSize:14,color:'var(--text)',cursor:'pointer',textDecoration:'underline',textDecorationColor:'var(--bg4)',textUnderlineOffset:2}},p.nombreCliente),
                    hasPartial&&h('span',{className:'tag',style:{background:'var(--blue-bg)',color:'var(--blue)',fontSize:9,padding:'1px 5px'}},'PARCIAL')),
                  h('div',{style:{fontSize:11,color:'var(--text3)',marginTop:2}},'Cuota '+p.cuotaN+' · Cobrar hoy'),
                  hasPartial&&h('div',{className:'mono',style:{fontSize:10,color:'var(--blue)',marginTop:1}},'Abonado '+fmt(p.partialPaid)+' de '+fmt(p.cuotaTotal))),
                h('div',{style:{textAlign:'right',flexShrink:0}},
                  h('div',{className:'mono',style:{fontWeight:700,fontSize:19,color:'var(--yellow)',lineHeight:1.1,letterSpacing:-.3}},fmt(val)),
                  isU&&h('div',{className:'mono',style:{fontSize:11,color:'var(--blue)',marginTop:1}},copToUsd(val,pl.trmAcordada)),
                  saldoL>0&&h('div',{className:'mono',style:{fontSize:10,fontWeight:400,color:'var(--text3)',marginTop:3}},'Saldo: '+fmt(saldoL))));
            }))),
      // ── PROXIMOS 7 DIAS ───────────────────────────────────────────────
      h('div',{className:'dash-card',style:{background:'rgba(187,128,9,.04)',border:'1px solid rgba(187,128,9,.3)'}},
        h('div',{className:'dash-card-header'},
          h('div',{style:{display:'flex',alignItems:'center',gap:6}},
            h(Ico,{name:'clock',size:14,color:'var(--yellow)'}),
            h('span',{style:{fontWeight:700,fontSize:14,color:'var(--yellow)'}},'Proximos 7 dias')),
          metrics.proximos.length>0&&h('span',{className:'mono',style:{fontSize:12,fontWeight:500,color:'var(--yellow)',opacity:.8}},metrics.proximos.length+' '+(metrics.proximos.length===1?'cuota':'cuotas'))),
        h('div',{className:'dash-list-body'},
        metrics.proximos.length===0
          ? emptyMsg('¡No hay cuotas próximas a vencer!')
          : metrics.proximos.slice(0,8).map(function(p,i){
              var pl=loanMap[p.prestamoId];var isU=pl&&pl.moneda==='USD';
              var dias=Math.ceil((new Date(p.fechaPago+'T12:00:00')-new Date(nowStr()+'T12:00:00'))/86400000);
              var hasPartial=(p.partialPaid||0)>0;var val=pendCuota(p);
              var saldoL=loanSaldoMap[p.prestamoId]||0;
              return h('div',{key:p.id,style:{display:'flex',justifyContent:'space-between',alignItems:'flex-start',padding:'10px 0',borderTop:i>0?'1px solid rgba(187,128,9,.12)':'none',gap:10}},
                h('div',{style:{minWidth:0,flex:1}},
                  h('div',{style:{display:'flex',alignItems:'center',gap:6,flexWrap:'wrap'}},
                    h('span',{onClick:function(){onNameClick(p.nombreCliente);},style:{fontWeight:600,fontSize:14,color:'var(--text)',cursor:'pointer',textDecoration:'underline',textDecorationColor:'var(--bg4)',textUnderlineOffset:2}},p.nombreCliente),
                    hasPartial&&h('span',{className:'tag',style:{background:'var(--blue-bg)',color:'var(--blue)',fontSize:9,padding:'1px 5px'}},'PARCIAL')),
                  h('div',{style:{fontSize:11,color:'var(--text3)',marginTop:2}},'Cuota '+p.cuotaN+' · en '+dias+' dia'+(dias>1?'s':'')),
                  hasPartial&&h('div',{className:'mono',style:{fontSize:10,color:'var(--blue)',marginTop:1}},'Abonado '+fmt(p.partialPaid)+' de '+fmt(p.cuotaTotal))),
                h('div',{style:{textAlign:'right',flexShrink:0}},
                  h('div',{className:'mono',style:{fontWeight:700,fontSize:19,color:'var(--yellow)',lineHeight:1.1,letterSpacing:-.3}},fmt(val)),
                  isU&&h('div',{className:'mono',style:{fontSize:11,color:'var(--blue)',marginTop:1}},copToUsd(val,pl.trmAcordada)),
                  saldoL>0&&h('div',{className:'mono',style:{fontSize:10,fontWeight:400,color:'var(--text3)',marginTop:3}},'Saldo: '+fmt(saldoL))));
            }))),
      // ── PAGOS EN MORA ─────────────────────────────────────────────────
      h('div',{className:'dash-card',style:{background:'var(--red-bg)',border:'1px solid var(--red-bd)'}},
        h('div',{className:'dash-card-header'},
          h('div',{style:{display:'flex',alignItems:'center',gap:6}},
            h(Ico,{name:'alert',size:14,color:'var(--red)',sw:2.2}),
            h('span',{style:{fontWeight:700,fontSize:14,color:'var(--red)'}},'Pagos en Mora')),
          metrics.mora.length>0&&h('button',{onClick:function(){onNav('pagos');},style:{fontSize:12,color:'var(--red)',fontWeight:600,background:'none',border:'none',cursor:'pointer',fontFamily:'inherit'}},'Ver todos →')),
        h('div',{className:'dash-list-body'},
        metrics.mora.length===0
          ? emptyMsg('¡Excelente! No hay pagos en mora.')
          : metrics.mora.map(function(p,i){
              var pl=loanMap[p.prestamoId];var isU=pl&&pl.moneda==='USD';
              var hasPartial=(p.partialPaid||0)>0;var val=pendCuota(p);
              var saldoL=loanSaldoMap[p.prestamoId]||0;
              return h('div',{key:p.id,style:{display:'flex',justifyContent:'space-between',alignItems:'flex-start',padding:'10px 0',borderTop:i>0?'1px solid rgba(248,81,73,.15)':'none',gap:10}},
                h('div',{style:{minWidth:0,flex:1}},
                  h('div',{style:{display:'flex',alignItems:'center',gap:6,flexWrap:'wrap'}},
                    h('span',{onClick:function(){onNameClick(p.nombreCliente);},style:{fontWeight:600,fontSize:14,color:'var(--text)',cursor:'pointer',textDecoration:'underline',textDecorationColor:'var(--bg4)',textUnderlineOffset:2}},p.nombreCliente),
                    hasPartial&&h('span',{className:'tag',style:{background:'var(--blue-bg)',color:'var(--blue)',fontSize:9,padding:'1px 5px'}},'PARCIAL')),
                  h('div',{style:{fontSize:11,color:'var(--text3)',marginTop:2}},'Cuota '+p.cuotaN+' · Vencio '+fmtD(p.fechaPago)),
                  hasPartial&&h('div',{className:'mono',style:{fontSize:10,color:'var(--blue)',marginTop:1}},'Abonado '+fmt(p.partialPaid)+' de '+fmt(p.cuotaTotal))),
                h('div',{style:{textAlign:'right',flexShrink:0}},
                  h('div',{className:'mono',style:{fontWeight:700,fontSize:19,color:'var(--red)',lineHeight:1.1,letterSpacing:-.3}},fmt(val)),
                  isU&&h('div',{className:'mono',style:{fontSize:11,color:'var(--blue)',marginTop:1}},copToUsd(val,pl.trmAcordada)),
                  saldoL>0&&h('div',{className:'mono',style:{fontSize:10,fontWeight:400,color:'var(--text3)',marginTop:3}},'Saldo: '+fmt(saldoL))));
            }))),
      // ── TRANSACCIONES DEL MES ─────────────────────────────────────────
      h('div',{className:'dash-card',style:{background:'var(--bg2)',border:'1px solid var(--border)',boxShadow:'var(--shadow)'}},
        h('div',{className:'dash-card-header'},
          h('div',{style:{display:'flex',alignItems:'center',gap:6}},
            h(Ico,{name:'activity',size:14,color:'var(--green)',sw:2.2}),
            h('span',{style:{fontSize:14,fontWeight:700,color:'var(--text)'}},'Transacciones del Mes')),
          h('button',{onClick:function(){onNav('historial');},style:{fontSize:12,color:'var(--text3)',fontWeight:600,background:'none',border:'none',cursor:'pointer',fontFamily:'inherit'}},'Ver historial →')),
        h('div',{className:'dash-list-body'},
          monthTxs.length===0
            ? emptyMsg('Sin transacciones este mes.')
            : monthTxs.map(function(t,i){
                var p=t.pay;
                var pl=loanMap[p.prestamoId];var isU=pl&&pl.moneda==='USD';
                var filaEsAbono=esAbono(p);
                // Parcial EN CURSO: hubo caja pero la cuota sigue sin saldarse -> se marca en ambar
                // para no leerse como una cuota ya cubierta.
                var esParcial=!filaEsAbono&&p.estadoPago!=='Pagado';
                var monto=t.cop;      // monto del EVENTO, no el acumulado de la cuota
                var fecha=t.fecha;    // fecha REAL en que entro el dinero
                var iconAccent=filaEsAbono?'blue':(esParcial?'yellow':'green');
                // USD: si la cuota tiene un solo evento se muestra el USD realmente recibido
                // (doctrina del Bug #23); con varios eventos se convierte el monto de ESTE evento
                // para no repetir el total en cada fila.
                var usdTxt=(t.nEv===1&&+p.montoUSDRecibido>0)?fmtUSD(p.montoUSDRecibido):copToUsd(monto,pl&&pl.trmAcordada);
                return h('div',{key:p.id+'|'+t.fecha+'|'+t.k,style:{display:'flex',alignItems:'center',gap:10,padding:'10px 0',borderTop:i>0?'1px solid var(--border)':'none'}},
                  h('div',{style:{width:24,height:24,borderRadius:6,background:'var(--'+iconAccent+'-bg)',display:'flex',alignItems:'center',justifyContent:'center',flexShrink:0}},
                    h(Ico,{name:filaEsAbono?'dollar':'check',size:11,color:'var(--'+iconAccent+')',sw:2.4})),
                  h('div',{style:{flex:1,minWidth:0}},
                    h('div',{style:{fontSize:13,fontWeight:600,color:'var(--text)',cursor:'pointer',textOverflow:'ellipsis',overflow:'hidden',whiteSpace:'nowrap'},onClick:function(){onNameClick(p.nombreCliente);}},p.nombreCliente),
                    h('div',{style:{fontSize:11,color:'var(--text3)',marginTop:2}},tipoTx(p,pl)+(esParcial?' · abono parcial':'')+' · '+fmtD(fecha))),
                  h('div',{style:{textAlign:'right',flexShrink:0}},
                    h('div',{className:'mono',style:{fontSize:15,fontWeight:700,color:'var(--text)'}},fmt(monto)),
                    isU&&h('div',{className:'mono',style:{fontSize:10,color:'var(--blue)',marginTop:1}},usdTxt)));
              })))),
    // ── EMPTY STATE ─────────────────────────────────────────────────────
    isEmpty&&h('div',{style:{textAlign:'center',padding:'44px 0',color:'var(--text3)'}},
      h('div',{style:{marginBottom:12}},h(Ico,{name:'briefcase',size:48,color:'var(--text3)'})),
      h('p',{style:{fontWeight:600,color:'var(--text2)',marginBottom:4}},'Sin prestamos aun'),
      h('p',{style:{fontSize:13}},'Ve a Cartera para registrar el primero')));
}
