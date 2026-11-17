// 앉을각 게임 화면: 승강장(1인칭) -> 열차 안(창밖 풍경) 시뮬레이션
import {
  LINE_COLORS, doorLabel, congestionPct, clock, metricMode, doorHeat, doorText, fmtWait,
} from "./seatcast.js";

const DOOR_GAP = 120; // 문 사이 간격(px)
const CAR_GAP = 28; // 칸 사이 연결부
const PAD = 60;

// 지상 구간과 한강 다리 (대략적인 장면 연출용)
const LINE1_UNDER = new Set(["서울역", "시청", "종각", "종로3가", "종로5가", "동대문", "동묘앞", "신설동", "제기동", "청량리"]);
const ABOVE = {
  2: new Set(["신답", "용답", "성수", "뚝섬", "한양대", "건대입구", "구의", "강변", "잠실나루", "당산", "신도림", "도림천", "양천구청"]),
  3: new Set(["지축", "옥수"]),
  4: new Set(["불암산", "당고개", "상계", "노원", "창동", "동작"]),
  7: new Set(["장암", "뚝섬유원지"]),
};
const BRIDGES = new Set([
  "2|당산|합정", "2|강변|잠실나루", "3|옥수|압구정", "4|이촌|동작", "7|뚝섬유원지|청담", "1|용산|노량진",
]);

function sceneFor(line, a, b) {
  if (BRIDGES.has(`${line}|${a}|${b}`) || BRIDGES.has(`${line}|${b}|${a}`)) return "river";
  const above = (n) => (line === "1" ? !LINE1_UNDER.has(n) : ABOVE[line]?.has(n));
  return above(a) && above(b) ? "city" : "tunnel";
}

function rng(seedStr) {
  let h = 1779033703;
  for (let i = 0; i < seedStr.length; i++) h = Math.imul(h ^ seedStr.charCodeAt(i), 3432918353);
  return () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return ((h ^= h >>> 16) >>> 0) / 4294967296;
  };
}

const reduceMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const P = (v) => Math.round(v * 100);

// 사람 실루엣
// 사람 실루엣 (어깨·팔·다리가 있는 형태, 몇 가지 변형)
const HEAD = `<ellipse cx="20" cy="12.5" rx="8" ry="9.4"/><rect x="16.6" y="19" width="6.8" height="7" rx="2.5"/>`;
const HAIR = `<path d="M10.8 14Q10 2.4 20 2.6Q30 2.4 29.2 14L30.4 28Q20 32 9.6 28Z"/>`;
const TORSO = `M9 31.5Q9 24.4 16 23.8H24Q31 24.4 31 31.5`;
const STAND_BODY = `<path d="${TORSO}L33.6 64Q33.7 67 30.8 66.4L29.6 65.6 28.8 120H22.4L20.8 75H19.2L17.6 120H11.2L10.4 65.6 9.2 66.4Q6.3 67 6.4 64Z"/>`;
const EXTRAS = {
  bag: `<path d="M31.5 33L37.6 60Q38 63.5 34.6 63.5H30.4Z"/><path d="M14 24L32 34" stroke-width="1.6" fill="none"/>`,
  pack: `<rect x="5.4" y="28" width="29.2" height="32" rx="8"/>`,
  arm: `<path d="M26.6 27.5L29.4 -24H34.4L32.8 31Z"/><rect x="28.2" y="-30" width="7.6" height="8" rx="3.5"/>`,
  phone: `<path d="M9.5 40Q14 50 20 46L21 42Q16 44 12.5 37Z"/>`,
};
function person(r, { allowArm = false } = {}) {
  const v = r();
  const hair = r() < 0.4 ? HAIR : "";
  const extra = allowArm && v < 0.35 ? EXTRAS.arm : v < 0.5 ? EXTRAS.bag : v < 0.65 ? EXTRAS.pack : "";
  return `<svg class="pp" viewBox="0 -30 40 150" aria-hidden="true">${hair}${HEAD}${STAND_BODY}${extra}</svg>`;
}
function seated(r) {
  const hair = r() < 0.4 ? HAIR : "";
  const lap = r() < 0.35 ? `<rect x="11" y="47" width="18" height="12" rx="3"/>` : "";
  const tilt = r() < 0.25 ? ` transform="rotate(${r() < 0.5 ? -9 : 9} 20 24)"` : "";
  return `<svg class="pp" viewBox="0 0 40 92" aria-hidden="true"><g${tilt}>${hair}${HEAD}</g>
    <path d="${TORSO}L32.4 58H7.6Z"/><path d="M5.6 55H34.4Q35.6 55 35.6 57V63Q35.6 65 34.4 65H5.6Q4.4 65 4.4 63V57Q4.4 55 5.6 55Z"/>
    <path d="M8.6 64H17L16.4 92H9.2Z"/><path d="M23 64H31.4L30.8 92H23.6Z"/>${lap}</svg>`;
}
const ME_STAND = `<svg class="pp stand" viewBox="0 -30 40 150" aria-hidden="true">${HEAD}${STAND_BODY}</svg>`;
const ME_SEAT = `<svg class="pp seat" viewBox="0 0 40 92" aria-hidden="true">${HEAD}<path d="${TORSO}L32.4 58H7.6Z"/><path d="M5.6 55H34.4V65H5.6Z"/><path d="M8.6 64H17L16.4 92H9.2Z"/><path d="M23 64H31.4L30.8 92H23.6Z"/></svg>`;
const tone = (r, base, spread) => `--l:${(base + r() * spread).toFixed(1)}%`;

