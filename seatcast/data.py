"""원본 데이터 세 개를 2호선 본선(201~243) 기준으로 통일합니다.

- 역: 역번호를 키로 쓰고, 이름의 괄호 부기는 떼어냅니다 (예: '삼성(무역센터)' -> '삼성').
- 방향: 내선 = 역번호가 커지는 방향(시계 방향), 외선 = 작아지는 방향.
  평일 아침 혼잡도가 잠실->강남(내선), 사당->강남(외선)에서 줄어드는 것으로 확인했습니다.
- 혼잡도: 해당 역을 출발할 때의 열차 혼잡도(%)입니다. 34%면 좌석이 모두 찬 상태입니다.
"""
import re
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "raw"
OUT = ROOT / "data" / "processed"

FIRST, LAST = 201, 243
LOOP = list(range(FIRST, LAST + 1))
DIRS = ("내선", "외선")
DAYTYPES = ("평일", "토요일", "일요일")


def canon(name):
    return re.sub(r"\(.*\)", "", str(name)).strip()


def next_station(no, direction, k=1):
    """내선이면 번호가 커지고, 외선이면 작아집니다. 순환선이라 끝에서 처음으로 이어집니다."""
    i = LOOP.index(no)
    step = k if direction == "내선" else -k
    return LOOP[(i + step) % len(LOOP)]


def prev_station(no, direction):
    return next_station(no, direction, -1)


def load_congestion(path=RAW / "congestion_20260930.xlsx"):
    frames = []
    for dt in DAYTYPES:
        x = pd.read_excel(path, sheet_name=dt)
        x = x[(x["호선"] == "2호선") & x["역번호"].between(FIRST, LAST)]
        slots = [c for c in x.columns if "~" in str(c)]
        long = x.melt(id_vars=["역번호", "상하구분"], value_vars=slots,
                      var_name="slot", value_name="cong")
        long["daytype"] = dt
        frames.append(long)
    df = pd.concat(frames).rename(columns={"역번호": "no", "상하구분": "dir"})
    df["no"] = df["no"].astype(int)
    start = df["slot"].str.slice(0, 5)
    df["hour"] = start.str.slice(0, 2).astype(int) % 24
    df["slot"] = start
    return df[["daytype", "no", "dir", "slot", "hour", "cong"]]


def load_ridership(path=RAW / "ridership_hourly.csv", stations=None):
    r = pd.read_csv(path)
    r = r[r["SBWY_ROUT_LN_NM"] == "2호선"].copy()
    r["name"] = r["STTN"].map(canon)
    r = r.merge(stations, on="name", how="inner")
    rows = []
    for h in range(24):
        on, off = f"HR_{h}_GET_ON_NOPE", f"HR_{h}_GET_OFF_NOPE"
        part = r[["USE_MM", "no", "name", on, off]].rename(columns={on: "on", off: "off"})
        part["hour"] = h
        rows.append(part)
    df = pd.concat(rows).rename(columns={"USE_MM": "month"})
    return df[["month", "no", "name", "hour", "on", "off"]]


def load_doors(path=RAW / "quick_exit_2호선.csv", stations=None):
    q = pd.read_csv(path, dtype={"stnNo": str})
    q = q[q["stnNo"].str.fullmatch(r"\d{3}")].copy()
    q["no"] = q["stnNo"].astype(int)
    q = q[q["no"].between(FIRST, LAST)]
    name_to_no = dict(zip(stations["name"], stations["no"]))
    nxt = q["drtnInfo"].map(canon).map(name_to_no)

    def direction(row_no, next_no):
        if next_no == next_station(row_no, "내선"):
            return "내선"
        if next_no == next_station(row_no, "외선"):
            return "외선"
        return None

    q["dir"] = [direction(a, b) for a, b in zip(q["no"], nxt)]
    car_door = q["qckgffVhclDoorNo"].str.extract(r"^(\d+)-(\d+)$").astype(float)
    q["car"], q["door"] = car_door[0], car_door[1]
    q = q.dropna(subset=["dir", "car", "door"])
    q[["car", "door"]] = q[["car", "door"]].astype(int)
    return q[["no", "dir", "car", "door", "plfmCmgFac"]].rename(
        columns={"plfmCmgFac": "facility"}).drop_duplicates()


def build():
    OUT.mkdir(parents=True, exist_ok=True)
    cong = load_congestion()
    names = pd.read_excel(RAW / "congestion_20260930.xlsx", sheet_name="평일")
    names = names[(names["호선"] == "2호선") & names["역번호"].between(FIRST, LAST)]
    stations = (names[["역번호", "역명"]].drop_duplicates()
                .rename(columns={"역번호": "no", "역명": "name"}))
    stations["no"] = stations["no"].astype(int)
    stations["name"] = stations["name"].map(canon)
    stations = stations.sort_values("no").reset_index(drop=True)

    ride = load_ridership(stations=stations)
    doors = load_doors(stations=stations)

    stations.to_csv(OUT / "stations.csv", index=False)
    cong.to_csv(OUT / "congestion.csv", index=False)
    ride.to_csv(OUT / "ridership.csv", index=False)
    doors.to_csv(OUT / "doors.csv", index=False)
    return stations, cong, ride, doors


if __name__ == "__main__":
    s, c, r, d = build()
    print(f"stations {len(s)} | congestion {len(c)} | ridership {len(r)} | doors {len(d)}")
    print("stations without ridership:", sorted(set(s.no) - set(r.no)))
    print("station-directions without doors:",
          sorted({(n, dr) for n in s.no for dr in DIRS} - set(zip(d.no, d.dir))))
