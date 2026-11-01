// supabase/functions/_shared/alight.ts — 이동 중 하차 알림. tick이 매분 부르고(새 메시지로 발송), 이동 중 카드에도 한 줄 보인다.
//
// 언제: 탑승 중에만 — boarded_at 뒤 환승 하차 전이면 첫 탈 구간, transfer_on_at 뒤면 두 번째 탈 구간.
// 무엇을: 그 구간의 하차 지점(환승역·환승 정류장, 마지막 구간이면 최종 하차 지점)까지 남은 정거장 level
//   2 → "🔔 2정거장 뒤 노원 하차 · 7호선 환승"
//   1 → "🔔 다음 역 노원, 내릴 준비"                       (버스는 "다음 정류장")
//   0 → "🚪 노원 도착 · 내리세요 (7호선 장암 방면, 도보 4분)"   (마지막 구간이면 "목적지까지 도보 N분")
// level 구하는 순서 (alightState):
//   1) 실시간 rideStops(realtime.ts): 탄 차(trips.ride_train·ride_veh)를 하차 지점 도착 목록에서 찾는다 (지하철식 셈).
//      1이면서 60초 안에 닿으면(버스 '곧 도착', 지하철 전역 출발) 0 — 매분 확인이라 진입·도착(30~60초)을 놓치지 않게.
//      하차역 출발(arvlCd 2)이거나, 1 이하로 보이던 차가 하차 지점 목록에서 빠졌으면 '지남' → 안 보냄. 4분 넘은 자료는 안 믿음.
//   2) 실시간으로 못 잡으면(인천 1호선처럼 API에 없음·탄 차 모름·안 보임·키 없음) 비례 추정, 문구에 "(추정)":
//      탄 뒤 흐른 시간 ÷ 구간 예상(expected_sec) × 정거장 수(segments.stop_names 개수 − 1). 목록이 없으면 정거장당 2분.
//      남은 예상 60초 이하면 0. 예상보다 5분 넘게 지났으면(도착 버튼을 안 누른 날 등) 추정으로는 안 보냄.
//   예상 남은 시간이 15분 넘고 추정 4정거장 넘게 남았으면 실시간은 부르지 않는다 (API 한도 아끼기).
// 보내는 규칙 (pickAlert): 지금 level 하나만 — 2에서 0으로 건너뛰면 0만. 같은·더 가까운 단계를 이미 보냈으면 안 보냄,
//   users.alight_alerts('2,1,0')에서 끈 단계도 안 보냄. 동시 실행 중복은 tick이 trip_alerts(trip_id, seg_index, kind) 유니크로 막는다.

import { rideStops, subwayHeading, boardingVehicle, isRide, normStation, lineLabel, busLabel, stopName, placeOf, SEC_PER_STATION,
  type Seg, type Env, type Ride, type RideStops } from "./realtime.ts";

// deno-lint-ignore no-explicit-any
type Trip = Record<string, any>;

export const ALERT_LEVELS = [2, 1, 0] as const;
export const DEFAULT_ALERTS = "2,1,0";        // users.alight_alerts 기본값
export const ARRIVE_SOON_SEC = 60;            // 이 안에 닿으면 '도착'
export const LIVE_FROM_SEC = 15 * 60;         // 추정 남은 시간이 이보다 길고
export const LIVE_FROM_STOPS = 3;             //   추정 남은 정거장이 이보다 많으면 실시간 조회 안 함
export const ESTIMATE_GRACE_SEC = 5 * 60;     // 추정: 예상 승차 시간 + 5분이 지나면 알림 안 함
export const STALE_SEC = 4 * 60;              // 실시간 자료가 이보다 오래됐으면 안 믿음
export const PASSED_MEMORY_MS = 10 * 60_000;  // 1정거장 안으로 보였던 차가 사라지면 10분 동안 '지남'으로 본다
const BUS_LINE_RE = /^\s*(.*?)\s*\((.*)\)\s*$/;   // '1142 (노원역1번출구→노원구청)'

