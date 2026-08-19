// public/js/modales/LoanModal.js — Crear o editar un prestamo, con bloqueo de campos sensibles.
//
// Extraido de `app.js` en la Etapa 3 (B7) del refactor. Codigo VERBATIM.
//
// El estado global sigue en `App` y baja por PROPS; los callbacks suben igual.
// Sin Context API y sin store.

import { Fld, Modal } from '../componentes/base.js';
import { Ico } from '../componentes/iconos.js';
import { showError } from '../core/api.js';
import { pmt, filasPreview } from '../core/calculo.js';
import { MODALIDAD_DIARIA, diasEntre } from '../core/dominio.js';
import {
  copToUsd, fmt, fmtD, fmtN, fmtNumInput, fmtUSD, parseDecimalInput, parseIntInput, parseNum,
} from '../core/format.js';
import { h, useMemo, useState } from '../core/react.js';
import { freqCuotaLabel, nowStr } from '../core/ui.js';

// ── LoanModal ─────────────────────────────────────────────────────────────────
export function LoanModal(props){
  var loan=props.loan,trm=props.trm,onSave=props.onSave,onClose=props.onClose;
  var allPays=props.pays||[];
  var prefill=loan&&loan._prefill||{};
  var calcPre=loan&&loan._calcPrefill||{};
  // v1.9.0 — Bloqueo de campos sensibles: si el prestamo tiene actividad financiera
  // (cuotas pagadas, abonos a capital o cuotas en mora), los campos que afectan a la
  // amortizacion (PMT/NPER/fechas/TRM) quedan deshabilitados para preservar la integridad
  // matematica del cronograma ya pactado con el deudor.
  var hasActivity=(function(){
    if(!loan||!loan.id) return false;
    return allPays.some(function(p){
      if(String(p.prestamoId)!==String(loan.id)) return false;
      if(p.estadoPago==='Pagado') return true;          // cuotas pagadas o abonos a capital
      if(p.estadoPago==='En Mora') return true;          // cuotas en mora (deuda causada)
      return false;
    });
  })();
  var lockSens=hasActivity&&!(loan&&(loan._prefill||loan._calcPrefill)); // solo bloquea en edicion real, no en prefill desde calc
  var fs=useState({
    nombre:prefill.nombre||loan&&loan.nombre||'',cedula:prefill.cedula||loan&&loan.cedula||'',telefono:prefill.telefono||loan&&loan.telefono||'',
    moneda:calcPre.moneda||loan&&loan.moneda||'COP',montoOrigen:calcPre.montoOrigen||loan&&loan.montoOrigen||'',
    trmAcordada:calcPre.trmAcordada||loan&&loan.trmAcordada||trm,tasaMensual:calcPre.tasaMensual||loan&&loan.tasaMensual||'',
    plazoMeses:calcPre.plazoMeses||loan&&loan.plazoMeses||'',modalidad:calcPre.modalidad||(loan&&loan.modalidad==='Intereses Indefinido'?'Intereses':(loan&&loan.modalidad||'Intereses')),
    frecuencia:calcPre.frecuencia||loan&&loan.frecuencia||'Mensual',
    fechaInicio:loan&&loan.fechaInicio||nowStr(),
    fechaDevolucion:loan&&loan.fechaDevolucion||'',
    // v1.10.0 — campos para modalidad Pago Unico
    // gananciaFija siempre se persiste en COP; gananciaInput es el valor visible (puede ser % o COP)
    gananciaFija:loan&&loan.gananciaFija||0,
    // v1.12.x FIX: al EDITAR un Pago Unico con ganancia guardada, reconstruir el modo. Solo se
    // persiste gananciaFija (COP absoluto), NO el modo original -> lo representamos como "monto
    // fijo" (exacto, sin perdida). El input va en la moneda del prestamo (USD = gananciaFija/TRM).
    // Antes quedaba fijo en 'pct' con el COP absoluto en el input -> calculaba 25000% del capital.
    gananciaMode:(loan&&loan.modalidad==='Pago Unico'&&(+loan.gananciaFija||0)>0)?'monto':'pct',
    gananciaInput:(loan&&(+loan.gananciaFija||0)>0)
      ?String(Math.round((loan.moneda==='USD'&&(+loan.trmAcordada||0)>0)?(+loan.gananciaFija/+loan.trmAcordada):+loan.gananciaFija))
      :'',
    estado:loan&&loan.estado||'Activo',notas:loan&&loan.notas||''
  });
  var f=fs[0]; var setF=fs[1];
  var isNew=!loan||!!loan._prefill||!!loan._calcPrefill;
  function set(k,v){setF(function(p){var n=Object.assign({},p);n[k]=v;return n;});}
  // v1.11.x — Selector "Cliente nuevo / existente" (solo al dar de alta un prestamo). La app asocia por
  // NOMBRE (no hay persona_id): elegir un cliente existente reusa su nombre/cedula/telefono y el backend
  // lo consolida en el mismo perfil (identico a crear el prestamo desde el perfil del deudor).
  var clientes=props.clientes||[];
  var coS=useState(false); var clientOpen=coS[0]; var setClientOpen=coS[1];
  // QA7: elegir una sugerencia prefilla los datos del cliente existente (asocia por nombre; el
  // backend lo consolida igual que crear el prestamo desde el perfil del deudor).
  function pickCliente(c){
    setF(function(p){return Object.assign({},p,{nombre:c.nombre,cedula:c.cedula||'',telefono:c.telefono||''});});
    setClientOpen(false);
  }
  // Autocompletado hibrido sobre el campo Nombre: filtra clientes por substring; oculto si el input
  // esta vacio o coincide exacto con un cliente (mismo patron que DebtModal).
  var cliQ=(f.nombre||'').trim(), cliQL=cliQ.toLowerCase();
  var cliExact=clientes.some(function(c){return (c.nombre||'').toLowerCase()===cliQL;});
  var clientesMatch=(cliQ&&!cliExact)?clientes.filter(function(c){return (c.nombre||'').toLowerCase().indexOf(cliQL)!==-1;}).slice(0,8):[];
  var cliOpen=clientOpen&&clientesMatch.length>0;
  // Compras fraccionadas de USD
  var comprasIniciales=function(){
    if(loan&&loan.comprasUSD){try{var p=typeof loan.comprasUSD==='string'?JSON.parse(loan.comprasUSD):loan.comprasUSD;if(Array.isArray(p)&&p.length>0)return p.map(function(c){return {monto:c.monto,tasa:c.tasa,totalCOP:((+c.monto)>0&&(+c.tasa)>0)?Math.round((+c.monto)*(+c.tasa)):''};});}catch(_){}}
    return [{monto:'',tasa:'',totalCOP:''},{monto:'',tasa:'',totalCOP:''}];
  };
  var cus=useState(comprasIniciales()); var compras=cus[0]; var setCompras=cus[1];
  var cfs=useState(!!(loan&&loan.comprasUSD&&loan.comprasUSD.length>2)); var compraFrac=cfs[0]; var setCompraFrac=cfs[1];
  // v1.11.x — "Total pagado en COP" del modo simple: auxiliar de UI (NO se persiste). Init derivado al editar.
  var tcS=useState(loan&&loan.moneda==='USD'&&(+loan.trmAcordada)>0&&(+loan.montoOrigen)>0?Math.round((+loan.montoOrigen)*(+loan.trmAcordada)):''); var totalCOPInput=tcS[0]; var setTotalCOPInput=tcS[1];
  // Cálculo ponderado en vivo (solo filas con valores válidos)
  var comprasValidas=compras.filter(function(c){return (+c.monto)>0&&(+c.tasa)>0;});
  var totalUSDComprado=comprasValidas.reduce(function(s,c){return s+(+c.monto);},0);
  var totalCOPInvertido=comprasValidas.reduce(function(s,c){return s+(+c.monto)*(+c.tasa);},0);
  var tasaPromedio=totalUSDComprado>0?Math.round(totalCOPInvertido/totalUSDComprado):0;
  var aplicaFracc=f.moneda==='USD'&&compraFrac;
  // Cuando hay compras fraccionadas válidas, la trmAcordada efectiva es la promedio
  var trmEfectiva=aplicaFracc&&tasaPromedio>0?tasaPromedio:(+f.trmAcordada||0);
  var excedeMonto=aplicaFracc&&(+f.montoOrigen||0)>0&&totalUSDComprado>(+f.montoOrigen||0);
  var faltaUSD=aplicaFracc&&(+f.montoOrigen||0)>0&&totalUSDComprado>0&&totalUSDComprado<(+f.montoOrigen||0);
  function setCompra(i,k,v){setCompras(function(prev){var n=prev.slice();n[i]=Object.assign({},n[i]);n[i][k]=v;return n;});}
  // Derivacion por fila: monto USD + (tasa | totalCOP) -> calcula el faltante. Todo sincronico (sin useEffect).
  function setCompraField(i,field,value){
    setCompras(function(prev){
      var n=prev.slice(); var row=Object.assign({},n[i]); row[field]=value;
      var usd=+row.monto||0;
      if(field==='totalCOP'){ if(usd>0) row.tasa=(+value)>0?Math.round((+value)/usd):''; }
      else if(field==='tasa'){ if(usd>0) row.totalCOP=(+value)>0?Math.round((+value)*usd):''; }
      else if(field==='monto'){ if(usd>0){ if((+row.tasa)>0) row.totalCOP=Math.round((+row.tasa)*usd); else if((+row.totalCOP)>0) row.tasa=Math.round((+row.totalCOP)/usd); } }
      n[i]=row; return n;
    });
  }
  function addCompra(){setCompras(function(prev){return prev.concat([{monto:'',tasa:'',totalCOP:''}]);});}
  function delCompra(i){setCompras(function(prev){if(prev.length<=1)return prev;var n=prev.slice();n.splice(i,1);return n;});}
  // Modo simple: Tasa <-> Total COP derivados via Capital USD (todo sincronico, sin useEffect -> sin loops)
  function syncSimpleFromTasa(v){ set('trmAcordada',v); var usd=+f.montoOrigen||0; if(usd>0) setTotalCOPInput((+v)>0?Math.round((+v)*usd):''); }
  function syncSimpleFromTotal(v){ setTotalCOPInput(v); var usd=+f.montoOrigen||0; if(usd>0) set('trmAcordada',(+v)>0?Math.round((+v)/usd):''); }
  function syncMonto(raw){ var v=parseNum(raw); set('montoOrigen',v); if(f.moneda==='USD'&&!compraFrac){ var usd=+v||0; if(usd>0){ if((+f.trmAcordada)>0) setTotalCOPInput(Math.round((+f.trmAcordada)*usd)); else if((+totalCOPInput)>0) set('trmAcordada',Math.round((+totalCOPInput)/usd)); } } }
  var esSI=f.modalidad==='Intereses';
  var esUnaCuota=f.modalidad==='Prestamo'||f.modalidad==='Pago Unico'; // v1.10.0: ambas son 1 cuota
  // Credito abierto: sin plazo, sin frecuencia y sin cronograma. Solo capital, tasa y
  // fecha de inicio — que PUEDE ser pasada: el motor devenga los dias transcurridos.
  var esDiarioF=f.modalidad===MODALIDAD_DIARIA;
  var montoCOP=f.moneda==='USD'?Math.round((+f.montoOrigen||0)*(trmEfectiva||1)):(+f.montoOrigen||0);
  // v1.10.0 — Calculo de ganancia para Pago Unico segun modo elegido
  // gananciaCOPCalc es el valor efectivo en COP que se va a persistir/mostrar
  var gananciaCOPCalc=(function(){
    if(f.modalidad!=='Pago Unico') return 0;
    var val=+f.gananciaInput||0;
    if(val<=0) return 0;
    if(f.gananciaMode==='pct') return Math.round(montoCOP*val/100);
    // modo 'monto': si la moneda es USD el input son USD → convertir a COP con TRM
    if(f.moneda==='USD'&&trmEfectiva>0) return Math.round(val*trmEfectiva);
    return Math.round(val);
  })();
  // % implicito derivado para el indicador de equivalencia
  var gananciaPctImpl=montoCOP>0?Math.round(gananciaCOPCalc/montoCOP*10000)/100:0;
  var preview=useMemo(function(){
    if(!montoCOP) return {cuota:0,totalInt:0,rows:[],totalPagar:0};
    var n=+f.plazoMeses||12;
    var rMensual=+f.tasaMensual/100;
    var freq=f.frecuencia||'Mensual';
    var r=freq==='Semanal'?rMensual/4.33:freq==='Quincenal'?rMensual/2:rMensual;
    var c;
    if(f.modalidad==='Prestamo'){c=montoCOP;}
    else if(f.modalidad==='Pago Unico'){c=montoCOP+gananciaCOPCalc;}
    else if(f.modalidad==='Intereses'){c=Math.round(montoCOP*r);}
    // Credito abierto: no hay cuota. Lo que se previsualiza es el interes que genera
    // UN DIA, que es la unidad real del producto. Sin esta rama caeria en el PMT con
    // plazo 0 y daria Infinity.
    else if(f.modalidad===MODALIDAD_DIARIA){c=Math.round(montoCOP*rMensual/30);}
    else{c=Math.round(pmt(r,n,montoCOP));}
    // Cronograma tentativo. El bucle vive en `filasPreview` (core/calculo.js), espejo
    // del motor: antes esta copia y la de CalcView desviaban la ultima cuota (Bug #51).
    var rows=[];
    if(c>0){
      if(f.modalidad==='Prestamo'){
        rows.push({n:1,interes:0,capital:montoCOP,cuota:montoCOP,saldo:0});
      } else if(f.modalidad==='Pago Unico'){
        // v1.10.0 — 1 cuota: interes = ganancia, capital = montoCOP
        rows.push({n:1,interes:gananciaCOPCalc,capital:montoCOP,cuota:montoCOP+gananciaCOPCalc,saldo:0});
      } else {
        var nFilas=f.modalidad==='Intereses'?Math.min(n||12,24):n;
        rows=filasPreview(montoCOP,r,nFilas,f.modalidad==='Intereses',c);
      }
    }
    var totalInt=rows.reduce(function(s,r){return s+r.interes;},0);
    var totalPagar=rows.reduce(function(s,r){return s+r.cuota;},0);
    return {cuota:c,totalInt:totalInt,rows:rows,totalPagar:totalPagar};
  },[montoCOP,f.tasaMensual,f.plazoMeses,f.modalidad,f.frecuencia,gananciaCOPCalc]);
  var scs=useState(false); var showCronoLoan=scs[0]; var setShowCronoLoan=scs[1];
  // Anti-doble-clic: bloquea el boton tras el primer click para evitar duplicados
  var sub=useState(false); var isSubmitting=sub[0]; var setIsSubmitting=sub[1];
  function submit(){
    if(isSubmitting) return; // bloqueo defensivo
    var needsPlazo=f.modalidad==='Capital + Intereses';
    var errores=[];
    if(!f.nombre.trim()) errores.push('Nombre');
    if(!f.montoOrigen||+f.montoOrigen<=0) errores.push('Monto');
    if(needsPlazo&&(!f.plazoMeses||+f.plazoMeses<=0)) errores.push('Plazo');
    if(errores.length>0){showError('Falta completar: '+errores.join(', '));return;}
    if(aplicaFracc&&comprasValidas.length===0){showError('Agrega al menos una compra valida o desactiva las compras fraccionadas');return;}
    if(aplicaFracc&&excedeMonto){showError('El total de compras ('+Math.round(totalUSDComprado).toLocaleString('es-CO')+' USD) excede el monto del prestamo');return;}
    var esPrestamo=f.modalidad==='Prestamo';
    var esPagoUnico=f.modalidad==='Pago Unico';
    var esUnaCuotaSubmit=esPrestamo||esPagoUnico;
    if(esUnaCuotaSubmit&&!f.fechaDevolucion){showError('Falta la fecha de pago');return;}
    // v1.10.0 — Pago Unico debe tener ganancia >= 0 (puede ser 0 si el user quiere sin ganancia)
    if(esPagoUnico&&(+f.gananciaInput||0)<0){showError('La ganancia no puede ser negativa');return;}
    var base=isNew?{}:(loan||{});
    var diaPagoAuto=new Date(f.fechaInicio+'T12:00:00').getDate();
    var trmFinal=aplicaFracc&&tasaPromedio>0?tasaPromedio:(+f.trmAcordada||0);
    var comprasFinal=aplicaFracc&&comprasValidas.length>0?JSON.stringify(comprasValidas.map(function(c){return {monto:+c.monto,tasa:+c.tasa};})):'';
    var extra={
      montoOrigen:+f.montoOrigen,trmAcordada:trmFinal,montoCOP:montoCOP,
      tasaMensual:esUnaCuotaSubmit?0:(+f.tasaMensual||0),
      plazoMeses:esUnaCuotaSubmit?1:(+f.plazoMeses||0),
      diaPago:diaPagoAuto,
      // El credito abierto no cobra por frecuencia (devenga por dias), pero la columna
      // es NOT NULL con default: se normaliza para que ninguna ruta lea un valor suelto.
      frecuencia:(esUnaCuotaSubmit||f.modalidad===MODALIDAD_DIARIA)?'Mensual':(f.frecuencia||'Mensual'),
      comprasUSD:comprasFinal,
      gananciaFija:esPagoUnico?gananciaCOPCalc:0
    };
    if(esUnaCuotaSubmit&&f.fechaDevolucion) extra.fechaDevolucion=f.fechaDevolucion;
    // Defense-in-depth (v1.9.0): si los campos sensibles estan bloqueados, sobrescribir
    // con los valores ORIGINALES del prestamo antes de enviar al backend. Asi, aunque el
    // `disabled` falle por algun bug de UI, la BD nunca se corrompe.
    // (Object.assign({},base,f,extra) hace que `extra` gane sobre `f` — sufuciente.)
    if(lockSens&&loan){
      extra.moneda=loan.moneda;
      extra.montoOrigen=loan.montoOrigen;
      extra.trmAcordada=loan.trmAcordada;
      extra.montoCOP=loan.montoCOP;
      extra.tasaMensual=loan.tasaMensual;
      extra.plazoMeses=loan.plazoMeses;
      extra.modalidad=loan.modalidad;
      extra.frecuencia=loan.frecuencia;
      extra.fechaInicio=loan.fechaInicio;
      extra.fechaDevolucion=loan.fechaDevolucion||'';
      extra.comprasUSD=loan.comprasUSD||'';
      // v1.10.0: gananciaFija tambien queda bloqueada si hay actividad
      extra.gananciaFija=loan.gananciaFija||0;
    }
    setIsSubmitting(true);
    onSave(Object.assign({},base,f,extra));
    // Safety net: si por alguna razon el modal sigue abierto despues de 5s, re-habilitar el boton
    setTimeout(function(){setIsSubmitting(false);},5000);
  }
  return h(Modal,{onClose:onClose,tall:true,wide:true},
    h('div',{style:{fontWeight:700,fontSize:16,color:'var(--text)',marginBottom:4}},!isNew?'Editar Prestamo':'Nuevo Prestamo'),
    // v1.9.0 — Banner de campos bloqueados (solo en edicion con actividad)
    lockSens&&h('div',{style:{background:'var(--yellow-bg)',border:'1px solid var(--yellow)',borderRadius:10,padding:'10px 12px',marginBottom:10,display:'flex',alignItems:'flex-start',gap:8}},
      h(Ico,{name:'alert',size:14,color:'var(--yellow)',sw:2.4}),
      h('div',{style:{flex:1}},
        h('div',{style:{fontSize:12,color:'var(--yellow)',fontWeight:700,marginBottom:2}},'Algunos campos estan bloqueados'),
        h('div',{style:{fontSize:11,color:'var(--text2)',lineHeight:1.4}},'Este prestamo ya registra pagos, abonos o cuotas en mora. Para preservar la integridad del cronograma pactado, los campos que afectan a la amortizacion no se pueden modificar.'))),
    // QA7 — Cliente: input unico con autocompletado hibrido (reemplaza las pestañas nuevo/existente).
    // Texto libre = cliente nuevo; elegir una sugerencia prefilla nombre/cedula/telefono (existente)
    // y el backend lo consolida por nombre (saveLoan auto-vincula). Misma estetica que DebtModal.
    h(Fld,{label:'Nombre del cliente *'},
      h('div',{style:{position:'relative'}},
        h('input',{value:f.nombre,onChange:function(e){set('nombre',e.target.value);setClientOpen(true);},onFocus:function(){setClientOpen(true);},onBlur:function(){setClientOpen(false);},placeholder:'Nombre completo',className:'inp',autoFocus:isNew,autoComplete:'off'}),
        cliOpen?h('div',{style:{position:'absolute',top:'100%',left:0,right:0,zIndex:30,marginTop:4,background:'var(--bg3)',border:'1px solid var(--border)',borderRadius:10,boxShadow:'0 8px 24px rgba(0,0,0,.35)',overflow:'hidden',maxHeight:200,overflowY:'auto'}},
          clientesMatch.map(function(c){
            var sub=[c.cedula&&c.cedula!=='0'?'CC '+c.cedula:'',c.telefono&&c.telefono!=='0'?c.telefono:''].filter(Boolean).join('  ·  ');
            return h('div',{key:c.nombre,onMouseDown:function(e){e.preventDefault();pickCliente(c);},onMouseEnter:function(e){e.currentTarget.style.background='var(--bg4)';},onMouseLeave:function(e){e.currentTarget.style.background='transparent';},style:{padding:'9px 12px',cursor:'pointer',transition:'background .12s',display:'flex',alignItems:'center',gap:8}},
              h(Ico,{name:'users',size:13,color:'var(--text3)'}),
              h('div',{style:{minWidth:0}},
                h('div',{style:{fontSize:13,fontWeight:600,color:'var(--text)',whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis'}},c.nombre),
                sub?h('div',{style:{fontSize:11,color:'var(--text3)',marginTop:1,whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis'}},sub):null));
          })):null)),
    h('div',{style:{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10}},
      h(Fld,{label:'Cedula / ID'},h('input',{value:f.cedula,  onChange:function(e){set('cedula',  e.target.value);},placeholder:'0000000',className:'inp'})),
      h(Fld,{label:'Telefono'},   h('input',{value:f.telefono,onChange:function(e){set('telefono',e.target.value);},placeholder:'+57...',  className:'inp'}))),
    h('div',{style:{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10}},
      h(Fld,{label:'Moneda'},h('select',{value:f.moneda,onChange:function(e){set('moneda',e.target.value);},className:'inp',disabled:lockSens,style:lockSens?{background:'var(--bg3)',color:'var(--text3)',cursor:'not-allowed'}:{}},h('option',null,'COP'),h('option',null,'USD'))),
      h(Fld,{label:f.moneda==='USD'?'Monto original (USD) *':'Monto (COP) *'},h('input',{type:'text',inputMode:'numeric',value:fmtNumInput(f.montoOrigen),onChange:function(e){if(!lockSens)syncMonto(e.target.value);},placeholder:'0',className:'inp',disabled:lockSens,style:lockSens?{background:'var(--bg3)',color:'var(--text3)',cursor:'not-allowed'}:{}}))),
    // Modo simple (una compra): Tasa <-> Total pagado en COP sincronizados por derivacion
    f.moneda==='USD'&&!aplicaFracc&&h('div',{style:{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10}},
      h(Fld,{label:'Tasa de cambio (COP x 1 USD)'},
        h('input',{type:'text',inputMode:'numeric',value:fmtNumInput(f.trmAcordada),onChange:function(e){if(!lockSens)syncSimpleFromTasa(parseNum(e.target.value));},placeholder:'0',className:'inp',disabled:lockSens,style:lockSens?{background:'var(--bg3)',color:'var(--text3)',cursor:'not-allowed'}:{}})),
      h(Fld,{label:'Total pagado en COP'},
        h('input',{type:'text',inputMode:'numeric',value:fmtNumInput(totalCOPInput),onChange:function(e){if(!lockSens)syncSimpleFromTotal(parseNum(e.target.value));},placeholder:'0',className:'inp',disabled:lockSens,style:lockSens?{background:'var(--bg3)',color:'var(--text3)',cursor:'not-allowed'}:{}}))),
    // Modo fraccionado: la tasa es la promedio ponderada (solo lectura)
    f.moneda==='USD'&&aplicaFracc&&h(Fld,{label:'Tasa de compra de USD (COP x 1 USD) — calculada automaticamente'},
      h('input',{type:'text',inputMode:'numeric',value:tasaPromedio>0?fmtNumInput(tasaPromedio):'',onChange:function(){},className:'inp',disabled:true,placeholder:'Llena el desglose abajo',style:{background:'var(--bg3)',color:'var(--text3)',cursor:'not-allowed'}})),
    f.moneda==='USD'&&h('div',{style:{fontSize:11,color:'var(--blue)',marginTop:4,marginBottom:8,fontFamily:'monospace'}},'Capital en COP: '+fmt(montoCOP)),
    f.moneda==='USD'&&h('label',{style:{display:'flex',alignItems:'center',gap:10,background:'var(--bg3)',border:'1px solid '+(compraFrac?'var(--blue)':'var(--border)'),borderRadius:10,padding:'10px 12px',marginBottom:8,cursor:lockSens?'not-allowed':'pointer',transition:'border-color .2s',opacity:lockSens?.5:1}},
      h('input',{type:'checkbox',checked:compraFrac,onChange:function(){if(!lockSens)setCompraFrac(!compraFrac);},disabled:lockSens,style:{width:16,height:16,accentColor:'var(--blue)',cursor:lockSens?'not-allowed':'pointer',margin:0}}),
      h('span',{style:{fontSize:13,color:'var(--text)',fontWeight:500}},'¿Compraste el USD en varias partes/tasas?')),
    f.moneda==='USD'&&compraFrac&&h('div',{style:{background:'rgba(88,166,255,.04)',border:'1px solid var(--blue-bd)',borderRadius:12,padding:'12px',marginBottom:8}},
      h('div',{style:{fontSize:10,fontWeight:700,color:'var(--blue)',letterSpacing:.5,marginBottom:8,display:'flex',alignItems:'center',gap:5}},
        h(Ico,{name:'dollar',size:11,color:'var(--blue)'}),' DESGLOSE DE COMPRAS DE USD'),
      compras.map(function(c,i){
        return h('div',{key:i,style:{display:'flex',gap:8,alignItems:'flex-end',marginBottom:8}},
          h('div',{style:{flex:1}},
            h('div',{style:{fontSize:10,color:'var(--text3)',fontWeight:600,marginBottom:3}},'Compra '+(i+1)+' (USD)'),
            h('input',{type:'text',inputMode:'numeric',value:fmtNumInput(c.monto),onChange:function(e){if(!lockSens)setCompraField(i,'monto',parseNum(e.target.value));},placeholder:'0',className:'inp',disabled:lockSens,style:lockSens?{background:'var(--bg3)',color:'var(--text3)',cursor:'not-allowed'}:{}})),
          h('div',{style:{flex:1}},
            h('div',{style:{fontSize:10,color:'var(--text3)',fontWeight:600,marginBottom:3}},'Tasa (COP)'),
            h('input',{type:'text',inputMode:'numeric',value:fmtNumInput(c.tasa),onChange:function(e){if(!lockSens)setCompraField(i,'tasa',parseNum(e.target.value));},placeholder:'0',className:'inp',disabled:lockSens,style:lockSens?{background:'var(--bg3)',color:'var(--text3)',cursor:'not-allowed'}:{}})),
          h('div',{style:{flex:1}},
            h('div',{style:{fontSize:10,color:'var(--text3)',fontWeight:600,marginBottom:3}},'Total pagado (COP)'),
            h('input',{type:'text',inputMode:'numeric',value:fmtNumInput(c.totalCOP),onChange:function(e){if(!lockSens)setCompraField(i,'totalCOP',parseNum(e.target.value));},placeholder:'0',className:'inp',disabled:lockSens,style:lockSens?{background:'var(--bg3)',color:'var(--text3)',cursor:'not-allowed'}:{}})),
          h('button',{onClick:function(){if(!lockSens)delCompra(i);},disabled:lockSens||compras.length<=1,title:'Eliminar fila',style:{flexShrink:0,padding:'9px 10px',background:'var(--bg3)',border:'1px solid var(--border)',borderRadius:8,color:'var(--red)',cursor:(lockSens||compras.length<=1)?'not-allowed':'pointer',opacity:(lockSens||compras.length<=1)?.4:1,display:'flex',alignItems:'center'}},h(Ico,{name:'x',size:13,color:'var(--red)',sw:2.4})));
      }),
      h('button',{onClick:function(){if(!lockSens)addCompra();},disabled:lockSens,style:{width:'100%',padding:'8px 0',background:'transparent',border:'1px dashed var(--blue)',borderRadius:8,color:'var(--blue)',fontSize:12,fontWeight:600,cursor:lockSens?'not-allowed':'pointer',display:'flex',alignItems:'center',justifyContent:'center',gap:6,marginBottom:10,opacity:lockSens?.5:1}},
        h(Ico,{name:'plus',size:12,color:'var(--blue)',sw:2.4}),' Añadir otra compra'),
      h('div',{style:{borderTop:'1px solid var(--blue-bd)',paddingTop:10,marginTop:4}},
        excedeMonto&&h('div',{style:{background:'var(--red-bg)',border:'1px solid var(--red-bd)',borderRadius:8,padding:'8px 10px',marginBottom:8,fontSize:11,color:'var(--red)',display:'flex',alignItems:'center',gap:6}},
          h(Ico,{name:'alert',size:12,color:'var(--red)',sw:2.4}),' El total de compras excede el monto del prestamo'),
        faltaUSD&&h('div',{style:{background:'var(--yellow-bg)',border:'1px solid var(--yellow)',borderRadius:8,padding:'8px 10px',marginBottom:8,fontSize:11,color:'var(--yellow)'}},
          'Faltan '+fmtN(Math.max(0,(+f.montoOrigen||0)-totalUSDComprado))+' USD por registrar'),
        h('div',{style:{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'6px 0',fontSize:12}},
          h('span',{style:{color:'var(--text3)'}},'Total USD comprado'),
          h('span',{className:'mono',style:{color:excedeMonto?'var(--red)':'var(--text)',fontWeight:500}},fmtN(totalUSDComprado)+' USD')),
        h('div',{style:{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'6px 0',fontSize:12,borderTop:'1px solid var(--bg3)'}},
          h('span',{style:{color:'var(--text3)'}},'Total invertido en COP'),
          h('span',{className:'mono',style:{color:'var(--text)',fontWeight:500}},fmt(totalCOPInvertido))),
        h('div',{style:{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'8px 0 4px',borderTop:'1px solid var(--bg3)'}},
          h('span',{style:{color:'var(--blue)',fontSize:11,fontWeight:600,letterSpacing:.5}},'TASA PROMEDIO PONDERADA'),
          h('span',{className:'mono',style:{color:'var(--blue)',fontWeight:600,fontSize:15}},tasaPromedio>0?fmt(tasaPromedio):'-')))),
    h(Fld,{label:h('span',{style:{display:'flex',alignItems:'center',gap:6}},'Modalidad',
      h('span',{style:{position:'relative',display:'inline-flex'},className:'tooltip-wrap'},
        h('span',{style:{display:'inline-flex',alignItems:'center',justifyContent:'center',width:16,height:16,borderRadius:'50%',border:'1.5px solid var(--text3)',fontSize:10,fontWeight:700,color:'var(--text3)',cursor:'help',lineHeight:1}},'i'),
        h('span',{className:'tooltip-box'},
          h('b',null,'Intereses:'),' Solo paga intereses mensuales. El capital se devuelve al final. Plazo indefinido.',h('br',null),h('br',null),
          h('b',null,'Capital + Intereses:'),' Cuota fija mensual (amortizacion francesa). Cada cuota incluye intereses + parte del capital. Plazo fijo.',h('br',null),h('br',null),
          h('b',null,'Prestamo:'),' Sin intereses. Se presta un monto y se paga en una sola cuota.',h('br',null),h('br',null),
          h('b',null,'Pago Unico:'),' Una sola cuota en fecha exacta + ganancia personalizable (por % o monto fijo). Ideal para negocios cortos.',h('br',null),h('br',null),
          h('b',null,'Interes Diario:'),' Credito abierto: el interes se genera cada dia sobre el capital vivo, sin cuotas ni plazo. El cliente paga intereses o abona capital cuando quiera. La fecha de inicio puede ser pasada: se devengan los dias transcurridos.',h('br',null),h('br',null),
          h('span',{style:{color:'var(--text3)',fontStyle:'italic'}},'En todas las modalidades se pueden hacer abonos a capital para reducir el saldo. En Interes Diario el abono se registra como un CORTE, que baja el capital y liquida el interes en el mismo movimiento.'))))},
      h('select',{value:f.modalidad,onChange:function(e){var m=e.target.value;set('modalidad',m);
        if(m==='Prestamo'||m==='Pago Unico'){set('tasaMensual','0');set('plazoMeses','1');}
        // El credito abierto no tiene plazo: se normaliza al centinela 0, que es lo que
        // el backend espera y lo que deja `buildSchedule` inerte.
        if(m===MODALIDAD_DIARIA){set('plazoMeses','0');}},className:'inp',disabled:lockSens,style:lockSens?{background:'var(--bg3)',color:'var(--text3)',cursor:'not-allowed'}:{}},
      h('option',null,'Intereses'),
      h('option',null,'Capital + Intereses'),
      h('option',null,'Prestamo'),
      h('option',null,'Pago Unico'),
      h('option',null,MODALIDAD_DIARIA))),
    !esUnaCuota&&!esDiarioF&&h(Fld,{label:'Frecuencia de cobro'},h('select',{value:f.frecuencia,onChange:function(e){set('frecuencia',e.target.value);},className:'inp',disabled:lockSens,style:lockSens?{background:'var(--bg3)',color:'var(--text3)',cursor:'not-allowed'}:{}},
      h('option',null,'Semanal'),h('option',null,'Quincenal'),h('option',null,'Mensual'))),
    // Credito abierto: solo TASA. No hay plazo que pedir, y dejar el campo visible
    // invitaria a escribir un numero que el motor ignora.
    esDiarioF&&h(Fld,{label:'Tasa mensual (%)'},
      h('input',{type:'text',inputMode:'decimal',value:f.tasaMensual,onChange:function(e){set('tasaMensual',parseDecimalInput(e.target.value));},placeholder:'0.00',className:'inp',disabled:lockSens,style:lockSens?{background:'var(--bg3)',color:'var(--text3)',cursor:'not-allowed'}:{}}),
      (+f.tasaMensual)>0&&h('div',{style:{fontSize:11,marginTop:4,color:'var(--text3)',fontFamily:'monospace'}},
        'Se aplicara: '+(+f.tasaMensual)+'% mensual — '+fmt(Math.round(montoCOP*(+f.tasaMensual||0)/100/30))+' por dia')),
    !esUnaCuota&&!esDiarioF&&h('div',{style:{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10}},
      h(Fld,{label:'Tasa mensual (%)'},
        h('input',{type:'text',inputMode:'decimal',value:f.tasaMensual,onChange:function(e){set('tasaMensual',parseDecimalInput(e.target.value));},placeholder:'0.00',className:'inp',disabled:lockSens,style:lockSens?{background:'var(--bg3)',color:'var(--text3)',cursor:'not-allowed'}:{}}),
        (+f.tasaMensual)>0&&h('div',{style:{fontSize:11,marginTop:4,color:'var(--text3)',fontFamily:'monospace'}},'Se aplicara: '+(+f.tasaMensual)+'% mensual')),
      h(Fld,{label:f.modalidad==='Capital + Intereses'?(f.frecuencia==='Semanal'?'Plazo (semanas) *':f.frecuencia==='Quincenal'?'Plazo (quincenas) *':'Plazo (meses) *'):'\u221E Plazo indefinido'},
        h('input',{type:'text',inputMode:'numeric',value:f.plazoMeses,onChange:function(e){set('plazoMeses',parseIntInput(e.target.value));},placeholder:f.modalidad==='Capital + Intereses'?'12':'\u221E',className:'inp',disabled:lockSens||f.modalidad==='Intereses',style:lockSens?{background:'var(--bg3)',color:'var(--text3)',cursor:'not-allowed'}:{}}))),
    esUnaCuota?h('div',{style:{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10}},
      h(Fld,{label:f.modalidad==='Pago Unico'?'Fecha del prestamo':'Fecha del prestamo'},h('input',{type:'date',value:f.fechaInicio,onChange:function(e){set('fechaInicio',e.target.value);},className:'inp',disabled:lockSens,style:lockSens?{background:'var(--bg3)',color:'var(--text3)',cursor:'not-allowed'}:{}})),
      h(Fld,{label:f.modalidad==='Pago Unico'?'Fecha exacta de pago':'Fecha de devolucion'},h('input',{type:'date',value:f.fechaDevolucion||'',onChange:function(e){set('fechaDevolucion',e.target.value);},className:'inp',min:f.fechaInicio,disabled:lockSens,style:lockSens?{background:'var(--bg3)',color:'var(--text3)',cursor:'not-allowed'}:{}})))
    :h(Fld,{label:'Fecha de inicio'},h('input',{type:'date',value:f.fechaInicio,onChange:function(e){set('fechaInicio',e.target.value);},className:'inp',disabled:lockSens,style:lockSens?{background:'var(--bg3)',color:'var(--text3)',cursor:'not-allowed'}:{}})),
    // v1.10.0 — Bloque Ganancia para modalidad Pago Unico: toggle %/monto + indicador de equivalencia
    f.modalidad==='Pago Unico'&&h('div',{style:{background:'rgba(63,185,80,.04)',border:'1px solid var(--green-bd)',borderRadius:12,padding:'12px 14px',marginBottom:8}},
      h('div',{style:{fontSize:10,fontWeight:700,color:'var(--green)',letterSpacing:.5,marginBottom:10,display:'flex',alignItems:'center',gap:5}},
        h(Ico,{name:'dollar',size:11,color:'var(--green)'}),' GANANCIA PACTADA'),
      // Toggle de modo: pct vs monto
      h('div',{style:{display:'flex',gap:8,marginBottom:10}},
        h('label',{style:{flex:1,display:'flex',alignItems:'center',gap:6,padding:'8px 10px',border:'1px solid '+(f.gananciaMode==='pct'?'var(--green)':'var(--border)'),borderRadius:8,cursor:lockSens?'not-allowed':'pointer',background:f.gananciaMode==='pct'?'rgba(63,185,80,.08)':'transparent',transition:'all .15s',opacity:lockSens?.5:1}},
          h('input',{type:'radio',name:'gananciaMode',checked:f.gananciaMode==='pct',onChange:function(){if(!lockSens){set('gananciaMode','pct');set('gananciaInput','');}},disabled:lockSens,style:{accentColor:'var(--green)',cursor:lockSens?'not-allowed':'pointer'}}),
          h('span',{style:{fontSize:12,color:'var(--text)',fontWeight:500}},'Por porcentaje')),
        h('label',{style:{flex:1,display:'flex',alignItems:'center',gap:6,padding:'8px 10px',border:'1px solid '+(f.gananciaMode==='monto'?'var(--green)':'var(--border)'),borderRadius:8,cursor:lockSens?'not-allowed':'pointer',background:f.gananciaMode==='monto'?'rgba(63,185,80,.08)':'transparent',transition:'all .15s',opacity:lockSens?.5:1}},
          h('input',{type:'radio',name:'gananciaMode',checked:f.gananciaMode==='monto',onChange:function(){if(!lockSens){set('gananciaMode','monto');set('gananciaInput','');}},disabled:lockSens,style:{accentColor:'var(--green)',cursor:lockSens?'not-allowed':'pointer'}}),
          h('span',{style:{fontSize:12,color:'var(--text)',fontWeight:500}},'Por monto fijo'))),
      // Input principal
      f.gananciaMode==='pct'?h(Fld,{label:'Porcentaje sobre el capital (%)'},
        h('input',{type:'text',inputMode:'decimal',value:f.gananciaInput,onChange:function(e){if(!lockSens)set('gananciaInput',parseDecimalInput(e.target.value));},placeholder:'10.00',className:'inp',disabled:lockSens,style:lockSens?{background:'var(--bg3)',color:'var(--text3)',cursor:'not-allowed'}:{}}),
        gananciaCOPCalc>0&&h('div',{style:{fontSize:11,color:'var(--text3)',marginTop:4,fontFamily:'monospace'}},'Equivale a '+fmt(gananciaCOPCalc)+' sobre '+fmt(montoCOP))
      ):h(Fld,{label:f.moneda==='USD'?'Monto fijo de ganancia (USD)':'Monto fijo de ganancia (COP)'},
        h('input',{type:'text',inputMode:'numeric',value:fmtNumInput(f.gananciaInput),onChange:function(e){if(!lockSens)set('gananciaInput',parseNum(e.target.value));},placeholder:'0',className:'inp',disabled:lockSens,style:lockSens?{background:'var(--bg3)',color:'var(--text3)',cursor:'not-allowed'}:{}}),
        gananciaCOPCalc>0&&h('div',{style:{fontSize:11,color:'var(--text3)',marginTop:4,fontFamily:'monospace'}},
          f.moneda==='USD'?'Equivale a '+fmt(gananciaCOPCalc)+' COP ('+gananciaPctImpl+'% del capital)':'Equivale al '+gananciaPctImpl+'% del capital'))),
    !isNew&&h(Fld,{label:'Estado'},h('select',{value:f.estado,onChange:function(e){set('estado',e.target.value);},className:'inp'},
      h('option',{value:'Activo'},'Activo'),
      h('option',{value:'Finalizado'},'Finalizado'),
      h('option',{value:'Cancelado'},'Cancelado (cierre forzoso)'))),
    h(Fld,{label:'Notas'},h('textarea',{value:f.notas,onChange:function(e){set('notas',e.target.value);},placeholder:'Observaciones opcionales...',rows:2,className:'inp',style:{resize:'none'}})),
    preview.cuota>0&&h('div',{style:{background:'var(--green-bg)',border:'1px solid var(--green-bd)',borderRadius:12,padding:'12px 14px'}},
      h('div',{style:{fontSize:11,color:'var(--green)',fontWeight:700,marginBottom:8}},'Resumen'),
      h('div',{style:{display:'flex',justifyContent:'space-between',marginBottom:5}},
        h('span',{style:{fontSize:12,color:'var(--text2)'}},f.modalidad==='Prestamo'?'Monto a devolver':f.modalidad==='Pago Unico'?'Total a cobrar (capital + ganancia)':f.modalidad==='Intereses'?'Cuota de interes'+(f.frecuencia==='Semanal'?' semanal':f.frecuencia==='Quincenal'?' quincenal':' mensual'):'Cuota '+(f.frecuencia==='Semanal'?'semanal':f.frecuencia==='Quincenal'?'quincenal':'mensual')),
        h('span',{className:'mono',style:{fontSize:12,fontWeight:700,color:f.modalidad==='Prestamo'?'var(--blue)':'var(--green)'}},fmt(preview.cuota))),
      f.moneda==='USD'&&trmEfectiva>0&&h('div',{style:{display:'flex',justifyContent:'space-between'}},
        h('span',{style:{fontSize:12,color:'var(--text2)'}},'Cuota '+freqCuotaLabel(f.frecuencia)+' en USD'),
        h('span',{className:'mono',style:{fontSize:12,fontWeight:700,color:'var(--yellow)'}},fmtUSD(preview.cuota/(trmEfectiva||1)))),
      f.modalidad==='Intereses'&&h('div',{style:{fontSize:11,color:'var(--blue)',marginTop:6}},'\u221E Plazo indefinido - paga intereses hasta abonar todo el capital'),
      esDiarioF&&h('div',{style:{fontSize:11,color:'var(--blue)',marginTop:6,lineHeight:1.5}},
        'Sin cuotas ni plazo: el interes se devenga cada dia sobre el capital vivo. El cliente paga intereses o abona capital cuando quiera, y cada movimiento se registra como un CORTE.',
        f.fechaInicio&&f.fechaInicio<nowStr()&&h('div',{style:{marginTop:4,color:'var(--yellow)',fontWeight:600}},
          'Fecha de inicio en el pasado: al crearlo ya traera '+diasEntre(f.fechaInicio,nowStr())+' dia(s) de interes devengado ('+fmt(Math.round(montoCOP*(+f.tasaMensual||0)/100/30*diasEntre(f.fechaInicio,nowStr())))+').')),
      f.modalidad==='Prestamo'&&f.fechaDevolucion&&h('div',{style:{fontSize:11,color:'var(--yellow)',marginTop:6}},'Sin intereses - devolucion: '+fmtD(f.fechaDevolucion)),
      f.modalidad==='Pago Unico'&&f.fechaDevolucion&&h('div',{style:{fontSize:11,color:'var(--green)',marginTop:6}},'Vence el '+fmtD(f.fechaDevolucion)+' \u2014 capital '+fmt(montoCOP)+' + ganancia '+fmt(gananciaCOPCalc)),
      preview.rows&&preview.rows.length>0&&h('button',{onClick:function(){setShowCronoLoan(!showCronoLoan);},style:{marginTop:10,background:'none',border:'none',cursor:'pointer',color:'var(--green)',fontSize:12,fontWeight:600,display:'flex',alignItems:'center',gap:4,padding:0}},
        showCronoLoan?'Ocultar cronograma':'Ver cronograma tentativo'),
      showCronoLoan&&preview.rows&&preview.rows.length>0&&h('div',{style:{marginTop:10,borderTop:'1px solid var(--green-bd)',paddingTop:10,overflowX:'auto'}},
        h('table',{style:{width:'100%',borderCollapse:'collapse',fontSize:11}},
          h('thead',null,h('tr',{style:{background:'rgba(63,185,80,.1)'}},
            ['#','Interes','Abono a capital','Valor cuota','Saldo'].map(function(hd){
              return h('th',{key:hd,style:{padding:'6px 8px',textAlign:hd==='#'?'center':'right',fontWeight:600,color:'var(--text2)',whiteSpace:'nowrap'}},hd);}))),
          h('tbody',null,preview.rows.map(function(r){
            var t=trmEfectiva||1;
            return h('tr',{key:r.n,style:{borderTop:'1px solid rgba(63,185,80,.12)'}},
              h('td',{style:{padding:'5px 8px',textAlign:'center',color:'var(--text3)'}},r.n),
              h('td',{className:'mono',style:{padding:'5px 8px',textAlign:'right',color:'var(--yellow)'}},fmtN(r.interes),
                f.moneda==='USD'&&h('div',{style:{fontSize:9,color:'var(--blue)'}},copToUsd(r.interes,t))),
              h('td',{className:'mono',style:{padding:'5px 8px',textAlign:'right',color:'var(--blue)'}},fmtN(r.capital),
                f.moneda==='USD'&&h('div',{style:{fontSize:9,color:'var(--blue)'}},copToUsd(r.capital,t))),
              h('td',{className:'mono',style:{padding:'5px 8px',textAlign:'right',color:'var(--green)',fontWeight:600}},fmtN(r.cuota),
                f.moneda==='USD'&&h('div',{style:{fontSize:9,color:'var(--blue)',fontWeight:400}},copToUsd(r.cuota,t))),
              h('td',{className:'mono',style:{padding:'5px 8px',textAlign:'right',color:'var(--text3)',fontSize:10}},fmtN(r.saldo),
                f.moneda==='USD'&&h('div',{style:{fontSize:9,color:'var(--blue)'}},copToUsd(r.saldo,t))));
          }))))),
    h('button',{onClick:submit,disabled:isSubmitting,className:'btn-primary',style:{marginTop:8,opacity:isSubmitting?.6:1,cursor:isSubmitting?'not-allowed':'pointer'}},isSubmitting?(isNew?'Creando...':'Guardando...'):(!isNew?'Guardar cambios':'Crear prestamo')));
}
