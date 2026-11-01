// Supabase Edge Function: telegram
// 텔레그램 봇 웹훅. --no-verify-jwt 로 배포하고, setWebhook 때 secret_token을 함께 등록한다.
//
// 처리하는 것
//  1. `/start <link_code>`  → users.link_code로 사용자를 찾아 telegram_chat_id 저장 → "연결됐어요" 답장
//  2. `/next` → 내 경로 전부의 오늘 출발 시각 (watch.py estimate_duration과 같은 계산, 실시간 보정은 없음)
//  3. callback_query (역사 안 버튼) → trips 에 시각 기록
//     버튼 data 형식 (watch.py가 inline_keyboard로 보낼 때 이 형식을 쓴다):
//       trip:start:<route_id>        집 출발 → trips 행 새로 만들고(started_at=now) 다음 버튼 보냄
//       trip:platform_at:<trip_id>   승강장 도착
//       trip:boarded_at:<trip_id>    열차 탑승
//       trip:transfer_off_at:<trip_id> 환승역 하차
//       trip:transfer_on_at:<trip_id>  환승 열차 탑승
//       trip:ended_at:<trip_id>      목적지 도착
//     탑승(boarded_at)·환승 탑승(transfer_on_at)을 처음 기록하면 그 순간 탄 차를 정해(_shared/alight.ts rideOnBoard →
//     realtime.ts boardingVehicle boarded) trips.ride_train(지하철 btrainNo)·ride_veh(버스 vehId)에 넣는다 — tick 하차 알림이 이 차를 따라간다.
//     못 정하면 둘 다 null (앞 구간 차를 지움 → 하차 알림은 추정).
//
// 환경변수: BOT_TOKEN, TELEGRAM_SECRET(웹훅 검증), SUPABASE_URL·SUPABASE_SERVICE_ROLE_KEY(자동 주입)

import { liveMessage, finalMessage, estimateDuration, TRIP_FIELDS, LOOKBACK_DAYS, type Trip } from "../_shared/trip_message.ts";
import { rideOnBoard } from "../_shared/alight.ts";

const BOT = Deno.env.get("BOT_TOKEN") ?? "";
const SUBWAY_KEY = Deno.env.get("SUBWAY_KEY") ?? "";
const BUS_KEY = Deno.env.get("BUS_KEY") ?? "";
const SECRET = Deno.env.get("TELEGRAM_SECRET") ?? "";
const SB_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SB_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const TG = `https://api.telegram.org/bot${BOT}`;


