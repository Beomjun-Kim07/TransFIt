// supabase/functions/_shared/steps.ts — 기록 단계 (trip_events). 환승 횟수 제한 없이 경로 segments에서 단계 목록을 만든다.
//
// 단계 = 출발 → 첫 탈것 승강장/정류장 도착 → 탑승 → 하차 → 다음 탈것 탑승 → 하차 … → 목적지 도착 (마지막 하차 = 목적지 도착)
//   예) 인천1호선 작전→계양, 공항철도 계양→서울역, 4호선 서울역→혜화:
//       출발 · 작전 승강장 도착 · 인천1호선 탑승 · 계양 하차 · 공항철도 탑승 · 서울역 하차 · 4호선 탑승 · 목적지 도착
// 기록: trip_events(trip_id, seg_index, kind 'platform'|'board'|'alight', at), unique(trip_id, seg_index, kind).
//   seg_index = segments를 seq 순으로 놓은 0부터 index (trip_alerts.seg_index와 같음). 출발·도착은 trips.started_at·ended_at 그대로.
// 옛 컬럼 호환 (첫 값만, 비어 있을 때만 채움): 첫 탈 구간 승강장 → platform_at, 탑승 → boarded_at, 하차 → transfer_off_at,
//   두 번째 탈 구간 탑승 → transfer_on_at. watch.py·report.py·개인 첫 도보(started_at→platform_at)는 이 컬럼을 그대로 읽는다.
//   거꾸로 trip_events가 없는 옛 기록·SQL 실행 전엔 옛 컬럼을 이벤트로 읽는다 (eventMap).
// 텔레그램 버튼: trip:ev:<trip_id>:<seg_index>:<kind>, 도착 trip:ended_at:<trip_id>, 출발 trip:start:<route_id>.
//   옛 형식 trip:<platform_at|boarded_at|transfer_off_at|transfer_on_at|ended_at>:<trip_id>도 받는다 (parseCallback).

import { isRide, normStation, lineLabel, busLabel, stopName, type Seg } from "./realtime.ts";

// deno-lint-ignore no-explicit-any
type Trip = Record<string, any>;
export type EvKind = "platform" | "board" | "alight";
export type StepKind = "start" | EvKind | "end";
export type Step = { kind: StepKind; seg: number; label: string; short: string };
export type TripEvent = { seg_index: number; kind: string; at: string };
export type State = "walk" | "platform" | "ride" | "transfer" | "done";
export type Progress = { steps: Step[]; at: (string | null)[]; last: number; next: number; state: State; seg: number; since: string | null };
export type Db = (method: string, path: string, body?: unknown, prefer?: string) => Promise<any>;

export const EV_KINDS: readonly EvKind[] = ["platform", "board", "alight"];
export const LEGACY_FIELDS = ["platform_at", "boarded_at", "transfer_off_at", "transfer_on_at"] as const;
export type LegacyField = typeof LEGACY_FIELDS[number];
const LEGACY: Record<LegacyField, [number, EvKind]> = {          // 옛 컬럼 = [몇 번째 탈 구간, 단계]
  platform_at: [0, "platform"], boarded_at: [0, "board"], transfer_off_at: [0, "alight"], transfer_on_at: [1, "board"],
};
export const EVENTS_EMBED = "trip_events(seg_index,kind,at)";
const BUS_LINE_RE = /^\s*(.*?)\s*\((.*)\)\s*$/;                 // '1142 (노원역1번출구→노원구청)'
const KEEP_YEOK = new Set(["서울", "인천", "부산", "대전", "대구", "광주", "울산", "수원", "청주", "천안"]);   // 도시 이름과 같은 역은 '서울역'

// ---------- 이름 ----------
/** 역 이름 표시: '계양역' → '계양', '서울역 1호선' → '서울역' (도시 이름과 같으면 '역'을 남긴다). */
export function stationName(name?: string | null) {
  const n = normStation(name);
  return KEEP_YEOK.has(n) ? `${n}역` : n;
}
const busNames = (seg: Seg) => { const m = BUS_LINE_RE.exec(seg.line ?? ""); return m ? m[2].split("→").map((x) => x.trim()).map((x) => x === "?" ? "" : x) : []; };
/** 탈 구간의 승차 지점 이름: 지하철 '작전', 버스는 line 괄호 앞쪽 ('노원역1번출구'). */
export function fromName(seg: Seg) {
  if (seg.kind === "subway") return stationName(seg.station_from);
  return busNames(seg)[0] || stopName(seg.station_from) || (seg.station_from ? `${seg.station_from}번 정류장` : "");
}
/** 탈 구간의 하차 지점 이름: 지하철 '계양'·'서울역', 버스는 line 괄호 뒤쪽 ('노원구청'). */
export function toName(seg: Seg) {
  if (seg.kind === "subway") return stationName(seg.station_to);
  return busNames(seg)[1] || stopName(seg.station_to) || (seg.station_to ? `${seg.station_to}번 정류장` : "");
}
/** 탈 것 이름: '공항철도', '4호선', '인천1호선', '1142번'. */
export const rideName = (seg: Seg) => seg.kind === "bus" ? busLabel(seg) : lineLabel(seg.line);

