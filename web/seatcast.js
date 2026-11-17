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
export function buildGraph(model) {
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
  const t = model.meta.transfer_min;
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

// 한 구간에서 내리기 전까지 거치는 역마다 문별로 생길 빈자리
export function forecastSegment(model, seg, { daytype, hour }) {
  const info = model.meta.lines[seg.line];
  const hi = model.meta.hours.indexOf(hour);
  const nDoors = info.cars * info.doors;
  const res = { line: seg.line, nDoors, cars: info.cars, doors: info.doors, steps: [], total: null, boardLoad: null };
  if (!info.forecast || hi < 0) return res;

  const k0 = `${seg.line}|${seg.nodes[0]}|${seg.nodes[1]}`;
  res.boardLoad = model.arrive_load[k0]?.[daytype]?.[hi] ?? null;
  const stay = new Array(nDoors).fill(1); // 문별로 '아직 못 앉았을' 확률
  // 문 하나 앞 좌석 수: 한 정거장에서 그 이상 빌 수는 없습니다
  const seatsPerDoor = info.seats / nDoors;
  let covered = 0;

  for (let j = 1; j < seg.nodes.length - 1; j++) {
    const key = `${seg.line}|${seg.nodes[j - 1]}|${seg.nodes[j]}`;
    const alight = model.alight[key]?.[daytype]?.[hi];
    const load = model.arrive_load[key]?.[daytype]?.[hi];
    const w = model.door_weights[key];
    if (alight == null || !load || !w) {
      res.steps.push({ name: seg.nodes[j], perDoor: null, load: load ?? null });
      continue;
    }
    covered++;
    const seated = Math.min(1, info.seats / load);
    const perDoor = w.map((x) => Math.min(alight * seated * x, seatsPerDoor));
    // 그 문 앞에 서 있는 사람(나 포함) 중 내가 빈자리를 차지할 확률 = 빈자리 / 서 있는 사람 [가정: 공평한 경쟁]
    const standing = Math.max(1, (load - info.seats) / nDoors);
    const chance = perDoor.map((f) => (load <= info.seats ? 1 : Math.min(1, f / standing)));
    chance.forEach((p, i) => (stay[i] *= 1 - p));
    res.steps.push({ name: seg.nodes[j], perDoor, load, cumulative: stay.map((s) => 1 - s) });
  }
  res.covered = covered;
  res.uncovered = res.steps.length - covered;
  // 탈 때부터 빈자리가 있으면 바로 앉을 수 있습니다
  const boardHasSeats = res.boardLoad != null && res.boardLoad < info.seats;
  res.total = covered ? stay.map((s) => (boardHasSeats ? 1 : 1 - s)) : null;
  res.boardHasSeats = boardHasSeats;
  return res;
}

export function plan(model, graph, { fromLine, from, toLine, to, daytype, hour }) {
  const path = shortestPath(graph, nodeId(fromLine, from), nodeId(toLine, to));
  if (!path) return null;
  const segs = segments(path).map((seg) => ({ ...seg, forecast: forecastSegment(model, seg, { daytype, hour }) }));
  return { minutes: path.minutes, segments: segs };
}

export function doorLabel(i, doors = 4) {
  return `${Math.floor(i / doors) + 1}-${(i % doors) + 1}`;
}

export function congestionPct(load, capacity) {
  return load == null ? null : Math.round((load / capacity) * 100);
}
