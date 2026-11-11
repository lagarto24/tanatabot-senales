// Backtest de CARTERA con la lógica EN VIVO del bot (mismas funciones de entrada y seguimiento que signals.ts).
// A diferencia de backtest.ts (cada estrategia por separado), aquí se simula el bot completo en 1D:
// prioridad entre estrategias y "una sola operación por activo", igual que en scan().
// Uso: bun cartera.ts            (descarga el historial y guarda una copia en ./_cache_cartera.json)
// Comisiones: 0,1% ida y vuelta, descontadas en R. NO es asesoría financiera.
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";

// 1) Cargar la lógica en vivo de signals.ts (configuración + indicadores + entradas + seguimiento), sin Telegram
const src = readFileSync(join(import.meta.dir, "signals.ts"), "utf8").split("\n");
const at = (re: RegExp) => src.findIndex((l) => re.test(l));
const cfgEnd = at(/^const TG_DIR/), indStart = at(/─ Indicadores ─/), trackEnd = at(/^const silent =/);
const mod = [...src.slice(0, cfgEnd), ...src.slice(indStart, trackEnd),
  "export { ind, donchianEntry, shortClearEntry, rsi2Entry, bottomEntry, volEntry, rangeEntry, emaEntry, track, CRYPTO, STOCKS };"].join("\n");
const MOD = join(import.meta.dir, "_vivo_tmp.ts");
writeFileSync(MOD, mod);
const L: any = await import(MOD);

type Candle = { t: number; o: number; h: number; l: number; c: number; v: number };
const FEE = 0.001;

