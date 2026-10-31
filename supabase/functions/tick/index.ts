// Supabase Edge Function: tick — 이동 중 안내. pg_cron이 매분 호출한다 (GitHub Actions 안 씀).
//
// 대상: 오늘(KST) 시작했고 ended_at이 없고 excluded가 아니며 시작 후 3시간 이내인 trips.
// 단계: started만 → 승차 지점으로 이동 중 / platform_at → 승강장 대기 / boarded_at → 탑승 중
//       transfer_off_at → 환승 이동 / transfer_on_at → 두 번째 탑승 중
// 다음 탈 구간의 실시간 도착(지하철 realtimeStationArrival, 버스 getStationByUid)을 조회해
// "도착 예상 = 지금 + 남은 구간 예상 합(대기 포함)"과 목표 대비 빠름/늦음을 계산한다.
// 방향 판별·역명 정규화·회차 열차 제외는 watch.py live_lines 로직을 그대로 옮겼다 (watch.py가 원본).
//
// 텔레그램은 trip당 메시지 하나: 처음 sendMessage → trips.live_msg_id 저장, 이후 editMessageText.
// 내용이 같으면 안 고친다. ended_at이 생기면 "🏁 도착 · 총 N분 (예상 M분)"으로 마지막 수정 후 live_msg_id=null.
// 실시간 API는 trip당 1분에 1회 이하 (인스턴스 메모리 캐시).
//
// 호출: POST /tick  (Authorization: Bearer <service_role>)   ?dry=1 이면 보내지 않고 내용을 응답으로.
// 환경변수: BOT_TOKEN, SUBWAY_KEY, BUS_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

// 실시간 로직은 B의 supabase/functions/_shared/realtime.ts 를 쓴다. 그 파일이 올 때까지 같은 시그니처의 임시 파일.
// TODO(B 완료 후): 아래 한 줄을 "../_shared/realtime.ts" 로 바꾸고 realtime_tmp.ts 삭제
import { liveChain, liveLineText, isRide, segLabel, lineLabel, busLabel, stopName, normStation, type Seg, type ChainItem } from "./realtime_tmp.ts";

const BOT = Deno.env.get("BOT_TOKEN") ?? "";
const SUBWAY_KEY = Deno.env.get("SUBWAY_KEY") ?? "";
const BUS_KEY = Deno.env.get("BUS_KEY") ?? "";          // 공공데이터포털 '인코딩' 키 — URL에 그대로 붙인다
const SB_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SB_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const TG = `https://api.telegram.org/bot${BOT}`;

const KST_MS = 9 * 3600 * 1000;
const REALTIME_HORIZON = 30 * 60;   // 실시간 API가 보여 주는 대략의 범위(초). 이보다 먼 승차 지점은 조회 안 함
const MAX_TRIP_SEC = 3 * 3600;
const MIN_SAMPLES = 5, LOOKBACK_DAYS = 60;


