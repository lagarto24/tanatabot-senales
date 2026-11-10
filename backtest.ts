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

const CRYPTO = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "HYPEUSDT", "BNBUSDT", "DOGEUSDT", "XRPUSDT", "SUIUSDT", "AVAXUSDT"];
const HYPERLIQUID: Record<string, string> = { HYPEUSDT: "HYPE" };
const STOCKS = ["AAPL", "TSLA", "NVDA", "MSFT", "AMZN", "SPY", "QQQ", "INTC", "AMD", "GOOGL", "META", "NFLX", "AVGO", "COST", "LLY", "ORCL", "GLD", "SLV"];
const TFS: TF[] = ["1h", "4h", "1d"];
let FEE = 0.001; // let: la prueba de estrés la duplica
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
type ExitParams = { name: string; kind: "rsi2" | "donchian"; shorts: boolean; n?: number; trail?: number; sl?: number; th?: number; ex?: number; gate?: number[]; tp?: number };
const EXIT_VARIANTS: ExitParams[] = [
  { name: "Q Connors RSI(2) solo LONG", kind: "rsi2", shorts: false },
  { name: "R Connors RSI(2) LONG+SHORT", kind: "rsi2", shorts: true },
  { name: "S Donchian 20/10 Tortugas", kind: "donchian", shorts: true },
  { name: "S2 Donchian solo LONG", kind: "donchian", shorts: false },
];
function backtestExit(k: Candle[], p: ExitParams): Trade[] {
  const c = k.map((x) => x.c), s200 = sma(c, 200), s5 = sma(c, p.ex ?? 5), e200 = ema(c, 200), r2 = rsi(c, 2), { atr } = atrAdx(k);
  const trades: Trade[] = [];
  for (let i = 220; i < k.length - 1; i++) {
    let L: boolean | null = null;
    if (p.kind === "rsi2") {
      if (c[i] > s200[i] && r2[i] < (p.th ?? 10)) L = true;
      else if (p.shorts && c[i] < s200[i] && r2[i] > 100 - (p.th ?? 10)) L = false;
    } else {
      const hi = Math.max(...k.slice(i - (p.n ?? 20), i).map((x) => x.h)), lo = Math.min(...k.slice(i - (p.n ?? 20), i).map((x) => x.l));
      if (c[i] > hi && c[i] > e200[i] && (!p.gate || p.gate[i] === 1)) L = true;
      else if (p.shorts && c[i] < lo && c[i] < e200[i]) L = false;
    }
    if (L === null) continue;
    const entry = c[i], risk = (p.sl ?? (p.kind === "rsi2" ? 3 : 2)) * atr[i];
    let stop = L ? entry - risk : entry + risk, res = NaN, n = 0;
    for (n = 1; n <= MAX_HOLD * 2 && i + n < k.length; n++) {
      const x = k[i + n], m = i + n;
      if (L ? x.l <= stop : x.h >= stop) { res = (L ? stop - entry : entry - stop) / risk; break; }
      if (p.tp && (L ? x.h >= entry + p.tp * risk : x.l <= entry - p.tp * risk)) { res = p.tp; break; }
      if (p.kind === "rsi2" && (L ? x.c > s5[m] : x.c < s5[m])) { res = (L ? x.c - entry : entry - x.c) / risk; break; }
      if (p.kind === "donchian" && m >= (p.trail ?? 10)) {
        const t10 = L ? Math.min(...k.slice(m - (p.trail ?? 10) + 1, m + 1).map((y) => y.l)) : Math.max(...k.slice(m - (p.trail ?? 10) + 1, m + 1).map((y) => y.h));
        stop = L ? Math.max(stop, t10) : Math.min(stop, t10);
      }
    }
    if (isNaN(res)) { if (i + n >= k.length) break; res = (L ? c[i + n - 1] - entry : entry - c[i + n - 1]) / risk; }
    trades.push({ side: L ? "LONG" : "SHORT", r: res - (FEE * entry) / risk, bars: n, t: k[i].t });
    i += n;
  }
  return trades;
}

// ═════════ Estrategias de Larry Williams ═════════
// Entradas con orden stop para la vela siguiente (se rellena si el precio llega; si abre más allá, al precio de apertura).
// Salidas al estilo Williams: "primera apertura con ganancia" (bailout) o tras N velas, con stop de protección.
type LWParams = { name: string; kind: "volbreak" | "smash" | "oops" | "wr"; shorts: boolean; k?: number };
const LW_VARIANTS: LWParams[] = [
  { name: "T Williams ruptura volatilidad 0.6", kind: "volbreak", shorts: false, k: 0.6 },
  { name: "U Williams ruptura volatilidad L+S", kind: "volbreak", shorts: true, k: 0.6 },
  { name: "V Williams Smash Day", kind: "smash", shorts: true },
  { name: "W Williams Oops", kind: "oops", shorts: true },
  { name: "X Williams %R en tendencia", kind: "wr", shorts: false },
];
function williamsR(k: Candle[], p: number) { return k.map((_, i) => { if (i < p - 1) return NaN; const s = k.slice(i - p + 1, i + 1); const hh = Math.max(...s.map((x) => x.h)), ll = Math.min(...s.map((x) => x.l)); return hh === ll ? -50 : (-100 * (hh - k[i].c)) / (hh - ll); }); }
function backtestLW(k: Candle[], p: LWParams): Trade[] {
  const c = k.map((x) => x.c), s200 = sma(c, 200), { atr } = atrAdx(k), wr = williamsR(k, 10);
  const trades: Trade[] = [];
  for (let i = 220; i < k.length - 2; i++) {
    const b = k[i], pv = k[i - 1], nx = k[i + 1], rng = b.h - b.l;
    const upT = c[i] > s200[i], dnT = c[i] < s200[i];
    let L: boolean | null = null, trig = NaN, stop = NaN;
    // señales calculadas al cierre de la vela i, ejecutadas en la vela i+1
    if (p.kind === "volbreak") {
      if (upT && nx.h >= nx.o + p.k! * rng) { L = true; trig = nx.o + p.k! * rng; stop = trig - rng; }
      else if (p.shorts && dnT && nx.l <= nx.o - p.k! * rng) { L = false; trig = nx.o - p.k! * rng; stop = trig + rng; }
    } else if (p.kind === "smash") {
      const lowest3 = Math.min(...k.slice(i - 3, i).map((x) => x.l)), highest3 = Math.max(...k.slice(i - 3, i).map((x) => x.h));
      if (upT && b.c < lowest3 && nx.h > b.h) { L = true; trig = b.h; stop = b.l; }
      else if (p.shorts && dnT && b.c > highest3 && nx.l < b.l) { L = false; trig = b.l; stop = b.h; }
    } else if (p.kind === "oops") {
      if (nx.o < b.l && nx.h >= b.l) { L = true; trig = b.l; stop = nx.l; }
      else if (p.shorts && nx.o > b.h && nx.l <= b.h) { L = false; trig = b.h; stop = nx.h; }
    } else if (p.kind === "wr") {
      if (upT && wr[i] < -90) { L = true; trig = c[i]; stop = c[i] - 3 * atr[i]; }
    }
    if (L === null) continue;
    const fill = p.kind === "wr" ? trig : L ? Math.max(trig, nx.o) : Math.min(trig, nx.o);
    const risk = Math.abs(fill - stop);
    if (!(risk > 0.1 * atr[i])) continue;
    const start = p.kind === "wr" ? i : i + 1; // vela de entrada
    if (p.kind !== "wr" && (L ? nx.l <= stop && nx.c < fill : nx.h >= stop && nx.c > fill)) { trades.push({ side: L ? "LONG" : "SHORT", r: -1 - (FEE * fill) / risk, bars: 1, t: b.t }); i = i + 1; continue; }
    let res = NaN, n = 0;
    for (n = 1; n <= 10 && start + n < k.length; n++) {
      const x = k[start + n];
      // 1) primera apertura con ganancia (bailout de Williams)
      if (p.kind !== "wr" && (L ? x.o > fill : x.o < fill)) { res = (L ? x.o - fill : fill - x.o) / risk; break; }
      // 2) stop de protección
      if (L ? x.l <= stop : x.h >= stop) { res = (L ? Math.min(stop, x.o) - fill : fill - Math.max(stop, x.o)) / risk; break; }
      // 3) %R: salir cuando el oscilador sube a sobrecompra
      if (p.kind === "wr" && wr[start + n] > -20) { res = (x.c - fill) / risk; break; }
    }
    if (isNaN(res)) { if (start + n >= k.length) break; const x = k[start + n - 1]; res = (L ? x.c - fill : fill - x.c) / risk; }
    trades.push({ side: L ? "LONG" : "SHORT", r: res - (FEE * fill) / risk, bars: n, t: b.t });
    i = start + n;
  }
  return trades;
}

