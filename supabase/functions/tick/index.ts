// Supabase Edge Function: tick — 이동 중 안내. pg_cron이 매분 호출한다 (GitHub Actions 안 씀).
//
// 대상: 오늘(KST) 시작했고 ended_at이 없고 excluded가 아니며 시작 후 3시간 이내인 trips.
// 단계: started만 → 승차 지점으로 이동 중 / platform_at → 승강장 대기 / boarded_at → 탑승 중
//       transfer_off_at → 환승 이동 / transfer_on_at → 두 번째 탑승 중
// 다음 탈 구간의 실시간 도착(지하철 realtimeStationArrival, 버스 getStationByUid)을 조회해
// "도착 예상 = 지금 + 남은 구간 예상 합(대기 포함)"과 목표 대비 빠름/늦음을 계산한다.
// 방향 판별·역명 정규화·회차 열차 제외는 watch.py live_lines 로직을 그대로 옮겼다 (watch.py가 원본).
//
// 텔레그램은 trip당 메시지 하나: 처음 sendMessage → trips.live_msg_id 저장, 이후 editMessageText.
// 내용이 같으면 안 고친다. ended_at이 생기면 "🏁 도착 · 총 N분 (예상 M분)"으로 마지막 수정 후 live_msg_id=null.
// 실시간 API는 trip당 1분에 1회 이하 (인스턴스 메모리 캐시).
//
// 호출: POST /tick  (Authorization: Bearer <service_role>)   ?dry=1 이면 보내지 않고 내용을 응답으로.
// 환경변수: BOT_TOKEN, SUBWAY_KEY, BUS_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

const BOT = Deno.env.get("BOT_TOKEN") ?? "";
const SUBWAY_KEY = Deno.env.get("SUBWAY_KEY") ?? "";
const BUS_KEY = Deno.env.get("BUS_KEY") ?? "";          // 공공데이터포털 '인코딩' 키 — URL에 그대로 붙인다
const SB_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SB_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const TG = `https://api.telegram.org/bot${BOT}`;
const SUBWAY_BASE = `http://swopenapi.seoul.go.kr/api/subway/${SUBWAY_KEY}/json`;
const BUS_BASE = "http://ws.bus.go.kr/api/rest";
const BUS_SERVICE: Record<string, string> = { stationinfo: "정류소정보조회", arrive: "버스도착정보조회" };

const KST_MS = 9 * 3600 * 1000;
const REALTIME_HORIZON = 30 * 60;   // 실시간 API가 보여 주는 대략의 범위(초). 이보다 먼 승차 지점은 조회 안 함
const MAX_TRIP_SEC = 3 * 3600;
const MIN_SAMPLES = 5, LOOKBACK_DAYS = 60;
const SEC_PER_STATION = 120;
const WALK_MPS = 3.7 * 1000 / 3600;
const LINE_ID: Record<string, string> = {
  "1호선": "1001", "2호선": "1002", "3호선": "1003", "4호선": "1004", "5호선": "1005",
  "6호선": "1006", "7호선": "1007", "8호선": "1008", "9호선": "1009",
  "경의중앙선": "1063", "공항철도": "1065", "경춘선": "1067", "수인분당선": "1075",
  "신분당선": "1077", "우이신설선": "1092", "서해선": "1093", "경강선": "1081", "GTX-A": "1032",
  "경의선": "1063", "중앙선": "1063", "분당선": "1075", "수인선": "1075",
};
const LOOP2: [number, number] = [1002000201, 1002000243];   // 2호선 본선 순환: 시청(201) → … → 충정로(243) → 시청
const MIN_SEC_RE = /(\d+)\s*분(?:\s*(\d+)\s*초)?/;           // '6분 30초 후', '2분12초후[1번째 전]'
const TLN_RE = /^\s*(.+?)행\s*-\s*(.+?)방면/;                 // '성수행 - 홍대입구방면' → (종착, 다음 역)
const STATIONS_AWAY_RE = /\[(\d+)\]번째 전역/;                 // '[14]번째 전역 (안양)'
const BUS_LINE_RE = /^\s*(.*?)\s*\((.*)\)\s*$/;              // '1142 (노원역1번출구→노원구청)'

type Seg = Record<string, any>;
type Item = { kind: string; label: string; waits: number[]; rough: boolean; note: string | null };

