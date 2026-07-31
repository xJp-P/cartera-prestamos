// public/js/core/format.js — formato de numeros, moneda y fechas, y parseo de inputs.
//
// Extraido de `app.js` en la Etapa 3 (B3) del refactor. Codigo VERBATIM.
//
// Funciones puras, sin estado ni DOM. Son los helpers mas usados del frontend
// (`fmt` ~24 sitios, `copToUsd` ~19, `fmtD` ~18, `fmtUSD` ~14).
//
// DOS DETALLES QUE PARECEN COSMETICOS Y NO LO SON:
//  - `fmt` produce un ESPACIO DURO (U+00A0) despues del `$`. Por eso los nombres
//    de archivo de los PDF se arman con toLocaleString y no con `fmt`.
//  - `fmtD` ancla las fechas a 'T12:00:00' (mediodia) para que el cambio de huso
//    no corra el dia. Todo el manejo de fechas de la app depende de ese anclaje.

export function fmt(n)  { return new Intl.NumberFormat('es-CO',{style:'currency',currency:'COP',maximumFractionDigits:0}).format(n||0); }

export function fmtUSD(n){ return 'USD $'+new Intl.NumberFormat('en-US',{minimumFractionDigits:2,maximumFractionDigits:2}).format(n||0); }

export function fmtN(n) { return new Intl.NumberFormat('es-CO').format(Math.round(n||0)); }

// Convierte COP a USD usando TRM del préstamo; retorna string "USD $X.XX"
export function copToUsd(cop,trm){ return trm>0?fmtUSD(cop/trm):''; }

export function fmtD(s) { return s?new Date(s+'T12:00:00').toLocaleDateString('es-CO',{day:'2-digit',month:'short',year:'numeric'}):'-'; }

export function fmtNumInput(v){
  if(!v&&v!==0)return '';
  var s=String(v).replace(/[^\d,]/g,'');
  var parts=s.split(',');
  var ent=parts[0].replace(/^0+(?=\d)/,'');
  if(!ent)ent='0';
  ent=ent.replace(/\B(?=(\d{3})+(?!\d))/g,'.');
  return parts.length>1?ent+','+parts[1]:ent;
}

export function parseNum(v){
  if(!v)return '';
  var s=String(v).replace(/\./g,'').replace(',','.');
  return s;
}

export function parseDecimalInput(v){
  var s=String(v||'').replace(',','.').replace(/[^\d.]/g,'');
  var parts=s.split('.');
  if(parts.length>2) s=parts[0]+'.'+parts.slice(1).join('');
  return s;
}

// Solo deja digitos (para inputs enteros como plazo).
export function parseIntInput(v){return String(v||'').replace(/[^\d]/g,'');}
