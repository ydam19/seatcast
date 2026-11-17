import {
  LINE_COLORS, buildGraph, plan, routes, arrival, doorLabel, congestionPct,
  DAY_INDEX, decodeTimetable, segmentTrains, clock, metricMode, doorHeat, doorText, fmtWait,
} from "./seatcast.js";
import { createGame } from "./game.js";

const $ = (id) => document.getElementById(id);
const els = {
  fromLine: $("fromLine"), from: $("from"), toLine: $("toLine"), to: $("to"),
  train: $("train"), live: $("live"), daytype: $("daytype"), swap: $("swap"), result: $("result"), game: $("game"),
};

const state = {
  fromLine: "9", from: "석촌", toLine: "5", to: "공덕",
  daytype: "평일",
  depart: 8 * 3600, // 첫 구간에서 고른 열차의 출발 시각(자정부터 초)
  mine: {}, // 구간 번호 -> 지금 선 위치 ("4-3")
};

let model, graphs, game;
const ttCache = new Map(); // "호선-요일" -> Promise<열차 목록>
let trainKey = ""; // 열차 목록을 다시 만들어야 하는지 판단
let renderToken = 0;
let routeChoices = []; // 경로 후보 (화면에 고르기 버튼으로 보여 줍니다)
const ROUTE_SLACK = 5 * 60; // 가장 빠른 경로보다 이만큼 안에 도착하면 앉아 가기 좋은 경로를 고릅니다

// 경로 하나를 추천 문에 섰을 때 서서 가는 시간(분). 자리 예보가 없는 구간은 다 서서 간다고 보고 따로 셉니다.
function standing(p) {
  let minutes = 0, unknown = 0;
  for (const s of p.segments) {
    const t = s.trip;
    if (!t || t.times.at(-1) == null) { minutes += 1e3; continue; } // 이어지는 열차 없음
    const dur = (t.times.at(-1) - t.board) / 60;
    const f = s.forecast;
    if (f.total && f.wait) {
      minutes += (dur / f.stops) * f.wait[f.best];
    } else if (f.boardHasSeats) {
      // 바로 앉음
    } else {
      minutes += dur;
      if (!model.meta.lines[s.line].forecast || (!f.total && s.nodes.length >= 3)) unknown += dur;
    }
  }
  return { minutes, unknown };
}
let userPicked = false; // 사용자가 열차를 직접 고르면 실시간 열차로 자동 선택하지 않습니다
const liveCache = new Map(); // 역 -> { at, data }
const LIVE_TTL = 20000;

async function fetchLive(station) {
  const hit = liveCache.get(station);
  if (hit && Date.now() - hit.at < LIVE_TTL) return hit.data;
  const r = await fetch(`api/arrival?station=${encodeURIComponent(station)}`);
  if (!r.ok) throw new Error(String(r.status));
  const data = await r.json();
  liveCache.set(station, { at: Date.now(), data });
  return data;
}

// 실시간으로 오는 열차를 시간표 열차와 맞춥니다: 열차 번호가 같으면 그 열차, 아니면 도착 예정 시각이 가장 가까운 열차
function matchLive(list, line, cands) {
  const now = nowSec();
  const out = [];
  for (const x of list) {
    if (x.line !== line) continue;
    let c = cands.find((t) => t.no && t.no === x.no && Math.abs(t.board - now) < 90 * 60);
    if (!c && x.eta > 0) {
      const target = (x.at ?? now) + x.eta;
      c = cands.reduce((b, t) => (Math.abs(t.board - target) < Math.abs((b?.board ?? 1e9) - target) ? t : b), null);
      if (c && Math.abs(c.board - target) > 180) c = null;
    }
    if (c && !out.some((o) => o.trip === c)) out.push({ live: x, trip: c });
  }
  return out.sort((a, b) => a.trip.board - b.trip.board).slice(0, 3);
}

// 실시간 도착 예정(정보를 받은 시각 + 남은 초)이 시간표보다 몇 분 늦은지
function liveDelay(m) {
  if (!m.live.eta || m.live.at == null) return 0;
  return Math.round((m.live.at + m.live.eta - m.trip.board) / 60);
}

