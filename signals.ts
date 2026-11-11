// Bot de señales técnicas -> Telegram (@Tanatabot)
// Uso:  bun signals.ts --once   (una pasada: la usa GitHub Actions cada hora)
//       bun signals.ts --summary (resumen de resultados a Telegram; se envía solo cada domingo 19:00)
//       bun signals.ts --agenda (noticias de hoy; sola a las 8:00) · --results (dato real: BLS y Fed) · --wait (modo en directo)
//       bun signals.ts --report (estado del mercado a Telegram) · --dry (prueba local) · --replay (verificación) · --sample (ejemplos)
//
// Estrategias elegidas por backtest con validación (70% historial / 30% datos no vistos):
//   Donchian 20/10 solo LONG (todas), RSI(2) Connors (acciones 1D). EMA 30/150/200 retirada el 11/11/2026 (ver cartera_resultados_3.txt).
// Sigue las posiciones abiertas: avisa de mover el stop y de cerrar. NO es asesoría financiera.

import { readFileSync, writeFileSync, existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";

// ───────────── Configuración ─────────────
const CRYPTO = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "HYPEUSDT", "BNBUSDT", "DOGEUSDT", "XRPUSDT", "SUIUSDT", "AVAXUSDT"];
// criptos que se leen de Hyperliquid (Binance tiene poco historial de HYPE)
const HYPERLIQUID: Record<string, string> = { HYPEUSDT: "HYPE" };
const STOCKS = ["AAPL", "TSLA", "NVDA", "MSFT", "AMZN", "SPY", "QQQ", "INTC", "AMD", "GOOGL", "META", "NFLX", "AVGO", "COST", "LLY", "ORCL", "GLD", "SLV"];
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
// Grupo "Tanatabot Señales" (creado el 11/11/2026; dentro está el socio del proyecto, José Antonio, sin ser admin).
const GRUPO_SENALES = "-5369563953";
// Personas que también reciben las señales por privado (ID de Telegram). Tienen que haber pulsado "Iniciar" en el bot.
// Vacío: el socio (936234915) ya las ve en el grupo "Tanatabot Señales".
const EXTRA_CHATS: string[] = [];
// Grupo extra que recibiría TODO (señales y noticias). Vacío: las señales van solo al grupo de señales y a los privados.
// "Acciones VS criptos" (-1003735205184) se queda separado: allí solo llegan las noticias (TELEGRAM_NEWS_TARGET).
const GRUPO_ACCIONES: string = "";
const ACCIONES_ID = "-1003735205184";
const SECONDARY = [...EXTRA_CHATS, ...(GRUPO_ACCIONES ? [GRUPO_ACCIONES] : [])];
const CHATS = [...new Set([...loadChatIds(), GRUPO_SENALES, ...SECONDARY])];

// Devuelve true si llegó a todos los chats. Si Telegram rechaza el formato HTML, reenvía en texto plano.
// Destino de las noticias (grupo y tema): secreto TELEGRAM_NEWS_TARGET con formato "chat_id:tema". Si no existe, van al privado.
const NEWS_TARGET = process.env.TELEGRAM_NEWS_TARGET?.trim() || "";
// Si el destino de noticias usa el @nombre de "Acciones VS criptos", se usa su ID numérico (funciona sea público o privado).
const newsTo = () => { if (!NEWS_TARGET) return undefined; let [chat, th] = NEWS_TARGET.split(":"); if (/^@profit99828273$/i.test(chat)) chat = ACCIONES_ID; return { chat, thread: th ? +th : undefined }; };
async function sendTelegram(text: string, to?: { chat: string; thread?: number }): Promise<boolean> {
  let allOk = true;
  const targets = to ? [to.chat, ...(GRUPO_ACCIONES && GRUPO_ACCIONES !== to.chat ? [GRUPO_ACCIONES] : [])] : CHATS;
  for (const chat_id of targets) {
    const th = to && chat_id === to.chat ? to.thread : undefined; // el tema (thread) solo existe en el grupo de noticias
    let ok = false, html = true;
    for (let attempt = 1; attempt <= 4 && !ok; attempt++) {
      try {
        const body = html
          ? { chat_id, text, parse_mode: "HTML", disable_web_page_preview: true, ...(th ? { message_thread_id: th } : {}) }
          : { chat_id, text: text.replace(/<[^>]+>/g, ""), disable_web_page_preview: true, ...(th ? { message_thread_id: th } : {}) };
        const r = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        if (r.ok) { ok = true; break; }
        const err = await r.text();
        console.error("Telegram error:", r.status, err);
        if (r.status === 400 && html) { html = false; continue; } // formato no válido → texto plano
        if (r.status < 500 && r.status !== 429) break;
      } catch (e) {
        console.error(`Telegram fallo de red (intento ${attempt}):`, (e as Error).message);
      }
      await Bun.sleep(attempt * 3000);
    }
    if (!SECONDARY.includes(chat_id)) allOk &&= ok; // un fallo en un privado o en el grupo de acciones no repite la señal en el grupo
  }
  return allOk;
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
    return d.filter((c) => c.t + 7 * H < now); // la vela diaria (abre 9:30 NY) se da por cerrada 30 min después del cierre (16:00 NY)
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
type Strat = "DON" | "RSI2" | "EMA" | "RNG" | "VOL" | "BOT" | "SHC";
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
  BOT: { name: "Posible suelo (sobreventa extrema + vela de giro)", how: "RSI diario por debajo de 25 y una vela de giro alcista.", hist: () => "En pruebas: PF 1.66 en 71 casos; pocos casos, aún no validado del todo." },
  VOL: { name: "Ruptura con volumen (curso Fran Ruiz, clase 5)", how: "El precio rompe el máximo de 20 velas con un volumen 1,5 veces mayor de lo normal.", hist: () => "PF 1.50 en datos no vistos; pasó las pruebas de estrés." },
  SHC: { name: "SHORT en tendencia bajista clara (en prueba)", how: "Precio y medias en modo bajista, tendencia fuerte, y rompe el mínimo de 20 días.", hist: () => "Backtest: PF 1.10 (1.87 en datos no vistos), pero aún no validada del todo." },
  RNG: { name: "Rebote en rango (baja volatilidad)", how: "Mercado tranquilo y sin tendencia: el precio sale por debajo de la banda de Bollinger y vuelve a entrar.", hist: () => "PF 1.62 en datos no vistos, pero falló la prueba de sensibilidad del stop (con otros stops conserva solo el 64% del beneficio): en revisión." },
  EMA: {
    name: "Retroceso a la EMA30 (EMA 30/150/200)",
    how: "En tendencia clara, el precio retrocede a su media de 30 velas y rebota a favor.",
    hist: () => "En pruebas con años de historial: acierta ~42% con objetivo al doble del riesgo.",
  },
};
const HIGH_CONF = (s: Strat, tf: TF) => tf === "1d";

