// 일정 점검: config/events.json의 금통위·FOMC 날짜를 공식 일정표와 비교
//   한국은행 통화정책방향 결정회의 일정 https://www.bok.or.kr/portal/singl/crncyPolicyDrcMtg/listYear.do?mtgSe=A&menuNo=200755
//   연준 FOMC 일정                    https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm
// 결과는 public/data/events-check.json (앱이 읽어서 다르면 화면에 알림). 다르면 종료 코드 2.
//
// 사용법: node scripts/check-events.mjs

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const UA = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130 Safari/537.36" };
const BOK_URL = "https://www.bok.or.kr/portal/singl/crncyPolicyDrcMtg/listYear.do?mtgSe=A&menuNo=200755";
const FED_URL = "https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm";
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

const kstToday = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
const addDays = (d, n) => {
  const t = new Date(d + "T00:00:00Z");
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
};
const pad = (n) => String(n).padStart(2, "0");

async function get(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20000);
  try {
    const r = await fetch(url, { headers: UA, signal: ctrl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.text();
  } finally {
    clearTimeout(t);
  }
}

// 한국은행: 연도별 표의 <th scope="row">01월 15일(목)</th>
async function bokDates(year) {
  const html = await get(`${BOK_URL}&pYear=${year}`);
  return [...html.matchAll(/<th scope="row">\s*(\d{2})월\s*(\d{2})일/g)].map((m) => `${year}-${m[1]}-${m[2]}`);
}

// 연준: "2026 FOMC Meetings" 패널마다 월(January, Apr/May)과 날짜(27-28, 16-17*, 30-1)
// 결정일 = 회의 마지막 날(미국) → 결과 발표는 한국 다음날 새벽이라 +1일. * = 경제전망(점도표) 회의
async function fedDates() {
  const html = (await get(FED_URL)).replace(/\s+/g, " ");
  const out = {};
  const parts = html.split(/(\d{4}) FOMC Meetings/);
  for (let i = 1; i < parts.length; i += 2) {
    const year = Number(parts[i]);
    const body = parts[i + 1];
    const re = /fomc-meeting__month[^>]*>\s*<strong>([^<]+)<\/strong>.*?fomc-meeting__date[^>]*>([^<]+)</g;
    const list = [];
    for (const m of body.matchAll(re)) {
      const monthTxt = m[1].trim();
      const dateTxt = m[2].trim();
      if (/notation|unscheduled/i.test(dateTxt)) continue;
      const lastMonth = monthTxt.split("/").pop().trim();
      const mi = MONTHS.findIndex((x) => x.toLowerCase().startsWith(lastMonth.toLowerCase().slice(0, 3)));
      const day = dateTxt.replace(/[^\d-]/g, "").split("-").filter(Boolean).pop();
      if (mi < 0 || !day) continue;
      const usDay = `${year}-${pad(mi + 1)}-${pad(day)}`;
      list.push({ date: addDays(usDay, 1), sep: dateTxt.includes("*") });
    }
    if (list.length && !out[year]) out[year] = list;
  }
  return out;
}

async function main() {
  const today = kstToday();
  const year = Number(today.slice(0, 4));
  const years = [year, year + 1];
  const cfg = JSON.parse(await fs.readFile(path.join(ROOT, "config", "events.json"), "utf8"));
  const mine = (country, re, y) =>
    cfg.events.filter((e) => e.country === country && re.test(e.title) && e.date.startsWith(String(y))).map((e) => e.date).sort();

  const diffs = [];
  const checked = [];
  const errors = [];

  const compare = (label, official, configured) => {
    for (const d of official) if (!configured.includes(d)) diffs.push(`${label} ${d} — 공식 일정에 있는데 앱에 없음`);
    for (const d of configured) if (!official.includes(d)) diffs.push(`${label} ${d} — 앱에 있는데 공식 일정에 없음`);
  };

  for (const y of years) {
    try {
      const official = await bokDates(y);
      if (official.length) {
        compare(`금통위 ${y}`, official, mine("KR", /금통위/, y));
        checked.push(`금통위 ${y} (${official.length}회)`);
      }
    } catch (e) {
      errors.push(`한국은행 일정 ${y}: ${e.message}`);
    }
  }
  try {
    const fed = await fedDates();
    for (const y of years) {
      if (!fed[y]) continue;
      const official = fed[y].map((x) => x.date);
      // FOMC는 결정 발표일(한국 날짜) 기준
      compare(`FOMC ${y}`, official, mine("US", /FOMC/, y));
      checked.push(`FOMC ${y} (${official.length}회)`);
    }
  } catch (e) {
    errors.push(`연준 일정: ${e.message}`);
  }

  const result = {
    checkedAt: new Date().toISOString(),
    ok: diffs.length === 0 && errors.length === 0,
    checked,
    diffs,
    errors,
    sources: [BOK_URL, FED_URL],
  };
  await fs.writeFile(path.join(ROOT, "public", "data", "events-check.json"), JSON.stringify(result, null, 1));
  console.log(`[일정 점검] 확인: ${checked.join(", ") || "없음"}`);
  diffs.forEach((d) => console.log("  ✗ " + d));
  errors.forEach((d) => console.log("  ! " + d));
  if (result.ok) console.log("  모두 일치");
  process.exitCode = diffs.length ? 2 : 0;
}

main();