// ---------- 설정 ----------
/** users.alight_alerts('2,1,0') → {2,1,0}. null·undefined(컬럼 없음)면 전부 켬, ''면 전부 끔. */
export function alertPrefs(v: unknown): Set<number> {
  if (v === null || v === undefined) return new Set(ALERT_LEVELS);
  return new Set(String(v).split(/[^0-9]+/).filter((x) => /^[012]$/.test(x)).map(Number));
}
export const prefsText = (s: Set<number>) => ALERT_LEVELS.filter((k) => s.has(k)).join(",");

// ---------- 지금 탄 구간 ----------
export const rideIndexes = (segments: Seg[]) => segments.map((s, i) => isRide(s) ? i : -1).filter((i) => i >= 0);
/** 탑승 단계 → 그때 타는 구간 index. boarded_at = 첫 탈 구간, transfer_on_at = 두 번째. 탑승 단계가 아니거나 없으면 -1. */
export function rideIndexFor(field: string, segments: Seg[]) {
  const r = rideIndexes(segments);
  return field === "boarded_at" ? r[0] ?? -1 : field === "transfer_on_at" ? r[1] ?? -1 : -1;
}
/** 지금 타고 있는 구간과 탄 시각. 탑승 중이 아니면 null. */
export function currentRide(t: Trip, segments: Seg[]): { index: number; since: string } | null {
  if (t.ended_at) return null;
  if (t.transfer_on_at) {
    const i = rideIndexFor("transfer_on_at", segments);
    return i >= 0 ? { index: i, since: t.transfer_on_at } : null;
  }
  if (t.transfer_off_at || !t.boarded_at) return null;
  const i = rideIndexFor("boarded_at", segments);
  return i >= 0 ? { index: i, since: t.boarded_at } : null;
}
/** 탑승 버튼 순간 탄 차 → trips에 넣을 { ride_veh, ride_train } (못 정하면 둘 다 null — 앞 구간 차를 지운다).
 *  탑승 단계(boarded_at·transfer_on_at)가 아니면 null. */
export async function rideOnBoard(field: string, segments: Seg[], env: Env): Promise<{ ride_veh: string | null; ride_train: string | null } | null> {
  const i = rideIndexFor(field, segments);
  if (i < 0) return null;
  const r = await boardingVehicle(segments[i], env, { boarded: true });
  return { ride_veh: r.vehId ?? null, ride_train: r.trainNo ?? null };
}

// ---------- 이름 ----------
/** 하차 지점 이름: 지하철 '노원', 버스는 line 괄호의 하차 정류장 이름 ('노원구청'). */
export function alightPlace(seg: Seg) {
  if (seg.kind === "subway") return normStation(seg.station_to) || "하차역";
  const m = BUS_LINE_RE.exec(seg.line ?? "");
  const name = m ? (m[2].split("→")[1] ?? "").trim() : "";
  if (name && name !== "?") return name;
  return stopName(seg.station_to) || (seg.station_to ? `${seg.station_to}번 정류장` : "하차 정류장");
}
const rideName = (seg: Seg) => seg.kind === "bus" ? busLabel(seg) : lineLabel(seg.line);
/** index 다음의 탈 구간과 그 사이 도보·환승 예상(초). 다음 탈 구간이 없으면 seg null, walkSec = 목적지까지 도보. */
export function nextRide(segments: Seg[], index: number): { seg: Seg | null; index: number; walkSec: number } {
  let walk = 0;
  for (let i = index + 1; i < segments.length; i++) {
    if (isRide(segments[i])) return { seg: segments[i], index: i, walkSec: walk };
    walk += segments[i].expected_sec || 0;
  }
  return { seg: null, index: -1, walkSec: walk };
}

