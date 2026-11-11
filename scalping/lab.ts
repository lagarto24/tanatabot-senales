// Laboratorio de scalping (velas de 15 min y 1 h). Prueba cada estrategia con costes reales ANTES de enviar señales.
// Uso: bun lab.ts            (la primera vez descarga el historial y lo guarda en ./_cache)
// Costes: 0,14% ida y vuelta (taker 0,05% por lado en Backpack / 0,045% en Hyperliquid + 0,02% de deslizamiento por lado).
// Entrada: apertura de la vela siguiente a la señal. Si en una vela se tocan stop y objetivo, cuenta como stop (conservador).
// Validación: 70% inicial / 30% final (datos no vistos), costes dobles, sin el 5% de las mejores, sensibilidad ±20%.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";

export type C = { t: number; o: number; h: number; l: number; c: number; v: number };
export type TF = "15m" | "1h";
const DIR = import.meta.dir, CACHE = join(DIR, "_cache");
mkdirSync(CACHE, { recursive: true });
// Top 50 cripto por capitalización (CoinGecko, 11/11/2026) que se pueden operar: sin stablecoins, oro tokenizado, activos RWA,
// tokens envueltos ni tokens de exchange sin mercado en Binance/Hyperliquid (LEO, WBT, OKB, BGB, CRO…). GRAM = antes Toncoin (TON).
// TIER_A (puestos 1–25): señales con la regla normal. TIER_B (puestos 26–50): solo señales MUY claras (ver lab_top50.ts).
export const TIER_A = ["BTCUSDT", "ETHUSDT", "BNBUSDT", "XRPUSDT", "SOLUSDT", "TRXUSDT", "HYPEUSDT", "ZECUSDT", "XMRUSDT", "DOGEUSDT", "LINKUSDT", "ADAUSDT", "XLMUSDT", "NEARUSDT", "BCHUSDT", "LTCUSDT", "UNIUSDT", "AVAXUSDT", "CCUSDT", "GRAMUSDT", "SUIUSDT", "HBARUSDT", "SHIBUSDT", "TAOUSDT", "QNTUSDT"];
export const TIER_B = ["PEPEUSDT", "ENAUSDT", "AAVEUSDT", "ONDOUSDT", "PUMPUSDT", "ASTERUSDT", "WLFIUSDT", "DOTUSDT", "MORPHOUSDT", "ICPUSDT", "MNTUSDT", "SKYUSDT", "WLDUSDT", "JSTUSDT", "ARBUSDT", "ETCUSDT", "VVVUSDT", "POLUSDT", "JUPUSDT", "RENDERUSDT", "LITUSDT", "ALGOUSDT", "KASUSDT", "INJUSDT", "ATOMUSDT"];
export const CRYPTO = process.env.SOLO_TOP20 ? TIER_A.slice(0, 20) : [...TIER_A, ...TIER_B];
// Se leen de Hyperliquid (Binance no los tiene o tiene poco historial)
export const HYPERLIQUID: Record<string, string> = {"HYPEUSDT":  "HYPE", "XMRUSDT":  "XMR", "CCUSDT":  "CC", "MNTUSDT":  "MNT", "VVVUSDT":  "VVV", "LITUSDT":  "LIT", "KASUSDT":  "KAS"};
export const STOCKS = ["AAPL", "TSLA", "NVDA", "MSFT", "AMZN", "SPY", "QQQ", "AMD", "META", "GOOGL", "AVGO", "NFLX"];
export const COST = 0.0014;
const H = 3600_000, TFMS: Record<TF, number> = { "15m": 15 * 60_000, "1h": H };

