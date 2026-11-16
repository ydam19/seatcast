"""서울 열린데이터광장 SearchSTNBySubwayLineInfo에서 호선별 역 목록(외부코드 포함)을 받아 저장합니다."""
import json
import sys
import urllib.request
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parent.parent


def load_key(name):
    for line in (ROOT / ".env").read_text(encoding="utf-8").splitlines():
        k, _, v = line.partition("=")
        if k.strip() == name and v.strip():
            return v.strip()
    sys.exit(f"{name} is empty in .env")


def main():
    key = load_key("SEOUL_API_KEY")
    rows, start = [], 1
    while True:
        url = f"http://openapi.seoul.go.kr:8088/{key}/json/SearchSTNBySubwayLineInfo/{start}/{start + 999}/"
        with urllib.request.urlopen(url, timeout=30) as r:
            body = json.load(r)["SearchSTNBySubwayLineInfo"]
        rows += body["row"]
        if len(rows) >= body["list_total_count"]:
            break
        start += 1000
    out = ROOT / "data" / "raw" / "stations_all.csv"
    pd.DataFrame(rows).to_csv(out, index=False, encoding="utf-8-sig")
    print(f"{len(rows)} rows -> {out}")


if __name__ == "__main__":
    main()