async function renderLive(token, s0, cands) {
  if (state.daytype !== todayDaytype()) {
    els.live.hidden = true;
    return;
  }
  let data;
  try {
    data = await fetchLive(s0.nodes[0]);
  } catch {
    els.live.hidden = true; // 로컬 정적 서버 등 실시간 함수가 없는 곳
    return;
  }
  if (token !== renderToken) return;
  const matched = matchLive(data.list, s0.line, cands);
  els.live.hidden = false;
  const head = `<div class="live-head">실시간 ${s0.nodes[0]} 도착<span>${clock(nowSec())} 기준</span></div>`;
  if (!matched.length) {
    els.live.innerHTML = `${head}<p class="live-empty">이 방향으로 곧 들어오는 열차 정보가 없어요.</p>`;
    return;
  }
  if (!userPicked && matched[0].trip.board !== state.depart) {
    state.depart = matched[0].trip.board;
    render();
    return;
  }
  els.live.innerHTML = head + `<div class="live-list">${matched.map((m) => {
    const d = liveDelay(m);
    const late = d >= 2 ? `<small class="late">${d}분 지연</small>` : `<small>시간표 ${clock(m.trip.board)}</small>`;
    return `<button type="button" class="live-item" data-board="${m.trip.board}" aria-pressed="${m.trip.board === state.depart}">
      <b>${m.trip.dest}행${m.trip.express ? " 급행" : ""}</b><em>${m.live.msg}</em>${late}</button>`;
  }).join("")}</div>`;
}

function timetable(line, daytype) {
  const key = `${line}-${DAY_INDEX[daytype]}`;
  if (!ttCache.has(key)) {
    ttCache.set(key, fetch(`data/tt/${key}.json`)
      .then((r) => (r.ok ? r.json() : { dests: [], trains: [] }))
      .then((raw) => decodeTimetable(model, line, raw)));
  }
  return ttCache.get(key);
}

function nowSec() {
  const d = new Date();
  const h = d.getHours();
  return (h < 3 ? h + 24 : h) * 3600 + d.getMinutes() * 60;
}

function todayDaytype() {
  const d = new Date().getDay();
  return d === 0 ? "일요일" : d === 6 ? "토요일" : "평일";
}

function option(value, label) {
  const o = document.createElement("option");
  o.value = value;
  o.textContent = label;
  return o;
}

function lineLabel(line) {
  return `${line}호선`;
}

function fillStations(select, line, selected) {
  select.replaceChildren();
  const names = [...model.stations[line]].sort((a, b) => a.localeCompare(b, "ko"));
  for (const n of names) select.append(option(n, n));
  select.value = names.includes(selected) ? selected : names[0];
  return select.value;
}

function fillInputs() {
  const lines = Object.keys(model.stations).sort();
  for (const sel of [els.fromLine, els.toLine]) {
    for (const l of lines) sel.append(option(l, lineLabel(l)));
  }
  for (const dt of model.meta.daytypes) {
    const b = document.createElement("button");
    b.type = "button";
    b.setAttribute("role", "radio");
    b.textContent = dt === "평일" ? "평일" : dt.replace("요일", "");
    b.dataset.value = dt;
    els.daytype.append(b);
  }
}

function syncInputs() {
  els.fromLine.value = state.fromLine;
  els.toLine.value = state.toLine;
  state.from = fillStations(els.from, state.fromLine, state.from);
  state.to = fillStations(els.to, state.toLine, state.to);
  for (const b of els.daytype.children) {
    b.setAttribute("aria-checked", String(b.dataset.value === state.daytype));
  }
  for (const [sel, line] of [[els.fromLine, state.fromLine], [els.toLine, state.toLine]]) {
    sel.style.setProperty("--lc", LINE_COLORS[line]);
  }
}

function heatLevel(v, max) {
  if (max <= 0) return 0;
  const r = v / max;
  return r >= 0.75 ? 4 : r >= 0.55 ? 3 : r >= 0.35 ? 2 : r >= 0.15 ? 1 : 0;
}

const fmt = (v) => (v >= 10 ? v.toFixed(0) : v.toFixed(1));
const badge = (line) => `<span class="lb" style="--lc:${LINE_COLORS[line]}">${line}</span>`;

