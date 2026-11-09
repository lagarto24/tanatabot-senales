// Backtest de la estrategia de señales con historial real.
// Uso: bun backtest.ts
// Simula cada señal: entra al cierre de la vela, sale en SL (−1R) o TP (+R:R).
// Si en la misma vela se tocan SL y TP, se cuenta como pérdida (conservador).
// Comisiones: 0.1% ida y vuelta, descontadas en R.

import { writeFileSync } from "fs";

type Candle = { t: number; o: number; h: number; l: number; c: number; v: number };
type TF = "1h" | "4h" | "1d";
const H = 3600_000;
const TF_MS: Record<TF, number> = { "1h": H, "4h": 4 * H, "1d": 24 * H };
const HTF: Record<TF, TF | null> = { "1h": "4h", "4h": "1d", "1d": null };

const CRYPTO = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "HYPEUSDT", "BNBUSDT"];
const HYPERLIQUID: Record<string, string> = { HYPEUSDT: "HYPE" };
const STOCKS = ["AAPL", "TSLA", "NVDA", "MSFT", "AMZN", "SPY"];
const TFS: TF[] = ["1h", "4h", "1d"];
const FEE = 0.001;
const MAX_HOLD = 60; // velas máximas en una operación; luego cierra a mercado

// ───────── Datos (con paginación para tener historial largo) ─────────
async function binance(sym: string, tf: TF, total: number): Promise<Candle[]> {
  let end = Date.now(), out: Candle[] = [];
  while (out.length < total) {
    let rows: any[] = [];
    for (const host of ["https://api.binance.com", "https://data-api.binance.vision"]) {
      try {
        const r = await fetch(`${host}/api/v3/klines?symbol=${sym}&interval=${tf}&limit=1000&endTime=${end}`);
        if (r.ok) { rows = await r.json(); break; }
      } catch {}
    }
    if (!rows.length) break;
    const k = rows.map((x) => ({ t: x[0], o: +x[1], h: +x[2], l: +x[3], c: +x[4], v: +x[5], ct: x[6] }));
    out = [...k, ...out];
    end = k[0].t - 1;
    if (rows.length < 1000) break;
  }
  const now = Date.now();
  return out.filter((x: any) => x.ct < now);
}
async function yahoo(sym: string, interval: string, range: string): Promise<Candle[]> {
  const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${sym}?interval=${interval}&range=${range}`, { headers: { "User-Agent": "Mozilla/5.0" } });
  const res: any = (await r.json()).chart?.result?.[0];
  if (!res) throw new Error("Yahoo sin datos");
  const q = res.indicators.quote[0], out: Candle[] = [];
  res.timestamp.forEach((ts: number, i: number) => {
    if (q.close[i] != null && q.open[i] != null) out.push({ t: ts * 1000, o: q.open[i], h: q.high[i], l: q.low[i], c: q.close[i], v: q.volume[i] ?? 0 });
  });
  return out;
}
function to4h(h1: Candle[]): Candle[] {
  const byDay = new Map<string, Candle[]>();
  for (const c of h1) { const k = new Date(c.t - 5 * H).toISOString().slice(0, 10); (byDay.get(k) ?? byDay.set(k, []).get(k)!).push(c); }
  const out: Candle[] = [];
  for (const bars of byDay.values())
    for (let i = 0; i < bars.length; i += 4) {
      const g = bars.slice(i, i + 4);
      out.push({ t: g[0].t, o: g[0].o, c: g.at(-1)!.c, h: Math.max(...g.map((x) => x.h)), l: Math.min(...g.map((x) => x.l)), v: g.reduce((s, x) => s + x.v, 0) });
    }
  return out;
}
async function hyperliquid(coin: string, tf: TF): Promise<Candle[]> {
  const step = TF_MS[tf] * 4000, now = Date.now();
  const out = new Map<number, Candle>();
  for (let start = Date.UTC(2024, 10, 1); start < now; start += step) {
    const r = await fetch("https://api.hyperliquid.xyz/info", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "candleSnapshot", req: { coin, interval: tf, startTime: start, endTime: Math.min(start + step, now) } }),
    });
    const rows: any[] = r.ok ? await r.json() : [];
    for (const x of rows) if (x.T < now) out.set(x.t, { t: x.t, o: +x.o, h: +x.h, l: +x.l, c: +x.c, v: +x.v });
  }
  return [...out.values()].sort((a, b) => a.t - b.t);
}
async function load(sym: string, crypto: boolean): Promise<Record<TF, Candle[]>> {
  if (HYPERLIQUID[sym]) { const c = HYPERLIQUID[sym]; return { "1h": await hyperliquid(c, "1h"), "4h": await hyperliquid(c, "4h"), "1d": await hyperliquid(c, "1d") }; }
  if (crypto) return { "1h": await binance(sym, "1h", 8000), "4h": await binance(sym, "4h", 4000), "1d": await binance(sym, "1d", 2000) };
  const h1 = (await yahoo(sym, "60m", "730d")).filter((c) => c.t + H <= Date.now());
  return { "1h": h1, "4h": to4h(h1), "1d": (await yahoo(sym, "1d", "10y")).filter((c) => c.t + 20 * H < Date.now()) };
}

// ───────── Indicadores (mismos que el bot) ─────────
function ema(v: number[], p: number) { const o = new Array(v.length).fill(NaN); if (v.length < p) return o; let s = v.slice(0, p).reduce((a, b) => a + b, 0) / p; o[p - 1] = s; const k = 2 / (p + 1); for (let i = p; i < v.length; i++) o[i] = s = v[i] * k + s * (1 - k); return o; }
function wilder(v: number[], p: number) { const o = new Array(v.length).fill(NaN); if (v.length <= p) return o; let s = v.slice(1, p + 1).reduce((a, b) => a + b, 0) / p; o[p] = s; for (let i = p + 1; i < v.length; i++) o[i] = s = (s * (p - 1) + v[i]) / p; return o; }
function rsi(c: number[], p = 14) { const g = c.map((x, i) => (i ? Math.max(x - c[i - 1], 0) : 0)), l = c.map((x, i) => (i ? Math.max(c[i - 1] - x, 0) : 0)); const ag = wilder(g, p), al = wilder(l, p); return ag.map((x, i) => (al[i] === 0 ? 100 : 100 - 100 / (1 + x / al[i]))); }
function macd(c: number[]) { const a = ema(c, 12), b = ema(c, 26); const line = c.map((_, i) => a[i] - b[i]); const st = line.findIndex((x) => !isNaN(x)); const sp = ema(line.slice(st), 9); const signal = line.map((_, i) => (i < st ? NaN : sp[i - st])); return { line, signal, hist: line.map((x, i) => x - signal[i]) }; }
function atrAdx(k: Candle[], p = 14) {
  const tr = k.map((x, i) => (i ? Math.max(x.h - x.l, Math.abs(x.h - k[i - 1].c), Math.abs(x.l - k[i - 1].c)) : x.h - x.l));
  const pdm = k.map((x, i) => { if (!i) return 0; const u = x.h - k[i - 1].h, d = k[i - 1].l - x.l; return u > d && u > 0 ? u : 0; });
  const ndm = k.map((x, i) => { if (!i) return 0; const u = x.h - k[i - 1].h, d = k[i - 1].l - x.l; return d > u && d > 0 ? d : 0; });
  const atr = wilder(tr, p), sp = wilder(pdm, p), sn = wilder(ndm, p);
  const dx = atr.map((a, i) => { const P = (100 * sp[i]) / a, N = (100 * sn[i]) / a; return (100 * Math.abs(P - N)) / (P + N || 1); });
  const f = dx.findIndex((x) => !isNaN(x)); const ap = wilder(dx.slice(f), p);
  return { atr, adx: dx.map((_, i) => (i < f ? NaN : ap[i - f])) };
}

// ───────── Estrategia parametrizable ─────────
type Params = { name: string; minFilters: number; slAtr: number; rr: number; htf: boolean; adxMin: number };
const VARIANTS: Params[] = [
  { name: "A actual (3 filtros, SL 1.5 ATR)", minFilters: 3, slAtr: 1.5, rr: 2, htf: false, adxMin: 20 },
  { name: "B 4 filtros", minFilters: 4, slAtr: 1.5, rr: 2, htf: false, adxMin: 20 },
  { name: "C + tendencia mayor", minFilters: 3, slAtr: 1.5, rr: 2, htf: true, adxMin: 20 },
  { name: "D + tendencia mayor, 4 filtros", minFilters: 4, slAtr: 1.5, rr: 2, htf: true, adxMin: 20 },
  { name: "E + tendencia mayor, SL 2 ATR", minFilters: 3, slAtr: 2, rr: 2, htf: true, adxMin: 20 },
  { name: "F + tendencia mayor, ADX 25", minFilters: 3, slAtr: 1.5, rr: 2, htf: true, adxMin: 25 },
];

// tendencia de la temporalidad mayor, alineada a cada vela (solo velas mayores ya cerradas)
function htfTrend(k: Candle[], tf: TF, big: Candle[] | undefined): number[] {
  if (!big) return k.map(() => 0);
  const c = big.map((x) => x.c), e50 = ema(c, 50), e200 = ema(c, 200);
  const dir = big.map((_, i) => (c[i] > e200[i] && e50[i] > e200[i] ? 1 : c[i] < e200[i] && e50[i] < e200[i] ? -1 : 0));
  return alignHtf(k, tf, big, dir);
}
// tendencia EMA20/EMA50 del gráfico diario (regla del artículo), alineada a velas cerradas
function dailyTrend2050(k: Candle[], tf: TF, daily: Candle[]): number[] {
  const c = daily.map((x) => x.c), e20 = ema(c, 20), e50 = ema(c, 50);
  const dir = daily.map((_, i) => (e20[i] > e50[i] ? 1 : e20[i] < e50[i] ? -1 : 0));
  if (tf === "1d") return dir;
  return alignHtf(k, tf, daily, dir, "1d");
}
function alignHtf(k: Candle[], tf: TF, big: Candle[], dir: number[], bigTf: TF = HTF[tf]!): number[] {
  const bigMs = TF_MS[bigTf];
  const out: number[] = []; let j = -1;
  for (const x of k) {
    const closeT = x.t + TF_MS[tf];
    while (j + 1 < big.length && big[j + 1].t + bigMs <= closeT) j++;
    out.push(j >= 0 ? dir[j] : 0);
  }
  return out;
}

type Trade = { side: "LONG" | "SHORT"; r: number; bars: number; t: number };
function backtest(k: Candle[], htfDir: number[], p: Params): Trade[] {
  const c = k.map((x) => x.c), e20 = ema(c, 20), e50 = ema(c, 50), e200 = ema(c, 200);
  const r = rsi(c), m = macd(c), { atr, adx } = atrAdx(k);
  const trades: Trade[] = [];
  let busyUntil = -1;
  for (let i = 220; i < k.length - 1; i++) {
    if (i <= busyUntil) continue;
    const j = i - 1;
    const volAvg = k.slice(i - 20, i).reduce((s, x) => s + x.v, 0) / 20;
    const up = c[i] > e200[i] && e50[i] > e200[i], down = c[i] < e200[i] && e50[i] < e200[i];
    for (const side of ["LONG", "SHORT"] as const) {
      const L = side === "LONG";
      if (L ? !up : !down) continue;
      if (p.htf && htfDir[i] !== (L ? 1 : -1)) continue;
      const trig = (L ? e20[j] <= e50[j] && e20[i] > e50[i] : e20[j] >= e50[j] && e20[i] < e50[i]) ||
        (L ? m.hist[j] <= 0 && m.hist[i] > 0 : m.hist[j] >= 0 && m.hist[i] < 0) ||
        (L ? r[j] <= 50 && r[i] > 50 : r[j] >= 50 && r[i] < 50);
      if (!trig) continue;
      const ok = [adx[i] >= p.adxMin, L ? r[i] >= 50 && r[i] <= 70 : r[i] >= 30 && r[i] <= 50,
        L ? m.line[i] > m.signal[i] : m.line[i] < m.signal[i], volAvg > 0 && k[i].v >= volAvg].filter(Boolean).length;
      if (ok < p.minFilters) continue;

      const entry = c[i], risk = p.slAtr * atr[i];
      const sl = L ? entry - risk : entry + risk, tp = L ? entry + risk * p.rr : entry - risk * p.rr;
      const feeR = (FEE * entry) / risk;
      let res = NaN, n = 0;
      for (n = 1; n <= MAX_HOLD && i + n < k.length; n++) {
        const b = k[i + n];
        const hitSl = L ? b.l <= sl : b.h >= sl, hitTp = L ? b.h >= tp : b.l <= tp;
        if (hitSl) { res = -1; break; }
        if (hitTp) { res = p.rr; break; }
      }
      if (isNaN(res)) { // cierre por tiempo
        const last = k[Math.min(i + MAX_HOLD, k.length - 1)].c;
        if (i + MAX_HOLD >= k.length) break; // operación aún abierta al final: se ignora
        res = ((L ? last - entry : entry - last) / risk);
      }
      trades.push({ side, r: res - feeR, bars: n, t: k[i].t });
      busyUntil = i + n;
      break;
    }
  }
  return trades;
}

// ───────── Estrategia del artículo: acción del precio en soporte/resistencia ─────────
// Tendencia: EMA20 vs EMA50 en diario. Zona: pivote (fractal 3+3) de las últimas 60 velas ± 0.5 ATR.
// Patrón: envolvente o pin bar (mecha ≥ 2× cuerpo y ≥ 60% del rango). Entrada: orden stop
// 0.1 ATR más allá del extremo de la vela señal, válida solo la vela siguiente. SL: otro extremo − 0.1 ATR.
type PAParams = { name: string; rr: number; be: boolean; localTrend: boolean };
const PA_VARIANTS: PAParams[] = [
  { name: "G artículo (S/R + vela, 1:2)", rr: 2, be: false, localTrend: false },
  { name: "H artículo + breakeven en 1R", rr: 2, be: true, localTrend: false },
  { name: "I artículo + tendencia propia", rr: 2, be: false, localTrend: true },
];
function backtestPA(k: Candle[], dDir: number[], p: PAParams): Trade[] {
  const c = k.map((x) => x.c), { atr } = atrAdx(k), e20 = ema(c, 20), e50 = ema(c, 50);
  const isPivLow = (i: number) => i >= 3 && i + 3 < k.length && [1, 2, 3].every((d) => k[i].l <= k[i - d].l && k[i].l <= k[i + d].l);
  const isPivHigh = (i: number) => i >= 3 && i + 3 < k.length && [1, 2, 3].every((d) => k[i].h >= k[i - d].h && k[i].h >= k[i + d].h);
  const trades: Trade[] = [];
  let busyUntil = -1;
  for (let i = 220; i < k.length - 2; i++) {
    if (i <= busyUntil) continue;
    const b = k[i], pv = k[i - 1], a = atr[i];
    const body = Math.abs(b.c - b.o), range = b.h - b.l;
    if (!range || !a) continue;
    for (const side of ["LONG", "SHORT"] as const) {
      const L = side === "LONG";
      if (dDir[i] !== (L ? 1 : -1)) continue;
      if (p.localTrend && (L ? e20[i] <= e50[i] : e20[i] >= e50[i])) continue;
      // zona: pivotes confirmados (j+3 < i) de las últimas 60 velas
      let atZone = false;
      for (let j = i - 60; j <= i - 4 && !atZone; j++) {
        if (j < 3) continue;
        if (L && isPivLow(j) && b.l <= k[j].l + 0.5 * a && b.c > k[j].l) atZone = true;
        if (!L && isPivHigh(j) && b.h >= k[j].h - 0.5 * a && b.c < k[j].h) atZone = true;
      }
      if (!atZone) continue;
      const engulf = L ? pv.c < pv.o && b.c > b.o && b.c >= pv.o && b.o <= pv.c : pv.c > pv.o && b.c < b.o && b.c <= pv.o && b.o >= pv.c;
      const wick = L ? Math.min(b.o, b.c) - b.l : b.h - Math.max(b.o, b.c);
      const pin = wick >= 2 * body && wick >= 0.6 * range;
      if (!engulf && !pin) continue;

      const entry = L ? b.h + 0.1 * a : b.l - 0.1 * a;
      const sl = L ? b.l - 0.1 * a : b.h + 0.1 * a;
      const nx = k[i + 1];
      const filled = L ? nx.h >= entry : nx.l <= entry;
      if (!filled) continue;
      const fill = L ? Math.max(entry, nx.o) : Math.min(entry, nx.o); // si abre con gap, entra al precio de apertura
      const risk = Math.abs(fill - sl);
      if (risk <= 0) continue;
      const tp = L ? fill + risk * p.rr : fill - risk * p.rr;
      const feeR = (FEE * fill) / risk;
      let stop = sl, res = NaN, n = 0;
      for (n = 1; n <= MAX_HOLD && i + n < k.length; n++) {
        const x = k[i + n];
        const hitSl = L ? x.l <= stop : x.h >= stop, hitTp = L ? x.h >= tp : x.l <= tp;
        if (hitSl) { res = stop === sl ? -1 : 0; break; }
        if (hitTp) { res = p.rr; break; }
        if (p.be && (L ? x.h >= fill + risk : x.l <= fill - risk)) stop = fill;
      }
      if (isNaN(res)) {
        if (i + MAX_HOLD >= k.length) break;
        const last = k[i + MAX_HOLD].c;
        res = (L ? last - fill : fill - last) / risk;
      }
      trades.push({ side, r: res - feeR, bars: n, t: k[i].t });
      busyUntil = i + n;
      break;
    }
  }
  return trades;
}

// ───────── Estrategia EMA 30/150/200 + RSI + MACD (swing multitemporal) ─────────
// Diario: precio > EMA200 y EMA30 > EMA150 = alcista (inverso = bajista).
// Temporalidad operada: EMA30 > EMA150 > EMA200 alineadas a favor.
// "pullback": la vela toca la EMA30 y cierra a favor; "cruce": EMA30 cruza EMA150.
// Filtros: RSI 40-65 (long) / 35-60 (short), MACD a favor (línea vs señal) e histograma creciendo.
// partial: cierra 50% en 1R y mueve stop a entrada; resto a TP 1:2.
type EMAParams = { name: string; entry: "pullback" | "cruce"; partial: boolean; slAtr: number };
const EMA_VARIANTS: EMAParams[] = [
  { name: "J EMA30/150/200 retroceso", entry: "pullback", partial: false, slAtr: 1.5 },
  { name: "K EMA retroceso + parcial 1R", entry: "pullback", partial: true, slAtr: 1.5 },
  { name: "L EMA30/150 cruce", entry: "cruce", partial: false, slAtr: 1.5 },
  { name: "M EMA retroceso, SL 2 ATR", entry: "pullback", partial: false, slAtr: 2 },
];
function dailyTrendEMA(k: Candle[], tf: TF, daily: Candle[]): number[] {
  const c = daily.map((x) => x.c), e30 = ema(c, 30), e150 = ema(c, 150), e200 = ema(c, 200);
  const dir = daily.map((_, i) => (c[i] > e200[i] && e30[i] > e150[i] ? 1 : c[i] < e200[i] && e30[i] < e150[i] ? -1 : 0));
  if (tf === "1d") return dir;
  return alignHtf(k, tf, daily, dir, "1d");
}
function simulate(k: Candle[], i: number, L: boolean, entry: number, sl: number, rr: number, partial: boolean): { r: number; n: number } | null {
  const risk = Math.abs(entry - sl);
  const tp = L ? entry + risk * rr : entry - risk * rr, p1 = L ? entry + risk : entry - risk;
  let stop = sl, banked = 0, size = 1;
  for (let n = 1; n <= MAX_HOLD; n++) {
    if (i + n >= k.length) return null;
    const x = k[i + n];
    const hitSl = L ? x.l <= stop : x.h >= stop;
    if (hitSl) return { r: banked + size * ((L ? stop - entry : entry - stop) / risk), n };
    if (partial && size === 1 && (L ? x.h >= p1 : x.l <= p1)) { banked += 0.5; size = 0.5; stop = entry; }
    if (L ? x.h >= tp : x.l <= tp) return { r: banked + size * rr, n };
  }
  const last = k[i + MAX_HOLD].c;
  return { r: banked + size * ((L ? last - entry : entry - last) / risk), n: MAX_HOLD };
}
function backtestEMA(k: Candle[], dDir: number[], p: EMAParams): Trade[] {
  const c = k.map((x) => x.c), e30 = ema(c, 30), e150 = ema(c, 150), e200 = ema(c, 200);
  const r = rsi(c), m = macd(c), { atr } = atrAdx(k);
  const trades: Trade[] = [];
  let busyUntil = -1;
  for (let i = 220; i < k.length - 1; i++) {
    if (i <= busyUntil) continue;
    const j = i - 1, b = k[i];
    for (const side of ["LONG", "SHORT"] as const) {
      const L = side === "LONG";
      if (dDir[i] !== (L ? 1 : -1)) continue;
      const aligned = L ? e30[i] > e150[i] && e150[i] > e200[i] : e30[i] < e150[i] && e150[i] < e200[i];
      const trig = p.entry === "pullback"
        ? aligned && (L ? b.l <= e30[i] && b.c > e30[i] && b.c > b.o : b.h >= e30[i] && b.c < e30[i] && b.c < b.o)
        : (L ? e30[j] <= e150[j] && e30[i] > e150[i] : e30[j] >= e150[j] && e30[i] < e150[i]) && (L ? c[i] > e200[i] : c[i] < e200[i]);
      if (!trig) continue;
      const rsiOk = L ? r[i] >= 40 && r[i] <= 65 : r[i] >= 35 && r[i] <= 60;
      const macdOk = (L ? m.line[i] > m.signal[i] : m.line[i] < m.signal[i]) && (L ? m.hist[i] > m.hist[j] : m.hist[i] < m.hist[j]);
      if (!rsiOk || !macdOk) continue;
      const entry = c[i], risk = p.slAtr * atr[i];
      const sim = simulate(k, i, L, entry, L ? entry - risk : entry + risk, 2, p.partial);
      if (!sim) break;
      trades.push({ side, r: sim.r - (FEE * entry) / risk, bars: sim.n, t: k[i].t });
      busyUntil = i + sim.n;
      break;
    }
  }
  return trades;
}

// ═════════ Estrategias nuevas (investigación de traders) ═════════
function sma(v: number[], p: number) { const o = new Array(v.length).fill(NaN); let s = 0; for (let i = 0; i < v.length; i++) { s += v[i]; if (i >= p) s -= v[i - p]; if (i >= p - 1) o[i] = s / p; } return o; }
const pivH = (k: Candle[], i: number, n: number) => i >= n && i + n < k.length && Array.from({ length: n }, (_, d) => d + 1).every((d) => k[i].h >= k[i - d].h && k[i].h > k[i + d].h);
const pivL = (k: Candle[], i: number, n: number) => i >= n && i + n < k.length && Array.from({ length: n }, (_, d) => d + 1).every((d) => k[i].l <= k[i - d].l && k[i].l < k[i + d].l);

// Estructura diaria (máximos y mínimos crecientes / decrecientes), alineada sin mirar al futuro
function dailyStructure(k: Candle[], tf: TF, daily: Candle[]): number[] {
  const N = 2, dir: number[] = []; const hs: number[] = [], ls: number[] = [];
  for (let i = 0; i < daily.length; i++) {
    const j = i - N; // pivote confirmado N velas después
    if (j >= N) { if (pivH(daily, j, N)) hs.push(daily[j].h); if (pivL(daily, j, N)) ls.push(daily[j].l); }
    const up = hs.length >= 2 && ls.length >= 2 && hs.at(-1)! > hs.at(-2)! && ls.at(-1)! > ls.at(-2)!;
    const dn = hs.length >= 2 && ls.length >= 2 && hs.at(-1)! < hs.at(-2)! && ls.at(-1)! < ls.at(-2)!;
    dir.push(up ? 1 : dn ? -1 : 0);
  }
  if (tf === "1d") return dir;
  return alignHtf(k, tf, daily, dir, "1d");
}

// N · Método Alex Ruiz (fractalidad): tendencia por estructura en diario; en la temporalidad operada,
// tras un retroceso que deja un mínimo más alto (HL), entrar al romper el último máximo (BOS).
// SL detrás del último giro. TP 1:3 (o 1:2 en la variante).
type ARParams = { name: string; rr: number; n: number };
const AR_VARIANTS: ARParams[] = [
  { name: "N Alex Ruiz estructura 1:3", rr: 3, n: 2 },
  { name: "O Alex Ruiz estructura 1:2", rr: 2, n: 2 },
  { name: "P Alex Ruiz estructura 1:3, giros 3", rr: 3, n: 3 },
];
function backtestAR(k: Candle[], dDir: number[], p: ARParams): Trade[] {
  const { atr } = atrAdx(k), trades: Trade[] = [];
  const H: { i: number; v: number }[] = [], Lw: { i: number; v: number }[] = [];
  let busyUntil = -1, usedH = -1, usedL = -1;
  for (let i = 50; i < k.length - 1; i++) {
    const j = i - p.n;
    if (pivH(k, j, p.n)) H.push({ i: j, v: k[j].h });
    if (pivL(k, j, p.n)) Lw.push({ i: j, v: k[j].l });
    if (i <= busyUntil || H.length < 2 || Lw.length < 2) continue;
    const a = atr[i], b = k[i], pv = k[i - 1];
    // LONG: estructura alcista local (HL), cierre rompe el último máximo
    const lh = H.at(-1)!, ll = Lw.at(-1)!, pl = Lw.at(-2)!, phh = H.at(-1)!, ph = H.at(-2)!;
    let done = false;
    if (dDir[i] === 1 && ll.v > pl.v && ll.i > lh.i && lh.i !== usedH && pv.c <= lh.v && b.c > lh.v) {
      const sl = ll.v - 0.1 * a, risk = b.c - sl;
      if (risk > 0.5 * a && risk < 4 * a) {
        const sim = simulate(k, i, true, b.c, sl, p.rr, false);
        if (!sim) break;
        trades.push({ side: "LONG", r: sim.r - (FEE * b.c) / risk, bars: sim.n, t: b.t }); busyUntil = i + sim.n; usedH = lh.i; done = true;
      }
    }
    // SHORT: máximo más bajo (LH), cierre rompe el último mínimo; SL sobre el último máximo
    if (!done && dDir[i] === -1 && phh.v < ph.v && phh.i > ll.i && ll.i !== usedL && pv.c >= ll.v && b.c < ll.v) {
      const sl = phh.v + 0.1 * a, risk = sl - b.c;
      if (risk > 0.5 * a && risk < 4 * a) {
        const sim = simulate(k, i, false, b.c, sl, p.rr, false);
        if (!sim) break;
        trades.push({ side: "SHORT", r: sim.r - (FEE * b.c) / risk, bars: sim.n, t: b.t }); busyUntil = i + sim.n; usedL = ll.i;
      }
    }
  }
  return trades;
}

// Q · RSI(2) de Larry Connors: en tendencia (precio vs SMA200), comprar cuando RSI(2) < 10
// (vender si > 90 en bajista). Salida: cierre cruza la SMA5. Stop de protección 3 ATR. R = pnl / riesgo.
// R · Donchian ("Tortugas"): cierre rompe máximo/mínimo de 20 velas a favor de la EMA200.
// Stop inicial 2 ATR; salida por mínimo/máximo de 10 velas (stop que persigue al precio).
type ExitParams = { name: string; kind: "rsi2" | "donchian"; shorts: boolean };
const EXIT_VARIANTS: ExitParams[] = [
  { name: "Q Connors RSI(2) solo LONG", kind: "rsi2", shorts: false },
  { name: "R Connors RSI(2) LONG+SHORT", kind: "rsi2", shorts: true },
  { name: "S Donchian 20/10 Tortugas", kind: "donchian", shorts: true },
];
function backtestExit(k: Candle[], p: ExitParams): Trade[] {
  const c = k.map((x) => x.c), s200 = sma(c, 200), s5 = sma(c, 5), e200 = ema(c, 200), r2 = rsi(c, 2), { atr } = atrAdx(k);
  const trades: Trade[] = [];
  for (let i = 220; i < k.length - 1; i++) {
    let L: boolean | null = null;
    if (p.kind === "rsi2") {
      if (c[i] > s200[i] && r2[i] < 10) L = true;
      else if (p.shorts && c[i] < s200[i] && r2[i] > 90) L = false;
    } else {
      const hi = Math.max(...k.slice(i - 20, i).map((x) => x.h)), lo = Math.min(...k.slice(i - 20, i).map((x) => x.l));
      if (c[i] > hi && c[i] > e200[i]) L = true;
      else if (p.shorts && c[i] < lo && c[i] < e200[i]) L = false;
    }
    if (L === null) continue;
    const entry = c[i], risk = (p.kind === "rsi2" ? 3 : 2) * atr[i];
    let stop = L ? entry - risk : entry + risk, res = NaN, n = 0;
    for (n = 1; n <= MAX_HOLD * 2 && i + n < k.length; n++) {
      const x = k[i + n], m = i + n;
      if (L ? x.l <= stop : x.h >= stop) { res = (L ? stop - entry : entry - stop) / risk; break; }
      if (p.kind === "rsi2" && (L ? x.c > s5[m] : x.c < s5[m])) { res = (L ? x.c - entry : entry - x.c) / risk; break; }
      if (p.kind === "donchian" && m >= 10) {
        const t10 = L ? Math.min(...k.slice(m - 9, m + 1).map((y) => y.l)) : Math.max(...k.slice(m - 9, m + 1).map((y) => y.h));
        stop = L ? Math.max(stop, t10) : Math.min(stop, t10);
      }
    }
    if (isNaN(res)) { if (i + n >= k.length) break; res = (L ? c[i + n - 1] - entry : entry - c[i + n - 1]) / risk; }
    trades.push({ side: L ? "LONG" : "SHORT", r: res - (FEE * entry) / risk, bars: n, t: k[i].t });
    i += n;
  }
  return trades;
}

function stats(tr: Trade[]) {
  const n = tr.length, wins = tr.filter((t) => t.r > 0).length;
  const total = tr.reduce((s, t) => s + t.r, 0);
  const gw = tr.filter((t) => t.r > 0).reduce((s, t) => s + t.r, 0), gl = -tr.filter((t) => t.r < 0).reduce((s, t) => s + t.r, 0);
  let eq = 0, peak = 0, dd = 0;
  for (const t of [...tr].sort((a, b) => a.t - b.t)) { eq += t.r; peak = Math.max(peak, eq); dd = Math.max(dd, peak - eq); }
  return { n, win: n ? (wins / n) * 100 : 0, total, avg: n ? total / n : 0, pf: gl ? gw / gl : gw ? 99 : 0, dd };
}
const row = (label: string, s: ReturnType<typeof stats>) =>
  `${label.padEnd(34)} ${String(s.n).padStart(5)} ${s.win.toFixed(1).padStart(6)}% ${s.total.toFixed(1).padStart(8)}R ${s.avg.toFixed(2).padStart(6)}R ${s.pf.toFixed(2).padStart(5)} ${s.dd.toFixed(1).padStart(6)}R`;
const HEAD = `${"".padEnd(34)} ${"ops".padStart(5)} ${"acierto".padStart(7)} ${"total".padStart(9)} ${"media".padStart(7)} ${"PF".padStart(5)} ${"maxDD".padStart(7)}`;

// ───────── Ejecutar ─────────
const all: Record<string, Trade[]> = {}; // clave: variante|sym|tf
const cutoff: Record<string, number> = {}; // 70% inicial = "entrenamiento", 30% final = "prueba"
const ranges: string[] = [];
for (const [sym, crypto] of [...CRYPTO.map((s) => [s, true] as const), ...STOCKS.map((s) => [s, false] as const)]) {
  let data: Record<TF, Candle[]>;
  try { data = await load(sym, crypto); } catch (e) { console.error(sym, "error de datos:", (e as Error).message); continue; }
  for (const tf of TFS) {
    const k = data[tf];
    if (k.length < 300) continue;
    ranges.push(`${sym} ${tf}: ${k.length} velas desde ${new Date(k[0].t).toISOString().slice(0, 10)}`);
    const dir = htfTrend(k, tf, HTF[tf] ? data[HTF[tf]!] : undefined);
    for (const p of VARIANTS) all[`${p.name}|${sym}|${tf}`] = backtest(k, dir, p);
    const dDir = dailyTrend2050(k, tf, data["1d"]);
    for (const p of PA_VARIANTS) all[`${p.name}|${sym}|${tf}`] = backtestPA(k, dDir, p);
    const eDir = dailyTrendEMA(k, tf, data["1d"]);
    for (const p of EMA_VARIANTS) all[`${p.name}|${sym}|${tf}`] = backtestEMA(k, eDir, p);
    const sDir = dailyStructure(k, tf, data["1d"]);
    for (const p of AR_VARIANTS) all[`${p.name}|${sym}|${tf}`] = backtestAR(k, sDir, p);
    for (const p of EXIT_VARIANTS) all[`${p.name}|${sym}|${tf}`] = backtestExit(k, p);
    cutoff[`${sym}|${tf}`] = k[Math.floor(k.length * 0.7)].t;
  }
  console.error("✓", sym);
}

const pick = (f: (v: string, s: string, t: string) => boolean) => Object.entries(all).filter(([key]) => f(...(key.split("|") as [string, string, string]))).flatMap(([, v]) => v);
const pickSplit = (f: (v: string, s: string, t: string) => boolean, oos: boolean) =>
  Object.entries(all).filter(([key]) => f(...(key.split("|") as [string, string, string]))).flatMap(([key, v]) => {
    const [, s, t] = key.split("|"); const c = cutoff[`${s}|${t}`];
    return v.filter((x) => (oos ? x.t >= c : x.t < c));
  });
const NAMES = [...VARIANTS.map((p) => p.name), ...PA_VARIANTS.map((p) => p.name), ...EMA_VARIANTS.map((p) => p.name), ...AR_VARIANTS.map((p) => p.name), ...EXIT_VARIANTS.map((p) => p.name)];
const out: string[] = [];
out.push("HISTORIAL USADO", ...ranges, "");
out.push("═══ RESUMEN POR VARIANTE (todos los activos y temporalidades) ═══", HEAD);
for (const n of NAMES) out.push(row(n, stats(pick((v) => v === n))));
for (const tf of TFS) {
  out.push("", `═══ ${tf.toUpperCase()} ═══`, HEAD);
  for (const n of NAMES) out.push(row(n, stats(pick((v, _s, t) => v === n && t === tf))));
  out.push(`  — validación: 70% inicial vs 30% final (datos no vistos) —`);
  for (const n of NAMES) {
    out.push(row(`${n} · 70%`, stats(pickSplit((v, _s, t) => v === n && t === tf, false))));
    out.push(row(`${n} · 30%`, stats(pickSplit((v, _s, t) => v === n && t === tf, true))));
  }
}
const VARIANTS_ALL = NAMES.map((name) => ({ name }));
out.push("", "═══ CRIPTO vs ACCIONES ═══", HEAD);
for (const p of VARIANTS_ALL) {
  out.push(row(p.name + " · cripto", stats(pick((v, s) => v === p.name && CRYPTO.includes(s)))));
  out.push(row(p.name + " · acciones", stats(pick((v, s) => v === p.name && STOCKS.includes(s)))));
}
out.push("", "═══ LONG vs SHORT ═══", HEAD);
for (const p of VARIANTS_ALL) {
  const t = pick((v) => v === p.name);
  out.push(row(p.name + " · LONG", stats(t.filter((x) => x.side === "LONG"))));
  out.push(row(p.name + " · SHORT", stats(t.filter((x) => x.side === "SHORT"))));
}
for (const p of VARIANTS_ALL) {
  out.push("", `═══ DETALLE: ${p.name} ═══`, HEAD);
  for (const [sym] of [...CRYPTO, ...STOCKS].map((s) => [s]))
    for (const tf of TFS) out.push(row(`${sym} ${tf}`, stats(pick((v, s, t) => v === p.name && s === sym && t === tf))));
}
const text = out.join("\n");
writeFileSync("backtest_resultados.txt", text);
console.log(text.split("\n═══ DETALLE")[0]);
