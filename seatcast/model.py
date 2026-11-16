"""칸·문별 '앞으로 생길 빈자리' 추정 모델 (첫 버전).

계산 순서
1. 하루 하차 인원: 월 합계 승하차를 요일 구분별 하루 값으로 나눕니다.
   평일/토/일 비중은 같은 역·시간의 혼잡도 합으로 정합니다.
2. 열차 한 대당 하차 인원: 하루 하차 인원을 방향별로 나누고(도착 열차 혼잡도 비율),
   시간당 열차 수로 나눕니다. 시간당 열차 수는 '승하차 순증감 = 혼잡도 변화' 관계를
   회귀해 데이터에서 역산합니다.
3. 문별 분배: 계단·에스컬레이터와 가까운 문(빠른하차정보)에 가중치를 더 줍니다. [가정]
4. 빈자리: 내리는 사람 중 앉아 있던 사람의 비율 = 좌석 수 / 도착 시 승객 수. [가정]

가정이 들어간 단계(3, 4)는 직접 탑승 관찰로 검증합니다.
"""
import calendar
import json
from pathlib import Path

import numpy as np
import pandas as pd

from seatcast.data import DAYTYPES, DIRS, LOOP, OUT, ROOT, prev_station

CARS, DOORS = 10, 4
SEATS_PER_TRAIN = 540          # 2호선 10량 x 54석
PERSONS_PER_PCT = 16           # 혼잡도 1% = 정원 1,600명의 1%
HOURS = list(range(5, 24))
MIN_TPH = 6.0                  # 첫차 시간대처럼 표본이 적을 때 비현실적으로 작게 나오는 값을 막습니다

# 문별 가중치 [가정] — 관찰 데이터로 보정할 값
W_BASE = 1.0
W_FACILITY = {"계단": 3.0, "에스컬레이터": 3.0, "엘리베이터": 1.0}
W_NEIGHBOR = 0.5               # 설비 문 바로 옆 문으로 퍼지는 정도


def days_in_month(ym):
    y, m = divmod(int(ym), 100)
    n = dict.fromkeys(DAYTYPES, 0)
    for d in range(1, calendar.monthrange(y, m)[1] + 1):
        wd = calendar.weekday(y, m, d)
        n["평일" if wd < 5 else "토요일" if wd == 5 else "일요일"] += 1
    return n


def hourly_congestion(cong):
    return cong.groupby(["daytype", "no", "dir", "hour"])["cong"].mean()


def daily_ridership(ride, ch):
    """(daytype, no, hour) -> 하루 평균 승차/하차 인원 (12개월 평균)."""
    level = ch.groupby(["daytype", "no", "hour"]).sum().unstack("daytype").fillna(0)
    out = []
    for ym, g in ride.groupby("month"):
        n = days_in_month(ym)
        g = g.set_index(["no", "hour"])[["on", "off"]]
        w = level.reindex(g.index).fillna(0)
        denom = sum(n[dt] * w[dt] for dt in DAYTYPES).replace(0, np.nan)
        for dt in DAYTYPES:
            f = (w[dt] / denom).fillna(0)
            part = g.mul(f, axis=0)
            part["daytype"] = dt
            out.append(part.reset_index())
    df = pd.concat(out)
    return df.groupby(["daytype", "no", "hour"])[["on", "off"]].mean()


def trains_per_hour(daily, ch, transfer_free=None):
    """승하차 순증감(하루, 역 전체)과 열차당 혼잡도 변화(양방향 합)를 회귀해 시간당 열차 수를 구합니다.
    상관이 약한 시간대(낮)는 앞뒤 시간대 값으로 채웁니다."""
    rows = []
    for (dt, no, dr, h), v in ch.items():
        p = ch.get((dt, prev_station(no, dr), dr, h))
        if p is not None:
            rows.append((dt, no, h, (v - p) * PERSONS_PER_PCT))
    dl = pd.DataFrame(rows, columns=["daytype", "no", "hour", "dL"]).groupby(
        ["daytype", "no", "hour"])["dL"].sum()
    j = daily.join(dl, how="inner")
    j["net"] = j["on"] - j["off"]
    if transfer_free is not None:
        j = j[j.index.get_level_values("no").isin(transfer_free)]
    result = {}
    for dt in DAYTYPES:
        est = {}
        for h in HOURS:
            try:
                g = j.loc[(dt, slice(None), h)]
            except KeyError:
                continue
            x, y = g["net"].to_numpy(), g["dL"].to_numpy()
            if len(x) < 5 or (x * x).sum() == 0:
                continue
            k = (x * y).sum() / (x * x).sum()
            r = np.corrcoef(x, y)[0, 1]
            if k > 0 and r >= 0.6:
                est[h] = 1 / k
        s = pd.Series(est, dtype=float).reindex(HOURS)
        s = s.interpolate(limit_direction="both").clip(lower=MIN_TPH)
        result[dt] = s.round(2).to_dict()
    # 주말은 승하차가 적어 회귀가 불안정합니다(토요일 8시 38대처럼 평일 출근보다 많게 나옴).
    # 주말 배차는 평일 낮과 비슷하다고 보고 평일 10~16시 중앙값을 씁니다. [가정]
    midday = float(np.median([result["평일"][h] for h in range(10, 17)]))
    for dt in ("토요일", "일요일"):
        result[dt] = {h: round(midday, 2) for h in HOURS}
    return result


