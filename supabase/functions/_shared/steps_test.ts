// 기록 단계(trip_events) 시험 — 환승 2번 경로(testdata/trip_events_flow.json, test_watch.py와 같은 픽스처). 네트워크·DB 없음.
// 실행: deno test --allow-read supabase/functions/_shared/steps_test.ts
import { buttonSteps, compatField, eventMap, legacyStep, parseCallback, progress, recordEvent, rideIndexes, stationName, stepCallback, stepLabel,
  tripSteps, withEvents, type Db } from "./steps.ts";
import { buttons, liveMessage, position, stageText } from "./trip_message.ts";
import { alightText, currentRide } from "./alight.ts";
import type { Seg } from "./realtime.ts";

// deno-lint-ignore no-explicit-any
type A = any;
function eq(actual: unknown, expected: unknown, msg = "") {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${msg}\n  실제: ${a}\n  기대: ${e}`);
}
function ok(cond: unknown, msg: string) { if (!cond) throw new Error(msg); }

const FLOW: A = JSON.parse(Deno.readTextFileSync(new URL("./testdata/trip_events_flow.json", import.meta.url)));
const SEGS: Seg[] = FLOW.segments;

/** 가짜 PostgREST: trips 행 하나 + trip_events. noTable이면 trip_events 테이블이 없는 DB (SQL 전). */
function fakeDb(row: A, opts: { noTable?: boolean } = {}) {
  const events: A[] = [];
  const db: Db = (method, path, body) => {
    if (path.startsWith("trip_events")) {
      if (opts.noTable) return Promise.reject(new Error(`db POST trip_events 404: {"code":"PGRST205","message":"Could not find the table 'public.trip_events' in the schema cache"}`));
      const b = body as A;
      if (events.some((e) => e.trip_id === b.trip_id && e.seg_index === b.seg_index && e.kind === b.kind)) return Promise.resolve([]);   // ignore-duplicates
      events.push({ ...b }); return Promise.resolve([b]);
    }
    const m = /^trips\?id=eq\.(\d+)(?:&(\w+)=is\.null)?$/.exec(path);
    if (method === "PATCH" && m) {
      if (m[2] && row[m[2]] != null) return Promise.resolve([]);
      Object.assign(row, body); return Promise.resolve([row]);
    }
    return Promise.reject(new Error(`예상 못 한 호출 ${method} ${path}`));
  };
  return { db, events };
}
/** presses를 앞에서 n개까지 기록한 trip (DB 행 · 메모리 행) */
async function pressed(n: number) {
  const row: A = { ...FLOW.trip }, t: A = { ...FLOW.trip }, { db, events } = fakeDb(row);
  for (const p of FLOW.presses.slice(0, n)) {
    if (p.kind === "end") { row.ended_at = t.ended_at = p.at; continue; }
    await recordEvent(db, t, SEGS, p.seg_index, p.kind, p.at);
  }
  return { row, t, events, db };
}

Deno.test("단계 목록: 환승 2번이어도 끝까지 — '계양 하차', '공항철도 탑승', '서울역 하차', '4호선 탑승', 마지막 하차 = 목적지 도착", () => {
  eq(tripSteps(SEGS).map((s) => s.label), ["출발했어요", "작전 승강장 도착", "인천1호선 탑승", "계양 하차", "공항철도 탑승", "서울역 하차", "4호선 탑승", "목적지 도착"]);
  eq(tripSteps(SEGS).map((s) => [s.kind, s.seg]), [["start", -1], ["platform", 1], ["board", 1], ["alight", 1], ["board", 3], ["alight", 3], ["board", 5], ["end", -1]]);
  eq(FLOW.presses.map((p: A) => stepLabel(SEGS, p.seg_index ?? -1, p.kind)), FLOW.presses.map((p: A) => p.label), "픽스처 이름과 같음");
  eq(tripSteps([{ kind: "walk", expected_sec: 60 }, { kind: "bus", station_from: "11211", station_to: "11234", line: "1142 (노원역1번출구→상신교회)" }]).map((s) => s.label),
     ["출발했어요", "노원역1번출구 정류장 도착", "1142번 탑승", "목적지 도착"], "버스 한 번");
  eq(tripSteps([{ kind: "walk", expected_sec: 600 }]).map((s) => s.kind), ["start", "end"], "탈 구간 없음");
  eq([stationName("서울역 1호선"), stationName("계양역"), stationName("강남역(2호선)"), stationName("인천역")], ["서울역", "계양", "강남", "인천역"]);
  eq(stepLabel(SEGS, 5, "alight"), "혜화 하차", "목록에 없는 마지막 하차도 이름은 만든다");
});

Deno.test("옛 컬럼 ↔ 이벤트: 첫 탈 구간 승강장·탑승·하차, 두 번째 탈 구간 탑승만", () => {
  eq(["platform_at", "boarded_at", "transfer_off_at", "transfer_on_at", "ended_at", "start", "nope"].map((f) => legacyStep(f, SEGS)),
     [{ kind: "platform", seg: 1 }, { kind: "board", seg: 1 }, { kind: "alight", seg: 1 }, { kind: "board", seg: 3 }, { kind: "end", seg: -1 }, { kind: "start", seg: -1 }, null]);
  eq([compatField(SEGS, 1, "platform"), compatField(SEGS, 1, "alight"), compatField(SEGS, 3, "board"), compatField(SEGS, 3, "alight"), compatField(SEGS, 5, "board")],
     ["platform_at", "transfer_off_at", "transfer_on_at", null, null]);
  eq(legacyStep("transfer_on_at", SEGS.slice(0, 2)), null, "탈 구간이 하나뿐인 경로엔 환승 탑승이 없다");
  // 옛 기록(trip_events 없음)도 단계로 읽힌다, trip_events가 있으면 그쪽이 먼저
  const old = { started_at: "s", platform_at: "p", boarded_at: "b", transfer_off_at: "x", transfer_on_at: "y" };
  eq([...eventMap(old, SEGS)], [["1:platform", "p"], ["1:board", "b"], ["1:alight", "x"], ["3:board", "y"]]);
  eq(eventMap({ ...old, trip_events: [{ seg_index: 1, kind: "platform", at: "P2" }] }, SEGS).get("1:platform"), "P2");
});

Deno.test("recordEvent: 픽스처대로 누르면 trip_events 6개 + 옛 컬럼은 첫 값만 (test_watch.py가 이 행을 쓴다)", async () => {
  const { row, t, events, db } = await pressed(FLOW.presses.length);
  eq(events.length, FLOW.expected_events);
  for (const [k, v] of Object.entries(FLOW.expected_columns)) eq(row[k], v, `trips.${k}`);
  eq([t.platform_at, t.transfer_on_at], [FLOW.expected_columns.platform_at, FLOW.expected_columns.transfer_on_at], "메모리 행도 같은 값");
  // 같은 단계를 또 누르면 아무것도 안 바뀜
  eq(await recordEvent(db, t, SEGS, 3, "board", "2026-11-01T09:00:00+09:00"), { fresh: false, compat: null });
  eq(row.transfer_on_at, FLOW.expected_columns.transfer_on_at, "두 번째 누름이 첫 값을 덮지 않음");
  // 옛 컬럼이 이미 있으면(다른 기기가 먼저) 이벤트만 넣고 컬럼은 그대로
  const r2: A = { ...FLOW.trip, platform_at: "2026-11-01T07:35:00+09:00" }, f2 = fakeDb(r2);
  eq(await recordEvent(f2.db, { ...r2 }, SEGS, 1, "platform", "2026-11-01T07:37:00+09:00"), { fresh: true, compat: null });
  eq(r2.platform_at, "2026-11-01T07:35:00+09:00");
});

Deno.test("recordEvent: trip_events 테이블이 없으면(SQL 전) 옛 컬럼만, 대응 컬럼 없는 단계는 오류", async () => {
  const row: A = { ...FLOW.trip }, t: A = { ...FLOW.trip }, { db } = fakeDb(row, { noTable: true });
  eq(await recordEvent(db, t, SEGS, 1, "platform", "2026-11-01T07:37:00+09:00"), { fresh: true, compat: "platform_at" });
  eq(row.platform_at, "2026-11-01T07:37:00+09:00");
  let err = "";
  try { await recordEvent(db, t, SEGS, 3, "alight", "2026-11-01T08:14:00+09:00"); } catch (e) { err = String(e); }
  ok(err.includes("trip_events"), `서울역 하차는 옛 컬럼이 없어 기록 못 함: ${err}`);
  const reads: string[] = [];
  const res = await withEvents(async (e) => { reads.push(e); if (e) throw new Error("db GET trips 400: Could not find a relationship between 'trips' and 'trip_events'"); return ["ok"]; });
  eq([res, reads], [["ok"], [",trip_events(seg_index,kind,at)", ""]], "select에서 trip_events 빼고 다시 읽기");
});

Deno.test("진행 상황: 걷는 중 → 승강장 → 인천1호선 → 환승 → 공항철도 → 환승 → 4호선 → 도착", async () => {
  const states = [];
  for (let n = 0; n <= FLOW.presses.length; n++) {
    const { t } = await pressed(n), p = progress(t, SEGS);
    states.push([p.state, p.seg, stageText(p, SEGS)]);
  }
  eq(states, [["walk", -1, "🚶 승차 지점으로 이동 중"], ["platform", 1, "🚉 승강장 대기"], ["ride", 1, "🚇 인천1호선 탑승 중"],
              ["transfer", 1, "🔄 환승 이동 · 다음 공항철도"], ["ride", 3, "🚇 공항철도 탑승 중"], ["transfer", 3, "🔄 환승 이동 · 다음 4호선"],
              ["ride", 5, "🚇 4호선 탑승 중"], ["done", -1, "🏁 도착"]]);
});

Deno.test("버튼: 다음 단계·그다음(건너뛰기) + 목적지 도착, 콜백 trip:ev:<trip>:<seg>:<kind>", async () => {
  const { t } = await pressed(3);   // 계양 하차까지
  const mk = buttons(t, SEGS).inline_keyboard.map((r) => [r[0].text, r[0].callback_data]);
  eq(mk, [["공항철도 탑승", "trip:ev:77:3:board"], ["서울역 하차", "trip:ev:77:3:alight"], ["목적지 도착", "trip:ended_at:77"]]);
  const last = await pressed(6);    // 4호선 탑승까지 → 남은 건 도착뿐
  eq(buttons(last.t, SEGS).inline_keyboard.map((r) => r[0].text), ["목적지 도착"]);
  eq(buttonSteps(progress((await pressed(7)).t, SEGS)), [], "도착하면 버튼 없음");
  eq(stepCallback(77, tripSteps(SEGS)[5]), "trip:ev:77:3:alight");
});

Deno.test("parseCallback: 새 형식·도착·출발·옛 형식, 이상한 값은 null", () => {
  eq(parseCallback("trip:ev:77:3:board"), { type: "ev", tripId: 77, seg: 3, kind: "board" });
  eq(parseCallback("trip:ended_at:77"), { type: "end", tripId: 77 });
  eq(parseCallback("trip:start:9"), { type: "start", routeId: 9 });
  eq(parseCallback("trip:transfer_on_at:77"), { type: "legacy", tripId: 77, field: "transfer_on_at" });
  eq(["trip:ev:77:3:jump", "trip:ev:x:3:board", "trip:boarded_at:0", "foo:start:1", "trip:ev:77:3", ""].map(parseCallback), [null, null, null, null, null, null]);
  ok("trip:ev:2147483647:12:platform".length <= 64, "텔레그램 callback_data 64바이트 안");
});

Deno.test("position: 공항철도 탄 지 10분 → 4호선 승차까지 20분, 이동 중 카드 문구", async () => {
  const { t } = await pressed(4);   // 공항철도 탑승 07:48
  const now = new Date("2026-11-01T07:58:00+09:00");
  const pos = position(t, SEGS, now);
  eq([pos.state, pos.next, pos.pre, pos.post], ["ride", 5, (1500 - 600) + 300, 900 + 360]);
  const { text, markup } = await liveMessage({ ...t, routes: FLOW.route }, SEGS, { now, log: () => {} }, async () => [], null);
  ok(text.split("\n")[1].startsWith("🚇 공항철도 탑승 중 · 출발 07:30 (28분 경과)"), text);
  eq(markup.inline_keyboard.map((r) => r[0].text), ["서울역 하차", "4호선 탑승", "목적지 도착"]);
});

Deno.test("하차 알림도 세 번째 탈 구간까지: 4호선 탑승 뒤 지금 탄 구간 = seg 5, 서울역 알림 문구", async () => {
  eq(currentRide((await pressed(6)).t, SEGS), { index: 5, since: FLOW.presses[5].at });
  eq(currentRide((await pressed(4)).t, SEGS), { index: 3, since: FLOW.presses[3].at });
  eq(currentRide((await pressed(5)).t, SEGS), null, "서울역 하차 뒤 환승 중");
  eq(alightText(SEGS, 3, 2), "🔔 2정거장 뒤 서울역 하차 · 4호선 환승");
  eq(alightText(SEGS, 3, 0), "🚪 서울역 도착 · 내리세요 (4호선, 도보 5분)");
  eq(rideIndexes(SEGS), [1, 3, 5]);
});
