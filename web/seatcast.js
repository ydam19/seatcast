// 앉을각 계산 로직 (브라우저와 Node 양쪽에서 씁니다)

export const DAYTYPES = ["평일", "토요일", "일요일"];

export function nextStation(model, no, dir, k = 1) {
  const loop = model.meta.loop;
  const i = loop.indexOf(no);
  const step = dir === "내선" ? k : -k;
  const n = loop.length;
  return loop[(((i + step) % n) + n) % n];
}

// 탄 역에서 내릴 역까지 더 짧은 방향과 정거장 수
export function route(model, from, to) {
  const loop = model.meta.loop;
  const n = loop.length;
  const a = loop.indexOf(from);
  const b = loop.indexOf(to);
  const inner = (b - a + n) % n;
  const outer = (a - b + n) % n;
  const dir = inner <= outer ? "내선" : "외선";
  const stops = Math.min(inner, outer);
  const path = [];
  let cur = from;
  for (let k = 0; k < stops; k++) {
    cur = nextStation(model, cur, dir);
    path.push(cur);
  }
  return { dir, stops, path };
}

// 방향 표시용: 다음 역 이름으로 "강남 방면"
export function heading(model, from, dir) {
  return model.stations[String(nextStation(model, from, dir))] + " 방면";
}

// 내리기 전까지 거치는 역(내릴 역 제외)에서 문별로 생길 것으로 예상되는 빈자리
export function seatsAhead(model, { daytype, hour, from, to }) {
  const { cars, doors, seats_per_train: seats } = model.meta;
  const { dir, stops, path } = route(model, from, to);
  const total = new Array(cars * doors).fill(0);
  const steps = [];
  const boardKey = `${daytype}|${hour}|${dir}|${nextStation(model, from, dir)}`;
  const boardLoad = model.arrive_load[boardKey] ?? null;

  for (const no of path.slice(0, -1)) {
    const key = `${daytype}|${hour}|${dir}|${no}`;
    const alight = model.alight[key];
    const load = model.arrive_load[key];
    const weights = model.door_weights[`${no}|${dir}`];
    if (alight == null || !load || !weights) {
      steps.push({ no, name: model.stations[String(no)], perDoor: null });
      continue;
    }
    const seatedShare = Math.min(1, seats / load);
    const perDoor = weights.map((w) => alight * seatedShare * w);
    perDoor.forEach((v, i) => (total[i] += v));
    steps.push({ no, name: model.stations[String(no)], perDoor, load });
  }
  return { dir, stops, path, total, steps, boardLoad };
}

export function doorLabel(i, doors = 4) {
  return `${Math.floor(i / doors) + 1}-${(i % doors) + 1}`;
}

export function doorIndex(label, doors = 4) {
  const m = /^(\d+)-(\d+)$/.exec(label || "");
  if (!m) return null;
  return (Number(m[1]) - 1) * doors + (Number(m[2]) - 1);
}

// 혼잡도(%) 표시: 승객 수 / 정원 1,600명
export function congestionPct(load) {
  return load == null ? null : Math.round(load / 16);
}
