import {
  DAYTYPES, route, heading, seatsAhead, doorLabel, doorIndex, congestionPct,
} from "./seatcast.js";

const $ = (id) => document.getElementById(id);
const els = {
  from: $("from"), to: $("to"), hour: $("hour"), mine: $("mine"),
  daytype: $("daytype"), swap: $("swap"), result: $("result"),
};

const state = { daytype: "평일", hour: 8, from: 226, to: 221, mine: "" };

function todayDaytype() {
  const d = new Date().getDay();
  return d === 0 ? "일요일" : d === 6 ? "토요일" : "평일";
}

function clampHour(h) {
  return Math.min(23, Math.max(5, h));
}

function option(value, label) {
  const o = document.createElement("option");
  o.value = value;
  o.textContent = label;
  return o;
}

function fillInputs(model) {
  const loop = model.meta.loop;
  for (const no of loop) {
    els.from.append(option(no, model.stations[String(no)]));
    els.to.append(option(no, model.stations[String(no)]));
  }
  for (let h = 5; h <= 23; h++) {
    els.hour.append(option(h, `${String(h).padStart(2, "0")}:00 ~ ${String(h).padStart(2, "0")}:59`));
  }
  els.mine.append(option("", "모름 / 아직 안 탐"));
  const { cars, doors } = model.meta;
  for (let i = 0; i < cars * doors; i++) els.mine.append(option(doorLabel(i, doors), doorLabel(i, doors)));

  for (const dt of DAYTYPES) {
    const b = document.createElement("button");
    b.type = "button";
    b.role = "radio";
    b.textContent = dt === "평일" ? "평일" : dt.replace("요일", "");
    b.dataset.value = dt;
    els.daytype.append(b);
  }
}

function syncInputs() {
  els.from.value = state.from;
  els.to.value = state.to;
  els.hour.value = state.hour;
  els.mine.value = state.mine;
  for (const b of els.daytype.children) {
    b.setAttribute("aria-checked", String(b.dataset.value === state.daytype));
  }
}

// 0~4 단계 색: 이 결과 안에서의 상대값
function heatLevel(v, max) {
  if (max <= 0) return 0;
  const r = v / max;
  return r > 0.85 ? 4 : r > 0.65 ? 3 : r > 0.45 ? 2 : r > 0.25 ? 1 : 0;
}

const fmt = (v) => (v >= 10 ? v.toFixed(0) : v.toFixed(1));

