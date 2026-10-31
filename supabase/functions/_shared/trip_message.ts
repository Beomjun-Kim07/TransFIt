// 이동 중 안내 메시지 — tick(매분 고쳐 쓰기)과 telegram(버튼 누르면 즉시 고쳐 쓰기)이 같이 쓴다.
// 단계: started만 → 승차 지점으로 이동 중 / platform_at → 승강장 대기 / boarded_at → 탑승 중
//       transfer_off_at → 환승 이동 / transfer_on_at → 두 번째 탑승 중
// 도착 예상 = 지금 + 남은 구간 예상 합 + 실시간 대기(_shared/realtime.ts liveChain). 목표 대비 빠름/늦음.

import { liveChain, liveLineText, isRide, segLabel, lineLabel, busLabel, stopName, normStation, REALTIME_HORIZON,
  type Seg, type ChainItem, type Env } from "./realtime.ts";

export type Trip = Record<string, any>;           // trips 행 + routes(name, arrive_by, …) + users(telegram_chat_id)
export type Markup = { inline_keyboard: { text: string; callback_data: string }[][] };

const KST_MS = 9 * 3600 * 1000;
const MAX_TRIP_SEC = 3 * 3600;
const MIN_SAMPLES = 5;
export const LOOKBACK_DAYS = 60;

// ---------- 시각 ----------
const kst = (d: Date) => new Date(d.getTime() + KST_MS);
export const hhmm = (d: Date) => kst(d).toISOString().slice(11, 16);
export const dayStartKst = (d: Date) => new Date(`${kst(d).toISOString().slice(0, 10)}T00:00:00+09:00`);
const since = (ts: string | null, now: Date) => ts ? Math.max(0, (now.getTime() - Date.parse(ts)) / 1000) : 0;
const mins = (sec: number) => Math.round(sec / 60);

/** 출발 시각 기준 ±12시간 안에서 가장 가까운 arrive_by. 그래도 3시간 넘게 차이 나면 null (목표 비교 생략). */
export function targetTime(arriveBy: string, startedAt: string): Date | null {
  const [hh, mm] = String(arriveBy).split(":").map(Number);
  const start = new Date(startedAt), day0 = dayStartKst(start).getTime();
  let best: Date | null = null;
  for (const d of [-1, 0, 1]) {
    const t = new Date(day0 + d * 86400_000 + (hh * 60 + mm) * 60_000);
    const gap = Math.abs(t.getTime() - start.getTime());
    if (gap <= 12 * 3600_000 && (!best || gap < Math.abs(best.getTime() - start.getTime()))) best = t;
  }
  if (best && Math.abs(best.getTime() - start.getTime()) > 3 * 3600_000) return null;
  return best;
}

// ---------- 소요시간 추정 (watch.py estimate_duration) ----------
function quantile(values: number[], p: number) {
  const v = [...values].sort((a, b) => a - b);
  const pos = (v.length - 1) * p, lo = Math.floor(pos), hi = Math.ceil(pos);
  return v[lo] + (v[hi] - v[lo]) * (pos - lo);
}
export function usableDurations(trips: any[]) {
  const out: number[] = [];
  for (const t of trips) {
    if (t.excluded || !t.started_at || !t.ended_at) continue;
    const d = (Date.parse(t.ended_at) - Date.parse(t.started_at)) / 1000;
    if (d >= 180 && d <= MAX_TRIP_SEC) out.push(d);
  }
  return out;
}
export function estimateDuration(route: any, segments: Seg[], trips: any[]) {
  const durs = usableDurations(trips);
  if (durs.length >= MIN_SAMPLES) return Math.trunc(quantile(durs, (route.confidence ?? 90) / 100));
  if (route.baseline_sec) return Math.trunc(route.baseline_sec);
  const segSum = segments.reduce((a, s) => a + (s.expected_sec || 0), 0);
  if (segSum) return Math.trunc(segSum);
  return (route.fallback_min ?? 40) * 60;
}

// ---------- 구간 요약 ----------
export function segSummary(s: Seg): string | null {
  if (s.kind === "subway") return [lineLabel(s.line), [normStation(s.station_from), normStation(s.station_to)].filter(Boolean).join("→")].filter(Boolean).join(" ");
  if (s.kind === "bus") {
    const m = /^\s*(.*?)\s*\((.*)\)\s*$/.exec(s.line ?? "");
    return [busLabel(s), m ? m[2] : [stopName(s.station_from), stopName(s.station_to)].filter(Boolean).join("→")].filter(Boolean).join(" ");
  }
  return null;
}

// ---------- 단계 ----------
export const STAGE = ["승차 지점으로 이동 중", "승강장 대기", "탑승 중", "환승 이동", "두 번째 탑승 중"];
const STAGE_ICON = ["🚶", "🚉", "🚇", "🔄", "🚇"];
export const TRIP_FIELDS = ["platform_at", "boarded_at", "transfer_off_at", "transfer_on_at", "ended_at"] as const;
export type Field = typeof TRIP_FIELDS[number];
export const stageOf = (t: Trip) => t.transfer_on_at ? 4 : t.transfer_off_at ? 3 : t.boarded_at ? 2 : t.platform_at ? 1 : 0;

