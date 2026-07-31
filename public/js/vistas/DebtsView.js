// public/js/vistas/DebtsView.js — Mis Deudas: lo que el usuario debe, agrupado por acreedor.
//
// Extraido de `app.js` en la Etapa 3 (B7) del refactor. Codigo VERBATIM.
//
// El estado global sigue viviendo en `App` y baja por PROPS, igual que antes.
// Sin Context API y sin store: eso seria rediseno, no refactor.

import { Ico } from '../componentes/iconos.js';
import { fmt, fmtD } from '../core/format.js';
import { h, useMemo, useState } from '../core/react.js';
import { properCase } from '../core/ui.js';

// ── Mis Deudas (deudas propias, registro manual — Bloque 2) ───────────────────
export function DebtsView(props){
  var debts=props.debts||[];
  var onReload=props.onReload;
  var onNew=props.onNew;
  var onPay=props.onPay;
  var onEdit=props.onEdit;
  var onDelete=props.onDelete;
  var onHistory=props.onHistory;
  var sExp=useState({}); var expanded=sExp[0]; var setExpanded=sExp[1];
  function toggleExpand(key){ setExpanded(function(prev){ var n=Object.assign({},prev); n[key]=!n[key]; return n; }); }

  // KPIs globales: gran total, visibles en todo momento.
  var stats=useMemo(function(){
    var activas=debts.filter(function(d){return d.estado==='Activa';});
    var totalActiva=activas.reduce(function(s,d){return s+(+d.saldo_pendiente||0);},0);
    return {totalActiva:totalActiva,count:debts.length,activas:activas.length,pagadas:debts.length-activas.length};
  },[debts]);

  // Agrupacion por acreedor (case-insensitive); nombre en Proper Case.
  var grupos=useMemo(function(){
    // timestamp robusto desde "YYYY-MM-DD HH:MM:SS" o "YYYY-MM-DD" (0 si invalido).
    function parseTs(s){ var t=new Date(String(s||'').replace(' ','T')).getTime(); return isNaN(t)?0:t; }
    var map={};
    debts.forEach(function(d){
      var key=(d.acreedor||'').trim().toLowerCase();
      if(!map[key]) map[key]={key:key,nombre:properCase(d.acreedor),deudas:[],totalActiva:0,activas:0,pagadas:0,oldestTs:Infinity};
      var g=map[key];
      g.deudas.push(d);
      g.oldestTs=Math.min(g.oldestTs, parseTs(d.fecha_creacion)); // deuda mas antigua del acreedor
      if(d.estado==='Activa'){ g.totalActiva+=(+d.saldo_pendiente||0); g.activas++; } else { g.pagadas++; }
    });
    // Orden DESC por la deuda mas antigua: el acreedor con la deuda mas reciente arriba, el mas antiguo abajo.
    return Object.keys(map).map(function(k){return map[k];})
      .sort(function(a,b){return b.oldestTs-a.oldestTs || a.nombre.localeCompare(b.nombre);});
  },[debts]);

  function estadoBadge(estado){
    var c=estado==='Pagada'?'var(--green)':'var(--yellow)';
    return h('span',{style:{fontSize:11,fontWeight:700,color:c,background:c+'20',padding:'3px 10px',borderRadius:99,whiteSpace:'nowrap'}},estado);
  }
  function kpi(iconName,iconColor,label,value,sub){
    return h('div',{style:{background:'var(--bg2)',border:'1px solid var(--border)',borderRadius:12,padding:'14px 16px'}},
      h('div',{style:{display:'flex',alignItems:'center',gap:8,marginBottom:8}},
        h('div',{style:{background:iconColor+'20',borderRadius:8,padding:7,display:'flex'}},h(Ico,{name:iconName,size:16,color:iconColor})),
        h('div',{style:{fontSize:11,fontWeight:700,color:'var(--text3)',textTransform:'uppercase',letterSpacing:'.5px'}},label)),
      h('div',{className:'mono',style:{fontSize:24,fontWeight:700,color:'var(--text)'}},value),
      h('div',{style:{fontSize:12,color:'var(--text3)',marginTop:2}},sub));
  }
  function avatar(nombre,size){
    return h('div',{style:{width:size,height:size,borderRadius:99,background:'var(--bg3)',display:'flex',alignItems:'center',justifyContent:'center',flexShrink:0,fontWeight:700,fontSize:Math.round(size*0.4),color:'var(--text2)'}},(nombre||'?').charAt(0).toUpperCase());
  }
  function subProfiles(g){
    return g.activas+' deuda'+(g.activas===1?'':'s')+' activa'+(g.activas===1?'':'s')+(g.pagadas>0?' · '+g.pagadas+' pagada'+(g.pagadas===1?'':'s'):'');
  }
  function iconBtn(icon,title,onClick,color){
    return h('button',{onClick:onClick,title:title,style:{background:'var(--bg3)',border:'1px solid var(--border)',borderRadius:8,width:32,height:32,cursor:'pointer',display:'flex',alignItems:'center',justifyContent:'center',flexShrink:0}},
      h(Ico,{name:icon,size:15,color:color||'var(--text2)'}));
  }

  // Tarjeta de UNA deuda: barra de progreso (% pagado) + montos + acciones.
  // Separador sutil de categoria (Activas / Finalizadas) dentro del acordeon.
  function catLabel(text,key){
    return h('div',{key:key,style:{display:'flex',alignItems:'center',gap:8,marginTop:4}},
      h('span',{style:{fontSize:11,fontWeight:700,color:'var(--text3)',textTransform:'uppercase',letterSpacing:'.5px'}},text),
      h('div',{style:{flex:1,height:1,background:'var(--border)'}}));
  }

  function debtCard(d){
    // QA5: base dinamica = monto_original + cargos (deuda total acumulada). pct = abonos / base.
    // Asi nunca da negativo aunque los cargos superen el monto original.
    var baseDeuda=(+d.monto_original||0)+(+d.total_cargos||0);
    var pct=baseDeuda>0?Math.max(0,Math.min(100,Math.round(((+d.total_abonos||0)/baseDeuda)*100))):0;
    return h('div',{key:d.id,style:{background:'var(--bg2)',border:'1px solid var(--border)',borderRadius:12,padding:'13px 15px'}},
      h('div',{style:{display:'flex',alignItems:'flex-start',justifyContent:'space-between',gap:10,marginBottom:10}},
        h('div',{style:{minWidth:0}},
          h('div',{style:{fontWeight:700,fontSize:15,color:'var(--text)',whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis'}},d.titulo||d.concepto||'Deuda'),
          (d.titulo&&d.concepto)?h('div',{style:{fontSize:12,color:'var(--text3)',marginTop:2,whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis'}},d.concepto):null,
          h('div',{style:{fontSize:11,color:'var(--text3)',marginTop:2}},'Registrada '+fmtD((d.fecha_creacion||'').slice(0,10)))),
        estadoBadge(d.estado)),
      // Barra de progreso: % pagado = (monto_original - saldo_pendiente) / monto_original
      h('div',{style:{marginBottom:10}},
        h('div',{style:{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:4}},
          h('span',{style:{fontSize:11,color:'var(--text3)'}},'Pagado'),
          h('span',{className:'mono',style:{fontSize:11,fontWeight:700,color:'var(--green)'}},pct+'%')),
        h('div',{style:{height:6,background:'var(--bg3)',borderRadius:99,overflow:'hidden'}},
          h('div',{style:{width:pct+'%',height:'100%',background:'var(--green)',borderRadius:99,transition:'width .3s'}}))),
      h('div',{style:{display:'flex',justifyContent:'space-between',alignItems:'flex-end',gap:12}},
        h('div',null,
          h('div',{style:{fontSize:11,color:'var(--text3)',marginBottom:2}},'Monto original'),
          h('div',{className:'mono',style:{fontSize:13,color:'var(--text2)',fontWeight:600}},fmt(d.monto_original))),
        h('div',{style:{textAlign:'right'}},
          h('div',{style:{fontSize:11,color:'var(--text3)',marginBottom:2}},'Saldo pendiente'),
          h('div',{className:'mono',style:{fontSize:16,fontWeight:700,color:d.estado==='Pagada'?'var(--green)':'var(--yellow)'}},fmt(d.saldo_pendiente)))),
      // Acciones: Ver pagos / Editar / Eliminar (+ Abonar si esta Activa)
      h('div',{style:{display:'flex',alignItems:'center',gap:6,marginTop:12}},
        iconBtn('clipboard','Ver pagos',function(){onHistory(d);}),
        iconBtn('edit','Editar',function(){onEdit(d);}),
        iconBtn('trash','Eliminar',function(){onDelete(d);},'var(--red)'),
        h('div',{style:{flex:1}}),
        d.estado==='Activa'?h('button',{onClick:function(){onPay(d);},style:{background:'var(--green2)',border:'none',borderRadius:8,padding:'7px 16px',cursor:'pointer',color:'#fff',fontSize:13,fontWeight:700,display:'flex',alignItems:'center',gap:6}},
          h(Ico,{name:'dollar',size:14,color:'#fff'}),'Abonar'):null));
  }

  // Encabezado de PERFIL (acordeon): clic alterna la expansion in-place (otros siguen visibles).
  function profileHeader(g){
    var open=!!expanded[g.key];
    return h('div',{onClick:function(){toggleExpand(g.key);},style:{background:'var(--bg2)',border:'1px solid var(--border)',borderRadius:12,padding:'13px 15px',cursor:'pointer',display:'flex',alignItems:'center',justifyContent:'space-between',gap:12}},
      h('div',{style:{display:'flex',alignItems:'center',gap:12,minWidth:0}},
        avatar(g.nombre,42),
        h('div',{style:{minWidth:0}},
          h('div',{style:{fontWeight:700,fontSize:15,color:'var(--text)',whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis'}},g.nombre),
          h('div',{style:{fontSize:12,color:'var(--text3)',marginTop:2}},subProfiles(g)))),
      h('div',{style:{display:'flex',alignItems:'center',gap:10,flexShrink:0}},
        h('div',{style:{textAlign:'right'}},
          h('div',{style:{fontSize:11,color:'var(--text3)'}},'Deuda total'),
          h('div',{className:'mono',style:{fontSize:16,fontWeight:700,color:g.totalActiva>0?'var(--yellow)':'var(--green)'}},fmt(g.totalActiva))),
        h(Ico,{name:open?'chevdown':'chevright',size:18,color:'var(--text3)'})));
  }

  // Bloque de un acreedor: cabecera-acordeon + (al expandir) sus deudas categorizadas.
  function groupBlock(g){
    var open=!!expanded[g.key];
    var act=g.deudas.filter(function(d){return d.estado==='Activa';}).sort(function(a,b){return (+b.saldo_pendiente||0)-(+a.saldo_pendiente||0);});
    var fin=g.deudas.filter(function(d){return d.estado!=='Activa';});
    var detalle=[];
    if(act.length){ detalle.push(catLabel('Activas','a-'+g.key)); act.forEach(function(d){detalle.push(debtCard(d));}); }
    if(fin.length){ detalle.push(catLabel('Finalizadas','f-'+g.key)); fin.forEach(function(d){detalle.push(debtCard(d));}); }
    return h('div',{key:g.key},
      profileHeader(g),
      open?h('div',{style:{display:'flex',flexDirection:'column',gap:8,marginTop:8,paddingLeft:12}},detalle):null);
  }

  // Nivel 1 dividido en Activos (>=1 deuda Activa) e Inactivos (todas Pagadas). Cada bloque hereda
  // el orden del memo `grupos` (desc por la deuda mas antigua del acreedor). Separador solo si hay.
  var activos=grupos.filter(function(g){return g.activas>0;});
  var inactivos=grupos.filter(function(g){return g.activas===0;});
  var perfiles=[];
  if(activos.length){ perfiles.push(catLabel('Activos','sec-act')); activos.forEach(function(g){perfiles.push(groupBlock(g));}); }
  if(inactivos.length){ perfiles.push(catLabel('Inactivos','sec-fin')); inactivos.forEach(function(g){perfiles.push(groupBlock(g));}); }

  return h('div',{style:{padding:16,maxWidth:1180,margin:'0 auto'}},
    // Cabecera: titulo + acciones (siempre visible)
    h('div',{style:{display:'flex',alignItems:'center',justifyContent:'space-between',gap:12,marginBottom:16,flexWrap:'wrap'}},
      h('div',{style:{display:'flex',alignItems:'center',gap:8}},
        h(Ico,{name:'wallet',size:20,color:'var(--green)'}),
        h('h2',{style:{color:'var(--text)',fontSize:18,fontWeight:700,margin:0}},'Mis Deudas')),
      h('div',{style:{display:'flex',gap:8}},
        h('button',{onClick:onReload,title:'Actualizar',style:{background:'var(--bg3)',border:'1px solid var(--border)',borderRadius:8,padding:'8px 12px',cursor:'pointer',color:'var(--text)',fontSize:13,display:'flex',alignItems:'center',gap:6}},
          h(Ico,{name:'refresh',size:14,color:'var(--text2)'}),'Actualizar'),
        h('button',{onClick:onNew,style:{background:'var(--green2)',border:'none',borderRadius:8,padding:'8px 14px',cursor:'pointer',color:'#fff',fontSize:13,fontWeight:700,display:'flex',alignItems:'center',gap:6}},
          h(Ico,{name:'plus',size:15,color:'#fff'}),'Nueva Deuda'))),

    // KPIs globales (siempre visibles, gran total)
    h('div',{style:{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(210px,1fr))',gap:12,marginBottom:18}},
      kpi('wallet','var(--yellow)','Deuda Total Activa',fmt(stats.totalActiva),stats.activas+' deuda'+(stats.activas===1?'':'s')+' activa'+(stats.activas===1?'':'s')),
      kpi('clipboard','var(--blue)','Cantidad de Deudas',String(stats.count),stats.activas+' activas · '+stats.pagadas+' pagadas')),

    // Cuerpo: vacio / acordeon de acreedores (los perfiles NO desaparecen al expandir)
    debts.length===0?
      h('div',{style:{textAlign:'center',padding:40,color:'var(--text3)'}},
        h(Ico,{name:'wallet',size:32,color:'var(--text3)'}),
        h('p',{style:{marginTop:12,fontSize:13}},'No tienes deudas registradas aun'),
        h('p',{style:{marginTop:4,fontSize:12,color:'var(--text3)'}},'Usa "Nueva Deuda" para agregar la primera'))
    :
      h('div',{style:{display:'flex',flexDirection:'column',gap:8}},perfiles));
}
