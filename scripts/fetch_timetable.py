"""서울 열린데이터광장 SearchSTNTimeTableByIDService에서 역별 열차 시간표를 받아 저장합니다.

역 x 요일(1 평일, 2 토요일, 3 휴일) x 방향(1 상행/내선, 2 하행/외선)마다 한 번씩 호출합니다.
기본은 1~9호선이고, --all을 주면 stations_all.csv의 모든 노선을 받습니다.
중간에 끊겨도 다시 실행하면 받은 조합은 건너뜁니다.
"""
import argparse
import json
import sys
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "raw"
PARTS = RAW / "timetable_parts"
OUT = RAW / "timetable.csv"
LINES_1_9 = [f"0{i}호선" for i in range(1, 10)]


def load_key(name):
    for line in (ROOT / ".env").read_text(encoding="utf-8").splitlines():
        k, _, v = line.partition("=")
        if k.strip() == name and v.strip():
            return v.strip()
    sys.exit(f"{name} is empty in .env")


def fetch(key, code, week, inout):
    path = PARTS / f"{code}_{week}_{inout}.json"
    if path.exists():
        return path, None
    rows, start = [], 1
    while True:
        url = (f"http://openapi.seoul.go.kr:8088/{key}/json/SearchSTNTimeTableByIDService/"
               f"{start}/{start + 999}/{code}/{week}/{inout}/")
        for attempt in range(4):
            try:
                with urllib.request.urlopen(url, timeout=30) as r:
                    body = json.load(r)
                break
            except Exception as e:  # 네트워크 오류는 잠깐 쉬고 다시 시도
                if attempt == 3:
                    return path, f"{code}/{week}/{inout}: {e}"
                time.sleep(2 * (attempt + 1))
        svc = body.get("SearchSTNTimeTableByIDService")
        if svc is None:  # INFO-200(데이터 없음) 등
            break
        rows += svc["row"]
        if len(rows) >= svc["list_total_count"]:
            break
        start += 1000
    path.write_text(json.dumps(rows, ensure_ascii=False), encoding="utf-8")
    return path, None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--all", action="store_true", help="1~9호선 외 모든 노선까지")
    ap.add_argument("--workers", type=int, default=8)
    args = ap.parse_args()

    key = load_key("SEOUL_API_KEY")
    st = pd.read_csv(RAW / "stations_all.csv", dtype=str)
    if not args.all:
        st = st[st.LINE_NUM.isin(LINES_1_9)]
    codes = sorted(st.STATION_CD.unique())
    jobs = [(c, w, i) for c in codes for w in (1, 2, 3) for i in (1, 2)]
    PARTS.mkdir(parents=True, exist_ok=True)
    print(f"{len(codes)} stations, {len(jobs)} requests")

    errors, done = [], 0
    with ThreadPoolExecutor(args.workers) as ex:
        for f in as_completed([ex.submit(fetch, key, *j) for j in jobs]):
            _, err = f.result()
            done += 1
            if err:
                errors.append(err)
            if done % 200 == 0:
                print(f"  {done}/{len(jobs)}")

    frames = []
    for p in sorted(PARTS.glob("*.json")):
        rows = json.loads(p.read_text(encoding="utf-8"))
        if rows:
            frames.append(pd.DataFrame(rows))
    df = pd.concat(frames, ignore_index=True)
    df.to_csv(OUT, index=False, encoding="utf-8-sig")
    print(f"{len(df)} rows -> {OUT}")
    if errors:
        print(f"{len(errors)} failed (다시 실행하면 이어서 받습니다):", *errors[:10], sep="\n  ")


if __name__ == "__main__":
    main()
