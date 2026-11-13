// 아침 경제 브리핑 수집기
// 1) 시장 지표(야후 파이낸스 + 한국은행 ECOS) 2) 뉴스 RSS 3) 일정 → public/data/*.json
// AI 없이 규칙으로 기사를 고름: 여러 언론사가 같이 다룬 기사 우선, 포토·부고·인사 등은 제외
//
// 사용법: node scripts/collect.mjs                    (전체: 지표+뉴스+일정)
//         node scripts/collect.mjs --indicators-only  (장중: 오늘 브리핑의 지표만 갱신)
// 환경변수(선택): ECOS_API_KEY  한국은행 ECOS 키 (없으면 공개 sample 키로 최근 값만 조회)

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = path.join(ROOT, "public", "data");
const ECOS_KEY = process.env.ECOS_API_KEY || "sample";
const UA = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36",
  Accept: "application/rss+xml,application/xml,text/xml,application/json,*/*",
};
const HISTORY_DAYS = 60;
const NEWS_WINDOW_HOURS = 20;

// ───────────────────────── 날짜 도우미 (KST) ─────────────────────────
const KST_OFFSET = 9 * 3600 * 1000;
const kstDate = (d = new Date()) => new Date(d.getTime() + KST_OFFSET).toISOString().slice(0, 10);
const ymd = (s) => s.replaceAll("-", "");
const addDays = (dateStr, n) => {
  const d = new Date(dateStr + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"];
const weekdayOf = (dateStr) => WEEKDAYS[new Date(dateStr + "T00:00:00Z").getUTCDay()];

async function fetchWithTimeout(url, opts = {}, ms = 15000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

// ───────────────────────── 1. 시장 지표 ─────────────────────────
// kind: index(%) / fx(원) / rate(%p, bp 표시) / commodity(%) / level
// alert: 이 이상 움직이면 강조 (pct 기준 또는 abs 기준)
const YAHOO = [
  // 필수
  { id: "usdkrw", group: "primary", sym: "KRW=X", name: "원/달러", unit: "원", digits: 1, alert: { abs: 10 }, upIsBad: true },
  { id: "kospi", group: "primary", sym: "^KS11", name: "코스피", unit: "", digits: 2, alert: { pct: 2 } },
  { id: "sp500", group: "primary", sym: "^GSPC", name: "S&P 500", unit: "", digits: 2, alert: { pct: 2 } },
  { id: "nasdaq", group: "primary", sym: "^IXIC", name: "나스닥", unit: "", digits: 2, alert: { pct: 2 } },
  { id: "us10y", group: "primary", sym: "^TNX", name: "미 국채 10년", unit: "%", digits: 3, isRate: true, alert: { bp: 10 } },
  { id: "wti", group: "primary", sym: "CL=F", name: "WTI 유가", unit: "$", digits: 2, alert: { pct: 3 } },
  // 더보기
  { id: "kosdaq", group: "more", sym: "^KQ11", name: "코스닥", unit: "", digits: 2, alert: { pct: 2 } },
  { id: "dow", group: "more", sym: "^DJI", name: "다우", unit: "", digits: 2, alert: { pct: 2 } },
  { id: "jpykrw", group: "more", sym: "JPYKRW=X", name: "원/엔(100엔)", unit: "원", digits: 2, scale: 100, alert: { pct: 1.5 }, upIsBad: true },
  // 야후의 CNYKRW=X는 일봉이 거의 비어 있어서 (원/달러 ÷ 위안/달러)로 계산
  { id: "cnykrw", group: "more", cross: ["KRW=X", "CNY=X"], name: "원/위안", unit: "원", digits: 2, alert: { pct: 1.5 }, upIsBad: true },
  { id: "gold", group: "more", sym: "GC=F", name: "금", unit: "$", digits: 1, alert: { pct: 2 } },
  { id: "dxy", group: "more", sym: "DX-Y.NYB", name: "달러인덱스", unit: "", digits: 2, alert: { pct: 1 } },
  { id: "vix", group: "more", sym: "^VIX", name: "VIX 공포지수", unit: "", digits: 2, alert: { level: 20 }, upIsBad: true },
  { id: "btc", group: "more", sym: "BTC-USD", name: "비트코인", unit: "$", digits: 0, alert: { pct: 5 } },
];

async function fetchYahoo(def) {
  if (def.cross) {
    const [a, b] = await Promise.all(def.cross.map((sym) => fetchYahoo({ sym })));
    const bMap = new Map(b.points.map((p) => [p.date, p.value]));
    const points = a.points.filter((p) => bMap.get(p.date)).map((p) => ({ date: p.date, value: p.value / bMap.get(p.date) }));
    if (points.length < 2) throw new Error("데이터 부족");
    return { points, asOf: a.asOf };
  }
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(def.sym)}?range=1mo&interval=1d`;
  const r = await fetchWithTimeout(url, { headers: UA });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = await r.json();
  const res = j.chart?.result?.[0];
  if (!res) throw new Error("빈 응답");
  const ts = res.timestamp || [];
  const closes = res.indicators?.quote?.[0]?.close || [];
  const scale = def.scale || 1;
  const series = [];
  // 장 마감 뒤 야후 일봉의 마지막 종가가 비어 있는 경우가 있음 (예: 코스피 11/12) → 현재가(meta)로 채움
  const lastPrice = res.meta?.regularMarketPrice;
  for (let i = 0; i < ts.length; i++) {
    let c = closes[i];
    if (c == null && i === ts.length - 1 && lastPrice != null) c = lastPrice;
    if (c == null) continue;
    series.push({ date: kstDate(new Date(ts[i] * 1000)), value: c * scale });
  }
  // 같은 날짜가 두 번 나오면 마지막 것만
  const byDate = new Map(series.map((p) => [p.date, p.value]));
  const pts = [...byDate.entries()].map(([date, value]) => ({ date, value }));
  if (pts.length < 2) throw new Error("데이터 부족");
  return { points: pts, asOf: new Date(res.meta.regularMarketTime * 1000).toISOString() };
}

async function fetchEcos(stat, item, days) {
  const end = kstDate();
  const start = addDays(end, -days);
  const url = `https://ecos.bok.or.kr/api/StatisticSearch/${ECOS_KEY}/json/kr/1/${ECOS_KEY === "sample" ? 10 : 100}/${stat}/D/${ymd(start)}/${ymd(end)}/${item}`;
  const r = await fetchWithTimeout(url, { headers: UA });
  const j = await r.json();
  const rows = j.StatisticSearch?.row;
  if (!rows?.length) throw new Error(j.RESULT?.MESSAGE || "ECOS 응답 없음");
  return rows.map((x) => ({
    date: `${x.TIME.slice(0, 4)}-${x.TIME.slice(4, 6)}-${x.TIME.slice(6, 8)}`,
    value: Number(x.DATA_VALUE),
  }));
}

// sample 키는 최대 10건만 주므로 조회 기간을 짧게
const ECOS_DEFS = [
  { id: "baserate", group: "primary", name: "한국 기준금리", unit: "%", digits: 2, isRate: true, stat: "722Y001", item: "0101000", days: ECOS_KEY === "sample" ? 9 : 400, alert: { bp: 1 } },
  { id: "kr3y", group: "more", name: "국고채 3년", unit: "%", digits: 3, isRate: true, stat: "817Y002", item: "010200000", days: ECOS_KEY === "sample" ? 13 : 45, alert: { bp: 10 } },
];

function buildIndicator(def, points, asOf) {
  const last = points[points.length - 1];
  const prev = points[points.length - 2];
  const change = last.value - prev.value;
  const pct = prev.value ? (change / prev.value) * 100 : 0;
  let alert = false;
  const a = def.alert || {};
  if (a.pct != null && Math.abs(pct) >= a.pct) alert = true;
  if (a.abs != null && Math.abs(change) >= a.abs) alert = true;
  if (a.bp != null && Math.abs(change * 100) >= a.bp) alert = true;
  if (a.level != null && last.value >= a.level) alert = true;

  const ind = {
    id: def.id,
    group: def.group,
    name: def.name,
    unit: def.unit,
    digits: def.digits,
    isRate: !!def.isRate,
    upIsBad: !!def.upIsBad,
    value: last.value,
    prev: prev.value,
    change,
    pct,
    date: last.date,
    asOf: asOf || last.date,
    spark: points.slice(-7).map((p) => Number(p.value.toFixed(4))),
    alert,
  };
  // 기준금리: 마지막으로 바뀐 날 찾기
  if (def.id === "baserate") {
    for (let i = points.length - 1; i > 0; i--) {
      if (points[i].value !== points[i - 1].value) {
        ind.lastChange = { date: points[i].date, change: points[i].value - points[i - 1].value };
        break;
      }
    }
    ind.change = ind.lastChange && ind.lastChange.date === last.date ? ind.lastChange.change : 0;
    ind.alert = ind.change !== 0;
  }
  return ind;
}

// 저장해 둔 지난 브리핑에서 지표별 (날짜 → 값) 기록을 모음 (최근 10개 파일)
async function loadStoredCloses() {
  const map = new Map();
  try {
    const files = (await fs.readdir(DATA_DIR)).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort().slice(-10);
    for (const f of files) {
      const b = JSON.parse(await fs.readFile(path.join(DATA_DIR, f), "utf8"));
      for (const i of b.indicators || []) {
        if (!map.has(i.id)) map.set(i.id, new Map());
        map.get(i.id).set(i.date, i.value);
      }
    }
  } catch {}
  return map;
}

// 야후 일봉에 중간 날짜가 비어 있으면 (예: 코스피 11/12 종가 누락) 저장해 둔 값으로 메움
function fillHoles(points, stored) {
  if (!stored?.size) return points;
  const have = new Set(points.map((p) => p.date));
  const first = points[0].date, last = points[points.length - 1].date;
  const extra = [...stored].filter(([d]) => d > first && d < last && !have.has(d)).map(([date, value]) => ({ date, value }));
  if (!extra.length) return points;
  return [...points, ...extra].sort((x, y) => (x.date < y.date ? -1 : 1));
}

// ───── 공식 출처 (키 없이 무료) — 야후 값이 비거나 오래됐을 때 대신 사용, 기준일 확인에도 사용 ─────
// same: 야후와 같은 값(같은 지수 종가)이라 빈 날짜를 섞어 채워도 됨. 아니면 통째로만 바꿈.
const usDate = (mdy) => {
  const [m, d, y] = mdy.split("/");
  return `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
};
async function fetchText(url) {
  const r = await fetchWithTimeout(url, { headers: UA });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.text();
}
const OFFICIAL = {
  kospi: { src: "한국은행", same: true, get: () => fetchEcos("802Y001", "0001000", 13) },
  kosdaq: { src: "한국은행", same: true, get: () => fetchEcos("802Y001", "0089000", 13) },
  // 미 재무부 일별 국채금리 (10년). ^TNX와 소수점 차이가 있어 섞지 않음
  us10y: {
    src: "미 재무부",
    same: false,
    get: async () => {
      const y = Number(kstDate().slice(0, 4));
      const rows = [];
      for (const yr of [y - 1, y]) {
        try {
          const csv = await fetchText(
            `https://home.treasury.gov/resource-center/data-chart-center/interest-rates/daily-treasury-rates.csv/${yr}/all?type=daily_treasury_yield_curve&field_tdr_date_value=${yr}&page&_format=csv`
          );
          const lines = csv.trim().split(/\r?\n/);
          const col = lines[0].split(",").map((h) => h.replace(/"/g, "")).indexOf("10 Yr");
          if (col < 0) continue;
          for (const l of lines.slice(1)) {
            const c = l.split(",");
            if (c[col]) rows.push({ date: usDate(c[0]), value: Number(c[col]) });
          }
        } catch {}
      }
      if (rows.length < 2) throw new Error("재무부 응답 없음");
      return rows.sort((a, b) => (a.date < b.date ? -1 : 1)).slice(-30);
    },
  },
  vix: {
    src: "Cboe",
    same: true,
    get: async () => {
      const lines = (await fetchText("https://cdn.cboe.com/api/global/us_indices/daily_prices/VIX_History.csv")).trim().split(/\r?\n/);
      return lines.slice(-30).map((l) => l.split(",")).filter((c) => c[4]).map((c) => ({ date: usDate(c[0]), value: Number(c[4]) }));
    },
  },
};

