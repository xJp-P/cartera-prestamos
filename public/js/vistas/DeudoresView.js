// public/js/vistas/DeudoresView.js — Perfiles de deudores agrupados por persona.
//
// Extraido de `app.js` en la Etapa 3 (B7) del refactor. Codigo VERBATIM.
//
// El estado global sigue viviendo en `App` y baja por PROPS, igual que antes.
// Sin Context API y sin store: eso seria rediseno, no refactor.

import { Ico } from '../componentes/iconos.js';
import { fmt, fmtUSD } from '../core/format.js';
import { h, useState } from '../core/react.js';

// ── Deudores ──────────────────────────────────────────────────────────────────
export function DeudoresView(props){
  var deudores=props.deudores,pays=props.pays,onSelect=props.onSelect,onAdd=props.onAdd;
  var sq=useState(''); var searchQ=sq[0]; var setSearchQ=sq[1];
  var filtered=deudores.filter(function(d){
    return !searchQ||d.nombre.toLowerCase().indexOf(searchQ.toLowerCase())!==-1;
  });
  return h('div',{className:'fade-in',style:{padding:16}},
    h('div',{style:{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:14}},
      h('div',null,
        h('div',{style:{fontWeight:700,fontSize:17,color:'var(--text)'}},'Mis Deudores'),
        h('div',{style:{fontSize:13,color:'var(--text2)',marginTop:2}},deudores.length+' personas')),
      h('button',{onClick:onAdd,style:{display:'flex',alignItems:'center',gap:6,background:'var(--green2)',color:'white',border:'none',borderRadius:10,padding:'8px 14px',fontSize:14,fontWeight:600,cursor:'pointer'}},
        h(Ico,{name:'plus',size:15,color:'white'}),' Nuevo')),
    h('div',{style:{position:'relative',marginBottom:12}},
      h('div',{style:{position:'absolute',left:11,top:'50%',transform:'translateY(-50%)',display:'flex'}},h(Ico,{name:'search',size:14,color:'var(--text3)'})),
      h('input',{value:searchQ,onChange:function(e){setSearchQ(e.target.value);},placeholder:'Buscar deudor...',className:'inp',style:{paddingLeft:33}})),
    deudores.length===0&&h('div',{style:{textAlign:'center',padding:'48px 0',color:'var(--text3)'}},
      h('div',{style:{marginBottom:12}},h(Ico,{name:'users',size:44,color:'var(--text3)'})),
      h('p',{style:{fontWeight:600,color:'var(--text2)'}},'Sin deudores registrados')),
    h('div',{style:{display:'flex',flexDirection:'column',gap:10}},
      (function(){
        var activos=filtered.filter(function(d){return d.loans.some(function(l){return l.estado==='Activo';});});
        var inactivos=filtered.filter(function(d){return !d.loans.some(function(l){return l.estado==='Activo';});});
        var items=[];
        activos.forEach(function(d){items.push({type:'card',d:d});});
        if(inactivos.length>0){
          items.push({type:'separator'});
          inactivos.forEach(function(d){items.push({type:'card',d:d});});
        }
        return items.map(function(item,i){
          if(item.type==='separator') return h('div',{key:'sep',style:{display:'flex',alignItems:'center',gap:10,margin:'10px 0'}},
            h('div',{style:{flex:1,height:1,background:'var(--border)'}}),
            h('span',{style:{fontSize:12,fontWeight:600,color:'var(--text3)',letterSpacing:1,textTransform:'uppercase'}},'Inactivos'),
            h('div',{style:{flex:1,height:1,background:'var(--border)'}}));
          var d=item.d;
          var activosCount=d.loans.filter(function(l){return l.estado==='Activo';}).length;
          return h('button',{key:d.nombre,className:'debtor-card',onClick:function(){onSelect(d);},
          style:{background:'var(--bg2)',border:'1px solid '+(d.mora>0?'var(--red-bd)':'var(--border)'),borderRadius:14,padding:'14px',textAlign:'left',cursor:'pointer',width:'100%',boxShadow:'var(--shadow)',transition:'border-color .15s'}},
          h('div',{style:{display:'flex',justifyContent:'space-between',alignItems:'flex-start'}},
            h('div',null,
              h('div',{style:{display:'flex',alignItems:'center',gap:8,marginBottom:6}},
                h('div',{style:{width:36,height:36,borderRadius:99,background:'var(--bg3)',border:'1px solid var(--border2)',display:'flex',alignItems:'center',justifyContent:'center',fontSize:16,flexShrink:0}},
                  d.nombre.charAt(0).toUpperCase()),
                h('div',null,
                  h('div',{style:{fontWeight:700,fontSize:14,color:'var(--text)'}},d.nombre),
                  d.cedula&&d.cedula!=='0'&&h('div',{style:{fontSize:12,color:'var(--text3)'}},'CC '+d.cedula))),
              h('div',{style:{display:'flex',gap:8,flexWrap:'wrap',alignItems:'center',marginTop:4}},
                d.telefono&&d.telefono!=='0'&&h('div',{style:{display:'flex',alignItems:'center',gap:4,fontSize:12,color:'var(--text2)'}},
                  h(Ico,{name:'phone',size:12,color:'var(--text3)'}),d.telefono),
                h('span',{className:'tag',style:{background:'var(--bg3)',color:'var(--text2)'}},activosCount+' prestamo'+(activosCount!==1?'s':'')),
                d.mora>0&&h('span',{className:'tag',style:{background:'var(--red-bg)',color:'var(--red)'}},d.mora+' mora'))),
            h('div',{style:{textAlign:'right'}},
              h('div',{className:'mono',style:{fontWeight:500,fontSize:15,color:'var(--green)'}},fmt(d.totalSaldo)),
              d.totalSaldoUSD>0&&h('div',{className:'mono',style:{fontSize:13,color:'var(--blue)',marginTop:1}},fmtUSD(d.totalSaldoUSD)),
              h('div',{style:{fontSize:12,color:'var(--text3)',marginTop:3}},'saldo total'))));
        });
      }())));
}
