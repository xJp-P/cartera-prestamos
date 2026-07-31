// public/js/vistas/HistorialView.js — Log de acciones, con el boton Deshacer y su candado LIFO.
//
// Extraido de `app.js` en la Etapa 3 (B7) del refactor. Codigo VERBATIM.
//
// El estado global sigue viviendo en `App` y baja por PROPS, igual que antes.
// Sin Context API y sin store: eso seria rediseno, no refactor.

import { Ico } from '../componentes/iconos.js';
import { h } from '../core/react.js';

// ── Historial de acciones ─────────────────────────────────────────────────────
export function HistorialView(props){
  var log=props.actLog||[];
  var undoLog=props.undoLog||[];
  var onUndo=props.onUndo;
  var onRefresh=props.onRefresh;
  var tipoIcon={prestamo:'plus',edicion:'edit',eliminacion:'trash',pago:'check',abono:'dollar',reestructuracion:'calc',cierre:'alert',deshacer:'refresh','cambio-fecha':'calendar',deuda:'briefcase'};
  // v2.1 — 'deshacer' en purpura: las acciones compensatorias deben destacar de un vistazo sin
  // confundirse con un error (rojo) ni con un cobro (verde).
  var tipoColor={prestamo:'var(--green)',edicion:'var(--blue)',eliminacion:'var(--red)',pago:'var(--green)',abono:'var(--yellow)',reestructuracion:'var(--blue)',cierre:'var(--red)',deshacer:'var(--purple)','cambio-fecha':'var(--blue)',deuda:'var(--text2)'};
  var tipoLabel={prestamo:'Nuevo prestamo',edicion:'Edicion',eliminacion:'Eliminacion',pago:'Pago',abono:'Abono',reestructuracion:'Reestructuracion',cierre:'Cierre forzoso',deshacer:'Deshecho','cambio-fecha':'Cambio de fecha',deuda:'Mis deudas'};

  function fmtFecha(f){
    if(!f)return '';
    var d=new Date(f);
    var meses=['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'];
    return d.getDate()+' '+meses[d.getMonth()]+' '+d.getFullYear()+' '+d.getHours().toString().padStart(2,'0')+':'+d.getMinutes().toString().padStart(2,'0');
  }

  // ── CANDADO A (LIFO) EN LA UI ───────────────────────────────────────────────
  // El backend solo acepta deshacer la entrada 'disponible' MAS RECIENTE de cada agregado
  // (409 en cualquier otra). La UI refleja exactamente esa regla: se calcula el "head" por
  // scope y solo esa fila ofrece el boton activo. Las demas lo muestran apagado, explicando
  // cual hay que deshacer primero — mejor que ocultarlo, que dejaria al usuario sin saber por
  // que una operacion no se puede revertir.
  var ujById={}, headByScope={};
  undoLog.forEach(function(u){
    ujById[u.id]=u;
    var k=u.scope_tipo+'|'+u.scope_id;
    // GET /api/undo llega ordenado por rowid DESC -> la primera 'disponible' de cada scope es el head.
    if(u.estado==='disponible'&&!headByScope[k]) headByScope[k]=u.id;
  });

  return h('div',{style:{padding:16}},
    h('div',{style:{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:16}},
      h('h2',{style:{color:'var(--text)',fontSize:18,fontWeight:700}},'Historial de acciones'),
      h('button',{onClick:onRefresh,style:{background:'var(--bg3)',border:'1px solid var(--border)',borderRadius:8,padding:'6px 12px',cursor:'pointer',color:'var(--text)',fontSize:13,display:'flex',alignItems:'center',gap:6}},
        h(Ico,{name:'refresh',size:14,color:'var(--text2)'}),'Actualizar')),
    log.length===0?
      h('div',{style:{textAlign:'center',padding:40,color:'var(--text3)'}},
        h(Ico,{name:'activity',size:32,color:'var(--text3)'}),
        h('p',{style:{marginTop:12,fontSize:13}},'No hay acciones registradas aun')):
      h('div',{style:{display:'flex',flexDirection:'column',gap:8}},
        log.map(function(item){
          var icon=tipoIcon[item.tipo]||'activity';
          var color=tipoColor[item.tipo]||'var(--text2)';
          var label=tipoLabel[item.tipo]||item.tipo;
          var uj=item.undo_id?ujById[item.undo_id]:null;
          var esHead=uj&&uj.estado==='disponible'&&headByScope[uj.scope_tipo+'|'+uj.scope_id]===uj.id;
          var bloqueada=uj&&uj.estado==='disponible'&&!esHead;
          var yaDeshecha=uj&&uj.estado==='deshecho';
          // Cual es la operacion que hay que deshacer PRIMERO en este agregado (para el tooltip).
          var headEntry=uj?ujById[headByScope[uj.scope_tipo+'|'+uj.scope_id]]:null;
          var motivo=bloqueada&&headEntry
            ? 'Primero debes deshacer la operacion mas reciente de este '+(uj.scope_tipo==='debt'?'registro':'prestamo')+': "'+headEntry.descripcion+'"'
            : '';
          return h('div',{key:item.id,style:{background:'var(--bg2)',border:'1px solid '+(yaDeshecha?'var(--purple-bd)':'var(--border)'),borderRadius:10,padding:'12px 14px',display:'flex',alignItems:'flex-start',gap:12,opacity:yaDeshecha?.72:1}},
            h('div',{style:{background:color+'20',borderRadius:8,padding:8,display:'flex',flexShrink:0}},
              h(Ico,{name:icon,size:16,color:color})),
            h('div',{style:{flex:1,minWidth:0}},
              h('div',{style:{display:'flex',alignItems:'center',gap:8,marginBottom:4,flexWrap:'wrap'}},
                h('span',{style:{fontSize:11,fontWeight:600,color:color,textTransform:'uppercase',letterSpacing:'.5px'}},label),
                h('span',{style:{fontSize:11,color:'var(--text3)'}},fmtFecha(item.fecha)),
                yaDeshecha&&h('span',{style:{fontSize:10,fontWeight:700,color:'var(--purple)',background:'var(--purple-bg)',border:'1px solid var(--purple-bd)',borderRadius:5,padding:'1px 6px',letterSpacing:'.3px'}},'REVERTIDA')),
              h('div',{style:{fontSize:14,color:'var(--text)',lineHeight:'1.4',textDecoration:yaDeshecha?'line-through':'none'}},item.mensaje),
              // El motivo del bloqueo se muestra tambien inline: el tooltip nativo no existe en tactil.
              bloqueada&&h('div',{style:{fontSize:11,color:'var(--text3)',marginTop:5,display:'flex',alignItems:'flex-start',gap:5,lineHeight:1.45}},
                h(Ico,{name:'clock',size:11,color:'var(--text3)',sw:2.2}),
                h('span',null,motivo))),
            // ── Accion de deshacer (solo el head LIFO la ofrece activa) ──
            (esHead||bloqueada)&&h('div',{style:{flexShrink:0}},
              h('button',{
                onClick:esHead?function(){onUndo(uj);}:null,
                disabled:!esHead,
                title:esHead?'Revertir esta operacion':motivo,
                style:{display:'flex',alignItems:'center',gap:6,padding:'7px 11px',borderRadius:8,fontSize:12,fontWeight:600,fontFamily:'inherit',
                  background:esHead?'var(--purple-bg)':'transparent',
                  border:'1px solid '+(esHead?'var(--purple)':'var(--border)'),
                  color:esHead?'var(--purple)':'var(--text3)',
                  cursor:esHead?'pointer':'not-allowed',opacity:esHead?1:.6,transition:'all .15s'}},
                h(Ico,{name:'refresh',size:13,color:esHead?'var(--purple)':'var(--text3)',sw:2.2}),'Deshacer')));
        })));
}
