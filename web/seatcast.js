// 앉을각 계산 로직 (브라우저와 Node 양쪽에서 씁니다)

export const LINE_COLORS = {
  1: "#0052A4", 2: "#00A84D", 3: "#EF7C1C", 4: "#00A5DE", 5: "#996CAC",
  6: "#CD7C2F", 7: "#747F00", 8: "#E6186C", 9: "#BDB092",
};

const nodeId = (line, name) => `${line}:${name}`;
const splitId = (id) => {
  const i = id.indexOf(":");
  return [id.slice(0, i), id.slice(i + 1)];
};

// 연결망: 같은 호선 구간 + 같은 이름 역끼리 환승
// transferMin: 환승 한 번에 매기는 분. 크게 주면 환승이 적은 경로를 찾습니다.
export function buildGraph(model, transferMin = model.meta.transfer_min) {
  const adj = new Map();
  const add = (a, b, w, kind) => {
    if (!adj.has(a)) adj.set(a, []);
    adj.get(a).push({ to: b, w, kind });
  };
  for (const [a, b, w, kind] of model.edges) add(a, b, w, kind);
  const byName = new Map();
  for (const [line, names] of Object.entries(model.stations)) {
    for (const n of names) {
      if (!byName.has(n)) byName.set(n, []);
      byName.get(n).push(line);
    }
  }
  const t = transferMin;
  for (const [n, lines] of byName) {
    for (const a of lines) for (const b of lines) {
      if (a !== b) add(nodeId(a, n), nodeId(b, n), t, "transfer");
    }
  }
  return adj;
}

// 가장 빠른 경로 (다익스트라). 노선이 작아 단순 배열 큐로 충분합니다.
export function shortestPath(graph, from, to) {
  const dist = new Map([[from, 0]]);
  const prev = new Map();
  const done = new Set();
  const queue = [from];
  while (queue.length) {
    queue.sort((a, b) => dist.get(a) - dist.get(b));
    const u = queue.shift();
    if (done.has(u)) continue;
    done.add(u);
    if (u === to) break;
    for (const e of graph.get(u) || []) {
      const d = dist.get(u) + e.w;
      if (d < (dist.get(e.to) ?? Infinity)) {
        dist.set(e.to, d);
        prev.set(e.to, { from: u, kind: e.kind });
        queue.push(e.to);
      }
    }
  }
  if (!dist.has(to)) return null;
  const steps = [];
  for (let cur = to; cur !== from; cur = prev.get(cur).from) {
    steps.unshift({ from: prev.get(cur).from, to: cur, kind: prev.get(cur).kind });
  }
  return { minutes: dist.get(to), steps };
}

// 경로를 호선별 구간으로 나눕니다
export function segments(path) {
  const segs = [];
  let cur = null;
  for (const s of path.steps) {
    if (s.kind === "transfer") { cur = null; continue; }
    const [line, a] = splitId(s.from);
    const [, b] = splitId(s.to);
    if (!cur || cur.line !== line) {
      cur = { line, nodes: [a], express: false };
      segs.push(cur);
    }
    cur.nodes.push(b);
    if (s.kind === "express") cur.express = true;
  }
  return segs;
}

// ---------------------------------------------------------------- 시간표

export const DAY_INDEX = { 평일: 0, 토요일: 1, 일요일: 2 };

// build.py가 내보낸 호선·요일별 시간표를 풉니다. 시각은 자정부터 센 초(새벽 0~2시는 24시 이후)
export function decodeTimetable(model, line, raw) {
  const names = model.stations[line];
  return raw.trains.map(([dest, express, no, ...rest]) => {
    const stops = [], times = [];
    for (let i = 0; i < rest.length; i += 2) {
      stops.push(names[rest[i]]);
      times.push(rest[i + 1] * 30);
    }
    // 행선지가 운행 중에 바뀌는 열차(순환선)는 정차 순번마다 행선지를 고릅니다
    const destAt = Array.isArray(dest)
      ? (k) => raw.dests[dest.reduce((d, [i, x]) => (k >= i ? x : d), dest[0][1])]
      : () => raw.dests[dest];
    return { dest: destAt(0), destAt, express: !!express, no, stops, times };
  });
}

