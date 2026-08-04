// public/js/vistas/PortfolioView.js — Rendimiento: ganancia por prestamo y KPIs globales.
//
// Extraido de `app.js` en la Etapa 3 (B7) del refactor. Codigo VERBATIM.
//
// El estado global sigue viviendo en `App` y baja por PROPS, igual que antes.
// Sin Context API y sin store: eso seria rediseno, no refactor.

import { Ico } from '../componentes/iconos.js';
import { imputarCobros } from '../core/dominio.js';
import { copToUsd, fmt, fmtD, fmtN, fmtUSD } from '../core/format.js';
import { h, useMemo, useState } from '../core/react.js';
import { esAbono } from '../core/ids.js';

// ── Rendimiento (Portfolio Performance) ───────────────────────────────────────
export function PortfolioView(props){
  var loans=props.loans,pays=props.pays;
  var ft=useState('Activo'); var filtro=ft[0]; var setFiltro=ft[1];
  var loanMetrics=useMemo(function(){
    return loans.map(function(loan){
      var lp=pays.filter(function(p){return p.prestamoId===loan.id;});
      var paid=lp.filter(function(p){return p.estadoPago==='Pagado';});
      var esUSD=loan.moneda==='USD';
      // Identificar abonos reales: predicado unico de core/ids.js
      // Regulares = cuotas normales del cronograma (no abonos)
      var regulares=lp.filter(function(p){return !esAbono(p);});
      var regularesPaid=paid.filter(function(p){return !esAbono(p);});
      var abonosPaid=paid.filter(function(p){return esAbono(p);});

      // ── GANANCIA REAL: COP recibido menos capital amortizado ──
      // Para COP: equivale a interesPeriodo (no hay TRM en juego).
      // Para USD: si el usuario registro montoCOPRecibido al cobrar, se usa eso
      // (incluye ganancia cambiaria por subida de TRM). Si no, fallback a interesPeriodo.
      var ganancia;
      if(esUSD){
        ganancia=regularesPaid.reduce(function(s,p){
          if(p.montoCOPRecibido&&p.montoCOPRecibido>0){
            // Capital robusto: cuotaTotal-interesPeriodo (en Prestamo abonoCapital=0,
            // de lo contrario el COP recibido se contaria entero como ganancia fantasma).
            return s+(p.montoCOPRecibido-(p.cuotaTotal-p.interesPeriodo));
          }
          return s+p.interesPeriodo;
        },0);
      } else {
        ganancia=paid.reduce(function(s,p){return s+p.interesPeriodo;},0);
      }

      // ── GANANCIA EN USD REAL (Bug #23 / v1.12.6): el USD efectivamente recibido como utilidad,
      // NO copToUsd(gananciaCOP) que reconvierte por TRM y recontaria la perdida/ganancia cambiaria.
      // Por cuota pagada: USD recibido - capital en USD (abonoCapital a TRM acordada).
      // Fallback (sin montoUSDRecibido): interes contractual en USD = interesPeriodo / trmAcordada.
      var gananciaUSD=esUSD?regularesPaid.reduce(function(s,p){
        var trm=loan.trmAcordada>0?loan.trmAcordada:1;
        // Capital en USD robusto para las 4 modalidades: cuotaTotal-interesPeriodo
        // (en Prestamo abonoCapital se guarda en 0, no sirve como base).
        var capUSD=(p.cuotaTotal-p.interesPeriodo)/trm;
        if(p.montoUSDRecibido&&p.montoUSDRecibido>0) return s+(p.montoUSDRecibido-capUSD);
        return s+(p.interesPeriodo/trm);
      },0):0;

      // ── CAPITAL RECUPERADO: via imputacion (Fase 3) ──────────────────────────
      // Incluye el capital que ya cubrio un pago parcial en curso, ademas del de las cuotas
      // saldadas y los abonos. Antes solo contaba cuotas con estadoPago==='Pagado'.
      var capRec=Math.round(lp.reduce(function(s,p){return s+imputarCobros(p).totales.capital;},0));
      // Se conservan para las filas INFORMATIVAS de la tarjeta ("Abonos a capital recibidos" y
      // "Abonos parciales recibidos"); ya NO participan del saldo, que sale del capital imputado.
      var capitalAbonos=abonosPaid.reduce(function(s,p){return s+p.abonoCapital;},0);
      var parcialesPend=regulares.filter(function(p){return p.estadoPago!=='Pagado';}).reduce(function(s,p){return s+(p.partialPaid||0);},0);

      // ── SALDO PENDIENTE: monto original - capital efectivamente recuperado ────
      // Antes restaba ADEMAS `parcialesPend` (el parcial COMPLETO), lo que rompia la identidad
      // documentada "Colocado = Recuperado + Saldo": el interes contenido en el parcial
      // desaparecia de los dos lados. Con el capital imputado la identidad se cumple exacta.
      var saldo;
      if(loan.estado!=='Activo'){
        saldo=0;
      } else {
        var origR=loan.moneda==='USD'?Math.round(loan.montoOrigen*loan.trmAcordada):Math.round(loan.montoOrigen);
        saldo=Math.max(0,origR-capRec);
      }

      // ── CUOTAS: solo regulares ──
      var cuotasPaid=regularesPaid.length;
      var cuotasTotal=regulares.length||1;

      // ── Progreso por MONTO (incluye abonos parciales) ──
      var totEspRec=regulares.reduce(function(s,p){return s+p.cuotaTotal;},0);
      var totCobRec=regulares.reduce(function(s,p){
        if(p.estadoPago==='Pagado') return s+p.cuotaTotal;
        return s+(p.partialPaid||0);
      },0);
      var pctMonto=totEspRec>0?Math.round(totCobRec/totEspRec*100):0;

      // ── MORA: tiene cuotas en mora? ──
      var enMora=lp.some(function(p){return p.estadoPago==='En Mora';});

      // ── FECHA DE FINALIZACION (derivada): ultimo pago registrado ──
      // No hay columna fechaFinalizado; se infiere del pago mas reciente:
      // paidAt (timestamp real v1.11.1) > fechaRecaudo > fechaPago; fallback fechaInicio.
      var fechaFin=paid.reduce(function(mx,p){var d=p.paidAt||p.fechaRecaudo||p.fechaPago||'';return d>mx?d:mx;},'')||loan.fechaInicio;

      return {loan:loan,ganancia:Math.round(ganancia),capRec:Math.round(capRec),saldo:saldo,
        cuotasPaid:cuotasPaid,cuotasTotal:cuotasTotal,enMora:enMora,capitalAbonos:Math.round(capitalAbonos),
        pctMonto:pctMonto,parcialesPend:Math.round(parcialesPend),fechaFin:fechaFin,gananciaUSD:gananciaUSD};
    }).sort(function(a,b){
      var aAct=a.loan.estado==='Activo',bAct=b.loan.estado==='Activo';
      if(aAct!==bAct) return aAct?-1:1;
      // Activos: por fecha de inicio desc. Finalizados/Cancelados: por fecha de finalizacion desc
      // (el ultimo finalizado arriba), con fechaInicio como desempate.
      if(aAct) return b.loan.fechaInicio.localeCompare(a.loan.fechaInicio);
      return b.fechaFin.localeCompare(a.fechaFin)||b.loan.fechaInicio.localeCompare(a.loan.fechaInicio);
    });
  },[loans,pays]);
  // Ganancia Obtenida: historica (incluye finalizados/cancelados — ya realizada).
  var totalGanancia=loanMetrics.reduce(function(s,m){return s+m.ganancia;},0);
  // Capital Colocado / Recuperado: SOLO prestamos Activos, para coincidir con el KPI
  // "Capital Original" del Dashboard (misma formula+filtro) y cumplir la identidad contable
  // Colocado = Recuperado + Saldo. Saldo ya esta acotado a activos (saldo=0 si no Activo).
  var activosR=loans.filter(function(l){return l.estado==='Activo';});
  var totalColocado=activosR.reduce(function(s,l){return s+(l.moneda==='USD'?Math.round(l.montoOrigen*l.trmAcordada):Math.round(l.montoOrigen));},0);
  var totalCapRec=loanMetrics.reduce(function(s,m){return m.loan.estado==='Activo'?s+m.capRec:s;},0);
  var totalSaldo=loanMetrics.reduce(function(s,m){return s+m.saldo;},0);

  function kpi(label,val,sub,color,bd){
    return h('div',{style:{background:'var(--bg2)',borderRadius:12,padding:'12px 14px',border:'1px solid '+bd}},
      h('div',{style:{fontSize:11,color:color,fontWeight:700,marginBottom:4}},label),
      h('div',{className:'mono',style:{fontWeight:700,fontSize:17,color:color}},val),
      h('div',{style:{fontSize:12,color:'var(--text3)',marginTop:3}},sub));
  }

  return h('div',{className:'fade-in',style:{padding:16}},
    h('div',{style:{fontWeight:700,fontSize:17,color:'var(--text)',marginBottom:2,display:'flex',alignItems:'center',gap:6}},h(Ico,{name:'trending',size:16,color:'var(--green)'}),' Rendimiento del Portafolio'),
    h('div',{style:{fontSize:13,color:'var(--text2)',marginBottom:14}},'Ganancias obtenidas y estado del capital'),
    h('div',{style:{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10,marginBottom:16}},
      kpi('GANANCIA OBTENIDA',fmt(totalGanancia),'Intereses cobrados','var(--green)','var(--green-bd)'),
      kpi('CAP. COLOCADO (ACTIVOS)',fmt(totalColocado),'Total invertido · solo activos','var(--blue)','var(--blue-bd)'),
      kpi('CAP. RECUPERADO (ACTIVOS)',fmt(totalCapRec),'Capital + abonos · solo activos','var(--blue)','var(--blue-bd)'),
      kpi('SALDO PENDIENTE',fmt(totalSaldo),'Capital expuesto','var(--yellow)','var(--border)')),
    h('div',{style:{display:'flex',gap:0,marginBottom:12,background:'var(--bg2)',borderRadius:10,border:'1px solid var(--border)',overflow:'hidden'}},
      [['Activo','Activo'],['Finalizados','Finalizados']].map(function(t){
        var val=t[0],label=t[1];
        var active=filtro===val;
        var cnt=loanMetrics.filter(function(m){return val==='Activo'?m.loan.estado==='Activo':(m.loan.estado==='Finalizado'||m.loan.estado==='Cancelado');}).length;
        return h('button',{key:val,onClick:function(){setFiltro(val);},style:{flex:1,padding:'9px 0',fontSize:13,fontWeight:700,cursor:'pointer',border:'none',
          background:active?'var(--green)':'transparent',color:active?'#fff':'var(--text3)',transition:'all .15s'}},
          label+' ('+cnt+')');
      })),
    loanMetrics.filter(function(m){return filtro==='Activo'?m.loan.estado==='Activo':(m.loan.estado==='Finalizado'||m.loan.estado==='Cancelado');}).length===0&&h('div',{style:{textAlign:'center',padding:'40px 0',color:'var(--text3)'}},
      h('div',{style:{marginBottom:10}},h(Ico,{name:filtro==='Activo'?'briefcase':'check',size:36,color:'var(--text3)'})),
      h('p',null,filtro==='Activo'?'Sin prestamos activos':'Sin prestamos finalizados')),
    h('div',{style:{display:'flex',flexDirection:'column',gap:10}},
      loanMetrics.filter(function(m){return filtro==='Activo'?m.loan.estado==='Activo':(m.loan.estado==='Finalizado'||m.loan.estado==='Cancelado');}).map(function(m){
        var l=m.loan;
        var esUSD=l.moneda==='USD';
        var pct=m.cuotasTotal>0?Math.round(m.cuotasPaid/m.cuotasTotal*100):0;
        var esCancelado=l.estado==='Cancelado';
        var stColor=l.estado==='Activo'?'var(--green)':esCancelado?'var(--red)':'var(--text3)';
        var stBg=l.estado==='Activo'?'var(--green-bg)':esCancelado?'var(--red-bg)':'var(--bg3)';
        // Color del saldo: naranja si hay mora, amarillo si activo, rojo si cancelado, gris si finalizado
        var saldoColor=esCancelado?'var(--red)':l.estado!=='Activo'?'var(--text3)':m.enMora?'var(--red)':'var(--yellow)';
        var perdidaTotal=esCancelado?Math.round((l.capitalPerdido||0)+(l.interesesPerdidos||0)):0;
        return h('div',{key:l.id,style:{background:'var(--bg2)',borderRadius:14,padding:'13px 14px',border:'1px solid '+(m.enMora&&l.estado==='Activo'?'var(--red-bd)':'var(--border)')}},
          h('div',{style:{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:6}},
            h('div',{style:{fontWeight:700,fontSize:14,color:'var(--text)'}},l.nombre),
            h('div',{style:{display:'flex',gap:5,alignItems:'center'}},
              m.enMora&&l.estado==='Activo'&&h('span',{style:{background:'var(--red-bg)',color:'var(--red)',fontSize:9,fontWeight:700,padding:'2px 7px',borderRadius:99}},'MORA'),
              h('span',{style:{background:stBg,color:stColor,fontSize:10,fontWeight:700,padding:'2px 9px',borderRadius:99}},l.estado))),
          h('div',{style:{display:'flex',gap:5,flexWrap:'wrap',fontSize:12,color:'var(--text3)',marginBottom:4}},
            h('span',null,fmtD(l.fechaInicio)),
            h('span',null,'\u2022'),
            h('span',null,l.modalidad),
            l.tasaMensual>0&&h('span',null,'\u2022'),
            l.tasaMensual>0&&h('span',null,l.tasaMensual+'% mensual')),
          h('div',{style:{fontSize:12,color:'var(--text3)',marginBottom:10}},
            'Capital: '+(esUSD?'USD $'+fmtN(l.montoOrigen)+' ('+fmt(Math.round(l.montoOrigen*l.trmAcordada))+')':fmt(Math.round(l.montoOrigen)))),
          h('div',{style:{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10,marginBottom:10}},
            h('div',null,
              h('div',{style:{fontSize:11,color:m.ganancia<0?'var(--red)':'var(--green)',fontWeight:600}},(esUSD&&l.modalidad==='Prestamo')?'Efecto TRM':'Ganancia obtenida'),
              h('div',{className:'mono',style:{fontSize:15,fontWeight:600,color:m.ganancia<0?'var(--red)':'var(--green)'}},fmt(m.ganancia)),
              esUSD&&h('div',{className:'mono',style:{fontSize:11,color:'var(--blue)'}},fmtUSD(m.gananciaUSD)),
              (esUSD&&l.modalidad==='Prestamo')&&h('div',{style:{fontSize:9,color:'var(--text3)',marginTop:1,fontStyle:'italic'}},m.ganancia<0?'Sin interes · TRM bajo al cobrar':m.ganancia>0?'Sin interes · TRM subio al cobrar':'Sin interes · sin variacion TRM')),
            h('div',null,
              h('div',{style:{fontSize:11,color:saldoColor,fontWeight:600}},esCancelado?'Perdida total':'Saldo pendiente'),
              h('div',{className:'mono',style:{fontSize:15,fontWeight:600,color:saldoColor}},l.estado==='Activo'?fmt(m.saldo):esCancelado?'-'+fmt(perdidaTotal):'Saldado'),
              esUSD&&l.estado==='Activo'&&h('div',{className:'mono',style:{fontSize:11,color:'var(--blue)'}},copToUsd(m.saldo,l.trmAcordada)),
              esCancelado&&(function(){
                var capP=Math.round(l.capitalPerdido||0),intP=Math.round(l.interesesPerdidos||0);
                if(capP>0&&intP>0) return h('div',{style:{marginTop:3,fontSize:9,lineHeight:1.6}},
                  h('div',{style:{color:'var(--text3)'}},'Capital ',h('span',{className:'mono',style:{color:'var(--red)'}},'-'+fmt(capP))),
                  h('div',{style:{color:'var(--text3)'}},'Intereses ',h('span',{className:'mono',style:{color:'var(--red)'}},'-'+fmt(intP))));
                if(capP>0) return h('div',{style:{marginTop:2,fontSize:9,color:'var(--text3)',fontStyle:'italic'}},'Solo capital no recuperado');
                if(intP>0) return h('div',{style:{marginTop:2,fontSize:9,color:'var(--text3)',fontStyle:'italic'}},'Solo intereses no cobrados');
                return null;
              })()),
            m.capitalAbonos>0&&h('div',{style:{gridColumn:'1/3',marginTop:2}},
              h('div',{style:{fontSize:11,color:'var(--blue)',fontWeight:600}},'Abonos a capital'),
              h('div',{className:'mono',style:{fontSize:14,fontWeight:500,color:'var(--blue)'}},fmt(m.capitalAbonos),
                esUSD&&h('span',{style:{fontSize:11,fontWeight:400,marginLeft:6}},copToUsd(m.capitalAbonos,l.trmAcordada)))),
            m.parcialesPend>0&&h('div',{style:{gridColumn:'1/3',marginTop:2}},
              h('div',{style:{fontSize:11,color:'var(--blue)',fontWeight:600}},'Abonos parciales recibidos'),
              h('div',{className:'mono',style:{fontSize:13,fontWeight:500,color:'var(--blue)'}},fmt(m.parcialesPend)),
              h('div',{style:{fontSize:10,color:'var(--text3)',marginTop:1,fontStyle:'italic'}},'Pendiente de completar cuota para reconocer ganancia'))),
          l.modalidad==='Intereses'?h('div',{style:{display:'flex',alignItems:'center',gap:6,fontSize:11,color:'var(--text3)'}},
            h('span',null,m.cuotasPaid+' cuotas pagadas'),
            h('span',{style:{color:'var(--blue)'}},'\u221E')):h('div',{style:{display:'flex',alignItems:'center',gap:8}},
            h('div',{style:{flex:1,height:6,background:'var(--bg3)',borderRadius:3,overflow:'hidden',position:'relative'}},
              h('div',{style:{width:m.pctMonto+'%',height:'100%',background:m.enMora&&l.estado==='Activo'?'var(--red)':'var(--green)',borderRadius:3,transition:'width .3s'}})),
            h('span',{style:{fontSize:11,color:'var(--text3)',whiteSpace:'nowrap'}},m.cuotasPaid+'/'+m.cuotasTotal+' ('+m.pctMonto+'%)')));
      })));
}