function routeTabs() {
  if (!routeChoices.length) return "";
  const rec = routeChoices.find((c) => c.rec);
  const fast = routeChoices.reduce((b, c) => (c.end < b.end ? c : b));
  const items = routeChoices.map((c) => {
    const segs = c.p.segments;
    const label = c.end === Infinity ? "이어지는 열차 없음" : `${clock(c.end)} 도착`;
    const late = Math.round((c.end - c.fastest) / 60);
    const stand = c.stand.minutes >= 1e3 ? ""
      : `서서 약 ${Math.round(c.stand.minutes)}분${c.stand.unknown ? " · 일부 자리 정보 없음" : ""}`;
    const tag = c.rec ? "추천" : c.end === c.fastest ? "가장 빨라요" : c.end === Infinity ? "" : `${late}분 늦게`;
    return `<button type="button" role="radio" aria-checked="${c.on}" data-route="${c.sig}">
      <span class="rp-lines">${segs.map((s) => badge(s.line)).join("")}</span>
      <span class="rp-text"><span class="rp-main">${label} · 환승 ${segs.length - 1}번</span>
        <span class="rp-sub">${stand}</span></span>
      <span class="rp-tag${c.rec ? " rec" : ""}">${tag}</span></button>`;
  }).join("");
  // 추천이 가장 빠른 경로가 아니면 이유를 적습니다
  const lateMin = rec ? Math.round((rec.end - fast.end) / 60) : 0;
  const why = rec && rec !== fast
    ? `<p class="rp-why">${lateMin > 0 ? `${lateMin}분 늦지만` : "도착 시각은 같지만"} 서서 가는 시간이 약 ${Math.round(fast.stand.minutes - rec.stand.minutes)}분 짧아 추천해요.</p>`
    : rec && rec.nearCount > 1 ? `<p class="rp-why">가장 빨리 도착하고, 서서 가는 시간도 가장 짧아요.</p>`
    : rec ? `<p class="rp-why">가장 빨리 도착하는 경로예요. 5분 안에 도착하는 다른 경로가 있으면 그중 앉아 가기 좋은 쪽을 추천해요.</p>` : "";
  return `<div class="route-pick" role="radiogroup" aria-label="경로 고르기">${items}</div>${why}`;
}

function routeSummary(p) {
  const parts = p.segments.map((s, i) => {
    const kind = s.express ? " 급행" : "";
    const stops = s.nodes.length - 1;
    const t = s.trip;
    const wait = i > 0 && t && p.segments[i - 1].trip?.times.at(-1) != null
      ? ` · ${Math.round((t.board - p.segments[i - 1].trip.times.at(-1)) / 60)}분 뒤 열차` : "";
    const transfer = i > 0 ? `<li class="transfer">${s.nodes[0]} 환승${wait}</li>` : "";
    const when = t
      ? `${clock(t.board)} ${t.dest}행${t.express ? " 급행" : ""}${t.times.at(-1) != null ? ` → ${clock(t.times.at(-1))} 도착` : ""}`
      : "이어지는 열차 없음";
    return `${transfer}<li>${badge(s.line)}<span>${s.nodes[0]} → ${s.nodes.at(-1)}</span>
      <em>${lineLabel(s.line)}${kind} · ${stops}정거장 · ${when}</em></li>`;
  });
  const transfers = p.segments.length - 1;
  const first = p.segments[0].trip, last = p.segments.at(-1).trip;
  const span = p.timed && last.times.at(-1) != null
    ? `${clock(first.board)} 출발 → ${clock(last.times.at(-1))} 도착 · ${Math.round(p.minutes)}분`
    : `약 ${Math.round(p.minutes)}분`;
  return `<div class="panel summary">
    ${routeTabs()}
    <p class="route-line">${span} · ${transfers ? `환승 ${transfers}번` : "환승 없음"}</p>
    <ol class="route">${parts.join("")}</ol>
  </div>`;
}