type Entry = { strat: Strat; side: "LONG" | "SHORT"; price: number; sl: number; tp?: number; t: number; reasons: string[] };
type Position = Entry & { sym: string; tf: TF; isCrypto: boolean; lastBar: number; bars: number; stop: number; exit?: { price: number; why: string } };

// Metales: se operan con sus fondos (GLD, SLV), que se mueven en el mismo % que XAU/USD y XAG/USD
const METALS: Record<string, { name: string; pair: string }> = { GLD: { name: "🥇 ORO (GLD)", pair: "XAU/USD" }, SLV: { name: "🥈 PLATA (SLV)", pair: "XAG/USD" } };
function entryMessage(sym: string, tf: TF, e: Entry, isCrypto: boolean): string {
  const metal = METALS[sym];
  const L = e.side === "LONG", cur = HYPERLIQUID[sym] ? "USDC" : isCrypto ? "USDT" : "USD";
  const pct = (x: number) => `${x >= e.price ? "+" : "−"}${Math.abs(((x - e.price) / e.price) * 100).toFixed(2)}%`;
  const rr = e.tp ? Math.abs(e.tp - e.price) / Math.abs(e.price - e.sl) : 0;
  return [
    e.strat === "BOT"
      ? `⚠️ <b>POSIBLE SUELO · ${metal ? metal.name : sym}</b> (${tf.toUpperCase()}) · LONG`
      : `${L ? "🟢" : "🔴"} <b>${e.side} · ${metal ? metal.name : sym}</b> (${tf.toUpperCase()})`,
    ...(e.strat === "BOT" ? [`<i>Aviso, no señal validada: ${e.reasons.join(" + ")}. Usa la mitad de tamaño.</i>`] : []),
    ...(e.strat === "SHC" ? [`<i>SHORT en prueba: aún no validada del todo. Usa la mitad de tamaño.</i>`] : []),
    ...(e.strat === "RNG" ? [`<i>Estrategia en revisión: no pasó todas las pruebas de estrés. Usa la mitad de tamaño.</i>`] : []),
    ``,
    `Entrada: <b>${fmt(e.price)} ${cur}</b>`,
    `Take profit: <b>${fmt(e.tp!)}</b> (${pct(e.tp!)})`,
    `Stop loss: <b>${fmt(e.sl)}</b> (${pct(e.sl)})`,
    `Riesgo/beneficio: 1:${+rr.toFixed(1)}`,
    ...(metal ? [``, `📌 Si operas ${metal.pair}: entra ahora y usa los mismos % de TP y SL.`] : []),
  ].join("\n");
}

function exitMessage(p: Position, price: number, _why: string): string {
  const L = p.side === "LONG", pct = ((L ? price - p.price : p.price - price) / p.price) * 100;
  return [
    `🔔 <b>CERRAR POSICIÓN</b> · <b>${METALS[p.sym]?.name ?? p.sym}</b> ${p.side} (${p.tf.toUpperCase()})`,
    `Precio: <b>${fmt(price)}</b> · Resultado: <b>${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%</b>`,
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
  return { c, r14: rsi(c, 14), e200: ema(c, 200), e50: ema(c, 50), s200: sma(c, 200), s5: sma(c, 5), r2: rsi(c, 2), atr: aa.atr, adx: aa.adx, mid, bbLo: c.map((_, i) => mid[i] - 2 * sd[i]), bbUp: c.map((_, i) => mid[i] + 2 * sd[i]) };
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
// SHORT claro EN PRUEBA (cripto 1D): la mejor SHORT del backtest (prueba_shorts.txt). PF 1.10 en 78 ops, 1.87 fuera de muestra,
// pero depende de sus mejores operaciones: se envía marcada "en prueba" para medirla en vivo antes de darla por buena.
// Filtro de tendencia bajista clara: precio < EMA200, EMA50 < EMA200, EMA200 bajando en 20 velas, ADX > 25. Gatillo: cierre bajo el mínimo de 20 velas. SL 2 ATR, TP 2R.
function shortClearEntry(k: Candle[], I: ReturnType<typeof ind>): Entry | null {
  const i = k.length - 1; if (i < 230) return null;
  const c = I.c[i], a = I.atr[i], lo = Math.min(...k.slice(i - 20, i).map((x) => x.l));
  if (!(c < I.e200[i] && I.e50[i] < I.e200[i] && I.e200[i] < I.e200[i - 20] && I.adx[i] > 25 && c < lo)) return null;
  const risk = 2 * a;
  return { strat: "SHC", side: "SHORT", price: c, sl: c + risk, tp: c - 2 * risk, t: k[i].t, reasons: [`Tendencia bajista clara: precio y EMA50 bajo la EMA200, que va bajando`, `ADX ${I.adx[i].toFixed(0)} (tendencia fuerte)`, `Rompió el mínimo de 20 velas (${fmt(lo)})`] };
}
function rsi2Entry(k: Candle[], I: ReturnType<typeof ind>): Entry | null {
  const i = k.length - 1; if (i < 220) return null;
  const c = I.c[i];
  if (c > I.s200[i] && I.r2[i] < 10)
    return { strat: "RSI2", side: "LONG", price: c, sl: c - 1.5 * I.atr[i], tp: c + 1.5 * 1.5 * I.atr[i], t: k[i].t, reasons: [`En tendencia alcista: sobre su media de 200 días`, `Caída fuerte a corto plazo: RSI(2) = ${I.r2[i].toFixed(1)} (menor de 10) → rebote probable`] };
  return null;
}
// Rebote en rango 4H: ADX < 20, bandas estrechas (< 6%), cierre previo bajo la banda inferior y cierre actual dentro. SL 1.5 ATR, TP 1:1.5.
// Aviso de posible suelo 1D: RSI(14) < 25 (en esta vela o la anterior) + martillo o envolvente alcista. SL bajo la vela, TP 1:2.
// En pruebas: PF 1.66 en 71 casos (pocos), así que se marca como aviso no validado del todo.
function bottomEntry(k: Candle[], I: ReturnType<typeof ind>): Entry | null {
  const i = k.length - 1; if (i < 220) return null;
  const b = k[i], pv = k[i - 1], a = I.atr[i], body = Math.abs(b.c - b.o), lw = Math.min(b.o, b.c) - b.l, rng = b.h - b.l;
  const engulf = b.c > b.o && pv.c < pv.o && b.c >= pv.o && b.o <= pv.c;
  const hammer = rng > 0 && lw >= 2 * body && lw >= 0.6 * rng;
  if (!((I.r14[i] < 25 || I.r14[i - 1] < 25) && (engulf || hammer))) return null;
  const sl = b.l - 0.2 * a, risk = b.c - sl;
  if (!(risk > 0.3 * a && risk < 5 * a)) return null;
  return { strat: "BOT", side: "LONG", price: b.c, sl, tp: b.c + 2 * risk, t: b.t, reasons: [`RSI diario ${I.r14[i].toFixed(0)} (sobreventa extrema)`, engulf ? "Vela envolvente alcista" : "Vela martillo"] };
}

// Ruptura con volumen 1D (curso de Fran Ruiz, clase 5): cierre sobre el máximo de 20 velas con volumen > 1,5× la media. SL 1,5 ATR, TP 1:2.
function volEntry(k: Candle[], I: ReturnType<typeof ind>): Entry | null {
  const i = k.length - 1; if (i < 220) return null;
  const hh = Math.max(...k.slice(i - 20, i).map((x) => x.h)), va = k.slice(i - 20, i).reduce((s, x) => s + x.v, 0) / 20;
  const c = I.c[i], a = I.atr[i];
  if (va > 0 && k[i].v > 1.5 * va && c > hh)
    return { strat: "VOL", side: "LONG", price: c, sl: c - 1.5 * a, tp: c + 2 * 1.5 * a, t: k[i].t, reasons: [`Rompió el máximo de 20 velas (${fmt(hh)})`, `Volumen ${(k[i].v / va).toFixed(1)}× la media`] };
  return null;
}
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
    // SHORT Donchian: cerrar en la caída grande (RSI14 < 30). En backtest 1D cripto: PF 1.14 → 1.24 y caída máxima 35.6R → 19.0R
    if (legacy && p.strat === "DON" && !L && I.r14[m] < 30) { return done(x.c, "RSI por debajo de 30: fin de la caída"); }
    if (legacy && p.strat === "DON" && m >= 10) {
      const t10 = L ? Math.min(...k.slice(m - 9, m + 1).map((y) => y.l)) : Math.max(...k.slice(m - 9, m + 1).map((y) => y.h));
      p.stop = L ? Math.max(p.stop, t10) : Math.min(p.stop, t10);
    }
    if (p.bars >= (p.strat === "EMA" || p.strat === "RNG" || p.strat === "VOL" || p.strat === "BOT" || p.strat === "SHC" ? 60 : 120)) { return done(x.c, "llevaba demasiado tiempo abierta sin resolverse"); }
  }
  // avisar de movimiento de stop solo si es relevante (≥ 0.25 ATR); en 1h solo si es ≥ 1 ATR para no saturar
  const a = I.atr[k.length - 1], minMove = (p.tf === "1h" ? 1 : 0.25) * a;
  if (legacy && p.strat === "DON" && Math.abs(p.stop - prevStop) >= minMove) msgs.push(stopMoveMessage(p, p.stop));
  return { msgs, closed: false };
}
// Al grupo solo le llega el aviso de cierre (sin avisos de mover el stop, para no marear)
const silent = (r: { msgs: string[]; closed: boolean }, p: Position) => ({ msgs: r.closed && p.exit ? [exitMessage(p, p.exit.price, p.exit.why)] : [], closed: r.closed });