// 이 구간을 그대로 달리는 열차: 첫 역에서 다음 정차역이 nodes[1]이고, 마지막 역까지 차례로 섭니다.
// 순환 열차의 마지막 역 찾기는 한 바퀴(다음에 첫 역이 다시 나오기 전)까지만 봅니다.
// 끝까지 가는 열차가 하루 종일 없으면(중간 회차 등) 방향만 맞는 열차를 씁니다.
export function segmentTrains(trains, seg) {
  const strict = [], loose = [];
  for (const t of trains) {
    for (let p = 0; p < t.stops.length - 1; p++) {
      if (t.stops[p] !== seg.nodes[0] || t.stops[p + 1] !== seg.nodes[1]) continue;
      const times = [t.times[p]];
      let k = p;
      for (let j = 1; j < seg.nodes.length; j++) {
        while (k < t.stops.length && t.stops[k] !== seg.nodes[j] && !(k > p && t.stops[k] === seg.nodes[0])) k++;
        if (k < t.stops.length && t.stops[k] !== seg.nodes[j]) k = t.stops.length;
        times.push(k < t.stops.length ? t.times[k] : null);
      }
      const trip = { dest: t.destAt(p), express: t.express, no: t.no, board: t.times[p], times };
      (times.at(-1) != null ? strict : loose).push(trip);
      // 순환선 열차는 하루에 같은 역을 여러 번 지나므로 계속 찾습니다
    }
  }
  const out = strict.length ? strict : loose;
  return out.sort((a, b) => a.board - b.board);
}