// ═════════ Estrategias SHORT con filtro de mercado bajista ═════════
// Régimen bajista diario: cierre < SMA200 y SMA50 < SMA200 (alineado sin mirar al futuro).
function dailyBear(k: Candle[], tf: TF, daily: Candle[]): number[] {
  const c = daily.map((x) => x.c), s50 = sma(c, 50), s200 = sma(c, 200);
  const dir = daily.map((_, i) => (c[i] < s200[i] && s50[i] < s200[i] ? -1 : 0));
  if (tf === "1d") return dir;
  return alignHtf(k, tf, daily, dir, "1d");
}
type ShParams = { name: string; kind: "don-trail" | "don-tp" | "rsi2" | "pull"; rr?: number };
const SH_VARIANTS: ShParams[] = [
  { name: "SA SHORT Donchian bajista, stop móvil", kind: "don-trail" },
  { name: "SB SHORT Donchian bajista, TP 1:2", kind: "don-tp", rr: 2 },
  { name: "SC SHORT Donchian bajista, TP 1:1.5", kind: "don-tp", rr: 1.5 },
  { name: "SD SHORT RSI(2) rebote fallido", kind: "rsi2" },
  { name: "SE SHORT rebote a EMA20, TP 1:2", kind: "pull", rr: 2 },
];
function backtestShort(k: Candle[], bear: number[], p: ShParams): Trade[] {
  const c = k.map((x) => x.c), s5 = sma(c, 5), e20 = ema(c, 20), e50 = ema(c, 50), r2 = rsi(c, 2), { atr } = atrAdx(k);
  const trades: Trade[] = [];
  for (let i = 220; i < k.length - 1; i++) {
    if (bear[i] !== -1) continue;
    const b = k[i];
    let ok = false, risk = 2 * atr[i];
    if (p.kind === "don-trail" || p.kind === "don-tp") ok = c[i] < Math.min(...k.slice(i - 20, i).map((x) => x.l));
    else if (p.kind === "rsi2") { ok = r2[i] > 90; risk = 3 * atr[i]; }
    else if (p.kind === "pull") ok = e20[i] < e50[i] && b.h >= e20[i] && b.c < e20[i] && b.c < b.o;
    if (!ok) continue;
    const entry = c[i]; let stop = entry + risk, res = NaN, n = 0;
    const tp = p.rr ? entry - risk * p.rr : NaN;
    for (n = 1; n <= MAX_HOLD && i + n < k.length; n++) {
      const x = k[i + n], m = i + n;
      if (x.h >= stop) { res = (entry - stop) / risk; break; }
      if (!isNaN(tp) && x.l <= tp) { res = p.rr!; break; }
      if (p.kind === "rsi2" && x.c < s5[m]) { res = (entry - x.c) / risk; break; }
      if (p.kind === "don-trail" && m >= 10) stop = Math.min(stop, Math.max(...k.slice(m - 9, m + 1).map((y) => y.h)));
    }
    if (isNaN(res)) { if (i + n >= k.length) break; res = (entry - k[i + n - 1].c) / risk; }
    trades.push({ side: "SHORT", r: res - (FEE * entry) / risk, bars: n, t: b.t });
    i += n;
  }
  return trades;
}

// ═════════ Estrategias de BAJA VOLATILIDAD (1h / 4h) ═════════
type LVParams = { kind: "squeeze" | "nr7" | "lowatr" | "range"; side: "L" | "S" | "LS"; rr: number; sl: number; n?: number; pct?: number; sq?: number };
function stdev(v: number[], p: number) { const m = sma(v, p); return v.map((_, i) => { if (i < p - 1) return NaN; let s = 0; for (let j = i - p + 1; j <= i; j++) s += (v[j] - m[i]) ** 2; return Math.sqrt(s / p); }); }
function backtestLV(k: Candle[], p: LVParams): Trade[] {
  const c = k.map((x) => x.c), e200 = ema(c, 200), mid = sma(c, 20), sd = stdev(c, 20), { atr, adx } = atrAdx(k);
  const up = c.map((_, i) => mid[i] + 2 * sd[i]), lo = c.map((_, i) => mid[i] - 2 * sd[i]);
  const kcU = c.map((_, i) => mid[i] + 1.5 * atr[i]), kcL = c.map((_, i) => mid[i] - 1.5 * atr[i]);
  const sqOn = c.map((_, i) => up[i] < kcU[i] && lo[i] > kcL[i]);
  const trades: Trade[] = []; const wantL = p.side !== "S", wantS = p.side !== "L";
  for (let i = 220; i < k.length - 2; i++) {
    const b = k[i], a = atr[i];
    let L: boolean | null = null, entry = c[i], stop = NaN, startBar = i;
    if (p.kind === "squeeze") {
      const N = p.sq ?? 6; let was = true; for (let j = i - N; j < i; j++) if (!sqOn[j]) { was = false; break; }
      if (was && !sqOn[i]) {
        if (wantL && c[i] > up[i] && c[i] > e200[i]) L = true;
        else if (wantS && c[i] < lo[i] && c[i] < e200[i]) L = false;
      }
    } else if (p.kind === "lowatr") {
      const n = p.n ?? 20, w = atr.slice(i - 100, i).filter((x) => !isNaN(x)).sort((x, y) => x - y);
      const low = w.length > 50 && atr[i - 1] <= w[Math.floor(w.length * (p.pct ?? 0.2))];
      if (low) {
        const hh = Math.max(...k.slice(i - n, i).map((x) => x.h)), ll = Math.min(...k.slice(i - n, i).map((x) => x.l));
        if (wantL && c[i] > hh && c[i] > e200[i]) L = true;
        else if (wantS && c[i] < ll && c[i] < e200[i]) L = false;
      }
    } else if (p.kind === "range") {
      if (adx[i] < 20 && (up[i] - lo[i]) / mid[i] < 0.06) {
        const pv = k[i - 1];
        if (wantL && pv.c < lo[i - 1] && c[i] > lo[i]) L = true;
        else if (wantS && pv.c > up[i - 1] && c[i] < up[i]) L = false;
      }
    } else if (p.kind === "nr7") {
      const r = b.h - b.l, n7 = k.slice(i - 6, i + 1).every((x) => x.h - x.l >= r);
      const nx = k[i + 1];
      if (n7) {
        if (wantL && c[i] > e200[i] && nx.h > b.h) { L = true; entry = Math.max(b.h, nx.o); stop = b.l; startBar = i + 1; }
        else if (wantS && c[i] < e200[i] && nx.l < b.l) { L = false; entry = Math.min(b.l, nx.o); stop = b.h; startBar = i + 1; }
      }
    }
    if (L === null) continue;
    if (isNaN(stop)) stop = L ? entry - p.sl * a : entry + p.sl * a;
    const risk = Math.abs(entry - stop); if (!(risk > 0.2 * a)) continue;
    if (startBar > i) { const nx = k[startBar]; if (L ? nx.l <= stop && nx.c < entry : nx.h >= stop && nx.c > entry) { trades.push({ side: L ? "LONG" : "SHORT", r: -1 - (FEE * entry) / risk, bars: 1, t: b.t }); i = startBar; continue; } }
    const sim = simulate(k, startBar, L, entry, stop, p.rr, false);
    if (!sim) break;
    trades.push({ side: L ? "LONG" : "SHORT", r: sim.r - (FEE * entry) / risk, bars: sim.n, t: b.t });
    i = startBar + sim.n;
  }
  return trades;
}

