// public/js/core/ids.js — PREDICADOS DE CLASIFICACION DE FILAS DE `payments`.
//
// ESPEJO EXACTO de `backend/core/ids.js`. Alli vive la justificacion completa;
// aqui solo lo imprescindible para no tener que saltar de archivo:
//
//   esCuotaRegular(p)  "es una cuota programada del cronograma?"  -> conteos de
//                      plazo, render del cronograma, auto-finalizacion.
//   !esAbono(p)        "es dinero que no es un abono a capital?"  -> KPIs de
//                      ganancia, interes cobrado, flujo de caja, transacciones.
//   esAbono(p)         "es un abono a capital?"
//
// Existen porque la modalidad de INTERES DIARIO introduce un TERCER tipo de fila
// (el CORTE, id `${loanId}-ct-${n}`) y rompe la equivalencia que el codigo dio
// por sentada durante 45 bugs: hasta hoy "no es abono" queria decir "es una
// cuota del cronograma". Un corte no es una cuota programada, pero SI es dinero
// real cobrado — asi que los dos filtros dejan de coincidir y cada sitio tiene
// que declarar cual de las dos preguntas hace.
//
// Mientras no exista ninguna fila '-ct-', `esCuotaRegular(p)` es IDENTICO a
// `!esAbono(p)`: el barrido que los introduce no mueve un solo numero.
//
// LOS CUERPOS DEBEN SER IDENTICOS a los del backend. Es la misma regla de
// negocio sobre los mismos datos; una divergencia entre las dos mitades
// reabriria la clase de falla del Bug #45 (el papel contradiciendo la pantalla).
// La duplicacion es inevitable: el backend es CommonJS y esto es un modulo ES,
// y el proyecto no tiene bundler a proposito.

// Marcas de id. No son configurables: viajan dentro de ids ya persistidos en la
// BD de produccion, asi que cambiarlas reclasificaria filas historicas.
export var MARCA_ABONO = '-ab-';
export var MARCA_CORTE = '-ct-';

// Acepta la fila entera o su id suelto: hay sitios que tienen el objeto y otros
// solo la cadena. Un id ausente/nulo no es abono ni corte -> cuota regular.
export function idDe(p) {
  if (typeof p === 'string') return p;
  return (p && p.id) || '';
}

export function esAbono(p) {
  return idDe(p).indexOf(MARCA_ABONO) !== -1;
}

export function esCorte(p) {
  return idDe(p).indexOf(MARCA_CORTE) !== -1;
}

export function esCuotaRegular(p) {
  return !esAbono(p) && !esCorte(p);
}