// ---------- 단계 목록 ----------
export const rideIndexes = (segments: Seg[]) => segments.map((s, i) => isRide(s) ? i : -1).filter((i) => i >= 0);
/** 경로 segments → 단계 목록. 탈 구간이 없으면 출발 → 목적지 도착만. */
export function tripSteps(segments: Seg[]): Step[] {
  const rides = rideIndexes(segments);
  const steps: Step[] = [{ kind: "start", seg: -1, label: "출발했어요", short: "출발" }];
  rides.forEach((i, k) => {
    const s = segments[i], where = s.kind === "bus" ? "정류장" : "승강장", from = fromName(s);
    if (k === 0) steps.push({ kind: "platform", seg: i, label: `${from ? `${from} ` : ""}${where} 도착`, short: where });
    steps.push({ kind: "board", seg: i, label: `${rideName(s)} 탑승`, short: `${rideName(s)} 탑승` });
    if (k < rides.length - 1) { const to = toName(s) || "환승 지점"; steps.push({ kind: "alight", seg: i, label: `${to} 하차`, short: `${to} 하차` }); }
  });
  steps.push({ kind: "end", seg: -1, label: "목적지 도착", short: "도착" });
  return steps;
}
/** 단계 이름. 목록에 없는 단계(마지막 탈 구간 하차 등)도 이름을 만든다. */
export function stepLabel(segments: Seg[], seg: number, kind: StepKind): string {
  const st = tripSteps(segments).find((s) => s.kind === kind && s.seg === seg);
  if (st) return st.label;
  const s = segments[seg];
  if (kind === "alight" && s) return `${toName(s) || "하차 지점"} 하차`;
  if (kind === "board" && s) return `${rideName(s)} 탑승`;
  if (kind === "platform" && s) return `${s.kind === "bus" ? "정류장" : "승강장"} 도착`;
  return kind === "end" ? "목적지 도착" : kind === "start" ? "출발" : "단계";
}

// ---------- 옛 컬럼 ↔ 이벤트 ----------
/** 옛 단계 이름 → { kind, seg }. 'start'·'ended_at'도 받는다. 이 경로에 그만큼 탈 구간이 없거나 모르는 이름이면 null. */
export function legacyStep(field: string, segments: Seg[]): { kind: StepKind; seg: number } | null {
  if (field === "start" || field === "started_at") return { kind: "start", seg: -1 };
  if (field === "ended_at" || field === "end") return { kind: "end", seg: -1 };
  const m = LEGACY[field as LegacyField];
  if (!m) return null;
  const seg = rideIndexes(segments)[m[0]];
  return seg === undefined ? null : { kind: m[1], seg };
}
/** 이 단계를 기록할 때 같이 채울 옛 컬럼 (첫 탈 구간 승강장·탑승·하차, 두 번째 탈 구간 탑승). 없으면 null. */
export function compatField(segments: Seg[], seg: number, kind: string): LegacyField | null {
  const k = rideIndexes(segments).indexOf(seg);
  for (const f of LEGACY_FIELDS) if (LEGACY[f][0] === k && LEGACY[f][1] === kind) return f;
  return null;
}
export const evKey = (seg: number, kind: string) => `${seg}:${kind}`;
/** 이 trip의 이벤트 시각 표: trip_events + 옛 컬럼(같은 단계가 trip_events에 없을 때만). key = 'seg:kind'. */
export function eventMap(t: Trip, segments: Seg[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const e of (t.trip_events ?? []) as TripEvent[]) if (e?.at) map.set(evKey(e.seg_index, e.kind), e.at);
  for (const f of LEGACY_FIELDS) {
    if (!t[f]) continue;
    const ev = legacyStep(f, segments);
    if (ev && !map.has(evKey(ev.seg, ev.kind))) map.set(evKey(ev.seg, ev.kind), t[f]);
  }
  return map;
}
export const stepAt = (step: Step, t: Trip, map: Map<string, string>): string | null =>
  step.kind === "start" ? t.started_at ?? null : step.kind === "end" ? t.ended_at ?? null : map.get(evKey(step.seg, step.kind)) ?? null;

// ---------- 진행 상황 ----------
/** 마지막으로 찍힌 단계(목록 순서로 가장 뒤) → 상태. walk = 승차 지점으로, platform = 승강장 대기, ride = seg 탑승 중,
 *  transfer = seg 하차 뒤 다음 탈 것으로, done = 도착. since = 그 단계 시각. next = 다음에 누를 단계 index. */
