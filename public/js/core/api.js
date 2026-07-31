// public/js/core/api.js — cliente HTTP del backend y canal de errores de la UI.
//
// Extraido de `app.js` en la Etapa 3 (B3) del refactor. Codigo VERBATIM.
//
// CONTRATO QUE NO SE PUEDE CAMBIAR: los cuatro helpers ATRAPAN el error y
// RESUELVEN `null`; nunca rechazan. De eso dependen dos cosas en toda la app:
//   - los llamadores comprueban `if(!r) return;` para distinguir fallo de exito;
//   - `_submitGuard` libera su bandera en el `.then` y NO en un `.catch`, porque
//     un `.catch` no correria jamas y el boton quedaria bloqueado para siempre.
// Ver Bugs #32 y #33.
//
// `_errorHandler` NO se exporta: es privado del modulo. Se cambia unicamente con
// `setErrorHandler`, que es lo que permite que `App` conecte su toast sin
// reasignar un binding importado (que bajo ESM seria un TypeError).

// ── Canal de errores hacia la UI ────────────────────────────────────────────
// `App` conecta su toast con `setErrorHandler` al renderizar; hasta que lo haga
// (y en los arneses de test, que no montan la UI) los errores caen a la consola.
//
// POR QUE UN SETTER Y NO UNA VARIABLE REASIGNABLE: esto era `var _showError = null`
// reasignado desde el cuerpo de render de `App`. Bajo modulos ES un `import` es un
// binding de SOLO LECTURA, asi que esa reasignacion seria un TypeError en el primer
// render — es decir, pantalla negra, la misma clase de fallo del Bug #40. El handler
// queda encapsulado aca y se cambia llamando a una funcion, que si cruza modulos.
// Privado a proposito: no se exporta. Se cambia SOLO con setErrorHandler.
var _errorHandler = null;
export function setErrorHandler(fn) { _errorHandler = typeof fn === 'function' ? fn : null; }
export function showError(msg) {
  if (_errorHandler) _errorHandler(msg);
  else console.error(msg);
}
export function handleApiError(err) {
  showError(err && err.message ? err.message : 'Error de conexion con el servidor');
}
export function handleRes(r) {
  if (!r.ok) return r.text().then(function(t) { try { var j=JSON.parse(t); throw new Error(j.error||'Error del servidor'); } catch(e) { if(e.message) throw e; throw new Error('Error del servidor ('+r.status+')'); }});
  return r.json();
}
export var API = {
  get:  function(url)   { return fetch(url).then(handleRes).catch(function(e){handleApiError(e);return null;}); },
  post: function(url,b) { return fetch(url,{method:'POST',  headers:{'Content-Type':'application/json'},body:JSON.stringify(b)}).then(handleRes).catch(function(e){handleApiError(e);return null;}); },
  put:  function(url,b) { return fetch(url,{method:'PUT',   headers:{'Content-Type':'application/json'},body:JSON.stringify(b)}).then(handleRes).catch(function(e){handleApiError(e);return null;}); },
  del:  function(url)   { return fetch(url,{method:'DELETE'}).then(handleRes).catch(function(e){handleApiError(e);return null;}); }
};
