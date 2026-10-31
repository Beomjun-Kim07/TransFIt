// supabase/functions/_shared/realtime.ts — 실시간 지하철·버스 조회 (B 담당). watch.py live_lines를 그대로 옮겼다 — watch.py가 원본.
//   지하철 realtimeStationArrival: 역명 정규화(이수 → 총신대입구(이수)), 방향 자동 판별(방면 → 종착역 → 역 ID), 회차 열차 제외,
//                                 남은 시간 barvlDt (0이면 '[N]번째 전역'·ordkey로 추정 → rough)
//   버스 getStationByUid: 남은 시간 traTime1/traTime2, 같은 이름 정류장이 길 양쪽이면 도착 정류장 쪽
//   체인: 승차 지점 도착 시각 = 걷기·환승·승차 예상 + 앞 구간에서 고른 차의 실제 대기 (watch.py와 같은 누적)
//
// liveForSegment(seg, readyInSec, env) → { line, waits, note? } | null
//   waits: 지금부터 몇 초 뒤 이 역·정류장에 오는지. readyInSec(그 승차 지점에 닿는 시각) 이후에 오는 차만, 빠른 순 최대 2대.
//   note : 대기 대신 보일 말 ('열차 정보 없음', '보이는 열차는 놓칠 듯 · 다음 열차 기준', '운행종료', '방향 미확정' …). 탈 구간이 아니면 null.
//   rough: 남은 시간을 역 수로 추정(코레일 구간) → 문구에 '약'.  ways: 방향 미확정이면 방향별, 버스 후보가 여럿이면 버스별 { line, waits }.
// liveChain(segments, fromIndex, walkSec, env) → ChainItem[]  (walkSec = 지금부터 segments[fromIndex] 시작점에 닿기까지 남은 초)
// env: { SUBWAY_KEY, BUS_KEY } (+ 시험용 fetch·now, 로그 log). BUS_KEY는 공공데이터포털 인코딩 키·디코딩 키 둘 다 된다.

export type Seg = {
  kind: string; station_from?: string | null; station_to?: string | null; line?: string | null;
  updn?: string | null; expected_sec?: number | null; [k: string]: unknown;
};
export type Env = { SUBWAY_KEY?: string; BUS_KEY?: string; fetch?: typeof fetch; now?: Date; log?: (msg: string) => void };
export type Way = { line: string; waits: number[] };
export type Live = { line: string; waits: number[]; note?: string; rough?: boolean; ways?: Way[] };
export type ChainItem = Live & { index: number; kind: string; readyInSec: number; chain: string };

export const REALTIME_HORIZON = 30 * 60;   // 실시간 API가 보여 주는 대략의 범위(초). 이보다 먼 뒤 구간은 조회 안 함
export const SEC_PER_STATION = 120;        // 남은 시간 없이 역 수만 올 때 역당 추정 초
const LINE_ID: Record<string, string> = {
  "1호선": "1001", "2호선": "1002", "3호선": "1003", "4호선": "1004", "5호선": "1005",
  "6호선": "1006", "7호선": "1007", "8호선": "1008", "9호선": "1009",
  "경의중앙선": "1063", "공항철도": "1065", "경춘선": "1067", "수인분당선": "1075",
  "신분당선": "1077", "우이신설선": "1092", "서해선": "1093", "경강선": "1081", "GTX-A": "1032",
  "경의선": "1063", "중앙선": "1063", "분당선": "1075", "수인선": "1075",   // 카카오 등 다른 표기
};
const LOOP2: [number, number] = [1002000201, 1002000243];   // 2호선 본선 순환: 시청(201) → … → 충정로(243) → 시청
const MIN_SEC_RE = /(\d+)\s*분(?:\s*(\d+)\s*초)?/;           // '6분 30초 후', '2분12초후[1번째 전]'
const TLN_RE = /^\s*(.+?)행\s*-\s*(.+?)방면/;                 // '성수행 - 홍대입구방면' → (종착, 다음 역)
const STATIONS_AWAY_RE = /\[(\d+)\]번째 전역/;                 // '[14]번째 전역 (안양)'
const BUS_LINE_RE = /^\s*(.*?)\s*\((.*)\)\s*$/;              // '1142 (노원역1번출구→노원구청)'
const BUS_BASE = "http://ws.bus.go.kr/api/rest";
const BUS_SERVICE: Record<string, string> = { stationinfo: "정류소정보조회", arrive: "버스도착정보조회" };

