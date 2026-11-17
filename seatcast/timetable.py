"""역별 시간표(data/raw/timetable.csv)를 열차 한 대의 운행(정차역과 시각 목록)으로 묶습니다.

시간표 API는 역 하나의 도착·출발 시각만 주므로, 열차 번호로 묶은 뒤 시각 순으로 정렬해 운행을 만듭니다.
- 같은 번호를 하루에 여러 번 쓰는 호선이 있어, 앞 역과 20분 넘게 벌어지면 다른 열차로 봅니다.
- 6호선 응암순환처럼 운행 중에 방향 표기가 바뀌는 열차는, 앞 운행이 끝난 역에서 바로 이어지면 하나로 합칩니다.
- 시각은 자정부터 센 초입니다. 새벽 0~2시는 전날 운행이라 24시간을 더합니다.
"""
import re
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
TIMETABLE = ROOT / "data" / "raw" / "timetable.csv"
WEEK = {"1": "평일", "2": "토요일", "3": "일요일"}  # 3은 휴일(일요일·공휴일)
MAX_GAP = 20 * 60
JOIN_GAP = 5 * 60
# 번호만 바꿔 같은 방향으로 계속 달리는 역(역 -> 허용 간격 초)
# 6호선 응암순환: 신내 쪽에서 온 열차가 응암에서 번호를 바꿔(짝수 -> 홀수) 순환선으로 나갑니다
# 2호선 순환선: 한 바퀴를 돌 때마다 성수에서 번호가 바뀝니다(예: 2017 -> 2061, 30초 뒤 출발)
# 값: (허용 간격 초, 이어질 수 없는 다음 역). 성수에서 용답으로 가는 열차는 성수지선이라 순환과 다른 열차입니다.
RENUMBER_AT = {("6", "응암"): (3 * 60, set()), ("2", "성수"): (2 * 60, {"용답"})}


def _sec(v):
    """'HH:MM:SS' -> 초. 9호선 급행역 일부는 원본이 '08::3:8:'처럼 일의 자리가 빠져 있어
    십의 자리로 어림한 값(음수로 표시)을 돌려주고, 운행으로 묶은 뒤 앞뒤 역 시각으로 보간합니다."""
    if not isinstance(v, str) or v == "00:00:00":
        return None
    m = re.fullmatch(r"(\d\d):(\d\d):(\d\d)", v)
    if m:
        h, mi, s = (int(x) for x in m.groups())
        rough = False
    else:
        m = re.fullmatch(r"(\d\d)::(\d):(\d):", v)
        if not m:
            return None
        h, mi, s = int(m[1]), int(m[2]) * 10 + 5, int(m[3]) * 10
        rough = True
    if h < 3:
        h += 24
    t = h * 3600 + mi * 60 + s
    return -t if rough else t


def _canon(name):
    return re.sub(r"\(.*\)", "", str(name)).strip()


def load_runs(lines=None):
    """[{line, daytype, dest, express, stops: [(역, 도착초, 출발초), ...]}] 목록."""
    d = pd.read_csv(TIMETABLE, dtype=str)
    d["line"] = d["LINE_NUM"].str.extract(r"^0?(\d)호선")[0]
    d = d.dropna(subset=["line"])
    if lines:
        d = d[d["line"].isin(lines)]
    d["name"] = d["STATION_NM"].map(_canon)
    arr = d["ARRIVETIME"].map(_sec)
    dep = d["LEFTTIME"].map(_sec)
    d["arr"] = arr.fillna(dep)
    d["dep"] = dep.fillna(arr)
    d = d.dropna(subset=["arr"])
    d["rough"] = d["arr"] < 0
    d["arr"] = d["arr"].abs().astype(int)
    d["dep"] = d["dep"].abs().astype(int)
    d = d.sort_values(["line", "WEEK_TAG", "TRAIN_NO", "INOUT_TAG", "arr"])

    runs = []
    for (line, week, train, _), g in d.groupby(["line", "WEEK_TAG", "TRAIN_NO", "INOUT_TAG"], sort=False):
        cur, last = None, None
        for name, a, b, dest, exp, rough in zip(g["name"], g["arr"], g["dep"], g["SUBWAYENAME"],
                                                g["EXPRESS_YN"], g["rough"]):
            if cur is None or a - last > MAX_GAP:
                cur = {"line": line, "daytype": WEEK[week], "train": train, "dest": _canon(dest),
                       "express": exp == "D", "stops": [], "rough": []}
                runs.append(cur)
            if cur["stops"] and cur["stops"][-1][0] == name and a - cur["stops"][-1][2] < 60:
                continue  # 같은 역이 중복으로 찍힌 행
            cur["stops"].append((name, a, b))
            cur["rough"].append(rough)
            last = b
    for r in runs:
        _fix_rough(r)
    return _join(runs)


