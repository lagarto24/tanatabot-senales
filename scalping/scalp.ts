// Bot de señales de SCALPING (aparte de Tanatabot Señales). NO es asesoría financiera.
// Uso:  bun scalp.ts --once     una pasada (cada hora, al cerrar la vela de 1h)
//       bun scalp.ts --dry      una pasada sin enviar nada a Telegram ni guardar estado (prueba)
//       bun scalp.ts --replay   repite el historial guardado con esta misma lógica (verificación contra lab_top50.ts)
//       bun scalp.ts --summary  resumen de resultados (lo envía al grupo si está configurado)
//
// Estrategia EN PRUEBA: ruptura Donchian 20 LONG en velas de 1 hora, solo cripto, y solo rupturas CLARAS:
//   la vela cierra sobre el máximo de las 20 anteriores y sobre su EMA200, con volumen ≥ 1,5 × la media de 20 velas y ADX(14) ≥ 25.
//   Stop inicial: 2 × ATR(14). Después el stop sube al mínimo de las últimas 10 velas (nunca baja). Sin objetivo fijo.
// Activos (lab.ts): las 50 primeras cripto del ranking que se pueden operar.
//   · Puestos 1–25: se ENVÍAN. Backtest 3 años, costes 0,14% (lab_resultados_top50.txt): 3.404 ops (~92/mes), PF 1,25,
//     datos no vistos PF 1,38, costes dobles PF 1,10. No pasa "sin el 5% de las mejores": por eso va en prueba, con mitad de tamaño.
//   · Puestos 26–50: ninguna versión gana en el backtest (PF ~1,02 incluso con el filtro de señal clara), así que NO se envían:
//     se vigilan en papel y salen en el resumen semanal. Si en vivo funcionan, se pueden activar.
// Las 15 estrategias de 15 minutos probadas perdieron todas con costes reales: no se envían.
import { readFileSync, writeFileSync, existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { ema, atr, hi, lo, TIER_A, TIER_B, HYPERLIQUID, type C } from "./lab.ts";
import { adx } from "./lab_top50.ts";

const TF = "1h", TF_MS = 3600_000;
const N = 20, SL_ATR = 2, TRAIL = 10, MAX_BARS = 200, VOL_X = 1.5, ADX_MIN = 25;
const COST = 0.0014;
const SEND_TIER = new Set(TIER_A), ALL = [...TIER_A, ...TIER_B];
// Privados extra (ID de Telegram). Vacío: el socio del proyecto ya está dentro del grupo "Tanatabot Scalping".
const PARTNERS: string[] = [];
const DIR = import.meta.dir, STATE = join(DIR, "scalp_state.json");
const args = process.argv.slice(2), DRY = args.includes("--dry");

// ───────── Telegram (mismo bot @Tanatabot, otro grupo) ─────────
function token(): string | null {
  if (process.env.TELEGRAM_BOT_TOKEN) return process.env.TELEGRAM_BOT_TOKEN.trim();
  try { const m = readFileSync(join(homedir(), ".claude", "channels", "telegram", ".env"), "utf8").match(/^TELEGRAM_BOT_TOKEN=(.+)$/m); return m ? m[1].trim() : null; } catch { return null; }
}
function groups(): string[] {
  const env = process.env.SCALP_CHAT_IDS?.split(",").map((s) => s.trim()).filter(Boolean);
  if (env?.length) return env;
  try { return (JSON.parse(readFileSync(join(DIR, "scalp_config.json"), "utf8")).chats ?? []).map(String); } catch { return []; }
}
const TOKEN = token(), GROUPS = groups();
const PAPER = !TOKEN || !GROUPS.length; // sin grupo configurado: modo papel (solo registra, no envía a nadie)
const CHATS = [...new Set([...GROUPS, ...PARTNERS])];
async function send(text: string): Promise<boolean> {
  if (DRY || PAPER) { console.log("— mensaje (no enviado) —\n" + text.replace(/<[^>]+>/g, "")); return true; }
  let okGroup = true;
  for (const chat of CHATS) {
    try {
      const r = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chat_id: chat, text, parse_mode: "HTML", disable_web_page_preview: true }) });
      if (!r.ok) { if (GROUPS.includes(chat)) okGroup = false; console.error("Telegram", chat, r.status, await r.text()); }
    } catch (e) { if (GROUPS.includes(chat)) okGroup = false; console.error("Telegram", chat, (e as Error).message); }
  }
  return okGroup; // un fallo en un privado no hace repetir la señal en el grupo
}

