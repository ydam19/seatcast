// 서울시 실시간 지하철 도착정보를 대신 받아 오는 Vercel 함수.
// 원본 API는 http만 지원해 https 페이지에서 바로 부를 수 없고, 인증키를 화면 코드에 넣지 않기 위해 거칩니다.
// GET /api/arrival?station=강남 -> { station, list: [{ line, no, dest, toward, eta, msg, express, last }] }

const LINES = {
  1001: "1", 1002: "2", 1003: "3", 1004: "4", 1005: "5",
  1006: "6", 1007: "7", 1008: "8", 1009: "9",
};
// 앉을각 역 이름 -> 실시간 API 역 이름
const ALIAS = { 서울역: "서울" };

// "2026-11-17 14:03:23" -> 자정부터 초
function daySec(v) {
  const m = /(\d\d):(\d\d):(\d\d)$/.exec(String(v || ""));
  if (!m) return null;
  const h = Number(m[1]);
  return (h < 3 ? h + 24 : h) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

const canon = (s) => String(s || "").replace(/\(.*?\)/g, "").trim();

module.exports = async (req, res) => {
  const station = canon(req.query.station);
  const key = process.env.SEOUL_API_KEY;
  if (!station || station.length > 20) return res.status(400).json({ error: "station" });
  if (!key) return res.status(500).json({ error: "key" });

  const name = ALIAS[station] || station;
  const url = `http://swopenapi.seoul.go.kr/api/subway/${key}/json/realtimeStationArrival/0/40/${encodeURIComponent(name)}`;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(6000) });
    const d = await r.json();
    const list = (d.realtimeArrivalList || [])
      .filter((x) => LINES[x.subwayId])
      .map((x) => {
        const [, toward = ""] = String(x.trainLineNm || "").split(" - ");
        return {
          line: LINES[x.subwayId],
          no: Number(String(x.btrainNo || "").replace(/\D/g, "")) || 0,
          dest: canon(x.bstatnNm),
          toward: canon(toward.replace(/방면.*$/, "")),
          eta: Number(x.barvlDt) || 0, // 초. 0이면 모름(메시지로 판단)
          at: daySec(x.recptnDt), // 이 정보를 받은 시각(자정부터 초, 새벽 0~2시는 24시 이후)
          msg: x.arvlMsg2 || "",
          express: x.btrainSttus === "급행",
          last: x.lstcarAt === "1",
        };
      });
    res.setHeader("Cache-Control", "s-maxage=15, stale-while-revalidate=15");
    return res.status(200).json({ station, list });
  } catch (e) {
    return res.status(502).json({ error: "upstream" });
  }
};
