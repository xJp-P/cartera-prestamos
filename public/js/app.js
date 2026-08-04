// public/js/app.js — la aplicacion completa.
//
// Movido desde el <script> inline de index.html en la Etapa 3 (B1) del refactor.
// Codigo VERBATIM: en este paso NO se divide nada. B1 existe unicamente para
// probar que los modulos ES funcionan en Electron, de modo que si fallan, falle
// aca y sea un `git revert` de un solo commit.
//
// Por que funcionan sin bundler: desktop/main.js hace loadURL sobre
// http://127.0.0.1:3420, no file://. Con file:// el origen seria opaco y el
// navegador rechazaria los modulos por CORS.
//
// DOS CAMBIOS DE SEMANTICA QUE TRAE `type="module"` (verificados antes de mover):
//  1. STRICT MODE implicito. Se comprobo que el bloque parsea como modulo ES:
//     sin `with`, sin octales legacy, sin parametros duplicados, sin eval.
//  2. AMBITO PROPIO: los `var`/`function` de nivel superior YA NO caen en
//     `window`. Se verifico que el codigo no dependia de eso (0 referencias a
//     `window.<simbolo top-level>`). React y ReactDOM siguen siendo globales
//     porque los dos <script src="/vendor/..."> son CLASICOS y corren ANTES:
//     un modulo es diferido por definicion.
//
// El `createRoot(...)` del final ahora corre tras parsearse el HTML (los modulos
// son diferidos), asi que #root existe con mas garantia que antes, no menos.

import { CHANGELOGS } from './datos/changelogs.js';

// Hubs del frontend — Etapa 3/B3 del refactor.
// React y ReactDOM NO se importan: son globales que dejan los <script> clasicos
// de /vendor (ver core/react.js).
import { h, useState, useEffect, useMemo, useCallback, createRoot } from './core/react.js';
import { API, setErrorHandler } from './core/api.js';
import { fmt, fmtD } from './core/format.js';
import { properCase, nowStr, addDays, payMatchesQuery } from './core/ui.js';
import { cobrosDe, imputarCobros, saldoConCaja, pendCuota } from './core/dominio.js';
import { Ico } from './componentes/iconos.js';
import { generateCronogramaPDF } from './pdf/cronograma.js';
import { generateReciboAbono }   from './pdf/recibo-abono.js';

// Vistas — Etapa 3/B7. El estado sigue en `App` y baja por props.
import { DashView } from './vistas/DashView.js';
import { CarteraView } from './vistas/CarteraView.js';
import { DeudoresView } from './vistas/DeudoresView.js';
import { PagosView } from './vistas/PagosView.js';
import { PortfolioView } from './vistas/PortfolioView.js';
import { CalcView } from './vistas/CalcView.js';
import { HistorialView } from './vistas/HistorialView.js';
import { DebtsView } from './vistas/DebtsView.js';
import { DevView } from './vistas/DevView.js';

// Modales — Etapa 3/B7. `App` los monta como hermanos y les pasa props.
import { DebtorModal } from './modales/DebtorModal.js';
import { PayModal } from './modales/PayModal.js';
import { PreflightMoraModal } from './modales/PreflightMoraModal.js';
import { AbonoModal } from './modales/AbonoModal.js';
import { LiquidarModal } from './modales/LiquidarModal.js';
import { RestructureModal } from './modales/RestructureModal.js';
import { LoanModal } from './modales/LoanModal.js';
import { DebtModal } from './modales/DebtModal.js';
import { DebtPayModal } from './modales/DebtPayModal.js';
import { DebtHistoryModal } from './modales/DebtHistoryModal.js';
import { DeleteDebtModal } from './modales/DeleteDebtModal.js';
import { ConfirmUndoModal } from './modales/ConfirmUndoModal.js';
import { ConfirmModal } from './modales/ConfirmModal.js';
import { esAbono } from './core/ids.js';

'use strict';




// ── Input numérico con formato automático (1.000.000) ──
// Acepta coma o punto como decimal; solo deja digitos y un unico punto decimal.







