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
