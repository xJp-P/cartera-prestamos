// public/js/datos/changelogs.js — novedades por version.
//
// Extraido de `app.js` en la Etapa 3 (B2) del refactor. Datos VERBATIM.
//
// Es texto inerte: ni una linea de logica. Vivia DENTRO del cuerpo de `App`,
// donde ocupaba 527 de sus ~1.310 lineas — mas de un tercio del componente mas
// grande de la app era una tabla de datos que se reconstruia en cada render.
//
// Lo consume el modal de novedades post-actualizacion: `App` compara la version
// que reporta Electron contra `localStorage.lastSeenVersion` y, si difieren y hay
// entrada para esa version, la muestra una sola vez.

export const CHANGELOGS = {
  '1.2.7': [
    'Recibo PDF en USD muestra solo dolares',
    'Fix spacing del tooltip de modalidad',
    'Tooltip de modalidad abre hacia abajo'
  ],
  '1.2.8': [
    'Changelog: resumen de novedades al actualizar',
    'Sincronizar datos re-lee la BD completa',
    'Boton de sincronizar movido a Desarrollador'
  ],
  '1.2.9': [
    'Mejor manejo de errores dentro de la app',
    'Aviso al iniciar si no se encuentra la base de datos',
    'Seccion de historial de acciones corregida',
    'Notificaciones mas integradas al diseño de la app'
  ],
  '1.3.0': [
    'Ventanas de cambios y errores mejoradas visualmente',
    'Textos de novedades mas claros y naturales'
  ],
  '1.4.0': [
    'Frecuencia de cobro: ahora puedes crear prestamos semanales, quincenales o mensuales',
    'El dia de pago se calcula automaticamente desde la fecha de inicio',
    'Nueva seccion en Pagos: "Proximas a vencer" para cuotas que vencen en 1-3 dias',
    'Valores en USD visibles en la seccion "Vencen en 3 dias" del Inicio',
    'La Calculadora tambien soporta frecuencias de cobro'
  ],
  '1.4.1': [
    'Correccion de decimales en USD en el resumen al crear prestamos'
  ],
  '1.4.2': [
    'Ventana de novedades ahora aparece correctamente al actualizar'
  ],
  '1.4.3': [
    'Inicio mas limpio: se elimino la seccion "Proximos 7 dias" (redundante con "Vencen en 3 dias")'
  ],
  '1.5.0': [
    'Modalidad "Prestamo" simplificada: solo pide fecha del prestamo y fecha de devolucion',
    'Se ocultan campos innecesarios (frecuencia, tasa, plazo) para prestamos sin interes',
    'El estado ya no se pide al crear un prestamo (siempre inicia como Activo)'
  ],
  '1.5.1': [
    'Orden mejorado: prestamos y deudores se organizan del mas reciente al mas antiguo',
    'Deudores separados en Activos e Inactivos con linea divisora',
    'Saldo en USD visible en la lista de deudores',
    '"Ganancia realizada" renombrada a "Ganancia obtenida" en Rendimiento'
  ],
  '1.5.2': [
    'Recibo PDF al registrar un pago (con opcion de activar/desactivar)',
    'Cronograma PDF desde el perfil de cada deudor',
    'Valor de liquidacion visible en el perfil y en el cronograma PDF',
    'PDFs se generan con el tema activo (claro u oscuro)',
    'Abonos a capital reflejados en el cronograma PDF',
    'Correccion general de saldos: formula unificada desde monto original menos capital pagado',
    'Saldo en perfil de deudores, cartera y abonos corregido con abonos incluidos'
  ],
  '1.5.3': [
    'Fix actualizacion automatica en Mac (firma de codigo desactivada)'
  ],
  '1.5.4': [
    'Mac: actualizaciones redirigen a GitHub Releases para descargar el .dmg manualmente',
    'Windows: actualizaciones automaticas sin cambios'
  ],
  '1.5.5': [
    'Test de actualizacion en Mac'
  ],
  '1.5.6': [
    'Mac: actualizacion automatica completa (descarga, instala y reinicia sin salir de la app)'
  ],
  '1.5.7': [
    'Test de actualizacion automatica en Mac'
  ],
  '1.5.8': [
    'Recibo PDF al registrar un pago (con opcion de activar/desactivar)',
    'Cronograma PDF desde el perfil de cada deudor',
    'Valor de liquidacion visible en el perfil y en el cronograma PDF',
    'PDFs se generan con el tema activo (claro u oscuro)',
    'Abonos a capital reflejados en el cronograma PDF',
    'Correccion general de saldos: formula unificada desde monto original menos capital pagado',
    'Saldo en perfil de deudores, cartera y abonos corregido con abonos incluidos',
    'Mac: actualizacion automatica completa (descarga, instala y reinicia sin salir de la app)'
  ],
  '1.5.9': [
    'Cronograma visible en el perfil de cada deudor (sin descargar PDF)',
    'Valores USD en cronograma del perfil (deuda, cuota, abonos)',
    'Cerrar abono a capital regresa al perfil del deudor',
    'Modalidad Intereses: cronograma y PDF solo muestran cuotas pagadas y en mora',
    'PDF Intereses: muestra total de intereses pagados',
    'PDF Capital + Intereses: muestra total de capital pagado',
    'Tasa % del prestamo visible en todos los PDFs',
    'Estado unificado en todos los cronogramas (Pagado, Mora, Pend.)',
    'Boton de cerrar modal reposicionado junto a la barra de arrastre'
  ],
  '1.6.0': [
    'Todos los emojis reemplazados por iconos SVG (consistentes en todos los dispositivos)',
    'Nuevos iconos: sparkle, clipboard, shield',
    'Iconos con colores tematicos en KPIs, titulos y estados vacios'
  ],
  '1.6.1': [
    'Boton "Liquidar deuda" en el perfil del deudor (paga capital + intereses en mora de un solo golpe)',
    'Dialogo de confirmacion estilizado con desglose de capital e intereses',
    'Abono a capital: muestra valor de liquidacion cuando hay cuotas en mora',
    'Abono del total del capital permitido (antes lo bloqueaba)',
    'Saldo del backend corregido: usa formula montoOrigen - capitalPagado',
    'Al liquidar: cuotas pendientes se eliminan, en mora se marcan pagadas, prestamo se cierra'
  ],
  '1.6.2': [
    'PDFs ahora respetan el tema activo (claro/oscuro) al 100%',
    'Recibo de pago con soporte completo de modo oscuro',
    'PDFs se guardan directamente con dialogo "Guardar como" (sin pasar por print)',
    'Fondos oscuros garantizados en PDF via Electron printToPDF'
  ],
  '1.7.0': [
    'Interfaz de escritorio: ventana completa con sidebar permanente',
    'Sidebar con navegacion, titulo y version de la app',
    'Header con nombre de la vista actual, badges de mora y busqueda',
    'Sidebar colapsable con boton hamburguesa',
    'Dashboard con KPIs en grid responsivo (se expanden al ancho)',
    'Fix zona horaria: fechas ahora usan hora local (no UTC)',
    'Liquidar deuda completa desde el perfil del deudor',
    'Valor de liquidacion visible en modal de abono a capital'
  ],
  '1.7.1': [
    'Recibo PDF mejorado: muestra cuantas cuotas quedan del total',
    'Recibo PDF: indica "... y N cuotas mas" cuando quedan mas de 3',
    'Espaciado corregido entre secciones del Dashboard',
    'Nombre sugerido al guardar cronograma PDF incluye monto y nombre'
  ],
  '1.7.2': [
    'Recibo PDF mejorado: muestra cuantas cuotas quedan del total',
    'Recibo PDF: indica "... y N cuotas mas" cuando quedan mas de 3',
    'Espaciado corregido entre secciones del Dashboard',
    'Nombre sugerido al guardar cronograma PDF incluye monto y nombre'
  ],
  '1.7.3': [
    'Recaudo del mes expandible: click para ver desglose de todas las cuotas del mes',
    'Desglose muestra fecha, nombre, tipo de pago y estado (pagado, mora, pendiente)',
    'Cuotas pagadas aparecen con check verde y opacidad reducida',
    'Nombres clickeables en el desglose para abrir perfil del deudor'
  ],
  '1.7.4': [
    'Tamaño de fuente aumentado en toda la app para mejor lectura en escritorio',
    'Boton "Ver cronograma" en perfil de deudor con color neutro (ya no se confunde con "Abono")'
  ],
  '1.7.5': [
    'Formato automatico de numeros: los montos se formatean con puntos de miles mientras escribes',
    'Aplica en: calculadora, crear prestamo, abonos, pagos USD y TRM'
  ],
  '1.7.6': [
    'Reorganizacion interna del codigo en carpetas /desktop y /backend',
    'Limpieza de codigo muerto y comentarios obsoletos',
    'Sin cambios visibles en la app — version de mantenimiento'
  ],
  '1.7.7': [
    'Pagos parciales en cuotas: abona una parte hoy y el resto despues',
    'Toggle "Pago completo / Pago parcial" en el modal de pago',
    'Cuotas con abono parcial muestran tag PARCIAL y sub-linea "Abonado $X de $Y" en la vista Pagos',
    'Campo de monto parcial con feedback en vivo: muestra cuanto quedaria pendiente al confirmar'
  ],
  '1.7.8': [
    'Boton rapido ✓ abre directamente el modal de pago (sin dialogo de confirmacion)',
    'Totales EN MORA, Vence Hoy y Proximas ya descuentan los abonos parciales recibidos',
    'Dashboard: sub-linea "Abonado $X de $Y" en listas de mora y recaudo del mes',
    'Barras de progreso en Cartera y Rendimiento basadas en monto recibido (no en conteo de cuotas)',
    'Recibo PDF diferenciado: "Abono Parcial", "Pago Final de Cuota" o "Pago Completo" segun corresponda'
  ],
  '1.7.9': [
    '— Novedades v1.7.7 al v1.7.9 —',
    'Pagos parciales en cuotas: abona una parte hoy y el resto despues',
    'Toggle "Pago completo / Pago parcial" en el modal de pago',
    'Cuotas con abono parcial muestran tag PARCIAL y sub-linea "Abonado $X de $Y" en la vista Pagos',
    'Campo de monto parcial con feedback en vivo: muestra cuanto quedaria pendiente al confirmar',
    'Boton rapido ✓ abre directamente el modal de pago (sin dialogo de confirmacion)',
    'Totales EN MORA, Vence Hoy y Proximas ya descuentan los abonos parciales recibidos',
    'Dashboard: sub-linea "Abonado $X de $Y" en listas de mora y recaudo del mes',
    'Barras de progreso en Cartera y Rendimiento basadas en monto recibido (no en conteo de cuotas)',
    'Recibo PDF diferenciado: "Abono Parcial", "Pago Final de Cuota" o "Pago Completo" segun corresponda',
    'Saldo pendiente en perfil del deudor descuenta correctamente los abonos parciales realizados',
    'Prestamos con abono parcial: tag "Parcial" y sub-linea visible sin necesidad de expandir',
    'Cronograma PDF: valor de liquidacion ajustado por abonos parciales acumulados',
    'Cronograma PDF: filas con pago parcial muestran monto pendiente y badge "Parcial"'
  ],
  '1.7.10': [
    'Deudores: saldo total en la card de cada deudor descuenta abonos parciales realizados',
    'Inicio: Cartera Activa descuenta abonos parciales de todos los prestamos activos',
    'Rendimiento: Saldo pendiente por prestamo y KPI global ya descuentan abonos parciales'
  ],
  '1.8.0': [
    'Nuevo boton "X" en Cartera para cerrar un prestamo a la fuerza cuando ya no se va a recuperar',
    'Antes de cerrar te muestra cuanto vas a perder: capital pendiente, intereses en mora y total',
    'Ahora se diferencia entre "Finalizado" (terminado con exito) y "Cancelado" (cerrado con perdidas)',
    'La pestaña Finalizados de Cartera agrupa ambos tipos con su etiqueta de color: verde para finalizado, rojo para cancelado',
    'Al expandir un prestamo terminado aparece un resumen claro: ganancia obtenida, capital recuperado, cuotas pagadas',
    'Si el prestamo fue cancelado, el resumen muestra ademas capital perdido, intereses perdidos y monto total perdido',
    'Ganancia y capital pueden mostrarse en negativo cuando el prestamo se cerro con perdidas',
    'Perfil del deudor: tarjetas del historial de creditos rediseñadas con banda de color y ganancia o perdida bien visible',
    'Rendimiento: las tarjetas de prestamos cancelados muestran la perdida total en rojo en vez de "Saldado"'
  ],
  '1.8.1': [
    'Liquidar deuda: nuevo modal con desglose claro (capital, intereses en mora, total a pagar)',
    'Opcion para incluir un mes adicional de intereses al liquidar — el total se actualiza al instante',
    'El boton de liquidar ahora dice solo "Liquidar deuda" (el monto se ve dentro del modal)',
    'Ventana de Abono a Capital: caja informativa que explica como se aplica tu abono segun el prestamo',
    'Aclara que el abono va al capital y NO descuenta intereses en mora (para eso usa Liquidar deuda)',
    'Cronograma del deudor: dos columnas nuevas (Capital e Interes) para ver el desglose de cada cuota'
  ],
  '1.8.2': [
    'Nuevo boton "Cambiar fecha de pago" en cada prestamo activo del perfil del deudor',
    'Permite mover el dia de pago (ej. del 15 al 30) calculando un prorrateo justo de los dias extra',
    'Si el cliente tiene cuotas en mora, se consolidan en la primera cuota nueva — un solo cobro',
    'Antes de confirmar veras el desglose: cuotas en mora + interes del mes + prorrateo + total',
    'Despues de confirmar aparece un comprobante visual con fecha nueva, primera cuota y cuotas siguientes',
    'Las cuotas en mora ya no apareceran en mora porque el sistema se reagenda automaticamente',
    'Aplica para modalidades Intereses y Capital + Intereses (no para prestamos sin interes)'
  ],
  '1.8.3': [
    'Recibo PDF ahora incluye el monto del prestamo en el nombre del archivo',
    'Util cuando un deudor tiene varios prestamos activos: identificas a cual corresponde el recibo',
    'Formato: "Recibo Prestamo $1.500.000 - Nombre del Cliente - Cuota 3.pdf"',
    'Ajuste tipografico general: jerarquia visual mas clara entre totales y valores individuales',
    'Inicio: totales de cada seccion en semibold, montos individuales mas ligeros',
    'Pagos: totales mas grandes (15px) y montos individuales mas pequeños (14px)',
    'Perfil del deudor, Cartera y Rendimiento: pesos balanceados sin saturar la lectura'
  ],
  '1.8.4': [
    'Prestamos en USD: ahora puedes registrar compras fraccionadas de dolares a distintas tasas',
    'Switch "¿Compraste el USD en varias partes/tasas?" al crear un prestamo USD',
    'Agrega cuantas filas necesites con monto USD y tasa COP de cada compra',
    'El sistema calcula automaticamente la tasa promedio ponderada y el total invertido en COP',
    'Bloquea la creacion si el total de compras excede el monto del prestamo',
    'Aviso amarillo si te faltan dolares por registrar (te deja crear igual)',
    'El desglose de compras queda visible en el perfil del deudor al expandir el prestamo'
  ],
  '1.8.5': [
    'Cambio de fecha de pago: ahora el prorrateo se conserva aunque presiones "Sincronizar datos"',
    'Antes el boton de sincronizar borraba el monto extra del prorrateo. Solucionado.',
    'Ganancia obtenida unificada en toda la app: Inicio y Rendimiento ahora muestran el mismo valor',
    'Para prestamos USD la ganancia incluye los intereses cobrados + la utilidad por subida de TRM al cobrar',
    'Nuevo desglose de ganancia para prestamos USD en el perfil del deudor:',
    '  • Ganancia interes (intereses puros del contrato)',
    '  • Ganancia/Perdida TRM (verde si subio al cobrar, rojo si bajo)',
    '  • Ganancia total',
    'Visible tanto en prestamos activos como finalizados',
    'Formulario de crear/editar prestamo mas robusto: la tasa y el plazo ya no pueden quedarse desactualizados',
    'Acepta indistintamente coma o punto como decimal (ej: 12,152 o 12.152)',
    'Debajo de la tasa aparece "Se aplicara: X% mensual" para verificar el valor exacto antes de guardar',
    'Debajo del plazo aparece la cuota mensual calculada en tiempo real'
  ],
  '1.8.6': [
    'Fix definitivo del prorrateo: ahora el monto extra del cambio de fecha sobrevive a cualquier accion',
    'Antes el prorrateo desaparecia si presionabas Sincronizar o editabas el prestamo despues',
    'Ahora el sistema guarda el extra a nivel del prestamo y lo aplica automaticamente cada vez que se regenera el cronograma',
    'Cuando pagas la cuota con prorrateo, el sistema lo limpia automaticamente para que no vuelva a aparecer'
  ],
  '1.8.7': [
    'Formulario de nuevo prestamo: ahora puedes "Ver cronograma tentativo" directamente desde el Resumen, igual que en la Calculadora',
    'Se eliminó el cuadro azul redundante de "Cuota mensual calculada" (ya estaba en el Resumen)',
    'Fix de decimales en USD: ahora puedes escribir "6.50" sin que el sistema te borre el punto',
    'Aplica para "USD recibidos" en cobros completos y parciales y "USD del abono" en el modal de abono a capital',
    'Acepta tanto coma como punto como decimal',
    'Rediseño completo de la vista expandida de cada prestamo en el perfil del deudor:',
    '  • Saldo pendiente como dato principal arriba (mas grande y prominente)',
    '  • Estructura tipo factura con secciones claras: Datos, Ganancias, Estado, Compras USD, Acciones',
    '  • Lineas divisorias entre cada seccion para mejor legibilidad',
    '  • Menos bordes de colores compitiendo entre si (mas limpio)',
    'Etiquetas estandarizadas: ahora se usa "Ganancia por intereses" tanto en prestamos COP como USD (antes habia inconsistencia)',
    'Para prestamos USD el desglose ahora tiene 3 lineas claras: Ganancia por intereses + Ganancia/Perdida por TRM + Ganancia total'
  ],
  '1.9.0': [
    'Nuevo: al hacer un abono a capital ahora puedes elegir entre 3 modos: mantener el plazo (default), modificar el plazo o fijar el valor de la cuota',
    'Nuevo: boton "Reestructurar cuotas" en el perfil del prestamo (modalidad Capital + Intereses) para recalcular el cronograma sin tener que hacer un abono',
    'En ambos flujos, si hay cuotas que vencen en los proximos 5 dias, aparece un aviso pre-vuelo que te deja marcarlas en Mora antes de continuar (o absorberlas)',
    'Para prestamos en USD, el valor de la cuota (modo "fijar cuota") se ingresa directamente en dolares y el sistema lo convierte automaticamente',
    'Las cuotas ya pagadas y las cuotas en Mora ahora se preservan intactas al hacer abonos, reestructurar, editar el prestamo o presionar "Sincronizar datos" (deuda historica garantizada)',
    'Editar prestamo: si el prestamo ya tiene actividad (pagos, abonos o mora), los campos sensibles (moneda, monto, tasa, modalidad, plazo, fechas, etc) quedan bloqueados con un aviso amarillo',
    'Solo quedan editables Nombre, Cedula, Telefono, Notas y Estado — para preservar la integridad del cronograma pactado',
    'Abonos USD ahora cuentan correctamente para la Ganancia/Perdida por TRM (igual que las cuotas regulares en USD)',
    'Anti-doble-click al crear prestamos: el boton se desactiva tras el primer click para evitar duplicados accidentales',
    'Cronograma en la pestaña Cartera ahora muestra las mismas columnas que el perfil del deudor: Capital + Interes + Deuda corrida + Cuota',
    'Tras una reestructuracion o abono, el perfil del deudor refresca los datos inmediatamente (ya no hace falta presionar Sincronizar)',
    'Mejora interna: las operaciones de abono y reestructurar son ahora atomicas — si algo falla, la base de datos no queda en estado intermedio'
  ],
  '1.9.2': [
    'Dashboard rediseñado por completo con un layout moderno tipo SaaS',
    'Nuevas tarjetas de KPIs con iconos en badges de color: Capital Original, Cobros del Mes, Saldo Pendiente y Ganancias',
    'Diferenciacion clara entre "Capital Original" (monto historico prestado) y "Saldo Pendiente" (capital actual por recuperar)',
    'Nueva barra de Acciones Rapidas: Nuevo prestamo, Pagos, Deudores y Calculadora',
    'Chips compactos arriba con conteo de deudores, prestamos COP/USD y cuotas en mora',
    'Las listas de "Vence Hoy", "Proximos 7 dias", "Mora" y "Transacciones recientes" ahora se organizan en una cuadricula 2x2 (en pantallas grandes)',
    'Las 4 secciones siempre se muestran con su titulo, incluso si no hay datos — con un mensaje amigable centrado',
    'Tipografia drastica en las cuotas: el valor a cobrar ahora es el protagonista visual (mas grande y bold), con el saldo del prestamo como dato secundario tenue',
    'En monitores grandes (>1180px) el dashboard ya no se estira de borde a borde — se mantiene centrado y compacto',
    'Botones de accion en el perfil del prestamo reorganizados en 3 niveles jerarquicos: Cobrar (verde), Ajustar cronograma (neutro) y Cronograma (ghost)',
    'Paleta de colores armonica entre los botones de Abono y Liquidacion (familia verde) — ya no compiten visualmente con tonos saturados',
    'Esta ventana de Novedades ahora tiene altura maxima y scroll interno: el titulo y el boton "Entendido" quedan fijos mientras la lista se desplaza comodamente',
    'Las 4 tarjetas del dashboard (Vence Hoy, Proximos, Mora, Transacciones) ahora tienen altura maxima fija con scroll interno: la simetria del grid 2x2 se preserva sin importar cuantos datos haya en cada una',
    'Nueva logica de "Recaudo del mes": el ESPERADO ahora cuenta solo las cuotas que vencen este mes (la mora arrastrada ya no contamina la meta). El RECIBIDO suma lo cobrado del mes mas la mora recuperada (cuotas viejas pagadas durante este mes).',
    'La barra de Recaudo cambia a dorado y muestra "META SUPERADA" cuando el % pasa de 100% (por ejemplo cuando se cobra cartera vencida)',
    'Fix critico: el boton "Sincronizar datos" ya no infla las cuotas Pendientes en prestamos Capital+Intereses con cuotas previamente pagadas. Antes usaba un saldo desactualizado y regeneraba cuotas con valores incorrectos (hasta 3x el monto real)',
    'Nueva pantalla de carga al abrir la app: ahora aparece una ventana ligera "Buscando actualizaciones..." mientras se verifica si hay version nueva en GitHub. Si la hay, se descarga e instala automaticamente sin tocar la base de datos. Solo si no hay actualizacion (o no hay internet) se procede a abrir la app normalmente.',
    'Esta proteccion garantiza que un bug en una version vieja nunca pueda corromper la base de datos: el codigo nuevo siempre se instala primero. El chequeo tiene un timeout de 60 segundos para no bloquear el inicio sin internet.'
  ],
  '1.9.3': [
    'La pantalla de carga al iniciar la app ahora muestra una cuenta regresiva de 60 segundos arriba del icono — sabes exactamente cuanto tiempo falta para que termine el chequeo de actualizaciones',
    'Si el chequeo no puede completarse (por ejemplo, sin internet), la pantalla ya no continua sola: ahora te muestra el mensaje "Problemas de conexion" y te da dos opciones claras: "Continuar" (abrir la app de todas formas, con el riesgo asumido) o "Cerrar app" (salir sin tocar nada)',
    'Esto da control total al usuario en situaciones de red inestable: si sabes que tu conexion esta floja pero quieres trabajar igual, sigues adelante; si prefieres reintentar mas tarde con buena senal, cierras la app limpiamente'
  ],
  '1.9.4': [
    'Mejora de seguridad: cuando la descarga de una actualizacion falla a mitad de camino (por ejemplo, se corta la conexion), la app ya no continua silenciosamente con la version anterior',
    'Ahora se muestra una pantalla de error con el mensaje "No se pudo descargar la nueva version" y un boton "Cerrar app" que es la unica accion disponible — esto te obliga a cerrar y abrir de nuevo para reintentar la actualizacion',
    'El objetivo: si una actualizacion existe es porque corrige algo importante (a veces un bug que puede afectar la base de datos). No queremos que sigas trabajando con la version vieja por error si la descarga fallo'
  ],
  '1.9.5': [
    'Cuando la descarga de una actualizacion falla, la pantalla de error ahora te da una segunda opcion ademas de "Cerrar app": el boton "Continuar de todos modos"',
    'Si elegis continuar, la app abre con la version actual asumiendo el riesgo — pensado para situaciones donde necesitas trabajar y el problema parece transitorio (servidor caido, WiFi inestable)',
    '"Cerrar app" sigue siendo la opcion recomendada y queda visible y primaria: cerrar y reabrir intenta la descarga de nuevo desde cero',
    'Asi tenes una puerta de escape sin perder la proteccion: la decision queda en vos en lugar de quedar bloqueado de tu herramienta de trabajo',
    'Mientras se descarga una actualizacion, ahora se muestra el porcentaje numerico junto a la barra (ej: "Descargando v1.9.5... 45%") para que tengas feedback exacto del avance'
  ],
  '1.10.0': [
    'Nueva modalidad de prestamo "Pago Unico" para negocios cortos: una sola cuota que vence en una fecha exacta que vos elegis, sin frecuencia ni cuotas periodicas',
    'Al crear un Pago Unico podes definir la ganancia de dos formas: por porcentaje sobre el capital (ej: 10%) o por monto fijo pactado (ej: prestar $300 y cobrar $50 de ganancia)',
    'Si elegis ganancia por monto fijo, la app calcula y te muestra en vivo el porcentaje equivalente; si elegis por porcentaje, te muestra el monto en dinero. Asi siempre ves las dos caras del trato',
    'Funciona con COP y con USD (con compras fraccionadas a distintas TRMs si aplica), igual que el resto de modalidades',
    'Cuando hagas un abono a capital sobre un Pago Unico, el capital baja pero la ganancia pactada se mantiene intacta — el deudor te termina pagando lo que se acordo desde el inicio',
    'Los KPIs del Inicio (Capital Original, Cobros del Mes, Saldo Pendiente, Ganancias) y las cards de Vence Hoy / Proximos 7 dias incluyen automaticamente los pagos unicos, sin cambios visuales necesarios'
  ],
  '1.10.1': [
    'En la pestaña Cartera, al desplegar el cronograma de un prestamo en dolares ya finalizado, ahora ves el resumen completo de ganancia: "Ganancia por intereses", "Ganancia/Perdida por TRM" y "Ganancia total"',
    'La ganancia/perdida por TRM (en verde si el dolar subio al cobrar, en rojo si bajo) ya estaba en la vista de Rendimiento; ahora tambien la tenes a mano directamente en Cartera sin cambiar de pestaña',
    'Aplica tanto a prestamos finalizados con exito como a los cerrados forzosamente (sobre lo que el deudor alcanzo a pagar). Los prestamos en pesos no muestran estas lineas porque no aplica'
  ],
  '1.10.2': [
    'La tarjeta "Pagos en Mora" del Inicio ahora muestra TODOS los pagos en mora (antes se cortaba en los primeros): la tarjeta mantiene su tamaño y el listado hace scroll interno cuando hay muchos',
    'El texto de ganancia/perdida por TRM ahora es dinamico en todas las vistas: dice "Ganancia por TRM" (verde) o "Perdida por TRM" (rojo) segun corresponda, en Cartera y en el perfil del deudor',
    'Antes en el perfil del deudor el titulo era fijo ("Ganancia/Perdida TRM"); ahora cambia segun el resultado real, igual que en la pestaña Cartera'
  ],
  '1.10.3': [
    'Mejoras internas de mantenimiento y estabilidad'
  ],
  '1.11.0': [
    'Cartera: cada barra de progreso ahora muestra el porcentaje exacto de avance (ej: 75%) junto a la barra',
    'Inicio: la tarjeta "Recaudo del mes" ahora tiene un selector de meses (‹ Mayo De 2026 ›) para navegar a periodos anteriores o futuros y revisar el recaudo de cada mes, sin afectar el resto del tablero',
    'Inicio: nuevos mini-graficos de tendencia en las tarjetas de KPIs — "Ganancias" muestra los ultimos 6 meses y "Cobros del Mes" la evolucion diaria del mes en curso, con ejes, cuadricula y valores de referencia'
  ],
  '1.11.1': [
    'Inicio: los mini-graficos de Ganancias y Cobros del Mes ahora son interactivos — pasa el cursor sobre un punto para ver el periodo y el monto exacto',
    'Los puntos con movimiento real se marcan en dorado; los dias o meses sin actividad quedan limpios (pero igual puedes ver su detalle al pasar el cursor)',
    'La tarjeta "Transacciones recientes" pasa a ser "Transacciones del Mes" y lista todas las transacciones del mes en curso (con scroll si hay muchas)',
    'Las transacciones del mismo dia se ordenan por la hora real en que las registraste (antes podian aparecer en desorden al compartir la misma fecha)'
  ],
  '1.11.2': [
    'Pantalla de carga mas prolija: textos sin puntos suspensivos y, durante una actualizacion, el porcentaje de descarga ahora se muestra junto a la barra de progreso'
  ],
  '1.11.3': [
    'Nuevo prestamo: ahora puedes asignar el credito a un cliente que ya existe — un buscador te deja elegirlo por nombre sin volver a escribir sus datos',
    'Calculadora de dolares: nuevo campo "Total pagado en COP" que calcula la tasa de cambio automaticamente (en el modo simple y en el desglose de varias compras)',
    'Inicio: la grafica de tendencia de "Ganancias" ahora muestra los ultimos 12 meses (antes 6)',
    'Cronograma PDF: ahora incluye la fecha de finalizacion del prestamo; para "Pago Unico" imprime la tasa/ganancia pactada y la frecuencia correcta (antes mostraba "Mensual")',
    'Recibo PDF: cuando un pago cancela la totalidad del prestamo, el recibo muestra un mensaje de felicitaciones'
  ],
  '1.11.4': [
    'Inicio: "Cobros del Mes" ahora refleja el flujo de caja real al instante — cada pago parcial suma al total y al mini-grafico el mismo dia en que lo recibes, sin esperar a que la cuota quede completa',
    'Inicio: los abonos a capital tambien se cuentan dentro de "Cobros del Mes" en su fecha de registro (antes quedaban fuera de ese indicador)'
  ],
  '1.12.0': [
    'La aplicacion estrena nombre: ahora se llama "Cartera". El cambio refleja que ya no solo administra lo que te deben (prestamos), sino tambien lo que tu debes (deudas) — tu cartera completa, en ambos sentidos, en un solo lugar',
    'Nuevo modulo "Mis Deudas" para llevar el control de tus propias obligaciones, con un sistema de cuenta rotativa de doble via: los abonos reducen el saldo y los cargos lo aumentan, ideal para cuentas que se mueven en ambos sentidos',
    'Cada deuda tiene su "Estado de cuenta" interactivo: una linea de tiempo en orden cronologico con todos los movimientos y una barra de progreso que muestra el avance real sobre el total (incluyendo los cargos)',
    'Mas proteccion para tu informacion: no puedes dejar una deuda con un monto menor a lo que ya abonaste, y las confirmaciones para eliminar usan ventanas propias de la app (claras y seguras) en lugar de los avisos del sistema',
    'Menu lateral renovado en formato acordeon (Prestamos y Deudas) que recuerda como lo dejaste la proxima vez que abres la app; tus acreedores se agrupan en Activos e Inactivos y se ordenan por antiguedad, igual que ya funcionaban los deudores',
    'Al crear un prestamo o una deuda, un buscador con autocompletado te sugiere clientes y acreedores que ya existen mientras escribes, con un diseño unificado en toda la app'
  ],
  '1.12.1': [
    'Ajuste visual: la pantalla de carga al iniciar ahora muestra el nuevo nombre "Cartera"',
    'Correccion: la ventana de novedades vuelve a aparecer automaticamente despues de cada actualizacion'
  ],
  '1.12.3': [
    'Hotfix: Correccion de calculo de tasa dinamica en previsualizacion bimonetaria.',
    'Mejora: Exportacion de PDFs eco-friendly sin margenes de sistema y actualizacion de metadatos corporativos.'
  ],
  '1.12.4': [
    'Hotfix critico: correccion matematica en el motor de amortizacion que inflaba las cuotas (in-app y en PDF) cuando el prestamo entraba en mora.'
  ],
  '1.12.5': [
    'Fix (Prestamos): corregida la inicializacion del modal de edicion de Pago Unico. Ahora reconstruye la ganancia como monto fijo absoluto, evitando calculos erroneos de porcentajes desbordados al cargar el formulario.'
  ],
  '1.12.6': [
    'Pagos en USD: si recibes la cuota completa en dolares pero la TRM bajo (entran menos pesos), el pago ya se marca como COMPLETO en vez de "parcial"; la diferencia queda registrada como perdida/ganancia por TRM.',
    'Pagos en USD: las "Transacciones del Mes", la lista de cobrados y el recibo ahora muestran los dolares realmente recibidos, no un valor recalculado desde los pesos a la tasa pactada.'
  ],
  '1.12.7': [
    'Recibo PDF: el campo "Fecha recaudo" ahora muestra la fecha real del pago que elegiste al registrarlo (antes imprimia siempre la fecha del dia en que se generaba el recibo). La "Fecha de emision" se mantiene con la fecha de impresion.'
  ],
  '1.12.8': [
    'Rendimiento: la ganancia en USD ahora muestra los dolares realmente recibidos (antes reconvertia los pesos por la TRM y daba un valor menor cuando el dolar se devaluaba).',
    'Rendimiento: los prestamos a 0% interes (modalidad Prestamo) ya no muestran su capital como ganancia; el resultado se etiqueta "Efecto TRM" y aclara si la diferencia viene de una subida o baja del dolar.',
    'Rendimiento: las ganancias negativas (perdida por TRM) se muestran en rojo.',
    'Rendimiento: los prestamos finalizados se ordenan del ultimo finalizado al mas antiguo.',
    'Rendimiento: en prestamos cerrados con perdida se especifica si proviene de intereses no cobrados, de capital no recuperado, o de ambos.',
    'Rendimiento: las tarjetas "Capital Colocado" y "Capital Recuperado" aclaran que suman solo prestamos activos.',
    'Perfil del deudor: nuevo bloque "Proyeccion de Ganancias" que compara lo ya cobrado contra la ganancia esperada del prestamo.'
  ],
  '1.12.9': [
    'Inicio: la tarjeta "Ganancias" usa la misma base de capital robusto que Rendimiento; ya no infla el historico contando el capital de prestamos a 0% interes (el total coincide en ambas vistas).',
    'Recibos PDF: mensaje dinamico segun la puntualidad del pago — agradecimiento si pagaste puntual o anticipado, o aviso con los dias exactos de retraso si llego tarde. El mensaje de liquidacion total ("Felicidades") mantiene prioridad.',
    'Rendimiento: las tarjetas "Capital Colocado" y "Capital Recuperado" aclaran que suman solo prestamos activos.',
    'Rendimiento y perfil del deudor: en prestamos a 0% interes en USD el resultado se rotula "Efecto TRM" e indica si la diferencia viene de una subida o baja del dolar; en prestamos cerrados con perdida se especifica si proviene de intereses no cobrados o de capital no recuperado.'
  ],
  '1.13.0': [
    'Prestamos cerrados: el resumen ahora arranca con "TOTAL RECIBIDO" (lo que realmente entro) y debajo desglosa capital, intereses y efecto TRM que lo componen — en Cartera y en el perfil del deudor.',
    'Prestamos activos: nuevo bloque "RECAUDADO A LA FECHA" que muestra cuanto se ha cobrado hasta hoy y como se reparte (capital recuperado a la fecha, intereses, efecto TRM), al final del cronograma en Cartera y en el perfil del deudor.',
    'La fila de capital en prestamos cerrados pasa a llamarse "Capital prestado": ya no dice "recuperado" cuando por una baja de la TRM en dolares recibiste menos pesos de los pactados.',
    'Las cifras en dolares (USD) muestran el valor real recibido/ganado y quedan consistentes entre Cartera, perfil del deudor y Rendimiento.'
  ],
  '1.13.1': [
    'Pago rapido (check verde) en Pagos: los prestamos a 0% interes (modalidad Prestamo) y los de pago unico ya se cobran directo con el check. Antes se bloqueaban mostrando por error una vista de "Detalle Abono Capital" que obligaba a liquidar desde el perfil del deudor.'
  ],
  '1.13.2': [
    'Prestamos a 0% interes (modalidad Prestamo) y de pago unico: al cobrar la ultima cuota, el prestamo ahora pasa automaticamente a Finalizado. Antes se quedaba en Activo aunque el saldo fuera $0 y seguia apareciendo como activo en todas las secciones.'
  ],
  '1.14.0': [
    'Cambiar fecha de pago: la primera cuota ahora es una "cuota transitoria" que cobra intereses solo por los dias REALES de su periodo (desde la ultima cuota pagada hasta la nueva fecha), en vez de un mes completo mas dias extra. Ya no se sobrecobra al adelantar la fecha de cobro.',
    'El modal desglosa la cuota transitoria: capital de la cuota (intacto) + intereses prorrateados (X dias) + total, para que se entienda de donde sale el monto; la mora previa se consolida por separado.',
    'Cambiar fecha de pago aplica solo a prestamos mensuales con cuotas periodicas (Intereses / Capital + Intereses).',
    'Mejoras internas de robustez en la identificacion de abonos a capital y el recalculo de cronogramas en todas las modalidades.'
  ],
  '1.15.0': [
    'Nuevo: "Descargar Reporte de Prestamos (PDF)" en la seccion Desarrollador. Genera un PDF con todos los prestamos activos: fecha, deudor, modalidad, tasa, la cuota por la que va el deudor (N/M o #N) con su valor en COP y USD, saldo pendiente y estado.',
    'Mapa de riesgo: los prestamos EN MORA aparecen primero (ordenados por el total de dinero vencido, de mayor a menor) y luego los AL DIA (por saldo pendiente). Bajo cada prestamo en mora se detallan sus cuotas atrasadas con los dias de retraso.',
    'El reporte totaliza el "capital total en la calle" al final y respeta el tema claro/oscuro activo.'
  ],
  '1.15.2': [
    'Reporte de Prestamos (PDF): la columna "Vencimiento" ahora muestra la fecha de la proxima cuota a cobrar (no la fecha de inicio del prestamo), y en prestamos con cuotas en mora la fila principal muestra el proximo ciclo regular pendiente mientras lo vencido se detalla en las sub-filas rojas.',
    'Reporte de Prestamos (PDF): el valor en USD tambien aparece en las cuotas en mora. Y cuando una cuota es transitoria (interes prorrateado por cambio de fecha), la fila principal conserva el numero y valor regular de referencia con la fecha del ciclo regular, y una sub-fila ambar detalla la cuota transitoria con su fecha y valor real a cobrar.',
    'Reporte de Prestamos (PDF): en prestamos con cuotas atrasadas, el badge de Estado de la fila principal dice "Pendiente" (neutral) en vez de "En mora", porque esa fila representa la proxima cuota que todavia no vence; las sub-filas rojas siguen alertando visualmente la mora del prestamo.',
    'Reporte de Prestamos (PDF): nueva seccion "Referencia de estados" al pie que explica, cada uno en su propia linea, los estados Al dia / Pendiente / En mora y el significado de las sub-filas roja (cuota vencida) y ambar (cuota transitoria).',
    'Recibo de Pago (PDF): si la cuota cobrada es transitoria, el recibo lo aclara con "(Cuota Transitoria / Interes Prorrateado)" junto al numero de cuota, para que tu archivo contable no quede descuadrado.'
  ],
  '1.15.3': [
    'Actualizacion automatica en Windows: corregido el error "No se pudo descargar la nueva version (ENOENT... rename temp-*.exe)" que aparecia al actualizar. Ahora la app descarga el instalador completo (no por partes) y, si falla, reintenta una vez limpiando los archivos temporales del updater, lo que evita ese fallo.'
  ],
  '1.16.0': [
    'Nuevo: Recibo de Cobro (Factura) en PDF desde la vista Pagos. Junto al boton verde de cobro, cada cuota pendiente tiene ahora un boton para generar un recibo formal de cobro, con un mensaje destacado que cambia segun el estado de la cuota: aviso de mora con los dias de atraso, recordatorio si vence hoy, o aviso de proximo vencimiento con los dias que faltan.',
    'El recibo muestra el total a pagar, el desglose de la cuota, los datos del prestamo y el saldo pendiente. En prestamos en dolares prioriza el USD como moneda principal, para un documento mas claro que entra siempre en una sola hoja. Si la cuota es transitoria (interes prorrateado por cambio de fecha), lo aclara junto al numero de cuota. Se descarga con el nombre "FC [Cliente] - C[Numero de cuota]".',
    'El recibo lleva un codigo de factura (FC-...) en el encabezado y el pie. Si el deudor no tiene cedula (o telefono) guardada, esos datos simplemente se omiten en vez de mostrar campos vacios o un "C.C. 0".',
    'Nuevo campo "Datos de pago" en la seccion Desarrollador: el texto que escribas ahi (cuentas, Nequi/Daviplata, a nombre de quien) aparece en el bloque "Como pagar" del recibo. Si lo dejas vacio, ese bloque no se muestra.',
    'Buscador de Pagos: ahora tambien puedes encontrar una cuota escribiendo su numero de factura (empieza a escribir "FC-").',
    'Reporte de Prestamos (PDF): el "Total vencido" y el "Capital total en la calle" ahora muestran ademas el equivalente sumado en dolares cuando hay prestamos en USD (ej: "Total vencido: $ 3.442.407 (Incluye USD $400.00)").'
  ],
  '1.16.1': [
    'Cambiar fecha de pago: corregido el calculo de la cuota transitoria cuando el nuevo dia adelantaria el cobro. Antes, mover el dia de pago a uno mas temprano (ej. del 30 al 15) proyectaba la primera cuota al mismo mes y prorrateaba solo unos pocos dias de interes; ahora la proyecta al mes siguiente ("nunca adelantar el cobro"), con el prorrateo de dias completo que corresponde a un aplazamiento. El aplazamiento se conserva aunque uses "Sincronizar" o edites el prestamo.',
    'El modal de cambio de fecha ahora muestra la fecha exacta proyectada de la primera cuota (ej. "PRIMERA CUOTA (15 de ago de 2026)") en vez de solo el numero del dia, y aclara que las siguientes se cobran el dia elegido de cada mes.'
  ],
  '1.17.0': [
    'Nuevo: Recibo de Abono a Capital en PDF. Cada vez que registras un abono —desde la vista Cartera, desde el perfil del deudor o al liquidar una deuda— se genera automaticamente un recibo que confirma el monto recibido, la fecha y el nuevo saldo pendiente.',
    'En prestamos de Capital + Intereses el recibo incluye el cronograma de pagos actualizado completo (cuota por cuota, con interes, abono a capital, valor y saldo) y un bloque de impacto que se adapta a como recalculaste: si mantuviste el plazo muestra cuanto bajo la cuota y cuantos intereses te ahorras; si modificaste el plazo muestra cuantas cuotas menos quedan; y si fijaste la cuota muestra la nueva cuota pactada.',
    'Si el abono salda el prestamo por completo, el documento se convierte en un Paz y Salvo que certifica que no queda saldo pendiente.',
    'En prestamos sin cronograma amortizable (Intereses, Prestamo y Pago Unico) se genera una version corta del recibo con el monto abonado, la fecha y el nuevo saldo.'
  ],
  '1.17.1': [
    'Corregido un error que podia registrar el MISMO abono dos veces cuando el boton recibia un doble clic (o un doble evento): se guardaba dos veces con milisegundos de diferencia y descontaba el doble del capital. Ahora el boton se bloquea y muestra "Registrando..." mientras se guarda el abono.',
    'El modal de abono tiene un nuevo check "Generar recibo de abono" para decidir si quieres el PDF o no, igual que ya existia al registrar un pago.',
    'El recibo de abono ahora incluye, entre el impacto y el cronograma, el valor exacto para liquidar la deuda hoy: "¿Quieres liquidar la deuda hoy?". Se calcula igual que el modal "Liquidar deuda" (capital pendiente + intereses en mora - abonos parciales en curso, sin los intereses futuros del cronograma), asi que las dos cifras siempre coinciden.',
    'El recibo de abono se descarga con el monto en el nombre del archivo (ej. "AB Nombre del Cliente - $560.000") en vez de un consecutivo, para que sea mas facil de encontrar.'
  ],
  '1.18.0': [
    'Todos los cronogramas de la app y de los PDF usan ahora las MISMAS columnas y los mismos nombres: # / Vence / Interes / Abono a capital / Valor cuota / Saldo / Estado. Antes cada pantalla usaba terminos distintos ("Fecha" o "Vence", "Capital" o "Abono a capital", "Deuda" o "Saldo") y costaba comparar un documento con otro.',
    'El Cronograma de Pagos en PDF ahora desglosa cuanto de cada cuota es interes y cuanto es abono a capital. Antes solo mostraba el valor total de la cuota.',
    'La columna "Saldo" muestra el saldo que queda DESPUES de pagar cada cuota, igual que en el Recibo de Abono. Antes la columna "Deuda" de la app mostraba el saldo ANTES de la cuota, lo que hacia que los numeros parecieran corridos un renglon frente al PDF y al recibo. Los valores no cambiaron: cambia cual de los dos saldos se muestra.',
    'Los abonos a capital aparecen ahora intercalados en la fecha en que se hicieron, dentro del cronograma de la app (en Cartera y en el perfil del deudor), con su propia fila azul marcada como "Abono". Antes se listaban aparte al final y no se veia en que punto del cronograma habian entrado.',
    'Corregido: en los prestamos sin intereses la cuota mostraba "$0" de abono a capital pese a que el saldo quedaba en cero. Ahora muestra el capital real, y en toda cuota se cumple que Interes + Abono a capital = Valor cuota.',
    'Corregido: en prestamos en dolares el desglose podia descuadrar un centavo (por ejemplo 363,25 + 96,74 = 459,99 en una cuota de 460,00). Ahora la suma es exacta.'
  ],
  '1.18.1': [
    'Blindaje contra el doble clic en TODAS las pantallas que guardan algo. En 1.17.1 se corrigio el abono, que llego a registrarse dos veces; ahora la misma proteccion cubre registrar un pago, reestructurar cuotas, cambiar la fecha de pago, liquidar una deuda, el aviso de cuotas proximas a vencer, y crear deudas o registrar movimientos en Mis Deudas. Mientras se guarda, el boton se bloquea y avisa que esta procesando.',
    'Corregido un error que podia mostrar "Pago registrado" aunque el pago NO se hubiera guardado: si fallaba la conexion, la pantalla se cerraba igual y anunciaba exito. Ahora, si algo falla, la ventana se queda abierta con el error a la vista.',
    'El boton de reestructurar se desbloqueaba a los 5 segundos aunque la operacion siguiera en curso. Ahora espera a que termine de verdad.',
    'Si una operacion falla o se cancela, el boton vuelve a habilitarse solo: ya no se queda bloqueado obligandote a cerrar y reabrir la ventana.'
  ],
  '1.18.2': [
    'Corregido de raiz un saldo fantasma en los prestamos sin intereses (modalidad "Prestamo"): algunos aparecian con saldo pendiente aunque ya estuvieran totalmente pagados. La app ahora guarda correctamente el capital de estos prestamos y sanea automaticamente los que ya existian, sin que tengas que hacer nada.'
  ],
  '1.19.0': [
    'Corregido un error critico que impedia LIQUIDAR un prestamo de Capital + Intereses que tuviera cuotas en mora: el sistema rebotaba el cobro con "El abono supera el saldo actual" aunque el cliente estuviera pagando exactamente lo que debia. Ahora la liquidacion se acepta correctamente y el prestamo se cierra.',
    'El modal "Liquidar deuda" ahora muestra el desglose completo y transparente: capital pendiente, intereses atrasados (con el numero de cuotas y su valor por mes), el interes adicional opcional del proximo mes, y el total a liquidar. Ese mismo valor aparece identico en el cronograma PDF y en el recibo de abono — todo sale de un unico calculo central, asi que nunca hay dos cifras distintas.',
    'Reporte de Prestamos Activos (PDF): las cuotas en mora ahora dicen "vencio el [fecha]" en vez de "vence el [fecha]", ya que esa fecha ya paso.'
  ],
  '2.0.0': [
    'Los abonos a capital ya no rebotan cuando el prestamo tiene cuotas en mora. Antes, si intentabas abonar un monto que incluia el capital retenido en esas cuotas, el sistema lo rechazaba con un error confuso aunque el cliente estuviera entregando exactamente lo que debia. Ahora el modal te muestra por separado cuanto es "abonable a capital" y cuanto esta retenido en mora, y topa el abono en la cifra correcta.',
    'Nuevo boton "Liquidar deuda" dentro del abono: si el dinero que recibiste supera el capital abonable porque alcanza tambien para cuotas en mora, el modal te explica por que y te lleva de un clic a la liquidacion, que si cobra capital + intereses atrasados de una sola vez.',
    'La liquidacion ahora se puede abrir desde cualquier parte de la app (antes solo existia dentro del perfil del deudor).',
    'Abonos en dolares con doble entrada: ahora registras por separado los USD del abono (que definen cuanto capital se descuenta, a la TRM pactada) y los COP que realmente recibiste. La app calcula en vivo la TRM implicita y te muestra en verde o rojo la ganancia o perdida por el movimiento del dolar. Antes esa diferencia cambiaria no quedaba registrada en ninguna parte.',
    'Mensajes de error mas claros al abonar: te dicen cual es el maximo, por que lo es, y a que herramienta acudir para cobrar el resto.'
  ],
  '2.2.0': [
    'NUEVO: "Ver flujo de caja" en el perfil de cada deudor. Dentro de un prestamo (activo o ya cerrado) puedes desplegar el historial REAL de movimientos: que entro, cuanto y en que fecha se recibio de verdad. No es el cronograma teorico, es lo que realmente paso, con los pagos de cuota, los abonos a capital, los pagos parciales y las liquidaciones en orden cronologico.',
    'Cada movimiento muestra cuanto fue interes y cuanto abono a capital, el saldo que iba quedando, y si el pago llego puntual o con cuantos dias de atraso. Al final, los totales cuadran con el resumen del prestamo.',
    'Los cobros muy antiguos (anteriores a que la app registrara el efectivo exacto) se marcan con un asterisco: la fecha es la real, pero el monto se reconstruye del valor de la cuota. Preferimos avisarlo antes que mostrar un dato como si fuera exacto.',
    'Corregido el redondeo del cronograma: la ultima cuota podia aparecer con $1 de diferencia frente a las demas (por ejemplo $105.999 en un credito de cuotas de $106.000), lo que parecia un error del recibo. Ahora todas las cuotas valen exactamente lo pactado.',
    'Ese mismo fix corrige un descuadre interno que no se veia: la suma de los abonos a capital podia superar en $1 el monto prestado. Ahora cuadra exacto, siempre.',
    '[BUGFIX v2.1.2] Fix de botones deshacer huerfanos y correccion de saldos parciales en PDF de prestamos activos.',
    '[HOTFIX v2.1.1] Esta es la version corregida del despliegue 2.1.0, que no alcanzaba a abrir (se quedaba en pantalla negra al iniciar). Ya esta solucionado y todo lo de abajo llega funcionando.',
    'NUEVO: boton Deshacer en el Historial. Si registras un pago, un abono, una liquidacion, una reestructuracion, un cierre forzoso, un cambio de fecha o cualquier movimiento de Mis Deudas por error, ahora puedes revertirlo y la app restaura el estado EXACTO que tenia antes: las cuotas, el saldo, las fechas y hasta los recibos internos vuelven como estaban.',
    'Solo se puede deshacer la ultima operacion de cada prestamo o deuda. Las anteriores muestran el boton apagado y te dicen cual tienes que deshacer primero, para que nunca se destape un movimiento sobre el que ya construiste otro.',
    'Antes de revertir aparece una confirmacion con el detalle de lo que se va a deshacer. Si la operacion tiene mas de 24 horas te lo advierte, y si movio dinero te recuerda que es probable que el cliente ya tenga un recibo PDF en sus manos con esa informacion.',
    'El historial NO se borra: la operacion queda marcada como revertida y se agrega el registro de que la deshiciste. Siempre queda la huella completa de lo que paso.',
    'Se guardan las ultimas 200 operaciones (o 90 dias) como puntos de retorno.',
    'Corregido un error que podia BORRAR el pago de una cuota: si un deudor te pagaba una cuota dejando otras mas viejas en mora y despues le cambiabas el dia de pago, ese pago desaparecia y su deuda subia sola. Ahora las cuotas ya pagadas quedan protegidas.',
    'La tarjeta "Transacciones del Mes" del Inicio ahora si muestra los abonos parciales, en la fecha real en que recibiste el dinero (antes solo listaba cuotas pagadas por completo, asi que un pago parcial no aparecia en ninguna parte).'
  ]
  ,'2.3.0': [
    'Los PAGOS PARCIALES ahora cuentan en toda la app. Antes, si un cliente abonaba una parte de la cuota, el dinero entraba pero el Capital recuperado, los Intereses cobrados y el Saldo no se movian hasta que la cuota quedaba completa. Ya no: cada peso se refleja en el momento en que entra.',
    'Cada pago se reparte entre interes y capital siguiendo la regla legal: primero cubre el interes del periodo y el sobrante baja el capital. Eso se ve fila por fila en el flujo de caja del deudor.',
    'Corregido el reparto absurdo del flujo de caja: si una cuota se pagaba en dos veces, el segundo pago cargaba con el interes y el capital COMPLETOS. Una fila de $50.000 llegaba a declarar $450.000 en rubros. Ahora cada fila cuadra: interes + capital = lo que entro.',
    'El saldo del prestamo baja con cada abono parcial, no de golpe cuando se cierra la cuota.',
    'IMPORTANTE: los pagos parciales ya no se pierden. Si registrabas un abono a capital, reestructurabas o cambiabas el dia de cobro mientras una cuota tenia un pago parcial encima, el registro de ese dinero se borraba y el sistema volvia a exigir la cuota completa. Corregido.',
    'RECIBO DE COBRO: ya no cobra intereses que el abono parcial habia cubierto. Antes el desglose mostraba los valores completos de la cuota debajo de un total ya descontado.',
    'RECIBO DE COBRO en dolares: ya no exige de mas cuando la TRM del dia fue menor a la pactada. Ahora mide lo que falta en dolares contra los dolares que el cliente entrego.',
    'RECIBO DE PAGO: cuando el pago es parcial, ahora dice a que se aplico el dinero (cuanto a interes y cuanto a capital). Antes esas dos lineas simplemente no se imprimian.',
    'RECIBO DE PAGO: solo se genera si el pago quedo realmente registrado. Antes se imprimia primero, asi que un fallo de conexion podia dejar en manos del deudor el comprobante de un pago que nunca se guardo.',
    'RECIBO DE ABONO: el cronograma que imprime ya descuenta lo que el deudor abono parcialmente; antes lo volvia a cobrar en el TOTAL A PAGAR.',
    'REPORTE DE PRESTAMOS ACTIVOS y CRONOGRAMA en PDF: muestran el mismo saldo que ves en pantalla. Antes los documentos y la app podian dar cifras distintas del mismo prestamo.',
    'NUEVO en el flujo de caja de prestamos en dolares: columna Efecto TRM, que muestra cuanto se perdio o gano por el cambio en cada cobro. Interes + Capital + Efecto TRM = lo que entro.'
  ],
  '2.4.0': [
    'Reorganizacion interna del codigo. La app funciona exactamente igual: no cambia ninguna cifra, ningun calculo ni ninguna pantalla.',
    'El proyecto pasa de dos archivos gigantes a modulos separados, lo que hace mas rapido y seguro corregir errores y agregar cosas nuevas.',
    'Se anadio una bateria de pruebas automaticas que revisa los saldos, los cobros, los 5 documentos PDF y los 25 servicios internos antes de cada entrega.'
  ]
};