// ═════════ Señales 4H con TP/SL en % fijo (para apalancamiento alto) ═════════
type PctParams = { kind: "don" | "ema" | "rng" | "sq"; side: "L" | "S"; tp: number; sl: number; n?: number };
function backtestPct(k: Candle[], p: PctParams): Trade[] {
  const c = k.map((x) => x.c), e20 = ema(c, 20), e50 = ema(c, 50), e200 = ema(c, 200), mid = sma(c, 20), sd = stdev(c, 20), { atr, adx } = atrAdx(k);
  const up = c.map((_, i) => mid[i] + 2 * sd[i]), lo = c.map((_, i) => mid[i] - 2 * sd[i]);
  const sqOn = c.map((_, i) => up[i] < mid[i] + 1.5 * atr[i] && lo[i] > mid[i] - 1.5 * atr[i]);
  const L = p.side === "L", trades: Trade[] = [], n = p.n ?? 20;
  for (let i = 220; i < k.length - 1; i++) {
    const b = k[i], pv = k[i - 1];
    let ok = false;
    if (p.kind === "don") ok = L ? c[i] > Math.max(...k.slice(i - n, i).map((x) => x.h)) && c[i] > e200[i] : c[i] < Math.min(...k.slice(i - n, i).map((x) => x.l)) && c[i] < e200[i];
    else if (p.kind === "ema") ok = L ? e20[i] > e50[i] && e50[i] > e200[i] && b.l <= e20[i] && b.c > e20[i] && b.c > b.o : e20[i] < e50[i] && e50[i] < e200[i] && b.h >= e20[i] && b.c < e20[i] && b.c < b.o;
    else if (p.kind === "rng") ok = adx[i] < 20 && (up[i] - lo[i]) / mid[i] < 0.06 && (L ? pv.c < lo[i - 1] && c[i] > lo[i] : pv.c > up[i - 1] && c[i] < up[i]);
    else if (p.kind === "sq") { let was = true; for (let j = i - 6; j < i; j++) if (!sqOn[j]) { was = false; break; } ok = was && !sqOn[i] && (L ? c[i] > up[i] && c[i] > e200[i] : c[i] < lo[i] && c[i] < e200[i]); }
    if (!ok) continue;
    const entry = c[i], sl = L ? entry * (1 - p.sl / 100) : entry * (1 + p.sl / 100), rr = p.tp / p.sl;
    const sim = simulate(k, i, L, entry, sl, rr, false);
    if (!sim) break;
    // costes de futuros con apalancamiento: comisión 0.1% ida y vuelta sobre el nocional, en R
    trades.push({ side: L ? "LONG" : "SHORT", r: sim.r - (FEE * 100) / p.sl, bars: sim.n, t: b.t });
    i += sim.n;
  }
  return trades;
}

// ═════════ Estrategia de FUNDING extremo (datos de derivados, idea tipo InvestRuiz) ═════════
// Funding muy alto = demasiados LONG apalancados pagando → posible caída (SHORT). Muy bajo/negativo = demasiados SHORT → posible subida (LONG).
const FUNDING: Record<string, { t: number; r: number }[]> = {};
async function loadFunding(sym: string) {
  if (FUNDING[sym]) return FUNDING[sym];
  const out: { t: number; r: number }[] = []; let start = Date.UTC(2019, 8, 1);
  while (true) {
    const r = await fetch(`https://fapi.binance.com/fapi/v1/fundingRate?symbol=${sym}&startTime=${start}&limit=1000`);
    if (!r.ok) break;
    const rows: any[] = await r.json(); if (!rows.length) break;
    for (const x of rows) out.push({ t: x.fundingTime, r: +x.fundingRate });
    start = rows.at(-1).fundingTime + 1; if (rows.length < 1000) break;
  }
  return (FUNDING[sym] = out);
}
type FundParams = { name: string; side: "L" | "S" | "LS"; pct: number; trend: boolean; rr: number; sl: number; win?: number };
function backtestFund(k: Candle[], f: { t: number; r: number }[], p: FundParams): Trade[] {
  if (f.length < 300) return [];
  const c = k.map((x) => x.c), e200 = ema(c, 200), { atr } = atrAdx(k), trades: Trade[] = [];
  const W = p.win ?? 270; let j = -1;
  for (let i = 220; i < k.length - 1; i++) {
    const close = k[i].t + 4 * H;
    while (j + 1 < f.length && f[j + 1].t <= close) j++;
    if (j < W) continue;
    if (f[j].t <= k[i].t) continue; // solo actuar en la vela donde se publica un funding nuevo
    const hist = f.slice(j - W, j).map((x) => x.r).sort((a, b) => a - b), now = f[j].r;
    const lo = hist[Math.floor(W * p.pct)], hi = hist[Math.floor(W * (1 - p.pct)) - 1];
    let L: boolean | null = null;
    if (p.side !== "S" && now < lo && (!p.trend || c[i] > e200[i])) L = true;
    else if (p.side !== "L" && now > hi && (!p.trend || c[i] < e200[i])) L = false;
    if (L === null) continue;
    const entry = c[i], risk = p.sl * atr[i];
    const sim = simulate(k, i, L, entry, L ? entry - risk : entry + risk, p.rr, false);
    if (!sim) break;
    trades.push({ side: L ? "LONG" : "SHORT", r: sim.r - (FEE * entry) / risk, bars: sim.n, t: k[i].t });
    i += sim.n;
  }
  return trades;
}