// ---------- Supabase (PostgREST, service_role) ----------
async function db(method: string, path: string, body?: unknown) {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`,
      "Content-Type": "application/json", Prefer: "return=representation",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`db ${method} ${path} ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

// ---------- Telegram ----------
async function tg(method: string, payload: Record<string, unknown>): Promise<any> {
  const r = await fetch(`${TG}/${method}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
  });
  const j = await r.json().catch(() => ({}));
  if (!j.ok) { console.error(`tg ${method}: ${j.description ?? r.status}`); return null; }
  return j.result;
}
const reply = (chat_id: number, text: string, extra: Record<string, unknown> = {}) =>
  tg("sendMessage", { chat_id, text, ...extra });

// ---------- /next: 출발 시각 계산 (watch.py estimate_duration / plan 과 같은 규칙) ----------
const MIN_SAMPLES = 5, LOOKBACK_DAYS = 60, LATER = "(기록 쌓이면 바뀜)";
const KST_MS = 9 * 3600 * 1000;

// 선형보간 분위수 (조연준 Estimator.quantile, watch.py quantile 과 동일)
function quantile(values: number[], p: number) {
  const v = [...values].sort((a, b) => a - b);
  const pos = (v.length - 1) * p, lo = Math.floor(pos), hi = Math.ceil(pos);
  return v[lo] + (v[hi] - v[lo]) * (pos - lo);
}
// 계산에 쓰는 기록(초) = 도착까지 찍힘 + excluded 아님 + 3분~3시간
function usableDurations(trips: any[]) {
  const out: number[] = [];
  for (const t of trips) {
    if (t.excluded || !t.started_at || !t.ended_at) continue;
    const d = (Date.parse(t.ended_at) - Date.parse(t.started_at)) / 1000;
    if (d >= 180 && d <= 3 * 3600) out.push(d);
  }
  return out;
}
function estimateDuration(route: any, segments: any[], trips: any[]): [number, string] {
  const durs = usableDurations(trips);
  const conf = route.confidence ?? 90;
  if (durs.length >= MIN_SAMPLES) return [Math.trunc(quantile(durs, conf / 100)), `내 기록 ${durs.length}회 ${conf}% 기준`];
  if (route.baseline_sec) return [Math.trunc(route.baseline_sec), `카카오 예상 기준${LATER}`];
  const segSum = segments.reduce((a, s) => a + (s.expected_sec || 0), 0);
  if (segSum) return [Math.trunc(segSum), `구간 예상 합 기준${LATER}`];
  return [(route.fallback_min ?? 40) * 60, `기본값 기준${LATER}`];
}
const hhmm = (m: number) => { m = ((m % 1440) + 1440) % 1440; return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`; };

async function nextText(chat_id: number) {
  const [user] = await db("GET", `users?telegram_chat_id=eq.${chat_id}&select=id`);
  if (!user) return "연결된 계정이 없어요. 웹앱의 '텔레그램 연결' 링크로 먼저 연결해 주세요.";
  const routes = await db("GET", `routes?user_id=eq.${user.id}&order=id&select=*`);
  if (!routes.length) return "저장된 경로가 없어요. 웹앱에서 길찾기 → 저장을 먼저 해 주세요.";
  const now = new Date();
  const kst = new Date(now.getTime() + KST_MS);
  const weekday = (kst.getUTCDay() + 6) % 7;                       // 월=0 (watch.py와 같음)
  const since = new Date(now.getTime() - LOOKBACK_DAYS * 86400 * 1000).toISOString();
  const lines: string[] = [];
  for (const r of routes) {
    const [segments, trips] = await Promise.all([
      db("GET", `segments?route_id=eq.${r.id}&order=seq&select=expected_sec`),
      db("GET", `trips?route_id=eq.${r.id}&started_at=gte.${encodeURIComponent(since)}&select=started_at,ended_at,excluded`),
    ]);
    const [dur, basis] = estimateDuration(r, segments, trips);
    const mins = Math.ceil(dur / 60);                               // 1분 올림 → 출발 시각과 '예상 N분'이 일치
    const [hh, mm] = String(r.arrive_by).split(":").map(Number);
    const arriveMin = hh * 60 + mm;
    const days = r.active_days || "MTWTF";
    const active = weekday < days.length && days[weekday] !== "-";
    lines.push(`${r.name} · 도착 ${hhmm(arriveMin)} → 출발 ${hhmm(arriveMin - mins)} (예상 ${mins}분 · ${basis})${active ? "" : " (오늘 쉼)"}`);
  }
  return lines.join("\n");
}

// ---------- 메시지: /start <link_code> ----------
async function onMessage(m: any): Promise<string | void> {
  const chat_id: number = m.chat.id;
  const text: string = (m.text ?? "").trim();
  if (/^\/next\b/.test(text)) {
    const t = await nextText(chat_id);
    await reply(chat_id, t);
    return t;
  }
  const mt = text.match(/^\/start(?:\s+(\S+))?/);
  if (!mt) {
    await reply(chat_id, "TransFit 봇이에요. 웹앱에서 '텔레그램 연결' 링크를 눌러 연결해 주세요.\n/next — 오늘 출발 시각 바로 보기");
    return;
  }
  const code = mt[1];
  if (!code) {
    await reply(chat_id, "연결 코드가 없어요. 웹앱의 '텔레그램 연결' 링크로 다시 들어와 주세요.");
    return;
  }
  const rows = await db("GET", `users?link_code=eq.${encodeURIComponent(code)}&select=id,email,telegram_chat_id`);
  const u = rows[0];
  if (!u) {
    await reply(chat_id, "연결 코드를 찾지 못했어요. 웹앱에 로그인한 뒤 링크를 다시 눌러 주세요.");
    return;
  }
  // 같은 chat_id가 다른 계정에 붙어 있으면 떼어낸다 (unique 제약)
  await db("PATCH", `users?telegram_chat_id=eq.${chat_id}&id=neq.${u.id}`, { telegram_chat_id: null });
  await db("PATCH", `users?id=eq.${u.id}`, { telegram_chat_id: chat_id });
  await reply(chat_id, `연결됐어요 ✅\n${u.email ?? ""}\n이제 출발 시각 알림을 여기로 보내드려요.`);
}

// ---------- 버튼: trip:<field>:<id> ----------
// start → trips 행 만들고 이동 중 메시지(tick과 같은 포맷)를 보내 live_msg_id 저장.
// 그 외 → 시각 기록 후 그 메시지를 즉시 고쳐 쓴다 (새 메시지 없음). 콜백 응답은 토스트.
const SELECT = "*,routes(id,name,arrive_by,confidence,baseline_sec,fallback_min)";
async function onCallback(q: any): Promise<string | void> {
  const chat_id: number = q.message?.chat?.id;
  const data: string = q.data ?? "";
  const [kind, field, idStr] = data.split(":");
  const id = Number(idStr);
  const now = new Date(), nowIso = now.toISOString();
  const toast = (text: string, alert = false) => tg("answerCallbackQuery", { callback_query_id: q.id, text, show_alert: alert });
  try {
    if (kind !== "trip" || !id) throw new Error("알 수 없는 버튼");
    const [user] = await db("GET", `users?telegram_chat_id=eq.${chat_id}&select=id`);
    if (!user) throw new Error("연결된 계정이 없어요");

    let trip: Trip, fresh = false;
    if (field === "start") {
      const [open] = await db("GET", `trips?user_id=eq.${user.id}&route_id=eq.${id}&ended_at=is.null&order=started_at.desc&limit=1&select=${SELECT}`);
      if (open && now.getTime() - Date.parse(open.started_at) < 3 * 3600_000) { trip = open; await toast("이미 출발 기록이 있어요"); }
      else {
        [trip] = await db("POST", `trips?select=${SELECT}`, { user_id: user.id, route_id: id, started_at: nowIso, source: "telegram" });
        await toast("출발 기록했어요");
      }
    } else {
      if (!(TRIP_FIELDS as readonly string[]).includes(field)) throw new Error("알 수 없는 단계");
      const [cur] = await db("GET", `trips?id=eq.${id}&user_id=eq.${user.id}&select=${SELECT}`);
      if (!cur) throw new Error("기록을 찾지 못했어요");
      if (cur[field]) { trip = cur; await toast("이미 기록된 단계예요"); }
      else { [trip] = await db("PATCH", `trips?id=eq.${id}&select=${SELECT}`, { [field]: nowIso }); fresh = true; await toast(`${field === "ended_at" ? "도착" : "단계"} 기록했어요`); }
    }

    const segments = await db("GET", `segments?route_id=eq.${trip.route_id}&order=seq`);
    if (fresh) {   // 탑승·환승 탑승: 탄 차 기록 (ride_veh·ride_train 컬럼이 아직 없으면 실패 — 단계 기록은 그대로)
      try {
        const ride = await rideOnBoard(field, segments, { SUBWAY_KEY, BUS_KEY, now });
        if (ride) { await db("PATCH", `trips?id=eq.${trip.id}`, ride); Object.assign(trip, ride); }
      } catch (e) { console.error("ride", String(e)); }
    }
    let text: string, markup: unknown;
    if (trip.ended_at) {
      let expected = trip.expected_sec;
      if (!expected) {
        const sinceIso = new Date(now.getTime() - LOOKBACK_DAYS * 86400_000).toISOString();
        const trips = await db("GET", `trips?route_id=eq.${trip.route_id}&id=neq.${trip.id}&started_at=gte.${encodeURIComponent(sinceIso)}&select=started_at,ended_at,excluded`);
        expected = estimateDuration(trip.routes, segments, trips);
      }
      ({ text, markup } = finalMessage(trip, expected));
    } else {
      ({ text, markup } = await liveMessage(trip, segments, { SUBWAY_KEY, BUS_KEY, now }));
    }
    // 메시지 하나를 고쳐 쓴다. 없으면(start) 보내고 저장. 도착이면 live_msg_id 비움(tick이 다시 안 건드리게)
    let msgId = trip.live_msg_id;
    if (msgId) {
      const r = await tg("editMessageText", { chat_id, message_id: msgId, text, reply_markup: markup });
      if (r === null) msgId = null;                                 // 지워진 메시지 등 → 새로 보냄
    }
    if (!msgId) {
      const m = await tg("sendMessage", { chat_id, text, reply_markup: markup });
      msgId = m?.message_id ?? null;
    }
    await db("PATCH", `trips?id=eq.${trip.id}`, { live_msg_id: trip.ended_at ? null : msgId });
  } catch (e) {
    await toast(String(e?.message ?? e), true);
    return `err: ${String(e?.message ?? e)}`;                       // 응답 본문 (텔레그램은 무시, curl 테스트용)
  }
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("ok");
  if (SECRET && req.headers.get("x-telegram-bot-api-secret-token") !== SECRET) {
    return new Response("forbidden", { status: 403 });
  }
  try {
    const upd = await req.json();
    if (upd.message) {
      const t = await onMessage(upd.message);
      if (t) return new Response(t);                               // /next 답장 본문 (텔레그램은 무시, curl 테스트용)
    } else if (upd.callback_query) { const t = await onCallback(upd.callback_query); if (t) return new Response(t); }
  } catch (e) {
    console.error(e);
  }
  // 텔레그램이 재전송하지 않도록 항상 200
  return new Response("ok");
});
