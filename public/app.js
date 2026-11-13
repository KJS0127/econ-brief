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
  renderEvents(b.events || [], b.date);

  $("foot").innerHTML = `
    <p>뉴스 ${timeAgo(b.generatedAt)} 기준 · 지표 ${timeAgo(b.indicatorsAt || b.generatedAt)} 기준 (장중 30분~1시간마다 갱신, 시세는 15~20분 지연될 수 있음)</p>
    <p>지표: Yahoo Finance, 한국은행 ECOS (야후 값이 비거나 늦으면 한국은행·미 재무부·Cboe 공식 값으로 대체, ⚠ 지연 = 최신 거래일 값을 못 받음) · 일정: 한국은행·연준 공식 일정표 · 뉴스: 연합뉴스, 한국경제, 매일경제, 이데일리 RSS. 기사 저작권은 각 언론사에 있으며 제목을 누르면 원문으로 이동합니다.</p>
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

$("date-select").addEventListener("change", (e) => load(e.target.value));
$("refresh").addEventListener("click", () => {
  initDates();
  load($("date-select").value || "latest");
});
try { state.tab = localStorage.getItem("brief.tab"); } catch {}

initDates();
load("latest");

// 아침에 앱을 다시 열면 (백그라운드에서 돌아오면) 최신 데이터로 갱신
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && ($("date-select").value || "latest") === "latest") load("latest");
});

if ("serviceWorker" in navigator && location.protocol !== "file:") {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}
