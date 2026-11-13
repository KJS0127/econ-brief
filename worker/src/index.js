// 시세 중계 Worker: 브라우저는 야후 시세를 직접 못 불러서(CORS) 이 Worker가 대신 받아 줌
// GET /quote?s=005930.KS,AAPL  → { at, quotes: [{ symbol, name, currency, price, prevClose, change, pct, time, spark }] }
// 6자리 국내 종목코드만 주면 .KS(코스피) → .KQ(코스닥) 순서로 찾음. 30초 캐시.

const ALLOW = ["https://kjs0127.github.io", "http://localhost:5178"];
const UA = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130 Safari/537.36" };

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const origin = req.headers.get("Origin") || "";
    const cors = { "Access-Control-Allow-Origin": ALLOW.includes(origin) ? origin : ALLOW[0], Vary: "Origin" };
    if (req.method === "OPTIONS") return new Response(null, { headers: { ...cors, "Access-Control-Allow-Methods": "GET" } });
    if (url.pathname !== "/quote") return new Response("not found", { status: 404, headers: cors });

    const syms = [...new Set((url.searchParams.get("s") || "").toUpperCase().split(",").map((s) => s.trim()).filter(Boolean))];
    if (!syms.length || syms.length > 20 || syms.some((s) => !/^[A-Z0-9.^=-]{1,15}$/.test(s)))
      return json({ error: "종목 코드가 올바르지 않습니다" }, 400, cors);

    const cache = caches.default;
    const key = new Request(`https://quote-cache.local/quote?s=${syms.join(",")}`);
    const hit = await cache.match(key);
    if (hit) return withCors(hit, cors);

    const quotes = await Promise.all(syms.map(quote));
    const res = json({ at: new Date().toISOString(), quotes }, 200, { "Cache-Control": "public, max-age=30" });
    ctx.waitUntil(cache.put(key, res.clone()));
    return withCors(res, cors);
  },
};

function json(obj, status, headers) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json; charset=utf-8", ...headers } });
}
function withCors(res, cors) {
  const r = new Response(res.body, res);
  for (const [k, v] of Object.entries(cors)) r.headers.set(k, v);
  return r;
}

async function chart(sym) {
  const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=1d&interval=5m`, { headers: UA });
  if (!r.ok) return null;
  const j = await r.json().catch(() => null);
  const res = j?.chart?.result?.[0];
  return res?.meta?.regularMarketPrice != null ? res : null;
}

async function quote(sym) {
  let s = sym;
  let r = /^\d{6}$/.test(sym) ? null : await chart(sym);
  if (!r && /^\d{6}$/.test(sym)) {
    for (const suf of [".KS", ".KQ"]) {
      r = await chart(sym + suf);
      if (r) {
        s = sym + suf;
        break;
      }
    }
  }
  if (!r) return { symbol: sym, error: "찾을 수 없음" };
  const m = r.meta;
  const price = m.regularMarketPrice;
  const prev = m.chartPreviousClose ?? m.previousClose ?? null;
  const closes = (r.indicators?.quote?.[0]?.close || []).filter((v) => v != null);
  const step = Math.max(1, Math.ceil(closes.length / 40));
  const spark = closes.filter((_, i) => i % step === 0 || i === closes.length - 1).map((v) => Number(v.toFixed(4)));
  return {
    symbol: s,
    name: m.shortName || m.longName || s,
    currency: m.currency,
    price,
    prevClose: prev,
    change: prev != null ? price - prev : null,
    pct: prev ? ((price - prev) / prev) * 100 : null,
    time: m.regularMarketTime ? new Date(m.regularMarketTime * 1000).toISOString() : null,
    spark,
  };
}
