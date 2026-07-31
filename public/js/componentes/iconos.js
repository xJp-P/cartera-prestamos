// public/js/componentes/iconos.js — vocabulario visual: iconos y colores de estado.
//
// Extraido de `app.js` en la Etapa 3 (B5) del refactor. Codigo VERBATIM.
//
// `ICONS` es un diccionario de paths SVG y `Ico` los pinta. Se agrupan con `ST`
// (los colores de los tres estados de cuota: Pagado / Pendiente / En Mora) porque
// juntos forman el vocabulario visual con el que el resto de la UI habla de estado.
//
// Nota para el futuro: el set NO tiene un icono `lock`. Cuando la Fase 2 de "La
// Bestia" necesito comunicar el candado LIFO se uso `clock`, que ademas transmite
// el orden cronologico. Antes de usar un nombre, comprobar que exista en ICONS:
// `Ico` devuelve null en silencio si no lo encuentra.

import { h } from '../core/react.js';

export var ST = {
  'Pagado':   {bg:'#0f2b19',color:'#3fb950',bd:'#1b4332',icon:'OK'},
  'Pendiente':{bg:'#2b2005',color:'#d29922',bd:'#3d2e08',icon:'...'},
  'En Mora':  {bg:'#2d1117',color:'#f85149',bd:'#5c1b18',icon:'!'}
};

export var ICONS = {
  home:      'M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z M9 22V12h6v10',
  briefcase: 'M20 7H4a2 2 0 00-2 2v10a2 2 0 002 2h16a2 2 0 002-2V9a2 2 0 00-2-2z M16 7V5a2 2 0 00-2-2h-4a2 2 0 00-2 2v2',
  check2:    'M9 11l3 3L22 4 M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11',
  users:     'M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2 M23 21v-2a4 4 0 00-3-3.87 M16 3.13a4 4 0 010 7.75',
  trending:  'M23 6l-9.5 9.5-5-5L1 18 M17 6h6v6',
  plus:      'M12 5v14 M5 12h14',
  edit:      'M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7 M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z',
  trash:     'M3 6h18 M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a1 1 0 011-1h4a1 1 0 011 1v2',
  x:         'M18 6L6 18 M6 6l12 12',
  xCircle:   'M12 22a10 10 0 100-20 10 10 0 000 20z M15 9l-6 6 M9 9l6 6',
  check:     'M20 6L9 17l-5-5',
  alert:     'M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z M12 9v4 M12 17h.01',
  clock:     'M12 2a10 10 0 100 20A10 10 0 0012 2z M12 6v6l4 2',
  search:    'M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z',
  chevdown:  'M6 9l6 6 6-6',
  chevleft:  'M15 18l-6-6 6-6',
  chevright: 'M9 18l6-6-6-6',
  bell:      'M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9 M13.73 21a2 2 0 01-3.46 0',
  refresh:   'M23 4v6h-6 M1 20v-6h6 M3.51 9a9 9 0 0114.85-3.36L23 10 M1 14l4.64 4.36A9 9 0 0020.49 15',
  dollar:    'M12 1v22 M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6',
  phone:     'M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07A19.5 19.5 0 013.07 9.8a19.79 19.79 0 01-3.07-8.63A2 2 0 012 0h3a2 2 0 012 1.72c.127.96.361 1.903.7 2.81a2 2 0 01-.45 2.11L6.09 7.91a16 16 0 006 6l1.27-1.27a2 2 0 012.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0122 16.92z',
  menu:       'M3 12h18 M3 6h18 M3 18h18',
  calc:       'M4 2h16a2 2 0 012 2v16a2 2 0 01-2 2H4a2 2 0 01-2-2V4a2 2 0 012-2z M8 10h.01 M12 10h.01 M16 10h.01 M8 14h.01 M12 14h.01 M16 14h.01 M8 18h.01 M12 18h.01 M16 18h.01 M8 6h8',
  calendar:    'M19 4H5a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2V6a2 2 0 00-2-2z M16 2v4 M8 2v4 M3 10h18',
  download:    'M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4 M7 10l5 5 5-5 M12 15V3',
  settings:    'M12.22 2h-.44a2 2 0 00-2 2v.18a2 2 0 01-1 1.73l-.43.25a2 2 0 01-2 0l-.15-.08a2 2 0 00-2.73.73l-.22.38a2 2 0 00.73 2.73l.15.1a2 2 0 011 1.72v.51a2 2 0 01-1 1.74l-.15.09a2 2 0 00-.73 2.73l.22.38a2 2 0 002.73.73l.15-.08a2 2 0 012 0l.43.25a2 2 0 011 1.73V20a2 2 0 002 2h.44a2 2 0 002-2v-.18a2 2 0 011-1.73l.43-.25a2 2 0 012 0l.15.08a2 2 0 002.73-.73l.22-.39a2 2 0 00-.73-2.73l-.15-.08a2 2 0 01-1-1.74v-.5a2 2 0 011-1.74l.15-.09a2 2 0 00.73-2.73l-.22-.38a2 2 0 00-2.73-.73l-.15.08a2 2 0 01-2 0l-.43-.25a2 2 0 01-1-1.73V4a2 2 0 00-2-2z M12 15a3 3 0 100-6 3 3 0 000 6z',
  folder:      'M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z',
  'refresh-cw': 'M23 4v6h-6 M1 20v-6h6 M3.51 9a9 9 0 0114.85-3.36L23 10 M1 14l4.64 4.36A9 9 0 0020.49 15',
  sun:         'M12 17a5 5 0 100-10 5 5 0 000 10z M12 1v2 M12 21v2 M4.22 4.22l1.42 1.42 M18.36 18.36l1.42 1.42 M1 12h2 M21 12h2 M4.22 19.78l1.42-1.42 M18.36 5.64l1.42-1.42',
  moon:        'M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z',
  activity:    'M22 12h-4l-3 9L9 3l-3 9H2',
  clipboard:   'M16 4h2a2 2 0 012 2v14a2 2 0 01-2 2H6a2 2 0 01-2-2V6a2 2 0 012-2h2 M15 2H9a1 1 0 00-1 1v1a1 1 0 001 1h6a1 1 0 001-1V3a1 1 0 00-1-1z',
  sparkle:     'M12 2l2 6.5L20.5 10l-6.5 2L12 18.5 10 12l-6.5-1.5L10 8.5 12 2z',
  shield:      'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z',
  wallet:      'M4 5h16a2 2 0 012 2v10a2 2 0 01-2 2H4a2 2 0 01-2-2V7a2 2 0 012-2z M2 10h20 M7 15h3',
  receipt:     'M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z M14 2v6h6 M8 13h8 M8 17h8 M8 9h2'
};

export function Ico(props){
  var name=props.name,size=props.size||18,sw=props.sw||1.8,color=props.color||'currentColor';
  var d=ICONS[name]; if(!d) return null;
  var parts=d.split(' M ');
  var paths=parts.map(function(p,i){return i===0?p:'M '+p;});
  return h('svg',{width:size,height:size,viewBox:'0 0 24 24',fill:'none',stroke:color,strokeWidth:sw,strokeLinecap:'round',strokeLinejoin:'round'},
    paths.map(function(p,i){return h('path',{key:i,d:p});}));
}