function segmentPanel(seg, idx) {
  const f = seg.forecast;
  const info = model.meta.lines[seg.line];
  const title = `${badge(seg.line)}<h2>${seg.nodes[0]} → ${seg.nodes.at(-1)}</h2>`;

  if (info.forecast && !seg.trip) {
    return `<div class="panel seg">
      <div class="seg-head">${title}</div>
      <p class="notice">이 시각 이후로는 이 구간을 가는 열차가 없어요. 더 이른 열차를 골라 주세요.</p>
    </div>`;
  }
  if (!info.forecast) {
    return `<div class="panel seg">
      <div class="seg-head">${title}</div>
      <p class="notice">${lineLabel(seg.line)}은 혼잡도와 칸·문 위치 데이터가 공개되지 않아 자리 예보를 제공하지 않아요.</p>
    </div>`;
  }
  if (seg.nodes.length < 3) {
    return `<div class="panel seg">
      <div class="seg-head">${title}</div>
      <p class="notice">한 정거장이라 중간에 자리가 날 기회가 없어요.</p>
    </div>`;
  }
  if (!f.total) {
    return `<div class="panel seg">
      <div class="seg-head">${title}</div>
      <p class="notice">이 구간은 서울교통공사 운영 구간이 아니라 혼잡도 데이터가 없어 자리 예보를 제공하지 않아요.</p>
    </div>`;
  }

  const total = f.total;
  const best = f.best;
  const max = total[best];
  const mode = metricMode(f);
  const mineLabel = state.mine[idx];
  const mineIdx = mineLabel ? total.findIndex((_, i) => doorLabel(i, f.doors) === mineLabel) : -1;
  const pct = congestionPct(f.boardLoad, info.capacity);
  const seatsFullPct = Math.round((info.seats / info.capacity) * 100);

  let notes = "";
  if (f.uncovered) {
    notes += `<p class="notice">중간 ${f.uncovered}개 역은 데이터가 없는 구간이라 계산에서 빠졌어요.</p>`;
  }
  if (pct != null) {
    notes += pct < seatsFullPct
      ? `<p class="notice">탈 때 열차 혼잡도 ${pct}% · 빈자리가 있을 가능성이 높아요.</p>`
      : `<p class="notice">탈 때 열차 혼잡도 ${pct}% · 좌석은 이미 다 차 있어요.</p>`;
  }
  if (f.boardHasSeats) {
    return `<div class="panel seg">
      <div class="seg-head">${title}</div>
      <p class="headline">타자마자 앉을 수 있어요</p>
      <p class="sub">이 열차는 탈 때 혼잡도가 ${pct}%로, 좌석이 다 차는 ${seatsFullPct}%보다 낮아요. 아무 칸이나 괜찮아요.</p>
      ${f.uncovered ? `<p class="notice">중간 ${f.uncovered}개 역은 데이터가 없는 구간이에요.</p>` : ""}
    </div>`;
  }

  const P = (v) => `${Math.round(v * 100)}`;
  // 비교 칸: 확률이 다 비슷하면 '서서 가는 정거장'으로 보여 줍니다
  const val = (i) => (mode === "pct"
    ? `${P(total[i])}<small>%</small>`
    : `${fmtWait(f.wait[i])}<small>정거장</small>`);
  const avgOf = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length;
  let compare = `<div class="stat best"><div class="k">추천 ${doorLabel(best, f.doors)}</div>
    <div class="v">${val(best)}</div></div>`;
  if (mineIdx >= 0) {
    compare += `<div class="stat mine"><div class="k">지금 위치 ${mineLabel}</div>
      <div class="v">${val(mineIdx)}</div></div>`;
    if (mineIdx !== best) {
      notes += mode === "pct"
        ? `<p class="notice">${doorLabel(best, f.doors)}로 옮기면 앉을 확률이 ${P(total[mineIdx])}%에서 ${P(max)}%로 올라가요.</p>`
        : `<p class="notice">${doorLabel(best, f.doors)}로 옮기면 서서 가는 정거장이 평균 ${fmtWait(f.wait[mineIdx])}에서 ${fmtWait(f.wait[best])}로 줄어요.</p>`;
    }
  } else {
    compare += `<div class="stat"><div class="k">아무 데나 섰을 때</div>
      <div class="v">${mode === "pct" ? `${P(avgOf(total))}<small>%</small>` : `${fmtWait(avgOf(f.wait))}<small>정거장</small>`}</div></div>`;
  }

  const rows = [];
  for (let c = 0; c < f.cars; c++) {
    const cells = [];
    let carBest = c * f.doors;
    for (let d = 0; d < f.doors; d++) {
      const i = c * f.doors + d;
      if (doorHeat(f, i) > doorHeat(f, carBest)) carBest = i;
      const cls = ["door", i === best ? "best" : "", i === mineIdx ? "mine" : ""].join(" ").trim();
      const txt = mode === "pct" ? P(total[i]) : fmtWait(f.wait[i]);
      cells.push(`<button type="button" class="${cls}" data-h="${heatLevel(doorHeat(f, i), 1)}"
        data-seg="${idx}" data-door="${doorLabel(i, f.doors)}"
        aria-label="${doorLabel(i, f.doors)} 앉을 확률 ${P(total[i])}%, 평균 ${fmtWait(f.wait[i])}정거장 서서">${txt}</button>`);
    }
    rows.push(`<div class="car"><span class="car-no">${c + 1}칸</span>
      <div class="car-doors">${cells.join("")}</div>
      <span class="car-total">${doorText(f, carBest)}</span></div>`);
  }

  const focus = mineIdx >= 0 ? mineIdx : best;
  const steps = f.steps.map((s) => {
    const cp = s.load ? `<span class="cong">도착 혼잡도 ${congestionPct(s.load, info.capacity)}%</span>` : "";
    const right = s.perDoor
      ? `빈자리 ${fmt(s.perDoor[focus])} · 누적 ${P(s.cumulative[focus])}%`
      : "데이터 없음";
    const at = s.at != null ? `<span class="at">${clock(s.at)}</span>` : "";
    return `<li><span>${at}${s.name}${cp}</span><span class="n">${right}</span></li>`;
  });

  return `<div class="panel seg">
    <div class="seg-head">${title}</div>
    <p class="headline"><strong>${doorLabel(best, f.doors)}</strong> 문 앞에 서세요</p>
    <p class="sub">내리기 전까지 앉을 확률 약 ${P(max)}%, 평균 ${fmtWait(f.wait[best])}정거장만 서서 가면 돼요.</p>
    <div class="compare">${compare}</div>
    ${notes}
    <div class="section-title"><h3>${mode === "pct" ? "칸·문별 앉을 확률" : "칸·문별 서서 가는 정거장"}</h3><span>문을 누르면 지금 위치로 지정</span></div>
    ${mode === "wait" ? `<p class="front">어느 문이든 내리기 전에 앉을 가능성이 높아서, 앉기까지 평균 몇 정거장 서서 가는지로 비교해요. 숫자가 작을수록 좋아요.</p>` : ""}
    <p class="front">1칸이 진행 방향 맨 앞 (${seg.nodes[1]} 방면) · 오른쪽은 칸에서 가장 좋은 문</p>
    <div class="train">${rows.join("")}</div>
    <div class="legend">낮음 <i style="background:var(--heat-0)"></i><i style="background:var(--heat-1)"></i><i style="background:var(--heat-2)"></i><i style="background:var(--heat-3)"></i><i style="background:var(--heat-4)"></i> 높음</div>
    <div class="section-title"><h3>${doorLabel(focus, f.doors)} 앞에서 정거장별로</h3><span>그 역에서 빌 자리 · 누적 확률</span></div>
    <ul class="steps">${steps.join("")}</ul>
  </div>`;
}