// ───────────── Noticias económicas de alto impacto (calendario gratuito de ForexFactory) ─────────────
// Solo eventos de EE.UU. de impacto alto: son los que más mueven cripto, acciones, oro y plata.
type NewsEvent = { t: number; title: string; forecast: string; previous: string };
let NEWS: NewsEvent[] | null = null;
let NEWS_OK = true; // false si el calendario no se pudo descargar ni había copia guardada
const NEWS_ES: [RegExp, string][] = [
  [/Core CPI/i, "Inflación subyacente EE.UU. (IPC subyacente)"], [/CPI/i, "Inflación EE.UU. (IPC)"],
  [/Core PCE/i, "Inflación PCE subyacente (la favorita de la Fed)"], [/PCE/i, "Inflación PCE"],
  [/Core PPI/i, "Precios de producción subyacentes (IPP)"], [/PPI/i, "Precios de producción (IPP)"],
  [/Non-Farm|NFP/i, "Empleo EE.UU. (nóminas NFP)"], [/Unemployment Rate/i, "Tasa de paro EE.UU."],
  [/Federal Funds Rate|FOMC Statement|Interest Rate/i, "Decisión de tipos de la Fed"], [/FOMC Press Conference/i, "Rueda de prensa de la Fed"],
  [/FOMC.*Minutes/i, "Actas de la Fed"], [/Powell|Fed Chair/i, "Discurso de Powell (presidente de la Fed)"],
  [/GDP/i, "PIB EE.UU."], [/Retail Sales/i, "Ventas minoristas EE.UU."], [/ISM/i, "Índice ISM"], [/JOLTS/i, "Ofertas de empleo JOLTS"],
];
const newsName = (t: string) => NEWS_ES.find(([re]) => re.test(t))?.[1] ?? t;
async function loadNews(cache?: { newsCache?: { at: number; ev: NewsEvent[] }; resultsDone?: string[]; opens?: Record<string, string> }): Promise<NewsEvent[]> {
  if (NEWS) return NEWS;
  const c = cache?.newsCache;
  if (c && Date.now() - c.at < 6 * 3600_000 && c.ev.length) return (NEWS = c.ev); // copia guardada reciente
  try {
    const r = await fetch("https://nfs.faireconomy.media/ff_calendar_thisweek.json", { headers: { "User-Agent": "Mozilla/5.0" } });
    const j: any[] = r.ok ? await r.json() : [];
    NEWS = j.filter((e) => e.impact === "High" && e.country === "USD").map((e) => ({ t: Date.parse(e.date), title: e.title, forecast: e.forecast ?? "", previous: e.previous ?? "" })).filter((e) => !isNaN(e.t));
    if (!r.ok) throw new Error("calendario " + r.status);
    if (cache) cache.newsCache = { at: Date.now(), ev: NEWS };
  } catch (e) { console.error("Calendario no disponible:", (e as Error).message); NEWS = c?.ev ?? []; NEWS_OK = !!c?.ev?.length; }
  return NEWS;
}
const hhmm = (ms: number) => new Date(ms).toLocaleString("es-ES", { timeZone: "Europe/Madrid", weekday: "short", hour: "2-digit", minute: "2-digit" });
// Nota para una señal: noticias fuertes en las próximas horas (24 h en 1D, 6 h en 4H) o en la última hora
function newsNote(tf: TF, news: NewsEvent[]): string {
  const now = Date.now(), ahead = (tf === "1d" ? 24 : 6) * 3600_000;
  const near = news.filter((e) => e.t > now - 3600_000 && e.t < now + ahead);
  if (!near.length) return "";
  const names = [...new Set(near.map((e) => `${newsName(e.title)} (${hhmm(e.t)})`))];
  return `\n\n📰 <b>Atención, noticia fuerte:</b> ${names.join(", ")}. Suele mover mucho el precio: mejor entrar después del dato o con menos tamaño.`;
}
// Agenda de la mañana: se envía una vez al día (8:00-8:59 hora España) solo si hay noticias fuertes hoy
function agendaDue(state: { lastAgenda?: string; newsCache?: { at: number; ev: NewsEvent[] } }): string | null {
  const p = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Madrid", hour: "numeric", hour12: false, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const g = (t: string) => p.find((x) => x.type === t)?.value ?? "";
  const key = `${g("year")}-${g("month")}-${g("day")}`;
  return +g("hour") === 8 && state.lastAgenda !== key ? key : null;
}
function agendaMessage(news: NewsEvent[], dayKey: string): string | null {
  const today = news.filter((e) => new Date(e.t).toLocaleDateString("en-CA", { timeZone: "Europe/Madrid" }) === dayKey).sort((a, b) => a.t - b.t);
  if (!today.length) return null;
  return [
    `📰 <b>NOTICIAS IMPORTANTES HOY</b> (EE.UU., impacto alto)`,
    ``,
    ...today.map((e) => `🕒 <b>${new Date(e.t).toLocaleTimeString("es-ES", { timeZone: "Europe/Madrid", hour: "2-digit", minute: "2-digit" })}</b> · ${newsName(e.title)}${e.forecast ? ` · previsión ${e.forecast}` : ""}${e.previous ? ` · anterior ${e.previous}` : ""}`),
    ``,
    `⚠️ Cerca de estas horas el precio puede dar saltos bruscos y tocar stops. Si tienes operaciones abiertas, revisa que el SL esté puesto. Evita entrar justo antes del dato.`,
    ``,
    `🔗 Calendario completo y datos en directo: <a href="https://es.investing.com/economic-calendar/">Investing.com</a>`,
  ].join("\n");
}

