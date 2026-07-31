// public/js/core/ui.js — utilidades transversales de interfaz.
//
// Extraido de `app.js` en la Etapa 3 (B3) del refactor. Codigo VERBATIM.
//
// `_submitGuard` es la pieza importante: la guarda anti doble-submit que blinda
// LOS 13 BOTONES que escriben en la BD (Bug #29, cerrado en v1.18.1). Los
// endpoints NO son idempotentes, asi que un doble clic aplicaba la operacion dos
// veces. Implementacion UNICA y compartida: cinco copias serian cinco sitios donde
// equivocarse.

// ── Guarda anti doble-submit (Bug #29) ───────────────────────────────────────
// Ejecuta `fn` solo si no hay otra operacion en vuelo y libera SIEMPRE la bandera:
// al resolver, al rechazar, si `fn` no devuelve promesa (rutas que ceden el control a
// otro modal, como el pre-flight de mora) o si lanza de forma sincrona.
//
// La liberacion va en el .then y NO en un .catch a proposito: los helpers de API
// (API.get/post/put/del) atrapan el error y RESUELVEN null, nunca rechazan, asi que un
// .catch jamas correria y el boton quedaria bloqueado para siempre. El manejador de
// rechazo se conserva por si esos helpers dejaran de atrapar en el futuro.
//
// Implementacion unica y compartida: los endpoints de escritura NO son idempotentes, y
// cinco copias de esta logica serian cinco sitios donde equivocarse.
export function _submitGuard(sending,setSending,fn){
  if(sending) return;
  setSending(true);
  var p;
  try{ p=fn(); }catch(e){ setSending(false); throw e; }
  if(p&&typeof p.then==='function') p.then(function(){setSending(false);},function(){setSending(false);});
  else setSending(false);
}

// Proper Case (Capitalizacion de Titulos): "pa"->"Pa", "juan PEREZ"->"Juan Perez"
export function properCase(s){ return String(s||'').trim().split(/\s+/).map(function(w){return w?w.charAt(0).toUpperCase()+w.slice(1).toLowerCase():w;}).join(' '); }

export function freqLabel(loan){
  if(loan.modalidad==='Intereses') return '\u221E Indefinido';
  var n=loan.plazoMeses;
  var f=loan.frecuencia||'Mensual';
  if(f==='Semanal') return n+' semanas';
  if(f==='Quincenal') return n+' quincenas';
  return n+' cuotas';
}

export function freqCuotaLabel(f){return f==='Semanal'?'semanal':f==='Quincenal'?'quincenal':'mensual';}

export function nowStr()    { var d=new Date(); return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'); }

export function addDays(s,n){ var d=new Date(s+'T12:00:00'); d.setDate(d.getDate()+n); return d.toISOString().split('T')[0]; }

// Codigo de Factura de Cobro: FC-[2 primeras letras del deudor]-[ultimos 3 del loanId]-[cuota 2 digitos]
export function facturaCode(p){
  if(!p) return '';
  var ini=properCase(String(p.nombreCliente||'')).replace(/\s+/g,'').slice(0,2);
  return 'FC-'+ini+'-'+String(p.prestamoId||'').slice(-3)+'-'+String(p.cuotaN||0).padStart(2,'0');
}