// 첫 구간을 가는 열차 목록을 시간대별로 묶어 보여 줍니다
function fillTrains(cands) {
  els.train.replaceChildren();
  if (!cands.length) {
    els.train.append(option("", "운행 열차 없음"));
    els.train.disabled = true;
    return;
  }
  els.train.disabled = false;
  let group = null, gh = -1;
  for (const t of cands) {
    const h = Math.floor(t.board / 3600) % 24;
    if (h !== gh) {
      group = document.createElement("optgroup");
      group.label = `${String(h).padStart(2, "0")}시`;
      els.train.append(group);
      gh = h;
    }
    group.append(option(t.board, `${clock(t.board)}  ${t.dest}행${t.express ? " 급행" : ""}`));
  }
}

async function render() {
  const token = ++renderToken;
  if (state.fromLine === state.toLine && state.from === state.to) {
    els.result.innerHTML = `<div class="panel empty">탄 곳과 내릴 곳을 다르게 골라 주세요.</div>`;
    els.game.hidden = true;
    return;
  }
  const rs = routes(graphs, state);
  if (!rs.length) {
    els.result.innerHTML = `<div class="panel empty">경로를 찾지 못했어요.</div>`;
    els.game.hidden = true;
    return;
  }
  const lines = [...new Set(rs.flatMap((r) => r.segments.map((s) => s.line)))];
  const lists = await Promise.all(lines.map((l) => timetable(l, state.daytype)));
  if (token !== renderToken) return; // 그 사이 입력이 바뀌었습니다
  const tts = Object.fromEntries(lines.map((l, i) => [l, lists[i]]));

  // 경로 고르기: 사용자가 고른 경로가 있으면 그대로.
  // 없으면 가장 빨리 도착하는 경로를 기준으로, 그보다 5분 안에 도착하는 경로 중 서서 가는 시간이 가장 짧은 경로
  const trial = rs.map((r) => {
    const p = plan(model, r, state, tts);
    return { r, p, end: arrival(p), stand: standing(p) };
  });
  const fastest = Math.min(...trial.map((x) => x.end));
  const order = (a, b) => a.stand.minutes - b.stand.minutes || a.end - b.end
    || a.r.segments.length - b.r.segments.length;
  const near = trial.filter((x) => x.end <= fastest + ROUTE_SLACK);
  const recommended = (near.length ? near : trial).sort(order)[0];
  const pick = trial.find((x) => x.r.sig === state.routeSig) || recommended;
  const r = pick.r;
  routeChoices = trial.length > 1
    ? trial.map((x) => ({ ...x, sig: x.r.sig, on: x === pick, rec: x === recommended, fastest, nearCount: near.length }))
      .sort((a, b) => a.end - b.end)
    : [];

  // 첫 구간 열차 목록: 경로 첫 구간이나 요일이 바뀌었을 때만 다시 만듭니다
  const s0 = r.segments[0];
  const cands = segmentTrains(tts[s0.line], s0);
  const key = JSON.stringify([s0.line, s0.nodes[0], s0.nodes[1], s0.nodes.at(-1), state.daytype]);
  if (key !== trainKey) {
    trainKey = key;
    fillTrains(cands);
  }
  if (cands.length && !cands.some((t) => t.board === state.depart)) {
    // 고른 시각 이후 첫 열차, 막차가 지났으면 막차
    state.depart = (cands.find((t) => t.board >= state.depart) || cands.at(-1)).board;
  }
  els.train.value = String(state.depart);
  renderLive(token, s0, cands);

  const p = plan(model, r, state, tts);
  els.game.hidden = false;
  game.show(p, state);
  els.result.innerHTML = routeSummary(p) + p.segments.map(segmentPanel).join("");
}

