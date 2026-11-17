"""1~9호선 연결망과 칸·문별 빈자리 추정 데이터를 만들어 web/data/model.json에 저장합니다.

단위
- 역(node): 호선 + 역 이름. 같은 이름이 여러 호선에 있으면 환승역입니다.
- 구간(edge): 역 a -> 다음 역 b. 혼잡도는 'a를 b 방향으로 출발할 때' 값입니다.
  분기역(2호선 성수·신도림, 5호선 강동, 6호선 응암)은 출발 방향마다 혼잡도 행이 따로 있습니다.

자리 예측은 혼잡도와 칸·문 위치가 공개된 서울교통공사 1~8호선 구간만 합니다.
9호선은 연결망(경로·환승)에만 들어갑니다.

계산 (구간 p -> n 으로 n에 도착하는 열차 한 대 기준, 혼잡도는 30분 단위)
1. 도착 승객 = 혼잡도(p -> n, 30분 구간) x 정원/100
2. n의 시간대 하차 인원 = 월 합계 / 요일 구분별 일수 (평일·토·일 비중은 혼잡도 합으로 배분)
3. 열차 한 대 하차 = 시간대 하차 x 이 방향 도착 승객 / sum(방향별 도착 승객 x 그 시간 실제 열차 수)
   열차 수는 역별 시간표(data/raw/timetable.csv)에서 p를 떠나 n에 서는 열차를 셉니다.
4. 문별 분배: 계단·에스컬레이터와 가까운 문에 가중치를 더 줍니다. [가정]

시간표는 web/data/tt/{호선}-{요일}.json으로 따로 내보내, 화면에서 실제 열차를 고르는 데 씁니다.
"""
import calendar
import json
import re
from pathlib import Path

import numpy as np
import pandas as pd

from seatcast.line9 import EXPRESS_STOPS
from seatcast.timetable import load_runs

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "raw"
WEB = ROOT / "web" / "data"
CONGESTION = RAW / "congestion_20260930.xlsx"

DAYTYPES = ("평일", "토요일", "일요일")
HOURS = list(range(5, 24))
SLOT_MIN = 30
CARS = {"1": 10, "2": 10, "3": 10, "4": 10, "5": 8, "6": 8, "7": 8, "8": 6, "9": 6}
DOORS = 4
SEATS_PER_CAR = 54
CAPACITY_PER_CAR = 160

# 문별 가중치 [가정] — 관찰 데이터로 보정할 값.
# 앉은 사람은 내릴 문이 아니라 빈자리가 있던 곳에 앉으므로 쏠림을 약하게 둡니다(3배로 두면 한 문에서 좌석 수보다 많이 비는 값이 나옴).
W_BASE = 1.0
W_FACILITY = {"계단": 1.5, "에스컬레이터": 1.5, "엘리베이터": 0.5}
W_NEIGHBOR = 0.5

# 이동 시간(분) — 경로 선택용 근사값
MIN_PER_STOP = 2.0
MIN_PER_EXPRESS_STATION = 1.3
MIN_TRANSFER = 4.0

# 혼잡도 행의 방향 표기 -> 빠른하차정보 방향 표기
LABEL_TO_QE = {"상선": "상행", "하선": "하행", "내선": "하행", "외선": "상행"}
QE_TO_LABEL = {
    "2": {"상행": "외선", "하행": "내선"},
    **{l: {"상행": "상선", "하행": "하선"} for l in "1345678"},
}

# 분기역에서 출발 방향마다 다른 혼잡도 행: (호선, 출발역, 다음 역) -> (역번호, 원래 역명)
DEPARTURE_ROW = {
    ("2", "성수", "뚝섬"): (9001, "성수E"),
    ("2", "성수", "용답"): (9002, "성수"),
    ("2", "성수", "건대입구"): (211, "성수"),
    ("2", "신도림", "도림천"): (9003, "신도림"),
    ("2", "신도림", "문래"): (234, "신도림"),
    ("2", "신도림", "대림"): (234, "신도림"),
    ("5", "강동", "길동"): (2549, "강동(하남검단산)"),
    ("5", "강동", "둔촌동"): (9005, "강동(마천)"),
    ("5", "강동", "천호"): (2549, "강동"),
    ("6", "응암", "역촌"): (9006, "응암S"),
    ("6", "응암", "새절"): (2611, "응암"),
}


