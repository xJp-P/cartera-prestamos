// public/js/core/calculo.js — matematica de PREVISUALIZACION en el cliente.
//
// Extraido de `app.js` en la Etapa 3 (B7) del refactor. Codigo VERBATIM.
//
// OJO CON EL ALCANCE: esto NO es el motor financiero. El motor vive en
// `backend/core/engine.js` y es la unica autoridad sobre lo que se persiste.
// Estas funciones solo alimentan los PREVIEW que la UI muestra mientras el
// usuario teclea (la cuota estimada de la Calculadora, el impacto de un abono
// antes de confirmarlo). Si alguna vez difieren del backend, manda el backend.
//
// `pmt` y `_pmt` SON LA MISMA FORMULA DUPLICADA, y se dejan las dos A PROPOSITO.
// Consolidarlas seria un cambio de logica, que este refactor tiene prohibido:
// la duplicacion es preexistente y unificarla es una decision de diseno aparte,
// no un efecto colateral de mover archivos.

export function pmt(r,n,pv){ return r===0?pv/n:pv*r*Math.pow(1+r,n)/(Math.pow(1+r,n)-1); }
// ── AbonoModal ────────────────────────────────────────────────────────────────
// Helper: PMT (cuota fija de amortizacion francesa)
export function _pmt(r,n,pv){if(r===0)return pv/n;return pv*r*Math.pow(1+r,n)/(Math.pow(1+r,n)-1);}
export function _tasaPeriodo(tasaMensual,frecuencia){if(frecuencia==='Semanal')return tasaMensual/4.33;if(frecuencia==='Quincenal')return tasaMensual/2;return tasaMensual;}
// NPER: numero de cuotas dado PMT, r, pv. Devuelve null si PMT <= pv*r (impossible).
export function _nper(r,pmtVal,pv){var int1=pv*r;if(pmtVal<=int1)return null;return Math.log(pmtVal/(pmtVal-int1))/Math.log(1+r);}

// ── Cronograma TENTATIVO (preview de LoanModal y de la Calculadora) ──────────
// ESPEJO del bucle de `buildSchedule` (backend/core/engine.js). Vivia duplicado
// byte a byte en los dos sitios y ninguna de las dos copias tenia el arreglo del
// Bug #43: la ultima fila se calculaba como `interes + saldo residual`, asi que
// arrastraba el ruido de redondeo y se mostraba 1-2 pesos fuera del valor pactado
// ("$374.999" donde la cuota es $375.000). Medido sobre 3.600 combinaciones, el
// preview desviaba la ultima cuota en el 85,5% de los casos; el backend, en 0%.
//
// La regla es la del motor, con su MISMA tolerancia calibrada: la ultima cuota
// toma el capital residual exacto y, si la diferencia contra el nominal es ruido
// de redondeo, se fuerza al nominal y el interes absorbe el ajuste. Si la
// diferencia es un GLOBO legitimo (tasa y plazo tan altos que el PMT converge al
// interes puro y el prestamo no amortiza), se respeta: ahi la ultima cuota SI es
// distinta y ocultarlo seria mentir sobre la deuda.
//
// `soloIntereses` NO hace globo final a proposito: el preview de esa modalidad es
// una ventana truncada de un credito indefinido, no su cierre.
export function filasPreview(montoCOP, r, nFilas, soloIntereses, cuotaNominal){
  var rows=[];
  var saldo=Math.round(montoCOP);
  var nominal=Math.round(cuotaNominal);
  var tol=Math.max(nFilas*2+2, Math.ceil(nominal*0.02));
  for(var i=0;i<nFilas;i++){
    var interes=Math.round(saldo*r);
    var isLast=i===nFilas-1;
    var capital,cuota;
    if(soloIntereses){
      capital=0; cuota=interes;
    } else if(isLast){
      capital=saldo;
      var natural=interes+capital;
      if(Math.abs(natural-nominal)<=tol && nominal-capital>=0){
        cuota=nominal; interes=cuota-capital;
      } else {
        cuota=natural;
      }
    } else {
      capital=Math.min(saldo, nominal-interes);
      cuota=nominal;
    }
    var sf=Math.max(0, saldo-capital);
    rows.push({n:i+1,interes:interes,capital:capital,cuota:cuota,saldo:sf});
    saldo=sf;
  }
  return rows;
}