async function main() {
  model = await (await fetch("data/model.json")).json();
  // 기본 환승 비용, 환승을 꺼리는 비용 두 가지로 경로 후보를 만듭니다
  graphs = [buildGraph(model), buildGraph(model, 15), buildGraph(model, 60)];
  game = createGame(els.game, {
    model,
    onPick: (seg, door) => { state.mine[seg] = door; render(); },
  });
  state.daytype = todayDaytype();
  state.depart = nowSec();
  fillInputs();
  syncInputs();
  render();

  const update = () => { syncInputs(); render(); };
  const reset = () => { state.mine = {}; state.routeSig = null; userPicked = false; update(); };
  els.fromLine.addEventListener("change", () => { state.fromLine = els.fromLine.value; reset(); });
  els.toLine.addEventListener("change", () => { state.toLine = els.toLine.value; reset(); });
  els.from.addEventListener("change", () => { state.from = els.from.value; reset(); });
  els.to.addEventListener("change", () => { state.to = els.to.value; reset(); });
  els.train.addEventListener("change", () => { userPicked = true; state.depart = Number(els.train.value); update(); });
  els.live.addEventListener("click", (e) => {
    const b = e.target.closest(".live-item");
    if (b) { userPicked = true; state.depart = Number(b.dataset.board); update(); }
  });
  // 실시간 도착은 30초마다 새로 받습니다
  setInterval(() => { if (!els.live.hidden && !document.hidden) render(); }, 30000);
  els.swap.addEventListener("click", () => {
    [state.fromLine, state.toLine] = [state.toLine, state.fromLine];
    [state.from, state.to] = [state.to, state.from];
    reset();
  });
  els.daytype.addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (b) { state.daytype = b.dataset.value; update(); }
  });
  els.result.addEventListener("click", (e) => {
    const rb = e.target.closest("[data-route]");
    if (rb) { state.routeSig = rb.dataset.route; state.mine = {}; update(); return; }
    const b = e.target.closest(".door");
    if (b) { state.mine[b.dataset.seg] = b.dataset.door; render(); }
  });
}

main().catch((err) => {
  els.result.innerHTML = `<div class="panel empty">데이터를 불러오지 못했어요. (${err.message})</div>`;
});