// deno-lint-ignore no-explicit-any
type A = any;
type Ctx = { env: Env; f: typeof fetch; now: Date; log: (m: string) => void };
const ctxOf = (env: Env): Ctx => ({ env, f: env.fetch ?? fetch, now: env.now ?? new Date(), log: env.log ?? ((m) => console.log(m)) });
const toInt = (v: unknown) => parseInt(String(v ?? "0"), 10) || 0;
export const isRide = (s: Seg) => s.kind === "subway" || s.kind === "bus";
const mins = (sec: number) => Math.round(sec / 60);
export const waitTxt = (sec: number) => { const m = Math.floor(sec / 60); return m ? `${m}분` : "1분 미만"; };

// ---------- 키 가리기 ----------
function busKeyParam(raw: string) {           // 인코딩 키(%포함)는 그대로, 디코딩 키는 인코딩해서 붙인다
  return raw.includes("%") ? raw : encodeURIComponent(raw);
}
/** 오류 문구엔 요청 주소(=키)가 섞여 나온다 (Deno fetch 오류는 URL을 담는다). 로그로 새지 않게 가린다. */
export function redact(text: string, env: Env) {
  const b = env.BUS_KEY ?? "";
  let dec = b; try { dec = decodeURIComponent(b); } catch { /* 그대로 */ }
  const keys = [env.SUBWAY_KEY ?? "", b, dec, encodeURIComponent(dec)].filter(Boolean).sort((x, y) => y.length - x.length);
  return keys.reduce((s, k) => s.split(k).join("***"), String(text));
}

// ---------- 시각 ----------
/** 실시간 데이터가 만들어진 뒤(recptnDt/mkTm 'YYYY-MM-DD HH:MM:SS' KST) 흐른 초. 남은 시간에서 빼 준다. */
export function ageSec(stamp: unknown, now: Date) {
  const t = Date.parse(`${String(stamp ?? "").slice(0, 19).replace(" ", "T")}+09:00`);
  return isNaN(t) ? 0 : Math.max(0, Math.floor((now.getTime() - t) / 1000));
}

// ---------- 이름 ----------
/** 카카오 이름('노원역', '강남역(2호선)', '서울역 1호선') → 실시간 API 이름('노원', '강남', '서울'). */
export function normStation(name?: string | null) {
  let n = (name ?? "").trim().split(" ")[0];
  n = n.replace(/\([^()]*선\)$/, "");
  if (n.length > 1 && n.endsWith("역")) n = n.slice(0, -1);
  return n;
}
const nameParts = (name?: string | null) => new Set(normStation(name).split(/[(),]/).filter(Boolean));
/** '이수' == '총신대입구(이수)', '신촌' == '신촌(경의중앙선)'. */
export function sameStation(x?: string | null, y?: string | null) {
  if (!x || !y) return false;
  const a = nameParts(x), b = nameParts(y);
  return [...a].some((p) => b.has(p));
}
/** '4호선', '수도권 4호선' → '1004'. 모르면 ''. */
export function lineId(line?: string | null) {
  const s = (line ?? "").replace(/ /g, "");
  for (const k of Object.keys(LINE_ID).sort((a, b) => b.length - a.length)) if (s.includes(k)) return LINE_ID[k];
  return "";
}
/** '수도권 4호선' → '4호선', '경의중앙선' 그대로. 노선명이 없으면 subwayId로. */
export function lineLabel(line?: string | null, sid = "") {
  let s = (line ?? "").replace(/^\s*수도권\s*/, "").trim();
  if (!s && sid) s = Object.keys(LINE_ID).find((k) => LINE_ID[k] === sid) ?? "";
  const m = /(?<!인천)([1-9])\s*호선/.exec(s);
  return m ? `${m[1]}호선` : (s || "지하철");
}
/** '노원역 11234' → '노원역', '11234' → ''. */
export const stopName = (v?: string | null) => (v ?? "").trim().replace(/\s*(?<!\d)\d{5}\s*$/, "");
/** '1142 (노원역1번출구→노원구청)' → '1142번'. */
export function busLabel(seg: Seg) {
  const m = BUS_LINE_RE.exec(seg.line ?? "");
  const no = (m ? m[1] : (seg.line ?? "")).trim().replace(/번+$/, "");
  return no ? `${no}번` : "버스";
}
export const segLabel = (seg: Seg) => seg.kind === "bus" ? busLabel(seg) : lineLabel(seg.line);
/** 승차 지점 이름 (체인 문구용): 지하철 '노원역', 버스는 line 괄호의 승차 정류장 이름. */
function placeOf(seg: Seg) {
  if (seg.kind === "subway") return `${normStation(seg.station_from)}역`;
  const m = BUS_LINE_RE.exec(seg.line ?? "");
  return (m ? m[2].split("→")[0] : stopName(seg.station_from)) || seg.station_from || "정류장";
}

