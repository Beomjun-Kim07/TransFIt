// 하차 알림 시험 — testdata/의 실제 API 응답(2026-11-01 16:47 a·16:49 b, 서울 지하철 realtimeStationArrival·버스 getStationByUid)으로
// 정거장 셈·단계·문구를 확인한다. 네트워크 없음, 텔레그램 안 보냄.
// 실행: deno test --allow-read supabase/functions/_shared/alight_test.ts
import { boardingVehicle, busAway, rideStops, subwayAway, subwayHeading, type Env, type Seg } from "./realtime.ts";
import { alertPrefs, alightLine, alightMessage, alightPlace, alightState, alightText, currentRide, estimateAway, liveLevel, pickAlert,
  prefsText, rideIndexFor, rideOnBoard, stopList } from "./alight.ts";
import { liveMessage } from "./trip_message.ts";

// deno-lint-ignore no-explicit-any
type A = any;
function eq(actual: unknown, expected: unknown, msg = "") {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${msg}\n  실제: ${a}\n  기대: ${e}`);
}
function ok(cond: unknown, msg: string) { if (!cond) throw new Error(msg); }
const quiet = (m: string) => void m;

// ---------- 실제 응답 샘플 ----------
const DIR = new URL("./testdata/", import.meta.url);
const read = (f: string): A => JSON.parse(Deno.readTextFileSync(new URL(f, DIR)));
const SUBWAY_FILES: Record<string, string> = { 노원: "nowon", 창동: "changdong", 마들: "madeul", 수락산: "suraksan", 도봉산: "dobongsan",
  부평: "bupyeong", 인천시청: "incheon_cityhall", 사당: "sadang" };
const BUS_STOPS = ["11211", "11212", "11213", "11354"];
const subwayOf = (cap: "a" | "b", st: string): A => read(`subway_${SUBWAY_FILES[st]}_${cap}.json`);
const busOf = (cap: "a" | "b", ars: string): A => read(`bus_${ars}_${cap}.json`);
const NOW = { a: new Date("2026-11-01T16:47:00+09:00"), b: new Date("2026-11-01T16:49:05+09:00") };

/** 캡처 a·b의 실제 응답을 돌려주는 가짜 fetch. 부른 주소는 calls에 쌓는다. */
function capFetch(cap: "a" | "b", calls: string[] = []): typeof fetch {
  return ((input: string | URL | Request) => {
    const url = String(input); calls.push(url);
    let body: A;
    if (url.includes("/realtimeStationArrival/ALL")) {
      body = { realtimeArrivalList: Object.keys(SUBWAY_FILES).map((statnNm) => ({ statnNm })) };
    } else if (url.includes("/realtimeStationArrival/")) {
      const st = decodeURIComponent(url.split("/").pop()!);
      body = SUBWAY_FILES[st] ? subwayOf(cap, st) : { status: 500, code: "INFO-200", message: "해당하는 데이터가 없습니다." };
    } else if (url.includes("stationinfo/getStationByUid")) {
      const ars = new URL(url).searchParams.get("arsId") ?? "";
      body = BUS_STOPS.includes(ars) ? busOf(cap, ars) : { msgHeader: { headerCd: "4" }, msgBody: { itemList: [] } };
    } else body = { msgHeader: { headerCd: "4" }, msgBody: { itemList: [] } };
    return Promise.resolve(new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } }));
  }) as typeof fetch;
}
const env = (cap: "a" | "b", calls: string[] = []): Env => ({ SUBWAY_KEY: "fake", BUS_KEY: "fake", fetch: capFetch(cap, calls), now: NOW[cap], log: quiet });

// ---------- 정거장 셈 (실제 응답 전체) ----------
Deno.test("실제 응답: 지하철 away = arvlCd·'[N]번째 전역'·ordkey 남은 역 수가 서로 맞음", () => {
  let n = 0;
  for (const st of Object.keys(SUBWAY_FILES)) for (const cap of ["a", "b"] as const) {
    for (const a of subwayOf(cap, st).realtimeArrivalList ?? []) {
      if (String(a.arvlCd) === "2") continue;                              // 하차역 출발 = 지남 (rideStops가 따로 본다)
      const ord = parseInt(String(a.ordkey).slice(2, 5), 10);
      eq(subwayAway(a), ord, `${st} ${a.btrainNo} ${a.arvlMsg2} (arvlCd ${a.arvlCd}, ordkey ${a.ordkey})`);
      n++;
    }
  }
  ok(n > 50, `확인한 열차 ${n}개`);
  // 대표 예 (캡처 a·b)
  const find = (cap: "a" | "b", st: string, no: string) => subwayOf(cap, st).realtimeArrivalList.find((a: A) => a.btrainNo === no);
  eq(subwayAway(find("a", "창동", "0118")), 2, "1호선(코레일) '[2]번째 전역 (월계)', barvlDt 0");
  eq(subwayAway(find("b", "창동", "0118")), 0, "2분 뒤 '창동 진입' (arvlCd 0)");
  eq(subwayAway(find("a", "노원", "4110")), 1, "'전역 도착' (arvlCd 5)");
  eq(subwayAway(find("b", "노원", "7178")), 0, "'노원 도착' (arvlCd 1)");
  eq(subwayAway(find("b", "수락산", "7178")), 2, "'5분 후 (노원)' — 문구엔 역 수가 없어 ordkey 002");
});

Deno.test("실제 응답: 버스 away = '곧 도착' 1, '[N번째 전]' N+1 (= staOrd − sectOrd + 1)", () => {
  let n = 0;
  for (const ars of BUS_STOPS) for (const cap of ["a", "b"] as const) {
    for (const it of busOf(cap, ars).msgBody.itemList) for (const k of [1, 2] as const) {
      const msg = String(it[`arrmsg${k}`] ?? "");
      if (!/곧 도착|번째 전/.test(msg)) continue;                          // 운행종료·출발대기·차고지출발
      eq(busAway(it, k), Number(it.staOrd) - Number(it[`sectOrd${k}`]) + 1, `${ars} ${it.rtNm} ${msg}`);
      n++;
    }
  }
  ok(n > 30, `확인한 버스 ${n}대`);
});

Deno.test("실제 응답: 같은 1132번 차가 와우패션클럽(33)→롯데백화점노원점(34)→노원역1번출구(35)로 갈 때 정거장 셈 (캡처 b)", async () => {
  const ride = { vehId: "110052066" };   // 와우패션클럽 '곧 도착' 5초, 롯데 '[1번째 전]', 노원역1번출구 '[2번째 전]'
  const seg = (to: string): Seg => ({ kind: "bus", station_from: "11354", station_to: to, line: "1132 (중계주공10단지.중계건영3차아파트→하차)" });
  const at = async (to: string) => { const r = await rideStops(seg(to), ride, env("b")); return [r.away, liveLevel(r, "bus"), r.msg]; };
  eq(await at("11213"), [1, 0, "곧 도착"], "와우패션클럽: 다음 정류장 + 60초 안 → 도착(0)");
  eq(await at("11212"), [2, 2, "1분후[1번째 전]"], "롯데: 와우패션클럽을 지나야 함 → 2정거장 전");
  eq(await at("11211"), [3, 3, "5분후[2번째 전]"], "노원역1번출구: 3정거장 — 아직 알림 없음");
});

// ---------- rideStops: 지하철 ----------
const SUB = (from: string, to: string, line: string, extra: Partial<Seg> = {}): Seg =>
  ({ kind: "subway", station_from: from, station_to: to, line, expected_sec: 600, ...extra });

Deno.test("rideStops 지하철 (실제 응답): 진입·도착 0, 전역 1, 두 정거장 2, 하차역 출발 = passed", async () => {
  const r = async (cap: "a" | "b", seg: Seg, no: string) => { const x = await rideStops(seg, { trainNo: no }, env(cap)); return [x.source, x.away, liveLevel(x, "subway")]; };
  eq(await r("a", SUB("창동역", "노원역", "4호선"), "4110"), ["live", 1, 1], "a: 4110 '전역 도착'");
  eq(await r("b", SUB("창동역", "노원역", "4호선"), "4110"), ["live", 0, 0], "b: 4110 '노원 도착'");
  eq(await r("b", SUB("노원역", "수락산역", "7호선"), "7178"), ["live", 2, 2], "b: 7178 '5분 후 (노원)' = 2정거장 전");
  eq(await r("b", SUB("노원역", "마들역", "7호선"), "7178"), ["live", 1, 1], "b: 마들엔 7178 '전역 도착' (barvlDt 120이라 아직 1)");
  eq(await r("b", SUB("노원역", "도봉산역", "7호선"), "7178"), ["live", 3, 3], "b: 도봉산엔 '8분 후 (노원)' = 3 → 알림 없음");
  eq(await r("a", SUB("월계역", "창동역", "1호선"), "0118"), ["live", 2, 2], "a: 코레일 '[2]번째 전역 (월계)'");
  eq(await r("b", SUB("월계역", "창동역", "1호선"), "0118"), ["live", 0, 0], "b: '창동 진입'");
  eq((await rideStops(SUB("상계역", "노원역", "4호선"), { trainNo: "4119" }, env("a"))).source, "passed", "a: 4119 '노원 출발' = 이미 지남");
  const gone = await rideStops(SUB("상계역", "노원역", "4호선"), { trainNo: "9999" }, env("a"));
  eq([gone.source, gone.listed], ["none", true], "목록은 왔는데 그 열차가 안 보임");
  const inc = await rideStops(SUB("부평역", "인천시청역", "인천1호선"), { trainNo: "1234" }, env("a"));
  eq([inc.source, inc.listed ?? false], ["none", false], "인천시청(인천 1호선): API에 없음 (INFO-200) → 추정으로");
  eq((await rideStops(SUB("노원역", "수락산역", "7호선"), {}, env("b"))).reason, "탄 열차 번호 없음");
});

Deno.test("subwayAway 순수: 문구·ordkey가 없으면 null", () => {
  eq(subwayAway({ arvlCd: "99", arvlMsg2: "3분 후", ordkey: "" }), null);
  eq(subwayAway({ arvlCd: "4", arvlMsg2: "전역 진입" }), 1);
  eq(busAway({ arrmsg1: "[차고지출발] ", staOrd: "13", sectOrd1: "2" }, 1), 12, "문구에 없으면 staOrd − sectOrd + 1");
  eq(busAway({ arrmsg1: "운행종료", staOrd: "1", sectOrd1: "0" }, 1), null);
});

// ---------- 탑승 순간 탄 차 (boardingVehicle boarded) ----------
Deno.test("boardingVehicle boarded (실제 응답): 방금 떠난(출발)·도착 중 열차를 고르고, 2분 넘게 먼 차만 있으면 {}", async () => {
  const s = SUB("노원역", "창동역", "4호선");
  eq(await boardingVehicle(s, env("a")), { trainNo: "4625" }, "기본: 떠난 4119는 빼고 다음 열차 (B의 동작 그대로)");
  eq(await boardingVehicle(s, env("a"), { boarded: true }), { trainNo: "4119" }, "탑승 버튼: 70초 전 '노원 출발'한 4119 = 내가 탄 열차");
  eq(await boardingVehicle(SUB("노원역", "마들역", "7호선"), env("b"), { boarded: true }), { trainNo: "7178" }, "'노원 도착' 7178");
  eq(await boardingVehicle(SUB("노원역", "중계역", "7호선"), env("a"), { boarded: true }), {}, "7호선 하행 가장 빠른 열차 5분 뒤 → 못 정함");
  const bus = (from: string, line: string): Seg => ({ kind: "bus", station_from: from, station_to: "11212", line });
  eq(await boardingVehicle(bus("11354", "1132 (중계주공10단지.중계건영3차아파트→롯데백화점노원점.노원역4번출구)"), env("a"), { boarded: true }),
     { vehId: "110052484" }, "버스 '곧 도착' 92초");
  eq(await boardingVehicle(bus("11211", "1138 (노원역1번출구→상계2동주민센터)"), env("a"), { boarded: true }), {}, "1138 '10분후[4번째 전]'뿐 → 못 정함");
});

Deno.test("rideOnBoard: 탑승 단계 → 그 구간의 탄 차, 못 정하면 null 둘 (앞 구간 차 지움)", async () => {
  const segs: Seg[] = [{ kind: "walk", expected_sec: 300 }, SUB("노원역", "창동역", "4호선"), { kind: "transfer", expected_sec: 240 }, SUB("노원역", "중계역", "7호선")];
  eq([rideIndexFor("boarded_at", segs), rideIndexFor("transfer_on_at", segs), rideIndexFor("ended_at", segs)], [1, 3, -1]);
  eq(await rideOnBoard("boarded_at", segs, env("a")), { ride_veh: null, ride_train: "4119" });
  eq(await rideOnBoard("transfer_on_at", segs, env("a")), { ride_veh: null, ride_train: null });
  eq(await rideOnBoard("platform_at", segs, env("a")), null);
});

// ---------- 추정 ----------
Deno.test("estimateAway: 정거장 목록 비례, 목록 없으면 정거장당 2분, 예상+5분 지나면 null", () => {
  const s = (names: string[] | null, sec = 600): Seg => ({ kind: "subway", station_to: "도봉산", expected_sec: sec, stop_names: names });
  const five = s(["노원", "마들", "수락산", "도봉산", "장암"]);   // 4정거장
  eq([0, 150, 300, 450, 545, 600].map((e) => estimateAway(five, e)?.away), [4, 3, 2, 1, 0, 0]);
  eq(estimateAway(five, 901), null, "600초 구간인데 15분 넘게 지남");
  eq([300, 400, 500].map((e) => estimateAway(s(null), e)?.away), [3, 2, 1], "목록 없음: 남은 초 ÷ 120 올림");
  eq(estimateAway(s(["노원", "도봉산"], 900), 0)?.hops, null, "양 끝만 있는데 15분 구간 → 목록 못 믿음");
  eq(estimateAway(s(["노원", "마들"], 120), 10)?.away, 1, "진짜 한 정거장 → 바로 '다음 역'");
  eq(stopList({ kind: "bus", stop_names: '["a","b"]' }), ["a", "b"], "jsonb가 문자열로 와도");
  eq(estimateAway({ kind: "bus", expected_sec: 0 }, 10), null, "예상 없음");
});

// ---------- 단계 고르기 ----------
Deno.test("pickAlert: 지금 단계 하나만 — 2→0 건너뛰면 0만, 되돌아가지 않음, 끈 단계 없음", () => {
  const all = alertPrefs("2,1,0");
  eq(pickAlert(2, all, []), 2);
  eq(pickAlert(0, all, [2]), 0, "1을 건너뛰고 0");
  eq(pickAlert(1, all, [0]), null, "도착 뒤에 1로 돌아가도 안 보냄");
  eq(pickAlert(2, all, [2]), null, "이미 보냄");
  eq(pickAlert(3, all, []), null);
  eq(pickAlert(null, all, []), null);
  eq(pickAlert(1, alertPrefs("2,0"), []), null, "1정거장 전 끔");
  eq(pickAlert(0, alertPrefs(""), []), null, "전부 끔");
  eq([prefsText(alertPrefs(null)), prefsText(alertPrefs("0, 2")), prefsText(alertPrefs("9,x"))], ["2,1,0", "2,0", ""]);
});

// ---------- 지금 탄 구간 ----------
const SEGS: Seg[] = [
  { kind: "walk", expected_sec: 300 },
  SUB("창동역", "노원역", "4호선", { expected_sec: 120, stop_names: ["창동", "노원"] }),
  { kind: "transfer", station_from: "노원", station_to: "노원", expected_sec: 240 },
  SUB("노원역", "수락산역", "7호선", { expected_sec: 240, stop_names: ["노원", "마들", "수락산"] }),
  { kind: "walk", expected_sec: 420 },
];
const trip = (o: Record<string, unknown>) => ({ id: 1, started_at: "2026-11-01T07:30:00Z", routes: { name: "집 → 학교", arrive_by: "17:30:00" }, ...o });

Deno.test("currentRide: 탑승 중에만 (환승 하차~환승 탑승 사이·도착 뒤는 없음)", () => {
  eq(currentRide(trip({ boarded_at: "x" }), SEGS), { index: 1, since: "x" });
  eq(currentRide(trip({ boarded_at: "x", transfer_off_at: "y" }), SEGS), null);
  eq(currentRide(trip({ boarded_at: "x", transfer_off_at: "y", transfer_on_at: "z" }), SEGS), { index: 3, since: "z" });
  eq(currentRide(trip({ boarded_at: "x", ended_at: "w" }), SEGS), null);
  eq(currentRide(trip({ platform_at: "x" }), SEGS), null);
});

// ---------- 끝까지: 상태 → 문구 ----------
const ago = (cap: "a" | "b", sec: number) => new Date(NOW[cap].getTime() - sec * 1000).toISOString();

Deno.test("alightState→alightMessage (실제 응답): 4호선 노원 하차 '다음 역'(a) → '도착 · 7호선 환승'(b)", async () => {
  const t = (cap: "a" | "b") => trip({ boarded_at: ago(cap, 60), ride_train: "4110" });
  const a = await alightState(t("a"), SEGS, env("a"));
  eq([a?.index, a?.level, a?.source, a?.place], [1, 1, "live", "노원"]);
  eq(await alightMessage(SEGS, 1, 1, env("a")), "🔔 다음 역 노원, 내릴 준비");
  const b = await alightState(t("b"), SEGS, env("b"));
  eq([b?.level, b?.source], [0, "live"]);
  eq(pickAlert(b!.level, alertPrefs(null), [1]), 0);
  eq(await alightMessage(SEGS, 1, 0, env("b")), "🚪 노원 도착 · 내리세요 (7호선 도봉산 방면, 도보 4분)", "방면 = 노원 7호선 상행 첫 열차 7178 '도봉산행'");
  eq(await subwayHeading(SEGS[3], env("b")), "도봉산 방면");
});

Deno.test("alightState (실제 응답): 환승 탑승 뒤 7호선 수락산 '2정거장 뒤', 마지막 구간은 '목적지까지 도보'", async () => {
  const t = trip({ boarded_at: ago("b", 900), transfer_off_at: ago("b", 700), transfer_on_at: ago("b", 30), ride_train: "7178" });
  const st = await alightState(t, SEGS, env("b"));
  eq([st?.index, st?.level, st?.source], [3, 2, "live"]);
  eq(alightText(SEGS, 3, 2), "🔔 2정거장 뒤 수락산 하차");
  eq(alightText(SEGS, 3, 0), "🚪 수락산 도착 · 내리세요 (목적지까지 도보 7분)");
  eq(alightLine(st), "🚏 수락산 하차까지 2정거장");
});

Deno.test("alightState: 실시간에 없는 노선(인천 1호선)은 정거장 목록으로 추정 + '(추정)'", async () => {
  const segs: Seg[] = [SUB("부평역", "인천시청역", "인천1호선", { expected_sec: 600, stop_names: ["부평", "동수", "부평삼거리", "간석오거리", "인천시청"] }),
                       { kind: "bus", station_from: "12345", station_to: "54321", line: "28 (인천시청→학교)" }];
  const at = async (sec: number) => (await alightState(trip({ boarded_at: ago("a", sec), ride_train: "1234" }), segs, env("a")))!;
  const st = await at(320);   // 4정거장 중 2.1 → 2정거장 전
  eq([st.level, st.source, st.live?.reason], [2, "estimate", "하차역 인천시청 실시간 없음"]);
  eq(await alightMessage(segs, 0, st.level!, env("a"), { estimated: true }), "🔔 2정거장 뒤 인천시청 하차 · 28번 환승 (추정)");
  eq(alightLine(st), "🚏 인천시청 하차까지 2정거장 (추정)");
  eq((await at(560)).level, 0, "남은 40초 → 도착");
  eq(alightText(segs, 0, 0, { estimated: true }), "🚪 인천시청 도착 · 내리세요 (28번 인천시청) (추정)");
  eq((await at(1000)).level, null, "예상+5분 지나면 추정으론 안 보냄");
});

Deno.test("alightState: 1정거장 안으로 보이던 차가 목록에서 빠지면 '지남', 멀면 실시간을 부르지 않음", async () => {
  const t = trip({ boarded_at: ago("a", 60), ride_train: "9999" });    // 노원 목록엔 9999 없음, 150초 구간에 60초 → 남은 90초
  const segs: Seg[] = [SUB("상계역", "노원역", "4호선", { expected_sec: 150, stop_names: ["상계", "노원"] })];
  const st = await alightState(t, segs, env("a"), { lastLive: () => ({ level: 1, at: NOW.a.getTime() - 60_000 }) });
  eq([st?.source, st?.level], ["passed", null]);
  const est = await alightState(t, segs, env("a"));
  eq([est?.source, est?.level], ["estimate", 1], "기억이 없으면 추정 (남은 90초 → 다음 역)");
  const calls: string[] = [];
  const far = await alightState(trip({ boarded_at: ago("a", 60), ride_train: "4110" }),
    [SUB("노원역", "사당역", "4호선", { expected_sec: 3000, stop_names: Array.from({ length: 23 }, (_, i) => `역${i}`) })], env("a", calls));
  eq([far?.source, far?.level, calls.length], ["estimate", 22, 0], "50분 구간 1분째: 실시간 안 부름");
  eq(alightLine(far), "🚏 사당 하차까지 22정거장 (추정)");
});

Deno.test("이름: 버스 하차 정류장은 line 괄호 뒤쪽, 번호만 있으면 '번 정류장'", () => {
  eq(alightPlace({ kind: "bus", station_to: "11212", line: "1132 (중계주공10단지→롯데백화점노원점.노원역4번출구)" }), "롯데백화점노원점.노원역4번출구");
  eq(alightPlace({ kind: "bus", station_to: "11212", line: "1132" }), "11212번 정류장");
  eq(alightPlace({ kind: "subway", station_to: "노원역" }), "노원");
  eq(alightText([{ kind: "bus", station_to: "11212", line: "1132 (a→노원역)" }], 0, 1), "🔔 다음 정류장 노원역, 내릴 준비");
});

Deno.test("이동 중 카드에 하차 줄 (tick이 넘긴 상태)", async () => {
  const t = trip({ boarded_at: ago("b", 30), transfer_off_at: null, ride_train: "4110" });
  const st = await alightState(t, SEGS, env("b"));
  const { text } = await liveMessage(t, SEGS, env("b"), async () => [], st);
  ok(text.split("\n")[2] === "🚏 노원 도착", text);
  const none = await liveMessage(trip({}), SEGS, env("b"), async () => [], null);
  ok(!none.text.includes("🚏"), none.text);
});
