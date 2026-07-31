// backend/core/errors.js — tipos de error del backend.
//
// Extraido de `server.js` en la Etapa 2 (A2) del refactor de modularizacion.
// Codigo movido VERBATIM.
//
// `ClientError` es la pieza que sostiene la doctrina "4xx => BD intacta": los
// endpoints validan LANZANDO (no con `return res.status(4xx)`), y `mutacionAtomica`
// lo atrapa en FASE 1, antes de la primera escritura. Un `return res.status(...)`
// en medio de un compute() dejaria a medias lo que ya se hubiera escrito.
//
// Nota del refactor: en el monolito esta clase se declaraba ~150 lineas DESPUES de
// `abortarSiHuerfanos`, que la usa. Funcionaba solo porque la referencia se resuelve
// en tiempo de llamada, no de definicion. Al vivir en un modulo que se importa
// arriba, esa fragilidad desaparece.

// Error de validacion -> respuesta 4xx sin tocar la BD.
class ClientError extends Error {
  constructor(message, code) { super(message); this.code = code || 400; }
}

module.exports = { ClientError };