// ---------- 실시간 지하철 ----------
const subwayBase = (c: Ctx) => `http://swopenapi.seoul.go.kr/api/subway/${c.env.SUBWAY_KEY}/json`;
async function fetchArrivals(c: Ctx, station: string): Promise<A[]> {
  const r = await c.f(`${subwayBase(c)}/realtimeStationArrival/0/30/${encodeURIComponent(station)}`);
  if (!r.ok) { await r.body?.cancel(); throw new Error(`지하철 API HTTP ${r.status}`); }
  const j = await r.json();
  const err = j.errorMessage ?? j;
  if (![undefined, null, "INFO-000", "INFO-200"].includes(err.code)) throw new Error(`지하철 API ${err.code} ${err.message}`);   // INFO-200 = 데이터 없음
  return j.realtimeArrivalList ?? [];
}
const ALL_NAMES = new WeakMap<typeof fetch, string[]>();   // fetch 함수별 (시험용 가짜와 섞이지 않게)
/** '이수' → ['총신대입구(이수)']. 전체 도착 목록에서 정식 이름을 찾는다 (이름이 안 맞을 때만 호출). */
async function officialNames(c: Ctx, name: string) {
  let all = ALL_NAMES.get(c.f);
  if (!all) {
    try {
      const r = await c.f(`${subwayBase(c)}/realtimeStationArrival/ALL`);
      const j = await r.json();
      all = [...new Set<string>((j.realtimeArrivalList ?? []).map((a: A) => a.statnNm).filter(Boolean))].sort();
    } catch (e) { c.log(`역 이름 목록 조회 실패: ${redact(String(e), c.env)}`); all = []; }
    if (all.length) ALL_NAMES.set(c.f, all);
  }
  return all.filter((n) => n !== name && sameStation(n, name));
}
/** [정식 역 이름, 그 역의 도착 목록 — lid 노선만]. 이름이 안 맞으면 정식 이름 후보로 다시 조회. */
async function stationArrivals(c: Ctx, name: string | null | undefined, lid: string): Promise<[string, A[]]> {
  const n = normStation(name);
  if (!n) return ["", []];
  const byLine = (arr: A[]) => arr.filter((a) => !lid || a.subwayId === lid);
  let arr = byLine(await fetchArrivals(c, n));
  if (arr.length) return [n, arr];
  for (const cand of await officialNames(c, n)) {
    arr = byLine(await fetchArrivals(c, cand));
    if (arr.length) return [cand, arr];
  }
  return [n, []];
}
/** 이 역 도착까지 남은 초. 이미 떠났거나 알 수 없으면 null. */
export function subwayEta(a: A, now: Date): number | null {
  const cd = String(a.arvlCd ?? "");
  if (cd === "2") return null;                                // 출발 — 방금 떠남
  let sec = toInt(a.barvlDt);
  if (sec <= 0) {                                             // 1호선 등 코레일 구간은 barvlDt가 0
    const msg = String(a.arvlMsg2 ?? ""), ordkey = String(a.ordkey ?? "");
    const m = MIN_SEC_RE.exec(msg), n = STATIONS_AWAY_RE.exec(msg);
    if (cd === "0" || cd === "1") sec = 0;                    // 진입·도착
    else if (m) sec = toInt(m[1]) * 60 + toInt(m[2]);
    else if (["3", "4", "5"].includes(cd)) sec = 90;          // 전역 출발·진입·도착
    else if (n) sec = toInt(n[1]) * SEC_PER_STATION;          // '[14]번째 전역 (안양)'
    else if (/^\d{3}$/.test(ordkey.slice(2, 5))) sec = toInt(ordkey.slice(2, 5)) * SEC_PER_STATION;   // ordkey 3~5번째 = 남은 역 수
    else return null;
  }
  return sec - ageSec(a.recptnDt, now);
}
/** barvlDt 없이 추정한 남은 시간이면 true → '약'. */
export const isRough = (a: A) => toInt(a.barvlDt) <= 0 && !["0", "1"].includes(String(a.arvlCd ?? ""));
/** [(남은 초, 열차)] 빨리 오는 순. 남은 시간을 모르는 열차는 뺀다. */
export function timedTrains(trains: A[], now: Date): [number, A][] {
  return trains.map((a): [number | null, A] => [subwayEta(a, now), a])
    .filter((x): x is [number, A] => x[0] !== null).sort((x, y) => x[0] - y[0]);
}
/** [종착역, 다음 역]. */
export function parseTln(a: A): [string, string] {
  const m = TLN_RE.exec(a.trainLineNm ?? "");
  return m ? [m[1].trim(), m[2].trim()] : [a.bstatnNm ?? "", ""];
}
const inLoop2 = (sid: string, ...ids: number[]) => sid === "1002" && ids.every((v) => LOOP2[0] <= v && v <= LOOP2[1]);
/** 같은 노선 두 역 ID 사이 거리(≈역 개수). 2호선 본선은 순환이라 짧은 쪽. */
export function idDist(sid: string, x: number, y: number) {
  if (inLoop2(sid, x, y)) { const n = LOOP2[1] - LOOP2[0] + 1; const d = ((y - x) % n + n) % n; return Math.min(d, n - d); }
  return Math.abs(y - x);
}
/** {subwayId: 이 역의 statnId}. */
export function stationIds(arr: A[]) {
  const out: Record<string, number> = {};
  for (const a of arr) if (/^\d+$/.test(String(a.statnId ?? ""))) out[a.subwayId] = toInt(a.statnId);
  return out;
}
/** 도착역 쪽으로 가는 열차만 고른다 → [열차 목록, 근거]. 판정 못 하면 [null, 사유]. */
export function pickDirection(arr: A[], bName: string, bIds: Record<string, number>): [A[] | null, string] {
  const groups = new Map<string, A[]>();                     // 다음 역이 같으면 같은 방향
  for (const a of arr) { const k = `${a.subwayId}|${a.statnTid}`; if (!groups.has(k)) groups.set(k, []); groups.get(k)!.push(a); }
  if (!bName) return [null, "도착역 정보 없음"];
  for (const g of groups.values()) if (sameStation(parseTln(g[0])[1], bName)) return [g, `방면이 ${bName}`];   // 1) 방면 = 도착역
  const hit = [...groups.values()].filter((g) => g.some((a) => sameStation(parseTln(a)[0], bName) || sameStation(a.bstatnNm, bName)));
  if (hit.length === 1) return [hit[0], `${bName}행 열차의 방향`];   // 2) 도착역행 열차가 한 방향에만
  let best: [number, A[]] | null = null;                     // 3) 다음 역 ID가 도착역 ID에 가까워지는 쪽
  for (const [key, g] of groups) {
    const [sid, tid] = key.split("|");
    const aId = String(g[0].statnId ?? "");
    if (!(sid in bIds) || !/^\d+$/.test(tid ?? "") || !/^\d+$/.test(aId)) continue;
    const dNow = idDist(sid, toInt(aId), bIds[sid]), dNext = idDist(sid, toInt(tid), bIds[sid]);
    if (dNext < dNow && (best === null || dNext < best[0])) best = [dNext, g];
  }
  return best ? [best[1], "역 ID 순서"] : [null, "방향 판정 실패"];
}
/** 회차(중간 종착) 열차를 뺀다. ① 종착역이 진행 방향 뒤쪽(이 역에 오기 전에 끝남) ② 종착역이 이 역과 도착역 사이.
 *  2호선 본선 순환열차와, 역 ID 앞 7자리가 다른(지선 등) 경우는 판단하지 않고 남긴다. */
