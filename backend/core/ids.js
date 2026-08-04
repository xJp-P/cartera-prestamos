// backend/core/ids.js — PREDICADOS DE CLASIFICACION DE FILAS DE `payments`.
//
// POR QUE EXISTE
// Durante 45 bugs el modelo de `payments` fue BINARIO: o la fila era una cuota
// programada del cronograma (id `${loanId}-${cuotaN}`) o era un abono a capital
// (id con '-ab-'). Por eso ~70 sitios del codigo clasifican con el literal
// `id.indexOf('-ab-') === -1`, donde "no es abono" equivale DE HECHO a "es una
// cuota del cronograma". Las dos preguntas eran la misma.
//
// Con la modalidad de INTERES DIARIO aparece un TERCER tipo de fila —el CORTE,
// id `${loanId}-ct-${n}`— y esa equivalencia se rompe: un corte NO es una cuota
// programada (no tiene vencimiento, no cuenta para el plazo, no entra en la
// auto-finalizacion) pero SI es dinero real cobrado (entra en el KPI Ganancias,
// en el flujo de caja y en "Cobros del Mes").
//
// A partir de aqui, el mismo literal significa dos cosas distintas segun el
// sitio, y decidirlo caso por caso con un `indexOf` disperso en 70 lugares es
// justo la clase de deuda que produjo los Bugs #28, #44 y #45. Estos tres
// predicados obligan a NOMBRAR la pregunta que cada sitio hace de verdad.
//
// COMO ELEGIR
//   esCuotaRegular(p)  "es una cuota programada del cronograma?"  -> conteos de
//                      plazo, regularConsumed, auto-finalizacion, rangos de
//                      regeneracion, render del cronograma.
//   !esAbono(p)        "es dinero que no es un abono a capital?"  -> KPIs de
//                      ganancia, interes cobrado, flujo de caja, transacciones.
//   esAbono(p)         "es un abono a capital?"                   -> lo que ya
//                      preguntaba `indexOf('-ab-') !== -1`.
//
// COMPATIBILIDAD HOY: mientras no exista ninguna fila '-ct-', `esCorte` es
// siempre false y por tanto `esCuotaRegular(p)` es IDENTICO a `!esAbono(p)`.
// Por eso el barrido que introduce estos predicados es un refactor puro: no
// mueve un solo numero de la cartera existente.
//
// SQL: las sentencias que filtran con `LIKE '%-ab-%'` (db/schema.js,
// db/housekeeping.js) no pueden llamar a una funcion JS. Se dejan literales a
// proposito; si alguna necesitara excluir cortes, se le anade la condicion
// explicita en el propio SQL.
//
// ESPEJO: `public/js/core/ids.js` es la copia para el frontend (modulo ES; aqui
// CommonJS). Los CUERPOS de las cinco funciones deben permanecer identicos: es
// la misma regla de negocio aplicada a los mismos datos, y una divergencia entre
// las dos mitades reabriria la clase de falla del Bug #45 (papel vs pantalla).

// Marcas de id. No son configurables: viajan dentro de ids ya persistidos en la
// BD de produccion, asi que cambiarlas reclasificaria filas historicas.
const MARCA_ABONO = '-ab-';
const MARCA_CORTE = '-ct-';

// Acepta la fila entera o su id suelto: hay sitios que tienen el objeto y otros
// solo la cadena. Un id ausente/nulo no es abono ni corte -> cuota regular, que
// es exactamente lo que hacia el guard `!p.id || p.id.indexOf(...)` de
// routes/recalculate.js antes del barrido.
function idDe(p) {
  if (typeof p === 'string') return p;
  return (p && p.id) || '';
}

function esAbono(p) {
  return idDe(p).indexOf(MARCA_ABONO) !== -1;
}

function esCorte(p) {
  return idDe(p).indexOf(MARCA_CORTE) !== -1;
}

function esCuotaRegular(p) {
  return !esAbono(p) && !esCorte(p);
}

module.exports = { MARCA_ABONO, MARCA_CORTE, idDe, esAbono, esCorte, esCuotaRegular };
