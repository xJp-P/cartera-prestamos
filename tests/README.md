# Suite de verificación — Cartera

Instrumental de la **Etapa 0** del refactor de los dos monolitos
(`public/index.html`, `backend/server.js`).

Existe por una razón concreta: **el refactor es puramente organizativo**, así que
cualquier cambio de comportamiento es un error por definición. Esta suite es el
detector de humo. Se construyó y se dejó **en verde sobre el código sin tocar**
(v2.3.0, commit `1677663`) *antes* de mover una sola línea, para que a partir de
ahí cualquier rojo signifique "lo rompí yo".

---

## Cómo se corre

```bash
node tests/run-all.js
```

Eso es todo. Otros modos:

```bash
node tests/run-all.js --solo syntax,hooks-order
```

```bash
node tests/run-all.js --actualizar
```

Y para levantar la app real y mirarla en un navegador:

```bash
node tests/serve.js --puerto 3421
```

### Por qué se relanza solo bajo Electron

`better-sqlite3` está compilado para el **ABI de Electron** y **no carga en Node
standalone** (convención #5 del proyecto). Node v18 del sistema falla con
`ERR_DLOPEN_FAILED`; `ELECTRON_RUN_AS_NODE=1` da un Node v20.9 con el ABI correcto.

`run-all.js` y `serve.js` **detectan esto y se relanzan solos**, así que basta con
`node`. Si corrés un suite suelto, hacelo así:

```bash
ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron tests/e2e-api.js
```

> Esto mejora el plan original, que preveía *copiar* `server.js` a un entorno
> aislado con un binding de Node aparte. No hace falta: los tests hacen
> `require('../backend/server')` sobre el archivo **real, en su sitio**. Menos
> pasos y, sobre todo, cero riesgo de que la copia se desincronice del original.

---

## Qué hay adentro

| Suite | Qué protege |
|---|---|
| `syntax.js` | Sintaxis de `backend/`, `desktop/` y del frontend. Sigue validando cuando el inline se convierta en módulos ES. |
| `hooks-order.js` | Que ningún hook quede por debajo de un `return` condicional — **el Bug #40**, la pantalla negra de v2.1.0. |
| `props-dominio.js` | Invariantes de `imputarCobros`, `cobrosDe`, `saldoConCaja`, `pendienteDeCuota`, `flujoCajaDe` y `computeLiquidacion` sobre las 157 cuotas reales. |
| `pdf-render.js` | Que los 5 generadores de PDF sigan produciendo la misma estructura de documento. |
| `e2e-api.js` | Los 25 endpoints contra el `server.js` real, con *golden master* y round-trip de undo. |

Y el andamiaje:

| Archivo | Rol |
|---|---|
| `lib/paths.js` | Rutas canónicas. |
| `lib/db.js` | **Único** punto por el que se obtiene una BD escribible: siempre una copia. |
| `lib/load-frontend.js` | **El punto de costura del refactor** (ver abajo). |
| `lib/report.js` | Aserciones y reporte, sin dependencias. |
| `serve.js` | Levanta el backend real sobre una copia, para abrir la app en un navegador. |
| `run-all.js` | Corre todo y devuelve un solo exit code. |
| `golden/` | Snapshots de referencia. |

---

## Las tres reglas que rigen este directorio

### 1. Prohibido el verde en vacío

Es **el** modo de fallo que esta suite existe para evitar. El `syntax.js` de la
sesión anterior se saltaba los `<script src=…>` y, si no encontraba bloque inline,
imprimía *"0 bloques validados"* y **salía con exit 0**. Un verde que no verificaba
nada, justo cuando el refactor iba a eliminar ese bloque inline.

Por eso, en toda esta suite:

- si un suite no logró afirmar nada, **sale con exit ≠ 0**;
- si falta un archivo de suite, `run-all.js` lo cuenta como **fallo**, nunca como éxito;
- `load-frontend.js` **lanza** si `index.html` ya no tiene inline, con instrucciones
  de qué actualizar, en vez de devolver 0 símbolos silenciosamente;
- `hooks-order.js` **se auto-prueba antes de opinar**: corre un control positivo y
  cuatro negativos, y si su propio analizador está ciego, lo reporta como fallo.

### 2. La BD de producción no se toca

`C:\Users\juanp\Desktop\bd_App_PTM_Backup\cartera.db` es la BD real del usuario.
Ningún test la abre para escribir. Las rutas escribibles salen **solo** de
`lib/db.js`, que copia a `%TEMP%\cartera-tests\` y **aborta** si alguna vez se le
pide devolver la ruta productiva.

### 3. Esto no reemplaza abrir la app

`new Function` valida **sintaxis, no ejecución** — la lección del Bug #40. Un error
en tiempo de render pasa limpio esa validación, y los arneses que renderizan
componentes *en aislamiento* tampoco lo ven, porque hay que atravesar el ciclo de
vida `loading` para que aparezca.

**Todo cambio que toque `App` o un camino de render se verifica cargando la app
real**, con 0 errores de consola:

```bash
node tests/serve.js --puerto 3421
```

Baseline registrado sobre v2.3.0 sin modificar: **0 mensajes de consola**, `#root`
con 488 elementos, datos reales en pantalla (`CAPITAL ORIGINAL $ 40.586.369`,
12 activos), tema oscuro aplicado. `window.electronAPI` queda `undefined` en un
navegador y el código lo maneja: es un camino legítimo, no un fallo.

---

## El punto de costura: `lib/load-frontend.js`

Los tests ejercitan el **código real** del frontend, no una reimplementación. Hoy
`public/index.html` lleva un único `<script>` inline (líneas 121-6593); el loader lo
extrae y lo **ejecuta en un contexto `vm`**, con lo que toda declaración top-level
(`function X`, `var X`) queda accesible:

```js
const { cargarFrontend } = require('./lib/load-frontend');
const { simbolos, captura } = cargarFrontend({ silenciarConsola: true });

simbolos.imputarCobros(pay);            // el helper real, no una copia
simbolos.generateFacturaCobro(...);     // el HTML aparece en captura.pdfs
```

Se ejecuta de verdad (no `new Function`) precisamente para que un error de carga
**falle acá** en vez de aparecer como pantalla negra. Y `Object.keys` sobre el
contexto evita mantener a mano una lista de 75 símbolos.

El entorno de navegador está stubeado: React/ReactDOM, `document`, `localStorage`,
y `window.electronAPI.printPDF`, que es por donde emiten los 5 generadores de PDF —
de ahí que el HTML resultante caiga en `captura.pdfs`.

> **Cuando la Etapa 3 convierta el inline en módulos ES, se cambia
> `cargarFrontend()` y nada más.** El resto del arnés no se entera. Y si alguien
> hace el cambio sin actualizar el loader, este lanza un error que dice exactamente
> qué tocar — no un falso verde.

---

## Nota sobre las cifras

Los conteos que imprimen los suites (157 cuotas, 26 préstamos, 29 componentes,
25 endpoints) salen de medir, no de asumir. Si el refactor los mueve, los suites
lo dicen: varios tienen umbrales mínimos (`>= 20 componentes`, `>= N endpoints`)
que fallan si de golpe están mirando al lugar equivocado.