export function dropShortTurn(trains: A[], bIds: Record<string, number>) {
  const keep: A[] = [];
  const sameBlock = (...v: number[]) => new Set(v.map((x) => String(x).slice(0, 7))).size === 1;
  for (const a of trains) {
    const sid = a.subwayId, bId = bIds[sid];
    const aId = parseInt(a.statnId), nId = parseInt(a.statnTid), tId = parseInt(a.bstatnId);
    if ([aId, nId, tId].some(isNaN)) { keep.push(a); continue; }
    if (!inLoop2(sid, aId, tId) && sameBlock(aId, nId, tId) && (tId - aId) * (nId - aId) < 0) continue;      // ①
    if (bId && !inLoop2(sid, aId, bId) && sameBlock(aId, tId, bId)) {
      const dab = idDist(sid, aId, bId), dat = idDist(sid, aId, tId);
      if (0 < dat && dat < dab && dat + idDist(sid, tId, bId) === dab) continue;                              // ②
    }
    keep.push(a);
  }
  return keep;
}
async function subwayLive(c: Ctx, seg: Seg, ready: number): Promise<Live> {
  const lid = lineId(seg.line);
  let [aName, arr] = await stationArrivals(c, seg.station_from, lid);
  const [bName, bArr] = seg.station_to ? await stationArrivals(c, seg.station_to, lid) : ["", [] as A[]];
  if (!lid && bArr.length) {                                  // 노선명을 못 읽었으면 출발·도착역에 같이 서는 노선
    const common = new Set(bArr.map((b: A) => b.subwayId));
    const f = arr.filter((a) => common.has(a.subwayId)); if (f.length) arr = f;
  }
  const bIds = stationIds(bArr);
  const line = lineLabel(seg.line, lid || (arr[0]?.subwayId ?? ""));
  if (!arr.length) return { line, waits: [], note: "열차 정보 없음" };

  let trains: A[] | null, basis: string;
  if (seg.updn) {   // updnLine은 상행/하행/내선/외선 — '내선순환', '상행선'처럼 적어도 맞게
    trains = arr.filter((a) => String(seg.updn).includes(a.updnLine || "?")); basis = `저장된 방향 ${seg.updn}`;
  } else [trains, basis] = pickDirection(arr, bName, bIds);
  c.log(`    지하철 ${aName}→${bName || "?"} ${seg.line ?? ""}: 방향 근거 = ${basis}`);

  if (trains === null) {                                      // 방향 미확정 → 방향마다 (섞어서 틀린 열차를 고르지 않게)
    const groups = new Map<string, A[]>();
    for (const a of dropShortTurn(arr, bIds)) {
      const nxt = parseTln(a)[1], k = nxt ? `${nxt}방면` : (a.updnLine || "?");
      if (!groups.has(k)) groups.set(k, []); groups.get(k)!.push(a);
    }
    const ways: Way[] = [];
    for (const [way, g] of groups) {
      const cat = timedTrains(g, c.now).filter(([e]) => e >= ready).slice(0, 2);
      if (cat.length) ways.push({ line: `${line} ${way}`, waits: cat.map(([e]) => e) });
    }
    return ways.length ? { line, waits: [], note: "방향 미확정", ways } : { line, waits: [], note: "방향 미확정 · 잡을 수 있는 열차 없음" };
  }
  const timed = timedTrains(dropShortTurn(trains, bIds), c.now);
  for (const [e, a] of timed) c.log(`      ${a.trainLineNm} 열차 ${a.btrainNo} ${e}초 (${a.arvlMsg2 ?? ""})`);
  if (!timed.length) return { line, waits: [], note: "열차 정보 없음" };
  const cat = timed.filter(([e]) => e >= ready).slice(0, 2);
  if (!cat.length) return { line, waits: [], note: "보이는 열차는 놓칠 듯 · 다음 열차 기준" };
  const out: Live = { line, waits: cat.map(([e]) => e) };
  if (cat.some(([, a]) => isRough(a))) out.rough = true;
  return out;
}

