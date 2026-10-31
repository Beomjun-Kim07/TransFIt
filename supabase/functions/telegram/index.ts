// Supabase Edge Function: telegram
// 텔레그램 봇 웹훅. --no-verify-jwt 로 배포하고, setWebhook 때 secret_token을 함께 등록한다.
//
// 처리하는 것
//  1. `/start <link_code>`  → users.link_code로 사용자를 찾아 telegram_chat_id 저장 → "연결됐어요" 답장
//  2. callback_query (역사 안 버튼) → trips 에 시각 기록
//     버튼 data 형식 (watch.py가 inline_keyboard로 보낼 때 이 형식을 쓴다):
//       trip:start:<route_id>        집 출발 → trips 행 새로 만들고(started_at=now) 다음 버튼 보냄
//       trip:platform_at:<trip_id>   승강장 도착
//       trip:boarded_at:<trip_id>    열차 탑승
//       trip:transfer_off_at:<trip_id> 환승역 하차
//       trip:transfer_on_at:<trip_id>  환승 열차 탑승
//       trip:ended_at:<trip_id>      목적지 도착
//
// 환경변수: BOT_TOKEN, TELEGRAM_SECRET(웹훅 검증), SUPABASE_URL·SUPABASE_SERVICE_ROLE_KEY(자동 주입)

const BOT = Deno.env.get("BOT_TOKEN") ?? "";
const SECRET = Deno.env.get("TELEGRAM_SECRET") ?? "";
const SB_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SB_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const TG = `https://api.telegram.org/bot${BOT}`;

const TRIP_FIELDS = ["platform_at", "boarded_at", "transfer_off_at", "transfer_on_at", "ended_at"] as const;
const LABEL: Record<string, string> = {
  platform_at: "승강장 도착", boarded_at: "열차 탑승", transfer_off_at: "환승 하차",
  transfer_on_at: "환승 탑승", ended_at: "목적지 도착",
};

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
async function tg(method: string, payload: Record<string, unknown>) {
  const r = await fetch(`${TG}/${method}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
  });
  if (!r.ok) console.error(`tg ${method} ${r.status}: ${(await r.text()).slice(0, 200)}`);
}
const reply = (chat_id: number, text: string, extra: Record<string, unknown> = {}) =>
  tg("sendMessage", { chat_id, text, ...extra });

// 다음 단계 버튼 (아직 안 누른 것만)
function nextButtons(trip: Record<string, unknown>) {
  const rows = TRIP_FIELDS.filter((f) => !trip[f]).map((f) => [
    { text: LABEL[f], callback_data: `trip:${f}:${trip.id}` },
  ]);
  return rows.length ? { reply_markup: { inline_keyboard: rows } } : {};
}

// ---------- 메시지: /start <link_code> ----------
async function onMessage(m: any) {
  const chat_id: number = m.chat.id;
  const text: string = (m.text ?? "").trim();
  const mt = text.match(/^\/start(?:\s+(\S+))?/);
  if (!mt) {
    await reply(chat_id, "TransFit 봇이에요. 웹앱에서 '텔레그램 연결' 링크를 눌러 연결해 주세요.");
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
async function onCallback(q: any) {
  const chat_id: number = q.message?.chat?.id;
  const data: string = q.data ?? "";
  const [kind, field, idStr] = data.split(":");
  const id = Number(idStr);
  const now = new Date().toISOString();
  try {
    if (kind !== "trip" || !id) throw new Error("알 수 없는 버튼");
    const users = await db("GET", `users?telegram_chat_id=eq.${chat_id}&select=id`);
    const user = users[0];
    if (!user) throw new Error("연결된 계정이 없어요");

    if (field === "start") {
      const [trip] = await db("POST", "trips", {
        user_id: user.id, route_id: id, started_at: now, source: "telegram",
      });
      await tg("answerCallbackQuery", { callback_query_id: q.id, text: "출발 기록했어요" });
      await reply(chat_id, `🚶 출발 ${now.slice(11, 16)} UTC 기록. 역에서 아래 버튼을 눌러 주세요.`, nextButtons(trip));
      return;
    }
    if (!(TRIP_FIELDS as readonly string[]).includes(field)) throw new Error("알 수 없는 단계");
    const [trip] = await db("PATCH", `trips?id=eq.${id}&user_id=eq.${user.id}`, { [field]: now });
    if (!trip) throw new Error("기록을 찾지 못했어요");
    await tg("answerCallbackQuery", { callback_query_id: q.id, text: `${LABEL[field]} 기록했어요` });
    // 누른 버튼은 빼고 남은 단계 버튼으로 갱신
    await tg("editMessageReplyMarkup", {
      chat_id, message_id: q.message.message_id,
      reply_markup: nextButtons(trip).reply_markup ?? { inline_keyboard: [] },
    });
    if (field === "ended_at") {
      const sec = Math.round((Date.parse(now) - Date.parse(trip.started_at)) / 1000);
      await reply(chat_id, `🏁 도착. 오늘 소요시간 ${Math.floor(sec / 60)}분 ${sec % 60}초 — 기록에 반영됐어요.`);
    }
  } catch (e) {
    await tg("answerCallbackQuery", { callback_query_id: q.id, text: String(e?.message ?? e), show_alert: true });
  }
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("ok");
  if (SECRET && req.headers.get("x-telegram-bot-api-secret-token") !== SECRET) {
    return new Response("forbidden", { status: 403 });
  }
  try {
    const upd = await req.json();
    if (upd.message) await onMessage(upd.message);
    else if (upd.callback_query) await onCallback(upd.callback_query);
  } catch (e) {
    console.error(e);
  }
  // 텔레그램이 재전송하지 않도록 항상 200
  return new Response("ok");
});
