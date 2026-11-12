// 아침 경제 브리핑 수집기
// 1) 시장 지표(야후 파이낸스 + 한국은행 ECOS) 2) 뉴스 RSS 3) 일정 → public/data/*.json
// AI 없이 규칙으로 기사를 고름: 여러 언론사가 같이 다룬 기사 우선, 포토·부고·인사 등은 제외
//
// 사용법: node scripts/collect.mjs
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
  for (let i = 0; i < ts.length; i++) {
    if (closes[i] == null) continue;
    series.push({ date: kstDate(new Date(ts[i] * 1000)), value: closes[i] * scale });
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

async function collectIndicators() {
  const out = [];
  const errors = [];
  await Promise.all([
    ...YAHOO.map(async (def) => {
      try {
        const { points, asOf } = await fetchYahoo(def);
        out.push(buildIndicator(def, points, asOf));
      } catch (e) {
        errors.push(`${def.name}: ${e.message}`);
      }
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
  return { list: out, errors };
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
const NOISE = /\[(포토|사진|화보|부고|인사|게시판|오늘의 ?운세|운세|날씨|알림|카드뉴스|영상|그래픽|표|모닝 ?브리핑|오늘의 ?일정)\]|^\s*\(?(포토|사진)\)?\s|부고|별세|대입수능 D-|로또/;

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
async function main() {
  const today = kstDate();
  console.log(`[브리핑] ${today} 수집 시작`);

  const [ind, news, events] = await Promise.all([collectIndicators(), collectNews(), loadEvents(today)]);
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
    top: pickTop(news.items),
    indicators: ind.list,
    sections: pickSections(news.items),
    events,
    notes,
    warnings,
  };

  await fs.mkdir(DATA_DIR, { recursive: true });
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
