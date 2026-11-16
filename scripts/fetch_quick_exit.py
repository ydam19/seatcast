"""공공데이터포털 서울교통공사 빠른하차정보(getFstExit)에서 호선별 칸·문 위치를 받아 CSV로 저장합니다.

사용법: python scripts/fetch_quick_exit.py 2호선
"""
import json
import sys
import urllib.parse
import urllib.request
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
BASE = "https://apis.data.go.kr/B553766/inout/getFstExit"


def load_key(name):
    for line in (ROOT / ".env").read_text(encoding="utf-8").splitlines():
        k, _, v = line.partition("=")
        if k.strip() == name and v.strip():
            return v.strip()
    sys.exit(f"{name} is empty in .env")


def fetch_page(key, line, page, rows=1000):
    q = urllib.parse.urlencode({
        "serviceKey": key, "pageNo": page, "numOfRows": rows,
        "dataType": "JSON", "lineNm": line,
    })
    with urllib.request.urlopen(f"{BASE}?{q}", timeout=30) as r:
        raw = r.read().decode("utf-8")
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        sys.exit(f"unexpected response: {raw[:300]}")


def main():
    line = sys.argv[1] if len(sys.argv) > 1 else "2호선"
    key = load_key("DATA_GO_KR_KEY")
    first = fetch_page(key, line, 1)
    header = first["response"]["header"] if "response" in first else first.get("header", {})
    body = first["response"]["body"] if "response" in first else first.get("body", {})
    if not body:
        sys.exit(f"error: {header}")
    total = int(body["totalCount"])
    items = body["items"]["item"]
    page = 1
    while len(items) < total:
        page += 1
        nxt = fetch_page(key, line, page)
        b = nxt["response"]["body"] if "response" in nxt else nxt["body"]
        items.extend(b["items"]["item"])
    df = pd.DataFrame(items)
    out = ROOT / "data" / "raw" / f"quick_exit_{line}.csv"
    df.to_csv(out, index=False, encoding="utf-8-sig")
    print(f"{line}: {len(df)} rows -> {out}")


if __name__ == "__main__":
    main()
