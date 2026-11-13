"use strict";

const $ = (id) => document.getElementById(id);
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const WEEK = ["일", "월", "화", "수", "목", "금", "토"];
const fmtDateTitle = (d) => {
  const [y, m, day] = d.split("-").map(Number);
  const w = WEEK[new Date(Date.UTC(y, m - 1, day)).getUTCDay()];
  return `${m}월 ${day}일 (${w})`;
};
const shortDate = (d) => {
  const [, m, day] = d.split("-").map(Number);
  return `${m}/${day}`;
};
const timeAgo = (iso) => {
  const t = new Date(iso);
  const h = t.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Seoul" });
  const d = t.toLocaleDateString("ko-KR", { month: "numeric", day: "numeric", timeZone: "Asia/Seoul" });
  return `${d} ${h}`;
};
const num = (v, digits) =>
  v.toLocaleString("ko-KR", { minimumFractionDigits: digits, maximumFractionDigits: digits });

let state = { brief: null, tab: null };

function dir(v) {
  if (Math.abs(v) < 1e-9) return "flat";
  return v > 0 ? "up" : "down";
}

function sparkSvg(values, cls) {
  if (!values || values.length < 2) return "";
  const w = 64, h = 26, p = 2;
  const min = Math.min(...values), max = Math.max(...values);
  const span = max - min || 1;
  const pts = values.map((v, i) => {
    const x = p + (i * (w - 2 * p)) / (values.length - 1);
    const y = h - p - ((v - min) / span) * (h - 2 * p);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const last = pts[pts.length - 1].split(",");
  return `<svg class="spark ${cls}" viewBox="0 0 ${w} ${h}" aria-hidden="true">
    <polyline points="${pts.join(" ")}" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"/>
    <circle cx="${last[0]}" cy="${last[1]}" r="2.2" fill="currentColor"/></svg>`;
}

function changeText(i) {
  const arrow = i.change > 0 ? "▲" : i.change < 0 ? "▼" : "–";
  if (i.id === "baserate") {
    if (i.lastChange) {
      const c = i.lastChange.change * 100;
      return `최근 변경 ${shortDate(i.lastChange.date)} ${c > 0 ? "+" : ""}${c.toFixed(0)}bp`;
    }
    return "변동 없음";
  }
  if (i.isRate) {
    const bp = i.change * 100;
    return `${arrow} ${Math.abs(bp).toFixed(1)}bp`;
  }
  const abs = Math.abs(i.change);
  const absTxt = i.unit === "원" ? `${num(abs, 1)}원 ` : "";
  return `${arrow} ${absTxt}${Math.abs(i.pct).toFixed(2)}%`;
}

function alertReason(i) {
  if (!i.alert) return "";
  if (i.id === "vix" && i.value >= 20) return "불안 구간";
  if (i.id === "baserate") return "금리 변경";
  return "큰 변동";
}

function indCard(i) {
  const d = dir(i.change);
  const unitPrefix = i.unit === "$" ? "$" : "";
  const unitSuffix = i.unit && i.unit !== "$" ? `<span class="u">${esc(i.unit)}</span>` : "";
  const flag = alertReason(i);
  // 지연: 같은 시장의 더 최신 거래일 값이 있는데 이 지표만 못 받은 경우
  const staleFlag = i.stale
    ? `<span class="flag stale" title="${i.latestDate ? `최신 거래일 ${shortDate(i.latestDate)} 값을 아직 못 받음` : "최근 값을 못 받음"}">⚠ 지연</span>`
    : "";
  const meta = `${shortDate(i.date)} 기준${i.latestDate ? ` (최신 ${shortDate(i.latestDate)})` : ""}${i.src ? ` · ${esc(i.src)}` : ""}`;
  return `<div class="ind ${i.alert ? "alert" : ""}">
    <div class="name"><span>${esc(i.name)}</span>${staleFlag || (flag ? `<span class="flag">● ${flag}</span>` : "")}</div>
    <div class="val">${unitPrefix}${num(i.value, i.digits)}${unitSuffix}</div>
    <div class="row">
      <div><div class="chg ${i.id === "baserate" ? "flat" : d}">${changeText(i)}</div>
      <div class="meta">${meta}</div></div>
      ${sparkSvg(i.spark, i.id === "baserate" ? "flat" : d)}
    </div>
  </div>`;
}

function renderIndicators(list) {
  const primary = list.filter((i) => i.group === "primary");
  const more = list.filter((i) => i.group === "more");
  $("ind-primary").innerHTML = primary.map(indCard).join("") || `<p class="empty">지표를 불러오지 못했습니다.</p>`;
  $("ind-more").innerHTML = more.map(indCard).join("");
  $("more-wrap").hidden = !more.length;
  const moreAlerts = more.filter((i) => i.alert).length;
  $("more-wrap").querySelector("summary").textContent =
    `지표 더보기 (${more.length})` + (moreAlerts ? ` · 큰 변동 ${moreAlerts}` : "");
}

function newsMeta(n) {
  return `<span>${esc(n.source)}</span><span>${timeAgo(n.time)}</span>${
    n.outlets > 1 ? `<span class="dup">${n.outlets}개 언론 보도</span>` : ""
  }`;
}

function renderTop(top) {
  $("top-card").hidden = !top?.length;
  $("top").innerHTML = (top || [])
    .map(
      (n) => `<li><a href="${esc(n.link)}" target="_blank" rel="noopener noreferrer">
        <span class="tt">${esc(n.title)}</span>
        <span class="m">${newsMeta(n)}</span></a></li>`
    )
    .join("");
}

function renderTabs(sections) {
  const withItems = sections.filter((s) => s.items.length);
  if (!state.tab || !withItems.some((s) => s.key === state.tab)) state.tab = withItems[0]?.key;
  $("tabs").innerHTML = sections
    .map(
      (s) =>
        `<button class="tab" role="tab" data-key="${s.key}" aria-selected="${s.key === state.tab}">${esc(s.name)}</button>`
    )
    .join("");
  $("tabs").querySelectorAll(".tab").forEach((b) =>
    b.addEventListener("click", () => {
      state.tab = b.dataset.key;
      try { localStorage.setItem("brief.tab", state.tab); } catch {}
      renderTabs(sections);
    })
  );
  const sec = sections.find((s) => s.key === state.tab);
  $("news").innerHTML = sec?.items.length
    ? sec.items
        .map(
          (n) => `<li><a href="${esc(n.link)}" target="_blank" rel="noopener noreferrer">
        <div class="t">${esc(n.title)}</div>
        <div class="m">${newsMeta(n)}</div></a></li>`
        )
        .join("")
    : `<li class="empty">이 분야 기사가 없습니다.</li>`;
}

function renderEvents(events, date) {
  const todays = events.filter((e) => e.date === date);
  $("today-events").hidden = !todays.length;
  $("today-events").innerHTML = todays.map((e) => `<span class="badge">오늘 · ${esc(e.title)}</span>`).join("");

  $("events-sec").hidden = !events.length;
  $("events").innerHTML = events
    .map((e) => {
      const [y, m, d] = e.date.split("-").map(Number);
      const w = WEEK[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
      return `<li class="${e.date === date ? "today" : ""}">
        <div class="d">${m}/${d}<small>${w}요일</small></div>
        <div>${esc(e.title)} <span class="src">${e.country ? esc(e.country) + " · " : ""}${e.from === "news" ? "기사 기준" : "공식 일정"}</span></div>
      </li>`;
    })
    .join("");
}

const fmtMonth = (m) => `${m.slice(0, 4)}년 ${Number(m.slice(4))}월`;
const signed = (v, d = 2) => `${v > 0 ? "+" : ""}${v.toFixed(d)}`;

const monthName = (m) => `${Number(m.slice(4))}월`;
const prevMonthOf = (m) => {
  const y = Number(m.slice(0, 4)), mo = Number(m.slice(4));
  return mo === 1 ? `${y - 1}12` : `${y}${String(mo - 1).padStart(2, "0")}`;
};
// "2026.06=100" → "2026년 6월 = 100"
const baseText = (unit) => {
  const m = /^(\d{4})\.(\d{2})=100$/.exec(unit || "");
  return m ? `${m[1]}년 ${Number(m[2])}월 = 100` : unit || "";
};

function ulsanCard(s) {
  const cur = monthName(s.month);
  const prev = monthName(s.prevMonth || prevMonthOf(s.month));
  let name, main, chg, d, lines;
  if (s.kind === "index") {
    d = dir(s.mom);
    name = "울산 아파트값 (실거래가지수)";
    main = `${num(s.value, 1)}${s.unit ? `<span class="u">${esc(baseText(s.unit))}</span>` : ""}`;
    chg = `${prev}보다 ${signed(s.mom)}%`;
    lines = [
      s.yoy != null ? `1년 전보다 ${signed(s.yoy, 1)}%` : "",
      s.nationMom != null ? `전국은 ${prev}보다 ${signed(s.nationMom)}%` : "",
    ];
  } else {
    d = dir(s.value);
    name = `울산 땅값 상승률 (${cur} 한 달)`;
    main = `${signed(s.value, 3)}<span class="u">%</span>`;
    chg = `${prev} 한 달은 ${signed(s.prev, 3)}%`;
    lines = [s.nation != null ? `전국은 ${cur} 한 달 ${signed(s.nation, 3)}%` : ""];
  }
  return `<div class="ind">
    <div class="name"><span>${esc(name)}</span><span class="muted">${fmtMonth(s.month)} 기준</span></div>
    <div class="val">${main}</div>
    <div class="row">
      <div><div class="chg ${s.kind === "index" ? d : "flat"}">${chg}</div>
      <div class="meta">${lines.filter(Boolean).join(" · ")}</div></div>
      ${sparkSvg(s.spark, d)}
    </div>
  </div>`;
}

const fmtDay = (d) => (d ? d.replaceAll("-", ".") : "");

function zoneRow(z, stages) {
  const idx = z.stageIndex ?? stages.indexOf(z.stage);
  const off = z.status === "해제" || z.status === "해제 추진" || z.status === "지연" || z.status === "표류";
  const steps = stages
    .map((s, i) => `<i class="${i < idx ? "on" : i === idx ? "cur" : ""}" title="${esc(s)}"></i>`)
    .join("");
  const stageTxt = z.stage ? `${esc(z.stage)} (${idx + 1}/${stages.length})` : "초기 추진";
  const srcTxt = z.link
    ? `<a href="${esc(z.link)}" target="_blank" rel="noopener noreferrer">${esc(z.src)}</a>`
    : esc(z.src || "");
  return `<li>
    <div class="z-top"><b>${esc(z.name)}</b><span class="pill">${esc(z.type)}</span>${
      z.status ? `<span class="pill warn">${esc(z.status)}</span>` : ""
    }${z.auto ? `<span class="pill auto">고시로 갱신</span>` : ""}</div>
    <div class="z-steps ${off ? "off" : ""}" aria-label="진행 단계 ${stageTxt}">${steps}</div>
    <div class="z-meta"><strong>${stageTxt}</strong> · ${fmtDay(z.date)} ${srcTxt} 기준${z.note ? " · " + esc(z.note) : ""}</div>
    ${z.latestNews ? `<a class="z-news" href="${esc(z.latestNews.link)}" target="_blank" rel="noopener noreferrer">${esc(z.latestNews.title)}</a>` : ""}
  </li>`;
}

function renderRedev(r) {
  // 정상 진행 중인 구역(최근 움직인 순) → 초기 추진 → 지연·해제
  const rank = (z) => (/해제|지연|표류/.test(z.status || "") ? 2 : z.stage ? 0 : 1);
  const zones = [...(r?.zones || [])].sort((a, b) => rank(a) - rank(b) || (a.date < b.date ? 1 : -1));
  $("redev").hidden = !zones.length && !r?.notices?.length && !r?.news?.length;
  if ($("redev").hidden) return;
  const stages = r.stages || [];
  const SHOW = 8;
  $("redev-zones").innerHTML = zones.slice(0, SHOW).map((z) => zoneRow(z, stages)).join("");
  $("redev-more").hidden = zones.length <= SHOW;
  $("redev-more").querySelector("summary").textContent = `구역 더보기 (${zones.length - SHOW})`;
  $("redev-zones-more").innerHTML = zones.slice(SHOW).map((z) => zoneRow(z, stages)).join("");

  $("redev-notices").innerHTML = (r.notices || []).length
    ? r.notices
        .map(
          (n) => `<li><a href="${esc(n.link)}" target="_blank" rel="noopener noreferrer">
        <div class="t">${esc(n.title)}</div>
        <div class="m"><span>${esc(n.no)}</span><span>${fmtDay(n.date)}</span>${
            n.stage ? `<span class="tag">${esc(n.stage)}</span>` : ""
          }${n.unknownZone ? `<span class="new-zone">목록에 없는 구역</span>` : ""}</div></a></li>`
        )
        .join("")
    : `<li class="empty">최근 고시가 없습니다.</li>`;

  $("redev-news").innerHTML = (r.news || []).length
    ? r.news
        .map(
          (n) => `<li><a href="${esc(n.link)}" target="_blank" rel="noopener noreferrer">
        <div class="t">${esc(n.title)}</div>
        <div class="m">${newsMeta(n)}${(n.tags || []).map((t) => `<span class="tag">#${esc(t)}</span>`).join("")}</div></a></li>`
        )
        .join("")
    : `<li class="empty">최근 60일 재개발·재건축 기사가 없습니다.</li>`;
}

function renderUlsan(u) {
  renderRedev(u?.redev);
  const stats = u?.stats || [], news = u?.news || [];
  $("ulsan-sec").hidden = !stats.length && !news.length;
  $("ulsan-stats").innerHTML = stats.map(ulsanCard).join("");
  $("ulsan-news").innerHTML = news.length
    ? news
        .map(
          (n) => `<li><a href="${esc(n.link)}" target="_blank" rel="noopener noreferrer">
        <div class="t">${esc(n.title)}</div>
        <div class="m">${newsMeta(n)}</div></a></li>`
        )
        .join("")
    : `<li class="empty">최근 7일 울산 부동산 기사가 없습니다.</li>`;
}

function render(b) {
  state.brief = b;
  $("date-title").textContent = fmtDateTitle(b.date);
  document.title = `경제 브리핑 · ${fmtDateTitle(b.date)}`;

  const notes = [...(b.notes || [])];
  const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
  if (b.date !== today && $("date-select").value === "latest")
    notes.unshift(`오늘(${fmtDateTitle(today)}) 브리핑이 아직 없어 ${fmtDateTitle(b.date)} 브리핑을 보여줍니다.`);
  const ec = state.eventsCheck;
  if (ec && ec.diffs?.length)
    notes.push(`일정 점검(${timeAgo(ec.checkedAt)}): 공식 일정표와 다른 날짜가 있어 아래 일정이 틀릴 수 있습니다 — ${ec.diffs.join(" / ")}`);
  $("notes").innerHTML = notes.map((n) => `<div class="note">${esc(n)}</div>`).join("");

  renderTop(b.top);
  renderIndicators(b.indicators || []);
  const indAt = b.indicatorsAt || b.generatedAt;
  $("ind-time").textContent = `${timeAgo(indAt)} 갱신 · 전일 대비`;
  renderTabs(b.sections || []);
  renderUlsan(b.ulsan);
  renderEvents(b.events || [], b.date);

  $("foot").innerHTML = `
    <p>뉴스 ${timeAgo(b.generatedAt)} 기준 · 지표 ${timeAgo(b.indicatorsAt || b.generatedAt)} 기준 (장중 30분~1시간마다 갱신, 시세는 15~20분 지연될 수 있음)</p>
    <p>지표: Yahoo Finance, 한국은행 ECOS (야후 값이 비거나 늦으면 한국은행·미 재무부·Cboe 공식 값으로 대체, ⚠ 지연 = 최신 거래일 값을 못 받음) · 일정: 한국은행·연준 공식 일정표 · 울산 부동산: 한국은행 ECOS(국토부 실거래가지수·지가변동률, 2~3개월 늦게 공표), Google 뉴스 검색 · 관심종목: Yahoo Finance(국내 약 20분 지연, 이 기기에만 저장) · 뉴스: 연합뉴스, 한국경제, 매일경제, 이데일리 RSS. 기사 저작권은 각 언론사에 있으며 제목을 누르면 원문으로 이동합니다.</p>
    <p>기사는 경제 키워드와 여러 언론사 보도 여부로 자동 선별했습니다. 투자 판단 전 원문과 공식 자료를 확인하세요.</p>`;
}

async function getJson(url) {
  const r = await fetch(url, { cache: "no-cache" });
  if (!r.ok) throw new Error(`${url} ${r.status}`);
  return r.json();
}

async function load(which = "latest") {
  $("ind-primary").innerHTML = '<div class="skeleton"></div>'.repeat(4);
  try {
    const [b, ec] = await Promise.all([getJson(`data/${which}.json`), getJson("data/events-check.json").catch(() => null)]);
    state.eventsCheck = ec;
    render(b);
  } catch (e) {
    $("date-title").textContent = "브리핑을 불러오지 못했습니다";
    $("ind-primary").innerHTML = "";
    $("notes").innerHTML = `<div class="note">데이터가 아직 없거나 네트워크 오류입니다. (${esc(e.message)})</div>`;
  }
}

async function initDates() {
  try {
    const { dates } = await getJson("data/index.json");
    $("date-select").innerHTML =
      `<option value="latest">최신</option>` +
      dates.map((d) => `<option value="${d}">${fmtDateTitle(d)}</option>`).join("");
  } catch {
    $("date-select").innerHTML = `<option value="latest">최신</option>`;
  }
}

// ───────────────────────── 관심종목 (앱을 열 때마다 최신 시세) ─────────────────────────
// 목록은 이 기기의 localStorage에만 저장 (공개 사이트·저장소에는 남기지 않음)
// 처음 설정: 주소 뒤에 #stocks=005930:삼성전자,AAPL:애플 을 붙여 열면 저장 후 주소에서 지움
const QUOTE_API = "https://econ-quotes.kimjungsoo0127.workers.dev/quote";
const STOCK_KEY = "brief.stocks";
// 이름을 안 적었을 때 쓰는 한글 이름 (자주 찾는 종목)
const KNOWN_NAMES = {
  "005930": "삼성전자", "000660": "SK하이닉스", "373220": "LG에너지솔루션", "005380": "현대차", "000270": "기아",
  "035420": "NAVER", "035720": "카카오", "207940": "삼성바이오로직스", "068270": "셀트리온", "005490": "POSCO홀딩스",
  "009540": "HD한국조선해양", "012450": "한화에어로스페이스", "010130": "고려아연",
  AAPL: "애플", MSFT: "마이크로소프트", NVDA: "엔비디아", GOOGL: "알파벳", AMZN: "아마존", META: "메타", TSLA: "테슬라",
  TTWO: "테이크투", SONY: "소니", AVGO: "브로드컴", TSM: "TSMC", NFLX: "넷플릭스", AMD: "AMD", QQQ: "QQQ", SPY: "SPY",
};
const baseCode = (s) => s.replace(/\.(KS|KQ)$/, "");

function loadStocks() {
  try {
    const v = JSON.parse(localStorage.getItem(STOCK_KEY) || "[]");
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}
function saveStocks(list) {
  try { localStorage.setItem(STOCK_KEY, JSON.stringify(list)); } catch {}
}
// "005930 삼성전자" / "AAPL" / "005930:삼성전자" → { s, name }
function parseStockLines(text) {
  return text
    .split(/[\n,]+/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [code, ...rest] = l.split(/[\s:]+/);
      return { s: code.toUpperCase(), name: rest.join(" ").trim() };
    })
    .filter((x) => /^[A-Z0-9.^=-]{1,15}$/.test(x.s))
    .slice(0, 20);
}
function importStocksFromHash() {
  const m = location.hash.match(/stocks=([^&]+)/);
  if (!m) return;
  const list = parseStockLines(decodeURIComponent(m[1]));
  if (list.length) saveStocks(list);
  history.replaceState(null, "", location.pathname + location.search);
}

const fmtPrice = (q) =>
  q.currency === "KRW" ? `${num(q.price, 0)}원` : `${q.currency === "USD" ? "$" : ""}${num(q.price, 2)}${q.currency !== "USD" ? " " + q.currency : ""}`;

function stockRow(item, q) {
  const name = item.name || KNOWN_NAMES[baseCode(item.s)] || q?.name || item.s;
  if (!q || q.error) {
    return `<li><div><div class="nm">${esc(name)}</div><div class="sub">${esc(item.s)} · 시세를 찾지 못함</div></div><div></div><div></div></li>`;
  }
  const d = q.change == null ? "flat" : dir(q.change);
  const arrow = d === "up" ? "▲" : d === "down" ? "▼" : "–";
  const pct = q.pct == null ? "" : `${arrow} ${Math.abs(q.pct).toFixed(2)}%`;
  return `<li>
    <div><div class="nm">${esc(name)}</div><div class="sub">${esc(baseCode(q.symbol))} · ${q.time ? timeAgo(q.time) : ""}</div></div>
    <div class="px"><b>${fmtPrice(q)}</b><span class="${d}">${pct}</span></div>
    ${sparkSvg(q.spark, d)}
  </li>`;
}

let stockReq = 0;
async function loadQuotes() {
  const list = loadStocks();
  if (!list.length) {
    $("my-list").innerHTML = `<li class="empty">편집을 눌러 관심종목을 추가하세요.</li>`;
    $("my-time").textContent = "";
    return;
  }
  const req = ++stockReq;
  if (!$("my-list").children.length || $("my-list").querySelector(".empty"))
    $("my-list").innerHTML = list.map((x) => `<li class="empty">${esc(x.name || x.s)} 불러오는 중…</li>`).join("");
  try {
    const r = await fetch(`${QUOTE_API}?s=${encodeURIComponent(list.map((x) => x.s).join(","))}`, { cache: "no-store" });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const { at, quotes } = await r.json();
    if (req !== stockReq) return;
    $("my-list").innerHTML = list.map((x, i) => stockRow(x, quotes[i])).join("");
    $("my-time").textContent = `${timeAgo(at)} 조회 · 전일 대비`;
  } catch (e) {
    if (req !== stockReq) return;
    $("my-list").innerHTML = `<li class="err">시세를 불러오지 못했습니다 (${esc(e.message)}). ↻ 를 눌러 다시 시도하세요.</li>`;
  }
}

function openStockEditor(open) {
  $("my-editor").hidden = !open;
  $("my-edit").textContent = open ? "닫기" : "편집";
  if (open) {
    $("my-input").value = loadStocks().map((x) => `${baseCode(x.s)}${x.name ? " " + x.name : ""}`).join("\n");
    $("my-input").focus();
  }
}
$("my-edit").addEventListener("click", () => openStockEditor($("my-editor").hidden));
$("my-cancel").addEventListener("click", () => openStockEditor(false));
$("my-save").addEventListener("click", () => {
  saveStocks(parseStockLines($("my-input").value));
  openStockEditor(false);
  $("my-list").innerHTML = "";
  loadQuotes();
});

importStocksFromHash();
loadQuotes();

$("date-select").addEventListener("change", (e) => load(e.target.value));
$("refresh").addEventListener("click", () => {
  initDates();
  load($("date-select").value || "latest");
  loadQuotes();
});
try { state.tab = localStorage.getItem("brief.tab"); } catch {}

initDates();
load("latest");

// 아침에 앱을 다시 열면 (백그라운드에서 돌아오면) 최신 데이터로 갱신
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible") return;
  loadQuotes();
  if (($("date-select").value || "latest") === "latest") load("latest");
});

if ("serviceWorker" in navigator && location.protocol !== "file:") {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}