// ---------- 추정 ----------
/** segments.stop_names (jsonb 배열, 승차·하차 정거장 포함). 문자열로 와도 읽는다. */
export function stopList(seg: Seg): string[] {
  let v: unknown = seg.stop_names;
  if (typeof v === "string") { try { v = JSON.parse(v); } catch { v = []; } }
  return Array.isArray(v) ? v.map((x) => String(x ?? "").trim()).filter(Boolean) : [];
}
/** 비례 추정: away = 정거장 수 − floor(흐른 시간 ÷ 예상 × 정거장 수). 목록이 없거나 양 끝만 있는데 5분 넘는 구간이면 정거장당 2분.
 *  남은 예상 60초 이하면 0. 예상이 없거나 예상 + 5분이 지났으면 null. */
export function estimateAway(seg: Seg, elapsedSec: number): { away: number; remainingSec: number; hops: number | null } | null {
  const exp = seg.expected_sec || 0;
  if (exp <= 0 || elapsedSec > exp + ESTIMATE_GRACE_SEC) return null;
  const remainingSec = Math.max(0, exp - elapsedSec);
  let hops = stopList(seg).length - 1;
  if (hops < 1 || (hops === 1 && exp > 5 * 60)) hops = 0;
  const away = remainingSec <= ARRIVE_SOON_SEC ? 0
    : hops ? hops - Math.floor(Math.min(hops, (elapsedSec / exp) * hops))
    : Math.ceil(remainingSec / SEC_PER_STATION);
  return { away, remainingSec, hops: hops || null };
}

// ---------- 판단 ----------
/** 실시간 결과 → level. 1이면서 60초 안에 닿으면(버스 '곧 도착', 지하철 전역 출발 arvlCd 3) 0. 모르면 null. */
export function liveLevel(r: RideStops, kind: string): number | null {
  if (r.source !== "live" || r.away === null || r.away === undefined) return null;
  const soon = typeof r.etaSec === "number" && r.etaSec <= ARRIVE_SOON_SEC;
  if (r.away === 1 && soon && (kind === "bus" || r.code === "3")) return 0;
  return r.away;
}
export type AlightState = {
  index: number; kind: string; place: string; elapsedSec: number;
  level: number | null;                               // 하차 지점까지 남은 정거장 (null = 모름 또는 지남)
  source: "live" | "estimate" | "passed" | "none";
  hops?: number | null; remainingSec?: number; live?: RideStops; note?: string;
};
export type LastLive = { level: number; at: number };   // 이 구간에서 마지막으로 실시간으로 본 level과 그 시각(ms)

/** 탑승 중이면 지금 탄 구간의 하차 상태, 아니면 null. lastLive(index) = tick이 기억하는 그 구간의 마지막 실시간 level. */
export async function alightState(t: Trip, segments: Seg[], env: Env,
  o: { lastLive?: (index: number) => LastLive | null | undefined; stops?: typeof rideStops } = {}): Promise<AlightState | null> {
  const cur = currentRide(t, segments);
  if (!cur) return null;
  const now = env.now ?? new Date(), seg = segments[cur.index];
  const elapsedSec = Math.max(0, Math.round((now.getTime() - Date.parse(cur.since)) / 1000));
  const est = estimateAway(seg, elapsedSec);
  const base = { index: cur.index, kind: seg.kind, place: alightPlace(seg), elapsedSec };
  const fromEst = (extra: Partial<AlightState>): AlightState => est
    ? { ...base, level: est.away, source: "estimate", hops: est.hops, remainingSec: est.remainingSec, ...extra }
    : { ...base, level: null, source: "none", ...extra };
  if (est && est.remainingSec > LIVE_FROM_SEC && est.away > LIVE_FROM_STOPS) return fromEst({ note: "아직 멀어 실시간 조회 안 함" });

  const ride: Ride = { trainNo: t.ride_train || undefined, vehId: t.ride_veh || undefined };
  const live = await (o.stops ?? rideStops)(seg, ride, { ...env, now });
  if (live.source === "live" && (live.ageSec ?? 0) <= STALE_SEC) {
    const level = liveLevel(live, seg.kind);
    if (level !== null) return { ...base, level, source: "live", live };
  }
  if (live.source === "passed") return { ...base, level: null, source: "passed", live };
  const ll = o.lastLive?.(cur.index);
  if (live.listed && ll && ll.level <= 1 && now.getTime() - ll.at < PASSED_MEMORY_MS) {
    return { ...base, level: null, source: "passed", live, note: "1정거장 안으로 보이던 차가 하차 지점 목록에서 빠짐" };
  }
  return fromEst({ live });
}

