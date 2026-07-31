// public/js/core/react.js — puente a los globals de React UMD.
//
// Extraido de `app.js` en la Etapa 3 (B3) del refactor. Codigo VERBATIM.
//
// El proyecto usa React 18 UMD SIN build step: `React` y `ReactDOM` llegan como
// globales desde los dos <script src="/vendor/..."> de index.html, que son
// CLASICOS y por tanto corren ANTES que cualquier modulo (los modulos son
// diferidos). Este archivo solo les pone nombre corto y los reexporta, para que
// los ~30 modulos que vienen no repitan el mismo destructuring.
//
// No se importa React: no hay `node_modules` en el navegador ni bundler que lo
// resuelva. Se leen los globales a proposito.

export var h = React.createElement;
export var useState = React.useState;
export var useEffect = React.useEffect;
export var useMemo = React.useMemo;
export var useCallback = React.useCallback;
export var createRoot = ReactDOM.createRoot;
