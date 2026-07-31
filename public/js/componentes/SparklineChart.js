// public/js/componentes/SparklineChart.js — mini-grafico de linea con tooltip.
//
// Extraido de `app.js` en la Etapa 3 (B5) del refactor. Codigo VERBATIM.
//
// Lo usan los KPI del Inicio (Cobros del Mes y Ganancias). Dibuja SVG a mano, sin
// libreria de graficos: es una dependencia menos y el proyecto no tiene bundler.

import { h, useState } from '../core/react.js';
import { fmt } from '../core/format.js';

// ── Dashboard ─────────────────────────────────────────────────────────────────
// ── Gráfico financiero compacto (SVG puro, sin dependencias) ────────────────
// Marco clasico (eje Y Oeste + eje X Sur solidos), grid tenue punteado, linea de
// tendencia + relleno degradado, etiquetas Y (max/min, abreviadas k/M) e eje X (meses).
// Caja ESTRICTA via overflow:hidden. Padding asimetrico: padL deja aire al eje Y y sus
// etiquetas; padB deja aire al eje X + la fila de meses. Todo cabe dentro de w x hgt.
export function SparklineChart(props){
  var _hov=useState(null);var hoveredIndex=_hov[0];var setHoveredIndex=_hov[1];
  var data=props.data||[];
  if(data.length<2) return null;
  var labels=props.labels||[],tipLabels=props.tipLabels||[];
  var w=props.width||298,hgt=props.height||98,stroke=props.color||'var(--green)';
  var padL=32,padR=20,padT=16,padB=22;                // padding moderado (el fix real fue z-index): recupera variacion vertical. padB aloja eje X + meses
  var plotL=padL,plotR=w-padR,plotT=padT,plotB=hgt-padB;
  var min=Math.min.apply(null,data),max=Math.max.apply(null,data),flat=max===min,range=(max-min)||1,n=data.length;
  function fmtSpark(v){var a=Math.abs(v);if(a>=1e6)return (v/1e6).toFixed(a>=1e7?0:1).replace(/\.0$/,'')+'M';if(a>=1e3)return Math.round(v/1e3)+'k';return String(Math.round(v));}
  var pts=data.map(function(v,i){
    var x=plotL+(i*(plotR-plotL)/(n-1));
    var y=flat?(plotT+plotB)/2:plotT+(1-(v-min)/range)*(plotB-plotT);
    return [Math.round(x*10)/10,Math.round(y*10)/10];
  });
  var line=pts.map(function(p,i){return (i===0?'M':'L')+p[0]+' '+p[1];}).join(' ');
  var area='M'+pts[0][0]+' '+plotB+' '+pts.map(function(p){return 'L'+p[0]+' '+p[1];}).join(' ')+' L'+pts[n-1][0]+' '+plotB+' Z';
  var gid='spark-'+String(props.id||'g').replace(/[^a-z0-9]/gi,'');
  var lblStyle={fill:'var(--text3)',fontSize:9,fontFamily:"'Cascadia Code','Consolas',monospace"};
  var hGrid=[0.25,0.5,0.75].map(function(f){return Math.round((plotT+f*(plotB-plotT))*10)/10;});
  // Tooltip interactivo: geometria del punto activo, anclada para NO salirse de la caja.
  var dense=n>14,rBase=dense?2:3.4,mono="'Cascadia Code','Consolas',monospace",tip=null;
  if(hoveredIndex!=null&&pts[hoveredIndex]){
    var cx=pts[hoveredIndex][0],cy=pts[hoveredIndex][1];
    var tLab=tipLabels[hoveredIndex]||labels[hoveredIndex]||('#'+(hoveredIndex+1));
    var tVal=fmt(data[hoveredIndex]);
    // Anclaje NATIVO con text-anchor (el motor de fuentes resuelve el ancho; sin medir tw).
    // rect de ancho FIJO; mitad derecha -> tooltip a la IZQ, mitad izq -> a la DER. Auto-acotado.
    var rightHalf=cx>w/2,anchor=rightHalf?'end':'start',rectW=78,rectH=26;
    var textX=rightHalf?cx-12:cx+12;
    var rectX=rightHalf?textX-(rectW-8):textX-5;
    var rectY=(cy<30)?cy+12:cy-12-rectH;                 // punto alto (cerca del techo) -> tooltip ABAJO; si no, arriba
    rectY=Math.max(2,Math.min(rectY,hgt-rectH-2));        // clamp vertical (textos relativos a rectY -> sin desync)
    tip={cx:cx,cy:cy,tLab:tLab,tVal:tVal,anchor:anchor,textX:textX,rectX:rectX,rectW:rectW,rectH:rectH,rectY:rectY};
  }
  return h('svg',{width:w,height:hgt,viewBox:'0 0 '+w+' '+hgt,style:Object.assign({display:'block',overflow:'hidden'},props.style||{})},
    h('defs',null,
      h('linearGradient',{id:gid,x1:'0',y1:'0',x2:'0',y2:'1'},
        h('stop',{offset:'0%',style:{stopColor:stroke,stopOpacity:.24}}),
        h('stop',{offset:'100%',style:{stopColor:stroke,stopOpacity:0}}))),
    hGrid.map(function(y,i){return h('line',{key:'h'+i,x1:plotL,y1:y,x2:plotR,y2:y,stroke:'var(--border)',strokeWidth:1,strokeDasharray:'2,4',opacity:.5});}),
    pts.map(function(p,i){return (!labels.length||labels[i])?h('line',{key:'v'+i,x1:p[0],y1:plotT,x2:p[0],y2:plotB,stroke:'var(--border)',strokeWidth:1,strokeDasharray:'2,4',opacity:.5}):null;}),
    h('path',{d:area,fill:'url(#'+gid+')',stroke:'none'}),
    h('line',{x1:plotL,y1:plotT,x2:plotL,y2:plotB,stroke:'var(--border)',strokeWidth:1}),
    h('line',{x1:plotL,y1:plotB,x2:plotR,y2:plotB,stroke:'var(--border)',strokeWidth:1}),
    h('path',{d:line,fill:'none',stroke:stroke,strokeWidth:2,strokeLinecap:'round',strokeLinejoin:'round'}),
    tip&&h('line',{x1:tip.cx,y1:tip.cy,x2:tip.cx,y2:plotB,stroke:stroke,strokeWidth:1,strokeDasharray:'2,2',opacity:.55}),
    pts.map(function(p,i){
      var act=i===hoveredIndex,on=data[i]>0;   // on = periodo con actividad (>0) -> dorado; si es 0 -> invisible pero interactivo
      return on
        ? h('circle',{key:'pt'+i,cx:p[0],cy:p[1],r:act?rBase+2:rBase,fill:'var(--gold)',stroke:'var(--bg2)',strokeWidth:act?1.5:1,opacity:act?1:(dense?.6:.9),pointerEvents:'all',style:{cursor:'pointer'},onMouseEnter:function(){setHoveredIndex(i);},onMouseLeave:function(){setHoveredIndex(null);}})
        : h('circle',{key:'pt'+i,cx:p[0],cy:p[1],r:dense?3.2:4,fill:'transparent',pointerEvents:'all',style:{cursor:'pointer'},onMouseEnter:function(){setHoveredIndex(i);},onMouseLeave:function(){setHoveredIndex(null);}});
    }),
    h('text',{x:plotL-4,y:plotT+3,textAnchor:'end',style:lblStyle},fmtSpark(max)),
    h('text',{x:plotL-4,y:plotB,textAnchor:'end',style:lblStyle},fmtSpark(min)),
    labels.length===n&&pts.map(function(p,i){return labels[i]?h('text',{key:'m'+i,x:p[0],y:plotB+13,textAnchor:'middle',style:lblStyle},labels[i]):null;}),
    tip&&h('g',{style:{pointerEvents:'none'}},
      h('rect',{x:tip.rectX,y:tip.rectY,width:tip.rectW,height:tip.rectH,rx:4,ry:4,fill:'var(--bg4)',stroke:'var(--border)',strokeWidth:1}),
      h('text',{x:tip.textX,y:tip.rectY+10,textAnchor:tip.anchor,style:{fill:'var(--text3)',fontSize:8.5,fontFamily:mono}},tip.tLab),
      h('text',{x:tip.textX,y:tip.rectY+21,textAnchor:tip.anchor,style:{fill:'var(--text)',fontSize:10,fontWeight:700,fontFamily:mono}},tip.tVal)));
}