def canon(name):
    name = re.sub(r"\(.*\)", "", str(name)).strip()
    return {"성수E": "성수", "응암S": "응암"}.get(name, name)


# ---------------------------------------------------------------- 노선 구조

def congestion_rows():
    """호선별로 파일에 적힌 순서대로 (역번호, 원래 역명) 목록."""
    x = pd.read_excel(CONGESTION, sheet_name="평일")
    x["line"] = x["호선"].str.replace("호선", "")
    rows = {}
    for line, g in x.groupby("line", sort=False):
        rows[line] = list(dict.fromkeys(zip(g["역번호"].astype(int), g["역명"])))
    return rows


def paths_from_rows(rows):
    """호선별 운행 경로(역 이름 순서). (경로, 양방향 여부) 목록."""
    names = {line: [canon(n) for _, n in r] for line, r in rows.items()}
    by_no = {line: {no: canon(n) for no, n in r} for line, r in rows.items()}
    paths = {}
    for line in ("1", "3", "4", "7", "8"):
        paths[line] = [(list(dict.fromkeys(names[line])), True)]

    loop = [by_no["2"][no] for no in range(201, 244)]
    paths["2"] = [
        (loop + [loop[0]], True),
        (["성수", "용답", "신답", "용두", "신설동"], True),
        (["신도림", "도림천", "양천구청", "신정네거리", "까치산"], True),
    ]

    five = names["5"]
    trunk = five[: five.index("강동") + 1]
    hanam = ["길동", "굽은다리", "명일", "고덕", "상일동", "강일", "미사", "하남풍산", "하남시청", "하남검단산"]
    macheon = ["둔촌동", "올림픽공원", "방이", "오금", "개롱", "거여", "마천"]
    paths["5"] = [(trunk + hanam, True), (trunk + macheon, True)]

    # 6호선: 신내 -> 응암 -> (응암 순환: 역촌·불광·독바위·연신내·구산) -> 응암 -> 신내, 한 방향으로만 돕니다
    six = list(dict.fromkeys(names["6"]))
    tail = six[six.index("새절"):]          # 새절 ... 신내
    loop6 = ["응암", "역촌", "불광", "독바위", "연신내", "구산", "응암"]
    paths["6"] = [(tail[::-1] + loop6 + tail, False)]

    # 서울교통공사 밖 구간: 혼잡도·칸 위치가 없어 자리 예보는 못 하지만 경로 안내를 위해 연결합니다.
    # 역 순서는 SearchSTNBySubwayLineInfo의 외부코드(FR_CODE) 순서입니다.
    l1_core = paths["1"][0][0]                       # 서울역 ... 청량리
    gyeongwon = ["연천", "전곡", "청산", "소요산", "동두천", "보산", "동두천중앙", "지행", "덕정", "덕계",
                 "양주", "녹양", "가능", "의정부", "회룡", "망월사", "도봉산", "도봉", "방학", "창동",
                 "녹천", "월계", "광운대", "석계", "신이문", "외대앞", "회기"]
    south = ["남영", "용산", "노량진", "대방", "신길", "영등포", "신도림", "구로"]
    gyeongin = ["구일", "개봉", "오류동", "온수", "역곡", "소사", "부천", "중동", "송내", "부개",
                "부평", "백운", "동암", "간석", "주안", "도화", "제물포", "도원", "동인천", "인천"]
    gyeongbu = ["가산디지털단지", "독산", "금천구청", "석수", "관악", "안양", "명학", "금정", "군포",
                "당정", "의왕", "성균관대", "화서", "수원", "세류", "병점", "세마", "오산대", "오산",
                "진위", "송탄", "서정리", "평택지제", "평택", "성환", "직산", "두정", "천안", "봉명",
                "쌍용", "아산", "탕정", "배방", "온양온천", "신창"]
    trunk1 = gyeongwon + l1_core[::-1] + south      # 연천 ... 청량리 ... 서울역 ... 구로
    paths["1"] = [
        (trunk1 + gyeongin, True),
        (trunk1 + gyeongbu, True),
        (["금천구청", "광명"], True),
        (["병점", "서동탄"], True),
    ]
    ilsan = ["대화", "주엽", "정발산", "마두", "백석", "대곡", "화정", "원당", "원흥", "삼송"]
    paths["3"] = [(ilsan + paths["3"][0][0], True)]
    jinjeop = ["진접", "오남", "별내별가람"]
    gwacheon_ansan = ["선바위", "경마공원", "대공원", "과천", "정부과천청사", "인덕원", "평촌", "범계",
                      "금정", "산본", "수리산", "대야미", "반월", "상록수", "한대앞", "중앙", "고잔",
                      "초지", "안산", "신길온천", "정왕", "오이도"]
    paths["4"] = [(jinjeop + paths["4"][0][0] + gwacheon_ansan, True)]
    bupyeong = ["까치울", "부천종합운동장", "춘의", "신중동", "부천시청", "상동", "삼산체육관",
                "굴포천", "부평구청", "산곡", "석남"]
    paths["7"] = [(paths["7"][0][0] + bupyeong, True)]
    byeollae = ["별내", "다산", "동구릉", "구리", "장자호수공원"]
    paths["8"] = [(byeollae + paths["8"][0][0], True)]
    return paths