/** 보낼 단계: 지금 level 하나만. 꺼 둔 단계, 이미 같은·더 가까운 단계를 보낸 경우, 2보다 먼 경우는 null. */
export function pickAlert(level: number | null, prefs: Set<number>, sent: number[]): number | null {
  if (level === null || level < 0 || level > 2 || !prefs.has(level)) return null;
  return sent.some((k) => k <= level) ? null : level;
}

// ---------- 문구 ----------
/** 알림 문구. heading = 다음 지하철 방면('장암 방면'). estimated면 끝에 ' (추정)'. */
export function alightText(segments: Seg[], index: number, level: number, o: { estimated?: boolean; heading?: string | null } = {}) {
  const seg = segments[index], place = alightPlace(seg), nx = nextRide(segments, index);
  const est = o.estimated ? " (추정)" : "";
  if (level >= 2) return `🔔 ${level}정거장 뒤 ${place} 하차${nx.seg ? ` · ${rideName(nx.seg)} 환승` : ""}${est}`;
  if (level === 1) return `🔔 다음 ${seg.kind === "bus" ? "정류장" : "역"} ${place}, 내릴 준비${est}`;
  const parts: string[] = [];
  if (nx.seg) parts.push(nx.seg.kind === "subway" ? [rideName(nx.seg), o.heading].filter(Boolean).join(" ") : `${rideName(nx.seg)} ${placeOf(nx.seg)}`.trim());
  const wm = Math.round(nx.walkSec / 60);
  if (wm >= 1) parts.push(nx.seg ? `도보 ${wm}분` : `목적지까지 도보 ${wm}분`);
  return `🚪 ${place} 도착 · 내리세요${parts.length ? ` (${parts.join(", ")})` : ""}${est}`;
}
/** alightText + 도착(0) 알림이고 다음이 지하철이면 방면을 실시간으로 (못 구하면 다음 구간 두 번째 정거장 '수락산 방면'). */
export async function alightMessage(segments: Seg[], index: number, level: number, env: Env,
  o: { estimated?: boolean; heading?: typeof subwayHeading } = {}) {
  let heading: string | null = null;
  const nx = nextRide(segments, index);
  if (level === 0 && nx.seg?.kind === "subway") {
    heading = await (o.heading ?? subwayHeading)(nx.seg, env);
    if (!heading) { const s = stopList(nx.seg)[1]; if (s) heading = `${normStation(s)} 방면`; }
  }
  return alightText(segments, index, level, { estimated: o.estimated, heading });
}
/** 이동 중 카드 한 줄: '🚏 노원 하차까지 3정거장', '🚏 다음 역 노원 하차', '🚏 노원 도착'. 모르면·지났으면·정거장 목록 없는 추정이면 ''. */
export function alightLine(st: AlightState | null | undefined): string {
  if (!st || st.level === null || (st.source === "estimate" && !st.hops)) return "";
  const est = st.source === "estimate" ? " (추정)" : "";
  if (st.level === 0) return `🚏 ${st.place} 도착${est}`;
  if (st.level === 1) return `🚏 다음 ${st.kind === "bus" ? "정류장" : "역"} ${st.place} 하차${est}`;
  return `🚏 ${st.place} 하차까지 ${st.level}정거장${est}`;
}