// 야후와 공식 출처 중 더 최신(마지막 날짜가 늦은) 쪽을 씀. 같으면 야후(장중 값이 있음)
function pickSeries(def, yahoo, official) {
  const o = OFFICIAL[def.id];
  if (!yahoo && !official?.length) return null;
  if (!yahoo) return { points: official, src: o.src };
  if (!official?.length) return { points: yahoo.points, asOf: yahoo.asOf };
  if (official.at(-1).date > yahoo.points.at(-1).date) return { points: official, src: o.src };
  if (o.same) return { points: fillHoles(yahoo.points, new Map(official.map((p) => [p.date, p.value]))), asOf: yahoo.asOf };
  return { points: yahoo.points, asOf: yahoo.asOf };
}

// ───── 기준일 지연 표시 ─────
// 시장별 "가장 최근 거래일"을 여러 출처에서 독립적으로 구해, 그보다 오래된 지표를 stale로 표시
const MARKET = {
  kospi: "kr", kosdaq: "kr", kr3y: "krClose",
  sp500: "us", nasdaq: "us", dow: "us", us10y: "us", vix: "us",
  usdkrw: "fx", jpykrw: "fx", cnykrw: "fx", dxy: "fx",
  wti: "cmd", gold: "cmd", btc: "crypto",
};
const bizDaysBetween = (a, b) => {
  let n = 0;
  for (let d = a; d < b; d = addDays(d, 1)) {
    const w = new Date(d + "T00:00:00Z").getUTCDay();
    if (w !== 0 && w !== 6) n++;
  }
  return n;
};
function markStale(list, refs = {}) {
  const today = kstDate();
  const ref = { ...refs };
  // 끝난 한국 거래일(한국은행 코스피)은 장중 코스피의 기준으로도 씀
  if (ref.krClose && (!ref.kr || ref.krClose > ref.kr)) ref.kr = ref.krClose;
  for (const i of list) {
    const m = MARKET[i.id];
    if (m && m !== "krClose" && (!ref[m] || i.date > ref[m])) ref[m] = i.date;
  }
  for (const i of list) {
    delete i.stale;
    delete i.latestDate;
    const m = MARKET[i.id];
    if (!m) continue;
    const r = ref[m];
    const behind = r && i.date < r;
    const tooOld = m === "crypto" ? i.date < addDays(today, -1) : bizDaysBetween(i.date, today) > 4;
    if (behind || tooOld) {
      i.stale = true;
      if (behind) i.latestDate = r;
    }
  }
  return list;
}