// ═════════ Barrido de liquidez (lógica de los mapas de calor de liquidaciones) ═════════
// Las zonas de liquidez están justo encima de máximos y debajo de mínimos recientes (giros confirmados).
// Señal: la vela perfora esa zona pero CIERRA de vuelta dentro → entrada en contra del barrido.
type LiqParams = { name: string; side: "L" | "S" | "LS"; trend: boolean; rr: number; n?: number; look?: number; target?: boolean };
function backtestLiq(k: Candle[], p: LiqParams): Trade[] {
  const c = k.map((x) => x.c), e200 = ema(c, 200), { atr } = atrAdx(k), trades: Trade[] = [], N = p.n ?? 3, look = p.look ?? 50;
  const isH = (j: number) => [...Array(N)].every((_, d) => k[j].h >= k[j - d - 1].h && k[j].h > k[j + d + 1].h);
  const isL = (j: number) => [...Array(N)].every((_, d) => k[j].l <= k[j - d - 1].l && k[j].l < k[j + d + 1].l);
  for (let i = 220; i < k.length - 1; i++) {
    const b = k[i], a = atr[i];
    // giros confirmados (j + N < i) en la ventana
    let pl = NaN, ph = NaN, nextH = NaN, nextL = NaN;
    for (let j = i - N - 1; j >= i - look; j--) {
      if (isNaN(pl) && isL(j) && k[j].l < Math.min(...k.slice(j + 1, i).map((x) => x.l))) pl = k[j].l;
      if (isNaN(ph) && isH(j) && k[j].h > Math.max(...k.slice(j + 1, i).map((x) => x.h))) ph = k[j].h;
      if (!isNaN(pl) && !isNaN(ph)) break;
    }
    let L: boolean | null = null, sl = NaN;
    if (p.side !== "S" && !isNaN(pl) && b.l < pl && b.c > pl && (!p.trend || c[i] > e200[i])) { L = true; sl = b.l - 0.1 * a; }
    else if (p.side !== "L" && !isNaN(ph) && b.h > ph && b.c < ph && (!p.trend || c[i] < e200[i])) { L = false; sl = b.h + 0.1 * a; }
    if (L === null) continue;
    const entry = c[i], risk = Math.abs(entry - sl);
    if (!(risk > 0.3 * a && risk < 3 * a)) continue;
    let rr = p.rr;
    if (p.target) { const tgt = L ? ph : pl; if (isNaN(tgt)) continue; rr = Math.abs(tgt - entry) / risk; if (rr < 1.5) continue; }
    const sim = simulate(k, i, L, entry, sl, rr, false);
    if (!sim) break;
    trades.push({ side: L ? "LONG" : "SHORT", r: sim.r - (FEE * entry) / risk, bars: sim.n, t: b.t });
    i += sim.n;
  }
  return trades;
}