// ───────── Datos ─────────
async function candles(sym: string): Promise<C[]> {
  const now = Date.now();
  if (HYPERLIQUID[sym]) {
    const r = await fetch("https://api.hyperliquid.xyz/info", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "candleSnapshot", req: { coin: HYPERLIQUID[sym], interval: TF, startTime: now - 600 * TF_MS, endTime: now } }) });
    if (!r.ok) throw new Error(`Hyperliquid HTTP ${r.status}`);
    return ((await r.json()) as any[]).filter((x) => x.T < now).map((x) => ({ t: x.t, o: +x.o, h: +x.h, l: +x.l, c: +x.c, v: +x.v }));
  }
  let last: unknown;
  for (const h of ["https://api.binance.com", "https://data-api.binance.vision"]) {
    try {
      const r = await fetch(`${h}/api/v3/klines?symbol=${sym}&interval=${TF}&limit=600`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return ((await r.json()) as any[]).filter((x) => x[6] < now).map((x) => ({ t: x[0], o: +x[1], h: +x[2], l: +x[3], c: +x[4], v: +x[5] }));
    } catch (e) { last = e; }
  }
  throw last;
}

// ───────── Lógica (la misma que la variante "volumen + ADX" de lab_top50.ts) ─────────
type Pos = { sym: string; entry: number; sl: number; stop: number; t: number; lastBar: number; bars: number; obs?: boolean };
type Closed = { sym: string; entry: number; exit: number; sl: number; R: number; pct: number; opened: number; closed: number; obs?: boolean };
type State = { open: Record<string, Pos>; last: Record<string, number>; history: Closed[]; lastWeekly?: string };
const loadState = (): State => (existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : { open: {}, last: {}, history: [] });

function signal(k: C[]): { price: number; sl: number; t: number; hh: number; vx: number; adx: number } | null {
  const i = k.length - 1; if (i < 210) return null;
  const c = k.map((x) => x.c), e200 = ema(c, 200), a = atr(k), ax = adx(k), hh = hi(k, i, N);
  let va = 0; for (let j = i - 20; j < i; j++) va += k[j].v; va /= 20;
  if (c[i] > hh && c[i] > e200[i] && va > 0 && k[i].v >= VOL_X * va && ax[i] >= ADX_MIN)
    return { price: c[i], sl: c[i] - SL_ATR * a[i], t: k[i].t, hh, vx: k[i].v / va, adx: ax[i] };
  return null;
}
// procesa las velas cerradas nuevas; devuelve el precio de salida si se cerró
function track(p: Pos, k: C[]): number | null {
  for (let m = k.findIndex((x) => x.t > p.lastBar); m >= 0 && m < k.length; m++) {
    const x = k[m]; p.lastBar = x.t; p.bars++;
    if (x.o <= p.stop) return x.o;
    if (x.l <= p.stop) return p.stop;
    if (p.bars >= MAX_BARS) return x.c;
    p.stop = Math.max(p.stop, lo(k, m + 1, TRAIL));
  }
  return null;
}

const name = (s: string) => (s === "GRAMUSDT" ? "GRAM (antes TON)" : s.replace("USDT", ""));
const fmt = (n: number) => (n >= 1000 ? n.toFixed(1) : n >= 1 ? n.toFixed(n >= 100 ? 2 : 3) : n.toPrecision(4));
const pctTxt = (a: number, b: number) => `${b >= a ? "+" : "−"}${Math.abs(((b - a) / a) * 100).toFixed(2)}%`;
const entryMsg = (sym: string, s: NonNullable<ReturnType<typeof signal>>) => [
  `⚡ <b>SCALPING · LONG · ${name(sym)}</b> (1H)`,
  `<i>Estrategia en prueba: usa la mitad de tamaño.</i>`,
  ``,
  `Entrada: <b>${fmt(s.price)} ${HYPERLIQUID[sym] ? "USDC" : "USDT"}</b>`,
  `Stop loss: <b>${fmt(s.sl)}</b> (${pctTxt(s.price, s.sl)})`,
  `Objetivo: sin objetivo fijo, se deja correr. Te avisamos para cerrar.`,
  ``,
  `Motivo: rompió el máximo de las últimas 20 horas (${fmt(s.hh)}) en tendencia alcista, con volumen ${s.vx.toFixed(1)}× la media y tendencia fuerte (ADX ${s.adx.toFixed(0)}).`,
  `<i>No es asesoramiento financiero.</i>`,
].join("\n");
const exitMsg = (p: Pos, x: number) => `⚡ <b>CERRAR POSICIÓN · ${name(p.sym)}</b> (scalping 1H) · ${pctTxt(p.entry, x)}`;

function summary(st: State, days = 7) {
  const since = Date.now() - days * 86400_000, line = (h: Closed[]) => { const w = h.filter((x) => x.R > 0).length, R = h.reduce((a, x) => a + x.R, 0); return `${h.length} operaciones · ${w} ganadoras · ${R >= 0 ? "+" : ""}${R.toFixed(2)} R`; };
  const h = st.history.filter((x) => x.closed >= since);
  return [`⚡ <b>Scalping · últimos ${days} días</b> (en prueba)`, `Señales enviadas (top 25): ${line(h.filter((x) => !x.obs))}`, `Vigilancia puestos 26–50 (no enviadas): ${line(h.filter((x) => x.obs))}`,
    `Abiertas ahora: ${Object.values(st.open).filter((p) => !p.obs).length}`, `<i>1 R = lo que se arriesga en cada operación.</i>`].join("\n");
}

