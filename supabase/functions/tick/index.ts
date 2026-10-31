// Supabase Edge Function: tick — 이동 중 안내. pg_cron이 매분 호출한다 (GitHub Actions 안 씀).
//
// 대상: 오늘(KST) 시작했고 ended_at이 없고 excluded가 아니며 시작 후 3시간 이내인 trips.
// 메시지 내용·단계·버튼은 _shared/trip_message.ts (telegram 함수와 공유), 실시간은 _shared/realtime.ts.
// 텔레그램은 trip당 메시지 하나: telegram 함수가 start 때 보내고 live_msg_id에 저장 → tick은 고쳐 쓰기만
// (live_msg_id가 없으면 한 번 보내고 저장). 내용이 같으면 안 고친다.
// ended_at이 생기면 "🏁 도착 · 총 N분 (예상 M분)"으로 마지막 수정 후 live_msg_id=null.
// 실시간 API는 trip당 1분에 1회 이하 (인스턴스 메모리 캐시).
//
// 호출: POST /tick  (Authorization: Bearer <service_role 또는 sb_secret_ 키>)   ?dry=1 이면 보내지 않고 내용을 응답으로.

import { liveChain, type Seg, type ChainItem } from "../_shared/realtime.ts";
import { liveMessage, finalMessage, estimateDuration, stageOf, STAGE, dayStartKst, LOOKBACK_DAYS, type Trip, type Markup } from "../_shared/trip_message.ts";

const BOT = Deno.env.get("BOT_TOKEN") ?? "";
const SUBWAY_KEY = Deno.env.get("SUBWAY_KEY") ?? "";
const BUS_KEY = Deno.env.get("BUS_KEY") ?? "";
const SB_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SB_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const TG = `https://api.telegram.org/bot${BOT}`;
const MAX_TRIP_SEC = 3 * 3600;

async function db(method: string, path: string, body?: unknown) {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, {
    method,
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json", Prefer: "return=representation" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`db ${method} ${path.split("?")[0]} ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
}
async function tg(method: string, payload: Record<string, unknown>): Promise<any> {
  const r = await fetch(`${TG}/${method}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  const j = await r.json().catch(() => ({}));
  if (!j.ok) throw new Error(`tg ${method}: ${j.description ?? r.status}`);
  return j.result;
}

// 실시간 조회 캐시: trip당 1분에 1회 이하 (단계가 바뀌면 다시 조회)
const liveCache = new Map<number, { at: number; segIdx: number; items: ChainItem[] }>();
function cachedLive(tripId: number, segments: Seg[], now: Date) {
  return async (fromIndex: number, walkSec: number) => {
    const c = liveCache.get(tripId);
    if (c && c.segIdx === fromIndex && now.getTime() - c.at < 55_000) return c.items;
    const items = await liveChain(segments, fromIndex, walkSec, { SUBWAY_KEY, BUS_KEY, now });
    liveCache.set(tripId, { at: now.getTime(), segIdx: fromIndex, items });
    return items;
  };
}

// 메시지 고쳐 쓰기. 내용이 같으면 안 고친다. live_msg_id가 없으면(telegram 함수가 못 보낸 경우) 한 번 보낸다.
const lastText = new Map<number, string>();
async function upsertMessage(t: Trip, chatId: number, text: string, markup: Markup) {
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

// 인증: legacy service_role(eyJ…)도, 새 secret key(sb_secret_…)도 받는다
function secretKeys(): string[] {
  const raw = Deno.env.get("SUPABASE_SECRET_KEYS") ?? "";
  let list: string[] = [];
  try { const j = JSON.parse(raw); list = Array.isArray(j) ? j.map((x) => typeof x === "string" ? x : x?.api_key ?? x?.key ?? "") : []; }
  catch { list = raw.split(/[,\s]+/); }
  return [SB_KEY, ...list].filter(Boolean);
}
function authorized(req: Request) {
  const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim() || (req.headers.get("apikey") ?? "").trim();
  return !!token && secretKeys().includes(token);
}

const SELECT = "*,routes(id,name,arrive_by,confidence,baseline_sec,fallback_min),users(telegram_chat_id)";
Deno.serve(async (req) => {
  if (!authorized(req)) return new Response(JSON.stringify({ error: "service_role 키가 필요해요" }), { status: 401 });
  const dry = new URL(req.url).searchParams.get("dry") === "1";
  const now = new Date();
  const out: any[] = [];
  const startFloor = new Date(Math.max(dayStartKst(now).getTime(), now.getTime() - MAX_TRIP_SEC * 1000)).toISOString();

  // 1) 진행 중
  const open = await db("GET", `trips?select=${SELECT}&ended_at=is.null&excluded=not.is.true&started_at=gte.${encodeURIComponent(startFloor)}&order=id`);
  for (const t of open) {
    const chatId = t.users?.telegram_chat_id;
    const rec: any = { trip_id: t.id, route: t.routes?.name, stage: STAGE[stageOf(t)] };
    try {
      if (!t.routes) throw new Error("경로 없음");
      const segments: Seg[] = await db("GET", `segments?route_id=eq.${t.route_id}&order=seq`);
      const { text, markup } = await liveMessage(t, segments, { SUBWAY_KEY, BUS_KEY, now }, cachedLive(t.id, segments, now));
      rec.text = text; rec.buttons = markup.inline_keyboard.map((r) => r[0].text);
      rec.action = dry ? "dry" : !chatId ? "텔레그램 미연결" : await upsertMessage(t, chatId, text, markup);
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
      const segments: Seg[] = await db("GET", `segments?route_id=eq.${t.route_id}&order=seq`);
      let expected = t.expected_sec;
      if (!expected) {
        const sinceIso = new Date(now.getTime() - LOOKBACK_DAYS * 86400 * 1000).toISOString();
        const trips = await db("GET", `trips?route_id=eq.${t.route_id}&id=neq.${t.id}&started_at=gte.${encodeURIComponent(sinceIso)}&select=started_at,ended_at,excluded`);
        expected = estimateDuration(t.routes, segments, trips);
      }
      const { text, markup } = finalMessage(t, expected);
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