def line9_path():
    s = pd.read_csv(RAW / "stations_all.csv", dtype=str)
    s9 = s[s["LINE_NUM"] == "09호선"].sort_values("FR_CODE")
    return [canon(n) for n in s9["STATION_NM"]]


def directed_edges(paths):
    """호선별 구간 목록 [(a, b, 다음 c 또는 None)]. c는 같은 방향으로 이어지는 다음 역."""
    out = {}
    for line, plist in paths.items():
        triples = set()
        for seq, both in plist:
            dirs = [seq, seq[::-1]] if both else [seq]
            for s in dirs:
                for i in range(len(s) - 1):
                    nxt = s[i + 2] if i + 2 < len(s) else None
                    triples.add((s[i], s[i + 1], nxt))
        out[line] = sorted(triples, key=lambda t: (t[0], t[1], t[2] or ""))
    return out


# ---------------------------------------------------------------- 혼잡도

def load_congestion():
    frames = []
    for dt in DAYTYPES:
        x = pd.read_excel(CONGESTION, sheet_name=dt)
        slots = [c for c in x.columns if "~" in str(c)]
        x["line"] = x["호선"].str.replace("호선", "")
        long = x.melt(id_vars=["line", "역번호", "역명", "상하구분"], value_vars=slots,
                      var_name="slot", value_name="cong")
        hh = long["slot"].str.slice(0, 2).astype(int)
        mm = long["slot"].str.slice(3, 5).astype(int)
        # 자정 넘은 구간(00:00~00:30)은 전날 운행이라 24시로 봅니다
        long["slot"] = (hh + 24 * (hh < 3)) * 60 + mm
        long["daytype"] = dt
        frames.append(long)
    df = pd.concat(frames)
    df["역번호"] = df["역번호"].astype(int)
    return df.groupby(["line", "역번호", "역명", "상하구분", "daytype", "slot"])["cong"].mean()


