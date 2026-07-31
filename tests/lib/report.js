// tests/lib/report.js — reporte y aserciones minimas, sin dependencias.
//
// Por que propio y no un framework: el arnes corre bajo
// `ELECTRON_RUN_AS_NODE` (ver README de tests/) para heredar el ABI de
// better-sqlite3. Meter jest/mocha ahi es una dependencia nueva, prohibida
// por el blueprint del refactor.

class Reporter {
  constructor(nombre) {
    this.nombre  = nombre;
    this.pasos   = [];
    this.fallos  = 0;
    this.ok      = 0;
  }

  // Aserto basico. `detalle` se imprime SIEMPRE que falle.
  check(desc, cond, detalle) {
    if (cond) {
      this.ok++;
      this.pasos.push({ ok: true, desc });
    } else {
      this.fallos++;
      this.pasos.push({ ok: false, desc, detalle });
      console.log(`  FAIL  ${desc}`);
      if (detalle !== undefined) {
        const txt = typeof detalle === 'string' ? detalle : JSON.stringify(detalle, null, 2);
        console.log(String(txt).split('\n').map(l => '        ' + l).join('\n'));
      }
    }
    return cond;
  }

  eq(desc, actual, esperado) {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(esperado);
    return this.check(desc, a === e, a === e ? undefined : `esperado: ${e}\nobtenido: ${a}`);
  }

  // Igualdad numerica con tolerancia (para comparar dinero reconstruido).
  near(desc, actual, esperado, tol) {
    const t  = tol === undefined ? 0.5 : tol;
    const ok = Math.abs((actual || 0) - (esperado || 0)) <= t;
    return this.check(desc, ok, ok ? undefined : `esperado: ${esperado} (+-${t})\nobtenido: ${actual}`);
  }

  seccion(titulo) { console.log(`\n-- ${titulo}`); }

  // Devuelve el exit code que debe propagarse.
  finalizar() {
    const total = this.ok + this.fallos;
    console.log(`\n[${this.nombre}] ${this.ok}/${total} OK` + (this.fallos ? `  — ${this.fallos} FALLO(S)` : ''));
    return this.fallos === 0 ? 0 : 1;
  }
}

module.exports = { Reporter };
