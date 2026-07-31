// public/js/vistas/CalcView.js — Simulador de prestamos con cronograma tentativo.
//
// Extraido de `app.js` en la Etapa 3 (B7) del refactor. Codigo VERBATIM.
//
// El estado global sigue viviendo en `App` y baja por PROPS, igual que antes.
// Sin Context API y sin store: eso seria rediseno, no refactor.

import { Fld } from '../componentes/base.js';
import { Ico } from '../componentes/iconos.js';
import { showError } from '../core/api.js';
import { pmt } from '../core/calculo.js';
import { copToUsd, fmt, fmtN, fmtNumInput, parseNum } from '../core/format.js';
import { h, useMemo, useState } from '../core/react.js';

// ── Calculadora (Simulador) ───────────────────────────────────────────────
export function CalcView(props){
  var onConfirm=props.onConfirm;
  var s1=useState(''); var monto=s1[0]; var setMonto=s1[1];
  var s2=useState('Intereses'); var modalidad=s2[0]; var setModalidad=s2[1];
  var s3=useState(''); var tasa=s3[0]; var setTasa=s3[1];
  var s4=useState(''); var plazo=s4[0]; var setPlazo=s4[1];
  var s5=useState(false); var showCrono=s5[0]; var setShowCrono=s5[1];
  var s6=useState('COP'); var moneda=s6[0]; var setMoneda=s6[1];
  var s7=useState(''); var trmCalc=s7[0]; var setTrmCalc=s7[1];
  var s8=useState('Mensual'); var frecCalc=s8[0]; var setFrecCalc=s8[1];

  var montoCOP=moneda==='USD'?Math.round((+monto||0)*(+trmCalc||1)):(+monto||0);

  var sim=useMemo(function(){
    var pv=moneda==='USD'?Math.round((+monto||0)*(+trmCalc||1)):(+monto||0);
    var rMensual=(+tasa||0)/100;
    var r=frecCalc==='Semanal'?rMensual/4.33:frecCalc==='Quincenal'?rMensual/2:rMensual;
    var n=+plazo||12;
    if(!pv||!r) return null;
    var cuota,intP,capP;
    if(modalidad==='Intereses'){
      intP=Math.round(pv*r); capP=0; cuota=intP;
    } else {
      cuota=Math.round(pmt(r,n,pv));
      intP=Math.round(pv*r); capP=cuota-intP;
    }
    var rows=[]; var saldo=pv;
    var nCuotas=modalidad==='Intereses'?Math.min(n||12,24):n;
    for(var i=0;i<nCuotas;i++){
      var intI=Math.round(saldo*r);
      var isLast=i===nCuotas-1;
      var capI,cuotaI;
      if(modalidad==='Intereses'){
        capI=0; cuotaI=intI;
      } else {
        capI=isLast?Math.round(saldo):Math.round(cuota-intI);
        cuotaI=isLast?Math.round(intI+saldo):cuota;
      }
      var sf=Math.max(0,Math.round(saldo-capI));
      rows.push({n:i+1,interes:intI,capital:capI,cuota:cuotaI,saldo:sf});
      saldo=sf;
    }
    var totalInt=rows.reduce(function(s,r){return s+r.interes;},0);
    var totalPagar=rows.reduce(function(s,r){return s+r.cuota;},0);
    return {cuota:cuota,intP:intP,capP:capP,rows:rows,totalInt:totalInt,totalPagar:totalPagar,montoCOP:pv};
  },[monto,modalidad,tasa,plazo,moneda,trmCalc,frecCalc]);

  function limpiar(){setMonto('');setModalidad('Intereses');setTasa('');setPlazo('');setShowCrono(false);setMoneda('COP');setTrmCalc('');setFrecCalc('Mensual');}

  function confirmar(){
    if(!sim){showError('Ingresa datos validos para simular');return;}
    var data={montoOrigen:+monto,modalidad:modalidad,tasaMensual:+tasa,plazoMeses:+plazo||12,frecuencia:frecCalc};
    if(moneda==='USD'){data.moneda='USD';data.trmAcordada=+trmCalc||1;}
    onConfirm(data);
  }

  return h('div',{className:'fade-in',style:{padding:16}},
    h('div',{style:{fontWeight:700,fontSize:17,color:'var(--text)',marginBottom:2,display:'flex',alignItems:'center',gap:6}},h(Ico,{name:'calc',size:16,color:'var(--green)'}),' Calculadora de Prestamos'),
    h('div',{style:{fontSize:13,color:'var(--text2)',marginBottom:14}},'Simula antes de registrar oficialmente'),
    h(Fld,{label:'Moneda'},h('select',{value:moneda,onChange:function(e){setMoneda(e.target.value);},className:'inp'},
      h('option',{value:'COP'},'COP - Pesos'),h('option',{value:'USD'},'USD - Dolares'))),
    moneda==='USD'&&h(Fld,{label:'TRM acordada *'},
      h('input',{type:'text',inputMode:'numeric',value:fmtNumInput(trmCalc),onChange:function(e){setTrmCalc(parseNum(e.target.value));},placeholder:'Ej: 4.200',className:'inp'})),
    h(Fld,{label:'Valor del prestamo ('+(moneda)+') *'},
      h('input',{type:'text',inputMode:'numeric',value:fmtNumInput(monto),onChange:function(e){setMonto(parseNum(e.target.value));},placeholder:moneda==='USD'?'Ej: 1.000':'Ej: 5.000.000',className:'inp'})),
    moneda==='USD'&&monto&&trmCalc&&h('div',{style:{fontSize:12,color:'var(--blue)',marginTop:2,marginBottom:14,paddingLeft:4}},'Equivalente COP: '+fmt(montoCOP)),
    h(Fld,{label:h('span',{style:{display:'flex',alignItems:'center',gap:6}},'Modalidad',
      h('span',{style:{position:'relative',display:'inline-flex'},className:'tooltip-wrap'},
        h('span',{style:{display:'inline-flex',alignItems:'center',justifyContent:'center',width:16,height:16,borderRadius:'50%',border:'1.5px solid var(--text3)',fontSize:10,fontWeight:700,color:'var(--text3)',cursor:'help',lineHeight:1}},'i'),
        h('span',{className:'tooltip-box'},
          h('b',null,'Intereses:'),' Solo paga intereses mensuales. El capital se devuelve al final. Plazo indefinido.',h('br',null),h('br',null),
          h('b',null,'Capital + Intereses:'),' Cuota fija mensual (amortizacion francesa). Cada cuota incluye intereses + parte del capital. Plazo fijo.',h('br',null),h('br',null),
          h('span',{style:{color:'var(--text3)',fontStyle:'italic'}},'En todas las modalidades se pueden hacer abonos a capital para reducir el saldo.'))))},
      h('select',{value:modalidad,onChange:function(e){setModalidad(e.target.value);},className:'inp'},
      h('option',null,'Intereses'),h('option',null,'Capital + Intereses'))),
    h(Fld,{label:'Frecuencia de cobro'},h('select',{value:frecCalc,onChange:function(e){setFrecCalc(e.target.value);},className:'inp'},
      h('option',null,'Semanal'),h('option',null,'Quincenal'),h('option',null,'Mensual'))),
    h('div',{style:{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10}},
      h(Fld,{label:'Tasa mensual (%) *'},h('input',{type:'number',step:'0.01',value:tasa,onChange:function(e){setTasa(e.target.value);},placeholder:'Ej: 2',className:'inp'})),
      h(Fld,{label:modalidad==='Intereses'?'Simular cuotas (\u221E)':(frecCalc==='Semanal'?'Plazo (semanas)':frecCalc==='Quincenal'?'Plazo (quincenas)':'Plazo (meses)')},h('input',{type:'number',value:plazo,onChange:function(e){setPlazo(e.target.value);},placeholder:modalidad==='Intereses'?'12 (simulacion)':'12',className:'inp'}))),
    sim&&h('div',{style:{background:'var(--green-bg)',border:'1px solid var(--green-bd)',borderRadius:14,padding:'14px',marginTop:14}},
      h('div',{style:{fontSize:11,color:'var(--green)',fontWeight:700,marginBottom:10}},'RESUMEN DE SIMULACION'),
      moneda==='USD'&&h('div',{style:{fontSize:11,color:'var(--blue)',marginBottom:10,padding:'6px 10px',background:'rgba(56,139,253,.08)',borderRadius:8,border:'1px solid rgba(56,139,253,.2)'}},
        'USD $'+fmtN(+monto||0)+' x TRM $'+fmtN(+trmCalc||0)+' = COP '+fmt(sim.montoCOP)),
      h('div',{style:{display:'grid',gridTemplateColumns:'1fr 1fr 1fr',gap:8}},
        h('div',{style:{textAlign:'center'}},
          h('div',{style:{fontSize:10,color:'var(--text3)',marginBottom:3}},modalidad==='Intereses'?'Cuota mensual':'Cuota total'),
          h('div',{className:'mono',style:{fontSize:14,fontWeight:700,color:'var(--green)'}},fmt(sim.cuota)),
          moneda==='USD'&&h('div',{className:'mono',style:{fontSize:10,color:'var(--blue)'}},copToUsd(sim.cuota,+trmCalc))),
        h('div',{style:{textAlign:'center'}},
          h('div',{style:{fontSize:10,color:'var(--text3)',marginBottom:3}},'Intereses 1er mes'),
          h('div',{className:'mono',style:{fontSize:14,fontWeight:700,color:'var(--yellow)'}},fmt(sim.intP)),
          moneda==='USD'&&h('div',{className:'mono',style:{fontSize:10,color:'var(--blue)'}},copToUsd(sim.intP,+trmCalc))),
        h('div',{style:{textAlign:'center'}},
          h('div',{style:{fontSize:10,color:'var(--text3)',marginBottom:3}},'Abono capital 1er mes'),
          h('div',{className:'mono',style:{fontSize:14,fontWeight:700,color:'var(--blue)'}},fmt(sim.capP)),
          moneda==='USD'&&h('div',{className:'mono',style:{fontSize:10,color:'var(--blue)'}},copToUsd(sim.capP,+trmCalc)))),
      h('div',{style:{marginTop:10,padding:'10px 12px',background:'rgba(63,185,80,.08)',borderRadius:10,border:'1px solid var(--green-bd)'}},
        h('div',{style:{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:6}},
          h('span',{style:{fontSize:12,color:'var(--text2)'}},'Ganancia en intereses'),
          h('div',{style:{textAlign:'right'}},
            h('div',{className:'mono',style:{fontSize:15,fontWeight:700,color:'var(--green)'}},fmt(sim.totalInt)),
            moneda==='USD'&&h('div',{className:'mono',style:{fontSize:10,color:'var(--blue)'}},copToUsd(sim.totalInt,+trmCalc)))),
        h('div',{style:{display:'flex',justifyContent:'space-between',alignItems:'center'}},
          h('span',{style:{fontSize:12,color:'var(--text2)'}},'Total a recibir'),
          h('div',{style:{textAlign:'right'}},
            h('div',{className:'mono',style:{fontSize:13,fontWeight:600,color:'var(--text)'}},fmt(sim.totalPagar)),
            moneda==='USD'&&h('div',{className:'mono',style:{fontSize:10,color:'var(--blue)'}},copToUsd(sim.totalPagar,+trmCalc))))),
      h('button',{onClick:function(){setShowCrono(!showCrono);},style:{marginTop:12,background:'none',border:'none',cursor:'pointer',color:'var(--green)',fontSize:12,fontWeight:600,display:'flex',alignItems:'center',gap:4,padding:0}},
        showCrono?'Ocultar cronograma':'Ver cronograma tentativo'),
      showCrono&&h('div',{style:{marginTop:10,borderTop:'1px solid var(--green-bd)',paddingTop:10,overflowX:'auto'}},
        h('table',{style:{width:'100%',borderCollapse:'collapse',fontSize:11}},
          h('thead',null,h('tr',{style:{background:'rgba(63,185,80,.1)'}},
            ['#','Interes','Abono a capital','Valor cuota','Saldo'].map(function(hd){
              return h('th',{key:hd,style:{padding:'6px 8px',textAlign:hd==='#'?'center':'right',fontWeight:600,color:'var(--text2)',whiteSpace:'nowrap'}},hd);}))),
          h('tbody',null,sim.rows.map(function(r){
            var t=+trmCalc||1;
            return h('tr',{key:r.n,style:{borderTop:'1px solid rgba(63,185,80,.12)'}},
              h('td',{style:{padding:'5px 8px',textAlign:'center',color:'var(--text3)'}},r.n),
              h('td',{className:'mono',style:{padding:'5px 8px',textAlign:'right',color:'var(--yellow)'}},fmtN(r.interes),
                moneda==='USD'&&h('div',{style:{fontSize:9,color:'var(--blue)'}},copToUsd(r.interes,t))),
              h('td',{className:'mono',style:{padding:'5px 8px',textAlign:'right',color:'var(--blue)'}},fmtN(r.capital),
                moneda==='USD'&&h('div',{style:{fontSize:9,color:'var(--blue)'}},copToUsd(r.capital,t))),
              h('td',{className:'mono',style:{padding:'5px 8px',textAlign:'right',color:'var(--green)',fontWeight:600}},fmtN(r.cuota),
                moneda==='USD'&&h('div',{style:{fontSize:9,color:'var(--blue)',fontWeight:400}},copToUsd(r.cuota,t))),
              h('td',{className:'mono',style:{padding:'5px 8px',textAlign:'right',color:'var(--text3)',fontSize:10}},fmtN(r.saldo),
                moneda==='USD'&&h('div',{style:{fontSize:9,color:'var(--blue)'}},copToUsd(r.saldo,t))));
          }))))),
    h('div',{style:{display:'flex',gap:10,marginTop:16}},
      h('button',{onClick:confirmar,className:'btn-primary',style:{flex:1,display:'flex',alignItems:'center',justifyContent:'center',gap:6}},h(Ico,{name:'check',size:14,color:'#fff'}),' Confirmar y crear'),
      h('button',{onClick:limpiar,style:{flex:1,background:'var(--bg3)',color:'var(--text2)',border:'1px solid var(--border2)',borderRadius:12,padding:13,fontSize:14,fontWeight:700,cursor:'pointer',fontFamily:'inherit',display:'flex',alignItems:'center',justifyContent:'center',gap:6}},h(Ico,{name:'x',size:14,color:'var(--red)'}),' Limpiar')));
}
