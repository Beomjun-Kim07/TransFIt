// 임시 파일 — B가 supabase/functions/_shared/realtime.ts 를 만들면 index.ts의 import를 그쪽으로 바꾸고 이 파일을 지운다.
// watch.py live_lines 로직의 TS 포팅. 시그니처는 _shared/realtime.ts 와 같게 맞춘다:
//   liveForSegment(seg, readyInSec, env) → { items, waitSec }   한 승차 구간. readyInSec = 그 승차 지점에 닿기까지 남은 초
//   liveChain(segments, fromIndex, walkSec, env) → { items, waitSec: {segIndex: 대기 초} }
//     fromIndex부터 구간을 따라가며 승차 지점 도착 시각을 체인으로 쌓는다 (watch.py live_lines). walkSec = 시작 offset
//   env = { SUBWAY_KEY, BUS_KEY, now? }

export type Seg = Record<string, any>;
export type LiveItem = { kind: string; label: string; waits: number[]; rough: boolean; note: string | null };
export type RealtimeEnv = { SUBWAY_KEY?: string; BUS_KEY?: string; now?: Date };
type Item = LiveItem;

const REALTIME_HORIZON = 30 * 60;   // 실시간 API가 보여 주는 대략의 범위(초)
const SEC_PER_STATION = 120;
const WALK_MPS = 3.7 * 1000 / 3600;
const LINE_ID: Record<string, string> = {
  "1호선": "1001", "2호선": "1002", "3호선": "1003", "4호선": "1004", "5호선": "1005",
  "6호선": "1006", "7호선": "1007", "8호선": "1008", "9호선": "1009",
  "경의중앙선": "1063", "공항철도": "1065", "경춘선": "1067", "수인분당선": "1075",
  "신분당선": "1077", "우이신설선": "1092", "서해선": "1093", "경강선": "1081", "GTX-A": "1032",
  "경의선": "1063", "중앙선": "1063", "분당선": "1075", "수인선": "1075",
};
const LOOP2: [number, number] = [1002000201, 1002000243];
const MIN_SEC_RE = /(\d+)\s*분(?:\s*(\d+)\s*초)?/;
const TLN_RE = /^\s*(.+?)행\s*-\s*(.+?)방면/;
const STATIONS_AWAY_RE = /\[(\d+)\]번째 전역/;
const BUS_LINE_RE = /^\s*(.*?)\s*\((.*)\)\s*$/;
const BUS_BASE = "http://ws.bus.go.kr/api/rest";
const BUS_SERVICE: Record<string, string> = { stationinfo: "정류소정보조회", arrive: "버스도착정보조회" };

// 호출마다 env에서 키를 받는다 (모듈 전역 대신)
let SUBWAY_KEY = "", BUS_KEY = "";
const SUBWAY_BASE = () => `http://swopenapi.seoul.go.kr/api/subway/${SUBWAY_KEY}/json`;

function ageSec(stamp: unknown, now: Date) {
  const t = Date.parse(`${String(stamp ?? "").slice(0, 19).replace(" ", "T")}+09:00`);
  return isNaN(t) ? 0 : Math.max(0, Math.floor((now.getTime() - t) / 1000));
}
export const waitTxt = (sec: number) => { const m = Math.floor(sec / 60); return m ? `${m}분` : "1분 미만"; };