// ── App ───────────────────────────────────────────────────────────────────────
function App(){
  var s1=useState([]); var loans=s1[0]; var setLoans=s1[1];
  var s2=useState([]); var pays=s2[0]; var setPays=s2[1];
  var s3=useState({trm:'4100'}); var cfg=s3[0]; var setCfg=s3[1];
  var s4=useState(true); var loading=s4[0]; var setLoading=s4[1];
  var s5=useState('dashboard'); var view=s5[0]; var setView=s5[1];
  var s6=useState(null); var loanModal=s6[0]; var setLoanModal=s6[1];
  var s7=useState(null); var payModal=s7[0]; var setPayModal=s7[1];
  var s8=useState(''); var searchQ=s8[0]; var setSearchQ=s8[1];
  var s10=useState(''); var fMonth=s10[0]; var setFMonth=s10[1];
  var s11=useState(null); var abonoModal=s11[0]; var setAbonoModal=s11[1];
  var s12=useState(null); var debtorModal=s12[0]; var setDebtorModal=s12[1];
  // v2.0.0 — modal de liquidacion ELEVADO desde DebtorModal a nivel App: ahora es un modal
  // hermano de AbonoModal, invocable desde el perfil del deudor Y desde el CTA de AbonoModal.
  var s13=useState(null); var liquidarModal=s13[0]; var setLiquidarModal=s13[1];
  var s13=useState(false); var menuOpen=s13[0]; var setMenuOpen=s13[1];
  var s14=useState(null); var calcData=s14[0]; var setCalcData=s14[1];
  var s15=useState(null); var toast=s15[0]; var setToast=s15[1];
  var s16=useState(false); var gSearch=s16[0]; var setGSearch=s16[1];
  var s17=useState(''); var gQ=s17[0]; var setGQ=s17[1];
  var s18=useState(false); var needsRestart=s18[0]; var setNeedsRestart=s18[1];
  var s19=useState(function(){return localStorage.getItem('theme')||'dark';}); var theme=s19[0]; var setTheme=s19[1];
  var s20=useState([]); var actLog=s20[0]; var setActLog=s20[1];
  // "La Bestia" Fase 2 — journal de operaciones reversibles (GET /api/undo). El Historial lo
  // cruza con activity_log por `undo_id` (enlace 1:1 escrito por mutacionAtomica).
  var s24=useState([]); var undoLog=s24[0]; var setUndoLog=s24[1];
  var s25=useState(null); var undoDlg=s25[0]; var setUndoDlg=s25[1];
  var sDebts=useState([]); var debts=sDebts[0]; var setDebts=sDebts[1];
  var sDebtModal=useState(null); var debtModal=sDebtModal[0]; var setDebtModal=sDebtModal[1];
  var sDebtPay=useState(null); var debtPayModal=sDebtPay[0]; var setDebtPayModal=sDebtPay[1];
  var sDebtHist=useState(null); var debtHistory=sDebtHist[0]; var setDebtHistory=sDebtHist[1];
  var sDebtDel=useState(null); var debtDelete=sDebtDel[0]; var setDebtDelete=sDebtDel[1];
  var sNavOpen=useState(function(){ try{ var v=JSON.parse(localStorage.getItem('navSections')); return (v&&typeof v==='object')?v:{prestamos:true,deudas:true}; }catch(_){ return {prestamos:true,deudas:true}; } });
  var navOpen=sNavOpen[0]; var setNavOpen=sNavOpen[1];
  var s21=useState(null); var globalUpdate=s21[0]; var setGlobalUpdate=s21[1];
  var s22=useState(null); var confirmDlg=s22[0]; var setConfirmDlg=s22[1];
  var s24=useState(null); var errorDlg=s24[0]; var setErrorDlg=s24[1];
  var s25=useState('win32'); var platform=s25[0]; var setPlatform=s25[1];
  // v1.9.0 — Reestructurar prestamo (sin abono) + preflight de cuotas proximas a mora
  var sRe=useState(null); var restructureModal=sRe[0]; var setRestructureModal=sRe[1];
  var sPre=useState(null); var preflightDlg=sPre[0]; var setPreflightDlg=sPre[1];
  var isMac=platform==='darwin';
  var sWide=useState(window.innerWidth>=768); var isDesktop=sWide[0]; var setIsDesktop=sWide[1];
  useEffect(function(){function onR(){setIsDesktop(window.innerWidth>=768);} window.addEventListener('resize',onR); return function(){window.removeEventListener('resize',onR);};},[]);
  // Conectar el canal de errores de API con el toast de la UI
  setErrorHandler(function(msg){ showToast(msg, 'error'); });
  // Chequear errores de arranque
  useEffect(function(){
    if(typeof window.electronAPI==='undefined'||!window.electronAPI.getStartupErrors) return;
    window.electronAPI.getStartupErrors().then(function(errs){
      if(errs && errs.length > 0) {
        setErrorDlg({title:'Aviso al iniciar', messages: errs.map(function(e){return e.message;})});
      }
    });
  },[]);
  function toggleTheme(){
    var next=theme==='dark'?'light':'dark';
    setTheme(next);localStorage.setItem('theme',next);
    document.documentElement.setAttribute('data-theme',next);
  }
  useEffect(function(){document.documentElement.setAttribute('data-theme',theme);},[]);
  useEffect(function(){
    if(typeof window.electronAPI!=='undefined'&&window.electronAPI.getPlatform){
      window.electronAPI.getPlatform().then(function(p){setPlatform(p);});
    }
  },[]);
  useEffect(function(){
    if(typeof window.electronAPI==='undefined'||!window.electronAPI.onUpdateStatus) return;
    var unsub=window.electronAPI.onUpdateStatus(function(data){setGlobalUpdate(data);});
    return unsub;
  },[]);
  // ── Changelog post-actualización ──────────────────────────────────────────
  var s23=useState(null); var changelogDlg=s23[0]; var setChangelogDlg=s23[1];
  useEffect(function(){
    if(typeof window.electronAPI==='undefined'||!window.electronAPI.getAppVersion) return;
    window.electronAPI.getAppVersion().then(function(ver){
      window._appVersion=ver;
      var lastSeen = localStorage.getItem('lastSeenVersion');
      // v1.12.1: se quito el guard `lastSeen &&`. El rebranding mueve userData a
      // %APPDATA%\cartera\ -> localStorage arranca vacio (lastSeen null) y el modal
      // de novedades nunca disparaba. Ahora dispara siempre que la version guardada
      // difiera de la actual (incluido null) y exista changelog. El setItem de abajo
      // garantiza que solo se muestre una vez por version.
      if(lastSeen !== ver && CHANGELOGS[ver]){
        setChangelogDlg({version:ver, items:CHANGELOGS[ver]});
      }
      localStorage.setItem('lastSeenVersion', ver);
    });
  },[]);

  var toastTimer=React.useRef(null);
  function showToast(msg,type){
    type=type||'success';
    if(toastTimer.current) clearTimeout(toastTimer.current);
    setToast({msg:msg,type:type,out:false});
    toastTimer.current=setTimeout(function(){setToast(function(t){return t?Object.assign({},t,{out:true}):null;});
      setTimeout(function(){setToast(null);},300);
    },2000);
  }

  var reload=useCallback(function(){
    return Promise.all([API.get('/api/loans'),API.get('/api/payments'),API.get('/api/config')])
      .then(function(res){
        if(res[0]) setLoans(res[0]);
        if(res[1]) setPays(res[1]);
        if(res[2]) setCfg(res[2]);
        setLoading(false);
        return res; // v1.17.0: expone los datos frescos (el Recibo de Abono los necesita)
      });
  },[]);

  // Guarda pares clave/valor en config (PUT /api/config) y refresca el estado local.
  var saveConfig=useCallback(function(patch){
    return API.put('/api/config',patch).then(function(r){
      if(!r) return null;
      setCfg(function(c){return Object.assign({},c,patch);});
      return r;
    });
  },[]);

  // Mis Deudas: modulo independiente; se carga aparte de reload() (loans/pays/config)
  var loadDebts=useCallback(function(){
    return API.get('/api/debts').then(function(data){ if(data) setDebts(data); });
  },[]);

  // ⚠️ ORDEN DE HOOKS: estos dos useCallback DEBEN vivir aqui, junto al resto de hooks de App y
  // MUY por encima del `if(loading) return ...` que corta el render mientras cargan los datos.
  // Estuvieron mas abajo (junto a navTo) y provocaron la pantalla negra de v2.1.0: en el primer
  // render loading=true, el return temprano se disparaba y estos hooks NO se ejecutaban; al
  // terminar la carga el render pasaba de largo y aparecian 2 hooks nuevos -> React lanzaba el
  // error #310 ("rendered more hooks than during the previous render"), desmontaba el arbol y la
  // pantalla se quedaba con lo ultimo pintado: el fondo var(--bg) del spinner (casi negro).
  // Regla: NINGUN hook por debajo de un return condicional.

  // Carga el historial y el journal EN PARALELO: la fila del log solo sabe que es reversible
  // cuando su undo_id existe en el journal y ademas es el head LIFO de su agregado.
  var loadHistorial=useCallback(function(){
    return Promise.all([
      fetch('/api/activity').then(function(r){return r.json();}).catch(function(){return [];}),
      fetch('/api/undo').then(function(r){return r.json();}).catch(function(){return [];})
    ]).then(function(res){
      setActLog(Array.isArray(res[0])?res[0]:[]);
      setUndoLog(Array.isArray(res[1])?res[1]:[]);
      return res;
    });
  },[]);

  // Ejecuta el undo y refresca TODO: el journal cambia de estado, el historial gana su entrada
  // compensatoria y los datos del prestamo/deuda vuelven al snapshot.
  var confirmarUndo=useCallback(function(entry){
    return API.post('/api/undo/'+entry.id,{}).then(function(r){
      if(!r){showToast('No se pudo deshacer','error');return;}
      if(r.error){showToast(r.error,'error');return;}
      setUndoDlg(null);
      return Promise.all([reload(),loadHistorial(),loadDebts()]).then(function(){
        // El backend avisa (sin bloquear) cuando el estado habia cambiado desde la operacion.
        showToast(r.warning?'Deshecho, con advertencias':'Operacion deshecha');
      });
    });
  },[reload,loadHistorial,loadDebts]);

  // Crear o editar deuda. data.id presente -> PUT (editar); ausente -> POST (crear).
  var saveDebt=useCallback(function(data){
    var req=data.id?API.put('/api/debts/'+data.id,data):API.post('/api/debts',data);
    return req.then(function(r){
      if(!r) return; // en error, handleApiError ya mostro el toast
      setDebtModal(null);
      return loadDebts().then(function(){ showToast(data.id?'Deuda actualizada':'Deuda registrada'); });
    });
  },[loadDebts]);

  // Eliminar deuda (DELETE /api/debts/:id). El confirm() nativo se hace en la tarjeta.
  var deleteDebt=useCallback(function(id){
    return API.del('/api/debts/'+id).then(function(r){
      if(!r) return;
      return loadDebts().then(function(){ showToast('Deuda eliminada','error'); });
    });
  },[loadDebts]);

  // QA6: acreedores unicos (case-insensitive, Proper Case) para el autocompletado de DebtModal.
  var existingAcreedores=useMemo(function(){
    var seen={},out=[];
    debts.forEach(function(d){
      var n=properCase(d.acreedor||''); var k=n.toLowerCase();
      if(n&&!seen[k]){ seen[k]=1; out.push(n); }
    });
    out.sort(function(a,b){return a.localeCompare(b);});
    return out;
  },[debts]);

  // Abonar a una deuda (POST /api/debts/:id/pay). Cierra el modal y recarga la lista.
  var payDebt=useCallback(function(id,data){
    return API.post('/api/debts/'+id+'/pay',data).then(function(r){
      if(!r) return;
      var saldada=r.deuda&&r.deuda.estado==='Pagada';
      setDebtPayModal(null);
      return loadDebts().then(function(){ showToast(saldada?'Deuda saldada':'Abono registrado'); });
    });
  },[loadDebts]);

  useEffect(function(){
    API.post('/api/recalculate',{}).then(function(){return reload();});
    loadDebts();
  },[reload,loadDebts]);

  var openPayModal=useCallback(function(p){
    var loan=null;
    for(var i=0;i<loans.length;i++){if(loans[i].id===p.prestamoId){loan=loans[i];break;}}
    setPayModal({pay:p,loan:loan});
  },[loans]);

  var saveLoan=useCallback(function(data){
    // Vinculacion automatica: si es nuevo, buscar deudor existente por nombre (case-insensitive)
    if(!data.id){
      var nombreNorm=data.nombre.trim().toLowerCase();
      var existente=loans.find(function(l){return l.nombre.trim().toLowerCase()===nombreNorm;});
      if(existente){
        // Auto-vincular: usar cedula/telefono del deudor existente si no se llenaron
        if(!data.cedula||data.cedula==='0') data.cedula=existente.cedula;
        if(!data.telefono||data.telefono==='0') data.telefono=existente.telefono;
        // Usar nombre exacto del existente para consistencia
        data.nombre=existente.nombre;
        // Validacion de duplicados: mismo nombre + mismo monto activo
        var dupActivo=loans.find(function(l){return l.nombre.trim().toLowerCase()===nombreNorm&&l.estado==='Activo'&&Math.round(l.montoCOP)===Math.round(data.montoCOP);});
        if(dupActivo){
          setConfirmDlg({title:'Prestamo duplicado',message:'Ya existe un prestamo activo para "'+existente.nombre+'" por '+fmt(data.montoCOP)+'.',okLabel:'Crear igual',okColor:'var(--yellow)',onConfirm:function(){setConfirmDlg(null);doSaveLoan(data);}});
          return Promise.resolve();
        }
      }
    }
    return doSaveLoan(data);
  },[reload,loans]);
  function doSaveLoan(data){
    var isNew=!data.id;
    var p=data.id?API.put('/api/loans/'+data.id,data):API.post('/api/loans',data);
    return p.then(function(r){
      if(!r)return;
      var savedLoan=r;
      return reload().then(function(){
        setLoanModal(null);showToast(isNew?'Prestamo creado':'Prestamo actualizado');
        if(isNew&&savedLoan&&savedLoan.id){
          setConfirmDlg({title:'Cronograma PDF',message:'¿Deseas generar el cronograma de pagos en PDF para enviar al deudor?',okLabel:'Generar PDF',okColor:'var(--blue)',onConfirm:function(){
            setConfirmDlg(null);
            API.get('/api/payments').then(function(allPays){
              var loanPays=allPays.filter(function(p2){return p2.prestamoId===savedLoan.id;});
              generateCronogramaPDF(savedLoan,loanPays,theme==='dark');
            });
          }});
        }
      });
    });
  }

  var delLoan=useCallback(function(id){
    setConfirmDlg({title:'Eliminar prestamo',message:'Se eliminara el prestamo y todo su cronograma de pagos. Esta accion no se puede deshacer.',okLabel:'Eliminar',okColor:'#b91c1c',onConfirm:function(){setConfirmDlg(null);API.del('/api/loans/'+id).then(function(r){if(!r)return;reload();showToast('Prestamo eliminado','error');});}});
  },[reload]);

  var forceCloseLoan=useCallback(function(loan){
    // Calcular pérdida estimada para mostrarla en la confirmación
    var lp=pays.filter(function(p){return p.prestamoId===loan.id;});
    var origCOP=loan.moneda==='USD'?Math.round(loan.montoOrigen*loan.trmAcordada):Math.round(loan.montoOrigen);
    var capPag=lp.filter(function(p){return p.estadoPago==='Pagado';}).reduce(function(s,p){return s+p.abonoCapital;},0);
    var capPerd=Math.max(0,Math.round(origCOP-capPag));
    var intPerd=Math.round(lp.filter(function(p){return p.estadoPago==='En Mora'&&!esAbono(p);}).reduce(function(s,p){return s+p.interesPeriodo;},0));
    var total=capPerd+intPerd;
    var msg='Cerrar a la fuerza el prestamo de '+loan.nombre+'. Se daran por perdidos:\n'
      +'• Capital pendiente: $'+capPerd.toLocaleString('es-CO')+'\n'
      +'• Intereses en mora: $'+intPerd.toLocaleString('es-CO')+'\n'
      +'• Total perdido: $'+total.toLocaleString('es-CO')+'\n'
      +'Las cuotas pendientes y en mora se eliminaran. El prestamo pasara a "Cancelado" y no se podra reactivar.';
    setConfirmDlg({title:'Cerrar prestamo a la fuerza',message:msg,okLabel:'Cerrar prestamo',okColor:'#b91c1c',onConfirm:function(){
      setConfirmDlg(null);
      API.post('/api/loans/'+loan.id+'/force-close',{}).then(function(r){
        if(!r)return;
        if(r.error){showToast(r.error,'error');return;}
        reload();showToast('Prestamo cerrado — perdida: $'+(r.totalPerdido||total).toLocaleString('es-CO'),'error');
      });
    }});
  },[pays,reload]);

  var recalculate=useCallback(function(){
    API.post('/api/recalculate',{}).then(function(r){
      reload();showToast('Cronogramas recalculados');
    });
  },[reload]);

  // v1.18.1 — se devuelve la promesa para que PayModal pueda liberar su guarda anti
  // doble-submit. Sin el `return`, el modal recibe undefined y la guarda quedaria colgada.
  var markPay=useCallback(function(id,status,fecha,obs,copRecibido,usdRecibido){
    fecha=fecha||null; obs=obs||''; copRecibido=copRecibido||0; usdRecibido=usdRecibido||0;
    return API.put('/api/payments/'+id,{estadoPago:status,fechaRecaudo:status==='Pagado'?(fecha||nowStr()):null,observaciones:obs,montoCOPRecibido:copRecibido,montoUSDRecibido:usdRecibido})
      .then(function(r){if(!r)return null;return reload().then(function(){return r;});})
      // v1.18.1: faltaba el guard `if(!r)`. Ante un fallo de API (API.put atrapa el error y
      // resuelve null) este .then corria igual: cerraba el modal y anunciaba "Pago registrado"
      // pese a que la escritura NO se habia hecho. markPartial ya lo tenia bien.
      // v2.3.0: resuelve con `r` (o null) para que el llamador sepa si la escritura ocurrio —
      // PayModal lo usa para emitir el recibo SOLO si el pago se registro de verdad.
      .then(function(r){if(!r)return null;setPayModal(null);showToast(status==='Pagado'?'Pago registrado':status==='En Mora'?'Marcado en mora':'Estado actualizado');return r;});
  },[reload]);

  var markPartial=useCallback(function(id,monto,fecha,obs,usdRecibido){
    return API.post('/api/payments/'+id+'/partial',{monto:monto,fecha:fecha||nowStr(),observaciones:obs||'',montoUSD:usdRecibido||0})
      .then(function(r){if(!r)return;return reload().then(function(){return r;});})
      // v2.3.0: resuelve con `r` (o null) — ver markPay.
      .then(function(r){if(!r)return null;setPayModal(null);showToast(r.completa?'Pago completado':'Pago parcial registrado ($'+(r.restante||0).toLocaleString('es-CO')+' restante)');return r;});
  },[reload]);

  var confirmarCalc=useCallback(function(data){
    setCalcData(null);
    setLoanModal({_prefill:{},_calcPrefill:data});
    setView('cartera');
  },[]);

  // v1.9.0 — Helpers de aplicacion (abono + reestructurar). Cada uno verifica cuotas
  // proximas a mora (≤5 dias) cuando hay recalculo, y muestra PreflightMoraModal antes
  // de continuar.
  // v1.17.0 — snapshot PRE-abono para el Recibo de Abono: saldo, cuota, cuotas restantes e
  // intereses ANTES del recalculo. Tras el POST el cronograma anterior ya no existe en BD.
  function _snapshotAbono(loanId){
    var l=loans.find(function(x){return x.id===loanId;});
    if(!l) return {};
    var lp=pays.filter(function(p){return p.prestamoId===loanId;});
    var esUSD=l.moneda==='USD',trm=l.trmAcordada||1;
    var orig=esUSD?Math.round(l.montoOrigen*trm):Math.round(l.montoOrigen);
    var capPag=lp.filter(function(p){return p.estadoPago==='Pagado';}).reduce(function(s,p){return s+p.abonoCapital;},0);
    var pend=lp.filter(function(p){return !esAbono(p)&&p.estadoPago==='Pendiente';}).sort(function(a,b){return a.cuotaN-b.cuotaN;});
    // `saldo` (MOTOR) se conserva a proposito: la liquidacion envia `monto = L.capitalPendiente`,
    // que esta en esa misma base; parearlo con el saldo con caja imprimiria un Paz y Salvo con
    // "saldo anterior < monto aplicado". `saldoCaja` es el que se MUESTRA como "Saldo anterior".
    return {saldo:Math.max(0,orig-capPag),saldoCaja:saldoConCaja(l,lp),cuota:pend.length?pend[0].cuotaTotal:0,cuotas:pend.length,
            intereses:pend.reduce(function(s,p){return s+p.interesPeriodo;},0),plazo:l.plazoMeses};
  }
  function _doAbono(loanId,monto,fecha,obs,montoUSD,liquidar,recalcMode,recalcValor,genRecibo,intExtra,copRecibido){
    var fromDeudor=abonoModal&&abonoModal.fromDeudor;
    var pre=_snapshotAbono(loanId);
    // v1.19.0 — intExtra (interes del proximo mes al liquidar, si el checkbox esta activo) viaja al
    // backend para registrarse como ingreso real; el backend lo ignora (0) fuera de la liquidacion.
    // v2.0.0 — montoCOPRecibido = CAJA REAL del abono (solo prestamos USD). NO toca el capital
    // (que va en `monto`, a TRM pactada): el backend lo persiste en la fila del abono para que el
    // desfase cambiario quede registrado. Si es 0 el backend conserva el valor derivado de antes.
    return API.post('/api/loans/'+loanId+'/abono',{monto:monto,fecha:fecha,observaciones:obs,montoUSD:montoUSD||0,liquidar:!!liquidar,recalcMode:recalcMode||null,recalcValor:recalcValor||null,intExtra:intExtra||0,montoCOPRecibido:copRecibido||0})
      .then(function(r){
        if(!r)return;
        if(r.error){showToast(r.error,'error');return;}
        // v1.9.0 — await reload antes de re-abrir DebtorModal para evitar mostrar datos viejos
        return reload().then(function(fresh){
          if(fromDeudor) setDebtorModal(fromDeudor);
          setAbonoModal(null);
          showToast(liquidar?'Deuda liquidada':'Abono registrado');
          // v1.17.0 — Recibo de Abono con el estado YA persistido (cronograma real regenerado
          // por el backend; no se replica aqui el motor financiero). Nunca rompe el flujo.
          try{
            var fl=((fresh&&fresh[0])||loans).find(function(x){return x.id===loanId;});
            var fp=(fresh&&fresh[1])||pays;
            // genRecibo!==false: la liquidacion (que no pasa el flag) mantiene el Paz y Salvo por defecto
            if(fl&&genRecibo!==false) generateReciboAbono(fl,fp,{monto:monto,montoUSD:montoUSD,fecha:fecha,observaciones:obs,pre:pre,recalcMode:recalcMode,liquidar:!!liquidar});
          }catch(e){}
        });
      });
  }
  function _doReestructurar(loanId,mode,valor,fromDeudor){
    return API.post('/api/loans/'+loanId+'/reestructurar',{recalcMode:mode,recalcValor:valor})
      .then(function(r){
        if(!r)return;
        if(r.error){showToast(r.error,'error');return;}
        // v1.9.0 — await reload antes de re-abrir DebtorModal
        return reload().then(function(){
          setRestructureModal(null);
          if(fromDeudor) setDebtorModal(fromDeudor);
          showToast('Prestamo reestructurado');
        });
      });
  }
  function _marcarMoraBatch(cuotas){
    var promises=cuotas.map(function(p){
      return API.put('/api/payments/'+p.id,{estadoPago:'En Mora',fechaRecaudo:null,observaciones:p.observaciones||'',montoCOPRecibido:0,montoUSDRecibido:0});
    });
    return Promise.all(promises);
  }
  var registrarAbono=useCallback(function(loanId,monto,fecha,obs,montoUSD,liquidar,recalcMode,recalcValor,genRecibo,intExtra,copRecibido){
    var needsPreflight=(recalcMode==='modificarPlazo'||recalcMode==='fijarCuota');
    var enRiesgo=needsPreflight?_cuotasEnRiesgo(pays,loanId):[];
    // v1.17.1: se devuelve la promesa para que AbonoModal libere su guarda anti doble-submit
    if(enRiesgo.length===0){return _doAbono(loanId,monto,fecha,obs,montoUSD,liquidar,recalcMode,recalcValor,genRecibo,intExtra,copRecibido);}
    var loanObj=loans.find(function(l){return l.id===loanId;});
    setPreflightDlg({
      cuotas:enRiesgo,loan:loanObj,
      // v1.18.1: se devuelve la promesa para que PreflightMoraModal libere su guarda.
      onMarkMora:function(){return _marcarMoraBatch(enRiesgo).then(function(){setPreflightDlg(null);return _doAbono(loanId,monto,fecha,obs,montoUSD,liquidar,recalcMode,recalcValor,genRecibo,intExtra,copRecibido);});},
      onContinue:function(){setPreflightDlg(null);return _doAbono(loanId,monto,fecha,obs,montoUSD,liquidar,recalcMode,recalcValor,genRecibo,intExtra,copRecibido);},
      onCancel:function(){setPreflightDlg(null);}
    });
  },[reload,abonoModal,pays,loans]);
  var reestructurarPrestamo=useCallback(function(loanId,mode,valor){
    var fromDeudor=restructureModal&&restructureModal.fromDeudor;
    var enRiesgo=_cuotasEnRiesgo(pays,loanId);
    // v1.18.1: se devuelve la promesa para que RestructureModal libere su guarda (mismo
    // patron que registrarAbono). En la rama de pre-flight se devuelve undefined a proposito:
    // el modal libera de inmediato porque el control pasa al PreflightMoraModal.
    if(enRiesgo.length===0){return _doReestructurar(loanId,mode,valor,fromDeudor);}
    var loanObj=loans.find(function(l){return l.id===loanId;});
    setPreflightDlg({
      cuotas:enRiesgo,loan:loanObj,
      // v1.18.1: se devuelve la promesa para que PreflightMoraModal libere su guarda.
      onMarkMora:function(){return _marcarMoraBatch(enRiesgo).then(function(){setPreflightDlg(null);return _doReestructurar(loanId,mode,valor,fromDeudor);});},
      onContinue:function(){setPreflightDlg(null);return _doReestructurar(loanId,mode,valor,fromDeudor);},
      onCancel:function(){setPreflightDlg(null);}
    });
  },[reload,restructureModal,pays,loans]);

  var metrics=useMemo(function(){
    var td=nowStr(),thisM=td.slice(0,7),nxtW=addDays(td,7);
    var active=loans.filter(function(l){return l.estado==='Activo';});
    var noAbono=function(p){return !esAbono(p);};
    var mp=pays.filter(function(p){return p.fechaPago.startsWith(thisM)&&noAbono(p);});
    var mora=pays.filter(function(p){return p.estadoPago==='En Mora'&&noAbono(p);});
    // v1.9.x — Recaudo del mes con logica de flujo de caja estricta. Mora arrastrada
    // ya no contamina el "esperado": solo cuenta lo que vence este mes. La mora
    // recuperada (cuotas de otros meses pagadas durante este mes) si suma al "recibido"
    // y aparece en la lista para visibilidad operativa.
    var moraRecuperadaMes=pays.filter(function(p){
      return noAbono(p)
        && !p.fechaPago.startsWith(thisM)
        && p.estadoPago==='Pagado'
        && p.fechaRecaudo
        && p.fechaRecaudo.startsWith(thisM);
    });
    // Ganancia real (historica, todos los estados): para USD usa montoCOPRecibido - capital robusto
    // (cuotaTotal - interesPeriodo), no abonoCapital (que se persiste en 0 en modalidad Prestamo y
    // contaria el capital como ganancia fantasma — Bug #25). Para COP usa interesPeriodo. Excluye abonos.
    // Misma definicion que loanMetrics.ganancia en PortfolioView -> ambas vistas cuadran.
    var loanCurrency={};loans.forEach(function(l){loanCurrency[l.id]=l.moneda;});
    var totalInteresesRecibidos=pays.filter(function(p){return p.estadoPago==='Pagado'&&!esAbono(p);})
      .reduce(function(s,p){
        var esUSD=loanCurrency[p.prestamoId]==='USD';
        if(esUSD&&p.montoCOPRecibido&&p.montoCOPRecibido>0){
          return s+(p.montoCOPRecibido-(p.cuotaTotal-p.interesPeriodo));
        }
        return s+p.interesPeriodo;
      },0);
    // Saldo real pendiente por préstamo activo (capital - capital recuperado)
    // KPI "Saldo Pendiente" del Inicio. Fase 3: capital vivo = original - CAPITAL IMPUTADO.
    // Antes restaba el parcial COMPLETO, mezclando interes dentro de una cifra de capital y
    // dando un numero distinto al del perfil del deudor para el mismo prestamo.
    var totalDeuda=active.reduce(function(s,l){
      var orig=l.moneda==='USD'?Math.round(l.montoOrigen*l.trmAcordada):Math.round(l.montoOrigen);
      var capImp=pays.filter(function(p){return p.prestamoId===l.id;})
        .reduce(function(a,p){return a+imputarCobros(p).totales.capital;},0);
      return s+Math.max(0,orig-Math.round(capImp));
    },0);
    // ESPERADO = SOLO cuotas con fechaPago en el mes actual (la meta real, sin mora arrastrada)
    var esperadoTot=mp.reduce(function(s,p){return s+p.cuotaTotal;},0);
    // RECIBIDO (Cobros del Mes) = flujo de caja real por FECHA DE TRANSACCION via cobrosDe():
    // ledger de recibos (cada parcial en su dia exacto + el pago final) con fallback a fechaRecaudo.
    // Incluye parciales EN CURSO y abonos a capital. Definicion IDENTICA a sparkCobros -> el KPI ==
    // suma de los puntos del grafico por construccion, sin doble conteo.
    var recibidoTot=pays.reduce(function(s,p){
      return s+cobrosDe(p).reduce(function(a,e){return a+(e.fecha.slice(0,7)===thisM?e.cop:0);},0);
    },0);
    return {
      totalCartera:totalDeuda,
      activeCount:active.length,
      esperado:esperadoTot,
      recibido:recibidoTot,
      mora:mora,totalMora:mora.reduce(function(s,p){return s+pendCuota(p);},0),
      totalInteresesRecibidos:totalInteresesRecibidos,
      hoy:pays.filter(function(p){return p.estadoPago==='Pendiente'&&p.fechaPago===td;})
              .sort(function(a,b){return a.nombreCliente.localeCompare(b.nombreCliente);}),
      proximos:pays.filter(function(p){return p.estadoPago==='Pendiente'&&p.fechaPago>td&&p.fechaPago<=nxtW;})
                   .sort(function(a,b){return a.fechaPago.localeCompare(b.fechaPago);}),
      pronto:pays.filter(function(p){return p.estadoPago==='Pendiente'&&p.fechaPago>td&&p.fechaPago<=addDays(td,3);})
                 .sort(function(a,b){return a.fechaPago.localeCompare(b.fechaPago);}),
      // Lista expandida: cuotas del mes actual (todos los estados) + mora recuperada este mes
      // (NO incluye mora historica pendiente — esa vive en la tarjeta "Pagos en Mora")
      recaudoList:mp.concat(moraRecuperadaMes)
                   .sort(function(a,b){return a.fechaPago.localeCompare(b.fechaPago)||a.nombreCliente.localeCompare(b.nombreCliente);})
    };
  },[loans,pays]);

  var filtPays=useMemo(function(){
    return pays.filter(function(p){
      if(p.estadoPago==='Pagado') return false;
      if(searchQ&&!payMatchesQuery(p,searchQ)) return false;
      if(fMonth&&p.fechaPago.indexOf(fMonth)!==0) return false;
      return true;
    }).sort(function(a,b){return a.fechaPago.localeCompare(b.fechaPago)||a.nombreCliente.localeCompare(b.nombreCliente);});
  },[pays,searchQ,fMonth]);

  // Deudores: agrupar loans por nombre
  var deudores=useMemo(function(){
    var map={};
    loans.forEach(function(l){
      var key=l.nombre;
      if(!map[key]) map[key]={nombre:l.nombre,cedula:l.cedula,telefono:l.telefono,loans:[],totalSaldo:0,totalSaldoUSD:0,mora:0};
      map[key].loans.push(l);
      if(l.estado==='Activo'){
        var origL=l.moneda==='USD'?Math.round(l.montoOrigen*l.trmAcordada):Math.round(l.montoOrigen);
        // Fase 2: el saldo mostrado descuenta el CAPITAL imputado, no el parcial completo. Restar
        // `partialPend` crudo descontaba de una cifra de capital una plata que en parte era interes,
        // y ademas contradecia al panel de Flujo de Caja del mismo perfil (medido: $200.000 de
        // diferencia entre la cabecera y la tabla, sobre el mismo prestamo).
        var capImpL=pays.filter(function(p){return p.prestamoId===l.id;})
          .reduce(function(s,p){return s+imputarCobros(p).totales.capital;},0);
        var saldoLoan=Math.max(0,origL-Math.round(capImpL));
        map[key].totalSaldo+=saldoLoan;
        if(l.moneda==='USD'&&l.trmAcordada>0) map[key].totalSaldoUSD+=Math.round(saldoLoan/l.trmAcordada*100)/100;
      }
    });
    // Add mora count per deudor
    pays.forEach(function(p){
      if(p.estadoPago==='En Mora'){
        var loan=null;
        for(var i=0;i<loans.length;i++){if(loans[i].id===p.prestamoId){loan=loans[i];break;}}
        if(loan&&map[loan.nombre]) map[loan.nombre].mora++;
      }
    });
    return Object.values(map).sort(function(a,b){
      var aActivos=a.loans.filter(function(l){return l.estado==='Activo';});
      var bActivos=b.loans.filter(function(l){return l.estado==='Activo';});
      // Activos primero, inactivos al final
      if(aActivos.length>0&&bActivos.length===0) return -1;
      if(aActivos.length===0&&bActivos.length>0) return 1;
      if(aActivos.length===0&&bActivos.length===0) return a.nombre.localeCompare(b.nombre);
      // Entre activos: más nuevo arriba, más viejo abajo
      var aFecha=aActivos.reduce(function(min,l){return l.fechaInicio<min?l.fechaInicio:min;},aActivos[0].fechaInicio);
      var bFecha=bActivos.reduce(function(min,l){return l.fechaInicio<min?l.fechaInicio:min;},bActivos[0].fechaInicio);
      return bFecha.localeCompare(aFecha);
    });
  },[loans,pays]);


  // Busqueda global
  var gResults=useMemo(function(){
    if(!gQ||gQ.length<2) return [];
    var q=gQ.toLowerCase();
    var results=[];
    // Deudores
    deudores.forEach(function(d){
      if(d.nombre.toLowerCase().indexOf(q)!==-1)
        results.push({type:'deudor',label:d.nombre,sub:d.loans.length+' prestamos - '+fmt(d.totalSaldo),data:d});
    });
    // Prestamos
    loans.forEach(function(l){
      if(l.nombre.toLowerCase().indexOf(q)!==-1||l.modalidad.toLowerCase().indexOf(q)!==-1)
        results.push({type:'prestamo',label:l.nombre+' - '+l.modalidad,sub:fmt(Math.round(l.montoOrigen*(l.moneda==='USD'?l.trmAcordada:1)))+' | '+l.estado,data:l});
    });
    // Pagos pendientes/mora
    pays.forEach(function(p){
      if(p.estadoPago==='Pagado') return;
      if(p.nombreCliente.toLowerCase().indexOf(q)!==-1)
        results.push({type:'pago',label:p.nombreCliente+' - Cuota '+p.cuotaN,sub:fmt(p.cuotaTotal)+' | '+p.estadoPago+' | '+fmtD(p.fechaPago),data:p});
    });
    return results.slice(0,15);
  },[gQ,deudores,loans,pays]);

  function openGSearch(){setGSearch(true);setGQ('');}
  function closeGSearch(){setGSearch(false);setGQ('');}

  // Abrir perfil deudor por nombre
  function openDebtorByName(nombre){
    var d=deudores.find(function(x){return x.nombre===nombre;});
    if(d) setDebtorModal(d);
  }

  // Botón rápido ✓: abre PayModal (permite elegir Completo o Parcial)
  var quickPay=openPayModal;

  if(loading) return h('div',{style:{display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',height:'100vh',background:'var(--bg)',gap:16}},
    h('div',{className:'spinner'}),
    h('p',{style:{color:'var(--text3)',fontSize:13}},'Cargando...'));

  var navSections=[
    {key:'prestamos',label:'Prestamos',items:[
      ['dashboard','home','Resumen'],
      ['cartera','briefcase','Cartera'],
      ['deudores','users','Deudores'],
      ['pagos','check2','Pagos'],
      ['rendimiento','trending','Rendimiento'],
      ['calculadora','calc','Calculadora'],
      ['historial','activity','Historial']
    ]},
    {key:'deudas',label:'Deudas',items:[
      ['deudas','wallet','Mis Deudas']
    ]}
  ];
  var navStandalone=[['desarrollador','settings','Desarrollador']];
  // Lista plana derivada (para el lookup de icono+label de la vista actual en el header).
  var nav=navSections.reduce(function(acc,s){return acc.concat(s.items);},[]).concat(navStandalone);

  function navTo(id){
    setView(id);setMenuOpen(false);
    if(id==='historial') loadHistorial();
    if(id==='deudas') loadDebts();
  }

  // Acordeon del sidebar: alterna una seccion y persiste el estado en localStorage (sobrevive F5).
  function toggleNavSection(key){
    setNavOpen(function(prev){
      var next=Object.assign({},prev); next[key]=!next[key];
      try{ localStorage.setItem('navSections',JSON.stringify(next)); }catch(_){}
      return next;
    });
  }

  var sidebarCollapsed = menuOpen;
  function toggleSidebar(){ setMenuOpen(!menuOpen); }

  return h('div',{className:'app-layout'},
    // ── Sidebar ──
    h('div',{className:'sidebar'+(menuOpen?' collapsed':'')},
      h('div',{className:'sidebar-header'},
        h(Ico,{name:'briefcase',size:18,color:'var(--green)'}),
        h('div',null,
          h('div',{style:{fontWeight:700,fontSize:16,color:'var(--text)'}},'Cartera'),
          h('div',{style:{fontSize:12,color:'var(--text3)',fontFamily:'monospace'}},metrics.activeCount+' activos'))),
      h('div',{className:'sidebar-nav'},
        navSections.map(function(sec){
          var open=navOpen[sec.key]!==false;
          return h('div',{key:sec.key,style:{marginBottom:2}},
            h('button',{onClick:function(){toggleNavSection(sec.key);},style:{display:'flex',alignItems:'center',justifyContent:'space-between',width:'100%',background:'none',border:'none',cursor:'pointer',fontFamily:'inherit',color:'var(--text3)',fontSize:11,fontWeight:700,textTransform:'uppercase',letterSpacing:'.6px',padding:'10px 14px 5px',userSelect:'none'}},
              h('span',null,sec.label),
              h(Ico,{name:open?'chevdown':'chevright',size:14,color:'var(--text3)'})),
            open?sec.items.map(function(item){
              var id=item[0],icon=item[1],label=item[2];
              return h('button',{key:id,className:'nav-item'+(view===id?' active':''),onClick:function(){navTo(id);},style:{paddingLeft:24}},
                h(Ico,{name:icon,size:18,color:view===id?'var(--green)':'var(--text3)'}),label);
            }):null);
        }),
        h('div',{style:{height:1,background:'var(--border)',margin:'8px 8px'}}),
        navStandalone.map(function(item){
          var id=item[0],icon=item[1],label=item[2];
          return h('button',{key:id,className:'nav-item'+(view===id?' active':''),onClick:function(){navTo(id);}},
            h(Ico,{name:icon,size:18,color:view===id?'var(--green)':'var(--text3)'}),label);
        })),
      h('div',{className:'sidebar-footer'},'v'+(window._appVersion||''))),
    // ── Main Area ──
    h('div',{className:'main-area'},
      h('div',{className:'main-header'},
        h('button',{onClick:toggleSidebar,style:{background:'none',border:'none',cursor:'pointer',padding:4,display:'flex'}},
          h(Ico,{name:'menu',size:22,color:'var(--text)'})),
        h('div',{style:{display:'flex',alignItems:'center',gap:8}},
          h(Ico,{name:nav.find(function(n){return n[0]===view;})?nav.find(function(n){return n[0]===view;})[1]:'home',size:18,color:'var(--green)'}),
          h('span',{style:{fontWeight:700,fontSize:16,color:'var(--text)'}},nav.find(function(n){return n[0]===view;})?nav.find(function(n){return n[0]===view;})[2]:'Inicio')),
        h('div',{style:{flex:1}}),
        h('div',{style:{display:'flex',alignItems:'center',gap:8}},
          metrics.pronto.length>0&&h('div',{onClick:function(){navTo('pagos');},style:{background:'var(--yellow-bg)',border:'1px solid var(--yellow)',padding:'5px 10px',borderRadius:99,fontSize:12,fontWeight:700,display:'flex',alignItems:'center',gap:4,cursor:'pointer',color:'var(--yellow)'},title:'Cuotas por vencer en 3 dias'},
            h(Ico,{name:'clock',size:12,color:'var(--yellow)'}),metrics.pronto.length,' pronto'),
          metrics.mora.length>0&&h('div',{onClick:function(){setSearchQ('');setFMonth('');navTo('pagos');},style:{background:'var(--red-bg)',border:'1px solid var(--red-bd)',padding:'5px 10px',borderRadius:99,fontSize:12,fontWeight:700,display:'flex',alignItems:'center',gap:4,cursor:'pointer',color:'var(--red)'}},
            h(Ico,{name:'bell',size:12,color:'var(--red)'}),metrics.mora.length,' mora'),
          h('button',{onClick:openGSearch,style:{background:'var(--bg3)',border:'1px solid var(--border)',borderRadius:99,padding:'6px 8px',cursor:'pointer',display:'flex',alignItems:'center'}},
            h(Ico,{name:'search',size:14,color:'var(--text3)'})),
          h('button',{onClick:toggleTheme,style:{background:'var(--bg3)',border:'1px solid var(--border)',borderRadius:99,padding:'6px 8px',cursor:'pointer',display:'flex',alignItems:'center'},title:theme==='dark'?'Tema claro':'Tema oscuro'},
            h(Ico,{name:theme==='dark'?'sun':'moon',size:14,color:'var(--text3)'})))),
      globalUpdate&&globalUpdate.status==='available'&&h('div',{style:{background:'var(--green-bg)',border:'1px solid var(--green-bd)',padding:'10px 20px',display:'flex',alignItems:'center',justifyContent:'space-between',gap:10,flexShrink:0}},
        h('div',{style:{display:'flex',alignItems:'center',gap:8}},
          h(Ico,{name:'download',size:16,color:'var(--green)'}),
          h('span',{style:{fontSize:12,color:'var(--green)',fontWeight:600}},'Nueva version v'+globalUpdate.version+' disponible')),
        h('div',{style:{display:'flex',gap:8}},
          h('button',{onClick:function(){window.electronAPI.downloadUpdate();},style:{background:'var(--green2)',color:'#fff',border:'none',borderRadius:8,padding:'6px 14px',fontSize:11,fontWeight:600,cursor:'pointer',fontFamily:'inherit'}},'Descargar'),
          h('button',{onClick:function(){setGlobalUpdate(null);},style:{background:'none',border:'none',cursor:'pointer',padding:4,display:'flex'}},
            h(Ico,{name:'x',size:14,color:'var(--green)'})))),
      globalUpdate&&globalUpdate.status==='downloading'&&h('div',{style:{background:'var(--blue-bg)',border:'1px solid var(--blue-bd)',padding:'10px 20px',display:'flex',alignItems:'center',gap:10,flexShrink:0}},
        h(Ico,{name:'download',size:16,color:'var(--blue)'}),
        h('div',{style:{flex:1}},
          h('div',{style:{fontSize:12,color:'var(--blue)',fontWeight:600,marginBottom:4}},'Descargando actualizacion... '+(globalUpdate.percent||0)+'%'),
          h('div',{style:{background:'var(--bg3)',borderRadius:6,height:5,overflow:'hidden'}},
            h('div',{style:{width:(globalUpdate.percent||0)+'%',height:'100%',background:'var(--blue)',borderRadius:6,transition:'width .3s'}})))),
      globalUpdate&&globalUpdate.status==='downloaded'&&h('div',{style:{background:'var(--green-bg)',border:'1px solid var(--green-bd)',padding:'10px 20px',display:'flex',alignItems:'center',justifyContent:'space-between',gap:10,flexShrink:0}},
        h('div',{style:{display:'flex',alignItems:'center',gap:8}},
          h(Ico,{name:'check',size:16,color:'var(--green)'}),
          h('span',{style:{fontSize:12,color:'var(--green)',fontWeight:600}},'v'+globalUpdate.version+' lista para instalar')),
        h('button',{onClick:function(){window.electronAPI.installUpdate();},style:{background:'var(--green2)',color:'#fff',border:'none',borderRadius:8,padding:'6px 14px',fontSize:11,fontWeight:600,cursor:'pointer',fontFamily:'inherit'}},'Reiniciar e instalar')),
      h('div',{className:'main-content'},
      view==='dashboard'  && h(DashView,  {metrics:metrics,isEmpty:loans.length===0,onNav:navTo,loans:loans,pays:pays,onNameClick:openDebtorByName,onNewLoan:function(){navTo('cartera');setLoanModal('new');}}),
      view==='cartera'    && h(CarteraView,{loans:loans,pays:pays,onAdd:function(){setLoanModal('new');},onEdit:setLoanModal,onDelete:delLoan,onAbono:setAbonoModal,onForceClose:forceCloseLoan}),
      view==='deudores'   && h(DeudoresView,{deudores:deudores,pays:pays,onSelect:setDebtorModal,onAdd:function(){setLoanModal('new');}}),
      view==='pagos'      && h(PagosView,  {pays:filtPays,allPays:pays,loans:loans,searchQ:searchQ,setSearchQ:setSearchQ,fMonth:fMonth,setFMonth:setFMonth,onSelect:openPayModal,onQuickPay:quickPay,onNameClick:openDebtorByName,datosPago:cfg.datos_pago}),
      view==='rendimiento'&& h(PortfolioView,{loans:loans,pays:pays}),
      view==='calculadora'&& h(CalcView,   {onConfirm:confirmarCalc}),
      view==='historial'   && h(HistorialView,{actLog:actLog,undoLog:undoLog,onUndo:function(entry){setUndoDlg(entry);},
        onRefresh:function(){loadHistorial().then(function(){showToast('Historial actualizado');});}}),
      view==='deudas'      && h(DebtsView,{debts:debts,onReload:loadDebts,onNew:function(){setDebtModal('new');},onPay:function(d){setDebtPayModal(d);},onEdit:function(d){setDebtModal(d);},onDelete:function(d){setDebtDelete(d);},onHistory:function(d){setDebtHistory(d);}}),
      view==='desarrollador'&& h(DevView,  {showToast:showToast,isMac:isMac,onNeedsRestart:function(){setNeedsRestart(true);},onSync:recalculate,onConfirm:function(cfg){setConfirmDlg(cfg);},loans:loans,pays:pays,datosPago:cfg.datos_pago,onSaveConfig:saveConfig}))
    ), /* end main-area */
    loanModal&&h(LoanModal,{loan:loanModal==='new'?null:loanModal,trm:cfg.trm,pays:pays,clientes:deudores,onSave:saveLoan,onClose:function(){setLoanModal(null);}}),
    payModal &&h(PayModal, {pay:payModal.pay,loan:payModal.loan,allPays:pays,onMark:markPay,onPartial:markPartial,onClose:function(){setPayModal(null);}}),
    debtModal&&h(DebtModal,{debt:debtModal==='new'?null:debtModal,onSave:saveDebt,onClose:function(){setDebtModal(null);},existingAcreedores:existingAcreedores}),
    debtPayModal&&h(DebtPayModal,{debt:debtPayModal,onSave:payDebt,onClose:function(){setDebtPayModal(null);}}),
    debtHistory&&h(DebtHistoryModal,{debt:debtHistory,onClose:function(){setDebtHistory(null);}}),
    debtDelete&&h(DeleteDebtModal,{debt:debtDelete,onConfirm:function(){var id=debtDelete.id;setDebtDelete(null);deleteDebt(id);},onClose:function(){setDebtDelete(null);}}),
    abonoModal&&h(AbonoModal,{loan:abonoModal.loan||abonoModal,pays:pays,onSave:registrarAbono,onClose:function(){if(abonoModal.fromDeudor){setDebtorModal(abonoModal.fromDeudor);} setAbonoModal(null);},
      // v2.0.0 — CTA "Liquidar deuda" del AbonoModal (cuando el abono excede el capital
      // amortizable por haber capital atrapado en cuotas En Mora). Cierra el abono y abre el
      // modal de liquidacion CONSERVANDO fromDeudor, para que Cancelar devuelva al perfil.
      // No se reutiliza onClose a proposito: ese re-abriria DebtorModal encima.
      onRequestLiquidar:function(l){var fd=abonoModal&&abonoModal.fromDeudor;setAbonoModal(null);setLiquidarModal({loan:l,fromDeudor:fd});}}),
    debtorModal&&h(DebtorModal,{deudor:debtorModal,pays:pays,loans:loans,onClose:function(){setDebtorModal(null);},onNewLoan:function(d){setDebtorModal(null);setLoanModal({_prefill:{nombre:d.nombre,cedula:d.cedula,telefono:d.telefono}});},onAbono:function(l){var dRef=debtorModal;setDebtorModal(null);setAbonoModal({loan:l,fromDeudor:dRef});},onReestructurar:function(l){var dRef=debtorModal;setDebtorModal(null);setRestructureModal({loan:l,fromDeudor:dRef});},
      // v2.0.0 — el modal de liquidacion se elevo a App; aqui solo se DISPARA, con el mismo
      // patron fromDeudor de onAbono/onReestructurar (Cancelar devuelve al perfil).
      onRequestLiquidar:function(l){var dRef=debtorModal;setDebtorModal(null);setLiquidarModal({loan:l,fromDeudor:dRef});},onReload:reload}),
    // v2.0.0 — LiquidarModal a nivel App (antes vivia DENTRO de DebtorModal, por eso era
    // inalcanzable desde AbonoModal). La logica de confirmacion es la MISMA de v1.19.0:
    // registrarAbono(...,liquidar=true,...) con el mismo obs y el mismo intExtra.
    liquidarModal&&h(LiquidarModal,{loan:liquidarModal.loan,pays:pays,
      onClose:function(){if(liquidarModal.fromDeudor){setDebtorModal(liquidarModal.fromDeudor);} setLiquidarModal(null);},
      onConfirm:function(loanId,monto,intExtra){var obs='Liquidacion total'+(intExtra>0?' + intereses anticipados proximo mes: $'+Math.round(intExtra).toLocaleString('es-CO'):'');
      // v1.18.1: se devuelve la promesa para que el modal de liquidacion libere su guarda.
      // Hasta ahora la unica proteccion era accidental: setDebtorModal(null) desmontaba el
      // modal en el mismo click, y el backend rechazaba el 2o intento porque el saldo ya
      // era 0. Ninguna de las dos es una garantia — la primera se cae con cualquier refactor
      // que mantenga el modal montado, y la segunda no aplica a una liquidacion parcial.
      // Tras liquidar NO se re-abre el perfil (comportamiento identico a v1.19.0).
      var _p=registrarAbono(loanId,monto,nowStr(),obs,0,true,null,null,undefined,intExtra);setLiquidarModal(null);setDebtorModal(null);return _p;}}),
    restructureModal&&h(RestructureModal,{loan:restructureModal.loan||restructureModal,pays:pays,onSave:reestructurarPrestamo,onClose:function(){if(restructureModal.fromDeudor){setDebtorModal(restructureModal.fromDeudor);} setRestructureModal(null);}}),
    preflightDlg&&h(PreflightMoraModal,{cuotas:preflightDlg.cuotas,loan:preflightDlg.loan,onMarkMora:preflightDlg.onMarkMora,onContinue:preflightDlg.onContinue,onCancel:preflightDlg.onCancel}),
    confirmDlg&&h(ConfirmModal,Object.assign({},confirmDlg,{onCancel:function(){setConfirmDlg(null);}})),
    // "La Bestia" Fase 2 — confirmacion de deshacer, con los candados C (>24h) y D (recibo).
    undoDlg&&h(ConfirmUndoModal,{entry:undoDlg,onConfirm:confirmarUndo,onClose:function(){setUndoDlg(null);}}),
    // v1.9.x — Changelog modal con max-height + scroll interno. Header (titulo) y
    // footer (boton Entendido) quedan fijos; solo la lista de items hace scroll.
    changelogDlg&&h('div',{className:'modal-overlay',onClick:function(){setChangelogDlg(null);}},
      h('div',{className:'modal-panel',onClick:function(e){e.stopPropagation();},style:{maxWidth:380,maxHeight:'min(620px,80vh)',display:'flex',flexDirection:'column'}},
        // Header fijo (handle + icono + titulo)
        h('div',{style:{flexShrink:0}},
          h('div',{className:'modal-handle'}),
          h('div',{style:{textAlign:'center',marginBottom:14}},
            h('div',{style:{marginBottom:6}},h(Ico,{name:'sparkle',size:28,color:'var(--green)'})),
            h('div',{style:{fontWeight:700,fontSize:17,color:'var(--text)'}},'Novedades de la version '+changelogDlg.version),
            h('div',{style:{fontSize:11,color:'var(--text3)',marginTop:4,fontStyle:'italic'}},changelogDlg.items.length+' '+(changelogDlg.items.length===1?'cambio':'cambios')))),
        // Cuerpo scrolleable (la lista de items)
        h('div',{style:{flex:'1 1 auto',minHeight:0,overflowY:'auto',marginBottom:14,paddingRight:6,borderTop:'1px solid var(--border)',borderBottom:'1px solid var(--border)',paddingTop:6,paddingBottom:6}},
          changelogDlg.items.map(function(item,i){
            return h('div',{key:i,style:{display:'flex',alignItems:'flex-start',gap:8,padding:'7px 0',fontSize:13,color:'var(--text2)',lineHeight:1.45}},
              h('div',{style:{flexShrink:0,marginTop:2}},h(Ico,{name:'check',size:14,color:'var(--green)',sw:2.4})),
              h('span',null,item));
          })),
        // Footer fijo (boton)
        h('button',{onClick:function(){setChangelogDlg(null);},style:{flexShrink:0,width:'100%',padding:'10px 0',background:'var(--green2)',color:'#fff',border:'none',borderRadius:10,fontWeight:700,fontSize:14,cursor:'pointer',fontFamily:'inherit'}},'Entendido'))),
    errorDlg&&h('div',{className:'modal-overlay',onClick:function(){setErrorDlg(null);}},
      h('div',{className:'modal-panel',onClick:function(e){e.stopPropagation();},style:{maxWidth:400}},
        h('div',{className:'modal-handle'}),
        h('div',{style:{textAlign:'center',marginBottom:14}},
          h('div',{style:{marginBottom:6}},h(Ico,{name:'alert',size:28,color:'var(--yellow)'})),
          h('div',{style:{fontWeight:700,fontSize:17,color:'var(--yellow)'}},errorDlg.title||'Error')),
        h('div',{style:{marginBottom:16}},
          errorDlg.messages.map(function(msg,i){
            return h('div',{key:i,style:{padding:'8px 12px',marginBottom:6,background:'var(--yellow-bg)',border:'1px solid var(--yellow)',borderRadius:8,fontSize:13,color:'var(--text)',whiteSpace:'pre-wrap'}},msg);
          })),
        h('button',{onClick:function(){setErrorDlg(null);},style:{width:'100%',padding:'10px 0',background:'var(--bg4)',color:'var(--text)',border:'1px solid var(--border)',borderRadius:10,fontWeight:700,fontSize:14,cursor:'pointer'}},'Entendido'))),
    gSearch&&h('div',{className:'gsearch-overlay',onClick:closeGSearch},
      h('div',{className:'gsearch-box',onClick:function(e){e.stopPropagation();}},
        h('div',{style:{position:'relative'}},
          h('div',{style:{position:'absolute',left:14,top:'50%',transform:'translateY(-50%)',display:'flex'}},h(Ico,{name:'search',size:16,color:'var(--green)'})),
          h('input',{className:'gsearch-input',value:gQ,onChange:function(e){setGQ(e.target.value);},placeholder:'Buscar cliente, prestamo, pago...',autoFocus:true})),
        gResults.length>0&&h('div',{className:'gsearch-results'},
          gResults.map(function(r,i){
            var catColor=r.type==='deudor'?'var(--blue)':r.type==='prestamo'?'var(--green)':'var(--yellow)';
            var catBg=r.type==='deudor'?'var(--blue-bg)':r.type==='prestamo'?'var(--green-bg)':'var(--yellow-bg)';
            var catLabel=r.type==='deudor'?'DEUDOR':r.type==='prestamo'?'PRESTAMO':'PAGO';
            return h('div',{key:i,className:'gsearch-item',onClick:function(){
              closeGSearch();
              if(r.type==='deudor') setDebtorModal(r.data);
              else if(r.type==='prestamo'){navTo('cartera');}
              else if(r.type==='pago') openPayModal(r.data);
            }},
              h('span',{className:'gsearch-cat',style:{background:catBg,color:catColor}},catLabel),
              h('div',{style:{flex:1,minWidth:0}},
                h('div',{style:{fontSize:13,fontWeight:600,color:'var(--text)',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}},r.label),
                h('div',{style:{fontSize:11,color:'var(--text3)',marginTop:1}},r.sub)));
          })),
        gQ.length>=2&&gResults.length===0&&h('div',{style:{padding:'20px 16px',textAlign:'center',color:'var(--text3)',fontSize:12}},'Sin resultados para "'+gQ+'"'))),
    toast&&h('div',{className:'toast'+(toast.out?' out':''),style:{background:toast.type==='error'?'var(--red-bg)':'var(--green-bg)',border:'1px solid '+(toast.type==='error'?'var(--red-bd)':'var(--green-bd)'),color:toast.type==='error'?'var(--red)':'var(--green)'}},toast.msg),
    needsRestart&&h('div',{style:{position:'fixed',inset:0,background:'rgba(0,0,0,.92)',display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',zIndex:999,backdropFilter:'blur(8px)'}},
      h(Ico,{name:'refresh-cw',size:40,color:'var(--green)'}),
      h('div',{style:{fontSize:18,fontWeight:700,color:'var(--text)',marginTop:16,marginBottom:8}},'Ruta actualizada'),
      h('div',{style:{fontSize:13,color:'var(--text3)',marginBottom:24,textAlign:'center',padding:'0 40px'}},'Debes reiniciar la app para usar la nueva ubicacion de la base de datos.'),
      h('button',{onClick:function(){if(window.electronAPI) window.electronAPI.relaunch();},style:{background:'var(--green)',color:'#fff',border:'none',borderRadius:12,padding:'14px 48px',fontSize:15,fontWeight:700,cursor:'pointer',fontFamily:'inherit'}},'Reiniciar')));
}










// ── PreflightMoraModal (v1.9.0) ───────────────────────────────────────────────
// Modal de advertencia previo a abono/reestructurar cuando hay cuotas Pendientes
// con fechaPago - hoy <= 5 dias. El usuario elige: marcar en mora (preservar como
// deuda independiente), continuar sin marcar (se absorben), o cancelar.
//
// Helper: detecta cuotas en riesgo (fechaPago entre hoy y hoy+5 dias, estadoPago=Pendiente,
// y NO es un registro de abono).
function _cuotasEnRiesgo(allPays,loanId){
  var hoy=new Date(nowStr()+'T12:00:00').getTime();
  var limite=hoy+5*24*60*60*1000;
  return allPays.filter(function(p){
    if(String(p.prestamoId)!==String(loanId)) return false;
    if(p.estadoPago!=='Pendiente') return false;
    if(esAbono(p)) return false;
    var t=new Date(p.fechaPago+'T12:00:00').getTime();
    return t>=hoy&&t<=limite;
  }).sort(function(a,b){return a.cuotaN-b.cuotaN;});
}
















createRoot(document.getElementById('root')).render(h(App,null));