// ---------- 실시간 버스 (서울 버스, 공공데이터포털) ----------
async function busGet(c: Ctx, op: string, params: Record<string, string>): Promise<A[]> {
  const q = new URLSearchParams({ resultType: "json", ...params }).toString();
  const r = await c.f(`${BUS_BASE}/${op}?serviceKey=${busKeyParam(c.env.BUS_KEY ?? "")}&${q}`);
  if (r.status === 401 || r.status === 403) {
    await r.body?.cancel();
    const svc = op.split("/")[0];
    throw new Error(`버스 키가 '${BUS_SERVICE[svc] ?? svc}' 서비스에 등록 안 됨 — 공공데이터포털 활용신청 확인`);
  }
  if (!r.ok) { await r.body?.cancel(); throw new Error(`버스 API HTTP ${r.status}`); }
  const j = await r.json();
  const h = j.msgHeader ?? {};
  if (!["0", "4"].includes(String(h.headerCd))) throw new Error(`버스 API ${h.headerCd} ${h.headerMsg}`);   // 0 정상, 4 결과 없음
  return j.msgBody?.itemList ?? [];
}
const normStop = (name?: string | null) => (name ?? "").replace(/\s/g, "");
export function sameStop(x?: string | null, y?: string | null) {
  const a = normStop(x), b = normStop(y);
  return !!(a && b && (a === b || a.split("(")[0] === b.split("(")[0]));
}
/** rtNm '146' ↔ 카카오 노선명 '146', '146번', '간선 146'. */
export function routeMatch(rtNm?: string | null, line?: string | null) {
  if (!line) return true;
  const rt = normStop(rtNm);
  const toks = new Set(line.split(/[\s:/,()]+/).filter(Boolean).map((t) => t.replace(/번+$/, "")));
  toks.add(normStop(line).replace(/번+$/, ""));
  return !!rt && toks.has(rt);
}
/** 승차 정류장 번호(arsId) 후보 묶음 [[이름이 정확히 같은 곳], [나머지 검색 결과]]. station_from에 5자리 번호가 있으면 그것 하나. */
export async function busStopIds(seg: Seg, env: Env): Promise<string[][]> {
  const s = (seg.station_from ?? "").trim();
  const m = /(?<!\d)(\d{5})(?!\d)/.exec(s);
  if (m) return [[m[1]]];
  if (!s) return [];
  const items = (await busGet(ctxOf(env), "stationinfo/getStationByName", { stSrch: s })).filter((it) => String(it.arsId ?? "0") !== "0");
  const exact: string[] = items.filter((it) => sameStop(it.stNm, s)).map((it) => it.arsId);
  const rest: string[] = items.map((it) => it.arsId).filter((id: string) => !exact.includes(id));
  return [exact, rest.slice(0, 10)];
}
/** n번째(1·2) 도착 예정 버스까지 남은 초. 운행 전·종료면 null. getStationByUid는 traTime{n}만 준다 (exps{n}은 예비). */
export function busEta(it: A, n: 1 | 2, now: Date): number | null {
  const msg = String(it[`arrmsg${n}`] ?? "");
  if (!msg || ["운행종료", "출발대기", "회차대기", "정보없음"].some((w) => msg.includes(w))) return null;
  let sec = toInt(it[`traTime${n}`]) || toInt(it[`exps${n}`]);
  if (sec <= 0) {
    if (msg.includes("곧 도착")) sec = 30;
    else { const m = MIN_SEC_RE.exec(msg); if (!m) return null; sec = toInt(m[1]) * 60 + toInt(m[2]); }
  }
  return sec - ageSec(it.mkTm, now);
}
/** 같은 이름 정류장이 길 양쪽에 있을 때 도착 정류장 쪽으로 가는 쪽을 고른다 → [항목들, 근거]. */
export async function pickBusStop(entries: A[], seg: Seg, env: Env): Promise<[A[], string]> {
  if (entries.length <= 1) return [entries, "정류장 하나"];
  const to = seg.station_to;
  if (!to) return [entries, "도착 정류장 정보 없음"];
  const nx = entries.filter((e) => sameStop(e.nxtStn, to));
  if (nx.length === 1) return [nx, "다음 정류장이 도착 정류장"];
  let stops: A[];
  try { stops = await busGet(ctxOf(env), "arrive/getArrInfoByRouteAll", { busRouteId: String(entries[0].busRouteId) }); }
  catch (e) { return [entries, `노선 순서 조회 실패: ${redact(String(e), env)}`]; }
  const n = stops.length;
  const ords: Record<string, number> = {};
  for (const s of stops) ords[s.arsId] = toInt(s.staOrd);
  const toOrds = stops.filter((s) => sameStop(s.stNm, to)).map((s) => toInt(s.staOrd));
  let best: [number, A] | null = null;
  for (const e of entries) {
    const fo = ords[e.arsId] || toInt(e.staOrd);
    const gaps = toOrds.map((t) => ((t - fo) % n + n) % n).filter(Boolean);
    if (fo && gaps.length && (best === null || Math.min(...gaps) < best[0])) best = [Math.min(...gaps), e];
  }
  return best ? [[best[1]], "노선 정류장 순서"] : [entries, "방향 판정 실패"];
}
async function busLive(c: Ctx, seg: Seg, ready: number): Promise<Live> {
  let entries: A[] = [];
  for (const group of await busStopIds(seg, c.env)) {        // 이름 정확히 같은 정류장부터, 그 노선이 없으면 나머지 후보
    entries = [];
    for (const ars of group) {
      entries.push(...(await busGet(c, "stationinfo/getStationByUid", { arsId: ars })).filter((it) => routeMatch(it.rtNm, seg.line)));
    }
    if (entries.length) break;
  }
  if (!entries.length) return { line: busLabel(seg), waits: [], note: "버스 정보 없음" };
  let picked: A[], basis: string;
  if (seg.line) [picked, basis] = await pickBusStop(entries, seg, c.env);
  else {                                                      // 노선을 모르면 그 정류장 버스 중 빨리 오는 3개
    const soon = (e: A) => busEta(e, 1, c.now) ?? 1e9;
    picked = [...entries].sort((a, b) => soon(a) - soon(b)).slice(0, 3); basis = "노선 미지정";
  }
  c.log(`    버스 ${seg.station_from}→${seg.station_to ?? "?"} ${seg.line ?? ""}: 정류장 근거 = ${basis}`);
  const res: Live[] = picked.map((e) => {
    c.log(`      ${e.rtNm} ${e.stNm}(${e.arsId}) ${e.adirection}방향 vehId1=${e.vehId1} traTime1=${e.traTime1} (${e.arrmsg1})`);
    const line = (e.rtNm ? `${e.rtNm}번` : busLabel(seg)) + (picked.length > 1 && e.adirection ? `(${e.adirection} 방향)` : "");
    const etas = [busEta(e, 1, c.now), busEta(e, 2, c.now)].filter((x): x is number => x !== null).sort((a, b) => a - b);
    const cat = etas.filter((x) => x >= ready).slice(0, 2);
    if (cat.length) return { line, waits: cat };
    if (etas.length) return { line, waits: [], note: "보이는 버스는 놓칠 듯 · 다음 버스 기준" };
    return { line, waits: [], note: e.arrmsg1 || "도착 정보 없음" };   // '운행종료' 등
  });
  if (res.length === 1) return res[0];
  const main = [...res].filter((r) => r.waits.length).sort((a, b) => a.waits[0] - b.waits[0])[0] ?? res[0];   // 가장 빨리 오는 버스
  return { ...main, ways: res.map((r) => ({ line: r.line, waits: r.waits })) };
}