export function progress(t: Trip, segments: Seg[]): Progress {
  const steps = tripSteps(segments), map = eventMap(t, segments);
  const at = steps.map((s) => stepAt(s, t, map));
  let last = 0;
  at.forEach((v, i) => { if (v) last = i; });
  const s = steps[last];
  const state: State = s.kind === "end" ? "done" : s.kind === "start" ? "walk" : s.kind === "platform" ? "platform" : s.kind === "board" ? "ride" : "transfer";
  return { steps, at, last, next: Math.min(last + 1, steps.length - 1), state, seg: s.seg, since: at[last] };
}
/** 텔레그램 버튼에 보일 단계: 다음 단계와 그다음(건너뛰기용) 중 안 찍힌 것 최대 max개 + 목적지 도착. 도착했으면 []. */
export function buttonSteps(p: Progress, max = 2): Step[] {
  if (p.state === "done") return [];
  const out = p.steps.slice(p.next).filter((s, k) => s.kind !== "end" && !p.at[p.next + k]).slice(0, max);
  return [...out, p.steps[p.steps.length - 1]];
}

// ---------- 텔레그램 콜백 ----------
export type Callback =
  | { type: "start"; routeId: number }
  | { type: "end"; tripId: number }
  | { type: "ev"; tripId: number; seg: number; kind: EvKind }
  | { type: "legacy"; tripId: number; field: LegacyField };
export function stepCallback(tripId: number, step: Step): string {
  return step.kind === "end" ? `trip:ended_at:${tripId}` : `trip:ev:${tripId}:${step.seg}:${step.kind}`;
}
/** 'trip:ev:<trip>:<seg>:<kind>', 'trip:ended_at:<trip>', 'trip:start:<route>', 옛 'trip:<platform_at|…>:<trip>'. 모르면 null. */
export function parseCallback(data: string): Callback | null {
  const p = String(data ?? "").split(":");
  if (p[0] !== "trip") return null;
  const n = (v: string | undefined) => /^\d+$/.test(v ?? "") ? Number(v) : NaN;
  if (p[1] === "ev" && p.length === 5) {
    const tripId = n(p[2]), seg = n(p[3]);
    return tripId > 0 && seg >= 0 && (EV_KINDS as readonly string[]).includes(p[4]) ? { type: "ev", tripId, seg, kind: p[4] as EvKind } : null;
  }
  if (p.length !== 3 || !(n(p[2]) > 0)) return null;
  if (p[1] === "start") return { type: "start", routeId: n(p[2]) };
  if (p[1] === "ended_at") return { type: "end", tripId: n(p[2]) };
  if ((LEGACY_FIELDS as readonly string[]).includes(p[1])) return { type: "legacy", tripId: n(p[2]), field: p[1] as LegacyField };
  return null;
}

// ---------- 기록 ----------
/** select에 trip_events를 끼워 읽는다. 테이블이 아직 없으면(SQL 실행 전) 빼고 다시 읽는다. read(embed) — embed = ',trip_events(...)' 또는 ''. */
export async function withEvents<T>(read: (embed: string) => Promise<T>): Promise<T> {
  try { return await read(`,${EVENTS_EMBED}`); }
  catch (e) { if (!String(e).includes("trip_events")) throw e; return await read(""); }
}
/** 단계 하나 기록: trip_events에 ignore-duplicates로 넣고(새로 들어갔으면 fresh), 대응하는 옛 컬럼이 비어 있으면 같이 채운다(첫 값만).
 *  trip_events 테이블이 없으면(SQL 전) 옛 컬럼만 — 옛 컬럼도 없는 단계면 오류. t(trips 행)는 기록한 값으로 고쳐 둔다. */
export async function recordEvent(db: Db, t: Trip, segments: Seg[], seg: number, kind: EvKind, atIso: string): Promise<{ fresh: boolean; compat: LegacyField | null }> {
  const field = compatField(segments, seg, kind);
  let fresh: boolean;
  try {
    const rows = await db("POST", "trip_events?on_conflict=trip_id,seg_index,kind", { trip_id: t.id, seg_index: seg, kind, at: atIso },
      "resolution=ignore-duplicates,return=representation");
    fresh = Array.isArray(rows) && rows.length > 0;
    if (fresh) t.trip_events = [...(t.trip_events ?? []), { seg_index: seg, kind, at: atIso }];
  } catch (e) {
    if (!String(e).includes("trip_events")) throw e;
    if (!field) throw new Error("DB 업데이트(trip_events) 전이라 이 단계는 아직 기록할 수 없어요");
    fresh = !t[field];
  }
  let wrote: LegacyField | null = null;
  if (fresh && field && !t[field]) {
    await db("PATCH", `trips?id=eq.${t.id}&${field}=is.null`, { [field]: atIso });
    t[field] = atIso; wrote = field;
  }
  return { fresh, compat: wrote };   // compat = 이번에 채운 옛 컬럼
}