// ═════════ Estrategias del curso de Fran Ruiz (clases 1-9), reglas tal como las describe ═════════
type FranParams = { kind: "bottom" | "cross" | "mabounce" | "ema725" | "fib" | "div" | "retest" | "volbrk" | "double"; side: "L" | "S"; rsiFib?: boolean };
function backtestFran(k: Candle[], p: FranParams): Trade[] {
  const c = k.map((x) => x.c), s50 = sma(c, 50), s100 = sma(c, 100), s200 = sma(c, 200), e7 = ema(c, 7), e25 = ema(c, 25), r = rsi(c), { atr } = atrAdx(k);
  const L = p.side === "L", N = 3, trades: Trade[] = [];
  const isH = (j: number) => j >= N && j + N < k.length && [...Array(N)].every((_, d) => k[j].h >= k[j - d - 1].h && k[j].h > k[j + d + 1].h);
  const isL = (j: number) => j >= N && j + N < k.length && [...Array(N)].every((_, d) => k[j].l <= k[j - d - 1].l && k[j].l < k[j + d + 1].l);
  const highs: number[] = [], lows: number[] = [];
  const bull = (b: Candle, pv: Candle) => { const body = Math.abs(b.c - b.o), lw = Math.min(b.o, b.c) - b.l, rng = b.h - b.l; return (b.c > b.o && pv.c < pv.o && b.c >= pv.o && b.o <= pv.c) || (rng > 0 && lw >= 2 * body && lw >= 0.6 * rng); };
  const bear = (b: Candle, pv: Candle) => { const body = Math.abs(b.c - b.o), uw = b.h - Math.max(b.o, b.c), rng = b.h - b.l; return (b.c < b.o && pv.c > pv.o && b.c <= pv.o && b.o >= pv.c) || (rng > 0 && uw >= 2 * body && uw >= 0.6 * rng); };
  let pending: { lvl: number; until: number } | null = null;
  for (let i = 220; i < k.length - 1; i++) {
    const j = i - N; if (isH(j)) highs.push(j); if (isL(j)) lows.push(j);
    const b = k[i], pv = k[i - 1], a = atr[i];
    const entry = c[i]; let sl = NaN, tp = NaN;
    if (p.kind === "bottom") {
      // Aviso de posible suelo: RSI diario < 25 (sobreventa extrema) y vela de giro alcista (martillo o envolvente)
      if (L && (r[i] < 25 || r[i - 1] < 25) && bull(b, pv)) sl = b.l - 0.2 * a;
    } else     if (p.kind === "cross") {
      // Clase 2: cruce dorado / de la muerte SMA50-200 con ángulo pronunciado (pendiente de la SMA50)
      const slope = (s50[i] - s50[i - 5]) / a;
      if (L ? s50[i - 1] <= s200[i - 1] && s50[i] > s200[i] && slope > 0.5 : s50[i - 1] >= s200[i - 1] && s50[i] < s200[i] && slope < -0.5) sl = L ? entry - 2 * a : entry + 2 * a;
    } else if (p.kind === "mabounce") {
      // Clases 1 y 2: rebote en SMA 50/100/200 con vela de giro (martillo o envolvente)
      const trendOk = L ? s50[i] > s200[i] && c[i] > s200[i] : s50[i] < s200[i] && c[i] < s200[i];
      const touched = [s50[i], s100[i], s200[i]].find((m) => (L ? b.l <= m + 0.2 * a && b.c > m : b.h >= m - 0.2 * a && b.c < m));
      if (trendOk && touched !== undefined && (L ? bull(b, pv) : bear(b, pv))) sl = L ? b.l - 0.2 * a : b.h + 0.2 * a;
    } else if (p.kind === "ema725") {
      // Clase 2: cruce EMA 7/25 a favor de la SMA200
      if (L ? e7[i - 1] <= e25[i - 1] && e7[i] > e25[i] && c[i] > s200[i] : e7[i - 1] >= e25[i - 1] && e7[i] < e25[i] && c[i] < s200[i]) sl = L ? entry - 1.5 * a : entry + 1.5 * a;
    } else if (p.kind === "fib") {
      // Clase 8: retroceso al Golden Pocket (50-61,8%) del último impulso; SL bajo el 78,6%; TP en la extensión -0,27
      if (highs.length >= 2 && lows.length >= 2) {
        const hI = highs[highs.length - 1], lI = lows[lows.length - 1];
        if (L && lI < hI && k[hI].h > k[highs[highs.length - 2]].h) {
          const H = k[hI].h, Lo = k[lI].l, R = H - Lo, z1 = H - 0.5 * R, z2 = H - 0.618 * R;
          if (b.l <= z1 && b.c >= z2 && b.l > H - 0.786 * R && (p.rsiFib ? r[i] < 40 : b.c > b.o)) { sl = H - 0.786 * R - 0.1 * a; tp = H + 0.27 * R; }
        }
        if (!L && hI < lI && k[lI].l < k[lows[lows.length - 2]].l) {
          const Lo = k[lI].l, H = k[hI].h, R = H - Lo, z1 = Lo + 0.5 * R, z2 = Lo + 0.618 * R;
          if (b.h >= z1 && b.c <= z2 && b.h < Lo + 0.786 * R && (p.rsiFib ? r[i] > 60 : b.c < b.o)) { sl = Lo + 0.786 * R + 0.1 * a; tp = Lo - 0.27 * R; }
        }
      }
    } else if (p.kind === "div") {
      // Clases 5 y 7: divergencia RSI (precio hace nuevo mínimo y el RSI no / precio nuevo máximo y el RSI no)
      if (L && lows.length >= 2 && lows[lows.length - 1] === j) { const a1 = lows[lows.length - 2]; if (k[j].l < k[a1].l && r[j] > r[a1] && r[j] < 40) sl = k[j].l - 0.2 * a; }
      if (!L && highs.length >= 2 && highs[highs.length - 1] === j) { const a1 = highs[highs.length - 2]; if (k[j].h > k[a1].h && r[j] < r[a1] && r[j] > 60) sl = k[j].h + 0.2 * a; }
    } else if (p.kind === "retest") {
      // Clase 4: ruptura del último máximo/mínimo y entrada en el retesteo (pullback) que aguanta el nivel
      const lvlIdx = L ? highs[highs.length - 1] : lows[lows.length - 1];
      let broke = false;
      if (lvlIdx !== undefined && !pending) {
        const lvl = L ? k[lvlIdx].h : k[lvlIdx].l;
        if (L ? pv.c <= lvl && b.c > lvl : pv.c >= lvl && b.c < lvl) { pending = { lvl, until: i + 10 }; broke = true; }
      }
      if (pending && i > pending.until) pending = null;
      if (pending && !broke && (L ? b.l <= pending.lvl + 0.2 * a && b.c > pending.lvl && b.c > b.o : b.h >= pending.lvl - 0.2 * a && b.c < pending.lvl && b.c < b.o)) {
        sl = L ? Math.min(b.l, pending.lvl) - 0.2 * a : Math.max(b.h, pending.lvl) + 0.2 * a;
        pending = null;
      }
    } else if (p.kind === "volbrk") {
      // Clase 5: ruptura del rango de 20 velas confirmada con volumen mayor a 1,5 veces la media
      const hh = Math.max(...k.slice(i - 20, i).map((x) => x.h)), ll = Math.min(...k.slice(i - 20, i).map((x) => x.l));
      const va = k.slice(i - 20, i).reduce((s, x) => s + x.v, 0) / 20;
      if (va > 0 && b.v > 1.5 * va && (L ? c[i] > hh : c[i] < ll)) sl = L ? entry - 1.5 * a : entry + 1.5 * a;
    } else if (p.kind === "double") {
      // Clase 3: doble suelo / doble techo con ruptura de la línea de cuello; objetivo = altura del patrón
      if (L && lows.length >= 2) {
        const a1 = lows[lows.length - 2], a2 = lows[lows.length - 1], neck = Math.max(...k.slice(a1, a2 + 1).map((x) => x.h)), bot = Math.min(k[a1].l, k[a2].l);
        if (a2 - a1 >= 5 && Math.abs(k[a1].l - k[a2].l) < 0.5 * a && pv.c <= neck && b.c > neck) { sl = bot - 0.2 * a; tp = neck + (neck - bot); }
      }
      if (!L && highs.length >= 2) {
        const a1 = highs[highs.length - 2], a2 = highs[highs.length - 1], neck = Math.min(...k.slice(a1, a2 + 1).map((x) => x.l)), top = Math.max(k[a1].h, k[a2].h);
        if (a2 - a1 >= 5 && Math.abs(k[a1].h - k[a2].h) < 0.5 * a && pv.c >= neck && b.c < neck) { sl = top + 0.2 * a; tp = neck - (top - neck); }
      }
    }
    if (isNaN(sl)) continue;
    const risk = Math.abs(entry - sl);
    if (!(risk > 0.3 * a && risk < 5 * a)) continue;
    const rr = isNaN(tp) ? 2 : Math.abs(tp - entry) / risk;
    if (!(rr >= 0.8)) continue;
    const sim = simulate(k, i, L, entry, sl, rr, false);
    if (!sim) break;
    trades.push({ side: L ? "LONG" : "SHORT", r: sim.r - (FEE * entry) / risk, bars: sim.n, t: b.t });
    i += sim.n;
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
const DATA: Record<string, Record<TF, Candle[]>> = {};
const all: Record<string, Trade[]> = {}; // clave: variante|sym|tf
const cutoff: Record<string, number> = {}; // 70% inicial = "entrenamiento", 30% final = "prueba"
const ranges: string[] = [];
const RUNSYMS = process.env.ONLY ? process.env.ONLY.split(",") : null;
for (const [sym, crypto] of (RUNSYMS ? RUNSYMS.map((s) => [s, s.endsWith("USDT")] as const) : [...CRYPTO.map((s) => [s, true] as const), ...STOCKS.map((s) => [s, false] as const)])) {
  if (RUNSYMS && !RUNSYMS.includes(sym)) continue;
  let data: Record<TF, Candle[]>;
  try { data = await load(sym, crypto); DATA[sym] = data; } catch (e) { console.error(sym, "error de datos:", (e as Error).message); continue; }
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
    for (const p of LW_VARIANTS) all[`${p.name}|${sym}|${tf}`] = backtestLW(k, p);
    const bear = dailyBear(k, tf, data["1d"]);
    for (const p of SH_VARIANTS) all[`${p.name}|${sym}|${tf}`] = backtestShort(k, bear, p);
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
const NAMES = [...VARIANTS.map((p) => p.name), ...PA_VARIANTS.map((p) => p.name), ...EMA_VARIANTS.map((p) => p.name), ...AR_VARIANTS.map((p) => p.name), ...EXIT_VARIANTS.map((p) => p.name), ...LW_VARIANTS.map((p) => p.name), ...SH_VARIANTS.map((p) => p.name)];
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


// ═════════ SHORT "claros": solo en tendencia bajista fuerte ═════════
// Filtro: precio < EMA200, EMA50 < EMA200, EMA200 bajando en 20 velas y ADX > adx.
// "brk": cierra bajo el mínimo de n velas · "rej": toca la EMA20 y cierra por debajo con vela bajista. SL sl·ATR, TP rr·riesgo.
type CSParams = { kind: "brk" | "rej"; n: number; sl: number; rr: number; adx: number };
function backtestShortClear(k: Candle[], p: CSParams, gate?: number[]): Trade[] {
  const c = k.map((x) => x.c), e20 = ema(c, 20), e50 = ema(c, 50), e200 = ema(c, 200), { atr, adx } = atrAdx(k);
  const trades: Trade[] = [];
  for (let i = 230; i < k.length - 1; i++) {
    if (gate && gate[i] !== -1) continue;
    const b = k[i];
    if (!(c[i] < e200[i] && e50[i] < e200[i] && e200[i] < e200[i - 20] && adx[i] > p.adx)) continue;
    const ok = p.kind === "brk" ? c[i] < Math.min(...k.slice(i - p.n, i).map((x) => x.l)) : b.h >= e20[i] && b.c < e20[i] && b.c < b.o && e20[i] < e50[i];
    if (!ok) continue;
    const risk = p.sl * atr[i], entry = c[i], stop = entry + risk, tp = entry - risk * p.rr;
    let res = NaN, n = 0;
    for (n = 1; n <= MAX_HOLD && i + n < k.length; n++) {
      const x = k[i + n];
      if (x.h >= stop) { res = -1; break; }
      if (x.l <= tp) { res = p.rr; break; }
    }
    if (isNaN(res)) { if (i + n >= k.length) break; res = (entry - k[i + n - 1].c) / risk; }
    trades.push({ side: "SHORT", r: res - (FEE * entry) / risk, bars: n, t: b.t });
    i += n;
  }
  return trades;
}
// ═════════ PRUEBA DE ESTRÉS (paso 6 del kit "Tu estrategia con IA en 7 prompts") ═════════
// Se ejecuta con: STRESS=1 bun backtest.ts
if (process.env.STRESS) {
  type Spec = { name: string; tfs: TF[]; syms: string[]; params: Record<string, number>; run: (k: Candle[], tf: TF, sym: string, P: Record<string, number>) => Trade[] };
  const ALL = [...CRYPTO, ...STOCKS];
  const dailyBull = (k: Candle[], tf: TF, d: Candle[]) => { const c = d.map((x) => x.c), s = sma(c, 200); return alignHtf(k, tf, d, d.map((_, i) => (c[i] > s[i] ? 1 : 0)), "1d"); };
  const LV: [string, LVParams][] = [
    ["Squeeze LONG", { kind: "squeeze", side: "L", rr: 2, sl: 1.5, sq: 6 }], ["Squeeze SHORT", { kind: "squeeze", side: "S", rr: 2, sl: 1.5, sq: 6 }],
    ["NR7 LONG", { kind: "nr7", side: "L", rr: 2, sl: 1 }], ["NR7 SHORT", { kind: "nr7", side: "S", rr: 2, sl: 1 }],
    ["ATR bajo LONG", { kind: "lowatr", side: "L", rr: 2, sl: 1.5, n: 20, pct: 0.2 }], ["ATR bajo SHORT", { kind: "lowatr", side: "S", rr: 2, sl: 1.5, n: 20, pct: 0.2 }],
    ["Rango LONG", { kind: "range", side: "L", rr: 1.5, sl: 1.5 }], ["Rango SHORT", { kind: "range", side: "S", rr: 1.5, sl: 1.5 }],
  ];
  const numKeys = (P: LVParams) => Object.fromEntries(Object.entries(P).filter(([kk, v]) => typeof v === "number" && kk !== "rr")) as Record<string, number>;
  if (process.env.FUND) for (const s of process.env.ONLY!.split(",")) await loadFunding(s);
  const FV: FundParams[] = [
    { name: "contrario LONG+SHORT 5%", side: "LS", pct: 0.05, trend: false, rr: 2, sl: 2 },
    { name: "contrario LONG 5%", side: "L", pct: 0.05, trend: false, rr: 2, sl: 2 },
    { name: "contrario SHORT 5%", side: "S", pct: 0.05, trend: false, rr: 2, sl: 2 },
    { name: "contrario a favor de tendencia 10%", side: "LS", pct: 0.1, trend: true, rr: 2, sl: 2 },
    { name: "contrario LONG en tendencia 10%", side: "L", pct: 0.1, trend: true, rr: 2, sl: 2 },
    { name: "contrario 5% TP 1:1.5", side: "LS", pct: 0.05, trend: false, rr: 1.5, sl: 2 },
  ];
  const LQ: LiqParams[] = [
    { name: "barrido LONG+SHORT 1:2", side: "LS", trend: false, rr: 2 },
    { name: "barrido LONG 1:2", side: "L", trend: false, rr: 2 },
    { name: "barrido SHORT 1:2", side: "S", trend: false, rr: 2 },
    { name: "barrido a favor de tendencia 1:2", side: "LS", trend: true, rr: 2 },
    { name: "barrido hacia la liquidez opuesta", side: "LS", trend: false, rr: 2, target: true },
    { name: "barrido LONG en tendencia 1:3", side: "L", trend: true, rr: 3 },
  ];
  const FRAN: [string, FranParams][] = [
    ["Posible suelo (RSI<25 + vela de giro)", { kind: "bottom", side: "L" }],
    ["Cruce dorado SMA50/200", { kind: "cross", side: "L" }], ["Cruce de la muerte SMA50/200", { kind: "cross", side: "S" }],
    ["Rebote en SMA 50/100/200 LONG", { kind: "mabounce", side: "L" }], ["Rechazo en SMA 50/100/200 SHORT", { kind: "mabounce", side: "S" }],
    ["Cruce EMA 7/25 LONG", { kind: "ema725", side: "L" }], ["Cruce EMA 7/25 SHORT", { kind: "ema725", side: "S" }],
    ["Fibonacci Golden Pocket LONG", { kind: "fib", side: "L" }], ["Fibonacci Golden Pocket SHORT", { kind: "fib", side: "S" }],
    ["Fibonacci + RSI LONG", { kind: "fib", side: "L", rsiFib: true }], ["Fibonacci + RSI SHORT", { kind: "fib", side: "S", rsiFib: true }],
    ["Divergencia RSI LONG", { kind: "div", side: "L" }], ["Divergencia RSI SHORT", { kind: "div", side: "S" }],
    ["Ruptura + retesteo LONG", { kind: "retest", side: "L" }], ["Ruptura + retesteo SHORT", { kind: "retest", side: "S" }],
    ["Ruptura con volumen LONG", { kind: "volbrk", side: "L" }], ["Ruptura con volumen SHORT", { kind: "volbrk", side: "S" }],
    ["Doble suelo", { kind: "double", side: "L" }], ["Doble techo", { kind: "double", side: "S" }],
  ];
  const specs: Spec[] = [
    ...(process.env.FRAN ? FRAN.filter(([nm]) => !process.env.FRANONLY || nm.startsWith(process.env.FRANONLY)).flatMap(([nm, P]) => (["4h", "1d"] as TF[]).map((tf): Spec => ({ name: `FRAN ${nm} ${tf}`, tfs: [tf], syms: ALL, params: {}, run: (k: Candle[]) => backtestFran(k, P) }))) : []),
    ...(process.env.LIQ ? LQ.flatMap((P) => (["4h", "1d"] as TF[]).map((tf): Spec => ({ name: `LIQ ${P.name} ${tf}`, tfs: [tf], syms: process.env.ONLY!.split(","), params: { n: 3, look: 50 }, run: (k: Candle[], _t: TF, _s: string, Q: Record<string, number>) => backtestLiq(k, { ...P, ...Q }) }))) : []),
    ...(process.env.FUND ? FV.map((P): Spec => ({ name: `FUND ${P.name} 4h`, tfs: ["4h"], syms: process.env.ONLY!.split(","), params: { sl: P.sl, pct: P.pct }, run: (k: Candle[], _t: TF, s: string, Q: Record<string, number>) => backtestFund(k, FUNDING[s] ?? [], { ...P, ...Q }) })) : []),
    ...(process.env.PCT ? (["don", "ema", "rng", "sq"] as const).flatMap((kind) => (["L", "S"] as const).flatMap((side) => [[2, 1], [3, 1.5], [4, 2]].map(([tp, sl]): Spec => ({ name: `PCT ${kind} ${side === "L" ? "LONG" : "SHORT"} TP${tp}% SL${sl}%`, tfs: ["4h"], syms: ["BTCUSDT", "HYPEUSDT", "SOLUSDT"], params: kind === "don" ? { n: 20 } : {}, run: (k: Candle[], _t: TF, _s: string, P: Record<string, number>) => backtestPct(k, { kind, side, tp, sl, n: P.n }) })))) : []),
    ...(process.env.SHORTS ? (["brk", "rej"] as const).flatMap((kind) => [1.5, 2].flatMap((rr) => (["4h", "1d"] as TF[]).flatMap((tf) => (["cripto", "acciones", "todo"] as const).map((grp): Spec => ({
      name: `SHORT CLARO ${kind === "brk" ? "ruptura de mínimos" : "rechazo en EMA20"} ${tf} TP ${rr}R ${grp}`, tfs: [tf], syms: grp === "cripto" ? CRYPTO : grp === "acciones" ? STOCKS : ALL,
      params: kind === "brk" ? { n: 20, sl: 2, adx: 25 } : { sl: 2, adx: 25 },
      run: (k: Candle[], _t: TF, _s: string, P: Record<string, number>) => backtestShortClear(k, { kind, n: P.n ?? 20, sl: P.sl, rr, adx: P.adx }),
    }))))) : []),
    ...(process.env.ONLY ? [
      { name: "ACTIVO Donchian 1d TP 3R", tfs: ["1d"] as TF[], syms: process.env.ONLY.split(","), params: { n: 20, sl: 2 }, run: (k: Candle[], _t: TF, _s: string, P: Record<string, number>) => backtestExit(k, { name: "", kind: "donchian", shorts: false, n: P.n, sl: P.sl, trail: 9999, tp: 3 }) },
      { name: "ACTIVO EMA retroceso 1d", tfs: ["1d"] as TF[], syms: process.env.ONLY.split(","), params: { sl: 2 }, run: (k: Candle[], tf: TF, s: string, P: Record<string, number>) => backtestEMA(k, dailyTrendEMA(k, tf, DATA[s]["1d"]), { name: "", entry: "pullback", partial: false, slAtr: P.sl }).filter((t) => t.side === "LONG") },
      { name: "ACTIVO RSI(2) 1d TP 1.5R", tfs: ["1d"] as TF[], syms: process.env.ONLY.split(",").filter((s) => !s.endsWith("USDT")), params: { th: 10, sl: 1.5 }, run: (k: Candle[], _t: TF, _s: string, P: Record<string, number>) => backtestExit(k, { name: "", kind: "rsi2", shorts: false, th: P.th, sl: P.sl, ex: 99999, tp: 1.5 }) },
      { name: "ACTIVO Rango LONG 4h", tfs: ["4h"] as TF[], syms: process.env.ONLY.split(","), params: { sl: 1.5 }, run: (k: Candle[], _t: TF, _s: string, P: Record<string, number>) => backtestLV(k, { kind: "range", side: "L", rr: 1.5, sl: P.sl }) },
    ] : []),
    ...LV.flatMap(([nm, P]) => (["1h", "4h"] as TF[]).map((tf): Spec => ({ name: `BAJA VOL ${nm} ${tf}`, tfs: [tf], syms: ALL, params: numKeys(P), run: (k, _t, _s, Q) => backtestLV(k, { ...P, ...Q }) }))),
    ...[1.5, 2, 3].map((tp): Spec => ({ name: `Donchian LONG 1d TP fijo ${tp}R`, tfs: ["1d"], syms: ALL, params: { n: 20, sl: 2 }, run: (k, _t, _s, P) => backtestExit(k, { name: "", kind: "donchian", shorts: false, n: P.n, sl: P.sl, trail: 9999, tp }) })),
    ...[1, 1.5, 2].map((tp): Spec => ({ name: `RSI(2) LONG 1d TP fijo ${tp}R`, tfs: ["1d"], syms: STOCKS, params: { th: 10, sl: 1.5 }, run: (k, _t, _s, P) => backtestExit(k, { name: "", kind: "rsi2", shorts: false, th: P.th, sl: P.sl, ex: 99999, tp }) })),
    ...(["1h", "4h"] as TF[]).map((tf): Spec => ({
      name: `Donchian LONG ${tf} + diario alcista`, tfs: [tf], syms: ALL, params: { n: 20, trail: 10, sl: 2 },
      run: (k, t, s, P) => backtestExit(k, { name: "", kind: "donchian", shorts: false, n: P.n, trail: P.trail, sl: P.sl, gate: dailyBull(k, t, DATA[s]["1d"]) }),
    })),
    ...(["1h", "4h", "1d"] as TF[]).map((tf): Spec => ({
      name: `Donchian LONG ${tf}`, tfs: [tf], syms: ALL, params: { n: 20, trail: 10, sl: 2 },
      run: (k, _t, _s, P) => backtestExit(k, { name: "", kind: "donchian", shorts: false, n: P.n, trail: P.trail, sl: P.sl }),
    })),
    { name: "RSI(2) LONG 1d acciones", tfs: ["1d"], syms: STOCKS, params: { th: 10, ex: 5, sl: 3 },
      run: (k, _t, _s, P) => backtestExit(k, { name: "", kind: "rsi2", shorts: false, th: P.th, ex: P.ex, sl: P.sl }) },
    { name: "EMA retroceso LONG 1d", tfs: ["1d"], syms: ALL, params: { sl: 2 },
      run: (k, tf, s, P) => backtestEMA(k, dailyTrendEMA(k, tf, DATA[s]["1d"]), { name: "", entry: "pullback", partial: false, slAtr: P.sl }).filter((t) => t.side === "LONG") },
  ];
  const runSpec = (sp: Spec, P: Record<string, number>, part?: "is" | "oos") => sp.syms.flatMap((s) => sp.tfs.flatMap((tf) => {
    const k = DATA[s]?.[tf]; if (!k || k.length < 300) return [];
    const tr = sp.run(k, tf, s, P), cut = k[Math.floor(k.length * 0.7)].t;
    return part ? tr.filter((t) => (part === "oos" ? t.t >= cut : t.t < cut)) : tr;
  }));
  const fmtS = (s: ReturnType<typeof stats>) => `${s.n} ops, PF ${s.pf.toFixed(2)}, neto ${s.total.toFixed(1)}R, caída ${s.dd.toFixed(1)}R`;
  const rep: string[] = ["", "════════ PRUEBA DE ESTRÉS ════════"];
  for (const sp of (process.env.FRAN ? specs.filter((s) => s.name.startsWith("FRAN")) : process.env.LIQ ? specs.filter((s) => s.name.startsWith("LIQ")) : process.env.FUND ? specs.filter((s) => s.name.startsWith("FUND")) : process.env.PCT ? specs.filter((s) => s.name.startsWith("PCT")) : process.env.SHORTS ? specs.filter((s) => s.name.startsWith("SHORT CLARO")) : process.env.ONLY ? specs.filter((s) => s.name.startsWith("ACTIVO")) : specs)) {
    const base = runSpec(sp, sp.params), b = stats(base);
    const fails = (s: ReturnType<typeof stats>) => s.pf < 1 || s.dd > 2 * b.dd;
    rep.push("", `■ ${sp.name} — base: ${fmtS(b)}`);
    const res: [string, string, boolean][] = [];
    // 1. Fuera de muestra
    const o = stats(runSpec(sp, sp.params, "oos"));
    res.push(["Fuera de muestra (30% final)", o.n < 30 ? `${fmtS(o)} (menos de 30: no cuenta)` : fmtS(o), o.n >= 30 && o.pf >= 1]);
    // 2. Sensibilidad ±10% ±20% de cada número
    for (const [key, v] of Object.entries(sp.params)) {
      const vals = [0.8, 0.9, 1.1, 1.2].map((m) => { let x = v * m; if (key !== "sl" && key !== "pct" && Number.isInteger(v)) { x = Math.round(x); if (x === v) x = m < 1 ? v - 1 : v + 1; } return x; });
      const ss = vals.map((x) => stats(runSpec(sp, { ...sp.params, [key]: x })));
      const keep = ss.reduce((a, s) => a + s.total, 0) / ss.length / b.total;
      const ok = ss.every((s) => !fails(s)) && keep >= 0.7;
      res.push([`Sensibilidad ${key}=${v} → ${vals.map((x) => +x.toFixed(2)).join("/")}`, `PF ${ss.map((s) => s.pf.toFixed(2)).join(" / ")} · conserva ${(keep * 100).toFixed(0)}% del beneficio`, ok]);
    }
    // 3. Costes dobles
    FEE = 0.002; const d = stats(runSpec(sp, sp.params)); FEE = 0.001;
    res.push(["Costes dobles (0.2%)", fmtS(d), !fails(d)]);
    // 4. Sin el 5% de las mejores
    const sorted = [...base].sort((a, z) => z.r - a.r), cutN = Math.ceil(base.length * 0.05);
    const rest = sorted.slice(cutN).reduce((a, t) => a + t.r, 0);
    res.push([`Sin el 5% mejores (${cutN} ops)`, `neto ${rest.toFixed(1)}R`, rest > 0]);
    // 5. Peor racha: 1.000 historias al azar, riesgo 1%, ruina = perder la mitad
    let ruin = 0; const dds: number[] = []; const R = base.map((t) => t.r);
    for (let s = 0; s < 1000; s++) {
      let eq = 1, pk = 1, mdd = 0, dead = false;
      for (let j = 0; j < R.length; j++) { eq *= 1 + 0.01 * R[Math.floor(Math.random() * R.length)]; pk = Math.max(pk, eq); mdd = Math.max(mdd, 1 - eq / pk); if (eq <= 0.5) dead = true; }
      if (dead) ruin++; dds.push(mdd);
    }
    dds.sort((a, z) => a - z);
    res.push(["Peor racha (1.000 simulaciones, 1%)", `ruina ${(ruin / 10).toFixed(1)}% · caída del peor 5%: ${(dds[949] * 100).toFixed(1)}%`, ruin / 1000 <= 0.05]);
    for (const [t, r, ok] of res) rep.push(`  ${ok ? "✅ PASA   " : "❌ NO PASA"}  ${t}: ${r}`);
    const nFail = res.filter((x) => !x[2]).length;
    rep.push(`  ⇒ VEREDICTO: ${nFail === 0 ? "PASAR A DEMO" : nFail <= 1 ? "VOLVER AL PASO 2 (revisar la prueba que falla)" : "DESCARTAR"}`);
  }
  const txt = rep.join("\n");
  writeFileSync(process.env.SHORTS ? "prueba_shorts.txt" : "prueba_estres.txt", txt);
  console.log(txt);
}

// ═════════ FRECUENCIA DE SEÑALES (estrategias en vivo, último año) ═════════
// FREQ=1 bun backtest.ts   (con ONLY=... para probar otros activos)
if (process.env.FREQ) {
  const since = Date.now() - 365 * 86400_000;
  const live: [string, TF, (k: Candle[], s: string, isStock: boolean) => Trade[]][] = [
    ["Ruptura máximos 1D", "1d", (k) => backtestExit(k, { name: "", kind: "donchian", shorts: false, sl: 2, trail: 9999, tp: 3 })],
    ["RSI(2) 1D (acciones)", "1d", (k, _s, st) => (st ? backtestExit(k, { name: "", kind: "rsi2", shorts: false, sl: 1.5, ex: 99999, tp: 1.5 }) : [])],
    ["EMA retroceso 1D", "1d", (k, s) => backtestEMA(k, dailyTrendEMA(k, "1d", DATA[s]["1d"]), { name: "", entry: "pullback", partial: false, slAtr: 2 }).filter((t) => t.side === "LONG")],
    ["Ruptura con volumen 1D", "1d", (k) => backtestFran(k, { kind: "volbrk", side: "L" })],
    ["Rebote en rango 4H", "4h", (k) => backtestLV(k, { kind: "range", side: "L", rr: 1.5, sl: 1.5 })],
  ];
  const ALLTR: Record<string, Trade[]> = {}, BYASSET: Record<string, Trade[]> = {};
  const rows: string[] = [], perAsset: Record<string, number> = {}; let total = 0, totR = 0, wins = 0;
  for (const [nm, tf, fn] of live) {
    let n = 0, R = 0, w = 0;
    for (const s of Object.keys(DATA)) {
      const k = DATA[s][tf]; if (!k || k.length < 300) continue;
      const all = fn(k, s, !s.endsWith("USDT"));
      (ALLTR[nm] ??= []).push(...all); (BYASSET[s] ??= []).push(...all);
      const tr = all.filter((t) => t.t >= since);
      n += tr.length; R += tr.reduce((a, t) => a + t.r, 0); w += tr.filter((t) => t.r > 0).length; perAsset[s] = (perAsset[s] ?? 0) + tr.length;
    }
    total += n; totR += R; wins += w;
    rows.push(`${nm.padEnd(26)} ${String(n).padStart(4)} señales · acierto ${n ? ((w / n) * 100).toFixed(0) : 0}% · ${R >= 0 ? "+" : ""}${R.toFixed(1)}R`);
  }
  console.log("\n═══ SEÑALES DEL ÚLTIMO AÑO ═══");
  console.log(rows.join("\n"));
  console.log(`TOTAL: ${total} señales (${(total / 365).toFixed(2)} al día · 1 cada ${(365 / Math.max(total, 1)).toFixed(1)} días) · acierto ${total ? ((wins / total) * 100).toFixed(0) : 0}% · ${totR >= 0 ? "+" : ""}${totR.toFixed(1)}R`);
  console.log("\n═══ HISTORIAL COMPLETO (todas las estrategias en vivo) ═══");
  for (const [nm, tr] of Object.entries(ALLTR)) console.log(row(nm, stats(tr)));
  console.log("\n═══ POR ACTIVO (historial completo) ═══");
  for (const [s, tr] of Object.entries(BYASSET).sort((a, b) => stats(b[1]).pf - stats(a[1]).pf)) console.log(row(s, stats(tr)));
  console.log("Por activo: " + Object.entries(perAsset).sort((a, b) => b[1] - a[1]).map(([s, n]) => `${s} ${n}`).join(" · "));
}