// ---------- 내보내는 함수 ----------
/** 탈 구간 하나의 실시간. waits = 지금부터 몇 초 뒤 도착 (readyInSec 이후, 최대 2대). 탈 구간이 아니면 null. */
export async function liveForSegment(seg: Seg, readyInSec: number, env: Env): Promise<Live | null> {
  if (!isRide(seg)) return null;
  const c = ctxOf(env);
  if (!(seg.kind === "subway" ? env.SUBWAY_KEY : env.BUS_KEY)) return { line: segLabel(seg), waits: [], note: "실시간 키 없음" };
  try {
    return await (seg.kind === "subway" ? subwayLive : busLive)(c, seg, readyInSec);
  } catch (e) {
    c.log(`    ${seg.kind} 실시간 실패: ${redact(String(e), env)}`);
    return { line: segLabel(seg), waits: [], note: "실시간 조회 실패" };
  }
}

/** watch.py live_lines 체인. segments[fromIndex]부터 따라가며 각 승차 지점에 닿는 시각(readyInSec)을 쌓는다:
 *    walkSec + 도보·환승·승차 예상 + 앞 구간에서 고른 차의 실제 대기 (traTime·barvlDt)
 *    예) 정류장까지 도보 0분 + 버스 대기 7분 + 승차 8분 + 환승 도보 4분 = 노원역 20분 뒤 → 20분 뒤 이후 첫 열차
 *  첫 탈 구간은 항상 한 항목(note 포함), 뒤 구간은 잡을 수 있는 차가 보일 때만. 탈 차를 못 정하면(놓침·정보 없음·방향 미확정)
 *  그다음 승차 시각을 알 수 없어 멈추고, 뒤 구간이 30분 넘게 남아도 멈춘다. */
