import {
  LINE_COLORS, buildGraph, plan, doorLabel, congestionPct,
} from "./seatcast.js";
import { createGame } from "./game.js";

const $ = (id) => document.getElementById(id);
const els = {
  fromLine: $("fromLine"), from: $("from"), toLine: $("toLine"), to: $("to"),
  hour: $("hour"), daytype: $("daytype"), swap: $("swap"), result: $("result"), game: $("game"),
};

const state = {
  fromLine: "9", from: "석촌", toLine: "5", to: "공덕",
  daytype: "평일", hour: 8,
  mine: {}, // 구간 번호 -> 지금 선 위치 ("4-3")
};

let model, graph, game;

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
  for (const h of model.meta.hours) {
    const hh = String(h).padStart(2, "0");
    els.hour.append(option(h, `${hh}:00 ~ ${hh}:59`));
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
  els.hour.value = state.hour;
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

function routeSummary(p) {
  const parts = p.segments.map((s, i) => {
    const kind = s.express ? " 급행" : "";
    const stops = s.nodes.length - 1;
    const transfer = i > 0 ? `<li class="transfer">${s.nodes[0]} 환승</li>` : "";
    return `${transfer}<li>${badge(s.line)}<span>${s.nodes[0]} → ${s.nodes.at(-1)}</span>
      <em>${lineLabel(s.line)}${kind} · ${stops}정거장</em></li>`;
  });
  const transfers = p.segments.length - 1;
  return `<div class="panel summary">
    <p class="route-line">약 ${Math.round(p.minutes)}분 · ${transfers ? `환승 ${transfers}번` : "환승 없음"}</p>
    <ol class="route">${parts.join("")}</ol>
  </div>`;
}

function segmentPanel(seg, idx) {
  const f = seg.forecast;
  const info = model.meta.lines[seg.line];
  const title = `${badge(seg.line)}<h2>${seg.nodes[0]} → ${seg.nodes.at(-1)}</h2>`;

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
  const max = Math.max(...total);
  const best = total.indexOf(max);
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
      <p class="sub">이 시간대 열차는 탈 때 혼잡도가 ${pct}%로, 좌석이 다 차는 ${seatsFullPct}%보다 낮아요. 아무 칸이나 괜찮아요.</p>
      ${f.uncovered ? `<p class="notice">중간 ${f.uncovered}개 역은 데이터가 없는 구간이에요.</p>` : ""}
    </div>`;
  }

  const P = (v) => `${Math.round(v * 100)}`;
  let compare = `<div class="stat best"><div class="k">추천 ${doorLabel(best, f.doors)}</div>
    <div class="v">${P(max)}<small>%</small></div></div>`;
  if (mineIdx >= 0) {
    const mv = total[mineIdx];
    compare += `<div class="stat mine"><div class="k">지금 위치 ${mineLabel}</div>
      <div class="v">${P(mv)}<small>%</small></div></div>`;
    if (mineIdx !== best) {
      notes += `<p class="notice">${doorLabel(best, f.doors)}로 옮기면 앉을 확률이 ${P(mv)}%에서 ${P(max)}%로 올라가요.</p>`;
    }
  } else {
    const avg = total.reduce((a, b) => a + b, 0) / total.length;
    compare += `<div class="stat"><div class="k">아무 데나 섰을 때</div>
      <div class="v">${P(avg)}<small>%</small></div></div>`;
  }

  const rows = [];
  for (let c = 0; c < f.cars; c++) {
    const cells = [];
    let carBest = 0;
    for (let d = 0; d < f.doors; d++) {
      const i = c * f.doors + d;
      carBest = Math.max(carBest, total[i]);
      const cls = ["door", i === best ? "best" : "", i === mineIdx ? "mine" : ""].join(" ").trim();
      cells.push(`<button type="button" class="${cls}" data-h="${heatLevel(total[i], 1)}"
        data-seg="${idx}" data-door="${doorLabel(i, f.doors)}"
        aria-label="${doorLabel(i, f.doors)} 앉을 확률 ${P(total[i])}%">${P(total[i])}</button>`);
    }
    rows.push(`<div class="car"><span class="car-no">${c + 1}칸</span>
      <div class="car-doors">${cells.join("")}</div>
      <span class="car-total">${P(carBest)}<small>%</small></span></div>`);
  }

  const focus = mineIdx >= 0 ? mineIdx : best;
  const steps = f.steps.map((s) => {
    const cp = s.load ? `<span class="cong">도착 혼잡도 ${congestionPct(s.load, info.capacity)}%</span>` : "";
    const right = s.perDoor
      ? `빈자리 ${fmt(s.perDoor[focus])} · 누적 ${P(s.cumulative[focus])}%`
      : "데이터 없음";
    return `<li><span>${s.name}${cp}</span><span class="n">${right}</span></li>`;
  });

  return `<div class="panel seg">
    <div class="seg-head">${title}</div>
    <p class="headline"><strong>${doorLabel(best, f.doors)}</strong> 문 앞에 서세요</p>
    <p class="sub">내리기 전까지 앉을 확률 약 ${P(max)}%예요.</p>
    <div class="compare">${compare}</div>
    ${notes}
    <div class="section-title"><h3>칸·문별 앉을 확률</h3><span>문을 누르면 지금 위치로 지정</span></div>
    <p class="front">1칸이 진행 방향 맨 앞 (${seg.nodes[1]} 방면) · 오른쪽은 칸에서 가장 좋은 문</p>
    <div class="train">${rows.join("")}</div>
    <div class="legend">낮음 <i style="background:var(--heat-0)"></i><i style="background:var(--heat-1)"></i><i style="background:var(--heat-2)"></i><i style="background:var(--heat-3)"></i><i style="background:var(--heat-4)"></i> 높음</div>
    <div class="section-title"><h3>${doorLabel(focus, f.doors)} 앞에서 정거장별로</h3><span>그 역에서 빌 자리 · 누적 확률</span></div>
    <ul class="steps">${steps.join("")}</ul>
  </div>`;
}

function render() {
  if (state.fromLine === state.toLine && state.from === state.to) {
    els.result.innerHTML = `<div class="panel empty">탄 곳과 내릴 곳을 다르게 골라 주세요.</div>`;
    els.game.hidden = true;
    return;
  }
  const p = plan(model, graph, state);
  if (!p) {
    els.result.innerHTML = `<div class="panel empty">경로를 찾지 못했어요.</div>`;
    els.game.hidden = true;
    return;
  }
  els.game.hidden = false;
  game.show(p, state);
  els.result.innerHTML = routeSummary(p) + p.segments.map(segmentPanel).join("");
}

async function main() {
  model = await (await fetch("data/model.json")).json();
  graph = buildGraph(model);
  game = createGame(els.game, {
    model,
    onPick: (seg, door) => { state.mine[seg] = door; render(); },
  });
  state.daytype = todayDaytype();
  const h = new Date().getHours();
  state.hour = Math.min(Math.max(h, model.meta.hours[0]), model.meta.hours.at(-1));
  fillInputs();
  syncInputs();
  render();

  const update = () => { syncInputs(); render(); };
  const reset = () => { state.mine = {}; update(); };
  els.fromLine.addEventListener("change", () => { state.fromLine = els.fromLine.value; reset(); });
  els.toLine.addEventListener("change", () => { state.toLine = els.toLine.value; reset(); });
  els.from.addEventListener("change", () => { state.from = els.from.value; reset(); });
  els.to.addEventListener("change", () => { state.to = els.to.value; reset(); });
  els.hour.addEventListener("change", () => { state.hour = Number(els.hour.value); update(); });
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
    const b = e.target.closest(".door");
    if (b) { state.mine[b.dataset.seg] = b.dataset.door; render(); }
  });
}

main().catch((err) => {
  els.result.innerHTML = `<div class="panel empty">데이터를 불러오지 못했어요. (${err.message})</div>`;
});