async function collectIndicators() {
  const out = [];
  const errors = [];
  const stored = await loadStoredCloses();
  const refs = {};
  await Promise.all([
    ...YAHOO.map(async (def) => {
      let yahoo = null, official = null, yErr = null;
      await Promise.all([
        fetchYahoo(def).then((r) => (yahoo = r), (e) => (yErr = e)),
        OFFICIAL[def.id]?.get().then((r) => (official = r), () => {}),
      ]);
      if (official?.length) {
        // 한국은행 코스피 = 끝난 한국 거래일, 재무부·Cboe = 끝난 미국 거래일
        const key = def.id === "kospi" || def.id === "kosdaq" ? "krClose" : "us";
        const last = official.at(-1).date;
        if (!refs[key] || last > refs[key]) refs[key] = last;
      }
      const picked = pickSeries(def, yahoo, official);
      if (!picked) {
        errors.push(`${def.name}: ${yErr?.message || "데이터 없음"}`);
        return;
      }
      const ind = buildIndicator(def, fillHoles(picked.points, stored.get(def.id)), picked.asOf);
      if (picked.src) ind.src = picked.src;
      out.push(ind);
    }),
    ...ECOS_DEFS.map(async (def) => {
      try {
        const pts = await fetchEcos(def.stat, def.item, def.days);
        out.push(buildIndicator(def, pts));
      } catch (e) {
        errors.push(`${def.name}: ${e.message}`);
      }
    }),
  ]);
  const order = [...YAHOO, ...ECOS_DEFS].map((d) => d.id);
  // 필수 카드 순서: 환율, 코스피, S&P, 나스닥, 미10년, WTI, 기준금리
  out.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
  markStale(out, refs);
  return { list: out, errors, refs };
}

// ───────────────────────── 2. 뉴스 RSS ─────────────────────────
const FEEDS = [
  { src: "연합뉴스", cat: "macro", url: "https://www.yna.co.kr/rss/economy.xml" },
  { src: "연합뉴스", cat: "market", url: "https://www.yna.co.kr/rss/market.xml" },
  { src: "한국경제", cat: "macro", url: "https://www.hankyung.com/feed/economy" },
  { src: "한국경제", cat: "market", url: "https://www.hankyung.com/feed/finance" },
  { src: "한국경제", cat: "realestate", url: "https://www.hankyung.com/feed/realestate" },
  { src: "한국경제", cat: "global", url: "https://www.hankyung.com/feed/international" },
  { src: "한국경제", cat: "industry", url: "https://www.hankyung.com/feed/it" },
  { src: "매일경제", cat: "macro", url: "https://www.mk.co.kr/rss/30100041/" },
  { src: "매일경제", cat: "market", url: "https://www.mk.co.kr/rss/50200011/" },
  { src: "매일경제", cat: "realestate", url: "https://www.mk.co.kr/rss/50300009/" },
  { src: "매일경제", cat: "global", url: "https://www.mk.co.kr/rss/30300018/" },
  { src: "매일경제", cat: "industry", url: "https://www.mk.co.kr/rss/50100032/" },
  { src: "연합뉴스", cat: "industry", url: "https://www.yna.co.kr/rss/industry.xml" },
  // 이데일리는 경제 전용 피드가 없어 전체 피드 사용 → 아래 점수 규칙으로 경제 기사만 걸러짐
  { src: "이데일리", cat: "industry", url: "http://rss.edaily.co.kr/edaily_news.xml" },
];

const SECTIONS = [
  { key: "macro", name: "거시·금리" },
  { key: "market", name: "증시" },
  { key: "realestate", name: "부동산" },
  { key: "industry", name: "산업·기업" },
  { key: "global", name: "해외" },
];

