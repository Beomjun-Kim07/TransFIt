// Supabase Edge Function: trip
// 아이폰 단축어·안드로이드 앱 등 외부에서 trips 단계를 기록한다. (--no-verify-jwt 로 배포, api_token으로 사용자 식별)
//
// POST { token, route_id, step }
//   step: start | platform_at | boarded_at | transfer_off_at | transfer_on_at | ended_at
// 규칙 (telegram 함수의 버튼 처리와 같음)
//   start      → 오늘 이 경로에 열린(ended_at 없는) trip이 있으면 그대로 반환, 없으면 새 행
//   그 외       → 오늘 열린 trip에 시각 기록. 이미 적힌 단계면 무시(그대로 ok)
// 응답 { ok:true, trip_id, step, next_step, duplicate? }  /  { ok:false, error }
// 기록되면 텔레그램으로 "🚉 승강장 도착 기록됨" 한 줄을 보낸다 (연결된 경우).

const BOT = Deno.env.get("BOT_TOKEN") ?? "";
const SB_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SB_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

const STEPS = ["start", "platform_at", "boarded_at", "transfer_off_at", "transfer_on_at", "ended_at"] as const;
type Step = typeof STEPS[number];
const MSG: Record<Step, string> = {
  start: "🚶 출발 기록됨", platform_at: "🚉 승강장 도착 기록됨", boarded_at: "🚇 열차 탑승 기록됨",
  transfer_off_at: "🔄 환승 하차 기록됨", transfer_on_at: "🚇 환승 탑승 기록됨", ended_at: "🏁 도착 기록됨",
};

async function db(method: string, path: string, body?: unknown) {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, {
    method,
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json", Prefer: "return=representation" },
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

// 다음에 누를 단계: 아직 안 적힌 것 중 첫 번째
function nextStep(trip: Record<string, unknown>): Step | null {
  if (trip.ended_at) return null;
  return STEPS.slice(1).find((s) => !trip[s]) ?? null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ ok: false, error: "POST만 받아요" }, 405);
  try {
    const { token, route_id, step } = await req.json().catch(() => ({}));
    if (!token || !route_id || !step) return json({ ok: false, error: "token, route_id, step이 필요해요" }, 400);
    if (!STEPS.includes(step)) return json({ ok: false, error: `step은 ${STEPS.join("|")} 중 하나` }, 400);

    const [user] = await db("GET", `users?api_token=eq.${encodeURIComponent(token)}&select=id,telegram_chat_id`);
    if (!user) return json({ ok: false, error: "토큰이 올바르지 않아요" }, 401);
    const [route] = await db("GET", `routes?id=eq.${Number(route_id)}&user_id=eq.${user.id}&select=id,name`);
    if (!route) return json({ ok: false, error: "내 경로가 아니거나 없어요" }, 404);

    const now = new Date();
    const nowIso = now.toISOString();
    // 오늘 이 경로의 가장 최근 trip (끝난 것 포함)
    const [today] = await db("GET",
      `trips?user_id=eq.${user.id}&route_id=eq.${route.id}` +
      `&started_at=gte.${encodeURIComponent(kstDayStart(now))}&order=started_at.desc&limit=1&select=*`);
    const open = today && !today.ended_at ? today : null;

    let trip: Record<string, unknown>;
    let duplicate = false;
    if (step === "start") {
      if (open) { trip = open; duplicate = true; }               // 이미 진행 중 → 무시
      else {
        [trip] = await db("POST", "trips", { user_id: user.id, route_id: route.id, started_at: nowIso, source: "shortcut" });
      }
    } else {
      if (!today) return json({ ok: false, error: "오늘 시작한 기록이 없어요. 먼저 start를 보내 주세요" }, 409);
      if (today[step]) { trip = today; duplicate = true; }       // 이미 적힌 단계 → 무시
      else if (!open) return json({ ok: false, error: "오늘 기록은 이미 끝났어요 (ended_at 기록됨)" }, 409);
      else [trip] = await db("PATCH", `trips?id=eq.${open.id}`, { [step]: nowIso });
    }

    if (!duplicate) {
      let text = `${MSG[step as Step]} · ${route.name}`;
      if (step === "ended_at") {
        const sec = Math.round((Date.parse(nowIso) - Date.parse(String(trip.started_at))) / 1000);
        text += ` · 오늘 ${Math.floor(sec / 60)}분 ${sec % 60}초`;
      }
      await notify(user.telegram_chat_id, text);
    }
    return json({ ok: true, trip_id: trip.id, step, next_step: nextStep(trip), duplicate });
  } catch (e) {
    console.error(e);
    return json({ ok: false, error: String(e?.message ?? e) }, 500);
  }
});
