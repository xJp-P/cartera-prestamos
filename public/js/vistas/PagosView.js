// public/js/vistas/PagosView.js — Cuotas por cobrar: mora, vencen hoy y proximas.
//
// Extraido de `app.js` en la Etapa 3 (B7) del refactor. Codigo VERBATIM.
//
// El estado global sigue viviendo en `App` y baja por PROPS, igual que antes.
// Sin Context API y sin store: eso seria rediseno, no refactor.

import { Ico } from '../componentes/iconos.js';
import { pendCuota } from '../core/dominio.js';
import { copToUsd, fmt, fmtD, fmtUSD } from '../core/format.js';
import { h, useState } from '../core/react.js';
import { nowStr, payMatchesQuery } from '../core/ui.js';
import { generateFacturaCobro } from '../pdf/factura-cobro.js';

// ── Pagos ─────────────────────────────────────────────────────────────────────
export function PagosView(props){
  var pays=props.pays,allPays=props.allPays||[],loans=props.loans||[],searchQ=props.searchQ,setSearchQ=props.setSearchQ;
  var fMonth=props.fMonth,setFMonth=props.setFMonth,onSelect=props.onSelect,onQuickPay=props.onQuickPay,onNameClick=props.onNameClick,datosPago=props.datosPago;
  var tabSt=useState('pendientes'); var pagosTab=tabSt[0]; var setPagosTab=tabSt[1];
  var today=new Date(nowStr()+'T12:00:00');
  function diasMora(fp){var d=new Date(fp+'T12:00:00');return Math.max(0,Math.floor((today-d)/86400000));}
  // Mapa rápido de préstamo por id para lookup de moneda/trm
  var loanMap={};loans.forEach(function(l){loanMap[l.id]=l;});
  var todayStr=nowStr();
  var moraPays=pays.filter(function(p){return p.estadoPago==='En Mora';});
  var hoyPays=pays.filter(function(p){return p.estadoPago==='Pendiente'&&p.fechaPago===todayStr;});
  // Próximas a vencer: pendientes dentro de 3 días (sin incluir hoy)
  var tres=new Date(today); tres.setDate(tres.getDate()+3);
  var tresStr=tres.toISOString().split('T')[0];
  var prontoPays=pays.filter(function(p){return p.estadoPago==='Pendiente'&&p.fechaPago>todayStr&&p.fechaPago<=tresStr;});
  var pendPays=pays.filter(function(p){return p.estadoPago==='Pendiente'&&p.fechaPago>tresStr;});
  var totalPronto=prontoPays.reduce(function(s,p){return s+pendCuota(p);},0);
  var totalMora=moraPays.reduce(function(s,p){return s+pendCuota(p);},0);
  var totalHoy=hoyPays.reduce(function(s,p){return s+pendCuota(p);},0);
  // Pagos cobrados del mes actual (o mes seleccionado)
  var mesFilter=fMonth||nowStr().slice(0,7);
  var cobrados=allPays.filter(function(p){
    if(p.estadoPago!=='Pagado') return false;
    if(p.id.indexOf('-ab-')!==-1) return false;
    var fRef=p.fechaRecaudo||p.fechaPago;
    if(fRef.indexOf(mesFilter)!==0) return false;
    if(searchQ&&!payMatchesQuery(p,searchQ)) return false;
    return true;
  }).sort(function(a,b){return (b.fechaRecaudo||b.fechaPago).localeCompare(a.fechaRecaudo||a.fechaPago);});
  var totalCobrado=cobrados.reduce(function(s,p){return s+(p.montoCOPRecibido||p.cuotaTotal);},0);

  function renderRow(p,type){
    var isMora=type==='mora';
    var isHoy=type==='hoy';
    var isPronto=type==='pronto';
    var dm=isMora?diasMora(p.fechaPago):0;
    var pl=loanMap[p.prestamoId];
    var esUSD=pl&&pl.moneda==='USD';
    var trm=pl?pl.trmAcordada:0;
    var yaPag=+p.partialPaid||0;
    var hasPartial=yaPag>0;
    var restante=Math.max(0,p.cuotaTotal-yaPag);
    var borderColor=hasPartial?'var(--blue)':isMora?'var(--red-bd)':isHoy||isPronto?'var(--yellow)':'var(--border)';
    var valColor=hasPartial?'var(--blue)':isMora?'var(--red)':isHoy||isPronto?'var(--yellow)':'var(--text)';
    return h('div',{key:p.id,style:{background:hasPartial?'rgba(33,129,219,.06)':isHoy?'rgba(187,128,9,.06)':'var(--bg2)',border:'1px solid '+borderColor,borderRadius:12,padding:'11px 13px',transition:'background .1s'}},
      h('div',{style:{display:'flex',justifyContent:'space-between',alignItems:'center'}},
        h('div',{style:{flex:1,minWidth:0,cursor:'pointer'},onClick:function(){onSelect(p);}},
          h('div',{style:{display:'flex',alignItems:'center',gap:6}},
            h('span',{onClick:function(e){e.stopPropagation();onNameClick(p.nombreCliente);},style:{fontWeight:500,fontSize:14,color:'var(--text)',cursor:'pointer',textDecoration:'underline',textDecorationColor:'var(--bg4)',textUnderlineOffset:2}},p.nombreCliente),
            hasPartial&&h('span',{className:'tag',style:{background:'var(--blue-bg)',color:'var(--blue)',fontSize:10,padding:'2px 6px'}},'PARCIAL')),
          h('div',{style:{fontSize:12,color:isPronto?'var(--yellow)':'var(--text3)',marginTop:2}},'Cuota '+p.cuotaN+(isHoy?' - Vence HOY':isPronto?' - en '+Math.ceil((new Date(p.fechaPago+'T12:00:00')-today)/86400000)+' dia'+(Math.ceil((new Date(p.fechaPago+'T12:00:00')-today)/86400000)>1?'s':''):' - Vence '+fmtD(p.fechaPago))),
          isMora&&dm>0&&h('div',{style:{fontSize:12,color:'var(--red)',fontWeight:600,marginTop:2}},dm+' dia'+(dm>1?'s':'')+' de mora'),
          hasPartial&&h('div',{className:'mono',style:{fontSize:11,color:'var(--blue)',fontWeight:600,marginTop:2}},'Abonado '+fmt(yaPag)+' de '+fmt(p.cuotaTotal))),
        h('div',{style:{display:'flex',alignItems:'center',gap:8}},
          h('div',{style:{textAlign:'right'},onClick:function(){onSelect(p);},cursor:'pointer'},
            h('span',{className:'mono',style:{fontWeight:300,fontSize:14,color:valColor}},fmt(hasPartial?restante:p.cuotaTotal)),
            esUSD&&h('div',{className:'mono',style:{fontSize:11,color:'var(--blue)',fontWeight:400}},copToUsd(hasPartial?restante:p.cuotaTotal,trm))),
          h('button',{className:'quick-pay',onClick:function(e){e.stopPropagation();var ln=loanMap[p.prestamoId];if(ln)generateFacturaCobro(p,ln,allPays,datosPago);},style:{background:'var(--bg3)',color:'var(--text2)',border:'1px solid var(--border)'},title:'Recibo de cobro (PDF)'},h(Ico,{name:'receipt',size:14,color:'var(--text2)'})),
          h('button',{className:'quick-pay',onClick:function(e){e.stopPropagation();onQuickPay(p);},style:{background:'var(--green-bg)',color:'var(--green)',border:'1px solid var(--green-bd)'},title:'Pago rapido'},h(Ico,{name:'check',size:14,color:'var(--green)'})))));
  }

  return h('div',{className:'fade-in',style:{display:'flex',flexDirection:'column',height:'100%'}},
    h('div',{style:{background:'var(--bg2)',borderBottom:'1px solid var(--border)',padding:'12px 14px',flexShrink:0}},
      h('div',{style:{position:'relative',marginBottom:8}},
        h('div',{style:{position:'absolute',left:11,top:'50%',transform:'translateY(-50%)',display:'flex'}},h(Ico,{name:'search',size:14,color:'var(--text3)'})),
        h('input',{value:searchQ,onChange:function(e){setSearchQ(e.target.value);},placeholder:'Buscar cliente...',className:'inp',style:{paddingLeft:33}})),
      h('div',{style:{display:'flex',gap:8}},
        h('input',{type:'month',value:fMonth,onChange:function(e){setFMonth(e.target.value);},className:'inp',style:{flex:1}}),
        fMonth&&h('button',{onClick:function(){setFMonth('');},style:{background:'var(--bg3)',border:'1px solid var(--border)',borderRadius:10,padding:'0 12px',fontSize:11,color:'var(--text3)',cursor:'pointer'}},'Limpiar')),
      h('div',{style:{display:'flex',gap:6,marginTop:8,flexWrap:'wrap'}},
        moraPays.length>0&&h('span',{className:'tag',style:{background:'var(--red-bg)',color:'var(--red)'}},moraPays.length+' en mora'),
        hoyPays.length>0&&h('span',{className:'tag',style:{background:'var(--yellow-bg)',color:'var(--yellow)'}},hoyPays.length+' hoy'),
        prontoPays.length>0&&h('span',{className:'tag',style:{background:'var(--yellow-bg)',color:'var(--yellow)'}},prontoPays.length+' por vencer'),
        h('span',{className:'tag',style:{background:'var(--bg3)',color:'var(--text2)'}},pendPays.length+' proximas')),
      h('div',{style:{display:'flex',gap:0,marginTop:10,borderBottom:'2px solid var(--border)'}},
        h('button',{onClick:function(){setPagosTab('pendientes');},style:{flex:1,padding:'8px 0',background:'none',border:'none',borderBottom:pagosTab==='pendientes'?'2px solid var(--green)':'2px solid transparent',color:pagosTab==='pendientes'?'var(--green)':'var(--text3)',fontWeight:700,fontSize:13,cursor:'pointer',marginBottom:-2}},'Pendientes'),
        h('button',{onClick:function(){setPagosTab('cobrados');},style:{flex:1,padding:'8px 0',background:'none',border:'none',borderBottom:pagosTab==='cobrados'?'2px solid var(--green)':'2px solid transparent',color:pagosTab==='cobrados'?'var(--green)':'var(--text3)',fontWeight:700,fontSize:13,cursor:'pointer',marginBottom:-2}},'Cobrados'))),
    pagosTab==='pendientes'?h('div',{style:{flex:1,overflowY:'auto',padding:'12px 14px',display:'flex',flexDirection:'column',gap:12}},
      moraPays.length===0&&hoyPays.length===0&&prontoPays.length===0&&pendPays.length===0&&h('div',{style:{textAlign:'center',padding:'50px 0',color:'var(--text3)'}},
        h('div',{style:{marginBottom:10}},h(Ico,{name:'check',size:36,color:'var(--green)'})),
        h('p',{style:{fontWeight:600,fontSize:14}},'Todo al dia'),
        h('p',{style:{fontSize:12,marginTop:4}},'No hay cuotas pendientes de cobro')),
      hoyPays.length>0&&h('div',null,
        h('div',{style:{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:8}},
          h('div',{style:{display:'flex',alignItems:'center',gap:6}},
            h(Ico,{name:'calendar',size:14,color:'var(--yellow)'}),
            h('span',{style:{fontSize:13,fontWeight:600,color:'var(--yellow)'}},'VENCE HOY')),
          h('span',{className:'mono',style:{fontSize:15,fontWeight:600,color:'var(--yellow)'}},fmt(totalHoy))),
        h('div',{style:{display:'flex',flexDirection:'column',gap:8}},
          hoyPays.map(function(p){return renderRow(p,'hoy');}))),
      prontoPays.length>0&&h('div',null,
        h('div',{style:{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:8}},
          h('div',{style:{display:'flex',alignItems:'center',gap:6}},
            h(Ico,{name:'clock',size:14,color:'var(--yellow)'}),
            h('span',{style:{fontSize:13,fontWeight:600,color:'var(--yellow)'}},'PROXIMAS A VENCER')),
          h('span',{className:'mono',style:{fontSize:15,fontWeight:600,color:'var(--yellow)'}},fmt(totalPronto))),
        h('div',{style:{display:'flex',flexDirection:'column',gap:8}},
          prontoPays.map(function(p){return renderRow(p,'pronto');}))),
      moraPays.length>0&&h('div',null,
        h('div',{style:{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:8}},
          h('div',{style:{display:'flex',alignItems:'center',gap:6}},
            h(Ico,{name:'alert',size:14,color:'var(--red)'}),
            h('span',{style:{fontSize:13,fontWeight:600,color:'var(--red)'}},'EN MORA')),
          h('span',{className:'mono',style:{fontSize:15,fontWeight:600,color:'var(--red)'}},fmt(totalMora))),
        h('div',{style:{display:'flex',flexDirection:'column',gap:8}},
          moraPays.map(function(p){return renderRow(p,'mora');}))),
      pendPays.length>0&&h('div',null,
        h('div',{style:{display:'flex',alignItems:'center',gap:6,marginBottom:8}},
          h(Ico,{name:'clock',size:14,color:'var(--text3)'}),
          h('span',{style:{fontSize:13,fontWeight:600,color:'var(--text2)'}},'PROXIMAS A COBRAR')),
        h('div',{style:{display:'flex',flexDirection:'column',gap:8}},
          pendPays.map(function(p){return renderRow(p,'pend');}))))
    :h('div',{style:{flex:1,overflowY:'auto',padding:'12px 14px',display:'flex',flexDirection:'column',gap:6}},
      h('div',{style:{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:8}},
        h('span',{style:{fontSize:13,fontWeight:600,color:'var(--text2)'}},'Cobrados en '+(fMonth||nowStr().slice(0,7))),
        h('span',{className:'mono',style:{fontSize:15,fontWeight:600,color:'var(--green)'}},fmt(totalCobrado))),
      cobrados.length===0&&h('div',{style:{textAlign:'center',padding:'40px 0',color:'var(--text3)'}},
        h('p',{style:{fontSize:13}},'Sin pagos cobrados este mes')),
      cobrados.map(function(p){
        var pl=loanMap[p.prestamoId];var esUSD=pl&&pl.moneda==='USD';var trm=pl?pl.trmAcordada:0;
        return h('div',{key:p.id,onClick:function(){onSelect(p);},style:{background:'var(--bg2)',border:'1px solid var(--green-bd)',borderRadius:10,padding:'9px 12px',cursor:'pointer',display:'flex',justifyContent:'space-between',alignItems:'center'}},
          h('div',{style:{minWidth:0}},
            h('div',{style:{fontWeight:500,fontSize:13,color:'var(--text)'}},p.nombreCliente),
            h('div',{style:{fontSize:11,color:'var(--text3)',marginTop:1}},'Cuota '+p.cuotaN+' \u2022 '+fmtD(p.fechaRecaudo||p.fechaPago))),
          h('div',{style:{textAlign:'right'}},
            h('div',{className:'mono',style:{fontWeight:300,fontSize:14,color:'var(--green)'}},fmt(p.montoCOPRecibido||p.cuotaTotal)),
            esUSD&&h('div',{className:'mono',style:{fontSize:11,color:'var(--blue)'}},(+p.montoUSDRecibido>0?fmtUSD(p.montoUSDRecibido):copToUsd(p.montoCOPRecibido||p.cuotaTotal,trm)))));
      })));
}