export async function liveChain(segments: Seg[], fromIndex: number, walkSec: number, env: Env): Promise<ChainItem[]> {
  env = { ...env, now: env.now ?? new Date() };               // 모든 구간을 같은 '지금' 기준으로
  const log = env.log ?? ((m: string) => console.log(m));
  const out: ChainItem[] = [];
  let offset = walkSec, first = true, chain: string[] = [];
  for (let i = Math.max(0, fromIndex); i < segments.length; i++) {
    const seg = segments[i], sec = seg.expected_sec || 0;
    if (!isRide(seg)) {
      if (!first) chain.push(`${seg.kind === "transfer" ? "환승 도보" : "도보"} ${mins(sec)}분`);
      offset += sec;
      continue;
    }
    if (first) chain = [`${seg.kind === "bus" ? "정류장" : "역"}까지 도보 ${mins(offset)}분`];
    const chainTxt = `${chain.join(" + ")} = ${placeOf(seg)} ${mins(offset)}분 뒤`;
    if (!first) {
      log(`    체인: ${chainTxt}`);
      if (offset > REALTIME_HORIZON) { log(`    → 실시간 범위(${REALTIME_HORIZON / 60}분) 밖이라 여기서 멈춤`); break; }
    }
    const live = (await liveForSegment(seg, offset, env))!;
    const caught = live.waits.length > 0;
    if (first || caught) out.push({ ...live, index: i, kind: seg.kind, readyInSec: offset, chain: chainTxt });
    if (!caught) {
      if (segments.slice(i + 1).some(isRide)) log("    → 탈 차를 못 정해 다음 승차 지점 도착 시각을 알 수 없음 — 여기서 멈춤");
      break;
    }
    chain.push(`${seg.kind === "bus" ? "버스" : "열차"} 대기 ${mins(live.waits[0] - offset)}분`, `승차 ${mins(sec)}분`);
    offset = live.waits[0] + sec;
    first = false;
  }
  return out;
}

