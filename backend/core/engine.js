// backend/core/engine.js — MOTOR FINANCIERO.
//
// Extraido de `server.js` en la Etapa 2 (A1) del refactor de modularizacion.
// El codigo de las 6 funciones se movio VERBATIM: no se corrigio, ni se renombro,
// ni se "mejoro" nada. Cualquier cambio de comportamiento aqui seria un bug.
//
// CONTRATO DE PUREZA: este modulo no toca la base de datos, ni Express, ni ningun
// estado del closure `createApp`. Solo depende de sus argumentos, `Math` y `Date`.
// Se verifico mecanicamente antes de extraerlo: 0 referencias a `db`, `app`,
// `insPayment`, `mutacionAtomica` y demas simbolos del closure. Por eso es la
// pieza de menor riesgo del backend y por eso va primera.
//
// Si algun dia una funcion de aca necesita la BD, NO se le pasa `db`: se parte la
// funcion y la parte impura se queda en su router. Perder la pureza de este modulo
// es perder la unica parte del backend que se puede probar sin levantar nada.

// ── Motor financiero ──────────────────────────────────────────────────────
function pmt(r, n, pv) {
  if (r === 0) return pv / n;
  return pv * r * Math.pow(1 + r, n) / (Math.pow(1 + r, n) - 1);
}

function getPayDate(startISO, cuotaN, diaPago, frecuencia) {
  const d = new Date(startISO + 'T12:00:00');
  if (frecuencia === 'Semanal') {
    d.setDate(d.getDate() + cuotaN * 7);
    return d.toISOString().split('T')[0];
  }
  if (frecuencia === 'Quincenal') {
    d.setDate(d.getDate() + cuotaN * 14);
    return d.toISOString().split('T')[0];
  }
  // Mensual (default)
  d.setDate(1);
  d.setMonth(d.getMonth() + cuotaN);
  d.setDate(Math.min(diaPago, new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()));
  return d.toISOString().split('T')[0];
}

// Convertir tasa mensual a tasa del período según frecuencia
function tasaPeriodo(tasaMensual, frecuencia) {
  if (frecuencia === 'Semanal') return tasaMensual / 4.33;
  if (frecuencia === 'Quincenal') return tasaMensual / 2;
  return tasaMensual; // Mensual
}

/**
 * buildSchedule — genera cronograma de cuotas
 * @param {object} loan        - datos del prestamo
 * @param {number} startN      - numero de cuota inicial (default 1)
 * @param {number} startSaldo  - saldo sobre el cual calcular (default loan.montoCOP)
 * @param {number} numCuotas   - cuantas cuotas generar (default: plazoMeses completo)
 *
 * startN tambien determina el offset de fecha: cuotaN=5 => mes 5 desde fechaInicio
 */
// Para Intereses: calcular cuántas cuotas generar hasta N períodos adelante de hoy
function cuotasHastaHoy(fechaInicio, startN, periodosAdelante, frecuencia) {
  const hoy = new Date();
  const inicio = new Date(fechaInicio + 'T12:00:00');
  const diffMs = hoy - inicio;
  const diasDiff = diffMs / (24 * 60 * 60 * 1000);
  var periodosDesdeInicio;
  if (frecuencia === 'Semanal') periodosDesdeInicio = Math.ceil(diasDiff / 7);
  else if (frecuencia === 'Quincenal') periodosDesdeInicio = Math.ceil(diasDiff / 14);
  else periodosDesdeInicio = Math.ceil(diasDiff / 30.44);
  periodosDesdeInicio += periodosAdelante;
  return Math.max(3, periodosDesdeInicio - startN + 1);
}

