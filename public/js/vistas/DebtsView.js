// public/js/vistas/DebtsView.js — Mis Deudas: lo que el usuario debe, agrupado por acreedor.
//
// Extraido de `app.js` en la Etapa 3 (B7) del refactor. Codigo VERBATIM.
//
// El estado global sigue viviendo en `App` y baja por PROPS, igual que antes.
// Sin Context API y sin store: eso seria rediseno, no refactor.

import { Ico } from '../componentes/iconos.js';
import { API } from '../core/api.js';
import { fmt, fmtD } from '../core/format.js';
import { h, useEffect, useMemo, useState } from '../core/react.js';
import { properCase } from '../core/ui.js';

// ── Mis Deudas (deudas propias, registro manual — Bloque 2) ───────────────────
export function DebtsView(props){
  var debts=props.debts||[];
  var onReload=props.onReload;
  var onNew=props.onNew;
  var onPay=props.onPay;
  var onEdit=props.onEdit;
  var onDelete=props.onDelete;
  var sExp=useState({}); var expanded=sExp[0]; var setExpanded=sExp[1];
  // Ledger por deuda: { [id]: {firma, pagos, error} }. GET /api/debts NO trae los
  // movimientos (solo los totales), asi que se piden por deuda al expandir el acreedor.
  var sMovs=useState({}); var movs=sMovs[0]; var setMovs=sMovs[1];
  function toggleExpand(key){ setExpanded(function(prev){ var n=Object.assign({},prev); n[key]=!n[key]; return n; }); }
  // Segundo nivel: cada deuda nace GUARDADA. Con varios prestamos del mismo acreedor,
  // abrir el perfil volcaba todos los ledgers a la vez y la pantalla se hacia ilegible.
  var sExpD=useState({}); var expDebt=sExpD[0]; var setExpDebt=sExpD[1];
  function toggleDebt(id){ setExpDebt(function(prev){ var n=Object.assign({},prev); n[id]=!n[id]; return n; }); }

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

  // ── Carga perezosa del ledger ───────────────────────────────────────────────
  // La FIRMA es el estado economico de la deuda: si cambia (se registro un abono o un
  // cargo), el ledger cacheado caduco y se vuelve a pedir. Sin esto, tras abonar la
  // tarjeta seguiria mostrando los movimientos viejos hasta recargar la vista.
  function firmaDeuda(d){
    return [d.id,d.saldo_pendiente,d.total_cargos,d.total_abonos,d.monto_original].join('|');
  }
  // Derivado puro: que deudas visibles necesitan su ledger. No es efecto todavia.
  var pendientes=[];
  grupos.forEach(function(g){
    if(!expanded[g.key]) return;
    g.deudas.forEach(function(d){
      if(!expDebt[d.id]) return;   // solo el detalle que el usuario abrio
      var c=movs[d.id];
      if(!c||c.firma!==firmaDeuda(d)) pendientes.push(d);
    });
  });
  // Clave estable: cuando no queda nada pendiente es '', y el efecto no se vuelve a
  // disparar (si dependiera de `movs` se realimentaria en bucle).
  var clavePendientes=pendientes.map(firmaDeuda).join(',');
  useEffect(function(){
    if(!clavePendientes) return;
    var vivo=true;
    pendientes.forEach(function(d){
      var f=firmaDeuda(d);
      API.get('/api/debts/'+d.id).then(function(r){
        if(!vivo) return;
        // Los helpers de API resuelven `null` en vez de rechazar: sin marcar el error
        // la tarjeta se quedaria en "Cargando..." para siempre.
        setMovs(function(prev){
          var n=Object.assign({},prev);
          n[d.id]={firma:f,pagos:(r&&r.pagos)||[],error:!r};
          return n;
        });
      });
    });
    return function(){ vivo=false; };
  },[clavePendientes]);

  // ── Despliegue: se anima la ALTURA, para que se VEA desplegarse ─────────────
  // Un fundido deja el contenido en su sitio de golpe; lo que se pidio es ver la
  // informacion abrirse. Eso obliga a animar la altura, y las dos vias declarativas
  // estan cerradas (ver el comentario de `.acc` en styles.css): `grid-template-rows`
  // se atasca en el primer despliegue y `interpolate-size` pide Chromium 129 cuando la
  // app corre sobre 122. WAAPI mide el contenido y anima entre dos alturas concretas.
  //
  // El estado previo se guarda EN EL PROPIO NODO (`_accOpen`), no en un ref por clave:
  // un nodo recien creado no lo tiene, asi que el primer render coloca la altura sin
  // animar y no hereda estado viejo al volver a la vista.
  function animarPanel(el, abrir){
    var alto=el.scrollHeight;
    el.style.overflow='hidden';
    var anim=el.animate(
      [{height:(abrir?0:alto)+'px',opacity:abrir?0:1},
       {height:(abrir?alto:0)+'px',opacity:abrir?1:0}],
      // 380ms con una curva pareja (la estandar de Material). Una curva muy cargada al
      // arranque —como cubic-bezier(.25,.8,.35,1)— llega al 91% de la altura a mitad de
      // camino: se ve un salto y luego una cola lenta, no un despliegue.
      {duration:380,easing:'cubic-bezier(.4,0,.2,1)'});
    // El estado FINAL se fija ya: si el contenido crece mientras esta abierto (se abre
    // una deuda dentro), `auto` lo acompana solo. Dejarlo en pixeles lo recortaria.
    el.style.height=abrir?'auto':'0px';
    el.style.opacity=abrir?'1':'0';
    anim.onfinish=function(){ if(abrir){ el.style.overflow=''; el.style.opacity=''; } };
  }
  useEffect(function(){
    var reduce=window.matchMedia&&window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    var paneles=document.querySelectorAll('[data-acc]');
    for(var i=0;i<paneles.length;i++){
      var el=paneles[i];
      var abrir=el.getAttribute('data-open')==='1';
      if(el._accOpen===abrir) continue;
      var primera=(el._accOpen===undefined);
      el._accOpen=abrir;
      if(primera||reduce){
        el.style.height=abrir?'auto':'0px';
        el.style.overflow=abrir?'':'hidden';
        el.style.opacity='';
        continue;
      }
      animarPanel(el,abrir);
    }
  });

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

  // ── EL LEDGER DE UNA DEUDA ──────────────────────────────────────────────────
  // El movimiento de APERTURA no existe en `pagos_deudas`: el saldo inicial vive en
  // `mis_deudas.monto_original`, en OTRA tabla. Por eso el estado de cuenta anunciaba
  // "1 movimiento" y "Cargos $1.400.000" bajo un saldo de $2.110.000 — la cuenta no
  // cuadraba en pantalla y faltaban $710.000 que no se listaban en ninguna parte.
  // Se sintetiza aqui, en la VISTA, sin tocar el esquema.
  var TAG={
    apertura:{txt:'Apertura',c:'var(--blue)', bg:'var(--blue-bg)', bd:'var(--blue-bd)'},
    cargo:   {txt:'Cargo',   c:'var(--red)',  bg:'var(--red-bg)',  bd:'var(--red-bd)'},
    abono:   {txt:'Abono',   c:'var(--green)',bg:'var(--green-bg)',bd:'var(--green-bd)'}
  };
  function movimientosDe(d){
    var cache=movs[d.id];
    var pagos=(cache&&cache.pagos)?cache.pagos.slice():[];
    // GET /api/debts/:id los devuelve del mas nuevo al mas viejo; el saldo corrido se
    // calcula al reves. `sort` es estable, asi que los del mismo dia conservan el orden
    // de insercion tras invertir.
    pagos.reverse();
    pagos.sort(function(a,b){ return String(a.fecha_pago||'').localeCompare(String(b.fecha_pago||'')); });
    // Con `monto_original` en 0 no hubo apertura: la cuenta arranco vacia y todo lo
    // que debe viene de cargos posteriores (caso real en los datos). Sintetizar una
    // fila de $0 seria ruido, asi que la lista empieza en el primer movimiento real.
    var base=+d.monto_original||0;
    var apertura={ id:'apertura-'+d.id, tipo:'apertura',
      fecha_pago:(d.fecha_creacion||'').slice(0,10),
      monto_pagado:base, notas:d.concepto||'' };
    var saldo=0;
    return (base>0?[apertura].concat(pagos):pagos).map(function(m){
      saldo+=(m.tipo==='abono'?-(+m.monto_pagado||0):(+m.monto_pagado||0));
      return {m:m,saldo:saldo};
    });
  }
  function movRow(x){
    var m=x.m, t=TAG[m.tipo]||TAG.cargo;
    return h('div',{key:m.id,style:{display:'grid',gridTemplateColumns:'1fr auto',gap:'3px 12px',background:'var(--bg3)',border:'1px solid var(--border)',borderLeft:'3px solid '+t.c,borderRadius:9,padding:'9px 11px'}},
      h('div',{style:{display:'flex',alignItems:'center',gap:8,flexWrap:'wrap',minWidth:0}},
        h('span',{style:{fontSize:9.5,fontWeight:700,letterSpacing:.5,textTransform:'uppercase',padding:'2px 7px',borderRadius:99,color:t.c,background:t.bg,border:'1px solid '+t.bd,flexShrink:0}},t.txt),
        // `pagos_deudas.fecha_pago` puede venir como 'YYYY-MM-DD HH:MM:SS'; `fmtD` le
        // concatena 'T12:00:00' y sin recortar sale Invalid Date.
        h('span',{style:{fontSize:12.5,fontWeight:600,color:'var(--text)'}},fmtD(String(m.fecha_pago||'').slice(0,10)))),
      h('div',{className:'mono',style:{gridRow:1,gridColumn:2,fontSize:14,fontWeight:700,color:t.c,textAlign:'right',whiteSpace:'nowrap'}},
        (m.tipo==='abono'?'- ':'+ ')+fmt(m.monto_pagado)),
      h('div',{style:{gridColumn:1,fontSize:12,color:'var(--text2)'}},m.notas||''),
      // El saldo corrido por fila es lo que vuelve el ledger auto-verificable: se sigue
      // la cuenta sin sumar de cabeza.
      h('div',{className:'mono',style:{gridRow:2,gridColumn:2,fontSize:11,color:'var(--text3)',textAlign:'right',whiteSpace:'nowrap'}},'saldo '+fmt(x.saldo)));
  }
  function reconItem(k,v,color){
    return h('div',{style:{display:'flex',flexDirection:'column',gap:1}},
      h('span',{style:{fontSize:10,fontWeight:700,letterSpacing:.8,textTransform:'uppercase',color:'var(--text3)'}},k),
      h('span',{className:'mono',style:{fontSize:14,fontWeight:700,color:color}},v));
  }
  function reconOp(t){
    return h('span',{style:{fontSize:15,color:'var(--text3)',fontWeight:600,paddingTop:12}},t);
  }

  // Tarjeta de UNA deuda, tratada como CUENTA CORRIENTE. Es su propio acordeon: la
  // cabecera (titulo + saldo + estado) siempre se ve, y el detalle —la aritmetica, el
  // ledger y las acciones— se despliega al hacer clic. Con varios prestamos del mismo
  // acreedor, abrir el perfil ya no vuelca todo de golpe.
  //
  // El detalle NO se monta condicionalmente: se queda en el DOM dentro de `.acc`, que
  // anima su altura. Renderizarlo solo al abrir cortaria la transicion, porque una
  // transicion necesita los dos estados presentes.
  function debtCard(d){
    var open=!!expDebt[d.id];
    var cargosExtra=+d.total_cargos||0;
    var abonado=+d.total_abonos||0;
    // Base dinamica (QA5): lo cargado es el monto original MAS los cargos posteriores.
    var cargado=(+d.monto_original||0)+cargosExtra;
    var saldo=+d.saldo_pendiente||0;
    var pct=cargado>0?Math.max(0,Math.min(100,Math.round((abonado/cargado)*100))):0;
    var cache=movs[d.id];
    var filas=movimientosDe(d);
    // Una deuda con un solo cargo y sin abonos no necesita explicarse: la franja
    // repetiria el mismo numero tres veces.
    var trivial=cargosExtra===0&&abonado===0;
    var activa=d.estado==='Activa';
    // Pista util sin abrir: si lo cargado supera el monto de apertura, la cuenta crecio.
    var sub='Abierta el '+fmtD((d.fecha_creacion||'').slice(0,10))+
            (cargosExtra>0?(' · cargado '+fmt(cargado)):'');

    return h('div',{key:d.id,style:{background:'var(--bg2)',border:'1px solid var(--border)',borderRadius:12,overflow:'hidden'}},

      // ── CABECERA (siempre visible, alterna el detalle) ──
      h('div',{onClick:function(){toggleDebt(d.id);},style:{padding:'13px 15px',cursor:'pointer',display:'flex',alignItems:'center',gap:11}},
        h('span',{className:'acc-chev'+(open?' open':'')},h(Ico,{name:'chevright',size:15,color:'var(--text3)'})),
        h('div',{style:{minWidth:0,flex:1}},
          h('div',{style:{fontWeight:700,fontSize:15,color:'var(--text)',whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis'}},d.titulo||d.concepto||'Deuda'),
          h('div',{style:{fontSize:12,color:'var(--text3)',marginTop:2}},sub)),
        h('div',{style:{textAlign:'right',flexShrink:0}},
          h('div',{style:{fontSize:10,fontWeight:700,letterSpacing:1,textTransform:'uppercase',color:'var(--text3)'}},'Saldo pendiente'),
          h('div',{className:'mono',style:{fontSize:19,fontWeight:700,marginTop:1,color:activa?'var(--yellow)':'var(--green)'}},fmt(saldo))),
        h('div',{style:{flexShrink:0}},estadoBadge(d.estado))),

      // ── DETALLE (se despliega) ──
      // El panel se monta SIEMPRE: animar una altura exige que el contenido este ahi
      // para poder medirlo, tanto al abrir como al cerrar. Una deuda cerrada no pide su
      // ledger igual (el fetch depende de `expDebt`, no del montaje).
      h('div',{className:'acc','data-acc':'d-'+d.id,'data-open':open?'1':'0'},

          // 1 — La aritmetica, visible: Cargado - Abonado = Saldo
          !trivial?h('div',{style:{borderTop:'1px solid var(--border)',padding:'12px 15px'}},
            h('div',{style:{display:'flex',alignItems:'center',gap:12,flexWrap:'wrap'}},
              reconItem('Cargado',fmt(cargado),'var(--red)'),
              reconOp('-'),
              reconItem('Abonado',fmt(abonado),'var(--green)'),
              reconOp('='),
              reconItem('Saldo',fmt(saldo),'var(--text)')),
            // "Pagado" mentia: en una cuenta que crece, un progreso hacia el 100%
            // RETROCEDE cuando entra un cargo. El rotulo ahora dice que mide.
            h('div',{style:{marginTop:11}},
              h('div',{style:{display:'flex',justifyContent:'space-between',alignItems:'baseline',fontSize:11,marginBottom:4}},
                h('span',{style:{color:'var(--text3)'}},abonado>0?('Abonado '+fmt(abonado)+' de '+fmt(cargado)):'Sin abonos todavia'),
                h('span',{className:'mono',style:{color:'var(--green)',fontWeight:700}},pct+'%')),
              h('div',{style:{height:5,background:'var(--bg3)',borderRadius:99,overflow:'hidden'}},
                h('div',{style:{width:pct+'%',height:'100%',background:'var(--green)',borderRadius:99,transition:'width .3s'}}))))
          :null,

          // 2 — El ledger, sin modales de por medio
          h('div',{style:{borderTop:'1px solid var(--border)',padding:'12px 15px'}},
            h('div',{style:{display:'flex',alignItems:'center',gap:8,marginBottom:9}},
              h('span',{style:{fontSize:10,fontWeight:700,letterSpacing:1.1,textTransform:'uppercase',color:'var(--text3)'}},
                cache&&!cache.error?(filas.length+' movimiento'+(filas.length===1?'':'s')):'Movimientos'),
              h('div',{style:{flex:1,height:1,background:'var(--border)'}})),
            !cache?
              h('div',{style:{fontSize:12,color:'var(--text3)',padding:'6px 0'}},'Cargando movimientos...')
            : cache.error?
              // El ledger es la unica via a los movimientos, asi que un fallo tiene que
              // ofrecer salida: borrar la entrada del cache lo vuelve a poner en la cola.
              h('div',{style:{display:'flex',alignItems:'center',gap:10,padding:'6px 0',flexWrap:'wrap'}},
                h('span',{style:{fontSize:12,color:'var(--yellow)'}},'No se pudieron cargar los movimientos.'),
                h('button',{onClick:function(){ setMovs(function(prev){ var n=Object.assign({},prev); delete n[d.id]; return n; }); },
                  style:{background:'var(--bg3)',border:'1px solid var(--border2)',borderRadius:8,padding:'5px 12px',cursor:'pointer',color:'var(--text2)',fontSize:12,fontWeight:600}},'Reintentar'))
            :
              h('div',{style:{display:'flex',flexDirection:'column',gap:7}},
                filas.slice().reverse().map(movRow))),

          // 3 — Acciones
          h('div',{style:{borderTop:'1px solid var(--border)',padding:'11px 15px',display:'flex',alignItems:'center',gap:6}},
            iconBtn('edit','Editar',function(){onEdit(d);}),
            iconBtn('trash','Eliminar',function(){onDelete(d);},'var(--red)'),
            h('div',{style:{flex:1}}),
            // Un cargo tambien REACTIVA una deuda ya pagada, asi que se ofrece siempre;
            // el abono solo mientras haya saldo que abonar.
            h('button',{onClick:function(){onPay(d,'cargo');},title:'Registrar un cargo (aumenta la deuda)',
              style:{background:'transparent',border:'1px solid var(--border2)',borderRadius:8,padding:'7px 13px',cursor:'pointer',color:'var(--text2)',fontSize:13,fontWeight:600}},'+ Cargo'),
            activa?h('button',{onClick:function(){onPay(d,'abono');},
              style:{background:'var(--green2)',border:'none',borderRadius:8,padding:'7px 16px',cursor:'pointer',color:'#fff',fontSize:13,fontWeight:700,display:'flex',alignItems:'center',gap:6}},
              h(Ico,{name:'dollar',size:14,color:'#fff'}),'Abonar'):null)));
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
        h('span',{className:'acc-chev'+(open?' open':'')},h(Ico,{name:'chevright',size:18,color:'var(--text3)'}))));
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
      h('div',{className:'acc','data-acc':'g-'+g.key,'data-open':open?'1':'0'},
        h('div',{style:{display:'flex',flexDirection:'column',gap:8,paddingTop:8,paddingLeft:12}},detalle)));
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