// ---------- 구간 이름 ----------
export function lineLabel(line: string | null, sid = "") {
  let s = (line ?? "").replace(/^\s*수도권\s*/, "").trim();
  if (!s && sid) s = Object.keys(LINE_ID).find((k) => LINE_ID[k] === sid) ?? "";
  const m = /(?<!인천)([1-9])\s*호선/.exec(s);
  return m ? `${m[1]}호선` : (s || "지하철");
}
export const stopName = (v: string | null) => (v ?? "").trim().replace(/\s*(?<!\d)\d{5}\s*$/, "");
export function busLabel(seg: Seg) {
  const m = BUS_LINE_RE.exec(seg.line ?? "");
  const no = (m ? m[1] : (seg.line ?? "")).trim().replace(/번+$/, "");
  return no ? `${no}번` : "버스";
}
export const segLabel = (seg: Seg) => seg.kind === "bus" ? busLabel(seg) : lineLabel(seg.line);
export function segSummary(s: Seg): string | null {
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
export function itemTxt(it: Item, first: boolean) {
  if (it.note) return `${it.label} ${it.note}`;
  return `${it.label} ${it.rough ? "약 " : ""}${it.waits.map(waitTxt).join("·")} 뒤${first ? " 도착" : ""}`;
}

// ---------- 실시간 지하철 (watch.py 그대로) ----------
export function normStation(name: string | null) {
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
  const r = await fetch(`${SUBWAY_BASE()}/realtimeStationArrival/0/30/${encodeURIComponent(station)}`);
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
      const r = await fetch(`${SUBWAY_BASE()}/realtimeStationArrival/ALL`);
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


// ---------- 공개 API ----------
export const isRide = (s: Seg) => s.kind === "subway" || s.kind === "bus";

export async function liveForSegment(seg: Seg, readyInSec: number, env: RealtimeEnv): Promise<{ items: LiveItem[]; waitSec: number | null }> {
  SUBWAY_KEY = env.SUBWAY_KEY ?? ""; BUS_KEY = env.BUS_KEY ?? "";
  const now = env.now ?? new Date();
  const key = seg.kind === "subway" ? SUBWAY_KEY : BUS_KEY;
  if (!key) return { items: [item(seg.kind, segLabel(seg), [], false, "실시간 키 없음")], waitSec: null };
  try {
    const [items, waitSec] = await (seg.kind === "subway" ? subwayLive : busLive)(seg, readyInSec, now, true);
    return { items, waitSec };
  } catch (e) {
    console.error(`${seg.kind} 실시간 실패`, String(e));
    return { items: [item(seg.kind, segLabel(seg), [], false, "실시간 조회 실패")], waitSec: null };
  }
}

/** watch.py live_lines: fromIndex부터 구간을 따라가며 승차 지점 도착 시각(offset)을 체인으로 쌓고 그 시각 이후 첫 차를 고른다.
 *  첫 승차 구간은 항상 한 항목, 뒤 구간은 잡을 수 있는 차가 보일 때만. 탈 차를 못 정하면 거기서 멈춘다. */
export async function liveChain(segments: Seg[], fromIndex: number, walkSec: number, env: RealtimeEnv): Promise<{ items: LiveItem[]; waitSec: Record<number, number> }> {
  SUBWAY_KEY = env.SUBWAY_KEY ?? ""; BUS_KEY = env.BUS_KEY ?? "";
  const now = env.now ?? new Date();
  const items: LiveItem[] = [], waitSec: Record<number, number> = {};
  let offset = walkSec, first = true;
  for (let i = fromIndex; i < segments.length; i++) {
    const seg = segments[i], sec = seg.expected_sec || 0;
    if (!isRide(seg)) { offset += sec; continue; }
    if (!first && offset > REALTIME_HORIZON) break;
    let got: LiveItem[] = [], wait: number | null = null;
    const key = seg.kind === "subway" ? SUBWAY_KEY : BUS_KEY;
    if (!key) { if (first) got = [item(seg.kind, segLabel(seg), [], false, "실시간 키 없음")]; }
    else {
      try { [got, wait] = await (seg.kind === "subway" ? subwayLive : busLive)(seg, offset, now, first); }
      catch (e) { console.error(`${seg.kind} 실시간 실패`, String(e)); if (first) got = [item(seg.kind, segLabel(seg), [], false, "실시간 조회 실패")]; }
    }
    items.push(...got);
    if (wait === null) break;
    waitSec[i] = wait;
    offset += wait + sec;
    first = false;
  }
  return { items, waitSec };
}
