"""서울 열린데이터광장 CardSubwayTime API에서 월별 역별·시간대별 승하차 인원을 받아 CSV로 저장합니다.

사용법: python scripts/fetch_ridership.py 202511 202610
"""
import json
import sys
import urllib.request
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "raw" / "ridership_hourly.csv"


def load_key(name):
    for line in (ROOT / ".env").read_text(encoding="utf-8").splitlines():
        k, _, v = line.partition("=")
        if k.strip() == name and v.strip():
            return v.strip()
    sys.exit(f"{name} is empty in .env")


def months(start, end):
    y, m = int(start[:4]), int(start[4:])
    while f"{y}{m:02d}" <= end:
        yield f"{y}{m:02d}"
        y, m = (y + 1, 1) if m == 12 else (y, m + 1)


def fetch_page(key, ym, first, last):
    url = f"http://openapi.seoul.go.kr:8088/{key}/json/CardSubwayTime/{first}/{last}/{ym}/"
    with urllib.request.urlopen(url, timeout=30) as r:
        return json.load(r)


def fetch_month(key, ym, page=1000):
    body = fetch_page(key, ym, 1, page)
    data = body.get("CardSubwayTime")
    if not data:
        code = body.get("RESULT", {}).get("CODE")
        print(f"{ym}: no data ({code})")
        return None
    rows = list(data["row"])
    total = data["list_total_count"]
    while len(rows) < total:
        nxt = fetch_page(key, ym, len(rows) + 1, len(rows) + page)
        rows.extend(nxt["CardSubwayTime"]["row"])
    return pd.DataFrame(rows)


def main():
    start, end = sys.argv[1], sys.argv[2]
    key = load_key("SEOUL_API_KEY")
    frames = []
    for ym in months(start, end):
        df = fetch_month(key, ym)
        if df is not None:
            print(f"{ym}: {len(df)} rows")
            frames.append(df)
    if not frames:
        sys.exit("nothing fetched")
    OUT.parent.mkdir(parents=True, exist_ok=True)
    # 일부 달(2026-03, 2026-07)은 API가 같은 행을 두 번 돌려주므로 중복을 제거합니다.
    df = pd.concat(frames).drop_duplicates(["USE_MM", "SBWY_ROUT_LN_NM", "STTN"], keep="last")
    df.to_csv(OUT, index=False, encoding="utf-8-sig")
    print(f"saved {OUT}")


if __name__ == "__main__":
    main()
