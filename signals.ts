// Bot de señales técnicas -> Telegram (@Tanatabot)
// Uso:  bun signals.ts          (corre en bucle, revisa cada 15 min)
//       bun signals.ts --once   (una sola pasada, para probar)
//       bun signals.ts --report (envía a Telegram un resumen del estado actual)
//
// Señal = tendencia + gatillo + filtros (confluencia). Solo velas cerradas.
// Stop loss y objetivos basados en ATR. NO es asesoría financiera.

import { readFileSync, writeFileSync, existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";

// ───────────── Configuración ─────────────
const CRYPTO = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "HYPEUSDT", "BNBUSDT"];
// criptos que se leen de Hyperliquid (Binance tiene poco historial de HYPE)
const HYPERLIQUID: Record<string, string> = { HYPEUSDT: "HYPE" };
const STOCKS = ["AAPL", "TSLA", "NVDA", "MSFT", "AMZN", "SPY"];
const TIMEFRAMES = ["1h", "4h", "1d"] as const;
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
const pct = (a: number, b: number) => `${(((a - b) / b) * 100).toFixed(2)}%`;

function message(sym: string, tf: TF, s: Signal, isCrypto: boolean): string {
  const icon = s.side === "LONG" ? "🟢" : "🔴";
  const arrow = s.side === "LONG" ? "📈" : "📉";
  return [
    `${icon} <b>${s.side}</b> ${arrow} <b>${sym}</b> · ${tf.toUpperCase()} ${isCrypto ? "🪙" : "🏛"}`,
    s.highConf
      ? `⭐ <b>ALTA CONFIANZA</b> — estrategia validada en backtest (EMA 30/150/200)`
      : `⚠️ <b>BAJA CONFIANZA</b> — en backtest 1h/4h no mostró ventaja; opera con cautela`,
    ``,
    `💵 Entrada: <b>${fmt(s.price)} ${isCrypto ? "USDT" : "USD"}</b>${isCrypto ? "" : " (bolsa EE.UU.)"}`,
    `🕒 Vela cerrada: ${new Date(s.t + TF_MS_MSG[tf]).toLocaleString("es-ES", { timeZone: "Europe/Madrid", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })} (hora España)`,
    `🛑 Stop loss: <b>${fmt(s.sl)}</b> (${pct(s.sl, s.price)})`,
    `🎯 Take profit: <b>${fmt(s.tp)}</b> (${pct(s.tp, s.price)})`,
    `⚖️ Riesgo/beneficio: <b>1:${TP_R}</b>`,
    ``,
    `⚡ <b>Apalancamiento</b> (resultado sobre tu margen):`,
    ...LEVERAGES.map((lev) => {
      const slP = (Math.abs(s.sl - s.price) / s.price) * 100 * lev;
      const tpP = (Math.abs(s.tp - s.price) / s.price) * 100 * lev;
      const warn = slP >= 80 ? " ⚠️ stop muy cerca de liquidación, no recomendado" : "";
      return `• <b>x${lev}</b>: TP <b>+${tpP.toFixed(1)}%</b> · SL <b>−${slP.toFixed(1)}%</b>${warn}`;
    }),
    ``,
    `📊 Confluencia: <b>${s.score}/${s.total}</b>`,
    ...s.reasons.map((r) => `✓ ${r}`),
    ``,
    `🛡 Riesgo sugerido: máx. 1% de tu capital por operación.`,
    `⚠️ Señal automática de análisis técnico, no es asesoría financiera.`,
  ].join("\n");
}

// ───────────── Bucle ─────────────
type State = Record<string, number>;
const loadState = (): State => (existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, "utf8")) : {});
const saveState = (s: State) => writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));

