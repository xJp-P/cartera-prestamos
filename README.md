# Cartera

App de escritorio para gestionar tu cartera de credito personal en ambos sentidos: lo que te deben (prestamos que otorgas) y lo que tu debes (tus propias deudas). Registra prestamos, cobra cuotas, genera recibos, lleva el seguimiento de tus deudores y controla tus obligaciones, todo en un solo lugar.

## Funcionalidades

- **Prestamos en COP y USD** con conversion automatica via TRM (incluye compras fraccionadas a distintas tasas); al crear puedes asignar el prestamo a un **cliente existente** (buscador por nombre) o registrar uno nuevo
- **4 modalidades:** Intereses (plazo indefinido), Capital + Intereses (amortizacion francesa), Prestamo (0% interes), Pago Unico (una cuota en fecha exacta + ganancia pactada por % o monto fijo)
- **Frecuencia de cobro:** semanal, quincenal o mensual
- **Abonos a capital** con recalculo automatico del cronograma (mantener plazo, modificar plazo o fijar cuota). El modal distingue el capital **abonable** del que esta retenido en cuotas en mora y topa el abono en la cifra correcta; si el dinero recibido alcanza tambien para esa mora, te ofrece pasar de un clic a **Liquidar deuda** (que cobra capital + intereses atrasados de una vez). En prestamos en USD pide **doble entrada**: los dolares del abono, que definen el capital a descontar a la TRM pactada, y los COP realmente recibidos — con la TRM implicita y el efecto cambiario calculados en vivo
- **Reestructuracion** de cronograma sin necesidad de abono (Capital + Intereses)
- **Recibos PDF** generados al registrar un pago, con mensaje segun la puntualidad (agradecimiento por pago puntual/anticipado o aviso con los dias de retraso)
- **Recibo de Cobro (Factura) en PDF** desde la vista Pagos: por cada cuota pendiente generas un recibo formal con un mensaje que cambia segun el estado de la cuota (aviso de mora con los dias de atraso, recordatorio si vence hoy, o aviso de proximo vencimiento con los dias que faltan). Muestra el total a pagar, el desglose de la cuota y el saldo, prioriza el dolar en prestamos en USD, lleva un codigo de factura (FC) y un bloque "Como pagar" configurable en Desarrollador. Se descarga como "FC [Cliente] - C[cuota].pdf"
- **Recibo de Abono a Capital en PDF** al registrar un abono (desde Cartera, desde el perfil del deudor o al liquidar), con un check para generarlo o no: confirma el monto recibido y el nuevo saldo, incluye el cronograma de pagos actualizado con el impacto del abono (cuanto bajo la cuota, cuantas cuotas menos quedan o la nueva cuota fija, segun como recalcules) y te dice cuanto costaria liquidar la deuda ese mismo dia. Si el abono salda el prestamo, el documento se convierte en un Paz y Salvo
- **Cronograma PDF** con valor de liquidacion desde el perfil de cada deudor, con el desglose de cuanto de cada cuota es interes y cuanto abono a capital
- **Cronogramas unificados:** todas las tablas de cuotas (en la app y en los PDF) usan las mismas columnas y los mismos nombres — Vence, Interes, Abono a capital, Valor cuota, Saldo y Estado — y los abonos a capital aparecen intercalados en la fecha en que se hicieron, para que puedas comparar cualquier documento con otro sin traducir terminos
- **Reporte de Prestamos Activos en PDF** (desde Desarrollador): mapa de riesgo con los prestamos en mora primero (ordenados por dinero vencido) y luego los al dia (por saldo pendiente), la cuota actual de cada deudor con su valor en COP/USD, las cuotas atrasadas detalladas y el capital total en la calle (el total vencido y el capital en la calle muestran tambien el equivalente sumado en dolares cuando hay prestamos en USD)
- **Dashboard** con KPIs (capital original, recaudo del mes, saldo pendiente, ganancias, mora y proximos vencimientos), selector de meses en el recaudo para revisar periodos pasados y mini-graficos de tendencia en las tarjetas
- **Perfiles de deudores** con historial completo de creditos y proyeccion de ganancia esperada por prestamo
- **Mis Deudas (lo que tu debes):** modulo de cuenta rotativa de doble via para llevar el control de tus propias deudas — registra abonos que reducen el saldo y cargos que lo aumentan, con estado de cuenta cronologico y barra de progreso por acreedor (agrupados en Activos e Inactivos)
- **Seccion de rendimiento** con ganancias por prestamo (intereses + ganancia/perdida por TRM en USD)
- **Calculadora** para simular prestamos antes de crearlos, con calculo automatico de la tasa de cambio desde el "Total pagado en COP"
- **Historial de acciones** (log de todo lo que hiciste) con **boton Deshacer**: revierte un pago, un abono, una liquidacion, una reestructuracion, un cierre forzoso, un cambio de fecha de pago o cualquier movimiento de Mis Deudas, y la app restaura el estado **exacto** que tenia antes (cuotas, saldo, fechas y recibos internos). Tres candados lo protegen: solo se puede deshacer la **ultima** operacion de cada prestamo o deuda (las anteriores muestran el boton apagado indicando cual va primero); antes de revertir aparece una **confirmacion** con el detalle, que **avisa si la operacion tiene mas de 24 horas** y, cuando movio dinero, **advierte que el cliente probablemente ya tiene un recibo PDF** con esa informacion; y el historial **nunca se borra** — la operacion queda marcada como revertida y se registra que la deshiciste. Se conservan las ultimas 200 operaciones (o 90 dias) como puntos de retorno
- **Tema claro/oscuro** (PDFs se generan con el tema activo)
- **Actualizaciones automaticas** desde GitHub Releases (Windows y Mac), con arranque protegido que blinda la base de datos durante el chequeo de updates
- **Sincronizacion** via iCloud Drive, OneDrive, etc.

