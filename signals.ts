// Bot de señales técnicas -> Telegram (@Tanatabot)
// Uso:  bun signals.ts --once   (una pasada: la usa GitHub Actions cada hora)
//       bun signals.ts --summary (resumen de resultados a Telegram; se envía solo cada domingo 19:00)
//       bun signals.ts --report (estado del mercado a Telegram) · --dry (prueba local) · --replay (verificación) · --sample (ejemplos)
//
// Estrategias elegidas por backtest con validación (70% historial / 30% datos no vistos):
//   Donchian 20/10 solo LONG (todas), RSI(2) Connors (acciones 1D), EMA 30/150/200 retroceso solo LONG (1D).
// Sigue las posiciones abiertas: avisa de mover el stop y de cerrar. NO es asesoría financiera.

import { readFileSync, writeFileSync, existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";

// ───────────── Configuración ─────────────
const CRYPTO = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "HYPEUSDT", "BNBUSDT", "DOGEUSDT", "XRPUSDT", "SUIUSDT"];
// criptos que se leen de Hyperliquid (Binance tiene poco historial de HYPE)
const HYPERLIQUID: Record<string, string> = { HYPEUSDT: "HYPE" };
const STOCKS = ["AAPL", "TSLA", "NVDA", "MSFT", "AMZN", "SPY", "QQQ", "INTC", "AMD"];
const TIMEFRAMES = ["4h", "1d"] as const; // 1D: 3 estrategias validadas · 4H: rebote en rango (baja volatilidad)
const CHECK_EVERY_MIN = 15;
const MIN_FILTERS = 3; // de 4 filtros (ADX, RSI, MACD, volumen)
const SL_ATR = 1.5;    // stop loss = 1.5 × ATR
const TP_R = 2;        // riesgo:beneficio 1:2 (take profit = 2 × distancia al stop)
const LEVERAGES = [5, 10]; // apalancamientos que se muestran en cada señal

type TF = (typeof TIMEFRAMES)[number];
type Candle = { t: number; o: number; h: number; l: number; c: number; v: number };

const TG_DIR = process.env.TELEGRAM_STATE_DIR ?? join(homedir(), ".claude", "channels", "telegram");
const STATE_FILE = join(import.meta.dir, "signals_state.json");

// En la nube (GitHub Actions) el token y los chats vienen de secretos: TELEGRAM_BOT_TOKEN y TELEGRAM_CHAT_IDS.
// En tu PC se leen de la configuración del canal de Telegram.
function loadToken(): string {
  if (process.env.TELEGRAM_BOT_TOKEN) return process.env.TELEGRAM_BOT_TOKEN.trim();
  const env = readFileSync(join(TG_DIR, ".env"), "utf8");
  const m = env.match(/^TELEGRAM_BOT_TOKEN=(.+)$/m);
  if (!m) throw new Error("No hay TELEGRAM_BOT_TOKEN en " + TG_DIR);
  return m[1].trim();
}
function loadChatIds(): string[] {
  if (process.env.TELEGRAM_CHAT_IDS) return process.env.TELEGRAM_CHAT_IDS.split(",").map((s) => s.trim()).filter(Boolean);
  const a = JSON.parse(readFileSync(join(TG_DIR, "access.json"), "utf8"));
  return a.allowFrom ?? [];
}
const TOKEN = loadToken();
const CHATS = loadChatIds();

async function sendTelegram(text: string) {
  for (const chat_id of CHATS) {
    for (let attempt = 1; attempt <= 4; attempt++) {
      try {
        const r = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ chat_id, text, parse_mode: "HTML", disable_web_page_preview: true }),
        });
        if (r.ok) break;
        console.error("Telegram error:", r.status, await r.text());
        if (r.status < 500 && r.status !== 429) break;
      } catch (e) {
        console.error(`Telegram fallo de red (intento ${attempt}):`, (e as Error).message);
      }
      await Bun.sleep(attempt * 3000);
    }
  }
}

// ───────────── Datos ─────────────
const BINANCE_HOSTS = ["https://api.binance.com", "https://data-api.binance.vision"];
async function fetchBinance(sym: string, tf: TF): Promise<Candle[]> {
  let last: unknown;
  for (const host of BINANCE_HOSTS) {
    try {
      const r = await fetch(`${host}/api/v3/klines?symbol=${sym}&interval=${tf}&limit=500`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const rows: any[] = await r.json();
      const now = Date.now();
      return rows
        .filter((k) => k[6] < now) // solo velas cerradas
        .map((k) => ({ t: k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] }));
    } catch (e) { last = e; }
  }
  throw last;
}