function decodeEntities(s) {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&middot;/g, "·")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}
const tag = (block, name) => {
  const m = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`));
  return m ? decodeEntities(m[1]) : "";
};

async function fetchFeed(feed) {
  const r = await fetchWithTimeout(feed.url, { headers: UA });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const xml = await r.text();
  const items = xml.match(/<item[\s>][\s\S]*?<\/item>/g) || [];
  return items.map((b) => {
    const pub = tag(b, "pubDate") || tag(b, "dc:date");
    return {
      title: tag(b, "title"),
      link: tag(b, "link"),
      // 발췌는 지역 기사 판별(예: "(춘천=연합뉴스)")에만 쓰고 저장하지 않음
      lead: tag(b, "description").slice(0, 40),
      time: pub ? new Date(pub) : null,
      source: feed.src,
      cat: feed.cat,
    };
  });
}

const normTitle = (t) =>
  t
    .replace(/\[[^\]]*\]|\([^)]*\)|【[^】]*】/g, "")
    .replace(/[^0-9a-zA-Z가-힣]/g, "")
    .toLowerCase();
function bigrams(s) {
  const set = new Set();
  for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2));
  return set;
}
function similar(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / Math.min(a.size, b.size);
}

async function collectNews() {
  const errors = [];
  const all = [];
  await Promise.all(
    FEEDS.map(async (f) => {
      try {
        all.push(...(await fetchFeed(f)));
      } catch (e) {
        errors.push(`${f.src}(${f.cat}): ${e.message}`);
      }
    })
  );
  const cutoff = Date.now() - NEWS_WINDOW_HOURS * 3600 * 1000;
  const recent = all
    .filter((n) => n.title && n.link && n.time && !isNaN(n.time) && n.time.getTime() >= cutoff)
    .sort((a, b) => b.time - a.time);

  // 중복(같은 사건, 비슷한 제목) 묶기 → 처음 나온(최신) 기사 하나만 남기고 몇 건이 겹쳤는지 기록
  const kept = [];
  for (const n of recent) {
    const bg = bigrams(normTitle(n.title));
    const dup = kept.find((k) => similar(k._bg, bg) >= 0.6);
    if (dup) {
      dup.dupCount++;
      if (!dup.sources.includes(n.source)) dup.sources.push(n.source);
      continue;
    }
    kept.push({ ...n, _bg: bg, dupCount: 1, sources: [n.source] });
  }
  kept.forEach((n, i) => {
    n.id = i + 1;
    delete n._bg;
    n.cat = classify(n.title, n.cat);
    n.score = scoreNews(n);
  });
  return { items: kept, errors };
}

// ───────────────────────── 3. 울산 부동산 ─────────────────────────
// 통계: 한국은행 ECOS (국토부·부동산원 원자료, 월별, 2~3개월 늦게 나옴)
// 뉴스: Google 뉴스 RSS 검색 (울산 지역 언론 포함). 제목·링크·언론사·시각만 저장
const ULSAN_STATS = [
  { id: "ulsan-apt", name: "울산 아파트 실거래가지수", stat: "901Y089", item: "A00", nation: "100", kind: "index" },
  { id: "ulsan-land", name: "울산 땅값 변동률(월)", stat: "901Y064", item: "P65H", nation: "P65A", kind: "rate" },
];
const ULSAN_QUERIES = ["울산 아파트", "울산 부동산", "울산 분양 청약"];
const ULSAN_RE = /아파트|부동산|분양|청약|집값|전세|전셋|매매|미분양|입주|재개발|재건축|주택|지가|땅값|오피스텔|임대|경매|공시가|실거래|부지|택지|신도시|역세권/;
const ym = (d) => `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
const addMonths = (yyyymm, n) => {
  const d = new Date(Date.UTC(Number(yyyymm.slice(0, 4)), Number(yyyymm.slice(4)) - 1 + n, 1));
  return ym(d);
};

async function fetchEcosMonthly(stat, item, start, end) {
  const url = `https://ecos.bok.or.kr/api/StatisticSearch/${ECOS_KEY}/json/kr/1/10/${stat}/M/${start}/${end}/${item}`;
  const j = await (await fetchWithTimeout(url, { headers: UA })).json();
  // unit: 지수 기준 시점 (예: "2026.06=100") — 기준이 바뀌면 화면 문구도 따라 바뀜
  return (j.StatisticSearch?.row || []).map((x) => ({ month: x.TIME, value: Number(x.DATA_VALUE), unit: x.UNIT_NAME }));
}

async function collectUlsanStats() {
  const end = ym(new Date(Date.now() + KST_OFFSET));
  const start = addMonths(end, -9); // sample 키 10건 제한
  const out = [];
  for (const s of ULSAN_STATS) {
    try {
      const [series, nation] = await Promise.all([
        fetchEcosMonthly(s.stat, s.item, start, end),
        fetchEcosMonthly(s.stat, s.nation, start, end),
      ]);
      if (series.length < 2) throw new Error("데이터 부족");
      const last = series.at(-1), prev = series.at(-2);
      const nLast = nation.find((x) => x.month === last.month);
      const nPrev = nation.find((x) => x.month === prev.month);
      const item = {
        id: s.id,
        name: s.name,
        kind: s.kind,
        month: last.month,
        prevMonth: prev.month,
        value: last.value,
        unit: last.unit,
        spark: series.slice(-7).map((x) => x.value),
      };
      if (s.kind === "index") {
        item.mom = ((last.value - prev.value) / prev.value) * 100;
        const ago = await fetchEcosMonthly(s.stat, s.item, addMonths(last.month, -12), addMonths(last.month, -12));
        if (ago[0]) item.yoy = ((last.value - ago[0].value) / ago[0].value) * 100;
        if (nLast && nPrev) item.nationMom = ((nLast.value - nPrev.value) / nPrev.value) * 100;
      } else {
        item.prev = prev.value;
        if (nLast) item.nation = nLast.value;
      }
      out.push(item);
    } catch (e) {
      console.warn(`  ! ${s.name}: ${e.message}`);
    }
  }
  return out;
}

async function collectUlsanNews() {
  const all = [];
  await Promise.all(
    ULSAN_QUERIES.map(async (q) => {
      try {
        const url = `https://news.google.com/rss/search?q=${encodeURIComponent(q + " when:7d")}&hl=ko&gl=KR&ceid=KR:ko`;
        const xml = await fetchText(url);
        // 구글 뉴스 제목은 "제목 - 언론사" 형태라 <source> 값으로 끝부분을 떼어 냄
        for (const b of xml.match(/<item[\s>][\s\S]*?<\/item>/g) || []) {
          const rawSource = tag(b, "source") || "뉴스";
          const source = rawSource.split(" - ")[0].trim(); // "울산매일 - 울산최초, …" → "울산매일"
          let title = tag(b, "title");
          const at = title.lastIndexOf(" - " + rawSource);
          if (at > 0) title = title.slice(0, at).trim();
          const pub = tag(b, "pubDate");
          all.push({ title, link: tag(b, "link"), source, time: pub ? new Date(pub) : null });
        }
      } catch (e) {
        console.warn(`  ! 울산 뉴스(${q}): ${e.message}`);
      }
    })
  );
  const cutoff = Date.now() - 7 * 86400e3;
  const recent = all
    .filter((n) => n.title && n.link && n.time && !isNaN(n.time) && n.time.getTime() >= cutoff)
    .filter((n) => n.title.includes("울산") && ULSAN_RE.test(n.title) && !NOISE.test(n.title))
    .sort((a, b) => b.time - a.time);
  const kept = [];
  for (const n of recent) {
    const bg = bigrams(normTitle(n.title));
    const dup = kept.find((k) => similar(k._bg, bg) >= 0.6);
    if (dup) {
      if (!dup.sources.includes(n.source)) dup.sources.push(n.source);
      continue;
    }
    kept.push({ ...n, _bg: bg, sources: [n.source || "뉴스"] });
  }
  // 여러 언론이 다룬 기사 먼저, 그다음 최신순
  kept.sort((a, b) => b.sources.length - a.sources.length || b.time - a.time);
  return kept.slice(0, 8).map((n) => publicItem(n));
}

// ───────────────────────── 3-1. 울산 재개발·재건축 ─────────────────────────
// 공식 1: 토지이음(국토부) 고시정보에서 울산(selSggCd=31) 정비사업 고시 — 정비구역 지정·변경·해제, 사업시행·관리처분 인가 등
// 공식 2: 구청·군청 고시공고(e-민원 시스템) — 조합설립추진위원회 승인, 조합설립인가, 주민 공람 등 (토지이음에 잘 안 실림)
// 뉴스: 단계 변화 신호(조합설립인가, 시공사 선정 등)를 찾아 "확인 필요"로 표시 (자동 변경은 하지 않음)
// 구역 목록: config/ulsan-zones.json. 공식 고시에 더 늦은 단계가 나오면 자동으로 단계를 올림
// 알림: 목록에 없는 구역의 고시, 고시로 단계가 바뀐 구역, 새 기사 신호가 있으면 alerts에 담음 → 아침 실행에서 GitHub 메일
const EUM_LIST = "https://www.eum.go.kr/web/gs/gv/gvGosiList.jsp";
const EUM_DETAIL = "https://www.eum.go.kr/web/gs/gv/gvGosiDet.jsp?seq=";
const REDEV_KEYWORDS = ["재개발", "재건축", "정비구역", "조합", "추진위원회", "주택정비", "관리처분"];
const REDEV_RE = /재개발|재건축|정비구역|정비사업|정비계획|주택정비|조합설립|추진위원회|관리처분|주거환경개선|가로주택/;
const REDEV_NEWS_QUERIES = ["울산 재개발", "울산 재건축", "울산 재개발 조합", "울산 정비구역", "울산 가로주택정비"];
const REDEV_NEWS_EXCLUDE = /공장|현대차|백화점|발전소|화력|학교 재건축|청사|고양이|봉사|축제|공연/;

// 토지이음은 EUC-KR이라 검색어를 EUC-KR 퍼센트 인코딩으로 보냄
let eucKrMap = null;
function eucKrEncode(s) {
  if (!eucKrMap) {
    eucKrMap = new Map();
    const dec = new TextDecoder("euc-kr");
    for (let a = 0xb0; a <= 0xc8; a++)
      for (let b = 0xa1; b <= 0xfe; b++) eucKrMap.set(dec.decode(new Uint8Array([a, b])), [a, b]);
  }
  return [...s]
    .map((c) => (eucKrMap.has(c) ? eucKrMap.get(c).map((x) => "%" + x.toString(16).toUpperCase()).join("") : encodeURIComponent(c)))
    .join("");
}

// 구청·군청 e-민원 고시공고. 울주군은 https가 오래된 보안 설정이라 Node에서 접속이 안 돼 http 사용
const DISTRICTS = [
  { name: "중구", base: "https://eminwon.junggu.ulsan.kr" },
  { name: "남구", base: "https://eminwon.ulsannamgu.go.kr" },
  { name: "동구", base: "https://eminwon.donggu.ulsan.kr" },
  { name: "북구", base: "https://eminwon.bukgu.ulsan.kr" },
  { name: "울주군", base: "http://eminwon.ulju.ulsan.kr" },
];
const EMINWON_PATH = "/emwp/gov/mogaha/ntis/web/ofr/action/OfrAction.do";
const DISTRICT_KEYWORDS = ["조합설립", "추진위원회", "재개발", "재건축", "정비구역", "가로주택"];
// "정비사업"만으로는 하천·문화재 정비도 걸려서 주택 정비사업 표현만 받음
const DISTRICT_RE = /재개발|재건축|주택정비|정비구역|정비예정구역|가로주택|소규모주택|소규모재건축|조합설립|추진위원회|관리처분|주거환경/;
const DISTRICT_EXCLUDE = /지역주택조합|노동조합|교섭|하천|소하천|성\s*정비|문화재|공원|도로/;
const stripTags = (s) => decodeEntities(s.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();

async function fetchEminwon(d, keyword) {
  const body = new URLSearchParams({
    jndinm: "OfrNotAncmtEJB", context: "NTIS", method: "selectListOfrNotAncmt", methodnm: "selectListOfrNotAncmtHomepage",
    homepage_pbs_yn: "Y", subCheck: "Y", ofr_pageSize: "50", not_ancmt_se_code: "01,02,03,04,05", title: "고시공고",
    initValue: "Y", countYn: "Y", list_gubun: "A", not_ancmt_sj: keyword, pageIndex: "1",
  });
  const r = await fetchWithTimeout(d.base + EMINWON_PATH, {
    method: "POST",
    headers: { ...UA, "Content-Type": "application/x-www-form-urlencoded" },
    body,
  }, 30000);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const html = await r.text();
  const out = [];
  for (const m of html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
    const id = m[1].match(/searchDetail\('(\d+)'\)/)?.[1];
    if (!id) continue;
    const cells = [...m[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((c) => stripTags(c[1]));
    const date = cells.find((c) => /^\d{4}-\d{2}-\d{2}$/.test(c));
    const no = cells.find((c) => /제\s?\d{4}-\d+호/.test(c)) || "";
    const title = cells
      .filter((c) => c !== no && !/^\d+$/.test(c) && !/^\d{4}-\d{2}-\d{2}/.test(c))
      .sort((a, b) => b.length - a.length)[0];
    if (!date || !title) continue;
    out.push({
      date,
      no: no || `울산광역시 ${d.name}`,
      seq: `${d.name}-${id}`,
      title,
      link: `${d.base}${EMINWON_PATH}?jndinm=OfrNotAncmtEJB&context=NTIS&method=selectOfrNotAncmt&methodnm=selectOfrNotAncmtRegst&not_ancmt_mgt_no=${id}&homepage_pbs_yn=Y&subCheck=Y&not_ancmt_se_code=01,02,03,04,05&list_gubun=A`,
      src: `${d.name} 고시공고`,
    });
  }
  return out;
}

const compact = (s) => s.replace(/\s+/g, "");
function stageOf(title) {
  // 공람·신청·건의·의견청취는 아직 결정 전 단계 (단계로 치지 않고 목록·알림에만 씀)
  // "(안)"·"수립안"도 아직 확정 전 (제목이 잘려 "(안..."으로 끝나기도 함)
  if (/공람|신청|건의|의견\s*청취|\(안|수립\s*안/.test(title)) return null;
  if (/취소/.test(title)) return "취소";
  if (/해제/.test(title)) return "해제";
  if (/준공|공사완료/.test(title)) return "준공";
  if (/관리처분/.test(title)) return "관리처분";
  if (/사업시행(계획)?(\([^)]*\))?\s*인가/.test(title)) return "사업시행인가";
  if (/추진위원회/.test(title)) return "추진위"; // "조합설립추진위원회"가 조합설립보다 먼저 걸리도록
  if (/조합설립/.test(title)) return "조합설립";
  if (/정비구역|정비계획|관리계획\s*승인/.test(title)) return "구역지정";
  return null;
}

async function fetchEumNotices(keyword, startdt, enddt) {
  const url = `${EUM_LIST}?selSggCd=31&zonenm=${eucKrEncode(keyword)}&listSize=200&startdt=${startdt}&enddt=${enddt}`;
  const r = await fetchWithTimeout(url, { headers: UA }, 20000);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const html = new TextDecoder("euc-kr").decode(await r.arrayBuffer());
  const rows = [...html.matchAll(/<td class="mb">([\d-]+)<\/td>\s*<td class="left mb" title="([^"]*)">[\s\S]*?href='gvGosiDet\.jsp\?seq=(\d+)[^']*'\s*title='([^']*)'/g)];
  return rows.map((m) => ({ date: m[1], no: decodeEntities(m[2]), seq: m[3], title: decodeEntities(m[4]) }));
}

async function collectUlsanRedev(today) {
  const errors = [];
  let cfg;
  try {
    cfg = JSON.parse(await fs.readFile(path.join(ROOT, "config", "ulsan-zones.json"), "utf8"));
  } catch (e) {
    return { zones: [], notices: [], news: [], errors: [`구역 목록: ${e.message}`] };
  }
  const STAGES = cfg.stages;

  // 1) 토지이음 고시 (최근 2년)
  const raw = [];
  await Promise.all(
    REDEV_KEYWORDS.map(async (k) => {
      try {
        raw.push(...(await fetchEumNotices(k, addDays(today, -730), today)));
      } catch (e) {
        errors.push(`토지이음(${k}): ${e.message}`);
      }
    })
  );
  const seen = new Set();
  const notices = raw
    .filter((n) => REDEV_RE.test(n.title) && n.no.includes("울산"))
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
    .filter((n) => {
      const key = n.title.replace(/[^0-9A-Za-z가-힣]/g, "").replace(/지형도면|정정|고시|안$/g, "");
      if (seen.has(key)) return false; // 시청·구청이 같은 고시를 따로 올린 경우 하나만
      seen.add(key);
      return true;
    })
    .map((n) => ({ ...n, link: EUM_DETAIL + n.seq, stage: stageOf(n.title), src: "토지이음" }));

  // 1-2) 구청·군청 고시공고 (최근 2년) — 구청마다 순서대로, 검색어마다 한 번씩
  const districtFails = [];
  await Promise.all(
    DISTRICTS.map(async (d) => {
      let ok = 0;
      for (const k of DISTRICT_KEYWORDS) {
        try {
          // 남구 서버가 느릴 때가 있어 한 번 더 시도
          const rows = await fetchEminwon(d, k).catch(() => fetchEminwon(d, k));
          ok++;
          for (const n of rows) {
            if (n.date < addDays(today, -730) || !DISTRICT_RE.test(n.title) || DISTRICT_EXCLUDE.test(n.title)) continue;
            if (notices.some((x) => x.seq === n.seq)) continue;
            notices.push({ ...n, stage: stageOf(n.title) });
          }
        } catch (e) {
          errors.push(`${d.name} 고시공고(${k}): ${e.message}`);
        }
      }
      if (!ok) districtFails.push(d.name);
    })
  );
  notices.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));

  // 2) 재개발 뉴스 (최근 60일)
  const newsRaw = [];
  await Promise.all(
    REDEV_NEWS_QUERIES.map(async (q) => {
      try {
        const xml = await fetchText(`https://news.google.com/rss/search?q=${encodeURIComponent(q + " when:60d")}&hl=ko&gl=KR&ceid=KR:ko`);
        for (const b of xml.match(/<item[\s>][\s\S]*?<\/item>/g) || []) {
          const rawSource = tag(b, "source") || "뉴스";
          let title = tag(b, "title");
          const at = title.lastIndexOf(" - " + rawSource);
          if (at > 0) title = title.slice(0, at).trim();
          const pub = tag(b, "pubDate");
          newsRaw.push({ title, link: tag(b, "link"), source: rawSource.split(" - ")[0].trim(), time: pub ? new Date(pub) : null });
        }
      } catch (e) {
        errors.push(`재개발 뉴스(${q}): ${e.message}`);
      }
    })
  );
  const kept = [];
  for (const n of newsRaw
    .filter((n) => n.title && n.time && !isNaN(n.time) && n.time.getTime() >= Date.now() - 60 * 86400e3)
    .filter((n) => n.title.includes("울산") && REDEV_RE.test(n.title) && !REDEV_NEWS_EXCLUDE.test(n.title))
    .sort((a, b) => b.time - a.time)) {
    const bg = bigrams(normTitle(n.title));
    const dup = kept.find((k) => similar(k._bg, bg) >= 0.6);
    if (dup) {
      if (!dup.sources.includes(n.source)) dup.sources.push(n.source);
      continue;
    }
    kept.push({ ...n, _bg: bg, sources: [n.source] });
  }
  const NEWS_TAGS = [
    ["조합", /조합/],
    ["추진위", /추진위/],
    ["시공사", /시공사|시공자/],
    ["구역지정", /정비구역|구역\s*지정/],
    ["해제", /해제/],
    ["안전진단", /안전진단/],
  ];
  const news = kept.slice(0, 10).map((n) => ({
    ...publicItem(n),
    tags: NEWS_TAGS.filter(([, re]) => re.test(n.title)).map(([t]) => t),
  }));

  // 3) 구역 목록 + 고시로 단계 자동 갱신 + 관련 최신 기사
  const matches = (zone, title) => zone.aliases.some((a) => compact(title).includes(compact(a)));
  const matched = new Set();
  // ③ 기사 제목의 단계 변화 신호 — "추진·예정·입찰"처럼 아직 결정 전인 표현이 있으면 신호로 보지 않음
  const NEWS_SIGNALS = [
    ["준공", /준공/],
    ["착공", /착공/],
    ["관리처분", /관리처분\s*(계획)?\s*인가/],
    ["사업시행인가", /사업시행\s*(계획)?\s*인가/],
    ["시공사선정", /시공(사|자)\s*(로\s*)?(선정|확정)|시공권\s*(확보|획득)|수주/],
    ["조합설립", /조합\s*설립\s*인가|창립\s*총회|조합\s*(출범|설립)/],
    ["추진위", /추진위(원회)?\s*(승인|구성|출범)/],
    ["해제", /해제/],
  ];
  const NOT_YET = /추진|속도|앞두|예정|목표|계획|신청|착수|재도전|유력|눈독|입찰|현설|유찰|불발|가능성|검토|\?/;
  const newsSignal = (title) => {
    if (NOT_YET.test(title.replace(/추진위(원회)?/g, ""))) return null;
    return NEWS_SIGNALS.find(([, re]) => re.test(title))?.[0] || null;
  };

  const alerts = [];
  const recent = (d, days) => d >= addDays(today, -days);
  const zones = cfg.zones.map((z) => {
    const zone = { ...z };
    for (const n of notices) {
      if (!matches(z, n.title)) continue;
      matched.add(n.seq);
      if (n.stage === "해제" || n.stage === "취소") {
        if (!zone.date || n.date >= zone.date) {
          Object.assign(zone, { status: n.stage, date: n.date, src: "고시", link: n.link, auto: true });
          if (recent(n.date, 7)) alerts.push(`[${z.name}] ${n.stage} 고시: ${n.title} (${n.date})`);
        }
        continue;
      }
      const ni = STAGES.indexOf(n.stage), zi = STAGES.indexOf(zone.stage);
      if (ni >= 0 && (ni > zi || (ni === zi && n.date > (zone.date || "")))) {
        Object.assign(zone, { stage: n.stage, date: n.date, src: "고시", link: n.link, auto: true });
        if (ni > zi && recent(n.date, 7)) alerts.push(`[${z.name}] 고시로 단계 변경 → ${n.stage}: ${n.title} (${n.date})`);
      } else if (!zone.link && n.stage === zone.stage) {
        zone.link = n.link;
      }
    }
    const rel = news.find((n) => matches(z, n.title));
    if (rel) zone.latestNews = { title: rel.title, link: rel.link, time: rel.time };
    // 기사 신호: 지금 단계보다 늦은 단계를 말하는 기사가 있으면 "확인 필요"
    const zi = STAGES.indexOf(zone.stage);
    for (const n of news) {
      if (!matches(z, n.title)) continue;
      const s = newsSignal(n.title);
      if (!s) continue;
      const si = STAGES.indexOf(s);
      const later = s === "해제" ? zone.status !== "해제" : si > zi;
      if (!later) continue;
      zone.signal = { stage: s, title: n.title, link: n.link, time: n.time };
      if (new Date(n.time) >= new Date(Date.now() - 2 * 86400e3))
        alerts.push(`[${z.name}] 기사에 '${s}' 신호 — 확인 필요: ${n.title}`);
      break;
    }
    zone.stageIndex = STAGES.indexOf(zone.stage);
    delete zone.aliases;
    return zone;
  });
  // 목록에 없는 구역의 고시 = 새로 생긴 구역일 수 있음
  for (const n of notices) {
    n.unknownZone = !matched.has(n.seq);
    if (n.unknownZone && recent(n.date, 7)) alerts.push(`[새 구역?] ${n.no}: ${n.title} (${n.date}) ${n.link}`);
  }
  if (districtFails.length) errors.push(`구청 고시공고 확인 실패: ${districtFails.join(", ")}`);
  // 최근에 움직인 구역이 위로
  zones.sort((a, b) => (a.date < b.date ? 1 : -1));

  return { stages: STAGES, zones, notices: notices.slice(0, 10), news, alerts, districtFails, errors };
}

// 제목 키워드로 분야 다시 나누기 (위에서부터 먼저 맞는 분야). 안 맞으면 피드 분류 유지
const CAT_RULES = [
  ["realestate", /집값|아파트|전세|월세|분양|재건축|재개발|부동산|청약|주택|빌딩 거래|오피스텔/],
  ["macro", /금리|환율|원[·\/]달러|물가|한은|한국은행|금통위|재경부|기재부|성장률|GDP|수출|수입|무역수지|경상수지|고용|실업|국채|가계부채|가계대출|세수|예산|추경|소비자심리/],
  ["market", /코스피|코스닥|증시|주가|특징주|상장|공모주|IPO|ETF|증권|공매도|시총|외국인 ?(순매수|순매도|매수|매도)|개미|밸류업/],
  ["global", /美|미국|中|중국|日|일본|EU|유럽|연준|Fed|트럼프|월가|뉴욕증시|나스닥|S&P|다우|엔비디아|애플|테슬라/],
  ["industry", /반도체|삼성|SK|현대|LG|롯데|한화|포스코|배터리|2차전지|조선|자동차|실적|영업이익|매출|AI|바이오|철강|항공|플랫폼|유통|통신/],
];
function classify(title, feedCat) {
  for (const [cat, re] of CAT_RULES) if (re.test(title)) return cat;
  return feedCat;
}

// 경제적으로 중요한 단어 (가중치)
const KW = [
  [3, /기준금리|금리|환율|원[·\/]달러|코스피|코스닥|나스닥|S&P|다우|연준|Fed|FOMC|금통위|한은|한국은행|물가|CPI|인플레|국채|유가|관세|수출|성장률|GDP|고용|실업/],
  [2, /증시|주가|반도체|삼성전자|SK하이닉스|엔비디아|실적|영업이익|집값|아파트|전세|부동산|대출|가계부채|재경부|기재부|금융위|금감원|달러|엔화|위안|비트코인|트럼프|무역|외국인|공매도|상장|배당|적자|흑자|어닝/],
];
// 지역·홍보성 기사 감점
const LOCAL_TITLE = /^[가-힣]{2,5}(시|군|구|도|교육청|재단|공사|농협|농기원)[,·\s'"‘“]/;
const PR_WORDS = /어워즈|수상|봉사|나눔|훈훈|ESG|기부|후원|협약|MOU|캠페인|개최|개막|워크숍|간담회|공모 ?선정|선정돼|기념식|발대식|위촉|신설법인|인사\b/;

function scoreNews(n) {
  let s = 0;
  if (n.sources.length > 1) s += (n.sources.length - 1) * 4; // 여러 언론사가 다룸
  if (n.dupCount > 1) s += 1;
  for (const [w, re] of KW) if (re.test(n.title)) s += w;
  if (/\(종합\d?\)/.test(n.title)) s += 1;
  const dateline = n.lead.match(/\(([가-힣]+)=연합뉴스\)/);
  if (dateline && dateline[1] !== "서울") s -= 4;
  if (LOCAL_TITLE.test(n.title)) s -= 3;
  if (PR_WORDS.test(n.title)) s -= 2;
  return s;
}

// ───────────────────────── 3. 일정 ─────────────────────────
async function loadEvents(today) {
  try {
    const cfg = JSON.parse(await fs.readFile(path.join(ROOT, "config", "events.json"), "utf8"));
    const until = addDays(today, 14);
    return cfg.events
      .filter((e) => e.date >= today && e.date <= until)
      .map((e) => ({ ...e, from: "calendar" }));
  } catch {
    return [];
  }
}

// ───────────────────────── 4. 기사 고르기 (규칙) ─────────────────────────
// 포토·부고·인사·운세 등 정보가 적은 기사 제외
const NOISE = /\[(포토|사진|화보|부고|인사|게시판|오늘의 ?운세|운세|날씨|알림|카드뉴스|영상|그래픽|표|모닝 ?브리핑|오늘의 ?일정|주요 ?뉴스)\]|이 ?시각 ?헤드라인|^\s*\(?(포토|사진)\)?\s|부고|별세|대입수능 D-|로또/;

// 정렬: 점수(scoreNews) → 다룬 언론사 수 → 최신 순
const byScore = (a, b) => b.score - a.score || b.sources.length - a.sources.length || b.time - a.time;
const MIN_SCORE = 2; // 이보다 낮으면 경제 기사로 보기 어려움

// 같은 주제 판별: 제목 단어가 2개 이상 겹치거나, 같은 핵심 지표 단어를 다루면 같은 주제로 봄
const STOP = new Set(["종합", "속보", "단독", "특징주", "기준", "올해", "내년", "작년", "오늘", "이번", "전년", "대비", "만에", "위해", "관련"]);
const TOPIC_TERMS = /환율|코스피|코스닥|국채|유가|금통위|연준|FOMC|기준금리|집값|전셋값|비트코인/g;
const words = (t) => new Set(t.replace(/\[[^\]]*\]/g, " ").split(/[^0-9a-zA-Z가-힣]+/).filter((w) => w.length >= 2 && !STOP.has(w)));
function sameTopic(a, b) {
  const ta = new Set(a.title.match(TOPIC_TERMS) || []);
  for (const t of b.title.match(TOPIC_TERMS) || []) if (ta.has(t)) return true;
  const wa = words(a.title);
  let n = 0;
  for (const w of words(b.title)) if (wa.has(w) && ++n >= 2) return true;
  return false;
}
function pickDiverse(list, n) {
  const out = [];
  for (const x of list) {
    if (out.length >= n) break;
    if (!out.some((y) => sameTopic(x, y))) out.push(x);
  }
  return out;
}

const usable = (news) => news.filter((x) => !NOISE.test(x.title) && x.score >= MIN_SCORE).sort(byScore);

function pickTop(news, n = 3) {
  return pickDiverse(usable(news), n).map(publicItem);
}

function pickSections(news, perSection = 5) {
  const clean = usable(news);
  return SECTIONS.map((s) => ({
    key: s.key,
    name: s.name,
    items: pickDiverse(clean.filter((x) => x.cat === s.key), perSection).map(publicItem),
  }));
}

function publicItem(n) {
  // 저작권: 제목·링크·언론사·시각만 저장. 기사 본문/발췌는 저장하지 않음.
  return {
    title: n.title,
    link: n.link,
    source: n.sources.join(" · "),
    outlets: n.sources.length,
    time: n.time.toISOString(),
  };
}

// ───────────────────────── 실행 ─────────────────────────
// 장중 갱신: 오늘 브리핑이 이미 있으면 지표만 새로 받아 바꿔 끼움 (뉴스·일정은 아침 것 유지)
// 자정~아침 브리핑 전(미국장 시간)에는 오늘 파일이 없으므로 가장 최근 브리핑(latest)의 지표를 갱신
async function updateIndicatorsOnly(today) {
  let brief;
  try {
    brief = JSON.parse(await fs.readFile(path.join(DATA_DIR, `${today}.json`), "utf8"));
  } catch {
    try {
      brief = JSON.parse(await fs.readFile(path.join(DATA_DIR, "latest.json"), "utf8"));
    } catch {
      return false; // 브리핑이 하나도 없음 → 전체 수집
    }
  }
  const file = path.join(DATA_DIR, `${brief.date}.json`);
  const ind = await collectIndicators();
  ind.errors.forEach((w) => console.warn("  ! " + w));
  // 일부 지표를 못 받았으면 아침 값 유지
  const fresh = new Map(ind.list.map((i) => [i.id, i]));
  brief.indicators = brief.indicators.map((i) => fresh.get(i.id) || i);
  for (const i of ind.list) if (!brief.indicators.some((x) => x.id === i.id)) brief.indicators.push(i);
  markStale(brief.indicators, ind.refs);
  brief.indicatorsAt = new Date().toISOString();
  const json = JSON.stringify(brief, null, 1);
  await fs.writeFile(file, json);
  await fs.writeFile(path.join(DATA_DIR, "latest.json"), json);
  console.log(`[브리핑] ${brief.date} 지표만 갱신 (${ind.list.length}개)`);
  return true;
}

async function main() {
  const today = kstDate();
  if (process.argv.includes("--indicators-only") && (await updateIndicatorsOnly(today))) return;
  console.log(`[브리핑] ${today} 수집 시작`);

  const [ind, news, events, ulsanStats, ulsanNews, redev] = await Promise.all([
    collectIndicators(),
    collectNews(),
    loadEvents(today),
    collectUlsanStats(),
    collectUlsanNews(),
    collectUlsanRedev(today),
  ]);
  console.log(`  울산 부동산 통계 ${ulsanStats.length}개, 뉴스 ${ulsanNews.length}건`);
  console.log(`  울산 재개발 구역 ${redev.zones.length}곳, 고시 ${redev.notices.length}건, 뉴스 ${redev.news.length}건`);
  redev.errors.forEach((w) => console.warn("  ! " + w));
  console.log(`  지표 ${ind.list.length}개, 뉴스 ${news.items.length}건(중복 제거 후), 일정 ${events.length}건`);
  const warnings = [...ind.errors, ...news.errors];
  warnings.forEach((w) => console.warn("  ! " + w));

  const dow = new Date(today + "T00:00:00Z").getUTCDay();
  const notes = [];
  if (dow === 0 || dow === 6) notes.push("주말 휴장 — 지표는 직전 거래일 기준입니다.");

  const brief = {
    date: today,
    weekday: weekdayOf(today),
    generatedAt: new Date().toISOString(),
    indicatorsAt: new Date().toISOString(),
    top: pickTop(news.items),
    indicators: ind.list,
    sections: pickSections(news.items),
    ulsan: {
      stats: ulsanStats,
      news: ulsanNews,
      redev: {
        stages: redev.stages,
        zones: redev.zones,
        notices: redev.notices,
        news: redev.news,
        districtFails: redev.districtFails,
      },
    },
    events,
    notes,
    warnings,
  };

  await fs.mkdir(DATA_DIR, { recursive: true });
  // ④ 재개발 알림 — 아침 실행(Actions)이 읽어서 새 알림이 있으면 실패 처리 → GitHub가 메일로 알림
  // 같은 알림이 매일 반복되지 않도록 이미 알린 것은 seen에 기록 (아침 실행 때 저장소에 커밋되어 유지)
  const alertFile = path.join(DATA_DIR, "redev-alerts.json");
  let seen = [];
  try {
    seen = JSON.parse(await fs.readFile(alertFile, "utf8")).seen || [];
  } catch {}
  const alertKey = (a) => a.replace(/\s*https?:\/\/\S+$/, "");
  const fresh = redev.alerts.filter((a) => !seen.includes(alertKey(a)));
  await fs.writeFile(
    alertFile,
    JSON.stringify(
      { date: today, alerts: fresh, districtFails: redev.districtFails, seen: [...seen, ...fresh.map(alertKey)].slice(-500) },
      null,
      1
    )
  );
  fresh.forEach((a) => console.log("  🔔 " + a));
  const json = JSON.stringify(brief, null, 1);
  await fs.writeFile(path.join(DATA_DIR, `${today}.json`), json);
  await fs.writeFile(path.join(DATA_DIR, "latest.json"), json);

  // 지난 날짜 목록 (최근 60일) + 오래된 파일 정리
  const files = (await fs.readdir(DATA_DIR)).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort().reverse();
  const keep = files.slice(0, HISTORY_DAYS);
  for (const f of files.slice(HISTORY_DAYS)) await fs.unlink(path.join(DATA_DIR, f));
  await fs.writeFile(path.join(DATA_DIR, "index.json"), JSON.stringify({ dates: keep.map((f) => f.slice(0, 10)) }));

  console.log(`[브리핑] 저장 완료 → public/data/${today}.json`);
}


main().catch((e) => {
  console.error(e);
  process.exit(1);
});