async function pass() {
  const st = loadState(); const lines: string[] = [];
  for (const sym of ALL) {
    const obs = !SEND_TIER.has(sym), say = (m: string) => (obs ? Promise.resolve(true) : send(m));
    try {
      const k = await candles(sym); if (k.length < 220) { lines.push(`${sym}: pocos datos`); continue; }
      const p = st.open[sym];
      if (p) {
        const x = track(p, k);
        if (x !== null) {
          if (await say(exitMsg(p, x))) {
            st.history.push({ sym, entry: p.entry, exit: x, sl: p.sl, R: (x - p.entry - COST * p.entry) / (p.entry - p.sl), pct: ((x - p.entry) / p.entry) * 100, opened: p.t, closed: Date.now(), ...(obs ? { obs } : {}) });
            delete st.open[sym]; lines.push(`${sym}: CERRADA en ${fmt(x)}${obs ? " (vigilancia)" : ""}`);
          }
        } else lines.push(`${sym}: abierta · stop ${fmt(p.stop)}${obs ? " (vigilancia)" : ""}`);
        continue;
      }
      const last = k[k.length - 1];
      if (st.last[sym] === last.t) { lines.push(`${sym}: ${fmt(last.c)}`); continue; }
      const s = signal(k);
      if (s && (await say(entryMsg(sym, s)))) {
        st.open[sym] = { sym, entry: s.price, sl: s.sl, stop: s.sl, t: s.t, lastBar: s.t, bars: 0, ...(obs ? { obs } : {}) };
        lines.push(`${sym}: NUEVA LONG en ${fmt(s.price)}${obs ? " (vigilancia, no enviada)" : ""}`);
      } else lines.push(`${sym}: ${fmt(last.c)}`);
      st.last[sym] = last.t;
    } catch (e) { lines.push(`${sym}: error ${(e as Error).message}`); }
  }
  // resumen semanal: domingo a partir de las 19:00 (Madrid), una vez
  const now = new Date(), wd = now.toLocaleDateString("en-GB", { timeZone: "Europe/Madrid", weekday: "short" }), hr = +now.toLocaleString("en-GB", { timeZone: "Europe/Madrid", hour: "2-digit", hour12: false });
  const day = now.toLocaleDateString("en-CA", { timeZone: "Europe/Madrid" });
  if (wd === "Sun" && hr >= 19 && st.lastWeekly !== day && (await send(summary(st)))) st.lastWeekly = day;
  if (!DRY) writeFileSync(STATE, JSON.stringify(st, null, 2));
  console.log(new Date().toISOString(), PAPER ? "· MODO PAPEL (sin grupo configurado: no se envía nada)" : `· enviando a ${CHATS.length} chat(s)`, DRY ? "· prueba en seco" : "");
  console.log(lines.join("\n"));
}

// Verificación: repite el historial guardado vela a vela con ESTA lógica y compara con el laboratorio
async function replay() {
  for (const [label, syms, ref] of [["top 25 (se envían)", TIER_A, "3404 ops · PF 1.25 · 466.3R"], ["26–50 (vigilancia)", TIER_B, "2721 ops · PF 1.01 · 8.0R"]] as const) {
    let n = 0, R = 0, gw = 0, gl = 0;
    for (const sym of syms) {
      const f = join(DIR, "_cache", `${sym}_1h.json`); if (!existsSync(f)) continue;
      const all: C[] = JSON.parse(readFileSync(f, "utf8")); let p: Pos | null = null;
      for (let i = 260; i < all.length - 1; i++) {
        const k = all.slice(Math.max(0, i - 599), i + 1);
        if (p) { const x = track(p, k); if (x !== null) { const r = (x - p.entry - COST * p.entry) / (p.entry - p.sl); n++; R += r; r > 0 ? (gw += r) : (gl -= r); p = null; } continue; }
        const s = signal(k); if (!s) continue;
        const e = all[i + 1].o; if (!(e > s.sl)) continue;
        p = { sym, entry: e, sl: s.sl, stop: s.sl, t: all[i + 1].t, lastBar: all[i].t, bars: 0 };
      }
    }
    console.log(`Replay ${label}: ${n} ops · PF ${(gw / gl).toFixed(2)} · neto ${R.toFixed(1)}R (laboratorio: ${ref})`);
  }
}

if (args.includes("--replay")) await replay();
else if (args.includes("--summary")) { const st = loadState(); await send(summary(st)); }
else await pass();
