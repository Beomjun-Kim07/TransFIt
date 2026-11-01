// Supabase Edge Function: trip
// 아이폰 단축어·안드로이드 앱 등 외부에서 trips 단계를 기록한다. (--no-verify-jwt 로 배포, api_token으로 사용자 식별)
//
// POST { token, route_id, seg_index, kind }   kind = start | platform | board | alight | end  (환승 횟수 제한 없음, _shared/steps.ts)
//      seg_index = segments를 seq 순으로 놓은 0부터 index (탈 구간). start·end엔 필요 없음.
// POST { token, route_id, step }               옛 형식도 그대로: start | platform_at | boarded_at | transfer_off_at | transfer_on_at | ended_at
//      → 첫 탈 구간 승강장·탑승·하차, 두 번째 탈 구간 탑승으로 바꿔 기록
// 규칙 (telegram 함수의 버튼 처리와 같음)
//   start      → 오늘 이 경로에 열린(ended_at 없는) trip이 있으면 그대로 반환, 없으면 새 행
//   end        → trips.ended_at
//   그 외       → trip_events에 기록(이미 있으면 무시, 그대로 ok) + 옛 컬럼(platform_at·boarded_at·transfer_off_at·transfer_on_at) 첫 값만
// 응답 { ok:true, trip_id, step, seg_index, kind, label, next_step(옛 이름 또는 null), next {seg_index, kind, label} | null, duplicate }
// 기록되면 텔레그램으로 "🚇 공항철도 탑승 기록됨" 한 줄을 보낸다 (연결된 경우).
// 탑승(board)을 기록하면 그 순간 탄 차를 정해 trips.ride_train·ride_veh에 넣는다 (tick 하차 알림용, _shared/alight.ts).
//   웹앱은 단계를 직접 기록한 뒤 같은 seg_index·kind로 이 함수를 부른다 → duplicate지만 기록된 지 60초 안이면 탄 차만 정한다.
//   응답에 ride { ride_veh, ride_train } (못 정하면 null 둘).

import { rideOnBoard } from "../_shared/alight.ts";
import { legacyStep, recordEvent, stepLabel, progress, withEvents, rideIndexes, compatField, evKey, eventMap, EV_KINDS, type EvKind, type StepKind } from "../_shared/steps.ts";

const BOT = Deno.env.get("BOT_TOKEN") ?? "";
const SUBWAY_KEY = Deno.env.get("SUBWAY_KEY") ?? "";
const BUS_KEY = Deno.env.get("BUS_KEY") ?? "";
const RIDE_RECENT_MS = 60_000;   // 이미 기록된 탑승 단계라도 이 안이면 탄 차를 정한다 (웹앱이 직접 기록한 뒤 부르는 경우)
const SB_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SB_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

const STEPS = ["start", "platform_at", "boarded_at", "transfer_off_at", "transfer_on_at", "ended_at"] as const;   // 옛 step
type Step = typeof STEPS[number];
const KINDS = ["start", "platform", "board", "alight", "end"];
const ICON: Record<string, string> = { start: "🚶", platform: "🚉", board: "🚇", alight: "🔄", end: "🏁" };

async function db(method: string, path: string, body?: unknown, prefer = "return=representation") {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, {
    method,
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json", Prefer: prefer },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`db ${method} ${path} ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

async function notify(chat_id: number | null, text: string) {
  if (!BOT || !chat_id) return;
  try {
    await fetch(`https://api.telegram.org/bot${BOT}/sendMessage`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chat_id, text }),
    });
  } catch (e) { console.error("telegram", e); }
}

// 한국 시간 기준 오늘 0시 (ISO)
function kstDayStart(now: Date) {
  const kst = new Date(now.getTime() + 9 * 3600 * 1000);
  return `${kst.toISOString().slice(0, 10)}T00:00:00+09:00`;
}