// ───────────── Resultados de los datos (fuente oficial: BLS, Oficina de Estadísticas Laborales de EE.UU.) ─────────────
// Tras la hora de publicación, el bot lee el dato real y lo publica con la previsión y lo que suele significar.
type ResultDef = { re: RegExp; series: string; kind: "mm" | "chgK" | "level"; name: string; goodIfLower: boolean | null; what: string };
const RESULTS: ResultDef[] = [
  { re: /^Core CPI m\/m/i, series: "CUSR0000SA0L1E", kind: "mm", name: "IPC subyacente (mensual)", goodIfLower: true, what: "inflación" },
  { re: /^CPI m\/m/i, series: "CUSR0000SA0", kind: "mm", name: "IPC (inflación mensual)", goodIfLower: true, what: "inflación" },
  { re: /^PPI m\/m/i, series: "WPSFD4", kind: "mm", name: "Precios de producción (IPP mensual)", goodIfLower: true, what: "inflación" },
  { re: /^Non-Farm Employment Change/i, series: "CES0000000001", kind: "chgK", name: "Empleo EE.UU. (nóminas NFP)", goodIfLower: null, what: "empleo" },
  { re: /^Unemployment Rate/i, series: "LNS14000000", kind: "level", name: "Tasa de paro EE.UU.", goodIfLower: null, what: "paro" },
  { re: /^Average Hourly Earnings m\/m/i, series: "CES0500000003", kind: "mm", name: "Salarios por hora (mensual)", goodIfLower: true, what: "salarios" },
];
const num = (s: string) => { const m = s.replace(",", ".").match(/-?\d+(\.\d+)?/); return m ? +m[0] * (/K/i.test(s) ? 1 : 1) : NaN; };
async function blsLatest(series: string[]): Promise<Record<string, { y: number; m: number; v: number[] }>> {
  const y = new Date().getUTCFullYear();
  const r = await fetch("https://api.bls.gov/publicAPI/v1/timeseries/data/", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ seriesid: series, startyear: String(y - 1), endyear: String(y) }),
  });
  const j: any = await r.json();
  if (j.status !== "REQUEST_SUCCEEDED") throw new Error("BLS: " + (j.message ?? []).join(" "));
  const out: Record<string, { y: number; m: number; v: number[] }> = {};
  for (const s of j.Results?.series ?? []) {
    const d = (s.data as any[]).filter((x) => /^M\d\d$/.test(x.period) && x.period !== "M13");
    if (d.length >= 2) out[s.seriesID] = { y: +d[0].year, m: +d[0].period.slice(1), v: d.slice(0, 2).map((x) => +x.value) };
  }
  return out;
}
// Publica los resultados de los eventos de las últimas 8 horas que aún no se hayan publicado
async function postResults(state: { resultsDone?: string[] }, news: NewsEvent[], send: (m: string) => Promise<boolean>): Promise<number> {
  const now = Date.now();
  const due = news.filter((e) => e.t + 5 * 60_000 < now && e.t > now - 8 * 3600_000)
    .map((e) => ({ e, def: RESULTS.find((d) => d.re.test(e.title)) }))
    .filter((x) => (x.def || FED_RE.test(x.e.title)) && !(state.resultsDone ?? []).includes(`${x.e.title}|${x.e.t}`));
  if (!due.length) return 0;
  let posted = 0;
  for (const { e } of due.filter((x) => !x.def)) { // decisión de la Fed
    try { const m = await fedResult(e); if (m && (await send(m))) { (state.resultsDone ??= []).push(`${e.title}|${e.t}`); posted++; } } catch (err) { console.error("Fed no disponible:", (err as Error).message); }
  }
  const blsDue = due.filter((x) => x.def);
  if (!blsDue.length) return posted;
  let data: Awaited<ReturnType<typeof blsLatest>>;
  try { data = await blsLatest([...new Set(blsDue.map((x) => x.def!.series))]); } catch (err) { console.error("Resultados no disponibles:", (err as Error).message); return posted; }
  for (const { e, def } of blsDue) {
    const d = data[def!.series]; if (!d) continue;
    // el dato debe ser del mes anterior al de publicación (si aún no se actualizó, se reintenta en la próxima pasada)
    const pub = new Date(e.t), expM = pub.getUTCMonth() === 0 ? 12 : pub.getUTCMonth(), expY = pub.getUTCMonth() === 0 ? pub.getUTCFullYear() - 1 : pub.getUTCFullYear();
    if (d.m !== expM || d.y !== expY) continue;
    const actual = def!.kind === "mm" ? +(((d.v[0] / d.v[1]) - 1) * 100).toFixed(1) : def!.kind === "chgK" ? Math.round(d.v[0] - d.v[1]) : d.v[0];
    const fc = num(e.forecast), unit = def!.kind === "chgK" ? "K" : "%";
    const show = (x: number) => (def!.kind === "chgK" ? `${x >= 0 ? "+" : ""}${x}K` : `${x.toFixed(1)}%`);
    let verdict = "", impact = "";
    if (!isNaN(fc)) {
      const diff = actual - fc;
      if (Math.abs(diff) < (def!.kind === "chgK" ? 15 : 0.05)) { verdict = "➖ <b>En línea con lo esperado</b>"; impact = "Sin sorpresa: el mercado suele moverse poco por este dato."; }
      else if (def!.goodIfLower === true) {
        verdict = diff > 0 ? `🔴 <b>Más alto de lo esperado</b> (más ${def!.what})` : `🟢 <b>Más bajo de lo esperado</b> (menos ${def!.what})`;
        impact = diff > 0 ? "Suele ser negativo para cripto, acciones y oro: aleja las bajadas de tipos de la Fed." : "Suele ser positivo para cripto, acciones y oro: acerca las bajadas de tipos de la Fed.";
      } else if (def!.what === "empleo") {
        verdict = diff > 0 ? "🟡 <b>Más fuerte de lo esperado</b>" : "🟡 <b>Más débil de lo esperado</b>";
        impact = diff > 0 ? "Economía fuerte: puede retrasar las bajadas de tipos (presión sobre cripto y acciones)." : "Economía más débil: acerca bajadas de tipos, pero puede asustar al mercado.";
      } else {
        verdict = diff > 0 ? "🟡 <b>Más alto de lo esperado</b>" : "🟡 <b>Más bajo de lo esperado</b>";
        impact = diff > 0 ? "Más paro: economía más débil, acerca bajadas de tipos." : "Menos paro: economía fuerte, puede retrasar bajadas de tipos.";
      }
    }
    const msg = [
      `📊 <b>DATO PUBLICADO · ${newsName(e.title)}</b>`,
      ``,
      `Resultado: <b>${show(actual)}</b>${!isNaN(fc) ? ` · previsión ${e.forecast}` : ""}${e.previous ? ` · anterior ${e.previous}` : ""}`,
      verdict,
      impact ? `💡 ${impact}` : "",
      ``,
      `<i>Fuente oficial: BLS (EE.UU.). Publicado ${hhmm(e.t)} hora España.</i>`,
    ].filter((l, i, a) => l !== "" || (a[i - 1] ?? "") !== "").join("\n");
    if (await send(msg)) { (state.resultsDone ??= []).push(`${e.title}|${e.t}`); posted++; }
  }
  if (state.resultsDone && state.resultsDone.length > 200) state.resultsDone = state.resultsDone.slice(-100);
  return posted;
}

