// Prueba del plan "top 50": las 25 primeras siempre con la regla normal y las 26–50 solo con señales MUY claras.
// Uso: bun lab_top50.ts   → lab_resultados_top50.txt
// "Muy clara" se define ANTES de mirar resultados con filtros clásicos de calidad de ruptura:
//   volumen de la vela ≥ 1,5 × la media de 20 · ADX(14) ≥ 25 (tendencia con fuerza) · BTC sobre su media de 200 días.
import { writeFileSync } from "fs";
import { join } from "path";
import { load, run, stats, ema, atr, hi, lo, COST, TIER_A, TIER_B, type C, type Strat, type Trade } from "./lab.ts";

function adx(k: C[], p = 14): number[] {
  const n = k.length, pdm = new Array(n).fill(0), mdm = new Array(n).fill(0), tr = new Array(n).fill(0);
  for (let i = 1; i < n; i++) {
    const up = k[i].h - k[i - 1].h, dn = k[i - 1].l - k[i].l;
    pdm[i] = up > dn && up > 0 ? up : 0; mdm[i] = dn > up && dn > 0 ? dn : 0;
    tr[i] = Math.max(k[i].h - k[i].l, Math.abs(k[i].h - k[i - 1].c), Math.abs(k[i].l - k[i - 1].c));
  }
  const sm = (v: number[]) => { const o = new Array(n).fill(NaN); let s = 0; for (let i = 1; i < n; i++) { if (i <= p) { s += v[i]; if (i === p) o[i] = s; } else o[i] = s = s - s / p + v[i]; } return o; };
  const T = sm(tr), P = sm(pdm), M = sm(mdm), dx = T.map((t, i) => { const a = (100 * P[i]) / t, b = (100 * M[i]) / t; return a + b ? (100 * Math.abs(a - b)) / (a + b) : 0; });
  const o = new Array(n).fill(NaN); let s = 0, c = 0;
  for (let i = p; i < n; i++) { if (!isFinite(dx[i])) continue; if (c < p) { s += dx[i]; c++; if (c === p) o[i] = s = s / p; } else o[i] = s = (s * (p - 1) + dx[i]) / p; }
  return o;
}
export { adx };

let BTC = new Map<number, boolean>();
const mk = (id: string, name: string, vol: boolean, adxOn: boolean, btc: boolean): Strat => ({
  id, name, side: 1, tfs: ["1h"], mk: ["c"], params: { n: 20, sl: 2 },
  make: (k, P) => {
    const c = k.map((x) => x.c), e200 = ema(c, 200), a = atr(k), ax = adx(k), n = Math.round(P.n), tN = Math.max(2, Math.round(n / 2));
    const va = k.map((_, i) => { if (i < 20) return NaN; let s = 0; for (let j = i - 20; j < i; j++) s += k[j].v; return s / 20; });
    return {
      entry: (i) => {
        if (!(c[i] > hi(k, i, n) && c[i] > e200[i])) return null;
        if (vol && !(va[i] > 0 && k[i].v >= 1.5 * va[i])) return null;
        if (adxOn && !(ax[i] >= 25)) return null;
        if (btc && !BTC.get(k[i].t)) return null;
        return { sl: c[i] - P.sl * a[i] };
      },
      trail: (_p, j) => lo(k, j + 1, tN), maxBars: 200,
    };
  },
});
const VARS = [
  mk("BASE", "Regla normal (Donchian 20)", false, false, false),
  mk("VOL", "+ volumen ≥ 1,5×", true, false, false),
  mk("ADX", "+ ADX ≥ 25", false, true, false),
  mk("VA", "+ volumen + ADX", true, true, false),
  mk("VAB", "+ volumen + ADX + BTC alcista", true, true, true),
];

if (import.meta.main) {
  const DATA: Record<string, C[]> = {};
  for (const s of [...TIER_A, ...TIER_B]) { try { const k = await load(s, "1h"); if (k.length > 1500) DATA[s] = k; console.error("✓", s, k.length); } catch (e) { console.error("✗", s, (e as Error).message); } }
  const bk = DATA.BTCUSDT, be = ema(bk.map((x) => x.c), 4800); BTC = new Map(bk.map((x, i) => [x.t, i >= 4800 && x.c > be[i]]));
  const f2 = (x: number) => x.toFixed(2), rep: string[] = [`PLAN TOP 50 · ${new Date().toISOString().slice(0, 10)} · Donchian 20 LONG 1h · costes ${(COST * 100).toFixed(2)}%`, ""];
  for (const [label, syms] of [["25 PRIMERAS (siempre)", TIER_A], ["PUESTOS 26–50 (solo muy claras)", TIER_B]] as const) {
    const ok = syms.filter((s) => DATA[s]); rep.push(`══ ${label}: ${ok.length} activos con datos (sin datos: ${syms.filter((s) => !DATA[s]).join(", ") || "ninguno"}) ══`);
    for (const S of VARS) {
      const go = (cost = COST, P = S.params) => ok.flatMap((s) => run(DATA[s], S, P, "1h", s, cost));
      const tr = go(), b = stats(tr), cut = (t: Trade) => t.t >= DATA[t.sym][Math.floor(DATA[t.sym].length * 0.7)].t, o = stats(tr.filter(cut)), d2 = stats(go(2 * COST));
      const rest = [...tr].sort((a, z) => z.r - a.r).slice(Math.ceil(tr.length * 0.05)).reduce((a, x) => a + x.r, 0);
      const sens = [0.8, 1.2].flatMap((m) => ["n", "sl"].map((kk) => stats(go(COST, { ...S.params, [kk]: S.params[kk] * m })).pf));
      const ts = tr.map((x) => x.t), months = tr.length ? (Math.max(...ts) - Math.min(...ts)) / (30 * 86400_000) : 1;
      const checks: [string, boolean][] = [["≥100 ops", b.n >= 100], ["PF≥1,15", b.pf >= 1.15], ["no vistos PF≥1,1", o.n >= 30 && o.pf >= 1.1], ["costes dobles PF≥1", d2.pf >= 1], ["sin 5% mejores >0", rest > 0], ["sensibilidad", sens.every((x) => x >= 1)]];
      rep.push(`${checks.every((c) => c[1]) ? "✅" : "❌"} ${S.name.padEnd(34)} ${String(b.n).padStart(5)} ops (${(b.n / Math.max(months, 1)).toFixed(0)}/mes) · acierto ${b.win.toFixed(0)}% · PF ${f2(b.pf)} · neto ${b.total.toFixed(1)}R · caída ${b.dd.toFixed(1)}R`,
        `     no vistos PF ${f2(o.pf)} (${o.n} ops) · costes dobles PF ${f2(d2.pf)} · sin 5% mejores ${rest.toFixed(0)}R · sensibilidad PF ${sens.map(f2).join("/")} · falla: ${checks.filter((c) => !c[1]).map((c) => c[0]).join(", ") || "nada"}`);
    }
    rep.push("");
  }
  const txt = rep.join("\n"); writeFileSync(join(import.meta.dir, "lab_resultados_top50.txt"), txt); console.log(txt);
}