async function fetchHyperliquid(coin: string, tf: TF): Promise<Candle[]> {
  const now = Date.now();
  const days = tf === "1h" ? 40 : tf === "4h" ? 160 : 1000;
  const r = await fetch("https://api.hyperliquid.xyz/info", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "candleSnapshot", req: { coin, interval: tf, startTime: now - days * 86400_000, endTime: now } }),
  });
  if (!r.ok) throw new Error(`Hyperliquid HTTP ${r.status}`);
  const rows: any[] = await r.json();
  return rows.filter((x) => x.T < now).map((x) => ({ t: x.t, o: +x.o, h: +x.h, l: +x.l, c: +x.c, v: +x.v }));
}
const fetchCrypto = (sym: string, tf: TF) => (HYPERLIQUID[sym] ? fetchHyperliquid(HYPERLIQUID[sym], tf) : fetchBinance(sym, tf));

async function yahoo(sym: string, interval: string, range: string): Promise<Candle[]> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${sym}?interval=${interval}&range=${range}`;
  const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!r.ok) throw new Error(`Yahoo HTTP ${r.status}`);
  const j: any = await r.json();
  const res = j.chart?.result?.[0];
  if (!res) throw new Error("Yahoo sin datos");
  const q = res.indicators.quote[0];
  const out: Candle[] = [];
  res.timestamp.forEach((ts: number, i: number) => {
    if (q.close[i] == null || q.open[i] == null) return;
    out.push({ t: ts * 1000, o: q.open[i], h: q.high[i], l: q.low[i], c: q.close[i], v: q.volume[i] ?? 0 });
  });
  return out;
}

async function fetchStock(sym: string, tf: TF): Promise<Candle[]> {
  const now = Date.now();
  const H = 3600_000;
  if (tf === "1d") {
    const d = await yahoo(sym, "1d", "2y");
    // la vela de hoy está abierta hasta ~16:00 NY; se descarta si es de las últimas 20 h
    return d.filter((c) => c.t + 20 * H < now);
  }
  const h1 = (await yahoo(sym, "60m", "1y")).filter((c) => c.t + H <= now);
  if (tf === "1h") return h1;
  // 4h: agrupar las velas de cada día en bloques de 4 (mañana / tarde)
  const byDay = new Map<string, Candle[]>();
  for (const c of h1) {
    const k = new Date(c.t - 5 * H).toISOString().slice(0, 10);
    (byDay.get(k) ?? byDay.set(k, []).get(k)!).push(c);
  }
  const out: Candle[] = [];
  for (const bars of byDay.values()) {
    for (let i = 0; i < bars.length; i += 4) {
      const g = bars.slice(i, i + 4);
      out.push({
        t: g[0].t, o: g[0].o, c: g[g.length - 1].c,
        h: Math.max(...g.map((x) => x.h)), l: Math.min(...g.map((x) => x.l)),
        v: g.reduce((s, x) => s + x.v, 0),
      });
      (out[out.length - 1] as any)._n = g.length;
      (out[out.length - 1] as any)._end = g[g.length - 1].t + H;
    }
  }
  const lastG: any = out[out.length - 1];
  if (lastG && lastG._n < 4 && now - lastG._end < 2 * H) out.pop(); // bloque aún abierto
  return out;
}

// ───────────── Indicadores ─────────────
function ema(v: number[], p: number): number[] {
  const out = new Array(v.length).fill(NaN);
  if (v.length < p) return out;
  let s = v.slice(0, p).reduce((a, b) => a + b, 0) / p;
  out[p - 1] = s;
  const k = 2 / (p + 1);
  for (let i = p; i < v.length; i++) out[i] = s = v[i] * k + s * (1 - k);
  return out;
}
function wilder(v: number[], p: number): number[] {
  const out = new Array(v.length).fill(NaN);
  if (v.length <= p) return out;
  let s = v.slice(1, p + 1).reduce((a, b) => a + b, 0) / p;
  out[p] = s;
  for (let i = p + 1; i < v.length; i++) out[i] = s = (s * (p - 1) + v[i]) / p;
  return out;
}
function rsi(c: number[], p = 14): number[] {
  const g = c.map((x, i) => (i ? Math.max(x - c[i - 1], 0) : 0));
  const l = c.map((x, i) => (i ? Math.max(c[i - 1] - x, 0) : 0));
  const ag = wilder(g, p), al = wilder(l, p);
  return ag.map((x, i) => (al[i] === 0 ? 100 : 100 - 100 / (1 + x / al[i])));
}
function macd(c: number[]) {
  const e12 = ema(c, 12), e26 = ema(c, 26);
  const line = c.map((_, i) => e12[i] - e26[i]);
  const start = line.findIndex((x) => !isNaN(x));
  const sigPart = ema(line.slice(start), 9);
  const signal = line.map((_, i) => (i < start ? NaN : sigPart[i - start]));
  return { line, signal, hist: line.map((x, i) => x - signal[i]) };
}
function atrAdx(k: Candle[], p = 14) {
  const tr = k.map((x, i) => (i ? Math.max(x.h - x.l, Math.abs(x.h - k[i - 1].c), Math.abs(x.l - k[i - 1].c)) : x.h - x.l));
  const pdm = k.map((x, i) => { if (!i) return 0; const u = x.h - k[i - 1].h, d = k[i - 1].l - x.l; return u > d && u > 0 ? u : 0; });
  const ndm = k.map((x, i) => { if (!i) return 0; const u = x.h - k[i - 1].h, d = k[i - 1].l - x.l; return d > u && d > 0 ? d : 0; });
  const atr = wilder(tr, p), sp = wilder(pdm, p), sn = wilder(ndm, p);
  const dx = atr.map((a, i) => { const pdi = (100 * sp[i]) / a, ndi = (100 * sn[i]) / a; return (100 * Math.abs(pdi - ndi)) / (pdi + ndi || 1); });
  const first = dx.findIndex((x) => !isNaN(x));
  const adxPart = wilder(dx.slice(first), p);
  const adx = dx.map((_, i) => (i < first ? NaN : adxPart[i - first]));
  return { atr, adx };
}

// ───────────── Estrategia ─────────────
type Signal = { side: "LONG" | "SHORT"; price: number; sl: number; tp: number; score: number; total: number; reasons: string[]; rsi: number; adx: number; t: number; highConf?: boolean };
type Reading = { trend: string; rsi: number; adx: number; price: number };

function analyze(k: Candle[]): { signal: Signal | null; reading: Reading } | null {
  if (k.length < 220) return null;
  const c = k.map((x) => x.c);
  const e20 = ema(c, 20), e50 = ema(c, 50), e200 = ema(c, 200);
  const r = rsi(c), m = macd(c), { atr, adx } = atrAdx(k);
  const i = k.length - 1, j = i - 1;
  const volAvg = k.slice(i - 20, i).reduce((s, x) => s + x.v, 0) / 20;
  const hasVol = volAvg > 0;

  const up = c[i] > e200[i] && e50[i] > e200[i];
  const down = c[i] < e200[i] && e50[i] < e200[i];
  const reading: Reading = { trend: up ? "alcista" : down ? "bajista" : "lateral", rsi: r[i], adx: adx[i], price: c[i] };

  for (const side of ["LONG", "SHORT"] as const) {
    const L = side === "LONG";
    if (L ? !up : !down) continue;
    const triggers: string[] = [];
    if (L ? e20[j] <= e50[j] && e20[i] > e50[i] : e20[j] >= e50[j] && e20[i] < e50[i]) triggers.push(`Cruce EMA20/EMA50 ${L ? "al alza" : "a la baja"}`);
    if (L ? m.hist[j] <= 0 && m.hist[i] > 0 : m.hist[j] >= 0 && m.hist[i] < 0) triggers.push(`Cruce MACD ${L ? "alcista" : "bajista"}`);
    if (L ? r[j] <= 50 && r[i] > 50 : r[j] >= 50 && r[i] < 50) triggers.push(`RSI cruza 50 ${L ? "hacia arriba" : "hacia abajo"}`);
    if (!triggers.length) continue;

    const filters: [boolean, string][] = [
      [adx[i] >= 20, `ADX ${adx[i].toFixed(0)} (tendencia con fuerza)`],
      [L ? r[i] >= 50 && r[i] <= 70 : r[i] >= 30 && r[i] <= 50, `RSI ${r[i].toFixed(0)} (sin sobre${L ? "compra" : "venta"})`],
      [L ? m.line[i] > m.signal[i] : m.line[i] < m.signal[i], `MACD ${L ? "sobre" : "bajo"} su señal`],
      [hasVol ? k[i].v >= volAvg : false, `Volumen sobre el promedio`],
    ];
    const ok = filters.filter((f) => f[0]);
    if (ok.length < MIN_FILTERS) continue;

    const risk = SL_ATR * atr[i];
    const sl = L ? c[i] - risk : c[i] + risk;
    return {
      reading,
      signal: {
        side, price: c[i], sl,
        tp: L ? c[i] + risk * TP_R : c[i] - risk * TP_R,
        score: 1 + ok.length + 1, total: 2 + filters.length,
        reasons: [`Tendencia ${L ? "alcista" : "bajista"} (precio y EMA50 ${L ? "sobre" : "bajo"} EMA200)`, ...triggers, ...ok.map((f) => f[1])],
        rsi: r[i], adx: adx[i], t: k[i].t,
      },
    };
  }
  return { signal: null, reading };
}

// ───────────── Estrategia 1D validada: EMA 30/150/200 retroceso (versión M del backtest) ─────────────
// Tendencia: precio vs EMA200 y EMA30 vs EMA150, con EMA30 > EMA150 > EMA200 alineadas.
// Gatillo: la vela toca la EMA30 y cierra a favor. Filtros: RSI 40-65 / 35-60, MACD a favor y acelerando.
// SL 2 × ATR, TP 1:2. Ganó tanto en el 70% inicial como en el 30% final del historial.
const SL_ATR_1D = 2;
function analyzeDaily(k: Candle[]): { signal: Signal | null; reading: Reading } | null {
  if (k.length < 220) return null;
  const c = k.map((x) => x.c);
  const e30 = ema(c, 30), e150 = ema(c, 150), e200 = ema(c, 200);
  const r = rsi(c), m = macd(c), { atr, adx } = atrAdx(k);
  const i = k.length - 1, j = i - 1, b = k[i];
  const up = c[i] > e200[i] && e30[i] > e150[i] && e150[i] > e200[i];
  const down = c[i] < e200[i] && e30[i] < e150[i] && e150[i] < e200[i];
  const reading: Reading = { trend: up ? "alcista" : down ? "bajista" : "lateral", rsi: r[i], adx: adx[i], price: c[i] };
  for (const side of ["LONG", "SHORT"] as const) {
    const L = side === "LONG";
    if (L ? !up : !down) continue;
    const touch = L ? b.l <= e30[i] && b.c > e30[i] && b.c > b.o : b.h >= e30[i] && b.c < e30[i] && b.c < b.o;
    if (!touch) continue;
    const rsiOk = L ? r[i] >= 40 && r[i] <= 65 : r[i] >= 35 && r[i] <= 60;
    const macdOk = (L ? m.line[i] > m.signal[i] : m.line[i] < m.signal[i]) && (L ? m.hist[i] > m.hist[j] : m.hist[i] < m.hist[j]);
    if (!rsiOk || !macdOk) continue;
    const risk = SL_ATR_1D * atr[i];
    return {
      reading,
      signal: {
        side, price: c[i], sl: L ? c[i] - risk : c[i] + risk, tp: L ? c[i] + risk * TP_R : c[i] - risk * TP_R,
        score: 5, total: 5, rsi: r[i], adx: adx[i], t: k[i].t, highConf: true,
        reasons: [
          `Tendencia ${L ? "alcista" : "bajista"}: EMA30 ${L ? ">" : "<"} EMA150 ${L ? ">" : "<"} EMA200`,
          `Precio ${L ? "sobre" : "bajo"} la EMA200`,
          `Retroceso a la EMA30 y cierre a favor`,
          `RSI ${r[i].toFixed(0)} (zona sana)`,
          `MACD ${L ? "sobre" : "bajo"} su señal y acelerando`,
        ],
      },
    };
  }
  return { signal: null, reading };
}
const analyzeFor = (tf: TF, k: Candle[]) => (tf === "1d" ? analyzeDaily(k) : analyze(k));

// ───────────── Formato ─────────────
const TF_MS_MSG: Record<TF, number> = { "1h": 3600_000, "4h": 4 * 3600_000, "1d": 24 * 3600_000 };
const fmt = (n: number) => (n >= 1000 ? n.toFixed(2) : n >= 1 ? n.toFixed(n >= 100 ? 2 : 3) : n.toPrecision(4));
const tfName = (tf: TF) => (tf === "1h" ? "1 hora" : tf === "4h" ? "4 horas" : "1 día");
const madrid = (ms: number) => new Date(ms).toLocaleString("es-ES", { timeZone: "Europe/Madrid", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

// Estrategias en vivo (elegidas por backtest con validación 70% / 30%):
//  DON  Donchian 20/10 "Tortugas" — todas las temporalidades y activos. En 1D: PF 1.69 → 1.33 en datos no vistos.
//  RSI2 Connors RSI(2) — solo acciones, solo LONG, 1D. PF 1.28 → 2.05, acierto ~70%.
//  EMA  EMA 30/150/200 retroceso — 1D, TP fijo 1:2. PF 1.23 → 1.42.
type Strat = "DON" | "RSI2" | "EMA" | "RNG";
const STRAT_INFO: Record<Strat, { name: string; how: string; hist: (tf: TF) => string }> = {
  DON: {
    name: "Ruptura Donchian (método \"Tortugas\")",
    how: "El precio rompe el máximo de las últimas 20 velas en tendencia alcista. Se deja correr la ganancia con un stop que va siguiendo al precio.",
    hist: (tf) => tf === "1d"
      ? "En pruebas con años de historial (solo LONG): acierta ~45% y cada ganancia vale de media más de 2 veces cada pérdida. Ganó en los 11 activos."
      : "En pruebas en 1h/4h (solo LONG): acierta ~35%, pero las ganancias compensan de sobra las pérdidas.",
  },
  RSI2: {
    name: "Rebote RSI(2) (método Larry Connors)",
    how: "Una acción en tendencia alcista cae fuerte unos días. Se compra la caída y se vende en el rebote.",
    hist: () => "En pruebas con años de historial: acierta ~70% de las veces, con operaciones cortas (pocos días).",
  },
  RNG: { name: "Rebote en rango (baja volatilidad)", how: "Mercado tranquilo y sin tendencia: el precio sale por debajo de la banda de Bollinger y vuelve a entrar.", hist: () => "PF 1.62 en datos no vistos." },
  EMA: {
    name: "Retroceso a la EMA30 (EMA 30/150/200)",
    how: "En tendencia clara, el precio retrocede a su media de 30 velas y rebota a favor.",
    hist: () => "En pruebas con años de historial: acierta ~42% con objetivo al doble del riesgo.",
  },
};
const HIGH_CONF = (s: Strat, tf: TF) => tf === "1d";

type Entry = { strat: Strat; side: "LONG" | "SHORT"; price: number; sl: number; tp?: number; t: number; reasons: string[] };
type Position = Entry & { sym: string; tf: TF; isCrypto: boolean; lastBar: number; bars: number; stop: number; exit?: { price: number; why: string } };

function entryMessage(sym: string, tf: TF, e: Entry, isCrypto: boolean): string {
  const L = e.side === "LONG", cur = isCrypto ? "USDT" : "USD";
  const pct = (x: number) => `${x >= e.price ? "+" : "−"}${Math.abs(((x - e.price) / e.price) * 100).toFixed(2)}%`;
  const rr = e.tp ? Math.abs(e.tp - e.price) / Math.abs(e.price - e.sl) : 0;
  return [
    `${L ? "🟢" : "🔴"} <b>${e.side} · ${sym}</b> (${tf.toUpperCase()})`,
    ``,
    `Entrada: <b>${fmt(e.price)} ${cur}</b>`,
    `Take profit: <b>${fmt(e.tp!)}</b> (${pct(e.tp!)})`,
    `Stop loss: <b>${fmt(e.sl)}</b> (${pct(e.sl)})`,
    `Riesgo/beneficio: 1:${+rr.toFixed(1)}`,
  ].join("\n");
}

function exitMessage(p: Position, price: number, why: string): string {
  const L = p.side === "LONG";
  const pct = ((L ? price - p.price : p.price - price) / p.price) * 100;
  const R = (L ? price - p.price : p.price - price) / Math.abs(p.price - p.sl);
  const win = pct > 0;
  return [
    `${win ? "✅" : "🛑"} <b>CERRAR ${p.side}</b> · <b>${p.sym}</b> · ${tfName(p.tf)}`,
    `Motivo: ${why}`,
    ``,
    `Entrada: ${fmt(p.price)} → Salida: <b>${fmt(price)}</b>`,
    `Resultado: <b>${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%</b> (${R >= 0 ? "+" : ""}${R.toFixed(2)} veces lo arriesgado)`,
    ...LEVERAGES.map((lev) => `• con x${lev}: ${pct >= 0 ? "+" : ""}${(pct * lev).toFixed(1)}%`),
    win ? `🎉 ¡Operación ganadora!` : `Las pérdidas pequeñas son parte del plan. Lo importante es respetar el stop.`,
  ].join("\n");
}

function stopMoveMessage(p: Position, newStop: number): string {
  const L = p.side === "LONG";
  const locked = ((L ? newStop - p.price : p.price - newStop) / p.price) * 100;
  return [
    `🔧 <b>MUEVE TU STOP</b> · ${p.side} <b>${p.sym}</b> · ${tfName(p.tf)}`,
    `Nuevo stop loss: <b>${fmt(newStop)}</b>`,
    locked >= 0 ? `🔒 Ya aseguras al menos <b>+${locked.toFixed(2)}%</b> pase lo que pase.` : `Reduces la pérdida máxima a ${locked.toFixed(2)}%.`,
  ].join("\n");
}

// ───────────── Reglas de entrada ─────────────
function sma(v: number[], p: number) { const o = new Array(v.length).fill(NaN); let s = 0; for (let i = 0; i < v.length; i++) { s += v[i]; if (i >= p) s -= v[i - p]; if (i >= p - 1) o[i] = s / p; } return o; }
const ind = (k: Candle[]) => {
  const c = k.map((x) => x.c);
  const aa = atrAdx(k), mid = sma(c, 20);
  const sd = c.map((_, i) => { if (i < 19) return NaN; let s = 0; for (let j = i - 19; j <= i; j++) s += (c[j] - mid[i]) ** 2; return Math.sqrt(s / 20); });
  return { c, e200: ema(c, 200), s200: sma(c, 200), s5: sma(c, 5), r2: rsi(c, 2), atr: aa.atr, adx: aa.adx, mid, bbLo: c.map((_, i) => mid[i] - 2 * sd[i]), bbUp: c.map((_, i) => mid[i] + 2 * sd[i]) };
};

function donchianEntry(k: Candle[], I: ReturnType<typeof ind>): Entry | null {
  const i = k.length - 1; if (i < 220) return null;
  const hi = Math.max(...k.slice(i - 20, i).map((x) => x.h)), lo = Math.min(...k.slice(i - 20, i).map((x) => x.l));
  const c = I.c[i], a = I.atr[i];
  if (c > hi && c > I.e200[i]) return { strat: "DON", side: "LONG", price: c, sl: c - 2 * a, tp: c + 3 * 2 * a, t: k[i].t, reasons: [`Rompió el máximo de las últimas 20 velas (${fmt(hi)})`, `Tendencia alcista: precio sobre la EMA200`] };
  // SHORT desactivado: en backtest los cortos de Donchian perdían (PF 0.78). Solo LONG.
  //   if (c < lo && c < I.e200[i]) return { strat: "DON", side: "SHORT", price: c, sl: c + 2 * a, t: k[i].t, reasons: [`Rompió el mínimo de las últimas 20 velas (${fmt(lo)})`, `Tendencia bajista: precio bajo la EMA200`] };
  return null;
}
function rsi2Entry(k: Candle[], I: ReturnType<typeof ind>): Entry | null {
  const i = k.length - 1; if (i < 220) return null;
  const c = I.c[i];
  if (c > I.s200[i] && I.r2[i] < 10)
    return { strat: "RSI2", side: "LONG", price: c, sl: c - 1.5 * I.atr[i], tp: c + 1.5 * 1.5 * I.atr[i], t: k[i].t, reasons: [`En tendencia alcista: sobre su media de 200 días`, `Caída fuerte a corto plazo: RSI(2) = ${I.r2[i].toFixed(1)} (menor de 10) → rebote probable`] };
  return null;
}
// Rebote en rango 4H: ADX < 20, bandas estrechas (< 6%), cierre previo bajo la banda inferior y cierre actual dentro. SL 1.5 ATR, TP 1:1.5.
function rangeEntry(k: Candle[], I: ReturnType<typeof ind>): Entry | null {
  const i = k.length - 1; if (i < 220) return null;
  const c = I.c[i], a = I.atr[i];
  if (I.adx[i] < 20 && (I.bbUp[i] - I.bbLo[i]) / I.mid[i] < 0.06 && I.c[i - 1] < I.bbLo[i - 1] && c > I.bbLo[i])
    return { strat: "RNG", side: "LONG", price: c, sl: c - 1.5 * a, tp: c + 1.5 * 1.5 * a, t: k[i].t, reasons: [`Mercado en rango tranquilo (ADX ${I.adx[i].toFixed(0)})`, `Volvió a entrar en las bandas de Bollinger`] };
  return null;
}
function emaEntry(k: Candle[]): Entry | null {
  const a = analyzeDaily(k);
  if (!a?.signal) return null;
  const s = a.signal;
  if (s.side !== "LONG") return null; // en backtest los SHORT de la EMA perdían (PF 0.77)
  return { strat: "EMA", side: s.side, price: s.price, sl: s.sl, tp: s.tp, t: s.t, reasons: s.reasons };
}

// ───────────── Seguimiento de posiciones ─────────────
// Procesa las velas cerradas posteriores a la última vista. Devuelve mensajes a enviar y si la posición se cerró.
function track(p: Position, k: Candle[], I: ReturnType<typeof ind>): { msgs: string[]; closed: boolean } {
  const L = p.side === "LONG", msgs: string[] = [];
  const legacy = !p.tp; // posiciones antiguas (sin TP fijo) siguen con sus avisos; las nuevas cierran en silencio en TP o SL
  const done = (price: number, why: string) => { p.exit = { price, why }; msgs.push(exitMessage(p, price, why)); return { msgs, closed: true }; };
  const start = k.findIndex((x) => x.t > p.lastBar);
  if (start < 0) return { msgs, closed: false };
  const prevStop = p.stop;
  for (let m = start; m < k.length; m++) {
    const x = k[m];
    p.lastBar = x.t; p.bars++;
    if (L ? x.l <= p.stop : x.h >= p.stop) {
      return done(p.stop, p.stop === p.sl ? "el precio tocó el stop loss" : "el precio tocó el stop que fuimos subiendo");
    }
    if (p.tp && (L ? x.h >= p.tp : x.l <= p.tp)) { return done(p.tp, "🎯 se alcanzó el objetivo (take profit)"); }
    if (legacy && p.strat === "RSI2" && x.c > I.s5[m]) { return done(x.c, "el precio rebotó sobre su media de 5 días (fin del rebote)"); }
    if (legacy && p.strat === "DON" && m >= 10) {
      const t10 = L ? Math.min(...k.slice(m - 9, m + 1).map((y) => y.l)) : Math.max(...k.slice(m - 9, m + 1).map((y) => y.h));
      p.stop = L ? Math.max(p.stop, t10) : Math.min(p.stop, t10);
    }
    if (p.bars >= (p.strat === "EMA" || p.strat === "RNG" ? 60 : 120)) { return done(x.c, "llevaba demasiado tiempo abierta sin resolverse"); }
  }
  // avisar de movimiento de stop solo si es relevante (≥ 0.25 ATR); en 1h solo si es ≥ 1 ATR para no saturar
  const a = I.atr[k.length - 1], minMove = (p.tf === "1h" ? 1 : 0.25) * a;
  if (legacy && p.strat === "DON" && Math.abs(p.stop - prevStop) >= minMove) msgs.push(stopMoveMessage(p, p.stop));
  return { msgs, closed: false };
}
const silent = (r: { msgs: string[]; closed: boolean }, p: Position) => (p.tp ? { msgs: [], closed: r.closed } : r);

// ───────────── Bucle ─────────────
type Closed = { sym: string; tf: TF; strat: Strat; side: "LONG" | "SHORT"; entry: number; exit: number; sl: number; tp?: number; R: number; pct: number; opened: number; closed: number; why: string };
type State = { last: Record<string, number>; open: Record<string, Position>; history?: Closed[]; lastWeekly?: string };
const loadState = (): State => {
  const raw = existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, "utf8")) : {};
  return raw.open ? raw : { last: {}, open: {} }; // formato antiguo → empezar limpio
};
const saveState = (s: State) => writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));

// ───────────── Registro y resumen semanal ─────────────
function summaryMessage(state: State, days = 7): string {
  const h = state.history ?? [], since = Date.now() - days * 86400_000;
  const block = (list: Closed[]) => {
    if (!list.length) return ["Sin operaciones cerradas."];
    const w = list.filter((x) => x.R > 0).length, R = list.reduce((a, x) => a + x.R, 0);
    return [`Operaciones: <b>${list.length}</b> · ✅ ${w} ganadas · 🛑 ${list.length - w} perdidas`, `Acierto: <b>${((w / list.length) * 100).toFixed(0)}%</b> · Resultado: <b>${R >= 0 ? "+" : ""}${R.toFixed(1)}R</b>`];
  };
  const week = h.filter((x) => x.closed >= since);
  const open = Object.values(state.open);
  return [
    `📊 <b>RESUMEN SEMANAL</b>`,
    ``,
    `<b>Esta semana</b>`, ...block(week),
    ...week.map((x) => `${x.R > 0 ? "✅" : "🛑"} ${x.sym} ${x.tf.toUpperCase()} ${x.side}: ${x.pct >= 0 ? "+" : ""}${x.pct.toFixed(2)}% (${x.R >= 0 ? "+" : ""}${x.R.toFixed(1)}R)`),
    ``,
    `<b>Desde el inicio</b>`, ...block(h),
    ``,
    `<b>Abiertas ahora: ${open.length}</b>`,
    ...open.map((p) => `• ${p.sym} ${p.tf.toUpperCase()} ${p.side} desde ${fmt(p.price)}`),
    ``,
    `<i>R = veces lo arriesgado. +1R = ganaste lo mismo que arriesgabas.</i>`,
  ].join("\n");
}
function weeklyDue(state: State): string | null {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Madrid", weekday: "short", hour: "numeric", hour12: false, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const g = (t: string) => parts.find((x) => x.type === t)?.value ?? "";
  const key = `${g("year")}-${g("month")}-${g("day")}`;
  return g("weekday") === "Sun" && +g("hour") >= 19 && state.lastWeekly !== key ? key : null;
}

async function scan(report = false) {
  const state = loadState();
  const lines: string[] = [];
  let sent = 0;
  const send = async (m: string) => { if (!report) { await sendTelegram(m); sent++; } };
  const jobs = [...CRYPTO.map((s) => [s, true] as const), ...STOCKS.map((s) => [s, false] as const)];
  for (const [sym, isCrypto] of jobs) {
    for (const tf of TIMEFRAMES) {
      try {
        const k = isCrypto ? await fetchCrypto(sym, tf) : await fetchStock(sym, tf);
        if (k.length < 220) { lines.push(`${sym} ${tf}: datos insuficientes`); continue; }
        const I = ind(k), last = k[k.length - 1];
        const strats: Strat[] = tf === "1d" ? (isCrypto ? ["DON", "EMA"] : ["DON", "RSI2", "EMA"]) : ["RNG"];
        const tags: string[] = [];
        for (const st of strats) {
          const key = `${st}|${sym}|${tf}`;
          const pos = state.open[key];
          if (pos) {
            const r = silent(track(pos, k, I), pos);
            for (const m of r.msgs) await send(m);
            if (r.closed) {
              if (pos.exit) {
                const Lg = pos.side === "LONG", diff = Lg ? pos.exit.price - pos.price : pos.price - pos.exit.price;
                (state.history ??= []).push({ sym, tf, strat: pos.strat, side: pos.side, entry: pos.price, exit: pos.exit.price, sl: pos.sl, tp: pos.tp, R: diff / Math.abs(pos.price - pos.sl), pct: (diff / pos.price) * 100, opened: pos.t, closed: Date.now(), why: pos.exit.why });
              }
              delete state.open[key];
            } else tags.push(`${st} ${pos.side} abierta`);
            continue;
          }
          if (state.last[key] === last.t) continue;
          const e = st === "DON" ? donchianEntry(k, I) : st === "RSI2" ? rsi2Entry(k, I) : st === "RNG" ? rangeEntry(k, I) : emaEntry(k);
          if (!e) continue;
          tags.push(`${st} ${e.side} NUEVA`);
          if (report) continue;
          state.last[key] = last.t;
          await send(entryMessage(sym, tf, e, isCrypto));
          state.open[key] = { ...e, sym, tf, isCrypto, lastBar: last.t, bars: 0, stop: e.sl };
        }
        lines.push(`${sym} ${tf}: ${fmt(last.c)}${tags.length ? " · " + tags.join(" · ") : ""}`);
      } catch (e) {
        lines.push(`${sym} ${tf}: error ${(e as Error).message}`);
      }
    }
  }
  if (!report) { const wk = weeklyDue(state); if (wk) { await sendTelegram(summaryMessage(state)); state.lastWeekly = wk; sent++; } }
  saveState(state);
  console.log(new Date().toLocaleString(), `— mensajes enviados: ${sent} · posiciones abiertas: ${Object.keys(state.open).length}`);
  console.log(lines.join("\n"));
  if (report) await sendTelegram(`📋 <b>Estado del mercado</b>\n<code>${lines.join("\n")}</code>`);
}

const args = process.argv.slice(2);
if (args.includes("--summary")) await sendTelegram(summaryMessage(loadState()));
else if (args.includes("--sample")) {
  // envía ejemplos de formato con precios reales (no son señales reales)
  const k = await fetchBinance("BTCUSDT", "1d"), I = ind(k), i = k.length - 1, c = I.c[i];
  const ex: Entry = { strat: "DON", side: "LONG", price: c, sl: c - 2 * I.atr[i], tp: c + 6 * I.atr[i], t: k[i].t, reasons: [`Rompió el máximo de las últimas 20 velas`, `Tendencia alcista: precio sobre la EMA200`] };
  await sendTelegram("🧪 <b>EJEMPLO DE FORMATO — no es una señal real</b>\n\n" + entryMessage("BTCUSDT", "1d", ex, true));
} else if (args.includes("--replay")) {
  // verificación: reproduce el historial vela a vela con la lógica en vivo (sin Telegram)
  const REPLAY_TF = (process.env.REPLAY_TF ?? "1d") as TF;
  for (const [sym, isCrypto] of [["BTCUSDT", true], ["SOLUSDT", true], ["ETHUSDT", true], ["SPY", false], ["NVDA", false], ["MSFT", false]] as const) {
    const all = isCrypto ? await fetchCrypto(sym, REPLAY_TF) : await fetchStock(sym, REPLAY_TF);
    const strats: Strat[] = REPLAY_TF === "4h" ? ["RNG"] : isCrypto ? ["DON", "EMA"] : ["DON", "RSI2", "EMA"];
    for (const st of strats) {
      let pos: Position | null = null; const R: number[] = [];
      for (let n = 221; n <= all.length; n++) {
        const k = all.slice(0, n), I = ind(k), last = k[n - 1];
        if (pos) {
          const r = track(pos, k, I);
          if (r.closed) {
            const m = r.msgs.at(-1)!.match(/\(([+-][\d.]+) veces/);
            R.push(m ? +m[1] : 0); pos = null;
          }
          continue;
        }
        const e = st === "DON" ? donchianEntry(k, I) : st === "RSI2" ? rsi2Entry(k, I) : st === "RNG" ? rangeEntry(k, I) : emaEntry(k);
        if (e) pos = { ...e, sym, tf: REPLAY_TF, isCrypto, lastBar: last.t, bars: 0, stop: e.sl };
      }
      const w = R.filter((x) => x > 0), l = R.filter((x) => x <= 0);
      const pf = -l.reduce((a, b) => a + b, 0) ? w.reduce((a, b) => a + b, 0) / -l.reduce((a, b) => a + b, 0) : 0;
      console.log(`${sym} ${st}: ${R.length} ops · acierto ${R.length ? ((w.length / R.length) * 100).toFixed(0) : 0}% · total ${R.reduce((a, b) => a + b, 0).toFixed(1)}R · PF ${pf.toFixed(2)}`);
    }
  }
} else if (args.includes("--dry")) {
  for (const [sym, isCrypto] of [["BTCUSDT", true], ["AAPL", false]] as const)
    for (const tf of TIMEFRAMES) {
      const k = isCrypto ? await fetchCrypto(sym, tf) : await fetchStock(sym, tf), I = ind(k);
      console.log(sym, tf, k.length, "velas", "DON:", donchianEntry(k, I)?.side ?? "-", "RSI2:", rsi2Entry(k, I)?.side ?? "-", "EMA:", tf === "1d" ? emaEntry(k)?.side ?? "-" : "n/a");
    }
} else if (args.includes("--report")) await scan(true);
else if (args.includes("--once")) await scan();
else {
  await sendTelegram(`✅ <b>Bot de señales activo</b>\nVigilando ${CRYPTO.length} criptos y ${STOCKS.length} acciones en 1h, 4h y 1D.`);
  while (true) { await scan(); await Bun.sleep(CHECK_EVERY_MIN * 60_000); }
}