// ───────────── Decisión de tipos de la Fed (fuente oficial: federalreserve.gov) ─────────────
const FED_RE = /Federal Funds Rate|FOMC Statement/i;
const frac = (s: string) => { const m = s.trim().match(/^(\d+)(?:[-\s](\d)\/(\d))?$/); return m ? +m[1] + (m[2] ? +m[2] / +m[3] : 0) : NaN; };
async function fedResult(e: NewsEvent): Promise<string | null> {
  const r = await fetch("https://www.federalreserve.gov/feeds/press_monetary.xml", { headers: { "User-Agent": "Mozilla/5.0" } });
  const x = await r.text();
  const items = [...x.matchAll(/<item>([\s\S]*?)<\/item>/g)].map((m) => ({
    title: (m[1].match(/<title>([\s\S]*?)<\/title>/) ?? [])[1] ?? "",
    link: ((m[1].match(/<link>([\s\S]*?)<\/link>/) ?? [])[1] ?? "").replace(/<!\[CDATA\[|\]\]>/g, "").trim(),
    t: Date.parse(((m[1].match(/<pubDate>([\s\S]*?)<\/pubDate>/) ?? [])[1] ?? "").replace(/<!\[CDATA\[|\]\]>/g, "")),
  }));
  const it = items.find((i) => /FOMC statement/i.test(i.title) && Math.abs(i.t - e.t) < 3 * 3600_000);
  if (!it) return null; // aún no publicado
  const txt = (await (await fetch(it.link, { headers: { "User-Agent": "Mozilla/5.0" } })).text()).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  const m = txt.match(/(maintain|lower|raise)[^.]{0,60}target range for the federal funds rate (?:at|to) ([\d\-\/ ]+?) to ([\d\-\/ ]+?) percent/i);
  if (!m) return null;
  const act = m[1].toLowerCase(), lo = frac(m[2]), hi = frac(m[3]);
  const verdict = act === "lower" ? "🟢 <b>BAJA los tipos de interés</b>" : act === "raise" ? "🔴 <b>SUBE los tipos de interés</b>" : "➖ <b>MANTIENE los tipos de interés</b>";
  const fc = num(e.forecast), surprise = !isNaN(fc) && Math.abs(hi - fc) > 0.01;
  const impact = act === "lower" ? "Bajar tipos suele ser positivo para cripto, acciones y oro." : act === "raise" ? "Subir tipos suele ser negativo para cripto, acciones y oro." : "Sin cambios: el mercado mirará el tono de la rueda de prensa de Powell (30 min después).";
  return [
    `🏦 <b>DECISIÓN DE LA FED</b>`,
    ``,
    verdict,
    `Nuevo rango: <b>${lo.toFixed(2)}% – ${hi.toFixed(2)}%</b>${e.forecast ? ` · previsión ${e.forecast}` : ""}${e.previous ? ` · anterior ${e.previous}` : ""}`,
    surprise ? `⚡ <b>¡Sorpresa!</b> El mercado esperaba otra cosa: pueden venir movimientos fuertes.` : "",
    `💡 ${impact}`,
    ``,
    `<i>Fuente oficial: Reserva Federal. Publicado ${hhmm(it.t)} hora España.</i>`,
  ].filter((l) => l !== "").join("\n");
}
// ¿El bot sabe sacar el resultado de este evento?
const resultable = (e: NewsEvent) => FED_RE.test(e.title) || RESULTS.some((d) => d.re.test(e.title));
// Modo "dato en directo": si hay un dato fuerte en los próximos 15 min, espera a la hora exacta y consulta cada minuto
// hasta publicarlo (máx. 10 min). Si no, simplemente espera 15 min. Lo usa el bucle de la nube en lugar de "sleep 900".
async function waitMode() {
  const st = loadState(); const news = await loadNews(st); saveState(st);
  const now = Date.now();
  const next = news.filter((e) => resultable(e) && e.t > now - 60_000 && e.t <= now + 15 * 60_000).sort((a, b) => a.t - b.t)[0];
  if (!next) { await Bun.sleep(15 * 60_000); return; }
  console.log(`⏱ Dato en directo: ${newsName(next.title)} a las ${hhmm(next.t)} — esperando…`);
  await Bun.sleep(Math.max(0, next.t - Date.now() + 20_000));
  const targets = news.filter((e) => resultable(e) && e.t === next.t);
  for (let i = 0; i < 10; i++) {
    const s = loadState();
    await postResults(s, news, (m) => sendTelegram(m, newsTo()));
    saveState(s);
    if (targets.every((e) => (s.resultsDone ?? []).includes(`${e.title}|${e.t}`))) { console.log("✅ datos publicados"); break; }
    await Bun.sleep(60_000);
  }
}