function buildSchedule(loan, startN, startSaldo, numCuotas) {
  startN = startN || 1;
  const { id, nombre, tasaMensual, modalidad, fechaInicio, diaPago } = loan;
  const freq = loan.frecuencia || 'Mensual';
  // Base para las FECHAS del cronograma (aplazamiento por cambio de dia de pago). NULL -> fechaInicio.
  const baseCron = loan.fechaBaseCronograma || fechaInicio;
  const montoCOP = startSaldo !== undefined ? startSaldo : loan.montoCOP;
  const indefinido = modalidad === 'Intereses';
  const totalCuotas = numCuotas !== undefined ? numCuotas : (indefinido ? cuotasHastaHoy(fechaInicio, startN, 3, freq) : (loan.plazoMeses || 12));
  const r = tasaPeriodo(tasaMensual / 100, freq);
  let saldo = montoCOP;
  const cuotaFija = pmt(r, totalCuotas, montoCOP);
  const rows = [];

  // Prestamo sin intereses: 1 cuota por el capital total (interesPeriodo=0, abonoCapital=capital).
  // v1.18.2 (Bug #30): abonoCapital persiste el CAPITAL (= cuotaTotal, ya que interes=0), NO 0.
  // El 0 historico era defensa contra la heuristica fragil 'interesPeriodo===0 && abonoCapital>0'
  // que confundia esta cuota con un abono; esa heuristica se erradico en v1.14.0 (Bug #28) y hoy
  // los abonos se identifican SOLO por id.indexOf('-ab-'). Con el 0, la formula canonica de saldo
  // (origCOP - Σ abonoCapital de Pagadas) no contaba el capital cobrado -> saldo fantasma en
  // prestamos ya saldados. Ahora es byte-identico a lo que 'Pago Unico' persiste con ganancia 0.
  if (modalidad === 'Prestamo') {
    var fechaCuota = loan.fechaDevolucion || getPayDate(baseCron, 1, diaPago, freq);
    rows.push({
      id: `${id}-1`, prestamoId: id, nombreCliente: nombre, cuotaN: 1,
      fechaPago: fechaCuota,
      saldoInicial: Math.round(montoCOP), interesPeriodo: 0,
      abonoCapital: Math.round(montoCOP), cuotaTotal: Math.round(montoCOP),
      saldoFinal: 0, estadoPago: 'Pendiente', fechaRecaudo: null, observaciones: '',
      montoCOPRecibido: 0, montoUSDRecibido: 0, partialPaid: 0, extraConsolidado: 0
    });
    return rows;
  }

  // v1.10.0 — Pago Unico: 1 cuota con capital + ganancia fija pactada
  // interesPeriodo carga la ganancia → entra al KPI Ganancias del Dashboard
  // abonoCapital carga el capital → entra al calculo de Saldo Pendiente
  // cuotaTotal = capital + ganancia → entra al Recaudo del mes
  if (modalidad === 'Pago Unico') {
    var fechaCuotaPU = loan.fechaDevolucion || getPayDate(baseCron, 1, diaPago, freq);
    var capitalPU = Math.round(montoCOP);
    var gananciaPU = Math.round(+loan.gananciaFija || 0);
    rows.push({
      id: `${id}-1`, prestamoId: id, nombreCliente: nombre, cuotaN: 1,
      fechaPago: fechaCuotaPU,
      saldoInicial: capitalPU,
      interesPeriodo: gananciaPU,
      abonoCapital: capitalPU,
      cuotaTotal: capitalPU + gananciaPU,
      saldoFinal: 0, estadoPago: 'Pendiente', fechaRecaudo: null, observaciones: '',
      montoCOPRecibido: 0, montoUSDRecibido: 0, partialPaid: 0, extraConsolidado: 0
    });
    return rows;
  }

  // ── v2.2.0 — ARITMETICA EN PESOS ENTEROS ─────────────────────────────────
  // Antes el bucle calculaba a 2 decimales y arrastraba ESE saldo, pero persistia
  // Math.round(...) a pesos: lo guardado y lo computado hacia adelante divergian. Dos efectos:
  //  (a) la ultima cuota (residual = interes + saldo) caia 1 peso por debajo de las demas y el
  //      cliente veia "$105.999" donde el contrato decia "$106.000" -> parecia un error del recibo;
  //  (b) peor y silencioso: Σ abonoCapital daba 400.001 sobre un prestamo de 400.000, asi que la
  //      formula canonica de saldo (origCOP − Σ capital de Pagadas) se iba a negativo y solo la
  //      salvaba el Math.max(0, ...). Ese descuadre es la misma clase de fallo de los Bugs #35/#19.
  // Ahora el saldo camina en enteros: lo persistido ES lo computado. Por construccion,
  // interes + capital == cuota en cada fila y Σ capital == capital prestado, exacto.
  const cuotaNominal = Math.round(cuotaFija);
  saldo = Math.round(saldo);
  // Tolerancia del ajuste de la ultima cuota. El residuo de redondeo NO crece linealmente con el
  // plazo: el medio peso que se pierde al redondear el PMT se capitaliza periodo a periodo, asi
  // que a 48 cuotas puede llegar a varios cientos de pesos. Medido sobre 2.700 combinaciones, el
  // criterio que separa limpiamente los dos mundos es la diferencia como FRACCION de la cuota:
  //   - ruido de redondeo -> siempre una fraccion minima del valor de la cuota
  //   - globo legitimo    -> multiplos de la cuota (pasa cuando tasa y plazo son tan altos que el
  //                          PMT converge al interes puro y el prestamo no amortiza nada)
  // Solo se absorbe el primero. El segundo se respeta: ahi la ultima cuota SI es distinta de
  // verdad y ocultarlo seria mentir sobre la deuda.
  const tolResidual = Math.max(totalCuotas * 2 + 2, Math.ceil(cuotaNominal * 0.02));

  for (let i = 0; i < totalCuotas; i++) {
    const cuotaN = startN + i;
    let interes = Math.round(saldo * r);
    const isLast  = indefinido ? false : (i === totalCuotas - 1);
    let capital, cuota;

    if (indefinido || modalidad === 'Intereses') {
      // Solo intereses: el capital viaja completo a la ultima cuota (globo). Sin cambios.
      capital = isLast ? saldo : 0;
      cuota   = isLast ? interes + saldo : interes;
    } else if (isLast) {
      // Ultima cuota: el capital es el residual EXACTO -> Σ capital == prestado, siempre.
      capital = saldo;
      const cuotaNatural = interes + capital;
      // El interes nunca puede quedar negativo al absorber (pasaria si el capital residual
      // superara la cuota nominal); en ese caso la diferencia no es ruido y se respeta.
      if (Math.abs(cuotaNatural - cuotaNominal) <= tolResidual && cuotaNominal - capital >= 0) {
        // Diferencia = ruido de redondeo: la cuota final vale lo MISMO que las demas (es lo
        // pactado) y el interes absorbe el ajuste, que es donde contablemente corresponde.
        cuota = cuotaNominal;
        interes = cuota - capital;
      } else {
        cuota = cuotaNatural; // diferencia real (globo): se respeta
      }
    } else {
      // Cuotas regulares: valor nominal exacto; el capital es el complemento del interes.
      capital = Math.min(saldo, cuotaNominal - interes);
      cuota   = cuotaNominal;
    }

    const saldoFinal = Math.max(0, saldo - capital);
    rows.push({
      id: `${id}-${cuotaN}`, prestamoId: id, nombreCliente: nombre, cuotaN: cuotaN,
      fechaPago: getPayDate(baseCron, cuotaN, diaPago, freq),
      saldoInicial: saldo, interesPeriodo: interes,
      abonoCapital: capital, cuotaTotal: cuota,
      saldoFinal: saldoFinal,
      estadoPago: 'Pendiente', fechaRecaudo: null, observaciones: '',
      montoCOPRecibido: 0, montoUSDRecibido: 0, partialPaid: 0, extraConsolidado: 0
    });
    saldo = saldoFinal;
  }
  return rows;
}

