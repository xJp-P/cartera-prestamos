// public/js/modales/AbonoModal.js — Abono a capital, con techo `saldoAbonable` y doble entrada en USD.
//
// Extraido de `app.js` en la Etapa 3 (B7) del refactor. Codigo VERBATIM.
//
// El estado global sigue en `App` y baja por PROPS; los callbacks suben igual.
// Sin Context API y sin store.

import { Fld, Modal } from '../componentes/base.js';
import { Ico } from '../componentes/iconos.js';
import { showError } from '../core/api.js';
import { _nper, _pmt, _tasaPeriodo } from '../core/calculo.js';
import { computeLiquidacion, saldoConCaja } from '../core/dominio.js';
import {
  copToUsd, fmt, fmtN, fmtNumInput, parseDecimalInput, parseIntInput, parseNum,
} from '../core/format.js';
import { h, useState } from '../core/react.js';
import { _submitGuard, nowStr } from '../core/ui.js';

export function AbonoModal(props){
  var loan=props.loan,allPays=props.pays||[],onSave=props.onSave,onClose=props.onClose,onRequestLiquidar=props.onRequestLiquidar;
  var esUSD=loan.moneda==='USD';
  var esCapInt=loan.modalidad==='Capital + Intereses';
  var s1=useState(''); var monto=s1[0]; var setMonto=s1[1];
  var s2=useState(nowStr()); var fecha=s2[0]; var setFecha=s2[1];
  var s3=useState(''); var obs=s3[0]; var setObs=s3[1];
  var s4=useState(''); var montoUSD=s4[0]; var setMontoUSD=s4[1];
  var s4b=useState(''); var copRecibido=s4b[0]; var setCopRecibido=s4b[1];       // v2.0.0: COP realmente recibidos (solo USD)
  var sRec=useState(true); var genRecibo=sRec[0]; var setGenRecibo=sRec[1];      // v1.17.1: PDF opcional
  var sSend=useState(false); var sending=sSend[0]; var setSending=sSend[1];      // v1.17.1: guarda anti doble-submit
  // Opciones de recalculo (solo para Capital + Intereses)
  var sm=useState('mantener'); var recalcMode=sm[0]; var setRecalcMode=sm[1];
  var sp=useState(''); var nuevoPlazo=sp[0]; var setNuevoPlazo=sp[1];
  var sc=useState(''); var nuevaCuotaFija=sc[0]; var setNuevaCuotaFija=sc[1];
  var scu=useState(''); var nuevaCuotaFijaUSD=scu[0]; var setNuevaCuotaFijaUSD=scu[1];
  // Cuota fija efectiva en COP (la que se usa para calcular). Para USD se deriva de USD x trmAcordada.
  var cuotaFijaEfectivaCOP=esUSD?Math.round((+nuevaCuotaFijaUSD||0)*(+loan.trmAcordada||1)):(+nuevaCuotaFija||0);
  var originalCOP=esUSD?Math.round(loan.montoOrigen*loan.trmAcordada):Math.round(loan.montoOrigen);
  var loanPays=allPays.filter(function(p){return String(p.prestamoId)===String(loan.id);});
  var todoCapPagado=loanPays.filter(function(p){return p.estadoPago==='Pagado';}).reduce(function(s,p){return s+p.abonoCapital;},0);
  var saldoActual=Math.max(0,originalCOP-todoCapPagado);
  var intMora=loanPays.filter(function(p){return p.estadoPago==='En Mora'&&p.id.indexOf('-ab-')===-1;}).reduce(function(s,p){return s+p.interesPeriodo;},0);
  // ── v2.0.0 — TECHO REAL DEL ABONO: espejo EXACTO del saldoReal que se computa dentro de POST /api/loans/:id/abono ──
  // saldoActual (identico al capitalPendienteLiq del backend) es TODO el capital que se debe:
  // el del cronograma futuro MAS el atrapado en cuotas En Mora. Pero un abono normal (no
  // liquidacion) solo puede tocar el capital FUTURO: el backend valida contra saldoReal, que SI
  // resta el capital En Mora (deuda independiente amortizada aparte, Bug #21). Sin este espejo el
  // modal aceptaba montos en la ventana (saldoReal, capitalPendienteLiq] que el backend rechazaba
  // con 400 "El abono supera el saldo actual" — el usuario pagaba justo lo que la pantalla decia.
  // Prestamo / Pago Unico (esSingleCuota) NO restan su mora: alli abonoCapital ES el saldo vivo.
  var esSingleCuota=loan.modalidad==='Prestamo'||loan.modalidad==='Pago Unico';
  var moraRows=loanPays.filter(function(p){return p.estadoPago==='En Mora';}); // sin filtro '-ab-': espejo del backend
  var moraCap=moraRows.reduce(function(s,p){return s+p.abonoCapital;},0);
  var moraCount=moraRows.filter(function(p){return p.id.indexOf('-ab-')===-1;}).length;
  var saldoAbonable=esSingleCuota?Math.max(0,originalCOP-todoCapPagado):Math.max(0,originalCOP-todoCapPagado-moraCap);
  var capEnMora=Math.max(0,saldoActual-saldoAbonable); // capital que solo se cobra liquidando o pagando esas cuotas
  // v2.3.0 — puente con el saldo que muestra el perfil. `saldoActual` es capital CONTRACTUAL
  // (no baja con parciales); `saldoCajaModal` es el mismo capital con la caja ya aplicada. Su
  // diferencia ES, por algebra, el capital imputado de los parciales que siguen en curso: en las
  // cuotas Pagadas el capital imputado coincide con `abonoCapital`, asi que solo sobreviven las
  // no Pagadas. Ambas son de PRESENTACION; el techo del abono no depende de esto.
  var saldoCajaModal=saldoConCaja(loan,loanPays);
  var capImputadoVivo=Math.max(0,saldoActual-saldoCajaModal);
  var parcialVivo=loanPays.filter(function(p){return p.id.indexOf('-ab-')===-1&&p.estadoPago!=='Pagado';})
    .reduce(function(s,p){return s+(p.partialPaid||0);},0);
  var liquidacion=computeLiquidacion(loan,loanPays,{}).total; // v1.19.0: helper centralizado
  // ── v2.0.0 — DOBLE ENTRADA OBLIGATORIA EN PRESTAMOS USD ──────────────────────────────
  // La deuda esta denominada en DOLARES y el ledger la lleva en COP a la TRM PACTADA
  // (originalCOP = montoOrigen x trmAcordada). Por eso el CAPITAL que se descuenta lo manda el
  // campo USD:  montoCapCOP = montoUSD x trmAcordada.
  // Los COP realmente recibidos NO tocan el capital (dependen de la TRM del dia): son la caja
  // real y sirven para medir el efecto TRM. Usar los COP de caja como capital descontaria de
  // MENOS cuando la TRM baja y dejaria capital fantasma vivo pese a que el cliente ya entrego
  // todos los dolares pactados (misma doctrina del pago bimonetario, Bug #23).
  var copRecNum=Math.round(+copRecibido||0);
  // Techo expresado en dolares. Como el usuario teclea USD con 2 decimales, redondear
  // (usd x trm) casi nunca da EXACTAMENTE saldoAbonable: sobrarian unos pesos de capital
  // fantasma que impedirian dejar el capital futuro en cero. Si el USD tecleado ES el techo
  // (tolerancia de medio centavo, misma doctrina que completaUSD en /partial), el capital se
  // ancla al techo exacto. Por encima de esa tolerancia NO se ancla, para que excedeAbonable
  // siga disparando el CTA de liquidacion en vez de capar el monto en silencio.
  var techoUSD=(esUSD&&+loan.trmAcordada>0)?Math.round(saldoAbonable/(+loan.trmAcordada)*100)/100:0;
  var cubreTechoUSD=esUSD&&(+montoUSD>0)&&Math.abs((+montoUSD)-techoUSD)<0.005;
  var montoCapCOP=esUSD
    ?(cubreTechoUSD?saldoAbonable:Math.round((+montoUSD||0)*(+loan.trmAcordada||0)))
    :Math.round(+monto||0);
  var trmImplicita=(esUSD&&(+montoUSD||0)>0&&copRecNum>0)?Math.round(copRecNum/(+montoUSD)):0;
  var efectoTRM=(esUSD&&copRecNum>0&&montoCapCOP>0)?copRecNum-montoCapCOP:0;
  // El backend recalcula desde (saldoReal - monto) -> el preview debe partir de saldoAbonable.
  var saldoTras=saldoAbonable-montoCapCOP;
  var saldoUSDTras=esUSD?saldoTras/loan.trmAcordada:0;
  // Monto que supera el techo real pero sigue dentro del capital total: no es un error del
  // usuario, es dinero que corresponde a la LIQUIDACION -> se ofrece el CTA en vez de un 400.
  var excedeAbonable=montoCapCOP>saldoAbonable;
  var ctaLiquidar=excedeAbonable&&capEnMora>0;
  // Cuotas regulares ya consumidas (pagadas + en mora, excluyendo abonos)
  var regulares=loanPays.filter(function(p){return p.id.indexOf('-ab-')===-1;});
  var regularConsumed=regulares.filter(function(p){return p.estadoPago==='Pagado'||p.estadoPago==='En Mora';}).length;
  var plazoOriginal=+loan.plazoMeses||12;
  var cuotasRestantesActuales=Math.max(1,plazoOriginal-regularConsumed);
  // Preview en vivo de la opcion seleccionada
  var preview=function(){
    if(!esCapInt||montoCapCOP<=0||saldoTras<=0) return null;
    var r=_tasaPeriodo((+loan.tasaMensual||0)/100,loan.frecuencia||'Mensual');
    var interesPrimerPeriodo=Math.round(saldoTras*r);
    if(recalcMode==='mantener'){
      var n=cuotasRestantesActuales;
      var pmtVal=Math.round(_pmt(r,n,saldoTras));
      return {modo:'mantener',cuota:pmtVal,nCuotas:n,interesP:interesPrimerPeriodo,error:null,ultimaResidual:0};
    }
    if(recalcMode==='modificarPlazo'){
      var nN=parseInt(nuevoPlazo,10);
      if(!nN||nN<1) return {modo:'modificarPlazo',cuota:0,nCuotas:0,interesP:interesPrimerPeriodo,error:'Ingresa un numero de cuotas valido (>= 1).',ultimaResidual:0};
      var pmtMod=Math.round(_pmt(r,nN,saldoTras));
      return {modo:'modificarPlazo',cuota:pmtMod,nCuotas:nN,interesP:interesPrimerPeriodo,error:null,ultimaResidual:0};
    }
    if(recalcMode==='fijarCuota'){
      var pmtFijo=cuotaFijaEfectivaCOP;
      if(pmtFijo<=0) return {modo:'fijarCuota',cuota:0,nCuotas:0,interesP:interesPrimerPeriodo,error:'Ingresa una cuota valida (> 0).',ultimaResidual:0};
      if(pmtFijo<=interesPrimerPeriodo) return {modo:'fijarCuota',cuota:pmtFijo,nCuotas:0,interesP:interesPrimerPeriodo,error:'La cuota debe ser mayor a '+fmt(interesPrimerPeriodo)+(esUSD?' ('+copToUsd(interesPrimerPeriodo,loan.trmAcordada)+')':'')+' que son los intereses del primer periodo. Con esta cuota nunca se saldaria la deuda.',ultimaResidual:0};
      var nCalc=_nper(r,pmtFijo,saldoTras);
      var nEnt=Math.ceil(nCalc);
      // Calcular saldo despues de (nEnt - 1) cuotas iguales para conocer la ultima residual
      var sR=saldoTras,resid=0;
      for(var i=0;i<nEnt-1;i++){var intI=sR*r;var capI=pmtFijo-intI;sR=sR-capI;}
      if(sR>0){resid=Math.round((sR+sR*r)*100)/100;}
      return {modo:'fijarCuota',cuota:pmtFijo,nCuotas:nEnt,interesP:interesPrimerPeriodo,error:null,ultimaResidual:resid};
    }
    return null;
  }();
  function submit(){
    // v1.17.1 — GUARDA ANTI DOBLE-SUBMIT. Sin esto, dos clicks (o un doble evento) disparaban
    // dos POST /abono con ~60 ms de diferencia y el backend, que es atomico pero NO idempotente,
    // aplicaba el abono DOS VECES (bug detectado en produccion el 18-jul-2026).
    if(sending) return;
    // v2.0.0 — USD exige DOS entradas: los dolares definen el capital, los COP la caja real.
    if(esUSD){
      if(!(+montoUSD>0)){showError('Ingresa el monto del abono en USD (define el capital que se descuenta)');return;}
      if(!(copRecNum>0)){showError('Ingresa los COP realmente recibidos (miden el efecto de la TRM)');return;}
    } else if(!monto||+monto<=0){showError('Ingresa un monto valido');return;}
    // v2.0.0 — el techo es saldoAbonable (capital del cronograma futuro), NO saldoActual.
    // Defense-in-depth: el boton ya se deshabilita, pero si algo fallara el submit tampoco
    // debe enviar un monto que el backend rechazaria con 400.
    if(montoCapCOP>saldoAbonable){
      var _techo=esUSD?copToUsd(saldoAbonable,loan.trmAcordada):fmt(saldoAbonable);
      var _mora=esUSD?copToUsd(capEnMora,loan.trmAcordada):fmt(capEnMora);
      showError(capEnMora>0
        ?'El abono maximo a capital es '+_techo+'. Los '+_mora+' restantes estan en '+moraCount+' cuota'+(moraCount!==1?'s':'')+' en mora: se cobran liquidando la deuda o pagando esas cuotas.'
        :'El abono maximo es '+_techo+' (solo capital). Los intereses en mora se cobran por separado.');
      return;
    }
    if(esCapInt&&preview&&preview.error){showError(preview.error);return;}
    var mode=esCapInt?recalcMode:null;
    var valor=null;
    if(mode==='modificarPlazo') valor=parseInt(nuevoPlazo,10);
    else if(mode==='fijarCuota') valor=cuotaFijaEfectivaCOP; // siempre en COP (auto-conv de USD)
    // v1.18.1: se delega en el helper compartido _submitGuard (misma semantica que tenia
    // aqui inline). Se libera al resolver, al rechazar o si onSave no devuelve promesa
    // (rama de pre-flight); en exito el modal ya se desmonto.
    // v2.0.0 — se envia el CAPITAL en COP a TRM pactada (montoCapCOP) y, aparte, la caja real
    // (copRecNum) para que el backend registre el desfase cambiario sin tocar el capital.
    _submitGuard(sending,setSending,function(){return onSave(loan.id,montoCapCOP,fecha,obs,+montoUSD||0,false,mode,valor,genRecibo,undefined,esUSD?copRecNum:0);});
  }
  // v2.0.0 — el boton se apaga cuando el monto excede el capital amortizable (alli la accion
  // correcta es el CTA de liquidacion, no forzar un POST que el backend va a rechazar) y, en
  // prestamos USD, mientras falte cualquiera de las dos entradas obligatorias.
  var faltanCamposUSD=esUSD&&(!(+montoUSD>0)||!(copRecNum>0));
  var btnOff=(esCapInt&&preview&&!!preview.error)||excedeAbonable||faltanCamposUSD||sending;
  // El rojo se reserva para "el prestamo quedaria SALDADO". Cubrir todo el capital amortizable
  // dejando mora viva es un estado NORMAL, no una alarma -> ambar.
  var lineaSaldoTras=montoCapCOP>0&&!excedeAbonable&&h('div',{style:{fontSize:11,marginTop:4,fontFamily:'monospace',color:saldoTras<=0?(capEnMora>0?'var(--yellow)':'var(--red)'):'var(--text2)'}},
    saldoTras<=0
      ?(capEnMora>0
          ?'Cubre todo el capital amortizable ('+(moraCount===1?'queda 1 cuota':'quedan '+moraCount+' cuotas')+' en mora)'
          :'El prestamo quedaria SALDADO')
      :'Saldo tras abono: '+fmt(saldoTras)+(esUSD?' ('+copToUsd(saldoTras,loan.trmAcordada)+')':''));
  return h(Modal,{onClose:onClose},
    h('div',{style:{fontWeight:700,fontSize:16,color:'var(--text)',marginBottom:4}},'Abono a Capital'),
    h('div',{style:{background:'var(--bg3)',borderRadius:12,padding:'13px 14px',marginBottom:16,border:'1px solid var(--border)'}},
      h('div',{style:{fontWeight:700,fontSize:14,color:'var(--text)'}},loan.nombre),
      h('div',{style:{fontSize:12,color:'var(--text2)',marginTop:3}},loan.modalidad),
      h('div',{className:'mono',style:{fontWeight:700,fontSize:18,color:'var(--green)',marginTop:6}},'Saldo actual: '+fmt(saldoActual),
        esUSD&&h('span',{style:{fontSize:13,fontWeight:600,color:'var(--blue)',marginLeft:8}},copToUsd(saldoActual,loan.trmAcordada))),
      // v2.0.0 — cuando hay capital atrapado en mora, "Saldo actual" (capital total) y el techo
      // del abono NO coinciden: se desglosa para que el numero del tope no parezca arbitrario.
      capEnMora>0&&h('div',{style:{fontSize:11,color:'var(--text3)',marginTop:4}},
        'Abonable a capital: ',h('span',{className:'mono',style:{fontWeight:700,color:'var(--text2)'}},fmt(saldoAbonable)),
        '  •  en mora: ',h('span',{className:'mono',style:{fontWeight:700,color:'var(--yellow)'}},fmt(capEnMora))),
      // v2.3.0 — "Saldo actual" es el capital CONTRACTUAL (base del motor): no baja con un pago
      // parcial, porque un parcial no re-amortiza. El perfil del deudor, en cambio, ya muestra el
      // saldo CON CAJA APLICADA. Mientras un parcial esta en vuelo y ya supero el interes del
      // periodo, las dos cifras difieren por el capital imputado y sin esta linea pareceria una
      // inconsistencia. NO se toca `saldoActual`: alimenta `capEnMora` (desglose de la mora) y
      // el techo del abono sigue siendo el espejo exacto del backend (Bug #36).
      capImputadoVivo>0&&h('div',{style:{fontSize:11,color:'var(--text3)',marginTop:4,lineHeight:1.5}},
        'Abonado en curso: ',h('span',{className:'mono',style:{fontWeight:700,color:'var(--blue)'}},fmt(parcialVivo)),
        ' (',fmt(capImputadoVivo),' a capital)',
        h('div',null,'Saldo con esos pagos aplicados: ',
          h('span',{className:'mono',style:{fontWeight:700,color:'var(--text2)'}},fmt(saldoCajaModal)),
          h('span',{style:{color:'var(--text3)'}},' — es el que ves en el perfil'))),
      intMora>0&&h('div',{className:'mono',style:{fontSize:13,color:'var(--yellow)',marginTop:4}},'Valor de liquidacion: '+fmt(liquidacion)+(esUSD?' '+copToUsd(liquidacion,loan.trmAcordada):''),
        h('div',{style:{fontSize:10,color:'var(--text3)',fontFamily:'var(--font)',marginTop:1}},'(incluye intereses en mora)'))),
    function(){
      var hayMora=intMora>0;
      var esPrestamo=loan.modalidad==='Prestamo';
      var esPagoUnicoLocal=loan.modalidad==='Pago Unico'; // v1.10.0
      var esIntereses=loan.modalidad==='Intereses';
      var titulo,partes;
      if(hayMora&&esPrestamo){
        titulo='Como se aplica este abono';
        partes=[
          {t:'Este abono reduce directamente el saldo del prestamo.'},
          {t:'La cuota en mora se actualiza automaticamente al nuevo saldo (porque es un prestamo sin interes).'}
        ];
      } else if(hayMora&&esPagoUnicoLocal){
        titulo='Como se aplica este abono';
        partes=[
          {t:'Este abono reduce el capital del prestamo.'},
          {t:'La ganancia pactada NO cambia: se conserva al mismo monto y se cobra junto con el capital restante en la fecha de pago.'},
          {t:'La cuota en mora se actualiza al nuevo saldo (capital + ganancia pactada).'}
        ];
      } else if(hayMora&&!esPrestamo){
        titulo='Como se aplica este abono';
        partes=[
          {t:'El monto se aplica 100% al ',b:'capital pendiente',t2:'. NO descuenta intereses en mora.'},
          {t:'Los intereses en mora ('+fmt(intMora)+') quedan como deuda independiente.'},
          {t:'Para cobrar la mora usa el boton ',b:'Liquidar deuda',t2:' o paga cada cuota desde la seccion Pagos.'}
        ];
      } else if(!hayMora&&esIntereses){
        titulo='Como se aplica este abono';
        partes=[
          {t:'El monto reduce el ',b:'capital pendiente',t2:' del prestamo.'},
          {t:'Las proximas cuotas de interes se calcularan sobre el nuevo saldo, por lo que el interes mensual baja.'}
        ];
      } else {
        titulo='Como se aplica este abono';
        partes=[
          {t:'El monto reduce el ',b:'capital pendiente',t2:' del prestamo.'},
          {t:'Las cuotas futuras se recalculan automaticamente sobre el nuevo saldo.'}
        ];
      }
      return h('div',{style:{background:'rgba(88,166,255,.06)',border:'1px solid var(--blue-bd)',borderRadius:12,padding:'10px 12px',marginBottom:12,marginTop:-8}},
        h('div',{style:{fontSize:10,fontWeight:700,color:'var(--blue)',letterSpacing:.5,marginBottom:6,display:'flex',alignItems:'center',gap:5}},
          h(Ico,{name:'alert',size:11,color:'var(--blue)',sw:2.4}),titulo.toUpperCase()),
        partes.map(function(p,i){
          return h('div',{key:i,style:{fontSize:11,color:'var(--text2)',lineHeight:1.5,marginTop:i>0?4:0,paddingLeft:10,position:'relative'}},
            h('span',{style:{position:'absolute',left:0,top:0,color:'var(--blue)'}},'•'),
            p.t,
            p.b&&h('span',{style:{fontWeight:700,color:'var(--text)'}},p.b),
            p.t2);
        }));
    }(),
    // ── v2.0.0 — ENTRADA DEL ABONO ───────────────────────────────────────────────────
    // USD: DOBLE ENTRADA OBLIGATORIA. Los dolares definen el capital (a TRM pactada) y los COP
    // la caja real del dia; su diferencia es el efecto TRM, que antes era imposible de registrar
    // porque el unico campo (COP) hacia las dos veces. COP: campo unico de siempre.
    esUSD
      ?h('div',{style:{background:'rgba(63,185,80,.08)',border:'1px solid var(--green-bd)',borderRadius:12,padding:'10px 12px',marginBottom:4}},
        h(Fld,{label:'Monto del abono (USD) *'},
          h('input',{type:'text',inputMode:'decimal',value:montoUSD,onChange:function(e){setMontoUSD(parseDecimalInput(e.target.value));},placeholder:'Ej: 250.00',className:'inp',style:{border:'1px solid var(--green)'}}),
          h('div',{style:{fontSize:11,marginTop:3,color:'var(--text3)'}},
            (+montoUSD>0)
              ?'Descuenta '+fmt(montoCapCOP)+' de capital (TRM pactada $'+fmtN(loan.trmAcordada)+')'
              :'Define el capital que se descuenta. Maximo '+copToUsd(saldoAbonable,loan.trmAcordada))),
        h(Fld,{label:'COP realmente recibidos *'},
          h('input',{type:'text',inputMode:'numeric',value:fmtNumInput(copRecibido),onChange:function(e){setCopRecibido(parseNum(e.target.value));},placeholder:'0',className:'inp',style:{border:'1px solid var(--green)'}}),
          h('div',{style:{fontSize:11,marginTop:3,color:'var(--text3)'}},'Caja real del dia. No altera el capital: mide el efecto de la TRM.')),
        trmImplicita>0&&h('div',{style:{fontSize:11,marginTop:7,paddingTop:7,borderTop:'1px solid var(--bg3)',color:efectoTRM<0?'var(--red)':'var(--green)'}},
          'TRM implicita $'+fmtN(trmImplicita)+' vs pactada $'+fmtN(loan.trmAcordada)+'  →  efecto TRM '+(efectoTRM>=0?'+':'-')+fmt(Math.abs(efectoTRM))),
        lineaSaldoTras)
      :h('div',{style:{background:'rgba(63,185,80,.08)',border:'1px solid var(--green-bd)',borderRadius:12,padding:'10px 12px',marginBottom:4}},
        h(Fld,{label:'Monto del abono (COP) *'},
          h('input',{type:'text',inputMode:'numeric',value:fmtNumInput(monto),onChange:function(e){setMonto(parseNum(e.target.value));},placeholder:'0',className:'inp',style:{border:'1px solid var(--green)'}}),
          lineaSaldoTras)),
    // ── v2.0.0 — CTA "Liquidar deuda" ────────────────────────────────────────────
    // El monto excede el capital amortizable porque hay capital atrapado en cuotas En Mora.
    // Antes este monto viajaba al backend y rebotaba con un 400 criptico ("El abono supera el
    // saldo actual") aunque el usuario pagara justo lo que la pantalla decia que debia. Ahora
    // se explica el porque y se ofrece la herramienta correcta: la liquidacion, que SI cobra
    // capital futuro + capital en mora + intereses de mora en un solo movimiento.
    ctaLiquidar&&h('div',{style:{background:'var(--yellow-bg)',border:'1px solid var(--yellow)',borderRadius:12,padding:'12px 13px',marginTop:8,marginBottom:4}},
      h('div',{style:{fontSize:10,fontWeight:700,color:'var(--yellow)',letterSpacing:.5,marginBottom:7,display:'flex',alignItems:'center',gap:5}},
        h(Ico,{name:'alert',size:11,color:'var(--yellow)',sw:2.4}),'ESE MONTO SUPERA EL ABONO A CAPITAL'),
      h('div',{style:{fontSize:11,color:'var(--text2)',lineHeight:1.55}},
        'Un abono solo reduce el capital del cronograma futuro, que hoy es ',
        h('span',{style:{fontWeight:700,color:'var(--text)'}},fmt(saldoAbonable)),
        '. Los ',
        h('span',{style:{fontWeight:700,color:'var(--text)'}},fmt(capEnMora)),
        ' restantes estan en ',
        h('span',{style:{fontWeight:700,color:'var(--text)'}},moraCount+' cuota'+(moraCount!==1?'s':'')+' en mora'),
        ', que se cobran aparte junto con sus intereses.'),
      h('div',{style:{fontSize:11,color:'var(--text3)',lineHeight:1.5,marginTop:7}},
        'Para cobrar todo de una vez usa la liquidacion (capital + intereses en mora):'),
      onRequestLiquidar&&h('button',{onClick:function(){onRequestLiquidar(loan);},style:{width:'100%',marginTop:9,padding:'10px 12px',borderRadius:10,fontSize:13,fontWeight:700,cursor:'pointer',display:'flex',alignItems:'center',justifyContent:'center',gap:8,fontFamily:'inherit',background:'transparent',border:'1px solid var(--yellow)',color:'var(--yellow)',transition:'all .15s'}},
        h(Ico,{name:'dollar',size:14,color:'var(--yellow)',sw:2.4}),'Liquidar deuda ('+(esUSD?copToUsd(liquidacion,loan.trmAcordada):fmt(liquidacion))+')')),
    // ── OPCIONES DE RECALCULO (solo Capital + Intereses y con monto válido) ──
    esCapInt&&montoCapCOP>0&&saldoTras>0&&h('div',{style:{background:'rgba(88,166,255,.04)',border:'1px solid var(--blue-bd)',borderRadius:12,padding:'12px',marginTop:4,marginBottom:4}},
      h('div',{style:{fontSize:10,fontWeight:700,color:'var(--blue)',letterSpacing:.5,marginBottom:8,display:'flex',alignItems:'center',gap:5}},
        h(Ico,{name:'calc',size:11,color:'var(--blue)'}),' OPCIONES DE RECALCULO'),
      // Radio: Mantener plazo
      h('label',{style:{display:'flex',alignItems:'flex-start',gap:8,padding:'6px 0',cursor:'pointer'}},
        h('input',{type:'radio',name:'recalcMode',value:'mantener',checked:recalcMode==='mantener',onChange:function(){setRecalcMode('mantener');},style:{marginTop:2,accentColor:'var(--blue)',cursor:'pointer'}}),
        h('div',{style:{flex:1}},
          h('div',{style:{fontSize:12,color:'var(--text)',fontWeight:500}},'Mantener plazo (default)'),
          h('div',{style:{fontSize:10,color:'var(--text3)',marginTop:1}},'Conserva las '+cuotasRestantesActuales+' cuota'+(cuotasRestantesActuales!==1?'s':'')+' restantes. La cuota mensual baja.'))),
      // Radio: Modificar plazo
      h('label',{style:{display:'flex',alignItems:'flex-start',gap:8,padding:'6px 0',cursor:'pointer'}},
        h('input',{type:'radio',name:'recalcMode',value:'modificarPlazo',checked:recalcMode==='modificarPlazo',onChange:function(){setRecalcMode('modificarPlazo');},style:{marginTop:2,accentColor:'var(--blue)',cursor:'pointer'}}),
        h('div',{style:{flex:1}},
          h('div',{style:{fontSize:12,color:'var(--text)',fontWeight:500}},'Modificar plazo'),
          h('div',{style:{fontSize:10,color:'var(--text3)',marginTop:1}},'Tu eliges el nuevo numero de cuotas restantes.'),
          recalcMode==='modificarPlazo'&&h('input',{type:'text',inputMode:'numeric',value:nuevoPlazo,onChange:function(e){setNuevoPlazo(parseIntInput(e.target.value));},placeholder:'Ej: '+cuotasRestantesActuales,className:'inp',style:{marginTop:6,fontSize:13,border:'1px solid var(--blue)'}}))),
      // Radio: Fijar cuota
      h('label',{style:{display:'flex',alignItems:'flex-start',gap:8,padding:'6px 0',cursor:'pointer'}},
        h('input',{type:'radio',name:'recalcMode',value:'fijarCuota',checked:recalcMode==='fijarCuota',onChange:function(){setRecalcMode('fijarCuota');},style:{marginTop:2,accentColor:'var(--blue)',cursor:'pointer'}}),
        h('div',{style:{flex:1}},
          h('div',{style:{fontSize:12,color:'var(--text)',fontWeight:500}},'Fijar valor de cuota'),
          h('div',{style:{fontSize:10,color:'var(--text3)',marginTop:1}},'Tu eliges cuanto pagar de cuota; el plazo se ajusta.'),
          recalcMode==='fijarCuota'&&(esUSD
            ?h('div',{style:{marginTop:6}},
                h('input',{type:'text',inputMode:'decimal',value:nuevaCuotaFijaUSD,onChange:function(e){setNuevaCuotaFijaUSD(parseDecimalInput(e.target.value));},placeholder:'Cuota en USD (ej: 50.00)',className:'inp',style:{fontSize:13,border:'1px solid var(--blue)'}}),
                (+nuevaCuotaFijaUSD)>0&&h('div',{style:{fontSize:11,marginTop:4,color:'var(--text3)',fontFamily:'monospace'}},'Equivale a '+fmt(cuotaFijaEfectivaCOP)+' COP (TRM $'+fmtN(loan.trmAcordada)+')'))
            :h('input',{type:'text',inputMode:'numeric',value:fmtNumInput(nuevaCuotaFija),onChange:function(e){setNuevaCuotaFija(parseNum(e.target.value));},placeholder:'Cuota en COP',className:'inp',style:{marginTop:6,fontSize:13,border:'1px solid var(--blue)'}})))),
      // PREVIEW
      preview&&h('div',{style:{marginTop:10,paddingTop:10,borderTop:'1px solid var(--bg2)'}},
        preview.error?h('div',{style:{background:'var(--red-bg)',border:'1px solid var(--red-bd)',borderRadius:8,padding:'8px 10px',fontSize:11,color:'var(--red)',display:'flex',alignItems:'flex-start',gap:6}},
          h(Ico,{name:'alert',size:12,color:'var(--red)',sw:2.4}),
          h('span',null,preview.error)):
        h('div',null,
          h('div',{style:{fontSize:10,color:'var(--text3)',fontWeight:600,letterSpacing:.5,marginBottom:6}},'PREVIEW'),
          h('div',{style:{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'5px 0',fontSize:12,borderTop:'1px solid var(--bg3)'}},
            h('span',{style:{color:'var(--text2)'}},'Saldo restante'),
            h('div',{style:{textAlign:'right'}},
              h('div',{className:'mono',style:{color:'var(--text)',fontWeight:500}},fmt(saldoTras)),
              esUSD&&h('div',{className:'mono',style:{fontSize:10,color:'var(--blue)'}},copToUsd(saldoTras,loan.trmAcordada)))),
          h('div',{style:{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'5px 0',fontSize:12,borderTop:'1px solid var(--bg3)'}},
            h('span',{style:{color:'var(--text2)'}},'Nueva cuota mensual'),
            h('div',{style:{textAlign:'right'}},
              h('div',{className:'mono',style:{color:'var(--green)',fontWeight:500}},fmt(preview.cuota)),
              esUSD&&h('div',{className:'mono',style:{fontSize:10,color:'var(--blue)'}},copToUsd(preview.cuota,loan.trmAcordada)))),
          h('div',{style:{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'5px 0',fontSize:12,borderTop:'1px solid var(--bg3)'}},
            h('span',{style:{color:'var(--text2)'}},'Cuotas restantes'),
            h('span',{style:{color:'var(--text)',fontWeight:500}},preview.nCuotas)),
          preview.ultimaResidual>0&&preview.ultimaResidual<preview.cuota&&h('div',{style:{display:'flex',justifyContent:'space-between',alignItems:'flex-start',padding:'5px 0',fontSize:12,borderTop:'1px solid var(--bg3)'}},
            h('div',null,
              h('div',{style:{color:'var(--text2)'}},'Ultima cuota (ajuste)'),
              h('div',{style:{fontSize:10,color:'var(--text3)',marginTop:1}},'Saldo residual exacto')),
            h('div',{style:{textAlign:'right'}},
              h('div',{className:'mono',style:{color:'var(--yellow)',fontWeight:500}},fmt(preview.ultimaResidual)),
              esUSD&&h('div',{className:'mono',style:{fontSize:10,color:'var(--blue)'}},copToUsd(preview.ultimaResidual,loan.trmAcordada))))))),
    h(Fld,{label:'Fecha del abono'},h('input',{type:'date',value:fecha,onChange:function(e){setFecha(e.target.value);},className:'inp'})),
    h(Fld,{label:'Observaciones'},h('input',{value:obs,onChange:function(e){setObs(e.target.value);},placeholder:'Notas opcionales...',className:'inp'})),
    // v1.17.1 — el usuario decide si quiere el PDF (mismo patron que PayModal :4256)
    h('label',{style:{display:'flex',alignItems:'center',gap:8,marginTop:14,cursor:'pointer',fontSize:12,color:'var(--text2)'}},
      h('input',{type:'checkbox',checked:genRecibo,onChange:function(){setGenRecibo(!genRecibo);},style:{width:16,height:16,accentColor:'var(--blue)',cursor:'pointer'}}),
      'Generar recibo de abono'),
    h('button',{onClick:submit,disabled:btnOff,className:'btn-primary',style:{marginTop:8,background:btnOff?'var(--bg3)':'var(--blue-bg)',border:'1px solid '+(btnOff?'var(--border)':'var(--blue)'),color:btnOff?'var(--text3)':'var(--blue)',cursor:btnOff?'not-allowed':'pointer'}},sending?'Registrando...':'Registrar abono'));
}