// ───────────── Aperturas de mercado (Asia, Europa, EE.UU.) ─────────────
// En cada apertura publica en el grupo un resumen: índices, BTC, oro, noticias del día y operaciones abiertas.
// No publica en fin de semana ni en festivos (si el índice no ha cotizado hoy, se salta).
type Market = { key: string; title: string; tz: string; h: number; m: number; idx: [string, string][] };
const MARKETS: Market[] = [
  { key: "ASIA", title: "🌏 ABRE ASIA (Tokio · Hong Kong)", tz: "Asia/Tokyo", h: 9, m: 0, idx: [["^N225", "Nikkei 225"], ["^HSI", "Hang Seng"]] },
  { key: "EU", title: "🌍 ABRE EUROPA (Londres · Fráncfort)", tz: "Europe/London", h: 8, m: 0, idx: [["^GDAXI", "DAX"], ["^STOXX50E", "Euro Stoxx 50"], ["^FTSE", "FTSE 100"]] },
  { key: "US", title: "🌎 ABRE EE.UU. (Nueva York)", tz: "America/New_York", h: 9, m: 30, idx: [["^GSPC", "S&P 500"], ["^IXIC", "Nasdaq"]] },
];
function localParts(tz: string) {
  const p = new Intl.DateTimeFormat("en-GB", { timeZone: tz, weekday: "short", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(new Date());
  const g = (t: string) => p.find((x) => x.type === t)?.value ?? "";
  return { wd: g("weekday"), date: `${g("year")}-${g("month")}-${g("day")}`, min: +g("hour") * 60 + +g("minute") };
}
async function quote(sym: string, tries = 3): Promise<{ price: number; prev: number; t: number } | null> {
  for (let a = 1; a <= tries; a++) try {
    const j: any = await (await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=1d&interval=5m`, { headers: { "User-Agent": "Mozilla/5.0" } })).json();
    const m = j.chart.result[0].meta;
    return { price: m.regularMarketPrice, prev: m.chartPreviousClose ?? m.previousClose, t: m.regularMarketTime * 1000 };
  } catch { if (a < tries) await Bun.sleep(1500 * a); }
  return null;
}
const chg = (p: number, prev: number) => { const x = ((p - prev) / prev) * 100; return `${x >= 0 ? "🟢 +" : "🔴 "}${x.toFixed(2)}%`; };
const big = (n: number) => n.toLocaleString("de-DE", { maximumFractionDigits: n >= 100 ? 0 : 2 }); // de-DE: igual que es-ES pero con punto de miles siempre
async function marketOpens(state: { opens?: Record<string, string>; open: Record<string, Position> }, news: NewsEvent[], send: (m: string) => Promise<boolean>) {
  for (const mk of MARKETS) {
    const lp = localParts(mk.tz), openMin = mk.h * 60 + mk.m, forced = process.env.FORCE_OPEN === mk.key, since = forced ? 10 : lp.min - openMin;
    if (!forced && (["Sat", "Sun"].includes(lp.wd) || since < 0 || since >= 45 || state.opens?.[mk.key] === lp.date)) continue;
    const qs: Awaited<ReturnType<typeof quote>>[] = []; for (const [s] of mk.idx) qs.push(await quote(s));
    const ref = qs[0];
    // ¿ya cotiza hoy? (si no, puede ser festivo o el dato aún no se ha actualizado)
    const openedToday = ref && Date.now() - ref.t < 40 * 60_000 && ref.t > Date.now() - (since + 5) * 60_000;
    if (!openedToday && !forced) { if (since >= 40) (state.opens ??= {})[mk.key] = lp.date; continue; }
    const btc = await (async () => { for (let a = 0; a < 3; a++) try { const j: any = await (await fetch("https://api.binance.com/api/v3/ticker/24hr?symbol=BTCUSDT")).json(); return { p: +j.lastPrice, c: +j.priceChangePercent }; } catch { await Bun.sleep(1500); } return null; })();
    const gold = await quote("GC=F");
    const today = news.filter((e) => new Date(e.t).toLocaleDateString("en-CA", { timeZone: "Europe/Madrid" }) === new Date().toLocaleDateString("en-CA", { timeZone: "Europe/Madrid" }) && e.t > Date.now() - 3600_000);
    const open = Object.values(state.open);
    const msg = [
      `🔔 <b>${mk.title}</b>`,
      ``,
      ...mk.idx.map(([, name], i) => (qs[i] ? `• ${name}: <b>${big(qs[i]!.price)}</b> ${chg(qs[i]!.price, qs[i]!.prev)}` : `• ${name}: sin datos`)),
      btc ? `• Bitcoin: <b>${big(btc.p)}</b> ${btc.c >= 0 ? "🟢 +" : "🔴 "}${btc.c.toFixed(2)}% (24 h)` : "",
      gold ? `• Oro: <b>${big(gold.price)}</b> ${chg(gold.price, gold.prev)}` : "",
      ``,
      today.length ? `📰 Noticias fuertes hoy: ${today.map((e) => `${newsName(e.title)} (${new Date(e.t).toLocaleTimeString("es-ES", { timeZone: "Europe/Madrid", hour: "2-digit", minute: "2-digit" })})`).join(", ")}` : NEWS_OK ? `📰 Sin noticias fuertes de EE.UU. pendientes hoy.` : `📰 Calendario no disponible ahora mismo: revisa la agenda de las 8:00.`,
      open.length ? `📈 Operaciones abiertas: ${open.map((p) => `${p.sym} ${p.side}`).join(", ")}` : `📈 Sin operaciones abiertas.`,
    ].filter((l, i, a) => !(l === "" && (a[i - 1] ?? "") === "")).join("\n");
    if (await send(msg)) (state.opens ??= {})[mk.key] = lp.date;
  }
}

// ───────────── Fin de semana: resumen cripto (sáb y dom 9:00) y agenda de la semana siguiente (dom 19:00) ─────────────
async function weekendBrief(state: { opens?: Record<string, string>; open: Record<string, Position> }, send: (m: string) => Promise<boolean>) {
  const lp = localParts("Europe/Madrid");
  if (!["Sat", "Sun"].includes(lp.wd)) return;
  // 1) Resumen cripto de la mañana
  if (lp.min >= 9 * 60 && lp.min < 9 * 60 + 45 && state.opens?.WKND !== lp.date) {
    const rows: string[] = [];
    for (const [s, n] of [["BTCUSDT", "Bitcoin"], ["ETHUSDT", "Ethereum"], ["SOLUSDT", "Solana"]] as const) {
      try { const j: any = await (await fetch(`https://api.binance.com/api/v3/ticker/24hr?symbol=${s}`)).json(); rows.push(`• ${n}: <b>${big(+j.lastPrice)}</b> ${+j.priceChangePercent >= 0 ? "🟢 +" : "🔴 "}${(+j.priceChangePercent).toFixed(2)}% (24 h)`); } catch {}
    }
    try { const k = await fetchHyperliquid("HYPE", "1d"); const a = k.at(-1)!, b = k.at(-2)!; rows.push(`• HYPE: <b>${big(a.c)}</b> ${chg(a.c, b.c)} (desde el cierre de ayer)`); } catch {}
    const open = Object.values(state.open);
    const msg = [
      `🪙 <b>CRIPTO · ${lp.wd === "Sat" ? "SÁBADO" : "DOMINGO"}</b> (las bolsas están cerradas, la cripto no)`,
      ``, ...rows, ``,
      open.length ? `📈 Operaciones abiertas: ${open.map((p) => `${p.sym} ${p.side}`).join(", ")}` : `📈 Sin operaciones abiertas.`,
      `<i>En fin de semana hay menos volumen: los movimientos pueden ser bruscos. Las señales de cripto siguen activas.</i>`,
    ].join("\n");
    if (await send(msg)) (state.opens ??= {}).WKND = lp.date;
  }
  // 2) Domingo por la tarde: agenda de la semana que viene
  if (lp.wd === "Sun" && lp.min >= 19 * 60 && state.opens?.NEXTWK !== lp.date) {
    let ev: NewsEvent[] = [];
    try {
      const r = await fetch("https://nfs.faireconomy.media/ff_calendar_nextweek.json", { headers: { "User-Agent": "Mozilla/5.0" } });
      if (r.ok) ev = ((await r.json()) as any[]).filter((e) => e.impact === "High" && e.country === "USD").map((e) => ({ t: Date.parse(e.date), title: e.title, forecast: e.forecast ?? "", previous: e.previous ?? "" }));
    } catch {}
    if (!ev.length && lp.min < 22 * 60) return; // aún no publicado: reintenta más tarde
    const msg = ev.length
      ? [`📅 <b>AGENDA DE LA SEMANA QUE VIENE</b> (EE.UU., impacto alto)`, ``,
         ...ev.sort((a, b) => a.t - b.t).map((e) => `• <b>${new Date(e.t).toLocaleString("es-ES", { timeZone: "Europe/Madrid", weekday: "short", day: "2-digit", hour: "2-digit", minute: "2-digit" })}</b> · ${newsName(e.title)}${e.forecast ? ` · previsión ${e.forecast}` : ""}`),
         ``, `⚠️ Esos días y horas el precio puede dar saltos fuertes. Planifica tus entradas.`,
         `🔗 <a href="https://es.investing.com/economic-calendar/">Calendario completo en Investing.com</a>`].join("\n")
      : `📅 <b>Semana que viene</b>: el calendario aún no está publicado. Cada mañana a las 8:00 tendrás la agenda del día.`;
    if (await send(msg)) (state.opens ??= {}).NEXTWK = lp.date;
  }
}

// ───────────── Bucle ─────────────
type Closed = { sym: string; tf: TF; strat: Strat; side: "LONG" | "SHORT"; entry: number; exit: number; sl: number; tp?: number; R: number; pct: number; opened: number; closed: number; why: string };
type State = { last: Record<string, number>; open: Record<string, Position>; history?: Closed[]; lastWeekly?: string; lastAgenda?: string; opens?: Record<string, string> };
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
  const news = await loadNews(state);
  const lines: string[] = [];
  let sent = 0;
  const send = async (m: string) => { if (report) return true; const ok = await sendTelegram(m); if (ok) sent++; return ok; };
  const jobs = [...CRYPTO.map((s) => [s, true] as const), ...STOCKS.map((s) => [s, false] as const)];
  // Filtro de mercado cripto (11/11/2026): no se abren LONG en cripto si BTC cierra bajo su media de 200 días.
  // Backtest de cartera (cartera_resultados_4.txt): PF en datos no vistos 1.64 → 1.67, caída 21.1R → 19.0R, último año 57.5R → 60.9R.
  let btcBull = true;
  try { const kb = await fetchCrypto("BTCUSDT", "1d"), Ib = ind(kb), j = kb.length - 1; btcBull = !(Ib.c[j] < Ib.s200[j]); } catch {}
  for (const [sym, isCrypto] of jobs) {
    for (const tf of TIMEFRAMES) {
      try {
        const k = isCrypto ? await fetchCrypto(sym, tf) : await fetchStock(sym, tf);
        if (k.length < 220) { lines.push(`${sym} ${tf}: datos insuficientes`); continue; }
        const I = ind(k), last = k[k.length - 1];
        // orden = prioridad si varias estrategias coinciden en el mismo activo
        // EMA retroceso retirada (11/11/2026): en el backtest de cartera (cartera.ts) ocupaba el hueco del activo con
        // operaciones flojas (PF 1.21) y bloqueaba rupturas Donchian. Sin ella: neto 672R → 716R, PF en datos no vistos 1.52 → 1.64,
        // caída máxima en datos no vistos 35.4R → 21.1R. Las posiciones EMA que sigan abiertas se siguen hasta cerrarse.
        const active: Strat[] = tf === "1d" ? (isCrypto ? ["DON", "VOL", "BOT", "SHC"] : ["DON", "RSI2", "VOL", "BOT"]) : ["RNG"];
        const leftover = Object.values(state.open).filter((p) => p.sym === sym && p.tf === tf && !active.includes(p.strat)).map((p) => p.strat);
        const strats: Strat[] = [...active, ...leftover];
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
          // una sola operación LONG por activo a la vez (evita acumular riesgo si varias estrategias coinciden)
          if (Object.values(state.open).some((p) => p.sym === sym)) continue; // una sola operación por activo (LONG o SHORT)
          const e = st === "DON" ? donchianEntry(k, I) : st === "RSI2" ? rsi2Entry(k, I) : st === "RNG" ? rangeEntry(k, I) : st === "VOL" ? volEntry(k, I) : st === "BOT" ? bottomEntry(k, I) : st === "SHC" ? shortClearEntry(k, I) : emaEntry(k);
          if (!e) continue;
          if (isCrypto && tf === "1d" && e.side === "LONG" && !btcBull) { tags.push(`${st} LONG descartada (BTC bajo su media de 200)`); continue; }
          tags.push(`${st} ${e.side} NUEVA`);
          if (report) continue;
          if (!(await send(entryMessage(sym, tf, e, isCrypto) + newsNote(tf, news)))) { tags.push("(no enviada, se reintenta)"); continue; } // si Telegram falla, no se marca: se reintenta en la próxima pasada
          state.last[key] = last.t;
          state.open[key] = { ...e, sym, tf, isCrypto, lastBar: last.t, bars: 0, stop: e.sl };
        }
        lines.push(`${sym} ${tf}: ${fmt(last.c)}${tags.length ? " · " + tags.join(" · ") : ""}`);
      } catch (e) {
        lines.push(`${sym} ${tf}: error ${(e as Error).message}`);
      }
    }
  }
  if (!report) await postResults(state, news, (m) => sendTelegram(m, newsTo()));
  if (!report) await marketOpens(state, news, (m) => sendTelegram(m, newsTo()));
  if (!report) await weekendBrief(state, (m) => sendTelegram(m, newsTo()));
  if (!report) { const day = agendaDue(state); if (day) { const m = agendaMessage(news, day); if (!m || (await sendTelegram(m, newsTo()))) state.lastAgenda = day; } }
  if (!report) { const wk = weeklyDue(state); if (wk) { await sendTelegram(summaryMessage(state)); state.lastWeekly = wk; sent++; } }
  saveState(state);
  console.log(new Date().toLocaleString(), `— mensajes enviados: ${sent} · posiciones abiertas: ${Object.keys(state.open).length}`);
  console.log(lines.join("\n"));
  if (report) await sendTelegram(`📋 <b>Estado del mercado</b>\n<code>${lines.join("\n")}</code>`);
}