// 다음에 누를 단계 (옛 이름): 아직 안 적힌 옛 컬럼 중 첫 번째
function nextStep(trip: Record<string, unknown>): Step | null {
  if (trip.ended_at) return null;
  return STEPS.slice(1).find((s) => !trip[s]) ?? null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ ok: false, error: "POST만 받아요" }, 405);
  try {
    const body = await req.json().catch(() => ({}));
    const { token, route_id, step } = body;
    const kindIn = body.kind ?? null, segIn = body.seg_index ?? null;
    if (!token || !route_id || !(step || kindIn)) return json({ ok: false, error: "token, route_id와 step(또는 seg_index·kind)이 필요해요" }, 400);
    if (step && !STEPS.includes(step)) return json({ ok: false, error: `step은 ${STEPS.join("|")} 중 하나` }, 400);
    if (!step && !KINDS.includes(kindIn)) return json({ ok: false, error: `kind는 ${KINDS.join("|")} 중 하나` }, 400);

    const [user] = await db("GET", `users?api_token=eq.${encodeURIComponent(token)}&select=id,telegram_chat_id`);
    if (!user) return json({ ok: false, error: "토큰이 올바르지 않아요" }, 401);
    const [route] = await db("GET", `routes?id=eq.${Number(route_id)}&user_id=eq.${user.id}&select=id,name`);
    if (!route) return json({ ok: false, error: "내 경로가 아니거나 없어요" }, 404);
    const segments = await db("GET", `segments?route_id=eq.${route.id}&order=seq`);

    // 기록할 단계 { kind, seg }
    let ev: { kind: StepKind; seg: number } | null;
    if (step) ev = legacyStep(step, segments);
    else if (kindIn === "start" || kindIn === "end") ev = { kind: kindIn, seg: -1 };
    else ev = Number.isInteger(Number(segIn)) && segIn !== null && segIn !== "" ? { kind: kindIn, seg: Number(segIn) } : null;
    if (!ev) return json({ ok: false, error: step ? `이 경로엔 ${step} 단계가 없어요 (탈 구간이 모자라요)` : "seg_index가 필요해요" }, 400);
    if (ev.kind !== "start" && ev.kind !== "end" && (!rideIndexes(segments).includes(ev.seg) || !(EV_KINDS as readonly string[]).includes(ev.kind))) {
      return json({ ok: false, error: `seg_index ${ev.seg}는 이 경로의 탈 구간이 아니에요 (탈 구간: ${rideIndexes(segments).join(", ") || "없음"})` }, 400);
    }

    const now = new Date();
    const nowIso = now.toISOString();
    // 오늘 이 경로의 가장 최근 trip (끝난 것 포함)
    const [today] = await withEvents((e) => db("GET",
      `trips?user_id=eq.${user.id}&route_id=eq.${route.id}` +
      `&started_at=gte.${encodeURIComponent(kstDayStart(now))}&order=started_at.desc&limit=1&select=*${e}`));
    const open = today && !today.ended_at ? today : null;

    let trip: Record<string, any>;
    let duplicate = false;
    if (ev.kind === "start") {
      if (open) { trip = open; duplicate = true; }               // 이미 진행 중 → 무시
      else {
        [trip] = await db("POST", "trips", { user_id: user.id, route_id: route.id, started_at: nowIso, source: "shortcut" });
      }
    } else {
      if (!today) return json({ ok: false, error: "오늘 시작한 기록이 없어요. 먼저 start를 보내 주세요" }, 409);
      trip = today;
      if (ev.kind === "end") {
        if (today.ended_at) duplicate = true;
        else [trip] = await db("PATCH", `trips?id=eq.${today.id}`, { ended_at: nowIso });
      } else {
        const done = eventMap(today, segments).has(evKey(ev.seg, ev.kind));
        if (done) duplicate = true;                              // 이미 적힌 단계 → 무시
        else if (!open) return json({ ok: false, error: "오늘 기록은 이미 끝났어요 (ended_at 기록됨)" }, 409);
        else duplicate = !(await recordEvent(db, trip, segments, ev.seg, ev.kind as EvKind, nowIso)).fresh;
      }
    }
    const label = stepLabel(segments, ev.seg, ev.kind);

    let ride: Record<string, string | null> | null = null;
    if (ev.kind === "board") {
      const at = Date.parse(String(eventMap(trip, segments).get(evKey(ev.seg, ev.kind)) ?? ""));
      if (!duplicate || now.getTime() - at < RIDE_RECENT_MS) {
        try {
          ride = await rideOnBoard(ev.seg, segments, { SUBWAY_KEY, BUS_KEY, now });
          if (ride) await db("PATCH", `trips?id=eq.${trip.id}`, ride);
        } catch (e) { console.error("ride", String(e)); ride = null; }   // ride_veh·ride_train 컬럼이 없으면 여기서 실패 — 기록은 그대로
      }
    }

    if (!duplicate) {
      const icon = ev.kind === "board" && segments[ev.seg]?.kind === "bus" ? "🚌" : ev.kind === "platform" && segments[ev.seg]?.kind === "bus" ? "🚏" : ICON[ev.kind];
      let text = `${icon} ${ev.kind === "start" ? "출발" : ev.kind === "end" ? "도착" : label} 기록됨 · ${route.name}`;
      if (ev.kind === "end") {
        const sec = Math.round((Date.parse(nowIso) - Date.parse(String(trip.started_at))) / 1000);
        text += ` · 오늘 ${Math.floor(sec / 60)}분 ${sec % 60}초`;
      }
      await notify(user.telegram_chat_id, text);
    }
    const p = progress(trip, segments), nx = p.steps[p.next];
    const next = p.state === "done" || p.at[p.next] ? null : { seg_index: nx.seg, kind: nx.kind, label: nx.label };
    const stepName = step ?? (ev.kind === "start" ? "start" : ev.kind === "end" ? "ended_at" : compatField(segments, ev.seg, ev.kind));
    return json({ ok: true, trip_id: trip.id, step: stepName, seg_index: ev.seg, kind: ev.kind, label, next_step: nextStep(trip), next, duplicate,
                  ...(ride ? { ride } : {}) });
  } catch (e) {
    console.error(e);
    return json({ ok: false, error: String(e?.message ?? e) }, 500);
  }
});