def slot_hour(slot):
    return (slot // 60) % 24


def load_doors():
    frames = []
    for line in "12345678":
        q = pd.read_csv(RAW / f"quick_exit_{line}호선.csv", dtype=str)
        q["line"] = line
        frames.append(q)
    q = pd.concat(frames)
    q["stn"] = q["stnNm"].map(canon)
    q["next"] = q["drtnInfo"].map(lambda v: canon(v) if isinstance(v, str) else None)
    cd = q["qckgffVhclDoorNo"].str.extract(r"^(\d+)-(\d+)$")
    q["car"], q["door"] = pd.to_numeric(cd[0]), pd.to_numeric(cd[1])
    return q.dropna(subset=["car", "door"])


def edge_label(doors, line, a, b, fallback=None):
    """구간 a -> b의 혼잡도 방향 표기. 빠른하차정보에서 'a에서 b 방면'이 몇 행인지로 판단합니다."""
    rows = doors[(doors["line"] == line) & (doors["stn"] == a) & (doors["next"] == b)]
    if len(rows):
        return QE_TO_LABEL[line][rows["upbdnbSe"].mode().iat[0]]
    rows = doors[(doors["line"] == line) & (doors["stn"] == b) & (doors["next"] == a)]
    if len(rows):  # 반대 방향 표기를 뒤집습니다
        opposite = {"상행": "하행", "하행": "상행"}[rows["upbdnbSe"].mode().iat[0]]
        return QE_TO_LABEL[line][opposite]
    return fallback


def label_rows(rows, line):
    return {canon(n): [] for _, n in rows[line]}


# ---------------------------------------------------------------- 승하차

def days_in_month(ym):
    y, m = divmod(int(ym), 100)
    n = dict.fromkeys(DAYTYPES, 0)
    for d in range(1, calendar.monthrange(y, m)[1] + 1):
        wd = calendar.weekday(y, m, d)
        n["평일" if wd < 5 else "토요일" if wd == 5 else "일요일"] += 1
    return n


def load_ridership():
    r = pd.read_csv(RAW / "ridership_hourly.csv")
    r["line"] = r["SBWY_ROUT_LN_NM"].str.extract(r"^(\d)호선")[0]
    r = r.dropna(subset=["line"])
    r["name"] = r["STTN"].map(canon)
    parts = []
    for h in range(24):
        p = r[["USE_MM", "line", "name", f"HR_{h}_GET_ON_NOPE", f"HR_{h}_GET_OFF_NOPE"]].copy()
        p.columns = ["month", "line", "name", "on", "off"]
        p["hour"] = h
        parts.append(p)
    return pd.concat(parts).groupby(["month", "line", "name", "hour"])[["on", "off"]].sum()


# ---------------------------------------------------------------- 시간표 내보내기

def write_timetables(runs, station_order):
    """호선·요일별 열차 목록. 정차역은 station_order의 번호, 시각은 자정부터 30초 단위 정수.

    {"dests": [행선지...], "trains": [[행선지, 급행 0/1, 열차번호, 역0, 시각0, 역1, 시각1, ...], ...]}
    행선지는 번호 하나, 또는 순환선처럼 운행 중에 바뀌면 [[정차 순번, 행선지 번호], ...]입니다.
    열차번호는 숫자만 남긴 값입니다(시간표 'K402'와 실시간 도착정보 '0402'를 맞추기 위해).
    첫 역은 출발 시각, 나머지는 도착 시각입니다(타는 역은 출발, 내리는 역은 도착을 쓰기 위해
    역마다 출발 시각도 필요하면 도착 + 30초로 봅니다).
    """
    out_dir = WEB / "tt"
    out_dir.mkdir(parents=True, exist_ok=True)
    groups = {}
    for r in runs:
        groups.setdefault((r["line"], r["daytype"]), []).append(r)
    for (line, dt), rs in groups.items():
        idx = {n: i for i, n in enumerate(station_order[line])}
        dests, trains = [], []
        def di(name):
            if name not in dests:
                dests.append(name)
            return dests.index(name)

        for r in sorted(rs, key=lambda r: r["stops"][0][2]):
            legs = r.get("legs")
            dest = [[i, di(d)] for i, d in legs] if legs else di(r["dest"])
            no = re.sub(r"\D", "", r["train"])
            row = [dest, int(r["express"]), int(no) if no else 0]
            for k, (name, a, b) in enumerate(r["stops"]):
                if name not in idx:
                    break
                row += [idx[name], (b if k == 0 else a) // 30]
            if len(row) >= 7:
                trains.append(row)
        (out_dir / f"{line}-{DAYTYPES.index(dt)}.json").write_text(
            json.dumps({"dests": dests, "trains": trains}, separators=(",", ":")), encoding="utf-8")


# ---------------------------------------------------------------- 조립

def build():
    rows = congestion_rows()
    paths = paths_from_rows(rows)
    edges = directed_edges(paths)
    doors = load_doors()
    cong = load_congestion()
    ride = load_ridership()

    # 구간별 출발 혼잡도 시계열: (line, a, b) -> {(daytype, hour): %}
    row_names = {line: {} for line in rows}
    for line, r in rows.items():
        for no, n in r:
            row_names[line].setdefault(canon(n), []).append((no, n))

    dep = {}
    missing = []
    for line, triples in edges.items():
        for a, b, _ in triples:
            if (line, a, b) in dep:
                continue
            label = edge_label(doors, line, a, b)
            if (line, a, b) in DEPARTURE_ROW:
                cands = [DEPARTURE_ROW[(line, a, b)]]
            else:
                cands = row_names[line].get(a, [])
            series = None
            for no, n in cands:
                labels = [label] if label else ["상선", "하선", "내선", "외선"]
                for lb in labels:
                    try:
                        s = cong.loc[(line, no, n, lb)]
                    except KeyError:
                        continue
                    if s.sum() > 0:
                        series = s
                        break
                if series is not None:
                    break
            if series is None:
                missing.append((line, a, b, label))
            else:
                dep[(line, a, b)] = series

    slots = sorted(cong.index.get_level_values("slot").unique())

    def dep_val(line, a, b, dt, slot):
        s = dep.get((line, a, b))
        if s is None:
            return np.nan
        return float(s.get((dt, slot), np.nan))

    # 하루 승하차(요일 구분별): 혼잡도 합으로 평일·토·일 비중을 나눕니다
    activity = {}
    for (line, a, b), s in dep.items():
        for (dt, slot), v in s.items():
            k = (line, a, dt, slot_hour(slot))
            activity[k] = activity.get(k, 0) + v
    daily = {}
    months = ride.index.get_level_values("month").unique()
    for ym in months:
        n = days_in_month(ym)
        g = ride.loc[ym]
        for (line, name, h), v in g.iterrows():
            w = {dt: activity.get((line, name, dt, h), 0) for dt in DAYTYPES}
            denom = sum(n[dt] * w[dt] for dt in DAYTYPES)
            if denom <= 0:
                continue
            for dt in DAYTYPES:
                key = (line, name, dt, h)
                f = w[dt] / denom
                acc = daily.setdefault(key, [0.0, 0.0, 0])
                acc[0] += v["on"] * f
                acc[1] += v["off"] * f
                acc[2] += 1
    daily = {k: (on / c, off / c) for k, (on, off, c) in daily.items()}

    # 시간표에서 구간별 실제 열차 수: (line, p, n) -> {(daytype, hour): 대수}
    runs = load_runs(list(CARS))
    trains = {}
    for r in runs:
        for (p, _, t), (n, _, _) in zip(r["stops"], r["stops"][1:]):
            k = (r["line"], p, n)
            hk = (r["daytype"], slot_hour(t // 60))
            trains.setdefault(k, {})
            trains[k][hk] = trains[k].get(hk, 0) + 1

    # 구간별 열차 한 대당 도착 승객과 하차 인원 (30분 구간마다)
    alight, load = {}, {}
    for line, triples in edges.items():
        if line == "9":
            continue
        ppp = CARS[line] * CAPACITY_PER_CAR / 100
        incoming = {}
        for p, n, _ in triples:
            incoming.setdefault(n, set()).add(p)
        for p, n in {(p, n) for p, n, _ in triples}:
            key = f"{line}|{p}|{n}"
            A, L = {}, {}
            for dt in DAYTYPES:
                a_list, l_list = [], []
                for slot in slots:
                    h = slot_hour(slot)
                    arr = dep_val(line, p, n, dt, slot) * ppp
                    flow = 0.0  # n에 도착하는 모든 방향의 시간당 승객
                    for q in incoming[n]:
                        v = dep_val(line, q, n, dt, slot) * ppp
                        t = trains.get((line, q, n), {}).get((dt, h), 0)
                        if v == v:
                            flow += v * t
                    off = daily.get((line, n, dt, h), (0, 0))[1]
                    if arr != arr or flow <= 0 or not trains.get((line, p, n), {}).get((dt, h)):
                        a_list.append(None)
                        l_list.append(None)
                        continue
                    a_list.append(round(min(off * arr / flow, arr), 1))
                    l_list.append(round(arr, 1))
                A[dt], L[dt] = a_list, l_list
            alight[key], load[key] = A, L

    # 구간별 문 가중치: n에 도착해 c 방면으로 계속 가는 열차의 문 (없으면 같은 방향 표기의 문)
    door_w = {}
    for line, triples in edges.items():
        n_doors = CARS[line] * DOORS
        for p, n, c in triples:
            key = f"{line}|{p}|{n}"
            if key in door_w:
                continue
            sub = doors[(doors["line"] == line) & (doors["stn"] == n)]
            if c is not None:
                pick = sub[sub["next"] == c]
            else:
                label = edge_label(doors, line, p, n)
                qe = LABEL_TO_QE.get(label)
                pick = sub[sub["upbdnbSe"] == qe] if qe else sub.iloc[0:0]
            w = np.full(n_doors, W_BASE)
            for _, row in pick.iterrows():
                i = int((row["car"] - 1) * DOORS + (row["door"] - 1))
                if not 0 <= i < n_doors:
                    continue
                bonus = W_FACILITY.get(row["plfmCmgFac"], 1.0)
                w[i] += bonus
                for j in (i - 1, i + 1):
                    if 0 <= j < n_doors:
                        w[j] += bonus * W_NEIGHBOR
            door_w[key] = (w / w.sum()).round(4).tolist()

    # 경로 탐색용 연결망 (1~9호선)
    nine = line9_path()
    route_edges = []
    for line, triples in edges.items():
        for a, b in {(a, b) for a, b, _ in triples}:
            route_edges.append([f"{line}:{a}", f"{line}:{b}", MIN_PER_STOP, "local"])
    for a, b in zip(nine, nine[1:]):
        route_edges.append([f"9:{a}", f"9:{b}", MIN_PER_STOP, "local"])
        route_edges.append([f"9:{b}", f"9:{a}", MIN_PER_STOP, "local"])
    exp = [s for s in nine if s in EXPRESS_STOPS]
    for a, b in zip(exp, exp[1:]):
        span = nine.index(b) - nine.index(a)
        cost = round(span * MIN_PER_EXPRESS_STATION, 2)
        route_edges.append([f"9:{a}", f"9:{b}", cost, "express"])
        route_edges.append([f"9:{b}", f"9:{a}", cost, "express"])

    station_order = {}
    for line, plist in paths.items():
        order = []
        for seq, _ in plist:
            for s in seq:
                if s not in order:
                    order.append(s)
        station_order[line] = order
    station_order["9"] = nine

    model = {
        "meta": {
            "slots": [int(x) for x in slots], "slot_min": SLOT_MIN, "daytypes": list(DAYTYPES),
            "lines": {l: {"cars": CARS[l], "doors": DOORS, "seats": CARS[l] * SEATS_PER_CAR,
                          "capacity": CARS[l] * CAPACITY_PER_CAR, "forecast": l != "9"}
                      for l in station_order},
            "transfer_min": MIN_TRANSFER,
            "line9_line9_express": EXPRESS_STOPS,
            "assumptions": {"w_base": W_BASE, "w_facility": W_FACILITY, "w_neighbor": W_NEIGHBOR},
        },
        "stations": station_order,
        "edges": route_edges,
        "arrive_load": load,
        "alight": alight,
        "door_weights": door_w,
    }
    WEB.mkdir(parents=True, exist_ok=True)
    write_timetables(runs, station_order)
    (WEB / "model.json").write_text(json.dumps(model, ensure_ascii=False, separators=(",", ":")),
                                    encoding="utf-8")
    return model, missing


if __name__ == "__main__":
    m, missing = build()
    size = (WEB / "model.json").stat().st_size / 1e6
    print(f"model.json {size:.2f} MB | stations", {l: len(v) for l, v in m["stations"].items()})
    print("route edges", len(m["edges"]), "| forecast edges", len(m["alight"]))
    print("edges without congestion:", missing[:20], len(missing))
    tt = sorted((WEB / "tt").glob("*.json"))
    print("timetables", len(tt), f"{sum(p.stat().st_size for p in tt) / 1e6:.2f} MB")