/** 버튼 문구: 다음 탈 구간 종류에 맞게. 버스면 정류장/버스, 지하철이면 승강장/열차. */
export function fieldLabel(f: Field, segments: Seg[]): string {
  const rides = segments.filter(isRide);
  const k = (i: number) => rides[i]?.kind ?? "subway";
  const bus = (i: number) => k(i) === "bus";
  switch (f) {
    case "platform_at": return bus(0) ? "정류장 도착" : "승강장 도착";
    case "boarded_at": return bus(0) ? "버스 탑승" : "열차 탑승";
    case "transfer_off_at": return bus(0) ? "환승 하차(버스)" : "환승 하차";
    case "transfer_on_at": return bus(1) ? "환승 탑승(버스)" : "환승 탑승";
    case "ended_at": return "목적지 도착";
  }
}
/** 다음 단계 버튼: 안 누른 것만, 환승 없는 경로는 환승 버튼 숨김. */
export function buttons(t: Trip, segments: Seg[]): Markup {
  const rides = segments.filter(isRide).length;
  const fields = TRIP_FIELDS.filter((f) => !t[f] && (rides >= 2 || !f.startsWith("transfer_")));
  return { inline_keyboard: fields.map((f) => [{ text: fieldLabel(f, segments), callback_data: `trip:${f}:${t.id}` }]) };
}

/** 단계에 따라 (다음 탈 구간 index, 그 승차 지점까지 남은 초 pre, 그 구간부터 끝까지 예상 합 post, 탈 구간 없을 때 남은 초) */
export function position(t: Trip, segments: Seg[], now: Date) {
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

// ---------- 메시지 ----------
/** 이동 중 메시지. live = 실시간 체인 결과를 주입(tick은 캐시를 끼움), 없으면 직접 조회. */
export async function liveMessage(t: Trip, segments: Seg[], env: Env, live?: (fromIndex: number, walkSec: number) => Promise<ChainItem[]>) {
  const now = env.now ?? new Date();
  const route = t.routes, p = position(t, segments, now);
  let liveLine = "", remaining = p.remaining, waitNote = "";
  if (p.next >= 0) {
    const seg = segments[p.next], icon = seg.kind === "bus" ? "🚌" : "🚇";
    if (p.pre <= REALTIME_HORIZON) {
      const items = await (live ? live(p.next, p.pre) : liveChain(segments, p.next, p.pre, { ...env, now }));
      liveLine = items.length ? `${icon} 다음: ${items.map((it, i) => liveLineText(it, it.readyInSec, i === 0)).join(" / ")}` : "";
      const waitSec: Record<number, number> = {};
      for (const it of items) if (it.waits.length) waitSec[it.index] = it.waits[0] - it.readyInSec;
      remaining = p.pre + segments.slice(p.next).reduce((a, s, k) => a + (s.expected_sec || 0) + (waitSec[p.next + k] ?? 0), 0);
      if (waitSec[p.next] === undefined) waitNote = " · 대기 미확인";
    } else {
      liveLine = `${icon} 다음: ${segSummary(seg) ?? segLabel(seg)} (${mins(p.pre)}분 뒤 승차 지점 · 실시간은 30분 안에서)`;
      remaining = p.pre + p.post; waitNote = " · 대기 미확인";
    }
  }
  const eta = new Date(now.getTime() + remaining * 1000);
  const target = targetTime(route.arrive_by, t.started_at);
  let vs = "";
  if (target) {
    const diff = Math.round((target.getTime() - eta.getTime()) / 60000);
    vs = ` · 목표 ${hhmm(target)} 대비 ${diff > 0 ? `${diff}분 빠름` : diff < 0 ? `${-diff}분 늦음` : "정시"}`;
  }
  const rides = segments.filter(isRide);
  const curRide = p.stage === 2 ? rides[0] : p.stage === 4 ? (rides[1] ?? rides[0]) : null;
  const icon = curRide ? (curRide.kind === "bus" ? "🚌" : "🚇") : STAGE_ICON[p.stage];
  const text = [`🧭 이동 중 · ${route.name}`,
    `${icon} ${STAGE[p.stage]} · 출발 ${hhmm(new Date(t.started_at))} (${mins(since(t.started_at, now))}분 경과)`,
    liveLine,
    `도착 예상 ${hhmm(eta)}${vs} (남은 약 ${mins(remaining)}분${waitNote})`].filter(Boolean).join("\n");
  return { text, markup: buttons(t, segments) };
}

/** 도착 메시지: "🏁 도착 · 총 N분 (예상 M분)". expectedSec = trips.expected_sec 또는 추정값 */
export function finalMessage(t: Trip, expectedSec: number) {
  const sec = Math.max(0, Math.round((Date.parse(t.ended_at) - Date.parse(t.started_at)) / 1000));
  return { text: `🏁 도착 · 총 ${Math.floor(sec / 60)}분 ${sec % 60}초 (예상 ${Math.ceil(expectedSec / 60)}분)\n${t.routes.name}`, markup: { inline_keyboard: [] } as Markup };
}