function render(model) {
  const { cars, doors } = model.meta;
  const name = (no) => model.stations[String(no)];

  if (state.from === state.to) {
    els.result.innerHTML = `<div class="panel empty">탄 역과 내릴 역을 다르게 골라 주세요.</div>`;
    return;
  }

  const r = seatsAhead(model, state);
  const routeLine = `${name(state.from)} → ${name(state.to)} · ${heading(model, state.from, r.dir)} (${r.dir}) · ${r.stops}정거장`;

  if (r.stops < 2) {
    els.result.innerHTML = `<div class="panel summary"><p class="route-line">${routeLine}</p>
      <p class="headline">한 정거장이면 서서 가셔도 금방이에요.</p>
      <p class="sub">중간에 거치는 역이 없어서 자리가 날 기회가 없습니다.</p></div>`;
    return;
  }

  const total = r.total;
  const max = Math.max(...total);
  const best = total.indexOf(max);
  const mineIdx = doorIndex(state.mine, doors);
  const boardPct = congestionPct(r.boardLoad);
  const seatsFull = model.meta.seats_per_train / 16; // 34%

  let notice = "";
  if (boardPct != null && boardPct < seatsFull) {
    notice = `<p class="notice">이 시간대 열차는 혼잡도 ${boardPct}%로, 탈 때부터 빈자리가 있을 가능성이 높아요.</p>`;
  } else if (boardPct != null) {
    notice = `<p class="notice">탈 때 열차 혼잡도 ${boardPct}% · 좌석은 이미 다 차 있어요.</p>`;
  }

  let compare = `<div class="stat best"><div class="k">추천 위치 ${doorLabel(best, doors)}</div>
    <div class="v">${fmt(max)}<small>석</small></div></div>`;
  if (mineIdx != null) {
    const mv = total[mineIdx];
    const ratio = mv > 0 ? max / mv : null;
    compare += `<div class="stat mine"><div class="k">지금 위치 ${state.mine}</div>
      <div class="v">${fmt(mv)}<small>석</small></div></div>`;
    if (ratio && mineIdx !== best) {
      notice += `<p class="notice">${doorLabel(best, doors)}로 옮기면 내 앞에 날 자리가 ${ratio.toFixed(1)}배예요.</p>`;
    }
  } else {
    const avg = total.reduce((a, b) => a + b, 0) / total.length;
    compare += `<div class="stat"><div class="k">40개 문 평균</div>
      <div class="v">${fmt(avg)}<small>석</small></div></div>`;
  }

  const summary = `<div class="panel summary">
    <p class="route-line">${routeLine}</p>
    <p class="headline"><strong>${doorLabel(best, doors)}</strong> 문 앞에 서세요</p>
    <p class="sub">내리기 전까지 이 문 앞 좌석에서 평균 ${fmt(max)}자리가 빌 것으로 예상돼요.</p>
    <div class="compare">${compare}</div>
    ${notice}
  </div>`;

  const carRows = [];
  for (let c = 0; c < cars; c++) {
    const cells = [];
    let carSum = 0;
    for (let d = 0; d < doors; d++) {
      const i = c * doors + d;
      carSum += total[i];
      const cls = ["door", i === best ? "best" : "", i === mineIdx ? "mine" : ""].join(" ").trim();
      cells.push(`<button type="button" class="${cls}" data-h="${heatLevel(total[i], max)}" data-door="${doorLabel(i, doors)}"
        aria-label="${doorLabel(i, doors)} 예상 빈자리 ${fmt(total[i])}석">${fmt(total[i])}</button>`);
    }
    carRows.push(`<div class="car"><span class="car-no">${c + 1}칸</span>
      <div class="car-doors">${cells.join("")}</div>
      <span class="car-total">${fmt(carSum)}<small>석</small></span></div>`);
  }

  const heatmap = `<div class="panel">
    <div class="section-title"><h2>칸·문별 예상 빈자리</h2><span>문을 누르면 지금 위치로 지정</span></div>
    <p class="front">1칸이 진행 방향 맨 앞입니다 (${heading(model, state.from, r.dir)})</p>
    <div class="train">${carRows.join("")}</div>
    <div class="legend">적음 <i style="background:var(--heat-0)"></i><i style="background:var(--heat-1)"></i><i style="background:var(--heat-2)"></i><i style="background:var(--heat-3)"></i><i style="background:var(--heat-4)"></i> 많음</div>
  </div>`;

  const focus = mineIdx ?? best;
  const stepRows = r.steps.map((s) => {
    const v = s.perDoor ? s.perDoor[focus] : null;
    const pct = s.load ? `<span class="cong">도착 혼잡도 ${congestionPct(s.load)}%</span>` : "";
    return `<li><span>${s.name}${pct}</span><span class="n">${v == null ? "-" : fmt(v) + "석"}</span></li>`;
  });
  const steps = `<div class="panel">
    <div class="section-title"><h2>${doorLabel(focus, doors)} 앞에서 정거장별로</h2><span>내릴 역 전까지</span></div>
    <ul class="steps">${stepRows.join("")}</ul>
  </div>`;

  els.result.innerHTML = summary + heatmap + steps;
}

async function main() {
  const model = await (await fetch("data/model.json")).json();
  state.daytype = todayDaytype();
  state.hour = clampHour(new Date().getHours());
  fillInputs(model);
  syncInputs();
  render(model);

  const update = () => { syncInputs(); render(model); };
  els.from.addEventListener("change", () => { state.from = Number(els.from.value); update(); });
  els.to.addEventListener("change", () => { state.to = Number(els.to.value); update(); });
  els.hour.addEventListener("change", () => { state.hour = Number(els.hour.value); update(); });
  els.mine.addEventListener("change", () => { state.mine = els.mine.value; update(); });
  els.swap.addEventListener("click", () => { [state.from, state.to] = [state.to, state.from]; update(); });
  els.daytype.addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (b) { state.daytype = b.dataset.value; update(); }
  });
  els.result.addEventListener("click", (e) => {
    const b = e.target.closest(".door");
    if (b) { state.mine = b.dataset.door; update(); }
  });
}

main().catch((err) => {
  els.result.innerHTML = `<div class="panel empty">데이터를 불러오지 못했어요. (${err.message})</div>`;
});