// ---------- Supabase ----------
async function db(method: string, path: string, body?: unknown) {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, {
    method,
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json", Prefer: "return=representation" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`db ${method} ${path.split("?")[0]} ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

// ---------- 텔레그램 ----------
async function tg(method: string, payload: Record<string, unknown>): Promise<any> {
  const r = await fetch(`${TG}/${method}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  const j = await r.json().catch(() => ({}));
  if (!j.ok) throw new Error(`tg ${method}: ${j.description ?? r.status}`);
  return j.result;
}

// ---------- 시각 ----------
const kst = (d: Date) => new Date(d.getTime() + KST_MS);
const hhmm = (d: Date) => kst(d).toISOString().slice(11, 16);
const todayStartKst = (now: Date) => new Date(`${kst(now).toISOString().slice(0, 10)}T00:00:00+09:00`);
const since = (ts: string | null, now: Date) => ts ? Math.max(0, (now.getTime() - Date.parse(ts)) / 1000) : 0;
function ageSec(stamp: unknown, now: Date) {           // recptnDt/mkTm 'YYYY-MM-DD HH:MM:SS'(KST) 뒤 흐른 초
  const t = Date.parse(`${String(stamp ?? "").slice(0, 19).replace(" ", "T")}+09:00`);
  return isNaN(t) ? 0 : Math.max(0, Math.floor((now.getTime() - t) / 1000));
}
const waitTxt = (sec: number) => { const m = Math.floor(sec / 60); return m ? `${m}분` : "1분 미만"; };
const mins = (sec: number) => Math.round(sec / 60);

// ---------- 소요시간 추정 (watch.py estimate_duration) ----------
function quantile(values: number[], p: number) {
  const v = [...values].sort((a, b) => a - b);
  const pos = (v.length - 1) * p, lo = Math.floor(pos), hi = Math.ceil(pos);
  return v[lo] + (v[hi] - v[lo]) * (pos - lo);
}
function usableDurations(trips: any[]) {
  const out: number[] = [];
  for (const t of trips) {
    if (t.excluded || !t.started_at || !t.ended_at) continue;
    const d = (Date.parse(t.ended_at) - Date.parse(t.started_at)) / 1000;
    if (d >= 180 && d <= MAX_TRIP_SEC) out.push(d);
  }
  return out;
}
function estimateDuration(route: any, segments: Seg[], trips: any[]) {
  const durs = usableDurations(trips);
  if (durs.length >= MIN_SAMPLES) return Math.trunc(quantile(durs, (route.confidence ?? 90) / 100));
  if (route.baseline_sec) return Math.trunc(route.baseline_sec);
  const segSum = segments.reduce((a, s) => a + (s.expected_sec || 0), 0);
  if (segSum) return Math.trunc(segSum);
  return (route.fallback_min ?? 40) * 60;
}

// ---------- 구간 이름 ----------
function lineLabel(line: string | null, sid = "") {
  let s = (line ?? "").replace(/^\s*수도권\s*/, "").trim();
  if (!s && sid) s = Object.keys(LINE_ID).find((k) => LINE_ID[k] === sid) ?? "";
  const m = /(?<!인천)([1-9])\s*호선/.exec(s);
  return m ? `${m[1]}호선` : (s || "지하철");
}
const stopName = (v: string | null) => (v ?? "").trim().replace(/\s*(?<!\d)\d{5}\s*$/, "");
function busLabel(seg: Seg) {
  const m = BUS_LINE_RE.exec(seg.line ?? "");
  const no = (m ? m[1] : (seg.line ?? "")).trim().replace(/번+$/, "");
  return no ? `${no}번` : "버스";
}
const segLabel = (seg: Seg) => seg.kind === "bus" ? busLabel(seg) : lineLabel(seg.line);
function segSummary(s: Seg): string | null {
  if (s.kind === "walk") {
    const sec = s.expected_sec || (s.distance_m || 0) / WALK_MPS;
    return sec ? `도보 ${Math.max(1, Math.round(sec / 60))}분` : null;
  }
  if (s.kind === "transfer") return "환승";
  if (s.kind === "subway") {
    const a = normStation(s.station_from), b = normStation(s.station_to);
    return [lineLabel(s.line), [a, b].filter(Boolean).join("→")].filter(Boolean).join(" ");
  }
  if (s.kind === "bus") {
    const m = BUS_LINE_RE.exec(s.line ?? "");
    const names = m ? m[2] : [stopName(s.station_from), stopName(s.station_to)].filter(Boolean).join("→");
    return [busLabel(s), names].filter(Boolean).join(" ");
  }
  return null;
}
const item = (kind: string, label: string, waits: number[] = [], rough = false, note: string | null = null): Item =>
  ({ kind, label, waits, rough, note });
function itemTxt(it: Item, first: boolean) {
  if (it.note) return `${it.label} ${it.note}`;
  return `${it.label} ${it.rough ? "약 " : ""}${it.waits.map(waitTxt).join("·")} 뒤${first ? " 도착" : ""}`;
}

// ---------- 실시간 지하철 (watch.py 그대로) ----------
function normStation(name: string | null) {
  let n = (name ?? "").trim().split(" ")[0];
  n = n.replace(/\([^()]*선\)$/, "");
  if (n.length > 1 && n.endsWith("역")) n = n.slice(0, -1);
  return n;
}
const nameParts = (name: string | null) => new Set(normStation(name).split(/[(),]/).filter(Boolean));
function sameStation(x: string | null | undefined, y: string | null | undefined) {
  if (!x || !y) return false;
  const a = nameParts(x), b = nameParts(y);
  return [...a].some((p) => b.has(p));
}
function lineId(line: string | null) {
  const s = (line ?? "").replace(/ /g, "");
  for (const k of Object.keys(LINE_ID).sort((a, b) => b.length - a.length)) if (s.includes(k)) return LINE_ID[k];
  return "";
}
async function fetchArrivals(station: string): Promise<any[]> {
  const r = await fetch(`${SUBWAY_BASE}/realtimeStationArrival/0/30/${encodeURIComponent(station)}`);
  if (!r.ok) throw new Error(`지하철 API HTTP ${r.status}`);
  const j = await r.json();
  const err = j.errorMessage ?? j;
  if (![undefined, null, "INFO-000", "INFO-200"].includes(err.code)) throw new Error(`지하철 API ${err.code} ${err.message}`);
  return j.realtimeArrivalList ?? [];
}
let ALL_NAMES: string[] | null = null;
async function officialNames(name: string) {                 // '이수' → ['총신대입구(이수)']
  if (ALL_NAMES === null) {
    try {
      const r = await fetch(`${SUBWAY_BASE}/realtimeStationArrival/ALL`);
      const j = await r.json();
      ALL_NAMES = [...new Set<string>((j.realtimeArrivalList ?? []).map((a: any) => a.statnNm).filter(Boolean))].sort();
    } catch (e) { console.error("역 이름 목록 조회 실패", String(e)); ALL_NAMES = []; }
  }
  return ALL_NAMES.filter((n) => n !== name && sameStation(n, name));
}
async function stationArrivals(name: string | null, lid: string): Promise<[string, any[]]> {
  const n = normStation(name);
  if (!n) return ["", []];
  const byLine = (arr: any[]) => arr.filter((a) => !lid || a.subwayId === lid);
  let arr = byLine(await fetchArrivals(n));
  if (arr.length) return [n, arr];
  for (const cand of await officialNames(n)) {
    arr = byLine(await fetchArrivals(cand));
    if (arr.length) return [cand, arr];
  }
  return [n, []];
}
function subwayEta(a: any, now: Date): number | null {
  const cd = String(a.arvlCd ?? "");
  if (cd === "2") return null;                                // 출발 — 방금 떠남
  let sec = parseInt(a.barvlDt || 0);
  if (sec <= 0) {                                             // 코레일 구간은 barvlDt가 0
    const msg = a.arvlMsg2 ?? "", ordkey = String(a.ordkey ?? "");
    const m = MIN_SEC_RE.exec(msg), n = STATIONS_AWAY_RE.exec(msg);
    if (cd === "0" || cd === "1") sec = 0;
    else if (m) sec = parseInt(m[1]) * 60 + parseInt(m[2] || "0");
    else if (["3", "4", "5"].includes(cd)) sec = 90;
    else if (n) sec = parseInt(n[1]) * SEC_PER_STATION;
    else if (/^\d{3}$/.test(ordkey.slice(2, 5))) sec = parseInt(ordkey.slice(2, 5)) * SEC_PER_STATION;
    else return null;
  }
  return sec - ageSec(a.recptnDt, now);
}
const isRough = (a: any) => parseInt(a.barvlDt || 0) <= 0 && !["0", "1"].includes(String(a.arvlCd ?? ""));
function timedTrains(trains: any[], now: Date): [number, any][] {
  return trains.map((a): [number | null, any] => [subwayEta(a, now), a])
    .filter((x): x is [number, any] => x[0] !== null).sort((x, y) => x[0] - y[0]);
}
function parseTln(a: any): [string, string] {
  const m = TLN_RE.exec(a.trainLineNm ?? "");
  return m ? [m[1].trim(), m[2].trim()] : [a.bstatnNm ?? "", ""];
}
const inLoop2 = (sid: string, ...ids: number[]) => sid === "1002" && ids.every((v) => LOOP2[0] <= v && v <= LOOP2[1]);
function idDist(sid: string, x: number, y: number) {
  if (inLoop2(sid, x, y)) { const n = LOOP2[1] - LOOP2[0] + 1; const d = ((y - x) % n + n) % n; return Math.min(d, n - d); }
  return Math.abs(y - x);
}
function stationIds(arr: any[]) {
  const out: Record<string, number> = {};
  for (const a of arr) if (/^\d+$/.test(String(a.statnId ?? ""))) out[a.subwayId] = parseInt(a.statnId);
  return out;
}
function groupByNext(arr: any[]) {                           // 다음 역이 같으면 같은 방향
  const g = new Map<string, any[]>();
  for (const a of arr) { const k = `${a.subwayId}|${a.statnTid}`; if (!g.has(k)) g.set(k, []); g.get(k)!.push(a); }
  return g;
}
function pickDirection(arr: any[], bName: string, bIds: Record<string, number>): [any[] | null, string] {
  const groups = groupByNext(arr);
  if (!bName) return [null, "도착역 정보 없음"];
  for (const g of groups.values()) if (sameStation(parseTln(g[0])[1], bName)) return [g, `방면이 ${bName}`];
  const hit = [...groups.values()].filter((g) => g.some((a) => sameStation(parseTln(a)[0], bName) || sameStation(a.bstatnNm, bName)));
  if (hit.length === 1) return [hit[0], `${bName}행 열차의 방향`];
  let best: [number, any[]] | null = null;
  for (const [key, g] of groups) {
    const [sid, tid] = key.split("|");
    const aId = String(g[0].statnId ?? "");
    if (!(sid in bIds) || !/^\d+$/.test(tid ?? "") || !/^\d+$/.test(aId)) continue;
    const dNow = idDist(sid, parseInt(aId), bIds[sid]), dNext = idDist(sid, parseInt(tid), bIds[sid]);
    if (dNext < dNow && (best === null || dNext < best[0])) best = [dNext, g];
  }
  if (best) return [best[1], "역 ID 순서"];
  return [null, "방향 판정 실패"];
}
function dropShortTurn(trains: any[], bIds: Record<string, number>) {   // 회차(중간 종착) 열차 제외
  const keep: any[] = [];
  const sameBlock = (...v: number[]) => new Set(v.map((x) => String(x).slice(0, 7))).size === 1;
  for (const a of trains) {
    const sid = a.subwayId, bId = bIds[sid];
    const aId = parseInt(a.statnId), nId = parseInt(a.statnTid), tId = parseInt(a.bstatnId);
    if ([aId, nId, tId].some(isNaN)) { keep.push(a); continue; }
    if (!inLoop2(sid, aId, tId) && sameBlock(aId, nId, tId) && (tId - aId) * (nId - aId) < 0) continue;      // ① 이 역에 오기 전에 끝남
    if (bId && !inLoop2(sid, aId, bId) && sameBlock(aId, tId, bId)) {
      const dab = idDist(sid, aId, bId), dat = idDist(sid, aId, tId);
      if (0 < dat && dat < dab && dat + idDist(sid, tId, bId) === dab) continue;                              // ② 도착역 전에 끝남
    }
    keep.push(a);
  }
  return keep;
}
function catchItem(label: string, catchList: [number, any][], offset: number) {
  const c = catchList.slice(0, 2);
  return item("subway", label, c.map(([e]) => e - offset), c.some(([, a]) => isRough(a)));
}
async function subwayLive(seg: Seg, offset: number, now: Date, first: boolean): Promise<[Item[], number | null]> {
  const lid = lineId(seg.line);
  let [aName, arr] = await stationArrivals(seg.station_from, lid);
  const [bName, bArr] = seg.station_to ? await stationArrivals(seg.station_to, lid) : ["", []];
  if (!lid && bArr.length) {
    const common = new Set(bArr.map((b: any) => b.subwayId));
    const f = arr.filter((a) => common.has(a.subwayId)); if (f.length) arr = f;
  }
  const bIds = stationIds(bArr);
  const label = lineLabel(seg.line, lid || (arr[0]?.subwayId ?? ""));
  const note = (msg: string): Item[] => first ? [item("subway", label, [], false, msg)] : [];
  if (!arr.length) return [note("열차 정보 없음"), null];

  let trains: any[] | null, basis: string;
  if (seg.updn) { trains = arr.filter((a) => String(seg.updn).includes(a.updnLine ?? "?")); basis = `저장된 방향 ${seg.updn}`; }
  else [trains, basis] = pickDirection(arr, bName, bIds);
  console.log(`    지하철 ${aName}→${bName || "?"} ${seg.line ?? ""}: 방향 근거 = ${basis}`);

  if (trains === null) {                                      // 방향 미확정 → 방향마다 한 항목
    const groups = new Map<string, any[]>();
    for (const a of dropShortTurn(arr, bIds)) {
      const nxt = parseTln(a)[1]; const k = nxt ? `${nxt}방면` : (a.updnLine ?? "?");
      if (!groups.has(k)) groups.set(k, []); groups.get(k)!.push(a);
    }
    const out: Item[] = [];
    for (const [way, g] of groups) {
      const c = timedTrains(g, now).filter(([e]) => e >= offset);
      if (c.length) out.push(catchItem(`${label} ${way}`, c, offset));
    }
    return [out.length ? out : note("방향 미확정 · 잡을 수 있는 열차 없음"), null];
  }
  const timed = timedTrains(dropShortTurn(trains, bIds), now);
  if (!timed.length) return [note("열차 정보 없음"), null];
  const c = timed.filter(([e]) => e >= offset);
  if (c.length) return [[catchItem(label, c, offset)], c[0][0] - offset];
  return [note("보이는 열차는 놓칠 듯 · 다음 열차 기준"), null];
}

// ---------- 실시간 버스 (watch.py 그대로) ----------
async function busGet(op: string, params: Record<string, string>): Promise<any[]> {
  const q = Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&");
  const r = await fetch(`${BUS_BASE}/${op}?serviceKey=${BUS_KEY}&resultType=json&${q}`);
  if (r.status === 401 || r.status === 403) { const svc = op.split("/")[0]; throw new Error(`버스 키가 '${BUS_SERVICE[svc] ?? svc}' 서비스에 등록 안 됨`); }
  if (!r.ok) throw new Error(`버스 API HTTP ${r.status}`);
  const j = await r.json();
  const h = j.msgHeader ?? {};
  if (!["0", "4"].includes(String(h.headerCd))) throw new Error(`버스 API ${h.headerCd} ${h.headerMsg}`);
  return j.msgBody?.itemList ?? [];
}
const normStop = (name: string | null | undefined) => (name ?? "").replace(/\s/g, "");
function sameStop(x: string | null | undefined, y: string | null | undefined) {
  const a = normStop(x), b = normStop(y);
  return !!(a && b && (a === b || a.split("(")[0] === b.split("(")[0]));
}
function routeMatch(rtNm: string | undefined, line: string | null) {   // rtNm '146' ↔ '146', '146번', '간선 146'
  if (!line) return true;
  const rt = normStop(rtNm);
  const toks = new Set(line.split(/[\s:/,()]+/).filter(Boolean).map((t) => t.replace(/번+$/, "")));
  toks.add(normStop(line).replace(/번+$/, ""));
  return !!rt && toks.has(rt);
}
async function busStopIds(seg: Seg): Promise<string[][]> {        // [[이름이 정확히 같은 곳], [나머지]]
  const s = (seg.station_from ?? "").trim();
  const m = /(?<!\d)(\d{5})(?!\d)/.exec(s);
  if (m) return [[m[1]]];
  if (!s) return [];
  const items = (await busGet("stationinfo/getStationByName", { stSrch: s })).filter((it) => String(it.arsId ?? "0") !== "0");
  const exact = items.filter((it) => sameStop(it.stNm, s)).map((it) => it.arsId);
  const rest = items.map((it) => it.arsId).filter((id) => !exact.includes(id));
  return [exact, rest.slice(0, 10)];
}
function busEta(it: any, n: 1 | 2, now: Date): number | null {
  const msg: string = it[`arrmsg${n}`] ?? "";
  if (!msg || ["운행종료", "출발대기", "회차대기", "정보없음"].some((w) => msg.includes(w))) return null;
  let sec = parseInt(it[`traTime${n}`] || 0) || parseInt(it[`exps${n}`] || 0);
  if (sec <= 0) {
    if (msg.includes("곧 도착")) sec = 30;
    else { const m = MIN_SEC_RE.exec(msg); if (!m) return null; sec = parseInt(m[1]) * 60 + parseInt(m[2] || "0"); }
  }
  return sec - ageSec(it.mkTm, now);
}
async function pickBusStop(entries: any[], seg: Seg): Promise<[any[], string]> {
  if (entries.length <= 1) return [entries, "정류장 하나"];
  const to = seg.station_to;
  if (!to) return [entries, "도착 정류장 정보 없음"];
  const nx = entries.filter((e) => sameStop(e.nxtStn, to));
  if (nx.length === 1) return [nx, "다음 정류장이 도착 정류장"];
  let stops: any[];
  try { stops = await busGet("arrive/getArrInfoByRouteAll", { busRouteId: String(entries[0].busRouteId) }); }
  catch (e) { return [entries, `노선 순서 조회 실패: ${String(e)}`]; }
  const n = stops.length;
  const ords: Record<string, number> = {}; for (const s of stops) ords[s.arsId] = parseInt(s.staOrd || 0);
  const toOrds = stops.filter((s) => sameStop(s.stNm, to)).map((s) => parseInt(s.staOrd || 0));
  let best: [number, any] | null = null;
  for (const e of entries) {
    const fo = ords[e.arsId] || parseInt(e.staOrd || 0);
    const gaps = toOrds.map((t) => ((t - fo) % n + n) % n).filter(Boolean);
    if (fo && gaps.length && (best === null || Math.min(...gaps) < best[0])) best = [Math.min(...gaps), e];
  }
  return best ? [[best[1]], "노선 정류장 순서"] : [entries, "방향 판정 실패"];
}
async function busLive(seg: Seg, offset: number, now: Date, first: boolean): Promise<[Item[], number | null]> {
  let entries: any[] = [];
  for (const group of await busStopIds(seg)) {
    entries = [];
    for (const ars of group) entries.push(...(await busGet("stationinfo/getStationByUid", { arsId: ars })).filter((it) => routeMatch(it.rtNm, seg.line)));
    if (entries.length) break;
  }
  if (!entries.length) return [first ? [item("bus", busLabel(seg), [], false, "버스 정보 없음")] : [], null];
  let picked: any[], basis: string;
  if (seg.line) [picked, basis] = await pickBusStop(entries, seg);
  else {
    const soon = (e: any) => busEta(e, 1, now) ?? 1e9;
    picked = [...entries].sort((a, b) => soon(a) - soon(b)).slice(0, 3); basis = "노선 미지정";
  }
  console.log(`    버스 ${seg.station_from}→${seg.station_to ?? "?"} ${seg.line ?? ""}: 정류장 근거 = ${basis}`);
  const out: Item[] = [];
  for (const e of picked) {
    const label = (e.rtNm ? `${e.rtNm}번` : busLabel(seg)) + (picked.length > 1 && e.adirection ? `(${e.adirection} 방향)` : "");
    const etas = [busEta(e, 1, now), busEta(e, 2, now)].filter((x): x is number => x !== null).sort((a, b) => a - b);
    const c = etas.filter((x) => x >= offset).slice(0, 2);
    if (c.length) out.push(item("bus", label, c.map((x) => x - offset)));
    else if (first && etas.length) out.push(item("bus", label, [], false, "보이는 버스는 놓칠 듯 · 다음 버스 기준"));
    else if (first) out.push(item("bus", label, [], false, e.arrmsg1 || "도착 정보 없음"));
  }
  const waits = out.filter((it) => it.waits.length).map((it) => it.waits[0]);
  return [out, waits.length ? Math.min(...waits) : null];
}

// ---------- 단계 · 남은 시간 ----------
const isRide = (s: Seg) => s.kind === "subway" || s.kind === "bus";
const STAGE = ["승차 지점으로 이동 중", "승강장 대기", "탑승 중", "환승 이동", "두 번째 탑승 중"];
const STAGE_ICON = ["🚶", "🚉", "🚇", "🔄", "🚇"];
const TRIP_FIELDS = ["platform_at", "boarded_at", "transfer_off_at", "transfer_on_at", "ended_at"] as const;
const LABEL: Record<string, string> = { platform_at: "승강장 도착", boarded_at: "열차 탑승", transfer_off_at: "환승 하차", transfer_on_at: "환승 탑승", ended_at: "목적지 도착" };

function stageOf(t: any) {
  return t.transfer_on_at ? 4 : t.transfer_off_at ? 3 : t.boarded_at ? 2 : t.platform_at ? 1 : 0;
}
/** 단계에 따라 (다음 탈 구간 index, 그 승차 지점까지 남은 초 pre, 그 구간부터 끝까지 예상 합 post, 탈 구간 없을 때 남은 초) */
function position(t: any, segments: Seg[], now: Date) {
  const rides = segments.map((s, i) => isRide(s) ? i : -1).filter((i) => i >= 0);
  const sum = (a: number, b: number) => segments.slice(a, b).reduce((x, s) => x + (s.expected_sec || 0), 0);
  const sec = (i: number) => segments[i]?.expected_sec || 0;
  const n = segments.length, [r1, r2, r3] = rides;
  const stage = stageOf(t);
  const none = (remaining: number) => ({ stage, next: -1, pre: 0, post: 0, remaining });
  if (r1 === undefined) return none(Math.max(0, sum(0, n) - since(t.started_at, now)));
  if (stage === 0) return { stage, next: r1, pre: Math.max(0, sum(0, r1) - since(t.started_at, now)), post: sum(r1, n), remaining: 0 };
  if (stage === 1) return { stage, next: r1, pre: 0, post: sum(r1, n), remaining: 0 };
  if (stage === 2) {
    const partial = Math.max(0, sec(r1) - since(t.boarded_at, now));
    if (r2 === undefined) return none(partial + sum(r1 + 1, n));
    return { stage, next: r2, pre: partial + sum(r1 + 1, r2), post: sum(r2, n), remaining: 0 };
  }
  if (stage === 3) {
    if (r2 === undefined) return none(Math.max(0, sum(r1 + 1, n) - since(t.transfer_off_at, now)));
    return { stage, next: r2, pre: Math.max(0, sum(r1 + 1, r2) - since(t.transfer_off_at, now)), post: sum(r2, n), remaining: 0 };
  }
  const cur = r2 ?? r1, nxt = r2 !== undefined ? r3 : undefined;
  const partial = Math.max(0, sec(cur) - since(t.transfer_on_at, now));
  if (nxt === undefined) return none(partial + sum(cur + 1, n));
  return { stage, next: nxt, pre: partial + sum(cur + 1, nxt), post: sum(nxt, n), remaining: 0 };
}

// 실시간 조회 캐시: trip당 1분에 1회 이하
const liveCache = new Map<number, { at: number; segIdx: number; items: Item[]; wait: number | null }>();
async function liveFor(tripId: number, segIdx: number, seg: Seg, offset: number, now: Date): Promise<[Item[], number | null]> {
  const c = liveCache.get(tripId);
  if (c && c.segIdx === segIdx && now.getTime() - c.at < 55_000) return [c.items, c.wait];   // 단계가 바뀌면 다시 조회
  let items: Item[] = [], wait: number | null = null;
  const key = seg.kind === "subway" ? SUBWAY_KEY : BUS_KEY;
  if (!key) items = [item(seg.kind, segLabel(seg), [], false, "실시간 키 없음")];
  else {
    try { [items, wait] = await (seg.kind === "subway" ? subwayLive : busLive)(seg, offset, now, true); }
    catch (e) { console.error(`${seg.kind} 실시간 실패`, String(e)); items = [item(seg.kind, segLabel(seg), [], false, "실시간 조회 실패")]; }
  }
  liveCache.set(tripId, { at: now.getTime(), segIdx, items, wait });
  return [items, wait];
}

function buttons(t: any, rides: number) {
  const fields = TRIP_FIELDS.filter((f) => !t[f] && (rides >= 2 || !f.startsWith("transfer_")));
  return { inline_keyboard: fields.map((f) => [{ text: LABEL[f], callback_data: `trip:${f}:${t.id}` }]) };
}

async function buildLive(t: any, segments: Seg[], now: Date) {
  const route = t.routes, p = position(t, segments, now);
  let liveLine = "", remaining = p.remaining, waitNote = "";
  if (p.next >= 0) {
    const seg = segments[p.next];
    if (p.pre <= REALTIME_HORIZON) {
      const [items, wait] = await liveFor(t.id, p.next, seg, p.pre, now);
      liveLine = items.length ? `${seg.kind === "bus" ? "🚌" : "🚇"} 다음: ${items.map((it, i) => itemTxt(it, i === 0)).join(" / ")}` : "";
      remaining = p.pre + (wait ?? 0) + p.post;
      if (wait === null) waitNote = " · 대기 미확인";
    } else {
      liveLine = `${seg.kind === "bus" ? "🚌" : "🚇"} 다음: ${segSummary(seg) ?? segLabel(seg)} (${mins(p.pre)}분 뒤 승차 지점 · 실시간은 30분 안에서)`;
      remaining = p.pre + p.post; waitNote = " · 대기 미확인";
    }
  }
  const eta = new Date(now.getTime() + remaining * 1000);
  const [hh, mm] = String(route.arrive_by).split(":").map(Number);
  const target = new Date(todayStartKst(now).getTime() + (hh * 60 + mm) * 60 * 1000);
  const diff = Math.round((target.getTime() - eta.getTime()) / 60000);
  const vs = diff > 0 ? `${diff}분 빠름` : diff < 0 ? `${-diff}분 늦음` : "정시";
  const rides = segments.filter(isRide);
  const curRide = p.stage === 2 ? rides[0] : p.stage === 4 ? (rides[1] ?? rides[0]) : null;   // 탑승 중이면 그 차의 아이콘
  const icon = curRide ? (curRide.kind === "bus" ? "🚌" : "🚇") : STAGE_ICON[p.stage];
  const stageTxt = `${icon} ${STAGE[p.stage]} · 출발 ${hhmm(new Date(t.started_at))} (${mins(since(t.started_at, now))}분 경과)`;
  const text = [`🧭 이동 중 · ${route.name}`, stageTxt, liveLine,
    `도착 예상 ${hhmm(eta)} · 목표 ${hhmm(target)} 대비 ${vs} (남은 약 ${mins(remaining)}분${waitNote})`].filter(Boolean).join("\n");
  return { text, markup: buttons(t, segments.filter(isRide).length) };
}

async function buildFinal(t: any, segments: Seg[], now: Date) {
  const total = Math.round((Date.parse(t.ended_at) - Date.parse(t.started_at)) / 60);
  let expected = t.expected_sec;
  if (!expected) {
    const sinceIso = new Date(now.getTime() - LOOKBACK_DAYS * 86400 * 1000).toISOString();
    const trips = await db("GET", `trips?route_id=eq.${t.route_id}&id=neq.${t.id}&started_at=gte.${encodeURIComponent(sinceIso)}&select=started_at,ended_at,excluded`);
    expected = estimateDuration(t.routes, segments, trips);
  }
  return { text: `🏁 도착 · 총 ${Math.round(total / 1000)}분 (예상 ${Math.ceil(expected / 60)}분)\n${t.routes.name}`, markup: { inline_keyboard: [] } };
}

// 메시지 보내기/고치기. 내용이 같으면 안 고친다.
const lastText = new Map<number, string>();
async function upsertMessage(t: any, chatId: number, text: string, markup: unknown) {
  const key = `${text}|${JSON.stringify(markup)}`;
  if (lastText.get(t.id) === key) return "unchanged";
  if (t.live_msg_id) {
    try {
      await tg("editMessageText", { chat_id: chatId, message_id: t.live_msg_id, text, reply_markup: markup });
      lastText.set(t.id, key); return "edited";
    } catch (e) {
      const msg = String(e);
      if (msg.includes("message is not modified")) { lastText.set(t.id, key); return "unchanged"; }
      if (!msg.includes("message to edit not found")) throw e;   // 사용자가 지운 메시지면 새로 보낸다
    }
  }
  const m = await tg("sendMessage", { chat_id: chatId, text, reply_markup: markup });
  await db("PATCH", `trips?id=eq.${t.id}`, { live_msg_id: m.message_id });
  lastText.set(t.id, key); return "sent";
}

// ---------- 메인 ----------
const SELECT = "*,routes(id,name,arrive_by,confidence,baseline_sec,fallback_min),users(telegram_chat_id)";
Deno.serve(async (req) => {
  const auth = req.headers.get("authorization") ?? "";
  if (!SB_KEY || auth !== `Bearer ${SB_KEY}`) return new Response(JSON.stringify({ error: "service_role 키가 필요해요" }), { status: 401 });
  const dry = new URL(req.url).searchParams.get("dry") === "1";
  const now = new Date();
  const out: any[] = [];
  const startFloor = new Date(Math.max(todayStartKst(now).getTime(), now.getTime() - MAX_TRIP_SEC * 1000)).toISOString();

  // 1) 진행 중
  const open = await db("GET", `trips?select=${SELECT}&ended_at=is.null&excluded=not.is.true&started_at=gte.${encodeURIComponent(startFloor)}&order=id`);
  for (const t of open) {
    const chatId = t.users?.telegram_chat_id;
    const rec: any = { trip_id: t.id, route: t.routes?.name, stage: STAGE[stageOf(t)] };
    try {
      if (!t.routes) throw new Error("경로 없음");
      const segments = await db("GET", `segments?route_id=eq.${t.route_id}&order=seq`);
      const { text, markup } = await buildLive(t, segments, now);
      rec.text = text; rec.buttons = markup.inline_keyboard.map((r: any[]) => r[0].text);
      if (dry) rec.action = "dry";
      else if (!chatId) rec.action = "텔레그램 미연결";
      else rec.action = await upsertMessage(t, chatId, text, markup);
    } catch (e) { rec.error = String(e); console.error(`trip ${t.id}`, String(e)); }
    out.push(rec);
  }
  // 2) 끝난 것 마무리 (메시지가 있던 것만)
  let ended: any[] = [];
  try { ended = await db("GET", `trips?select=${SELECT}&ended_at=not.is.null&live_msg_id=not.is.null&order=id`); }
  catch (e) { out.push({ error: `live_msg_id 조회 실패 (컬럼 없음?) ${String(e)}` }); }
  for (const t of ended) {
    const chatId = t.users?.telegram_chat_id;
    const rec: any = { trip_id: t.id, route: t.routes?.name, stage: "도착" };
    try {
      const segments = await db("GET", `segments?route_id=eq.${t.route_id}&order=seq`);
      const { text, markup } = await buildFinal(t, segments, now);
      rec.text = text;
      if (dry) rec.action = "dry";
      else {
        if (chatId) {
          try { await tg("editMessageText", { chat_id: chatId, message_id: t.live_msg_id, text, reply_markup: markup }); }
          catch (e) { if (!String(e).includes("not modified") && !String(e).includes("not found")) throw e; }
        }
        await db("PATCH", `trips?id=eq.${t.id}`, { live_msg_id: null });
        liveCache.delete(t.id); lastText.delete(t.id);
        rec.action = "finalized";
      }
    } catch (e) { rec.error = String(e); console.error(`trip ${t.id} final`, String(e)); }
    out.push(rec);
  }
  return new Response(JSON.stringify({ at: now.toISOString(), dry, trips: out }, null, 1), { headers: { "Content-Type": "application/json" } });
});