/** 한 항목 문구 (watch.py와 같은 말): '4호선 3분·9분 뒤 도착' — 숫자는 승차 지점에 닿은 뒤 대기(waits − readyInSec). */
export function liveLineText(live: Live, readyInSec: number, first = true): string {
  const one = (line: string, waits: number[], i: number) =>
    `${line} ${live.rough ? "약 " : ""}${waits.map((w) => waitTxt(w - readyInSec)).join("·")} 뒤${first && i === 0 ? " 도착" : ""}`;
  const ways = (live.ways ?? []).filter((w) => w.waits.length);
  if (ways.length) return ways.map((w, i) => one(w.line, w.waits, i)).join(" / ");
  if (live.note) return `${live.line} ${live.note}`;
  return one(live.line, live.waits, 0);
}
/** watch.py live 알림과 같은 한 줄: '🚇 지금 출발하면: 4호선 3분·9분 뒤 도착 / 472번 5분 뒤'. */
export function liveText(items: ChainItem[]): string {
  if (!items.length) return "🚶 지금 출발하세요 (실시간 정보 없음)";
  const icon = items[0].kind === "bus" ? "🚌" : "🚇";
  return `${icon} 지금 출발하면: ${items.map((it, i) => liveLineText(it, it.readyInSec, i === 0)).join(" / ")}`;
}