## Como instalar en Mac

Descarga el instalador desde [Releases](https://github.com/xJp-P/cartera/releases):

- **Windows:** `Instalador-Windows-X.X.X.exe`
- **Mac:** `Instalador-Mac-X.X.X.dmg`

La app se actualiza automaticamente cuando hay una nueva version disponible.

### Nota para usuarios de Mac

Al abrir la app por primera vez, macOS puede mostrar un mensaje diciendo que la app **"esta danada y no puede abrirse"**. Esto ocurre porque la app no tiene un certificado de Apple Developer (que cuesta $99/ano), pero la app es completamente segura.

**Para solucionarlo, sigue estos pasos:**

1. **No** hagas click en "Mover al basurero" — dale a **Cancelar**
2. Abre la app **Terminal** (puedes buscarla en Spotlight con `Cmd + Espacio` y escribir "Terminal")
3. Copia y pega el siguiente comando en la Terminal y presiona **Enter**:

```bash
xattr -cr /Applications/Cartera.app
```

4. Cierra la Terminal
5. Abre la app normalmente — ahora deberia funcionar sin problemas

> Este paso solo es necesario **la primera vez** que instalas la app. Las actualizaciones posteriores no requieren repetirlo.

## Base de datos

La base de datos es un archivo SQLite (`cartera.db`) que se crea automaticamente la primera vez que abres la app.

| Sistema | Ubicacion por defecto |
|---|---|
| Windows | `%APPDATA%\cartera\cartera.db` |
| Mac | `~/Library/Application Support/cartera/cartera.db` |

Desde la seccion **Desarrollador** dentro de la app puedes cambiar la ubicacion de la base de datos a cualquier carpeta (por ejemplo, una carpeta de iCloud Drive o OneDrive para sincronizar entre equipos).

## Estructura del proyecto

```
├── desktop/
│   ├── main.js           # Ventana Electron + IPC handlers + auto-update
│   └── preload.js        # Bridge seguro entre Electron y frontend
├── backend/
│   └── server.js         # API Express + SQLite + motor financiero
├── public/
│   └── index.html        # UI completa en React
├── build/
│   ├── icon.ico          # Icono Windows
│   ├── icon.png          # Icono general
│   └── uninstaller.nsh   # Script de desinstalacion
└── .github/
    └── workflows/
        └── build.yml     # CI/CD: compila y publica releases
```

## Desarrollo local

```bash
# Instalar dependencias
npm install

# Ejecutar en modo desarrollo
npm start

# Compilar instaladores
npm run build:win    # Windows
npm run build:mac    # Mac
npm run build:all    # Ambos
```

## Stack tecnologico

| Componente | Tecnologia |
|---|---|
| Escritorio | Electron |
| Backend | Express (local en 127.0.0.1:3420) |
| Base de datos | SQLite (better-sqlite3) |
| Frontend | React 18 (UMD, sin build step) |
| Instalador | NSIS (Windows) / DMG (Mac) |
| Auto-update | electron-updater (Win) / custom updater (Mac) + GitHub Releases |

## Para desarrolladores

Toda la documentación interna vive en **`CLAUDE.md`**: arquitectura, esquema de BD, endpoints, modalidades, lógica de negocio, estado actual, historial de sprints, backlog y convenciones de trabajo.

---

Uso privado.