const args = process.argv.slice(2);
if (args.includes("--summary")) await sendTelegram(summaryMessage(loadState()));
else if (args.includes("--wait")) await waitMode();
else if (args.includes("--opentest")) { const st = loadState(); await marketOpens(st, await loadNews(st), async (m) => (console.log(m), true)); }
else if (args.includes("--fedtest")) console.log(await fedResult({ t: Date.parse("2026-10-28T14:00:00-04:00"), title: "Federal Funds Rate", forecast: "4.00%", previous: "4.00%" }));
else if (args.includes("--results")) { const st = loadState(); const n = await postResults(st, await loadNews(st), (m) => (console.log(m), sendTelegram(m, newsTo()))); saveState(st); console.log("resultados publicados:", n); }
else if (args.includes("--agenda")) { const d = new Date().toLocaleDateString("en-CA", { timeZone: "Europe/Madrid" }); const st0 = loadState(); const nw = await loadNews(st0); saveState(st0); console.log("eventos fuertes cargados:", nw.length); const m = agendaMessage(nw, d); console.log(m ?? "sin noticias fuertes hoy"); if (m) await sendTelegram(m, newsTo()); }
else if (args.includes("--sample")) {
  // envía ejemplos de formato con precios reales (no son señales reales)
  const k = await fetchBinance("BTCUSDT", "1d"), I = ind(k), i = k.length - 1, c = I.c[i];
  const ex: Entry = { strat: "DON", side: "LONG", price: c, sl: c - 2 * I.atr[i], tp: c + 6 * I.atr[i], t: k[i].t, reasons: [`Rompió el máximo de las últimas 20 velas`, `Tendencia alcista: precio sobre la EMA200`] };
  console.log("🧪 EJEMPLO DE FORMATO (solo en pantalla, no se envía al grupo)\n\n" + entryMessage("BTCUSDT", "1d", ex, true));
  const ks = await fetchStock("SLV", "1d"), Is = ind(ks), j = ks.length - 1, cs = Is.c[j];
  console.log("🧪 EJEMPLO DE FORMATO (plata, solo en pantalla)\n\n" + entryMessage("SLV", "1d", { strat: "VOL", side: "LONG", price: cs, sl: cs - 1.5 * Is.atr[j], tp: cs + 3 * Is.atr[j], t: ks[j].t, reasons: [] }, false));
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
            const ex = pos.exit!, Lr = pos.side === "LONG";
            R.push((Lr ? ex.price - pos.price : pos.price - ex.price) / Math.abs(pos.price - pos.sl)); pos = null;
          }
          continue;
        }
        const e = st === "DON" ? donchianEntry(k, I) : st === "RSI2" ? rsi2Entry(k, I) : st === "RNG" ? rangeEntry(k, I) : st === "VOL" ? volEntry(k, I) : st === "BOT" ? bottomEntry(k, I) : emaEntry(k);
        if (e) pos = { ...e, sym, tf: REPLAY_TF, isCrypto, lastBar: last.t, bars: 0, stop: e.sl };
      }
      const w = R.filter((x) => x > 0), l = R.filter((x) => x <= 0);
      const pf = -l.reduce((a, b) => a + b, 0) ? w.reduce((a, b) => a + b, 0) / -l.reduce((a, b) => a + b, 0) : 0;
      console.log(`${sym} ${st}: ${R.length} ops · acierto ${R.length ? ((w.length / R.length) * 100).toFixed(0) : 0}% · total ${R.reduce((a, b) => a + b, 0).toFixed(1)}R · PF ${pf.toFixed(2)}`);
    }
  }
} else if (args.includes("--shctest")) {
  // verificación del SHORT en prueba: días del historial en que habría saltado (sin Telegram)
  for (const sym of ["BTCUSDT", "ETHUSDT", "SOLUSDT"]) {
    const all = await fetchCrypto(sym, "1d"), hits: string[] = [];
    for (let n = 231; n <= all.length; n++) { const k = all.slice(0, n), e = shortClearEntry(k, ind(k)); if (e) hits.push(new Date(e.t).toISOString().slice(0, 10)); }
    console.log(sym, all.length, "velas ·", hits.length, "señales · últimas:", hits.slice(-4).join(", ") || "-");
  }
} else if (args.includes("--dry")) {
  for (const [sym, isCrypto] of [["BTCUSDT", true], ["AAPL", false]] as const)
    for (const tf of TIMEFRAMES) {
      const k = isCrypto ? await fetchCrypto(sym, tf) : await fetchStock(sym, tf), I = ind(k);
      console.log(sym, tf, k.length, "velas", "DON:", donchianEntry(k, I)?.side ?? "-", "RSI2:", rsi2Entry(k, I)?.side ?? "-", "EMA:", tf === "1d" ? emaEntry(k)?.side ?? "-" : "n/a");
    }
} else if (args.includes("--report")) await scan(true);
else if (args.includes("--once")) { await scan(); await scalping(); }
else {
  await sendTelegram(`✅ <b>Bot de señales activo</b>\nVigilando ${CRYPTO.length} criptos y ${STOCKS.length} acciones en 1h, 4h y 1D.`);
  while (true) { await scan(); await Bun.sleep(CHECK_EVERY_MIN * 60_000); }
}

// Bot de scalping (carpeta scalping/, grupo "Tanatabot Scalping"): en GitHub Actions se ejecuta después de cada pasada.
// Va aquí y no en el workflow para que funcione también en la ejecución que ya está en marcha (signals.ts se descarga en cada vuelta).
// Deja su estado preparado para el commit del bucle. Un fallo del scalping nunca afecta a las señales de Tanatabot.
async function scalping() {
  if (process.env.GITHUB_ACTIONS !== "true" || !existsSync(join(import.meta.dir, "scalping", "scalp.ts"))) return;
  try {
    const r = Bun.spawnSync([process.execPath, "scalping/scalp.ts", "--once"], { cwd: import.meta.dir, stdout: "inherit", stderr: "inherit", env: process.env });
    if (r.exitCode !== 0) console.error("scalping terminó con error", r.exitCode);
    if (existsSync(join(import.meta.dir, "scalping", "scalp_state.json"))) Bun.spawnSync(["git", "add", "scalping/scalp_state.json"], { cwd: import.meta.dir });
  } catch (e) { console.error("scalping no se pudo ejecutar:", (e as Error).message); }
}