def _fix_rough(r):
    """어림 시각인 역은 앞뒤 정확한 역 사이를 정차 순서대로 나눠 채웁니다."""
    rough = r.pop("rough")
    if not any(rough):
        return
    good = [i for i, x in enumerate(rough) if not x]
    if len(good) < 2:
        return
    st = r["stops"]
    for i, x in enumerate(rough):
        if not x:
            continue
        lo = max([g for g in good if g < i], default=None)
        hi = min([g for g in good if g > i], default=None)
        if lo is None or hi is None:
            continue
        t = st[lo][2] + (st[hi][1] - st[lo][2]) * (i - lo) / (hi - lo)
        st[i] = (st[i][0], int(t), int(t) + 30)


def _join(runs):
    """방향 표기만 바뀐 같은 열차를 이어 붙입니다.
    6호선은 응암에서 끝난 운행 뒤에 같은 번호가 2~3분 뒤 역촌에서 다시 시작하므로, 역이 달라도
    같은 번호가 JOIN_GAP 안에 이어 출발하면 한 열차로 봅니다."""
    by_train, by_station = {}, {}
    for r in runs:
        by_train.setdefault((r["line"], r["daytype"], r["train"]), []).append(r)
        by_station.setdefault((r["line"], r["daytype"], r["stops"][0][0]), []).append(r)
    used = set()
    out = []
    for r in sorted(runs, key=lambda r: r["stops"][0][1]):
        if id(r) in used:
            continue
        used.add(id(r))
        while True:
            last_name, _, b = r["stops"][-1]
            # 종착역에서 같은 번호로 되돌아 나가는 열차(회차)는 다른 운행으로 둡니다.
            # 2호선 순환처럼 같은 역에서 같은 방향으로 계속 가면(바로 앞 역으로 돌아가지 않으면) 이어 붙입니다.
            prev = r["stops"][-2][0] if len(r["stops"]) >= 2 else None
            nxt = [x for x in by_train[(r["line"], r["daytype"], r["train"])]
                   if id(x) not in used and 0 <= x["stops"][0][1] - b <= JOIN_GAP
                   and (x["stops"][0][0] != last_name or len(x["stops"]) == 1
                        or x["stops"][1][0] != prev)]
            gap, banned = RENUMBER_AT.get((r["line"], last_name), (None, set()))
            if not nxt and gap and prev not in banned:
                nxt = [x for x in by_station.get((r["line"], r["daytype"], last_name), [])
                       if id(x) not in used and 0 <= x["stops"][0][2] - b <= gap
                       and (len(x["stops"]) == 1 or x["stops"][1][0] not in banned | {prev})]
            if not nxt:
                break
            x = min(nxt, key=lambda x: x["stops"][0][1])
            used.add(id(x))
            skip = 1 if x["stops"][0][0] == last_name else 0
            # 이어 붙인 뒤에도 구간마다 원래 행선지를 보여 주도록 바뀌는 위치를 기록합니다
            r.setdefault("legs", [(0, r["dest"])])
            r["legs"].append((len(r["stops"]) - 1 + skip, x["dest"]))
            r["stops"] = r["stops"] + x["stops"][skip:]
            r["dest"] = x["dest"]
            r["train"] = x["train"]  # 번호가 바뀐 경우 이후 운행은 새 번호로 찾습니다
        if len(r["stops"]) >= 2:
            out.append(r)
    return out