async function scan(report = false) {
  const state = loadState();
  const lines: string[] = [];
  let sent = 0;
  const jobs = [...CRYPTO.map((s) => [s, true] as const), ...STOCKS.map((s) => [s, false] as const)];
  for (const [sym, isCrypto] of jobs) {
    for (const tf of TIMEFRAMES) {
      try {
        const k = isCrypto ? await fetchCrypto(sym, tf) : await fetchStock(sym, tf);
        const a = analyzeFor(tf, k);
        if (!a) { lines.push(`${sym} ${tf}: datos insuficientes`); continue; }
        const { signal, reading } = a;
        lines.push(`${sym} ${tf}: ${fmt(reading.price)} · ${reading.trend} · RSI ${reading.rsi.toFixed(0)} · ADX ${reading.adx.toFixed(0)}${signal ? ` · ${signal.side}` : ""}`);
        const key = `${sym}|${tf}`;
        if (signal && state[key] !== signal.t) {
          state[key] = signal.t;
          if (!report) { await sendTelegram(message(sym, tf, signal, isCrypto)); sent++; }
        }
      } catch (e) {
        lines.push(`${sym} ${tf}: error ${(e as Error).message}`);
      }
    }
  }
  saveState(state);
  console.log(new Date().toLocaleString(), `— señales enviadas: ${sent}`);
  console.log(lines.join("\n"));
  if (report) await sendTelegram(`📋 <b>Estado del mercado</b>\n<code>${lines.join("\n")}</code>`);
}

const args = process.argv.slice(2);
if (args.includes("--sample")) {
  // envía ejemplos de formato con precios reales de BTC (no son señales reales)
  const k = await fetchBinance("BTCUSDT", "1d");
  const c = k[k.length - 1].c, a = atrAdx(k).atr[k.length - 1] * SL_ATR_1D;
  const ex: Signal = { side: "LONG", price: c, sl: c - a, tp: c + a * TP_R, score: 5, total: 5, rsi: 52, adx: 24, t: 0, highConf: true,
    reasons: ["Tendencia alcista: EMA30 > EMA150 > EMA200", "Precio sobre la EMA200", "Retroceso a la EMA30 y cierre a favor", "RSI 52 (zona sana)", "MACD sobre su señal y acelerando"] };
  await sendTelegram("🧪 <b>EJEMPLO DE FORMATO 1D — no es una señal real</b>\n\n" + message("BTCUSDT", "1d", ex, true));
  const k4 = await fetchBinance("BTCUSDT", "4h");
  const c4 = k4[k4.length - 1].c, a4 = atrAdx(k4).atr[k4.length - 1] * SL_ATR;
  const ex4: Signal = { side: "SHORT", price: c4, sl: c4 + a4, tp: c4 - a4 * TP_R, score: 5, total: 6, rsi: 44, adx: 27, t: 0,
    reasons: ["Tendencia bajista (precio y EMA50 bajo EMA200)", "Cruce MACD bajista", "ADX 27 (tendencia con fuerza)", "RSI 44 (sin sobreventa)", "MACD bajo su señal"] };
  await sendTelegram("🧪 <b>EJEMPLO DE FORMATO 4H — no es una señal real</b>\n\n" + message("BTCUSDT", "4h", ex4, true));
} else if (args.includes("--dry")) {
  // prueba local: analiza y muestra en consola, sin Telegram ni guardar estado
  for (const [sym, isCrypto] of [["BTCUSDT", true], ["AAPL", false]] as const)
    for (const tf of TIMEFRAMES) {
      const k = isCrypto ? await fetchCrypto(sym, tf) : await fetchStock(sym, tf);
      const a = analyzeFor(tf, k);
      console.log(sym, tf, k.length, "velas", a?.reading, a?.signal ? message(sym, tf, a.signal, isCrypto) : "sin señal");
    }
} else if (args.includes("--report")) await scan(true);
else if (args.includes("--once")) await scan();
else {
  await sendTelegram(`✅ <b>Bot de señales activo</b>\nVigilando ${CRYPTO.length} criptos y ${STOCKS.length} acciones en 1h, 4h y 1D. Revisión cada ${CHECK_EVERY_MIN} min.\n⭐ 1D = estrategia validada (alta confianza)\n⚠️ 1h/4h = baja confianza`);
  // primera pasada: marca las señales ya existentes sin enviarlas (evita avalancha de señales viejas)
  if (!existsSync(STATE_FILE)) await scan(true);
  while (true) {
    await scan();
    await Bun.sleep(CHECK_EVERY_MIN * 60_000);
  }
}
