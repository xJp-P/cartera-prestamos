// public/js/vistas/DevView.js — Desarrollador: ruta de la BD, actualizaciones y reportes.
//
// Extraido de `app.js` en la Etapa 3 (B7) del refactor. Codigo VERBATIM.
//
// El estado global sigue viviendo en `App` y baja por PROPS, igual que antes.
// Sin Context API y sin store: eso seria rediseno, no refactor.

import { Ico } from '../componentes/iconos.js';
import { showError } from '../core/api.js';
import { h, useEffect, useState } from '../core/react.js';
import { generateReportePrestamosPDF } from '../pdf/reporte-activos.js';

// ── Desarrollador ─────────────────────────────────────────────────────────────
export function DevView(props){
  var showToast=props.showToast;
  var isMac=props.isMac;
  var onNeedsRestart=props.onNeedsRestart;
  var onSync=props.onSync;
  var s1=useState(''); var dbPath=s1[0]; var setDbPath=s1[1];
  var s2=useState(false); var loading=s2[0]; var setLoading=s2[1];
  var s3=useState(''); var appVersion=s3[0]; var setAppVersion=s3[1];
  var s4=useState(null); var updateInfo=s4[0]; var setUpdateInfo=s4[1];
  var s5=useState(props.datosPago||''); var datosPago=s5[0]; var setDatosPago=s5[1];
  var s6=useState(false); var savingPago=s6[0]; var setSavingPago=s6[1];
  // Prestamos que /recalculate no pudo reconstruir. Desde la Etapa 1 el endpoint aisla
  // al problematico y sigue con los demas, asi que un "Sincronizado" a secas afirmaria
  // algo falso. Se guarda para mostrarlo de forma PERSISTENTE: es una lista que hay que
  // leer y sobre la que hay que actuar, no cabe en un toast de 2 segundos.
  var s7=useState(null); var omitidos=s7[0]; var setOmitidos=s7[1];
  var s8=useState(false); var sincronizando=s8[0]; var setSincronizando=s8[1];
  var hasAPI=typeof window.electronAPI!=='undefined';

  function saveDatosPago(){
    if(!props.onSaveConfig) return;
    setSavingPago(true);
    Promise.resolve(props.onSaveConfig({datos_pago:datosPago})).then(function(){
      setSavingPago(false);
      showToast('Datos de pago guardados');
    }).catch(function(){ setSavingPago(false); });
  }

  useEffect(function(){
    if(!hasAPI) return;
    window.electronAPI.getDbPath().then(setDbPath);
    window.electronAPI.getAppVersion().then(setAppVersion);
    var unsub=window.electronAPI.onUpdateStatus(function(data){setUpdateInfo(data);});
    return unsub;
  },[]);

  function pickFolder(){
    if(!hasAPI) return;
    setLoading(true);
    window.electronAPI.pickDbFolder().then(function(folder){
      if(!folder){setLoading(false);return;}
      return window.electronAPI.setDbPath(folder).then(function(res){
        if(res && res.ok){
          setDbPath(res.path);
          setLoading(false);
          onNeedsRestart();
        } else {
          setLoading(false);
          showError(res && res.error ? res.error : 'Error al mover la base de datos');
        }
      });
    }).catch(function(){setLoading(false);showError('Error al mover la base de datos');});
  }

  function resetPath(){
    if(!hasAPI) return;
    props.onConfirm({title:'Restaurar ubicacion',message:'Volver a la ruta por defecto? La app usara la carpeta nativa del sistema.',okLabel:'Restaurar',okColor:'var(--yellow)',onConfirm:function(){
      window.electronAPI.resetDbPath().then(function(res){
        if(res && res.ok){
          setDbPath(res.path);
          onNeedsRestart();
        } else {
          showError(res && res.error ? res.error : 'Error al restaurar la base de datos');
        }
      });
    }});
  }

  return h('div',{className:'fade-in',style:{padding:'16px 14px'}},
    h('div',{style:{fontWeight:700,fontSize:18,color:'var(--text)',marginBottom:4,display:'flex',alignItems:'center',gap:6}},h(Ico,{name:'settings',size:18,color:'var(--text2)'}),' Desarrollador'),
    h('div',{style:{fontSize:12,color:'var(--text3)',marginBottom:16}},'Configuracion avanzada'),

    h('div',{style:{background:'var(--bg2)',borderRadius:14,padding:'16px',border:'1px solid var(--border)',marginBottom:12}},
      h('div',{style:{display:'flex',alignItems:'center',gap:8,marginBottom:12}},
        h(Ico,{name:'folder',size:18,color:'var(--blue)'}),
        h('span',{style:{fontWeight:700,fontSize:14,color:'var(--text)'}},'Ubicacion de la base de datos')),
      h('div',{style:{fontSize:11,color:'var(--text3)',marginBottom:12}},'Puedes guardar tu base de datos en cualquier carpeta (ej: iCloud Drive, OneDrive, Dropbox). Solo la BD se mueve, los archivos de la app quedan en su lugar.'),
      h('div',{style:{background:'var(--bg3)',borderRadius:10,padding:'10px 12px',border:'1px solid var(--border)',marginBottom:12,wordBreak:'break-all'}},
        h('div',{style:{fontSize:9,color:'var(--text3)',fontWeight:600,marginBottom:3}},'RUTA ACTUAL'),
        h('div',{className:'mono',style:{fontSize:11,color:'var(--blue)'}},dbPath||'Cargando...')),
      h('div',{style:{display:'flex',gap:8}},
        h('button',{onClick:pickFolder,disabled:loading||!hasAPI,style:{flex:1,background:'var(--blue-bg)',color:'var(--blue)',border:'1px solid var(--blue-bd)',borderRadius:10,padding:'10px',fontSize:12,fontWeight:600,cursor:hasAPI?'pointer':'not-allowed',fontFamily:'inherit',display:'flex',alignItems:'center',justifyContent:'center',gap:6}},
          h(Ico,{name:'folder',size:13,color:'var(--blue)'}),loading?'Moviendo...':'Cambiar ubicacion'),
        h('button',{onClick:resetPath,disabled:!hasAPI,style:{background:'var(--bg3)',color:'var(--text2)',border:'1px solid var(--border)',borderRadius:10,padding:'10px 14px',fontSize:12,fontWeight:600,cursor:hasAPI?'pointer':'not-allowed',fontFamily:'inherit'}},'Restaurar')),
      !hasAPI&&h('div',{style:{marginTop:10,fontSize:11,color:'var(--yellow)',background:'var(--yellow-bg)',borderRadius:8,padding:'8px 10px',border:'1px solid var(--yellow)'}},'Esta funcion solo esta disponible en la app de escritorio (Electron). En el navegador no se puede acceder al sistema de archivos.')),

    h('div',{style:{background:'var(--bg2)',borderRadius:14,padding:'16px',border:'1px solid var(--border)',marginBottom:12}},
      h('div',{style:{display:'flex',alignItems:'center',gap:8,marginBottom:8}},
        h(Ico,{name:'alert',size:16,color:'var(--yellow)'}),
        h('span',{style:{fontWeight:700,fontSize:14,color:'var(--text)'}},'Importante')),
      h('ul',{style:{fontSize:12,color:'var(--text2)',margin:0,paddingLeft:20,lineHeight:1.8}},
        h('li',null,'Al cambiar la ubicacion, la BD actual se ',h('strong',null,'copia'),' a la nueva carpeta.'),
        h('li',null,'Debes ',h('strong',null,'reiniciar la app'),' despues de cambiar la ruta.'),
        h('li',null,'Si usas una carpeta en la nube (iCloud, OneDrive), tu BD se sincroniza automaticamente.'),
        h('li',null,'No abras la app en dos dispositivos al mismo tiempo.'))),

    h('div',{style:{background:'var(--bg2)',borderRadius:14,padding:'16px',border:'1px solid var(--border)',marginBottom:12}},
      h('div',{style:{fontWeight:600,fontSize:13,color:'var(--text)',marginBottom:8}},'Info del sistema'),
      h('div',{style:{display:'grid',gridTemplateColumns:'1fr 1fr',gap:6}},
        h('div',{style:{fontSize:10,color:'var(--text3)'}},'Version'),
        h('div',{className:'mono',style:{fontSize:10,color:'var(--text2)'}},appVersion||'...'),
        h('div',{style:{fontSize:10,color:'var(--text3)'}},'Motor'),
        h('div',{className:'mono',style:{fontSize:10,color:'var(--text2)'}},'Electron + Express'),
        h('div',{style:{fontSize:10,color:'var(--text3)'}},'Base de datos'),
        h('div',{className:'mono',style:{fontSize:10,color:'var(--text2)'}},'SQLite (better-sqlite3)'),
        h('div',{style:{fontSize:10,color:'var(--text3)'}},'Frontend'),
        h('div',{className:'mono',style:{fontSize:10,color:'var(--text2)'}},'React 18 UMD'))),

    h('div',{style:{background:'var(--bg2)',borderRadius:14,padding:'16px',border:'1px solid var(--border)'}},
      h('div',{style:{display:'flex',alignItems:'center',gap:8,marginBottom:12}},
        h(Ico,{name:'download',size:18,color:'var(--green)'}),
        h('span',{style:{fontWeight:700,fontSize:14,color:'var(--text)'}},'Actualizaciones')),

      !updateInfo||updateInfo.status==='not-available'?
        h('div',null,
          h('div',{style:{fontSize:12,color:'var(--text2)',marginBottom:10}},'Tu app esta al dia.'),
          h('button',{onClick:function(){if(hasAPI)window.electronAPI.checkForUpdates();setUpdateInfo({status:'checking'});},disabled:!hasAPI,style:{background:'var(--bg3)',color:'var(--text)',border:'1px solid var(--border)',borderRadius:10,padding:'10px 16px',fontSize:12,fontWeight:600,cursor:'pointer',fontFamily:'inherit',display:'flex',alignItems:'center',gap:6}},
            h(Ico,{name:'refresh',size:13,color:'var(--text2)'}),'Buscar actualizaciones')):

      updateInfo.status==='checking'?
        h('div',{style:{fontSize:12,color:'var(--text2)',display:'flex',alignItems:'center',gap:8}},
          h('div',{className:'spinner'}),
          'Buscando actualizaciones...'):

      updateInfo.status==='dev-mode'?
        h('div',{style:{fontSize:12,color:'var(--yellow)'}},'Modo desarrollo — las actualizaciones solo funcionan en la app instalada.'):

      updateInfo.status==='available'?
        h('div',null,
          h('div',{style:{fontSize:12,color:'var(--green)',marginBottom:10,fontWeight:600}},'Nueva version disponible: v'+updateInfo.version),
          h('button',{onClick:function(){window.electronAPI.downloadUpdate();},style:{background:'var(--green-bg)',color:'var(--green)',border:'1px solid var(--green-bd)',borderRadius:10,padding:'10px 16px',fontSize:12,fontWeight:600,cursor:'pointer',fontFamily:'inherit',display:'flex',alignItems:'center',gap:6}},
            h(Ico,{name:'download',size:13,color:'var(--green)'}),'Descargar actualizacion')):

      updateInfo.status==='downloading'?
        h('div',null,
          h('div',{style:{fontSize:12,color:'var(--blue)',marginBottom:8}},'Descargando... '+(updateInfo.percent||0)+'%'),
          h('div',{style:{background:'var(--bg3)',borderRadius:6,height:6,overflow:'hidden'}},
            h('div',{style:{width:(updateInfo.percent||0)+'%',height:'100%',background:'var(--blue)',borderRadius:6,transition:'width .3s'}}))):

      updateInfo.status==='downloaded'?
        h('div',null,
          h('div',{style:{fontSize:12,color:'var(--green)',marginBottom:10,fontWeight:600}},'v'+updateInfo.version+' lista para instalar'),
          h('button',{onClick:function(){window.electronAPI.installUpdate();},style:{background:'var(--green2)',color:'#fff',border:'none',borderRadius:10,padding:'10px 16px',fontSize:12,fontWeight:600,cursor:'pointer',fontFamily:'inherit',display:'flex',alignItems:'center',gap:6}},
            h(Ico,{name:'refresh',size:13,color:'#fff'}),'Reiniciar e instalar')):

      updateInfo.status==='error'?
        h('div',null,
          h('div',{style:{fontSize:12,color:'var(--red)',marginBottom:10}},'Error: '+(updateInfo.message||'No se pudo verificar')),
          h('button',{onClick:function(){if(hasAPI)window.electronAPI.checkForUpdates();setUpdateInfo({status:'checking'});},style:{background:'var(--bg3)',color:'var(--text)',border:'1px solid var(--border)',borderRadius:10,padding:'10px 16px',fontSize:12,fontWeight:600,cursor:'pointer',fontFamily:'inherit'}},'Reintentar')):null),

    h('div',{style:{background:'var(--bg2)',borderRadius:14,padding:'16px',border:'1px solid var(--border)',marginBottom:12}},
      h('div',{style:{display:'flex',alignItems:'center',gap:8,marginBottom:8}},
        h(Ico,{name:'download',size:18,color:'var(--green)'}),
        h('span',{style:{fontWeight:700,fontSize:14,color:'var(--text)'}},'Reporte de prestamos')),
      h('div',{style:{fontSize:11,color:'var(--text3)',marginBottom:12}},'Descarga un PDF con todos los prestamos activos (deudor, modalidad, tasa, saldo pendiente y estado). Las cuotas en mora se detallan bajo cada prestamo y al final se totaliza el capital en la calle.'),
      h('button',{onClick:function(){
        var activos=(props.loans||[]).filter(function(l){return l.estado==='Activo';});
        if(activos.length===0){showToast('No hay prestamos activos para el reporte','error');return;}
        generateReportePrestamosPDF(props.loans,props.pays,document.documentElement.getAttribute('data-theme')==='dark');
      },style:{background:'var(--green-bg)',color:'var(--green)',border:'1px solid var(--green-bd)',borderRadius:10,padding:'10px 16px',fontSize:12,fontWeight:600,cursor:'pointer',fontFamily:'inherit',display:'flex',alignItems:'center',gap:6}},
        h(Ico,{name:'download',size:13,color:'var(--green)'}),'Descargar Reporte de Prestamos (PDF)')),

    h('div',{style:{background:'var(--bg2)',borderRadius:14,padding:'16px',border:'1px solid var(--border)',marginBottom:12}},
      h('div',{style:{display:'flex',alignItems:'center',gap:8,marginBottom:8}},
        h(Ico,{name:'receipt',size:18,color:'var(--blue)'}),
        h('span',{style:{fontWeight:700,fontSize:14,color:'var(--text)'}},'Datos de pago (recibo de cobro)')),
      h('div',{style:{fontSize:11,color:'var(--text3)',marginBottom:10}},'Este texto aparece en el bloque "Como pagar" del Recibo de Cobro (Factura) que generas desde la vista Pagos. Ej: cuentas, Nequi/Daviplata, a nombre de quien. Si lo dejas vacio, el bloque no se muestra.'),
      h('textarea',{value:datosPago,onChange:function(e){setDatosPago(e.target.value);},rows:4,placeholder:'Transferencia / Nequi / Daviplata\nA nombre de ...\nCel. ...',style:{width:'100%',resize:'vertical',fontFamily:'inherit',fontSize:12,color:'var(--text)',background:'var(--bg3)',border:'1px solid var(--border)',borderRadius:10,padding:'10px 12px',boxSizing:'border-box'}}),
      h('button',{onClick:saveDatosPago,disabled:savingPago,style:{marginTop:10,background:'var(--blue-bg)',color:'var(--blue)',border:'1px solid var(--blue-bd)',borderRadius:10,padding:'10px 16px',fontSize:12,fontWeight:600,cursor:'pointer',fontFamily:'inherit',display:'flex',alignItems:'center',gap:6}},
        h(Ico,{name:'check',size:13,color:'var(--blue)'}),savingPago?'Guardando...':'Guardar datos de pago')),

    h('div',{style:{background:'var(--bg2)',borderRadius:14,padding:'16px',border:'1px solid var(--border)'}},
      h('div',{style:{display:'flex',alignItems:'center',gap:8,marginBottom:8}},
        h(Ico,{name:'refresh',size:18,color:'var(--yellow)'}),
        h('span',{style:{fontWeight:700,fontSize:14,color:'var(--text)'}},'Sincronizar datos')),
      h('div',{style:{fontSize:11,color:'var(--text3)',marginBottom:12}},'Recalcula todos los cronogramas activos. Se ejecuta automaticamente al abrir la app. Usa este boton solo si notas inconsistencias.'),
      // El toast lo emite `recalculate` en App, que es quien conoce el resultado. Antes se
      // mostraba aqui uno fijo de "Cronogramas recalculados" ANTES de saber si habia ido bien.
      h('button',{onClick:function(){
          if(sincronizando) return;
          setSincronizando(true);
          Promise.resolve(onSync()).then(function(r){
            setSincronizando(false);
            setOmitidos(r&&r.omitidos?r.omitidos:[]);
          });
        },disabled:sincronizando,style:{background:'var(--bg3)',color:'var(--text)',border:'1px solid var(--border)',borderRadius:10,padding:'10px 16px',fontSize:12,fontWeight:600,cursor:sincronizando?'not-allowed':'pointer',opacity:sincronizando?.6:1,fontFamily:'inherit',display:'flex',alignItems:'center',gap:6}},
        h(Ico,{name:'refresh',size:13,color:'var(--text2)'}),sincronizando?'Sincronizando...':'Sincronizar manualmente'),

      omitidos&&omitidos.length>0&&h('div',{style:{marginTop:12,background:'var(--red-bg)',border:'1px solid var(--red-bd)',borderRadius:10,padding:'10px 12px'}},
        h('div',{style:{display:'flex',alignItems:'center',gap:6,marginBottom:6}},
          h(Ico,{name:'alert',size:14,color:'var(--red)'}),
          h('span',{style:{fontWeight:700,fontSize:12,color:'var(--red)'}},omitidos.length+' prestamo'+(omitidos.length===1?'':'s')+' no se pudo'+(omitidos.length===1?'':'ieron')+' recalcular')),
        h('div',{style:{fontSize:11,color:'var(--text3)',marginBottom:8}},'Quedaron EXACTAMENTE como estaban (su transaccion revirtio sola). El resto si se sincronizo.'),
        omitidos.map(function(o,i){
          return h('div',{key:o.id||i,style:{fontSize:11.5,color:'var(--text2)',padding:'6px 0',borderTop:i>0?'1px solid var(--red-bd)':'none'}},
            h('div',{style:{fontWeight:600,color:'var(--text)'}},o.nombre||o.id),
            h('div',{style:{marginTop:2,lineHeight:1.4}},o.motivo));
        })),
      omitidos&&omitidos.length===0&&h('div',{style:{marginTop:12,fontSize:11.5,color:'var(--green)',display:'flex',alignItems:'center',gap:6}},
        h(Ico,{name:'check',size:13,color:'var(--green)'}),'Todos los cronogramas activos se recalcularon sin omisiones.')));
}