def door_weights(doors):
    """(no, dir) -> 40개 문의 하차 비율."""
    weights = {}
    for no in LOOP:
        for dr in DIRS:
            w = np.full(CARS * DOORS, W_BASE)
            sub = doors[(doors["no"] == no) & (doors["dir"] == dr)]
            for _, row in sub.iterrows():
                i = (row["car"] - 1) * DOORS + (row["door"] - 1)
                if not 0 <= i < len(w):
                    continue
                bonus = W_FACILITY.get(row["facility"], 1.0)
                w[i] += bonus
                for j in (i - 1, i + 1):
                    if 0 <= j < len(w):
                        w[j] += bonus * W_NEIGHBOR
            weights[(no, dr)] = (w / w.sum()).round(4).tolist()
    return weights


# 환승역은 환승객이 개찰구를 거치지 않아 승하차 집계와 혼잡도 변화가 어긋나므로 열차 수 추정에서 뺍니다.
TRANSFER = {201, 203, 204, 205, 207, 208, 211, 212, 216, 218, 222, 223, 226, 234, 237, 238, 239, 243}


def build():
    cong = pd.read_csv(OUT / "congestion.csv")
    ride = pd.read_csv(OUT / "ridership.csv")
    doors = pd.read_csv(OUT / "doors.csv")
    stations = pd.read_csv(OUT / "stations.csv")

    ch = hourly_congestion(cong)
    daily = daily_ridership(ride, ch)
    tph = trains_per_hour(daily, ch, transfer_free=set(LOOP) - TRANSFER)

    # 열차 한 대·방향별 도착 승객과 하차 인원
    alight, load = {}, {}
    for dt in DAYTYPES:
        for h in HOURS:
            t = tph[dt].get(h)
            for no in LOOP:
                arr = {dr: ch.get((dt, prev_station(no, dr), dr, h), np.nan) * PERSONS_PER_PCT
                       for dr in DIRS}
                total_arr = sum(v for v in arr.values() if not np.isnan(v))
                try:
                    off = daily.loc[(dt, no, h), "off"]
                except KeyError:
                    off = 0.0
                for dr in DIRS:
                    a = arr[dr]
                    if np.isnan(a) or not t or total_arr <= 0:
                        continue
                    per_train = off * (a / total_arr) / t
                    key = f"{dt}|{h}|{dr}|{no}"
                    alight[key] = round(min(per_train, a), 1)
                    load[key] = round(a, 1)

    weights = door_weights(doors)
    model = {
        "meta": {
            "line": "2호선",
            "cars": CARS, "doors": DOORS, "seats_per_train": SEATS_PER_TRAIN,
            "loop": LOOP,
            "assumptions": {"w_base": W_BASE, "w_facility": W_FACILITY, "w_neighbor": W_NEIGHBOR},
        },
        "stations": dict(zip(stations["no"].astype(str), stations["name"])),
        "trains_per_hour": tph,
        "arrive_load": load,
        "alight": alight,
        "door_weights": {f"{no}|{dr}": w for (no, dr), w in weights.items()},
    }
    out = ROOT / "web" / "data"
    out.mkdir(parents=True, exist_ok=True)
    (out / "model.json").write_text(json.dumps(model, ensure_ascii=False), encoding="utf-8")
    return model


def seats_ahead(model, daytype, hour, direction, start_no, n_stops):
    """start_no에서 탄 뒤 n_stops 정거장 동안 문별로 생길 것으로 예상되는 빈자리 수 (40개)."""
    from seatcast.data import next_station
    seats = model["meta"]["seats_per_train"]
    total = np.zeros(CARS * DOORS)
    no = start_no
    for _ in range(n_stops):
        no = next_station(no, direction)
        key = f"{daytype}|{hour}|{direction}|{no}"
        a, load = model["alight"].get(key), model["arrive_load"].get(key)
        if a is None or not load:
            continue
        seated_share = min(1.0, seats / load)
        w = np.array(model["door_weights"][f"{no}|{direction}"])
        total += a * seated_share * w
    return total


if __name__ == "__main__":
    m = build()
    print("trains/hour (평일):", m["trains_per_hour"]["평일"])
    names = {int(k): v for k, v in m["stations"].items()}
    s = seats_ahead(m, "평일", 8, "외선", 226, 4)  # 사당에서 외선(강남 방면) 4정거장
    by_car = s.reshape(CARS, DOORS).sum(axis=1)
    print("평일 8시 사당 -> 외선 4정거장, 칸별 예상 빈자리:", by_car.round(1).tolist())
    best = np.argsort(-s)[:3]
    print("best doors:", [f"{i // DOORS + 1}-{i % DOORS + 1}: {s[i]:.1f}" for i in best])
    print("route:", [names[x] for x in [226, 225, 224, 223, 222]])