// ───────── Datos ─────────
async function binance(sym: string, tf: TF, total: number): Promise<C[]> {
  let end = Date.now(), out: C[] = [];
  while (out.length < total) {
    let rows: any[] = [];
    for (let a = 0; a < 3 && !rows.length; a++) for (const h of ["https://data-api.binance.vision", "https://api.binance.com"]) {
      try { const r = await fetch(`${h}/api/v3/klines?symbol=${sym}&interval=${tf}&limit=1000&endTime=${end}`); if (r.ok) { rows = await r.json(); break; } } catch {}
    }
    if (!rows.length) break;
    const k = rows.map((x) => ({ t: x[0], o: +x[1], h: +x[2], l: +x[3], c: +x[4], v: +x[5], ct: x[6] }));
    out = [...k, ...out]; end = k[0].t - 1; if (rows.length < 1000) break;
  }
  return out.filter((x: any) => x.ct < Date.now()).map(({ t, o, h, l, c, v }) => ({ t, o, h, l, c, v }));
}
async function hyper(coin: string, tf: TF): Promise<C[]> {
  const now = Date.now();
  const r = await fetch("https://api.hyperliquid.xyz/info", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "candleSnapshot", req: { coin, interval: tf, startTime: now - 5000 * TFMS[tf], endTime: now } }) });
  const rows: any[] = await r.json();
  return rows.filter((x) => x.T < now).map((x) => ({ t: x.t, o: +x.o, h: +x.h, l: +x.l, c: +x.c, v: +x.v }));
}
async function yahoo(sym: string): Promise<C[]> {
  const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${sym}?interval=60m&range=730d`, { headers: { "User-Agent": "Mozilla/5.0" } });
  const res: any = (await r.json()).chart.result[0], q = res.indicators.quote[0], out: C[] = [];
  res.timestamp.forEach((ts: number, i: number) => { if (q.close[i] != null && q.open[i] != null) out.push({ t: ts * 1000, o: q.open[i], h: q.high[i], l: q.low[i], c: q.close[i], v: q.volume[i] ?? 0 }); });
  return out.filter((c) => c.t + H <= Date.now());
}
export async function load(sym: string, tf: TF): Promise<C[]> {
  const f = join(CACHE, `${sym}_${tf}.json`);
  if (existsSync(f)) return JSON.parse(readFileSync(f, "utf8"));
  const k = HYPERLIQUID[sym] ? await hyper(HYPERLIQUID[sym], tf) : sym.endsWith("USDT") ? await binance(sym, tf, tf === "15m" ? 70_000 : 26_500) : tf === "1h" ? await yahoo(sym) : [];
  writeFileSync(f, JSON.stringify(k));
  return k;
}

// ───────── Indicadores ─────────
export const ema = (v: number[], p: number) => { const o = new Array(v.length).fill(NaN); let s = NaN; const a = 2 / (p + 1); for (let i = 0; i < v.length; i++) { if (i === p - 1) s = v.slice(0, p).reduce((x, y) => x + y, 0) / p; else if (i >= p) s = v[i] * a + s * (1 - a); o[i] = s; } return o; };
export const sma = (v: number[], p: number) => { const o = new Array(v.length).fill(NaN); let s = 0; for (let i = 0; i < v.length; i++) { s += v[i]; if (i >= p) s -= v[i - p]; if (i >= p - 1) o[i] = s / p; } return o; };
const wild = (v: number[], p: number) => { const o = new Array(v.length).fill(NaN); let s = 0; for (let i = 1; i < v.length; i++) { if (i <= p) { s += v[i]; if (i === p) o[i] = s = s / p; } else o[i] = s = (s * (p - 1) + v[i]) / p; } return o; };
export const rsi = (c: number[], p: number) => { const g = c.map((x, i) => (i ? Math.max(x - c[i - 1], 0) : 0)), l = c.map((x, i) => (i ? Math.max(c[i - 1] - x, 0) : 0)); const ag = wild(g, p), al = wild(l, p); return ag.map((x, i) => (al[i] === 0 ? 100 : 100 - 100 / (1 + x / al[i]))); };
export const atr = (k: C[], p = 14) => wild(k.map((x, i) => (i ? Math.max(x.h - x.l, Math.abs(x.h - k[i - 1].c), Math.abs(x.l - k[i - 1].c)) : x.h - x.l)), p);
export const hi = (k: C[], i: number, n: number) => { let m = -Infinity; for (let j = i - n; j < i; j++) m = Math.max(m, k[j].h); return m; };
export const lo = (k: C[], i: number, n: number) => { let m = Infinity; for (let j = i - n; j < i; j++) m = Math.min(m, k[j].l); return m; };

// ───────── Motor ─────────
export type P = Record<string, number>;
export type Pos = { side: 1 | -1; e: number; stop: number; tp?: number; i0: number; t: number; risk: number; day: number };
export type Sig = { sl: number; rr?: number };
export type Model = { entry: (i: number) => Sig | null; exit?: (p: Pos, j: number) => number | null; trail?: (p: Pos, j: number) => number | null; maxBars: number };
export type Strat = { id: string; name: string; side: 1 | -1; tfs: TF[]; mk: ("c" | "s")[]; params: P; make: (k: C[], P: P, side: 1 | -1, tf: TF) => Model };
export type Trade = { t: number; r: number; sym: string; tf: TF };
export function run(k: C[], S: Strat, Pp: P, tf: TF, sym: string, cost = COST): Trade[] {
  const m = S.make(k, Pp, S.side, tf), out: Trade[] = [];
  let p: Pos | null = null;
  for (let i = 260; i < k.length - 1; i++) {
    if (p) {
      const b = k[i], L = p.side === 1; let x: number | null = null;
      if (L ? b.o <= p.stop : b.o >= p.stop) x = b.o;
      else if (L ? b.l <= p.stop : b.h >= p.stop) x = p.stop;
      else if (p.tp !== undefined && (L ? b.o >= p.tp : b.o <= p.tp)) x = b.o;
      else if (p.tp !== undefined && (L ? b.h >= p.tp : b.l <= p.tp)) x = p.tp;
      else if (m.exit) x = m.exit(p, i);
      if (x === null && i - p.i0 >= m.maxBars) x = b.c;
      if (x !== null) { out.push({ t: p.t, r: (p.side * (x - p.e) - cost * p.e) / p.risk, sym, tf }); p = null; continue; }
      if (m.trail) { const ns = m.trail(p, i); if (ns !== null) p.stop = L ? Math.max(p.stop, ns) : Math.min(p.stop, ns); }
      continue;
    }
    const s = m.entry(i); if (!s) continue;
    const e = k[i + 1].o, risk = S.side * (e - s.sl);
    if (!(risk > 0)) continue;
    p = { side: S.side, e, stop: s.sl, tp: s.rr ? e + S.side * s.rr * risk : undefined, i0: i + 1, t: k[i + 1].t, risk, day: Math.floor(k[i + 1].t / 86400_000) };
  }
  return out;
}

// ───────── Estrategias ─────────
const base = (k: C[]) => { const c = k.map((x) => x.c); return { c, e200: ema(c, 200), e800: ema(c, 800), a: atr(k) }; };
export const STRATS: Strat[] = [];
for (const side of [1, -1] as const) {
  const SN = side === 1 ? "LONG" : "SHORT", sx = side === 1 ? "L" : "S";
  // 1 · Ruptura Donchian a favor de la tendencia (EMA200), stop móvil en el extremo de n/2 velas
  for (const htf of [false, true]) STRATS.push({
    id: `DON${htf ? "H" : ""}${sx}`, name: `Ruptura Donchian${htf ? " + tendencia mayor (EMA800)" : ""} ${SN}`, side, tfs: ["15m", "1h"], mk: ["c", "s"], params: { n: 20, sl: 2 },
    make: (k, P, sd) => { const B = base(k), n = Math.round(P.n), tN = Math.max(2, Math.round(n / 2)); return {
      entry: (i) => { const c = B.c[i], ok = sd === 1 ? c > hi(k, i, n) && c > B.e200[i] && (!htf || c > B.e800[i]) : c < lo(k, i, n) && c < B.e200[i] && (!htf || c < B.e800[i]); return ok ? { sl: c - sd * P.sl * B.a[i] } : null; },
      trail: (p, j) => (sd === 1 ? lo(k, j + 1, tN) : hi(k, j + 1, tN)), maxBars: 200 }; } });
  // 2 · Donchian con objetivo fijo 2R
  STRATS.push({ id: `DONT${sx}`, name: `Ruptura Donchian objetivo 2R ${SN}`, side, tfs: ["15m", "1h"], mk: ["c", "s"], params: { n: 20, sl: 2, rr: 2 },
    make: (k, P, sd) => { const B = base(k), n = Math.round(P.n); return {
      entry: (i) => { const c = B.c[i], ok = sd === 1 ? c > hi(k, i, n) && c > B.e200[i] : c < lo(k, i, n) && c < B.e200[i]; return ok ? { sl: c - sd * P.sl * B.a[i], rr: P.rr } : null; }, maxBars: 150 }; } });
  // 3 · Reversión RSI(2) a favor de la tendencia: compra caídas fuertes en tendencia alcista, sale al cruzar la SMA5
  STRATS.push({ id: `RSI2${sx}`, name: `Reversión RSI(2) ${SN}`, side, tfs: ["15m", "1h"], mk: ["c", "s"], params: { th: 10, sl: 2 },
    make: (k, P, sd) => { const B = base(k), r2 = rsi(B.c, 2), s5 = sma(B.c, 5); return {
      entry: (i) => { const c = B.c[i], ok = sd === 1 ? c > B.e200[i] && r2[i] < P.th : c < B.e200[i] && r2[i] > 100 - P.th; return ok ? { sl: c - sd * P.sl * B.a[i] } : null; },
      exit: (p, j) => (sd === 1 ? (B.c[j] > s5[j] ? B.c[j] : null) : B.c[j] < s5[j] ? B.c[j] : null), maxBars: 30 }; } });
  // 4 · Ruptura tras compresión de Bollinger (squeeze)
  STRATS.push({ id: `SQZ${sx}`, name: `Ruptura tras compresión (squeeze) ${SN}`, side, tfs: ["15m", "1h"], mk: ["c", "s"], params: { look: 120, sl: 1.5, rr: 2 },
    make: (k, P, sd) => { const B = base(k), m = sma(B.c, 20), look = Math.round(P.look);
      const sd20 = B.c.map((_, i) => { if (i < 19) return NaN; let s = 0; for (let j = i - 19; j <= i; j++) s += (B.c[j] - m[i]) ** 2; return Math.sqrt(s / 20); });
      const bw = sd20.map((s, i) => (4 * s) / m[i]); return {
      entry: (i) => { if (i < look + 21) return null; let mn = Infinity; for (let j = i - look; j < i - 1; j++) mn = Math.min(mn, bw[j]);
        const sq = bw[i - 1] <= mn * 1.1, c = B.c[i], brk = sd === 1 ? c > m[i] + 2 * sd20[i] && c > B.e200[i] : c < m[i] - 2 * sd20[i] && c < B.e200[i];
        return sq && brk ? { sl: c - sd * P.sl * B.a[i], rr: P.rr } : null; }, maxBars: 100 }; } });
  // 5 · Cruce de medias rápidas EMA 9/21 con filtro EMA200 (el "scalping" más popular)
  STRATS.push({ id: `EMX${sx}`, name: `Cruce EMA 9/21 ${SN}`, side, tfs: ["15m", "1h"], mk: ["c", "s"], params: { f: 9, s: 21, sl: 1.5, rr: 1.5 },
    make: (k, P, sd) => { const B = base(k), f = ema(B.c, Math.round(P.f)), s = ema(B.c, Math.round(P.s)); return {
      entry: (i) => { const up = f[i - 1] <= s[i - 1] && f[i] > s[i], dn = f[i - 1] >= s[i - 1] && f[i] < s[i], c = B.c[i];
        const ok = sd === 1 ? up && c > B.e200[i] : dn && c < B.e200[i]; return ok ? { sl: c - sd * P.sl * B.a[i], rr: P.rr } : null; }, maxBars: 100 }; } });
  // 6 · Ruptura del rango asiático (cripto): rango 00-08 UTC, entrada 08-16 UTC, cierre al final del día UTC
  STRATS.push({ id: `ASIA${sx}`, name: `Ruptura rango de Asia ${SN}`, side, tfs: ["15m", "1h"], mk: ["c"], params: { rr: 2 },
    make: (k, P, sd) => { const B = base(k), rh: number[] = [], rl: number[] = [], done = new Set<number>();
      let d = -1, h = -Infinity, l = Infinity;
      for (const x of k) { const dd = Math.floor(x.t / 86400_000), hr = new Date(x.t).getUTCHours(); if (dd !== d) { d = dd; h = -Infinity; l = Infinity; } if (hr < 8) { h = Math.max(h, x.h); l = Math.min(l, x.l); } rh.push(hr >= 8 ? h : NaN); rl.push(hr >= 8 ? l : NaN); }
      return {
      entry: (i) => { const hr = new Date(k[i].t).getUTCHours(), dd = Math.floor(k[i].t / 86400_000); if (hr < 8 || hr >= 16 || done.has(dd) || !isFinite(rh[i])) return null;
        const c = B.c[i], ok = sd === 1 ? c > rh[i] && c > B.e200[i] : c < rl[i] && c < B.e200[i]; if (!ok) return null; done.add(dd); return { sl: (rh[i] + rl[i]) / 2, rr: P.rr }; },
      exit: (p, j) => (j + 1 < k.length && Math.floor(k[j + 1].t / 86400_000) !== p.day ? B.c[j] : null), maxBars: 96 }; } });
  // 7 · Ruptura del rango de apertura (acciones, 1h): primera vela del día; entrada antes de las 14:30 NY; cierre al final de la sesión
  STRATS.push({ id: `ORB${sx}`, name: `Ruptura de la 1ª hora (ORB) ${SN}`, side, tfs: ["1h"], mk: ["s"], params: { rr: 2 },
    make: (k, P, sd) => { const B = base(k), key = (t: number) => Math.floor((t - 10 * H) / 86400_000), rh: number[] = [], rl: number[] = [], pos: number[] = [], done = new Set<number>();
      let d = -1, h = 0, l = 0, n = 0;
      for (const x of k) { const dd = key(x.t); if (dd !== d) { d = dd; h = x.h; l = x.l; n = 0; } else n++; rh.push(h); rl.push(l); pos.push(n); }
      return {
      entry: (i) => { if (pos[i] < 1 || pos[i] > 4 || done.has(key(k[i].t))) return null; const c = B.c[i], ok = sd === 1 ? c > rh[i] && c > B.e200[i] : c < rl[i] && c < B.e200[i];
        if (!ok) return null; done.add(key(k[i].t)); return { sl: sd === 1 ? rl[i] : rh[i], rr: P.rr }; },
      exit: (p, j) => (j + 1 < k.length && key(k[j + 1].t) !== key(k[j].t) ? B.c[j] : null), maxBars: 8 }; } });
}

// ───────── Ronda 2: variantes de la única candidata (Donchian LONG 1h cripto) ─────────
// Ideas con fundamento, no ajuste fino: canal más largo (sistema 2 de las Tortugas, 55 velas), tendencia diaria del propio activo
// (EMA de 4800 velas de 1h ≈ media de 200 días) y filtro de mercado (BTC sobre su media de 200 días).
export const REF: { btc?: Map<number, boolean> } = {};
export function setBtcRef(k: C[]) { const e = ema(k.map((x) => x.c), 4800); REF.btc = new Map(k.map((x, i) => [x.t, i >= 4800 && x.c > e[i]])); }
export const STRATS2: Strat[] = [];
for (const [n, daily, btc] of [[20, true, false], [20, false, true], [20, true, true], [55, false, false], [55, true, false], [55, true, true]] as [number, boolean, boolean][]) {
  STRATS2.push({ id: `D${n}${daily ? "d" : ""}${btc ? "b" : ""}L`, name: `Donchian ${n} LONG${daily ? " + tendencia diaria" : ""}${btc ? " + BTC alcista" : ""}`, side: 1, tfs: ["1h"], mk: ["c"], params: { n, sl: 2 },
    make: (k, P) => { const B = base(k), e4800 = ema(B.c, 4800), nn = Math.round(P.n), tN = Math.max(2, Math.round(nn / 2)); return {
      entry: (i) => { const c = B.c[i]; if (!(c > hi(k, i, nn) && c > B.e200[i])) return null; if (daily && !(c > e4800[i])) return null; if (btc && !REF.btc?.get(k[i].t)) return null; return { sl: c - P.sl * B.a[i] }; },
      trail: (p, j) => lo(k, j + 1, tN), maxBars: 400 }; } });
}

// ───────── Estadística y validación ─────────
export function stats(tr: Trade[]) {
  const s = [...tr].sort((a, b) => a.t - b.t), w = s.filter((x) => x.r > 0), gw = w.reduce((a, x) => a + x.r, 0), gl = -s.filter((x) => x.r <= 0).reduce((a, x) => a + x.r, 0);
  let e = 0, pk = 0, dd = 0; for (const x of s) { e += x.r; pk = Math.max(pk, e); dd = Math.max(dd, pk - e); }
  return { n: s.length, win: s.length ? (100 * w.length) / s.length : 0, total: e, pf: gl ? gw / gl : gw ? 99 : 0, dd, avg: s.length ? e / s.length : 0 };
}
const f2 = (x: number) => x.toFixed(2);
if (import.meta.main) {
  const DATA: Record<string, Partial<Record<TF, C[]>>> = {};
  for (const s of [...CRYPTO, ...STOCKS]) for (const tf of ["15m", "1h"] as TF[]) {
    if (!s.endsWith("USDT") && tf === "15m") continue; // Yahoo solo da 60 días en 15 min: no sirve para validar
    try { const k = await load(s, tf); if (k.length > 1500) (DATA[s] ??= {})[tf] = k; console.error("✓", s, tf, k.length); } catch (e) { console.error("✗", s, tf, (e as Error).message); }
  }
  if (process.env.SOLO_DATOS) process.exit(0);
  const rows: { line: string; score: number; pass: boolean; detail: string[] }[] = [];
  if (DATA.BTCUSDT?.["1h"]) setBtcRef(DATA.BTCUSDT["1h"]!);
  const ONLY = process.env.ONLY_ID?.split(","), ONLY_TF = process.env.ONLY_TF as TF | undefined;
  for (const S of (process.env.LAB2 ? STRATS2 : STRATS).filter((x) => !ONLY || ONLY.includes(x.id))) for (const tf of S.tfs.filter((x) => !ONLY_TF || x === ONLY_TF)) for (const mk of S.mk.filter((x) => !process.env.ONLY_MK || x === process.env.ONLY_MK)) {
    const syms = (mk === "c" ? CRYPTO : STOCKS).filter((s) => DATA[s]?.[tf]);
    if (!syms.length) continue;
    const go = (Pp: P, cost = COST) => syms.flatMap((s) => run(DATA[s]![tf]!, S, Pp, tf, s, cost));
    const cutOf = (s: string) => { const k = DATA[s]![tf]!; return k[Math.floor(k.length * 0.7)].t; };
    const tr = go(S.params), b = stats(tr), o = stats(tr.filter((x) => x.t >= cutOf(x.sym))), d2 = stats(go(S.params, 2 * COST));
    const sorted = [...tr].sort((a, z) => z.r - a.r), rest = sorted.slice(Math.ceil(tr.length * 0.05)).reduce((a, x) => a + x.r, 0);
    const sens: string[] = []; let sensOk = true;
    for (const [kk, v] of Object.entries(S.params)) for (const mlt of [0.8, 1.2]) { const s2 = stats(go({ ...S.params, [kk]: v * mlt })); sens.push(`${kk}×${mlt}: PF ${f2(s2.pf)}`); if (s2.pf < 1) sensOk = false; }
    const ts = tr.map((x) => x.t), days = tr.length ? (Math.max(...ts) - Math.min(...ts)) / 86400_000 : 1;
    const checks: [string, boolean][] = [["≥100 operaciones", b.n >= 100], ["PF ≥ 1,15", b.pf >= 1.15], ["datos no vistos PF ≥ 1,1 (≥30 ops)", o.n >= 30 && o.pf >= 1.1], ["costes dobles PF ≥ 1", d2.pf >= 1], ["sin el 5% mejores > 0", rest > 0], ["sensibilidad ±20% PF ≥ 1", sensOk]];
    const pass = checks.every((c) => c[1]);
    rows.push({ pass, score: pass ? b.pf : b.pf - 10,
      line: `${pass ? "✅" : "❌"} [${S.id}] ${(S.name + " · " + tf + " · " + (mk === "c" ? "cripto" : "acciones")).padEnd(62)} ${String(b.n).padStart(5)} ops · ${((b.n / Math.max(days, 1)) * 30).toFixed(0).padStart(3)}/mes · acierto ${b.win.toFixed(0)}% · PF ${f2(b.pf)} · neto ${b.total.toFixed(1)}R · caída ${b.dd.toFixed(1)}R`,
      detail: [`     no vistos: ${o.n} ops PF ${f2(o.pf)} neto ${o.total.toFixed(1)}R · costes dobles PF ${f2(d2.pf)} · sin 5% mejores ${rest.toFixed(1)}R · ${sens.join(" · ")}`, `     falla: ${checks.filter((c) => !c[1]).map((c) => c[0]).join(", ") || "nada"}`] });
    console.error("·", S.id, tf, mk);
  }
  rows.sort((a, z) => z.score - a.score);
  const head = [`LABORATORIO DE SCALPING · ${new Date().toISOString().slice(0, 10)} · costes ${(COST * 100).toFixed(2)}% ida y vuelta`,
    `Cripto: ${CRYPTO.filter((s) => DATA[s]).join(", ")} · Acciones (1h): ${STOCKS.filter((s) => DATA[s]).join(", ")}`,
    ...Object.entries(DATA).flatMap(([s, v]) => Object.entries(v!).map(([tf, k]) => `  ${s} ${tf}: ${k!.length} velas desde ${new Date(k![0].t).toISOString().slice(0, 10)}`)), ""];
  const txt = [...head, ...rows.flatMap((r) => [r.line, ...r.detail])].join("\n");
  writeFileSync(join(DIR, process.env.OUT ?? (process.env.LAB2 ? "lab_resultados_2.txt" : "lab_resultados.txt")), txt); console.log(txt);
}
