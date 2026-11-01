// 이동 중 안내 메시지 — tick(매분 고쳐 쓰기)과 telegram(버튼 누르면 즉시 고쳐 쓰기)이 같이 쓴다.
// 단계: 경로 segments에서 만든 목록(_shared/steps.ts) — 출발 → 첫 탈것 승강장 도착 → 탑승 → 하차 → 다음 탑승 … → 목적지 도착.
//   환승 횟수 제한 없음. 진행 상황 = trip_events(+옛 컬럼)에서 마지막으로 찍힌 단계: 승차 지점으로 이동 중 / 승강장 대기 /
//   '공항철도 탑승 중' / 환승 이동. 버튼 = 다음 단계·그다음(건너뛰기) + 목적지 도착 (trip:ev:<trip>:<seg>:<kind>).
// 도착 예상 = 지금 + 남은 구간 예상 합 + 실시간 대기(_shared/realtime.ts liveChain). 목표 대비 빠름/늦음.
// 탑승 중이면 하차 지점까지 남은 정거장 한 줄 (_shared/alight.ts alightLine: '🚏 노원 하차까지 3정거장').

import { liveChain, liveLineText, isRide, segLabel, lineLabel, busLabel, stopName, normStation, REALTIME_HORIZON,
  type Seg, type ChainItem, type Env } from "./realtime.ts";
import { alightState, alightLine, type AlightState } from "./alight.ts";
import { progress, buttonSteps, stepCallback, rideIndexes, rideName, type Progress } from "./steps.ts";

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
  route = route ?? {};
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
/** 상태 한 줄: '🚶 승차 지점으로 이동 중', '🚉 승강장 대기', '🚇 공항철도 탑승 중', '🔄 환승 이동 · 다음 4호선'. */
export function stageText(p: Progress, segments: Seg[]): string {
  const seg = segments[p.seg];
  if (p.state === "walk") return "🚶 승차 지점으로 이동 중";
  if (p.state === "platform") return seg?.kind === "bus" ? "🚏 정류장 대기" : "🚉 승강장 대기";
  if (p.state === "ride") return `${seg?.kind === "bus" ? "🚌" : "🚇"} ${seg ? rideName(seg) : ""} 탑승 중`.replace("  ", " ");
  if (p.state === "transfer") { const nx = rideIndexes(segments).find((i) => i > p.seg); return `🔄 환승 이동${nx !== undefined ? ` · 다음 ${rideName(segments[nx])}` : ""}`; }
  return "🏁 도착";
}
/** 다음 단계 버튼: 다음 단계와 그다음(건너뛰기) 중 안 찍힌 것 + 목적지 도착. 콜백 trip:ev:<trip>:<seg>:<kind> / trip:ended_at:<trip>. */
export function buttons(t: Trip, segments: Seg[], p: Progress = progress(t, segments)): Markup {
  return { inline_keyboard: buttonSteps(p).map((s) => [{ text: s.label, callback_data: stepCallback(t.id, s) }]) };
}

/** 진행 상황에 따라 (다음 탈 구간 index, 그 승차 지점까지 남은 초 pre, 그 구간부터 끝까지 예상 합 post, 탈 구간 없을 때 남은 초) */
export function position(t: Trip, segments: Seg[], now: Date, p: Progress = progress(t, segments)) {
  const rides = rideIndexes(segments);
  const sum = (a: number, b: number) => segments.slice(a, b).reduce((x, s) => x + (s.expected_sec || 0), 0);
  const sec = (i: number) => segments[i]?.expected_sec || 0;
  const n = segments.length, state = p.state;
  const none = (remaining: number) => ({ state, next: -1, pre: 0, post: 0, remaining });
  const after = (i: number) => rides.find((r) => r > i);
  if (!rides.length || state === "done") return none(state === "done" ? 0 : Math.max(0, sum(0, n) - since(t.started_at, now)));
  if (state === "walk") return { state, next: rides[0], pre: Math.max(0, sum(0, rides[0]) - since(t.started_at, now)), post: sum(rides[0], n), remaining: 0 };
  if (state === "platform") return { state, next: p.seg, pre: 0, post: sum(p.seg, n), remaining: 0 };
  const nx = after(p.seg);
  if (state === "ride") {
    const partial = Math.max(0, sec(p.seg) - since(p.since, now));
    if (nx === undefined) return none(partial + sum(p.seg + 1, n));
    return { state, next: nx, pre: partial + sum(p.seg + 1, nx), post: sum(nx, n), remaining: 0 };
  }
  if (nx === undefined) return none(Math.max(0, sum(p.seg + 1, n) - since(p.since, now)));   // transfer
  return { state, next: nx, pre: Math.max(0, sum(p.seg + 1, nx) - since(p.since, now)), post: sum(nx, n), remaining: 0 };
}

// ---------- 메시지 ----------
/** 이동 중 메시지. live = 실시간 체인 결과를 주입(tick은 캐시를 끼움), 없으면 직접 조회.
 *  alight = 하차 상태(tick이 알림과 같이 쓰려고 미리 구한 것). undefined면 탑승 중일 때 직접 구하고, null이면 그 줄 없음. */
export async function liveMessage(t: Trip, segments: Seg[], env: Env, live?: (fromIndex: number, walkSec: number) => Promise<ChainItem[]>,
                                  alight?: AlightState | null) {
  const now = env.now ?? new Date();
  if (alight === undefined) {
    try { alight = await alightState(t, segments, { ...env, now }); } catch (e) { console.error("alight", String(e)); alight = null; }
  }
  const route = t.routes, prog = progress(t, segments), p = position(t, segments, now, prog);
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
  const text = [`🧭 이동 중 · ${route.name}`,
    `${stageText(prog, segments)} · 출발 ${hhmm(new Date(t.started_at))} (${mins(since(t.started_at, now))}분 경과)`,
    alightLine(alight),
    liveLine,
    `도착 예상 ${hhmm(eta)}${vs} (남은 약 ${mins(remaining)}분${waitNote})`].filter(Boolean).join("\n");
  return { text, markup: buttons(t, segments, prog) };
}

/** 도착 메시지: "🏁 도착 · 총 N분 (예상 M분)". expectedSec = trips.expected_sec 또는 추정값 */
export function finalMessage(t: Trip, expectedSec: number | null | undefined) {
  const sec = Math.max(0, Math.round((Date.parse(t.ended_at) - Date.parse(t.started_at)) / 1000));
  const exp = Number(expectedSec);
  const expTxt = Number.isFinite(exp) && exp > 0 ? `예상 ${Math.ceil(exp / 60)}분` : "예상 없음";
  return { text: `🏁 도착 · 총 ${Math.floor(sec / 60)}분 ${sec % 60}초 (${expTxt})\n${t.routes?.name ?? ""}`, markup: { inline_keyboard: [] } as Markup };
}