// ---------- Supabase ----------
async function db(method: string, path: string, body?: unknown) {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, {
    method,
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json", Prefer: "return=representation" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`db ${method} ${path.split("?")[0]} ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

// ---------- 텔레그램 ----------
async function tg(method: string, payload: Record<string, unknown>): Promise<any> {
  const r = await fetch(`${TG}/${method}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  const j = await r.json().catch(() => ({}));
  if (!j.ok) throw new Error(`tg ${method}: ${j.description ?? r.status}`);
  return j.result;
}

// ---------- 시각 ----------
const kst = (d: Date) => new Date(d.getTime() + KST_MS);
const hhmm = (d: Date) => kst(d).toISOString().slice(11, 16);
const todayStartKst = (now: Date) => new Date(`${kst(now).toISOString().slice(0, 10)}T00:00:00+09:00`);
const since = (ts: string | null, now: Date) => ts ? Math.max(0, (now.getTime() - Date.parse(ts)) / 1000) : 0;
const mins = (sec: number) => Math.round(sec / 60);

// ---------- 소요시간 추정 (watch.py estimate_duration) ----------
function quantile(values: number[], p: number) {
  const v = [...values].sort((a, b) => a - b);
  const pos = (v.length - 1) * p, lo = Math.floor(pos), hi = Math.ceil(pos);
  return v[lo] + (v[hi] - v[lo]) * (pos - lo);
}
function usableDurations(trips: any[]) {
  const out: number[] = [];
  for (const t of trips) {
    if (t.excluded || !t.started_at || !t.ended_at) continue;
    const d = (Date.parse(t.ended_at) - Date.parse(t.started_at)) / 1000;
    if (d >= 180 && d <= MAX_TRIP_SEC) out.push(d);
  }
  return out;
}
function estimateDuration(route: any, segments: Seg[], trips: any[]) {
  const durs = usableDurations(trips);
  if (durs.length >= MIN_SAMPLES) return Math.trunc(quantile(durs, (route.confidence ?? 90) / 100));
  if (route.baseline_sec) return Math.trunc(route.baseline_sec);
  const segSum = segments.reduce((a, s) => a + (s.expected_sec || 0), 0);
  if (segSum) return Math.trunc(segSum);
  return (route.fallback_min ?? 40) * 60;
}

// ---------- 단계 · 남은 시간 ----------
const STAGE = ["승차 지점으로 이동 중", "승강장 대기", "탑승 중", "환승 이동", "두 번째 탑승 중"];
const STAGE_ICON = ["🚶", "🚉", "🚇", "🔄", "🚇"];
const TRIP_FIELDS = ["platform_at", "boarded_at", "transfer_off_at", "transfer_on_at", "ended_at"] as const;
const LABEL: Record<string, string> = { platform_at: "승강장 도착", boarded_at: "열차 탑승", transfer_off_at: "환승 하차", transfer_on_at: "환승 탑승", ended_at: "목적지 도착" };

function stageOf(t: any) {
  return t.transfer_on_at ? 4 : t.transfer_off_at ? 3 : t.boarded_at ? 2 : t.platform_at ? 1 : 0;
}
/** 단계에 따라 (다음 탈 구간 index, 그 승차 지점까지 남은 초 pre, 그 구간부터 끝까지 예상 합 post, 탈 구간 없을 때 남은 초) */
function position(t: any, segments: Seg[], now: Date) {
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

// 실시간 조회 캐시: trip당 1분에 1회 이하 (단계가 바뀌면 다시 조회)
const liveCache = new Map<number, { at: number; segIdx: number; items: ChainItem[] }>();
async function liveFrom(tripId: number, segments: Seg[], fromIndex: number, walkSec: number, now: Date) {
  const c = liveCache.get(tripId);
  if (c && c.segIdx === fromIndex && now.getTime() - c.at < 55_000) return c.items;
  const items = await liveChain(segments, fromIndex, walkSec, { SUBWAY_KEY, BUS_KEY, now });
  liveCache.set(tripId, { at: now.getTime(), segIdx: fromIndex, items });
  return items;
}
// 구간 요약 (watch.py seg_summary): '4호선 노원→선바위', '9201번 선바위역2번출구(광역)→연세대'
function segSummary(s: Seg): string | null {
  if (s.kind === "subway") return [lineLabel(s.line), [normStation(s.station_from), normStation(s.station_to)].filter(Boolean).join("→")].filter(Boolean).join(" ");
  if (s.kind === "bus") {
    const m = /^\s*(.*?)\s*\((.*)\)\s*$/.exec(s.line ?? "");
    return [busLabel(s), m ? m[2] : [stopName(s.station_from), stopName(s.station_to)].filter(Boolean).join("→")].filter(Boolean).join(" ");
  }
  return null;
}

function buttons(t: any, rides: number) {
  const fields = TRIP_FIELDS.filter((f) => !t[f] && (rides >= 2 || !f.startsWith("transfer_")));
  return { inline_keyboard: fields.map((f) => [{ text: LABEL[f], callback_data: `trip:${f}:${t.id}` }]) };
}

async function buildLive(t: any, segments: Seg[], now: Date) {
  const route = t.routes, p = position(t, segments, now);
  let liveLine = "", remaining = p.remaining, waitNote = "";
  if (p.next >= 0) {
    const seg = segments[p.next];
    if (p.pre <= REALTIME_HORIZON) {
      const items = await liveFrom(t.id, segments, p.next, p.pre, now);
      liveLine = items.length ? `${seg.kind === "bus" ? "🚌" : "🚇"} 다음: ${items.map((it, i) => liveLineText(it, it.readyInSec, i === 0)).join(" / ")}` : "";
      // 남은 시간 = 승차 지점까지 + Σ(구간 예상) + 체인이 잡은 차의 실제 대기(waits[0] - readyInSec)
      const waitSec: Record<number, number> = {};
      for (const it of items) if (it.waits.length) waitSec[it.index] = it.waits[0] - it.readyInSec;
      remaining = p.pre + segments.slice(p.next).reduce((a, s, k) => a + (s.expected_sec || 0) + (waitSec[p.next + k] ?? 0), 0);
      if (waitSec[p.next] === undefined) waitNote = " · 대기 미확인";
    } else {
      liveLine = `${seg.kind === "bus" ? "🚌" : "🚇"} 다음: ${segSummary(seg) ?? segLabel(seg)} (${mins(p.pre)}분 뒤 승차 지점 · 실시간은 30분 안에서)`;
      remaining = p.pre + p.post; waitNote = " · 대기 미확인";
    }
  }
  const eta = new Date(now.getTime() + remaining * 1000);
  const [hh, mm] = String(route.arrive_by).split(":").map(Number);
  const target = new Date(todayStartKst(now).getTime() + (hh * 60 + mm) * 60 * 1000);
  const diff = Math.round((target.getTime() - eta.getTime()) / 60000);
  const vs = diff > 0 ? `${diff}분 빠름` : diff < 0 ? `${-diff}분 늦음` : "정시";
  const rides = segments.filter(isRide);
  const curRide = p.stage === 2 ? rides[0] : p.stage === 4 ? (rides[1] ?? rides[0]) : null;   // 탑승 중이면 그 차의 아이콘
  const icon = curRide ? (curRide.kind === "bus" ? "🚌" : "🚇") : STAGE_ICON[p.stage];
  const stageTxt = `${icon} ${STAGE[p.stage]} · 출발 ${hhmm(new Date(t.started_at))} (${mins(since(t.started_at, now))}분 경과)`;
  const text = [`🧭 이동 중 · ${route.name}`, stageTxt, liveLine,
    `도착 예상 ${hhmm(eta)} · 목표 ${hhmm(target)} 대비 ${vs} (남은 약 ${mins(remaining)}분${waitNote})`].filter(Boolean).join("\n");
  return { text, markup: buttons(t, segments.filter(isRide).length) };
}

async function buildFinal(t: any, segments: Seg[], now: Date) {
  const total = Math.round((Date.parse(t.ended_at) - Date.parse(t.started_at)) / 60);
  let expected = t.expected_sec;
  if (!expected) {
    const sinceIso = new Date(now.getTime() - LOOKBACK_DAYS * 86400 * 1000).toISOString();
    const trips = await db("GET", `trips?route_id=eq.${t.route_id}&id=neq.${t.id}&started_at=gte.${encodeURIComponent(sinceIso)}&select=started_at,ended_at,excluded`);
    expected = estimateDuration(t.routes, segments, trips);
  }
  return { text: `🏁 도착 · 총 ${Math.round(total / 1000)}분 (예상 ${Math.ceil(expected / 60)}분)\n${t.routes.name}`, markup: { inline_keyboard: [] } };
}

// 메시지 보내기/고치기. 내용이 같으면 안 고친다.
const lastText = new Map<number, string>();
async function upsertMessage(t: any, chatId: number, text: string, markup: unknown) {
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

// ---------- 인증: legacy service_role(eyJ…)도, 새 secret key(sb_secret_…)도 받는다 ----------
// Supabase가 함수에 자동 주입하는 SUPABASE_SERVICE_ROLE_KEY(legacy JWT)와 SUPABASE_SECRET_KEYS(새 키 목록) 둘 다와 비교
function secretKeys(): string[] {
  const raw = Deno.env.get("SUPABASE_SECRET_KEYS") ?? "";
  let list: string[] = [];
  try { const j = JSON.parse(raw); list = Array.isArray(j) ? j.map((x) => typeof x === "string" ? x : x?.api_key ?? x?.key ?? "") : []; }
  catch { list = raw.split(/[,\s]+/); }
  return [SB_KEY, ...list].filter(Boolean);
}
function authorized(req: Request) {
  const auth = req.headers.get("authorization") ?? "";
  const token = auth.replace(/^Bearer\s+/i, "").trim() || (req.headers.get("apikey") ?? "").trim();
  return !!token && secretKeys().includes(token);
}

// ---------- 메인 ----------
const SELECT = "*,routes(id,name,arrive_by,confidence,baseline_sec,fallback_min),users(telegram_chat_id)";
Deno.serve(async (req) => {
  if (!authorized(req)) return new Response(JSON.stringify({ error: "service_role 키가 필요해요" }), { status: 401 });
  const dry = new URL(req.url).searchParams.get("dry") === "1";
  const now = new Date();
  const out: any[] = [];
  const startFloor = new Date(Math.max(todayStartKst(now).getTime(), now.getTime() - MAX_TRIP_SEC * 1000)).toISOString();

  // 1) 진행 중
  const open = await db("GET", `trips?select=${SELECT}&ended_at=is.null&excluded=not.is.true&started_at=gte.${encodeURIComponent(startFloor)}&order=id`);
  for (const t of open) {
    const chatId = t.users?.telegram_chat_id;
    const rec: any = { trip_id: t.id, route: t.routes?.name, stage: STAGE[stageOf(t)] };
    try {
      if (!t.routes) throw new Error("경로 없음");
      const segments = await db("GET", `segments?route_id=eq.${t.route_id}&order=seq`);
      const { text, markup } = await buildLive(t, segments, now);
      rec.text = text; rec.buttons = markup.inline_keyboard.map((r: any[]) => r[0].text);
      if (dry) rec.action = "dry";
      else if (!chatId) rec.action = "텔레그램 미연결";
      else rec.action = await upsertMessage(t, chatId, text, markup);
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
      const segments = await db("GET", `segments?route_id=eq.${t.route_id}&order=seq`);
      const { text, markup } = await buildFinal(t, segments, now);
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