function crowdCount(pct, r) {
  if (pct == null) return Math.floor(r() * 2);
  if (pct < 40) return Math.floor(r() * 2);
  if (pct < 80) return 1 + Math.floor(r() * 2);
  if (pct < 130) return 2 + Math.floor(r() * 3);
  return 4 + Math.floor(r() * 3);
}

export function createGame(root, { model, onPick }) {
  let ctx = null; // 현재 장면 정보
  let run = 0; // 애니메이션 취소용 토큰
  let speed = 1;

  const sleep = (ms, token) => new Promise((res, rej) => {
    setTimeout(() => (token === run ? res() : rej(new Error("cancel"))), ms / speed);
  });

  function show(plan, state) {
    const key = JSON.stringify([plan.sig, state.daytype, state.depart]);
    if (ctx && ctx.key === key) {
      // 같은 경로: 위치만 바꿉니다
      const m = state.mine[ctx.segIdx];
      if (m && ctx.scene === "platform") setPos(labelIndex(m), false);
      return;
    }
    const first = plan.segments.findIndex((s) => s.forecast.total);
    ctx = { key, plan, state, segIdx: Math.max(0, first) };
    openSegment(ctx.segIdx);
  }

  function labelIndex(label) {
    const [c, d] = label.split("-").map(Number);
    return (c - 1) * ctx.f.doors + (d - 1);
  }

  function tabs() {
    const segs = ctx.plan.segments;
    if (segs.length < 2) return "";
    return `<div class="g-tabs">${segs.map((s, i) => `<button type="button" data-seg="${i}" aria-pressed="${i === ctx.segIdx}">
      <span class="lb" style="--lc:${LINE_COLORS[s.line]}">${s.line}</span>${s.nodes[0]} → ${s.nodes.at(-1)}</button>`).join("")}</div>`;
  }

  function openSegment(i) {
    run++;
    ctx.segIdx = i;
    const seg = ctx.plan.segments[i];
    ctx.seg = seg;
    ctx.f = seg.forecast;
    ctx.info = model.meta.lines[seg.line];
    const f = ctx.f;
    if (!ctx.info.forecast || !f.total || seg.nodes.length < 3) {
      const why = !ctx.info.forecast
        ? `${seg.line}호선은 혼잡도와 칸·문 위치 데이터가 공개되지 않아 자리 예보 게임을 할 수 없어요.`
        : seg.nodes.length < 3
          ? "한 정거장이라 중간에 자리가 날 기회가 없어요."
          : "이 구간은 혼잡도 데이터가 없어 자리 예보 게임을 할 수 없어요.";
      ctx.scene = "none";
      root.innerHTML = `${tabs()}<div class="g-none" style="--lc:${LINE_COLORS[seg.line]}">
        <span class="lb">${seg.line}</span><p>${why}</p></div>`;
      return;
    }
    ctx.best = f.best;
    const mine = ctx.state.mine[i];
    ctx.pos = mine ? labelIndex(mine) : ctx.best;
    platform();
  }

  // ---------- 승강장 ----------
  const carW = () => ctx.f.doors * DOOR_GAP + CAR_GAP;
  const doorX = (i) => PAD + Math.floor(i / ctx.f.doors) * carW() + (i % ctx.f.doors) * DOOR_GAP + DOOR_GAP / 2;

  function platform() {
    const token = ++run;
    ctx.scene = "platform";
    const { seg, f, info } = ctx;
    const n = f.cars * f.doors;
    const W = PAD * 2 + f.cars * carW() - CAR_GAP;
    const pct = congestionPct(f.boardLoad, info.capacity);
    const r = rng(ctx.key + ctx.segIdx);
    const lc = LINE_COLORS[seg.line];

    let psd = "", marks = "", crowd = "", train = "", mini = "";
    for (let i = 0; i < n; i++) {
      const x = doorX(i);
      const label = doorLabel(i, f.doors);
      psd += `<div class="g-bay" style="left:${x - 36}px"><b class="g-plate">${label}</b><i class="l"></i><i class="r"></i></div>`;
      marks += `<button type="button" class="g-mark${i === ctx.best ? " best" : ""}" data-i="${i}" style="left:${x - 52}px"
        aria-label="${label}에 서기, 앉을 확률 ${P(f.total[i])}%, 평균 ${fmtWait(f.wait[i])}정거장 서서"><i class="g-lane"></i>
        <span class="g-mark-txt"><span class="g-mark-label">${label}</span><span class="g-mark-p">${doorText(f, i)}</span></span>
        <i class="g-lane"></i></button>`;
      const q = crowdCount(pct, r);
      for (let k = 0; k < q; k++) {
        const side = k % 2 ? 1 : -1;
        const dx = side * (12 + Math.floor(k / 2) * 20) + (r() - 0.5) * 8;
        crowd += `<span class="g-person" style="left:${x + dx - 16}px;--h:${(0.88 + r() * 0.2).toFixed(2)};--d:${(r() * 2).toFixed(2)}s;${tone(r, 16, 10)}">${person(r)}</span>`;
      }
    }
    // 열차: 칸마다 창문과 문, 안에 탄 사람
    for (let c = 0; c < f.cars; c++) {
      const left = PAD + c * carW() - 14;
      let inner = "";
      const inside = pct == null ? 2 : Math.min(9, Math.round(pct / 18));
      for (let k = 0; k < inside; k++) {
        inner += `<span class="g-rider" style="left:${(r() * (carW() - 70)).toFixed(0)}px;--h:${(0.85 + r() * 0.25).toFixed(2)};${tone(r, 12, 10)}">${person(r, { allowArm: true })}</span>`;
      }
      let doors = "";
      for (let d = 0; d < f.doors; d++) doors += `<div class="g-tdoor" style="left:${d * DOOR_GAP + DOOR_GAP / 2 - 24 + 14}px"><i class="l"></i><i class="r"></i></div>`;
      train += `<div class="g-car" style="left:${left}px;width:${carW() - 10}px">
        <div class="g-win">${inner}</div><span class="g-carno">${c + 1}</span>${doors}</div>`;
      let cells = "";
      for (let d = 0; d < f.doors; d++) {
        const i = c * f.doors + d;
        const h = Math.min(4, Math.floor(doorHeat(f, i) * 5));
        cells += `<i data-i="${i}" data-h="${h}"></i>`;
      }
      mini += `<span class="g-mini-car">${cells}</span>`;
    }

    root.innerHTML = `${tabs()}
    <div class="g-stage g-platform" style="--lc:${lc}">
      <div class="g-sign">
        <span class="lb">${seg.line}</span>
        <span class="g-sign-st">${seg.nodes[0]}</span>
        <span class="g-sign-dir">${seg.nodes[1]} 방면</span>
        <span class="g-led" id="gLed">${seg.trip ? `${clock(seg.trip.board)} ${seg.trip.dest}행` : "열차가 들어오고 있습니다"}</span>
      </div>
      <div class="g-view" id="gView">
        <div class="g-world" id="gWorld" style="width:${W}px">
          <div class="g-track"><div class="g-train" id="gTrain" style="width:${W}px">${train}</div></div>
          <div class="g-psd">${psd}</div>
          <div class="g-floor"><div class="g-edge"></div>${marks}</div>
          <div class="g-crowd">${crowd}</div>
        </div>
        <div class="g-feet" aria-hidden="true"><i></i><i></i></div>
        <div class="g-vignette" aria-hidden="true"></div>
        <button type="button" class="g-nav prev" id="gPrev" aria-label="왼쪽 문으로">‹</button>
        <button type="button" class="g-nav next" id="gNext" aria-label="오른쪽 문으로">›</button>
      </div>
      <div class="g-bar">
        <div class="g-mini-wrap"><div class="g-mini" id="gMini" aria-label="칸별 앉을 확률 지도">${mini}</div>
          <p class="g-hint">발밑 표시를 누르거나 좌우로 끌어서 자리를 옮기세요</p></div>
        <div class="g-hud">
          <div class="g-pos" id="gPos"></div>
          <button type="button" class="g-go" id="gGo" disabled>열차 기다리는 중</button>
        </div>
      </div>
    </div>`;

    const view = root.querySelector("#gView");
    const world = root.querySelector("#gWorld");
    ctx.el = { view, world, led: root.querySelector("#gLed"), pos: root.querySelector("#gPos"), go: root.querySelector("#gGo"), mini: root.querySelector("#gMini") };
    setPos(ctx.pos, true);

    // 손가락으로 끌어서 승강장을 걸어 다닙니다
    let drag = null;
    view.addEventListener("pointerdown", (e) => {
      if (e.target.closest(".g-nav")) return;
      drag = { x: e.clientX, cam: ctx.cam, moved: false };
    });
    view.addEventListener("pointermove", (e) => {
      if (!drag) return;
      const dx = e.clientX - drag.x;
      if (Math.abs(dx) > 6) drag.moved = true;
      if (drag.moved) {
        world.classList.add("dragging");
        setCam(drag.cam - dx);
      }
    });
    const end = () => {
      if (!drag) return;
      if (drag.moved) {
        world.classList.remove("dragging");
        const center = ctx.cam + view.clientWidth / 2;
        let nearest = 0;
        for (let i = 0; i < n; i++) if (Math.abs(doorX(i) - center) < Math.abs(doorX(nearest) - center)) nearest = i;
        pick(nearest);
        view.dataset.dragged = "1";
        setTimeout(() => delete view.dataset.dragged, 0);
      }
      drag = null;
    };
    view.addEventListener("pointerup", end);
    view.addEventListener("pointercancel", end);
    view.addEventListener("click", (e) => {
      if (view.dataset.dragged) return;
      const m = e.target.closest(".g-mark");
      if (m) pick(Number(m.dataset.i));
    });
    root.querySelector("#gPrev").addEventListener("click", () => pick(Math.max(0, ctx.pos - 1)));
    root.querySelector("#gNext").addEventListener("click", () => pick(Math.min(n - 1, ctx.pos + 1)));
    ctx.el.mini.addEventListener("click", (e) => {
      const c = e.target.closest("[data-i]");
      if (c) pick(Number(c.dataset.i));
    });
    root.querySelectorAll(".g-tabs button").forEach((b) => b.addEventListener("click", () => openSegment(Number(b.dataset.seg))));
    ctx.el.go.addEventListener("click", () => ride());

    arrive(token).catch(() => {});
  }

  function setCam(x) {
    ctx.cam = x;
    ctx.el.world.style.transform = `translateX(${-x}px)`;
  }

  function setPos(i, instant) {
    ctx.pos = i;
    const { f, el } = ctx;
    if (instant) el.world.classList.add("dragging");
    setCam(doorX(i) - el.view.clientWidth / 2);
    if (instant) { void el.world.offsetWidth; el.world.classList.remove("dragging"); }
    el.view.querySelectorAll(".g-mark").forEach((m) => m.classList.toggle("mine", Number(m.dataset.i) === i));
    el.mini.querySelectorAll("[data-i]").forEach((c) => c.classList.toggle("mine", Number(c.dataset.i) === i));
    const label = doorLabel(i, f.doors);
    const bestLabel = doorLabel(ctx.best, f.doors);
    const what = metricMode(f) === "pct"
      ? `앉을 확률 <b class="g-num">${P(f.total[i])}%</b>`
      : `평균 <b class="g-num">${fmtWait(f.wait[i])}</b>정거장 서서`;
    el.pos.innerHTML = i === ctx.best
      ? `<b>${label}</b> ${what}<span class="g-tag">최고 자리</span>`
      : `<b>${label}</b> ${what}
         <button type="button" class="g-jump" id="gJump">추천 ${bestLabel} · ${doorText(f, ctx.best)} ›</button>`;
    el.pos.querySelector("#gJump")?.addEventListener("click", () => pick(ctx.best));
  }

  function pick(i) {
    setPos(i, false);
    onPick(ctx.segIdx, doorLabel(i, ctx.f.doors));
  }

  async function arrive(token) {
    const train = root.querySelector("#gTrain");
    const view = ctx.el.view;
    if (reduceMotion()) {
      train.style.transition = "none";
      train.style.transform = "none";
    } else {
      train.style.transform = `translateX(${train.offsetWidth + view.clientWidth}px)`;
      void train.offsetWidth;
      train.classList.add("arriving");
      train.style.transform = "translateX(0)";
      await sleep(3200, token);
    }
    ctx.el.led.textContent = "문이 열립니다";
    view.classList.add("open");
    await sleep(700, token);
    ctx.el.led.textContent = `${ctx.seg.nodes.at(-1)}까지 ${ctx.seg.nodes.length - 1}정거장`;
    ctx.el.go.disabled = false;
    ctx.el.go.textContent = "이 자리에서 탑승하기";
  }

  // ---------- 열차 안 ----------
  function ride() {
    const token = ++run;
    ctx.scene = "ride";
    const { seg, f, info } = ctx;
    const lc = LINE_COLORS[seg.line];
    const pos = ctx.pos;
    const label = doorLabel(pos, f.doors);
    const r = rng(`${Date.now()}`);
    const seatsPerDoor = info.seats / (f.cars * f.doors);

    const stops = seg.nodes.slice(1);
    const dots = stops.map((s, i) => `<li data-i="${i}"><i></i><span>${s}</span></li>`).join("");
    let seats = "";
    for (let k = 0; k < 7; k++) seats += `<div class="g-seat" data-k="${k}"><span class="g-sitter" style="${tone(r, 13, 10)}">${seated(r)}</span></div>`;

    root.innerHTML = `${tabs()}
    <div class="g-stage g-ride" style="--lc:${lc}">
      <div class="g-sign g-sign-ride">
        <span class="lb">${seg.line}</span>
        <span class="g-led" id="gLed">${seg.trip ? `${clock(seg.trip.board)} ` : ""}${seg.nodes[0]} 출발</span>
        <span class="g-chance" id="gChance">0%</span>
      </div>
      <ol class="g-dots" id="gDots">${dots}</ol>
      <div class="g-cabin" id="gCabin">
        <div class="g-ceiling"></div>
        <div class="g-band" id="gBand" data-scene="tunnel">
          <div class="g-scn tunnel"></div><div class="g-scn city"></div><div class="g-scn river"></div>
          <div class="g-stn" id="gStn"><b></b></div>
          <div class="g-panes"><i></i><i></i><i></i></div>
        </div>
        <div class="g-straps"></div>
        <div class="g-bench"><span class="g-part"></span>${seats}<span class="g-part"></span></div>
        <div class="g-pole l"></div><div class="g-pole r"></div>
        <div class="g-standing" id="gStanding"></div>
        <div class="g-me" id="gMe"><span class="g-me-tag">나 · ${label}</span>${ME_STAND}${ME_SEAT}</div>
        <div class="g-toast" id="gToast"></div>
      </div>
      <div class="g-bar">
        <div class="g-hud">
          <div class="g-pos" id="gPos"><b>${label}</b> 앞 · 예보 확률 <b class="g-num">${P(f.total[pos])}%</b></div>
          <div class="g-ctl">
            <button type="button" class="g-btn" id="gFast" aria-pressed="false">빨리 감기</button>
            <button type="button" class="g-btn" id="gBack">자리 다시 고르기</button>
          </div>
        </div>
      </div>
    </div>`;

    const $ = (id) => root.querySelector(id);
    const el = {
      led: $("#gLed"), chance: $("#gChance"), dots: $("#gDots"), band: $("#gBand"), stn: $("#gStn"),
      standing: $("#gStanding"), me: $("#gMe"), toast: $("#gToast"), pos: $("#gPos"), cabin: $("#gCabin"),
    };
    speed = 1;
    $("#gFast").addEventListener("click", (e) => {
      speed = speed === 1 ? 3 : 1;
      e.currentTarget.setAttribute("aria-pressed", String(speed > 1));
    });
    $("#gBack").addEventListener("click", () => { speed = 1; platform(); });
    root.querySelectorAll(".g-tabs button").forEach((b) => b.addEventListener("click", () => openSegment(Number(b.dataset.seg))));

    // 서 있는 사람: 뒷줄(좌석 앞)부터 채우고, 더 붐비면 화면 가장자리 앞줄까지
    const SLOTS = [
      [9, 0], [91, 0], [22, 0], [78, 0], [-3, 1], [103, 1], [14, 1], [86, 1], [2, 0], [98, 0], [33, 0], [67, 0],
    ];
    const standingFor = (load) => {
      const pct = congestionPct(load, info.capacity) ?? 60;
      const want = Math.max(0, Math.min(SLOTS.length, Math.round((pct - 25) / 11)));
      const cur = el.standing.querySelectorAll(".g-stander:not(.leave)").length;
      for (let k = cur; k < want; k++) {
        const [x, row] = SLOTS[k];
        const s = document.createElement("span");
        s.className = `g-stander row${row}`;
        s.style.left = `${x + (r() - 0.5) * 4}%`;
        s.style.setProperty("--h", (0.92 + r() * 0.16).toFixed(2));
        s.style.setProperty("--l", `${(row ? 6 : 12) + r() * 7}%`);
        s.style.setProperty("--d", `${(r() * 2).toFixed(2)}s`);
        s.innerHTML = person(r, { allowArm: true });
        el.standing.append(s);
      }
      [...el.standing.querySelectorAll(".g-stander:not(.leave)")].slice(want).forEach((s) => {
        s.classList.add("leave");
        setTimeout(() => s.remove(), 600);
      });
    };
    standingFor(f.boardLoad);

    // 창밖 풍경을 움직이는 엔진
    let x = 0, v = 0, target = 0, raf = 0, last = performance.now();
    const loop = (t) => {
      const dt = Math.min(0.05, (t - last) / 1000);
      last = t;
      v += (target - v) * Math.min(1, dt * 2.2 * speed);
      x += v * dt * speed;
      el.band.style.setProperty("--x", x.toFixed(1));
      if (token === run) raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    const MAXV = reduceMotion() ? 0 : 900;

    const toast = (html) => {
      el.toast.innerHTML = html;
      el.toast.classList.remove("show");
      void el.toast.offsetWidth;
      el.toast.classList.add("show");
    };

    const sitDown = (k) => {
      const seat = root.querySelector(`.g-seat[data-k="${k}"]`);
      const cab = el.cabin.getBoundingClientRect();
      const sr = seat.getBoundingClientRect();
      el.me.style.left = `${sr.left - cab.left + sr.width / 2}px`;
      el.me.style.bottom = `${cab.bottom - sr.bottom}px`;
      el.me.classList.add("sit");
      seat.classList.add("me");
    };

    const play = async () => {
      let seated = false;
      let seatedAt = null;
      let prevCum = 0;
      if (f.boardHasSeats) {
        await sleep(600, token);
        root.querySelectorAll(".g-seat").forEach((s, k) => k % 2 && s.classList.add("empty"));
        sitDown(3);
        seated = true;
        seatedAt = seg.nodes[0];
        toast(`타자마자 앉았어요`);
      }
      for (let j = 0; j < f.steps.length + 1; j++) {
        const isLast = j === f.steps.length;
        const name = stops[j];
        const from = j === 0 ? seg.nodes[0] : stops[j - 1];
        // 출발
        el.band.dataset.scene = sceneFor(seg.line, from, name);
        el.led.textContent = `이번 역은 ${name}`;
        el.dots.querySelectorAll("li").forEach((li, k) => {
          li.classList.toggle("done", k < j);
          li.classList.toggle("next", k === j);
        });
        const li = el.dots.querySelector(`li[data-i="${j}"]`);
        if (li) el.dots.scrollTo({ left: li.offsetLeft - el.dots.clientWidth / 2 + li.offsetWidth / 2, behavior: "smooth" });
        el.stn.classList.remove("in");
        target = MAXV;
        await sleep(2600, token);
        // 도착: 역 플랫폼이 창밖으로 들어옵니다
        const plate = el.stn.querySelector("b");
        plate.textContent = name;
        plate.classList.toggle("long", name.length >= 6);
        el.stn.classList.add("in");
        target = 0;
        await sleep(1300, token);
        if (isLast) break;

        const s = f.steps[j];
        const cum = s.cumulative ? s.cumulative[pos] : prevCum;
        el.chance.textContent = `${P(cum)}%`;
        if (seated) { prevCum = cum; standingFor(s.load); await sleep(500, token); continue; }

        const p = prevCum >= 1 ? 0 : Math.max(0, (cum - prevCum) / (1 - prevCum));
        prevCum = cum;
        const win = r() < p;
        const expect = s.perDoor ? s.perDoor[pos] / 2 : 0;
        let k = Math.floor(expect) + (r() < expect % 1 ? 1 : 0);
        k = Math.min(7, win ? Math.max(1, k) : k);

        // 앉아 있던 사람이 일어나 내립니다
        const order = [3, 2, 4, 1, 5, 0, 6];
        const freed = order.slice(0, k).filter((q) => !root.querySelector(`.g-seat[data-k="${q}"]`).classList.contains("me"));
        freed.forEach((q) => root.querySelector(`.g-seat[data-k="${q}"]`).classList.add("empty"));
        toast(k ? `${name} · 내 앞 ${k}명 내림` : `${name} · 내 앞에서 내린 사람 없음`);
        await sleep(900, token);
        if (win) {
          sitDown(freed[0]);
          seated = true;
          seatedAt = name;
          toast(`<b>${name}</b>에서 앉았어요`);
          freed.slice(1).forEach((q) => root.querySelector(`.g-seat[data-k="${q}"]`).classList.remove("empty"));
        } else if (k) {
          toast(`다른 사람이 먼저 앉았어요`);
          freed.forEach((q) => root.querySelector(`.g-seat[data-k="${q}"]`).classList.remove("empty"));
        }
        standingFor(s.load);
        await sleep(900, token);
      }
      cancelAnimationFrame(raf);
      finish(seated, seatedAt);
    };

    const finish = (seated, seatedAt) => {
      const idx = seg.nodes.indexOf(seatedAt);
      const bestLabel = doorLabel(ctx.best, f.doors);
      const head = seated
        ? (idx === 0 ? "타자마자 앉아서 갔어요" : `${seatedAt}에서 앉았어요`)
        : "끝까지 서서 갔어요";
      const sub = seated
        ? (idx > 0 ? `${idx}정거장 서서 가고, 남은 ${seg.nodes.length - 1 - idx}정거장은 앉아서 갔어요.` : "")
        : pos === ctx.best
          ? `이 자리가 가장 좋은 자리였지만 확률은 ${P(f.total[pos])}%였어요.`
          : metricMode(f) === "pct"
            ? `추천 자리 ${bestLabel}였다면 확률이 ${P(f.total[pos])}%에서 ${P(f.total[ctx.best])}%로 올라가요.`
            : `추천 자리 ${bestLabel}였다면 서서 가는 정거장이 평균 ${fmtWait(f.wait[pos])}에서 ${fmtWait(f.wait[ctx.best])}로 줄어요.`;
      const next = ctx.segIdx + 1 < ctx.plan.segments.length
        ? `<button type="button" class="g-btn primary" id="gNextSeg">${seg.nodes.at(-1)}에서 환승하기</button>` : "";
      const retryBest = !seated && pos !== ctx.best
        ? `<button type="button" class="g-btn primary" id="gBest">${bestLabel}에서 다시 타기</button>` : "";
      el.cabin.insertAdjacentHTML("beforeend", `<div class="g-end">
        <p class="g-end-k">${seg.nodes.at(-1)} 도착 · 한 번 굴려 본 결과</p>
        <p class="g-end-h">${head}</p>
        ${sub ? `<p class="g-end-s">${sub}</p>` : ""}
        <div class="g-end-b">${retryBest}${next}<button type="button" class="g-btn" id="gAgain">다시 타기</button></div>
      </div>`);
      root.querySelector("#gAgain").addEventListener("click", () => ride());
      root.querySelector("#gBest")?.addEventListener("click", () => { pick(ctx.best); ride(); });
      root.querySelector("#gNextSeg")?.addEventListener("click", () => openSegment(ctx.segIdx + 1));
    };

    play().catch(() => cancelAnimationFrame(raf));
  }

  return { show };
}