// 2) Datos diarios con historial largo
const CACHE = join(import.meta.dir, "_cache_cartera.json");
async function binance(sym: string): Promise<Candle[]> {
  let end = Date.now(), out: Candle[] = [];
  while (out.length < 3000) {
    let rows: any[] = [];
    for (const h of ["https://api.binance.com", "https://data-api.binance.vision"]) {
      try { const r = await fetch(`${h}/api/v3/klines?symbol=${sym}&interval=1d&limit=1000&endTime=${end}`); if (r.ok) { rows = await r.json(); break; } } catch {}
    }
    if (!rows.length) break;
    const k = rows.map((x) => ({ t: x[0], o: +x[1], h: +x[2], l: +x[3], c: +x[4], v: +x[5], ct: x[6] }));
    out = [...k, ...out]; end = k[0].t - 1; if (rows.length < 1000) break;
  }
  return out.filter((x: any) => x.ct < Date.now()).map(({ t, o, h, l, c, v }) => ({ t, o, h, l, c, v }));
}
async function hyper(coin: string): Promise<Candle[]> {
  const now = Date.now();
  const r = await fetch("https://api.hyperliquid.xyz/info", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "candleSnapshot", req: { coin, interval: "1d", startTime: now - 3000 * 86400_000, endTime: now } }) });
  const rows: any[] = await r.json();
  return rows.filter((x) => x.T < now).map((x) => ({ t: x.t, o: +x.o, h: +x.h, l: +x.l, c: +x.c, v: +x.v }));
}
async function yahoo(sym: string): Promise<Candle[]> {
  const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${sym}?interval=1d&range=10y`, { headers: { "User-Agent": "Mozilla/5.0" } });
  const res: any = (await r.json()).chart.result[0], q = res.indicators.quote[0], out: Candle[] = [];
  res.timestamp.forEach((ts: number, i: number) => { if (q.close[i] != null && q.open[i] != null) out.push({ t: ts * 1000, o: q.open[i], h: q.high[i], l: q.low[i], c: q.close[i], v: q.volume[i] ?? 0 }); });
  return out.filter((c) => c.t + 20 * 3600_000 < Date.now());
}
let DATA: Record<string, Candle[]> = existsSync(CACHE) ? JSON.parse(readFileSync(CACHE, "utf8")) : {};
for (const s of [...L.CRYPTO, ...L.STOCKS]) {
  if (DATA[s]?.length) continue;
  try { DATA[s] = s === "HYPEUSDT" ? await hyper("HYPE") : s.endsWith("USDT") ? await binance(s) : await yahoo(s); console.error("✓", s, DATA[s].length); }
  catch (e) { console.error("✗", s, (e as Error).message); }
  writeFileSync(CACHE, JSON.stringify(DATA));
}

// 3) Simulador de cartera (réplica de scan() en 1D)
type Trade = { sym: string; strat: string; side: string; t: number; r: number; bars: number };
type Variant = { name: string; crypto: string[]; stocks: string[]; donTP?: number | null };
const PREC: Record<string, any> = {};
for (const s of Object.keys(DATA)) if (DATA[s].length >= 300) PREC[s] = L.ind(DATA[s]); // indicadores causales: el valor en i no depende del futuro

function runAsset(sym: string, v: Variant): Trade[] {
  const all = DATA[sym], I = PREC[sym]; if (!I) return [];
  const strats = sym.endsWith("USDT") ? v.crypto : v.stocks, out: Trade[] = [];
  let pos: any = null;
  for (let n = 222; n <= all.length; n++) {
    const k = all.slice(0, n);
    if (pos) {
      const r = L.track(pos, k, I);
      if (r.closed) {
        const ex = pos.exit, lg = pos.side === "LONG", risk = Math.abs(pos.price - pos.sl);
        const R = ((lg ? ex.price - pos.price : pos.price - ex.price) - FEE * pos.price) / risk;
        out.push({ sym, strat: pos.strat, side: pos.side, t: pos.t, r: R, bars: pos.bars }); pos = null;
      }
      continue; // la vela en que se cierra no abre otra (igual que el bot: la siguiente pasada ya es otra vela)
    }
    for (const st of strats) {
      let e = st === "DON" ? L.donchianEntry(k, I) : st === "RSI2" ? L.rsi2Entry(k, I) : st === "VOL" ? L.volEntry(k, I) : st === "BOT" ? L.bottomEntry(k, I) : st === "SHC" ? L.shortClearEntry(k, I) : st === "EMA" ? L.emaEntry(k) : null;
      if (!e) continue;
      if (st === "DON" && v.donTP !== undefined) { const risk = e.price - e.sl; e = { ...e, tp: v.donTP === null ? undefined : e.price + v.donTP * risk }; }
      pos = { ...e, sym, tf: "1d", isCrypto: sym.endsWith("USDT"), lastBar: k[n - 1].t, bars: 0, stop: e.sl };
      break;
    }
  }
  return out;
}
function stats(tr: Trade[]) {
  const s = [...tr].sort((a, b) => a.t - b.t), w = s.filter((x) => x.r > 0);
  const gw = w.reduce((a, x) => a + x.r, 0), gl = -s.filter((x) => x.r <= 0).reduce((a, x) => a + x.r, 0);
  let eq = 0, pk = 0, dd = 0, cap = 1; for (const x of s) { eq += x.r; pk = Math.max(pk, eq); dd = Math.max(dd, pk - eq); cap *= 1 + 0.01 * x.r; }
  return { n: s.length, win: s.length ? (100 * w.length) / s.length : 0, total: eq, pf: gl ? gw / gl : 99, dd, avg: s.length ? eq / s.length : 0, cap: (cap - 1) * 100 };
}
const fmtS = (x: ReturnType<typeof stats>) => `${String(x.n).padStart(4)} ops · acierto ${x.win.toFixed(0).padStart(2)}% · PF ${x.pf.toFixed(2)} · neto ${x.total.toFixed(1).padStart(6)}R · media ${x.avg.toFixed(2)}R · caída ${x.dd.toFixed(1)}R`;

const ACT_C = ["DON", "VOL", "EMA", "BOT", "SHC"], ACT_S = ["DON", "RSI2", "VOL", "EMA", "BOT"];
const NO_SHC = ACT_C.filter((x) => x !== "SHC");
const NO_EMA_C = ACT_C.filter((x) => x !== "EMA"), NO_EMA_S = ACT_S.filter((x) => x !== "EMA");
const VARIANTS: Variant[] = process.env.V3 ? [
  { name: "A. ACTUAL (como está el bot)", crypto: ACT_C, stocks: ACT_S },
  { name: "K. Actual sin EMA (TP 3R)", crypto: NO_EMA_C, stocks: NO_EMA_S },
  ...[4, 5].map((tp): Variant => ({ name: `K. Sin EMA + Donchian TP ${tp}R`, crypto: NO_EMA_C, stocks: NO_EMA_S, donTP: tp })),
  { name: "K. Sin EMA + Donchian sin TP (stop móvil)", crypto: NO_EMA_C, stocks: NO_EMA_S, donTP: null },
] : process.env.V2 ? [
  { name: "A. ACTUAL (como está el bot)", crypto: ACT_C, stocks: ACT_S },
  { name: "H. Actual sin SHORT en prueba (SHC)", crypto: NO_SHC, stocks: ACT_S },
  ...[4.5, 5, 5.5, 6].map((tp): Variant => ({ name: `I. Sin SHC + Donchian TP ${tp}R`, crypto: NO_SHC, stocks: ACT_S, donTP: tp })),
  { name: "J. Sin SHC ni EMA + Donchian TP 5R", crypto: ["DON", "VOL", "BOT"], stocks: ["DON", "RSI2", "VOL", "BOT"], donTP: 5 },
] : [
  { name: "A. ACTUAL (como está el bot)", crypto: ACT_C, stocks: ACT_S },
  { name: "B. Solo validadas (sin VOL, BOT, SHC)", crypto: ["DON", "EMA"], stocks: ["DON", "RSI2", "EMA"] },
  { name: "C. Donchian + RSI2 (sin EMA, VOL, BOT, SHC)", crypto: ["DON"], stocks: ["DON", "RSI2"] },
  { name: "D. Actual + Donchian TP 4R", crypto: ACT_C, stocks: ACT_S, donTP: 4 },
  { name: "E. Actual + Donchian TP 5R", crypto: ACT_C, stocks: ACT_S, donTP: 5 },
  { name: "F. Actual + Donchian sin TP (stop móvil 10 velas)", crypto: ACT_C, stocks: ACT_S, donTP: null },
  { name: "G. Solo validadas + Donchian TP 4R", crypto: ["DON", "EMA"], stocks: ["DON", "RSI2", "EMA"], donTP: 4 },
];
const syms = Object.keys(PREC);
const tAll = syms.flatMap((s) => DATA[s].map((c) => c.t)).sort((a, b) => a - b);
const cut = tAll[Math.floor(tAll.length * 0.7)], since1y = Date.now() - 365 * 86400_000;
const rep: string[] = [`BACKTEST DE CARTERA (lógica en vivo, 1D) · ${syms.length} activos · ${new Date().toISOString().slice(0, 10)}`,
  `Corte datos no vistos: desde ${new Date(cut).toISOString().slice(0, 10)} · comisiones 0,1% · "cap" = crecimiento arriesgando 1% por operación (orden de entrada)`, ""];
for (const v of VARIANTS) {
  const tr = syms.flatMap((s) => runAsset(s, v));
  const a = stats(tr), o = stats(tr.filter((x) => x.t >= cut)), y = stats(tr.filter((x) => x.t >= since1y));
  const sorted = [...tr].sort((p, q) => q.r - p.r), rest = sorted.slice(Math.ceil(tr.length * 0.05)).reduce((p, x) => p + x.r, 0);
  rep.push(`■ ${v.name}`, `   todo:        ${fmtS(a)} · cap +${a.cap.toFixed(0)}%`, `   no vistos:   ${fmtS(o)}`, `   último año:  ${fmtS(y)}`, `   sin el 5% mejores: ${rest.toFixed(1)}R`);
  const by: Record<string, Trade[]> = {}; for (const x of tr) (by[x.strat] ??= []).push(x);
  rep.push("   por estrategia: " + Object.entries(by).map(([k2, t2]) => { const s2 = stats(t2); return `${k2} ${s2.n} ops PF ${s2.pf.toFixed(2)} ${s2.total.toFixed(0)}R`; }).join(" · "), "");
}
const txt = rep.join("\n"); writeFileSync(join(import.meta.dir, process.env.V3 ? "cartera_resultados_3.txt" : process.env.V2 ? "cartera_resultados_2.txt" : "cartera_resultados.txt"), txt); console.log(txt);