export function clock(sec) {
  const m = Math.floor(sec / 60);
  return `${String(Math.floor(m / 60) % 24).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

function slotIndex(model, sec) {
  const S = model.meta.slots;
  const i = Math.floor((sec / 60 - S[0]) / model.meta.slot_min);
  return Math.max(0, Math.min(S.length - 1, i));
}

// ---------------------------------------------------------------- 자리 예보

// 한 구간에서 내리기 전까지 거치는 역마다 문별로 생길 빈자리. 역마다 그 열차가 도착하는 시각의 30분 구간 값을 씁니다.
export function forecastSegment(model, seg, { daytype, trip }) {
  const info = model.meta.lines[seg.line];
  const nDoors = info.cars * info.doors;
  const res = { line: seg.line, nDoors, cars: info.cars, doors: info.doors, steps: [], total: null, boardLoad: null };
  if (!info.forecast || !trip) return res;

  const k0 = `${seg.line}|${seg.nodes[0]}|${seg.nodes[1]}`;
  res.boardLoad = model.arrive_load[k0]?.[daytype]?.[slotIndex(model, trip.board)] ?? null;
  const stay = new Array(nDoors).fill(1); // 문별로 '아직 못 앉았을' 확률
  const wait = new Array(nDoors).fill(1); // 문별로 서서 가는 정거장 수의 기댓값(첫 구간은 무조건 서서)
  // 문 하나 앞 좌석 수: 한 정거장에서 그 이상 빌 수는 없습니다
  const seatsPerDoor = info.seats / nDoors;
  let covered = 0;

  for (let j = 1; j < seg.nodes.length - 1; j++) {
    const key = `${seg.line}|${seg.nodes[j - 1]}|${seg.nodes[j]}`;
    const si = slotIndex(model, trip.times[j] ?? trip.board);
    const alight = model.alight[key]?.[daytype]?.[si];
    const load = model.arrive_load[key]?.[daytype]?.[si];
    const w = model.door_weights[key];
    const at = trip.times[j];
    if (alight == null || !load || !w) {
      res.steps.push({ name: seg.nodes[j], at, perDoor: null, load: load ?? null });
      continue;
    }
    covered++;
    const seated = Math.min(1, info.seats / load);
    const perDoor = w.map((x) => Math.min(alight * seated * x, seatsPerDoor));
    // 빈자리를 두고 겨루는 사람 = 원래 서 있던 사람 + 이 역에서 새로 탄 사람(다음 구간 혼잡도로 추정)
    const nextKey = `${seg.line}|${seg.nodes[j]}|${seg.nodes[j + 1]}`;
    const nextLoad = model.arrive_load[nextKey]?.[daytype]?.[slotIndex(model, trip.times[j + 1] ?? trip.board)] ?? load;
    const boarded = Math.max(0, nextLoad - (load - alight));
    const standingAll = Math.max(0, load - info.seats) + boarded;
    // 문 앞에 서 있는 사람(나 포함) 중 내가 빈자리를 차지할 확률 = 빈자리 / 겨루는 사람 [가정: 공평한 경쟁]
    const standing = Math.max(1, standingAll / nDoors);
    const chance = perDoor.map((f) => (load <= info.seats ? 1 : Math.min(1, f / standing)));
    chance.forEach((p, i) => { stay[i] *= 1 - p; wait[i] += stay[i]; });
    res.steps.push({ name: seg.nodes[j], at, perDoor, load, cumulative: stay.map((s) => 1 - s) });
  }
  res.covered = covered;
  res.uncovered = res.steps.length - covered;
  // 탈 때부터 빈자리가 있으면 바로 앉을 수 있습니다
  const boardHasSeats = res.boardLoad != null && res.boardLoad < info.seats;
  res.total = covered ? stay.map((s) => (boardHasSeats ? 1 : 1 - s)) : null;
  res.wait = covered ? wait.map((x) => (boardHasSeats ? 0 : x)) : null;
  res.stops = seg.nodes.length - 1;
  // 추천 문: 앉을 확률이 가장 높은 문, 비슷하면(1%p 안) 서서 가는 정거장이 가장 적은 문
  if (res.total) {
    const top = Math.max(...res.total);
    res.best = res.total.reduce((b, t, i) => (t >= top - 0.01 && res.wait[i] < res.wait[b] ? i : b),
      res.total.indexOf(top));
  }
  res.boardHasSeats = boardHasSeats;
  return res;
}

// 경로만 (시간표 없이)
export function route(graph, { fromLine, from, toLine, to }) {
  const path = shortestPath(graph, nodeId(fromLine, from), nodeId(toLine, to));
  if (!path) return null;
  const segs = segments(path);
  const sig = segs.map((s) => `${s.line}:${s.nodes[0]}>${s.nodes.at(-1)}${s.express ? "*" : ""}`).join("|");
  return { minutes: path.minutes, segments: segs, sig };
}

// 환승 비용을 달리한 연결망마다 경로를 찾아, 겹치지 않는 후보만 돌려줍니다
export function routes(graphs, state) {
  const out = [];
  for (const g of graphs) {
    const r = route(g, state);
    if (r && !out.some((o) => o.sig === r.sig)) out.push(r);
  }
  return out;
}

// 실제 시간표로 계산한 도착 시각(없으면 Infinity)
export function arrival(p) {
  const t = p.segments.at(-1).trip?.times.at(-1);
  return p.timed && t != null ? t : Infinity;
}

// 첫 구간에서 고른 열차(board 시각)부터, 환승마다 갈아탈 수 있는 가장 빠른 열차를 이어 붙여 예보합니다.
// timetables: 호선 -> 그 요일 열차 목록(decodeTimetable 결과)
export function plan(model, r, state, timetables) {
  if (!r) return null;
  const transfer = model.meta.transfer_min * 60;
  let ready = state.depart;
  const segs = r.segments.map((seg, i) => {
    const cands = segmentTrains(timetables[seg.line] || [], seg);
    const trip = i === 0
      ? cands.find((t) => t.board === state.depart) || cands.find((t) => t.board >= state.depart)
      : cands.find((t) => t.board >= ready);
    if (trip) ready = (trip.times.at(-1) ?? trip.board) + transfer;
    return { ...seg, trip: trip || null, forecast: forecastSegment(model, seg, { daytype: state.daytype, trip }) };
  });
  const first = segs[0].trip, last = segs.at(-1).trip;
  const minutes = first && last && last.times.at(-1) != null
    ? (last.times.at(-1) - first.board) / 60 : r.minutes;
  return { minutes, timed: !!(first && last), segments: segs, sig: r.sig };
}

// 어느 문이든 앉을 확률이 거의 같으면(5%p 안) '서서 가는 정거장 수'로 문을 비교합니다
export function metricMode(f) {
  const t = f.total;
  return Math.max(...t) - Math.min(...t) < 0.05 ? "wait" : "pct";
}

// 문을 비교할 값(0~1, 클수록 좋음)
export function doorHeat(f, i) {
  if (metricMode(f) === "pct") return f.total[i];
  const lo = Math.min(...f.wait), hi = Math.max(...f.wait);
  return hi - lo < 1e-9 ? 1 : 1 - (f.wait[i] - lo) / (hi - lo);
}

export const fmtWait = (x) => (x < 0.05 ? "0" : x.toFixed(1));

// 문 하나를 짧게: "87%" 또는 "2.4역"
export function doorText(f, i) {
  return metricMode(f) === "pct" ? `${Math.round(f.total[i] * 100)}%` : `${fmtWait(f.wait[i])}역`;
}

export function doorLabel(i, doors = 4) {
  return `${Math.floor(i / doors) + 1}-${(i % doors) + 1}`;
}

export function congestionPct(load, capacity) {
  return load == null ? null : Math.round((load / capacity) * 100);
}