/**
 * buildScheduleFixedPMT — genera cronograma con cuota fija y cuota residual final.
 * Usado por opcion 3 del recalculo (Fijar valor de cuota).
 * Genera N-1 cuotas iguales de cuotaFija + 1 ultima cuota que ajusta el saldo a 0.
 *
 * @param {object} loan        - datos del prestamo (necesita id, nombre, fechaInicio, diaPago, frecuencia, modalidad, tasaMensual)
 * @param {number} startN      - numero de cuota inicial
 * @param {number} saldoInicial - saldo de capital sobre el cual aplicar
 * @param {number} cuotaFija   - cuota deseada por periodo (debe ser > saldoInicial * r)
 * @returns {Array<object>} - filas de cuotas (la ultima es la residual)
 * @throws Error si cuotaFija <= saldoInicial * r (cuota insuficiente para cubrir intereses)
 */
function buildScheduleFixedPMT(loan, startN, saldoInicial, cuotaFija) {
  const { id, nombre, tasaMensual, fechaInicio, diaPago } = loan;
  const freq = loan.frecuencia || 'Mensual';
  const baseCron = loan.fechaBaseCronograma || fechaInicio; // fechas via base de cronograma (aplazamiento)
  const r = tasaPeriodo(tasaMensual / 100, freq);
  const interesInicial = saldoInicial * r;
  // Validacion: cuota debe cubrir al menos el interes del primer periodo
  if (cuotaFija <= interesInicial) {
    throw new Error('Cuota insuficiente: $' + Math.round(cuotaFija).toLocaleString('es-CO') +
      ' no cubre el interes del primer periodo ($' + Math.round(interesInicial).toLocaleString('es-CO') + ').');
  }
  const rows = [];
  // v2.2.0 — pesos enteros, misma doctrina que buildSchedule: lo persistido ES lo computado
  // hacia adelante, asi que interes + capital == cuota y Σ capital == saldo inicial, exacto.
  // AQUI SI se conserva el residual visible de la ultima cuota: en "fijar cuota" el usuario
  // pacta un valor y el sobrante final es una consecuencia BUSCADA del modelo (N-1 iguales +
  // 1 residual), no ruido de redondeo como en el PMT.
  const cuotaEnt = Math.round(cuotaFija);
  let saldo = Math.round(saldoInicial);
  let cuotaN = startN;
  const MAX_ITER = 1000; // safety net
  let i = 0;
  while (saldo > 0 && i < MAX_ITER) {
    const interes = Math.round(saldo * r);
    // Si esta cuota completa o exceria el saldo, es la ultima (residual)
    const saldoMasInteres = saldo + interes;
    let capital, cuotaTotal, saldoFinal;
    if (saldoMasInteres <= cuotaEnt) {
      // Ultima cuota: residual exacto
      capital = saldo;
      cuotaTotal = saldoMasInteres;
      saldoFinal = 0;
    } else {
      capital = Math.min(saldo, cuotaEnt - interes);
      cuotaTotal = cuotaEnt;
      saldoFinal = Math.max(0, saldo - capital);
    }
    rows.push({
      id: `${id}-${cuotaN}`,
      prestamoId: id,
      nombreCliente: nombre,
      cuotaN: cuotaN,
      fechaPago: getPayDate(baseCron, cuotaN, diaPago, freq),
      saldoInicial: Math.round(saldo),
      interesPeriodo: Math.round(interes),
      abonoCapital: Math.round(capital),
      cuotaTotal: Math.round(cuotaTotal),
      saldoFinal: Math.round(saldoFinal),
      estadoPago: 'Pendiente',
      fechaRecaudo: null,
      observaciones: '',
      montoCOPRecibido: 0,
      montoUSDRecibido: 0,
      partialPaid: 0,
      extraConsolidado: 0
    });
    saldo = saldoFinal;
    cuotaN++;
    i++;
  }
  if (i >= MAX_ITER) throw new Error('Cuota demasiado baja: requiere mas de ' + MAX_ITER + ' cuotas para saldar.');
  return rows;
}

module.exports = {
  pmt,
  getPayDate,
  tasaPeriodo,
  cuotasHastaHoy,
  buildSchedule,
  buildScheduleFixedPMT,
};
