// realtime.ts 시험 — test_watch.py의 live 관련 케이스를 옮겼다. 텔레그램은 안 보낸다.
// 실행: deno test --allow-net --allow-read --allow-env supabase/functions/_shared/realtime_test.ts
// 앞부분은 가짜 데이터(네트워크 없음). '실제 API' 시험은 .env.local(또는 환경변수)에 SUBWAY_KEY·BUS_KEY가 있을 때만 돌고, 키는 출력하지 않는다.
import {
  boardingVehicle, busEta, busLabel, busStopIds, type ChainItem, dropShortTurn, type Env, firstWalkSec, idDist, isRough, lineId, lineLabel, liveChain,
  liveForSegment, liveLineText, liveText, normStation, personalWalkSec, pickBusStop, pickDirection, redact, rideEta, routeMatch, sameStation,
  type Seg, SEC_PER_STATION, stopName, subwayEta, timedTrains, type TripRow,
} from "./realtime.ts";

// deno-lint-ignore no-explicit-any
type A = any;
function eq(actual: unknown, expected: unknown, msg = "") {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${msg}\n  실제: ${a}\n  기대: ${e}`);
}
function ok(cond: unknown, msg: string) { if (!cond) throw new Error(msg); }
const now = new Date();
const quiet = (m: string) => void m;

// test_watch.py tr()와 같은 가짜 열차
function tr(sid: string, upd: string, tln: string, cur: number, nxt: number, term: number, bar = "120", no = "1"): A {
  return { subwayId: sid, updnLine: upd, trainLineNm: tln, statnId: String(cur), statnTid: String(nxt), bstatnId: String(term),
    bstatnNm: tln.split("행")[0], barvlDt: bar, arvlCd: "99", arvlMsg2: "", btrainNo: no, recptnDt: "" };
}
// 가짜 fetch: 지하철 역 이름 → 도착 목록, 버스 arsId → getStationByUid 항목, 정류장 이름 → getStationByName 항목
function fakeFetch(subway: Record<string, A[]>, bus: Record<string, A[]> = {}, fail = "", byName: Record<string, A[]> = {}): typeof fetch {
  return ((input: string | URL | Request) => {
    const url = String(input);
    if (fail) return Promise.reject(new TypeError(`error sending request for url (${url}): ${fail}`));
    let body: A = {};
    if (url.includes("/realtimeStationArrival/0/30/")) {
      const st = decodeURIComponent(url.split("/").pop()!);
      body = { errorMessage: { code: "INFO-000" }, realtimeArrivalList: subway[st] ?? [] };
    } else if (url.includes("/realtimeStationArrival/ALL")) {
      body = { realtimeArrivalList: Object.keys(subway).map((statnNm) => ({ statnNm })) };
    } else if (url.includes("stationinfo/getStationByUid")) {
      body = { msgHeader: { headerCd: "0" }, msgBody: { itemList: bus[new URL(url).searchParams.get("arsId") ?? ""] ?? [] } };
    } else if (url.includes("stationinfo/getStationByName")) {
      body = { msgHeader: { headerCd: "0" }, msgBody: { itemList: byName[new URL(url).searchParams.get("stSrch") ?? ""] ?? [] } };
    } else body = { msgHeader: { headerCd: "4" }, msgBody: { itemList: [] } };
    return Promise.resolve(new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } }));
  }) as typeof fetch;
}
const fakeEnv = (f: typeof fetch): Env => ({ SUBWAY_KEY: "fake-subway", BUS_KEY: "fake%2Bbus", fetch: f, now, log: quiet });

// ---------- 순수 함수 ----------
Deno.test("역 이름·노선 이름", () => {
  eq(normStation("노원역"), "노원");
  eq(normStation("강남역(2호선)"), "강남");
  eq(normStation("서울역 1호선"), "서울");
  eq(normStation("총신대입구(이수)역"), "총신대입구(이수)");
  ok(sameStation("이수", "총신대입구(이수)") && sameStation("신촌", "신촌(경의중앙선)") && !sameStation("노원", "창동"), "same_station");
  ok(lineId("수도권 4호선") === "1004" && lineId("신분당선") === "1077" && lineId("경의중앙선") === "1063" && lineId("") === "", "line_id");
  ok(idDist("1002", 1002000243, 1002000201) === 1 && idDist("1002", 1002000211, 1002000222) === 11, "2호선 순환 거리");
  ok(routeMatch("146", "간선 146") && routeMatch("146", "146번") && !routeMatch("1460", "146"), "route_match");
  ok(lineLabel("수도권 4호선") === "4호선" && lineLabel("인천1호선") === "인천1호선" && lineLabel("", "1004") === "4호선" && lineLabel(null) === "지하철", "line_label");
  ok(stopName("노원역 11234") === "노원역" && stopName("11234") === "", "stop_name");
  eq(busLabel({ kind: "bus", line: "1142 (노원역1번출구→노원구청)" }), "1142번");
});

// ---------- 방향 판정 ----------
Deno.test("방향 판정 (가짜 데이터)", () => {
  // 2호선 건대입구(212)에서 양쪽 다 '성수행' → 방면·종착역으로 못 정하고 역 ID로
  const arr = [tr("1002", "외선", "성수행 - 성수방면", 1002000212, 1002000211, 1002000211),
               tr("1002", "내선", "성수행 - 구의방면", 1002000212, 1002000213, 1002000211)];
  let [g, why] = pickDirection(arr, "뚝섬", { "1002": 1002000210 });
  eq(g?.[0].updnLine, "외선", `건대입구→뚝섬 = 외선 (${why})`);
  [g, why] = pickDirection(arr, "성수", { "1002": 1002000211 });
  ok(g?.[0].updnLine === "외선" && why.includes("방면"), `건대입구→성수 = 외선 (${why})`);
  [g, why] = pickDirection(arr, "강남", { "1002": 1002000222 });
  eq(g?.[0].updnLine, "내선", `건대입구→강남 = 내선 (${why})`);
  [g] = pickDirection(arr, "강남", {});
  eq(g, null, "도착역 ID 없으면 미확정");
  // 4호선 노원(411)→사당(433) 하행, 한성대입구(418)행은 회차
  const arr4 = [tr("1004", "하행", "오이도행 - 창동방면", 1004000411, 1004000412, 1004000456, "120", "a"),
                tr("1004", "하행", "한성대입구행 - 창동방면", 1004000411, 1004000412, 1004000418, "120", "b"),
                tr("1004", "상행", "진접행 - 상계방면", 1004000411, 1004000410, 1004000405, "120", "c")];
  [g, why] = pickDirection(arr4, "사당", { "1004": 1004000433 });
  eq([...new Set(g!.map((a: A) => a.updnLine))], ["하행"], `노원→사당 = 하행 (${why})`);
  eq(dropShortTurn(g!, { "1004": 1004000433 }).map((a: A) => a.btrainNo), ["a"], "한성대입구행(회차) 제외");
  eq(dropShortTurn(g!, { "1004": 1004000415 }).length, 2, "도착역이 회차역 앞이면 둘 다 유지");
  [g, why] = pickDirection(arr4, "오이도", {});
  eq(g?.[0].updnLine, "하행", `종착역 = 도착역 (${why})`);
  // 창동(116) 상행 목록의 '용산행'(135) — 창동에 안 오는 열차
  const yongsan = tr("1001", "상행", "용산행 - 방학방면", 1001000116, 1001000115, 1001000135, "120", "y");
  const dongducheon = tr("1001", "상행", "동두천행 - 방학방면", 1001000116, 1001000115, 1001000101, "120", "d");
  eq(dropShortTurn([yongsan, dongducheon], {}).map((a: A) => a.btrainNo), ["d"], "진행 방향 뒤쪽 종착(용산행) 제외");
  eq(dropShortTurn(arr, {}).length, 2, "2호선 순환 '성수행'은 그대로");
  eq(timedTrains([arr4[0], arr4[1]], now).length, 2, "도착 시간 같아도 정렬 OK");
});

Deno.test("남은 시간: barvlDt 0인 코레일 구간", () => {
  const k = { barvlDt: "0", arvlCd: "99", arvlMsg2: "[14]번째 전역 (안양)", recptnDt: "", ordkey: "01014청량리0" };
  ok(subwayEta(k, now) === 14 * SEC_PER_STATION && isRough(k), "[14]번째 전역 → 역 수 추정, '약'");
  eq(subwayEta({ ...k, arvlMsg2: "", ordkey: "02003용산0" }, now), 3 * SEC_PER_STATION, "ordkey로 역 수");
  eq(subwayEta({ ...k, arvlCd: "2", arvlMsg2: "서울 출발" }, now), null, "출발한 열차 제외");
  ok(!isRough({ ...k, barvlDt: "300" }), "barvlDt 있으면 '약' 없음");
  const stamp = new Date(now.getTime() + 9 * 3600e3 - 30e3).toISOString().slice(0, 19).replace("T", " ");   // 30초 전 KST
  eq(subwayEta({ barvlDt: "200", arvlCd: "99", recptnDt: stamp }, now), 170, "recptnDt 뒤 흐른 30초를 뺌");
});

// ---------- 버스 ----------
Deno.test("버스 도착 파싱", async () => {
  eq(busEta({ arrmsg1: "10분후[5번째 전]", traTime1: "592" }, 1, now), 592, "traTime1 초");
  eq(busEta({ arrmsg2: "곧 도착", traTime2: "110" }, 2, now), 110, "traTime2 / 곧 도착도 traTime 우선");
  eq(busEta({ arrmsg1: "곧 도착", traTime1: "0" }, 1, now), 30, "traTime 없고 곧 도착=30초");
  eq(busEta({ arrmsg1: "출발대기", exps1: "0" }, 1, now), null, "출발대기 제외");
  eq(busEta({ arrmsg1: "2분12초후[1번째 전]", exps1: "149" }, 1, now), 149, "exps1 초");
  eq(busEta({ arrmsg1: "3분5초후[2번째 전]", exps1: "0" }, 1, now), 185, "exps1 없으면 문구에서");
  const ents = [{ arsId: "11111", nxtStn: "상계주공7단지", rtNm: "1142" }, { arsId: "22222", nxtStn: "노원구청", rtNm: "1142" }];
  const [p] = await pickBusStop(ents, { kind: "bus", station_to: "노원구청" }, {});
  eq(p, [ents[1]], "길 건너 정류장 고르기 (다음 정류장)");
  eq(await busStopIds({ kind: "bus", station_from: "노원역 11234" }, {}), [["11234"]], "station_from 안의 arsId 사용");
});

// ---------- liveForSegment / liveChain (가짜 fetch) ----------
const NOWON = [tr("1004", "하행", "오이도행 - 창동방면", 1004000411, 1004000412, 1004000456, "200", "a"),     // 도보 5분이면 놓침
               tr("1004", "하행", "오이도행 - 창동방면", 1004000411, 1004000412, 1004000456, "400", "b"),
               tr("1004", "하행", "한성대입구행 - 창동방면", 1004000411, 1004000412, 1004000418, "500", "t"),   // 회차
               tr("1004", "하행", "오이도행 - 창동방면", 1004000411, 1004000412, 1004000456, "760", "c"),
               tr("1004", "하행", "오이도행 - 창동방면", 1004000411, 1004000412, 1004000456, "1200", "d"),
               tr("1004", "상행", "진접행 - 상계방면", 1004000411, 1004000410, 1004000405, "350", "u")];
const SADANG = [tr("1004", "하행", "오이도행 - 남태령방면", 1004000433, 1004000434, 1004000456)];

Deno.test("liveForSegment: 지하철 — 놓칠 열차·회차·반대 방향 빼고 지금부터 초로 2대", async () => {
  const env = fakeEnv(fakeFetch({ 노원: NOWON, 사당: SADANG }));
  const seg: Seg = { kind: "subway", station_from: "노원역", station_to: "사당역", line: "수도권 4호선" };
  eq(await liveForSegment(seg, 300, env), { line: "4호선", waits: [400, 760] });
  eq(await liveForSegment(seg, 1500, env), { line: "4호선", waits: [], note: "보이는 열차는 놓칠 듯 · 다음 열차 기준" });
  eq(liveLineText((await liveForSegment(seg, 300, env))!, 300), "4호선 1분·7분 뒤 도착", "watch.py와 같은 문구 (대기 = waits − readyInSec)");
  eq(await liveForSegment({ kind: "walk", expected_sec: 300 }, 0, env), null, "탈 구간 아니면 null");
  eq(await liveForSegment(seg, 0, { ...env, SUBWAY_KEY: "" }), { line: "4호선", waits: [], note: "실시간 키 없음" });
});

Deno.test("liveForSegment: 방향 미확정이면 방향별 ways, 이름 보정(이수 → 총신대입구(이수))", async () => {
  const isu = [tr("1007", "상행", "장암행 - 내방방면", 1007000736, 1007000735, 1007000709, "300", "x"),
               tr("1007", "하행", "석남행 - 남성방면", 1007000736, 1007000737, 1007000753, "500", "y")];
  const env = fakeEnv(fakeFetch({ "총신대입구(이수)": isu }));
  const live = await liveForSegment({ kind: "subway", station_from: "이수역", station_to: "없는역", line: "7호선" }, 0, env);
  eq(live, { line: "7호선", waits: [], note: "방향 미확정",
             ways: [{ line: "7호선 내방방면", waits: [300] }, { line: "7호선 남성방면", waits: [500] }] });
  eq(liveLineText(live!, 0), "7호선 내방방면 5분 뒤 도착 / 7호선 남성방면 8분 뒤");
});

Deno.test("liveForSegment: 실패하면 '실시간 조회 실패', 로그에 키가 안 남음", async () => {
  const logs: string[] = [];
  const env: Env = { SUBWAY_KEY: "SECRET-SUBWAY-KEY", BUS_KEY: "a%2Bb%3D", fetch: fakeFetch({}, {}, "connection refused"), now, log: (m) => logs.push(m) };
  eq(await liveForSegment({ kind: "subway", station_from: "노원", line: "4호선" }, 0, env), { line: "4호선", waits: [], note: "실시간 조회 실패" });
  eq(await liveForSegment({ kind: "bus", station_from: "11354", line: "1132" }, 0, env), { line: "1132번", waits: [], note: "실시간 조회 실패" });
  ok(logs.length === 2 && logs.every((l) => !l.includes("SECRET-SUBWAY-KEY") && !l.includes("a%2Bb%3D") && !l.includes("a+b=")), `키 가림: ${logs.join(" | ")}`);
  ok(redact("x/SECRET-SUBWAY-KEY/y?serviceKey=a%2Bb%3D&k=a+b=", env) === "x/***/y?serviceKey=***&k=***", "redact 인코딩·디코딩 둘 다");
});

// 경로 5 모양: 버스 1132(대기 428초=7분, 승차 509초) → 환승 도보 262초 → 노원역 = 428+509+262 = 1199초(20분) 뒤
// 대기를 안 더하면 771초(13분)로 보고 780초 열차를 고르게 된다 — 그 열차는 실제로 못 탄다.
const BUS_NOW = { rtNm: "1132", stNm: "중계주공10단지.중계건영3차아파트", arsId: "11354", adirection: "노원역",
                  traTime1: "428", arrmsg1: "7분후[6번째 전]", traTime2: "900", arrmsg2: "15분후[12번째 전]" };
const NOWON_CHAIN = [tr("1004", "하행", "오이도행 - 창동방면", 1004000411, 1004000412, 1004000456, "780", "13분"),
                     tr("1004", "하행", "사당행 - 창동방면", 1004000411, 1004000412, 1004000433, "1000", "회차"),
                     tr("1004", "하행", "오이도행 - 창동방면", 1004000411, 1004000412, 1004000456, "1230", "20분"),
                     tr("1004", "하행", "오이도행 - 창동방면", 1004000411, 1004000412, 1004000456, "1500", "25분")];
const SEONBAWI = [tr("1004", "하행", "오이도행 - 경마공원방면", 1004000435, 1004000436, 1004000456)];
const ROUTE5: Seg[] = [
  { kind: "bus", station_from: "11354", station_to: "11213", line: "1132 (중계주공10단지.중계건영3차아파트→와우패션클럽)", expected_sec: 509 },
  { kind: "transfer", station_from: "와우패션클럽", station_to: "노원", expected_sec: 262 },
  { kind: "subway", station_from: "노원", station_to: "선바위", line: "4호선", expected_sec: 3240 },
  { kind: "transfer", station_from: "선바위", station_to: "선바위역2번출구(광역)", expected_sec: 214 },
  { kind: "bus", station_from: "21137", station_to: "연세대", line: "9201 (선바위역2번출구(광역)→연세대)", expected_sec: 2753 },
];

Deno.test("liveChain: 앞 구간 대기 7분을 누적 → 13분 열차는 못 타고 20분 열차부터", async () => {
  const env = fakeEnv(fakeFetch({ 노원: NOWON_CHAIN, 선바위: SEONBAWI }, { "11354": [BUS_NOW] }));
  const items = await liveChain(ROUTE5, 0, 0, env);
  eq(items.map((i) => [i.index, i.kind, i.line, i.waits, i.readyInSec]),
     [[0, "bus", "1132번", [428, 900], 0], [2, "subway", "4호선", [1230, 1500], 1199]]);
  eq(items[1].chain, "정류장까지 도보 0분 + 버스 대기 7분 + 승차 8분 + 환승 도보 4분 = 노원역 20분 뒤");
  eq(liveText(items), "🚌 지금 출발하면: 1132번 7분·15분 뒤 도착 / 4호선 1분 미만·5분 뒤", "watch.py live 문구와 같음");
  eq(items.length, 2, "9201번은 30분 밖이라 멈춤");
});

Deno.test("liveChain: 첫 버스를 못 정하면 뒤 구간은 도착 시각을 몰라 생략", async () => {
  const off = { ...BUS_NOW, traTime1: "0", arrmsg1: "운행종료", traTime2: "0", arrmsg2: "운행종료" };
  const items = await liveChain(ROUTE5, 0, 0, fakeEnv(fakeFetch({ 노원: NOWON_CHAIN, 선바위: SEONBAWI }, { "11354": [off] })));
  eq(items.map((i) => [i.line, i.note]), [["1132번", "운행종료"]]);
  eq(liveText(items), "🚌 지금 출발하면: 1132번 운행종료");
});

Deno.test("liveChain: fromIndex·walkSec — 이동 중 (노원역까지 2분 남음)", async () => {
  const items: ChainItem[] = await liveChain(ROUTE5, 2, 120, fakeEnv(fakeFetch({ 노원: NOWON_CHAIN, 선바위: SEONBAWI })));
  eq(items.map((i) => [i.index, i.waits, i.readyInSec, i.chain]), [[2, [780, 1230], 120, "역까지 도보 2분 = 노원역 2분 뒤"]]);
  eq(await liveChain([{ kind: "walk", expected_sec: 600 }], 0, 0, fakeEnv(fakeFetch({}))), [], "탈 구간 없으면 빈 목록");
});

// ---------- 개인 첫 도보 (test_watch.py와 같은 케이스) ----------
const wt = (minutes: number, daysAgo = 1, excluded?: boolean, platform = true): TripRow => {
  const st = now.getTime() - daysAgo * 86400e3;
  return { started_at: new Date(st).toISOString(), platform_at: platform ? new Date(st + minutes * 60e3).toISOString() : null,
           ...(excluded === undefined ? {} : { excluded }) };
};
const NOISE = [wt(9, 1, true), wt(4, 61), wt(45), wt(0.5), wt(6, 1, undefined, false)];
const WALK_SUB: Seg[] = [{ kind: "walk", expected_sec: 600 }, { kind: "subway", station_from: "노원역", station_to: "사당역", line: "4호선" }];

Deno.test("개인 첫 도보: started_at→platform_at 중앙값 (최근 60일, excluded 제외, 1~40분, 3회 이상)", () => {
  eq(personalWalkSec([wt(5), wt(7), wt(6, 1, false), ...NOISE], now), 360, "중앙값 6분 (제외·61일 전·45분·30초·platform_at 없음은 뺌)");
  eq(personalWalkSec([wt(5), wt(7), ...NOISE], now), null, "쓸 기록 2회면 null");
  eq(personalWalkSec([wt(5), wt(6), wt(7), wt(8)], now), 390, "짝수 개면 가운데 둘 평균");
  eq(personalWalkSec([wt(1), wt(40), wt(40)], now), 2400, "1분·40분 경계 포함");
  const r = { started_at: "2026-10-30T08:00:00.12345+00:00", platform_at: "2026-10-30T08:05:00.5+00:00" };
  eq(personalWalkSec([r, r, r], new Date("2026-11-01T00:00:00Z")), 300, "소수 초 5자리 시각도 읽음");
  eq(firstWalkSec(WALK_SUB, [wt(5), wt(5), wt(5)], now), { sec: 300, n: 3, personal: true }, "개인값 있으면 그것");
  eq(firstWalkSec(WALK_SUB, [wt(5)], now), { sec: 600, n: 1, personal: false }, "기록 부족하면 segments expected_sec");
  eq(firstWalkSec(ROUTE5, null, now), { sec: 0, n: 0, personal: false }, "첫 구간이 버스면 구간 예상 0");
});

Deno.test("liveChain: 개인 첫 도보 — 10분 예상 대신 내 기록 5분이면 400초 열차부터, 버스로 시작해도 반영", async () => {
  const env = fakeEnv(fakeFetch({ 노원: NOWON, 사당: SADANG }));
  const base = await liveChain(WALK_SUB, 0, 0, env);
  const mine = await liveChain(WALK_SUB, 0, 0, env, { trips: [wt(5), wt(4), wt(6), ...NOISE] });
  const few = await liveChain(WALK_SUB, 0, 0, env, { trips: [wt(5), wt(4)] });
  eq([base[0].readyInSec, base[0].waits], [600, [760, 1200]], "구간 예상 10분");
  eq([mine[0].readyInSec, mine[0].waits, mine[0].chain], [300, [400, 760], "역까지 도보 5분 = 노원역 5분 뒤"], "내 기록 5분");
  eq(liveText(mine), "🚇 지금 출발하면: 4호선 1분·7분 뒤 도착", "watch.py와 같은 문구");
  eq(few[0].readyInSec, 600, "기록 2회면 segments expected_sec");
  const moving = await liveChain(WALK_SUB, 1, 120, env, { trips: [wt(5), wt(5), wt(5)] });
  eq(moving[0].readyInSec, 120, "fromIndex가 첫 승차 구간이면(이동 중) trips 무시, walkSec 그대로");
  const r5 = await liveChain(ROUTE5, 0, 0, fakeEnv(fakeFetch({ 노원: NOWON_CHAIN, 선바위: SEONBAWI }, { "11354": [BUS_NOW] })), { trips: [wt(2), wt(2), wt(2)] });
  eq(r5.map((i) => [i.index, i.readyInSec, i.waits]), [[0, 120, [428, 900]], [2, 1199, [1230, 1500]]], "버스로 시작: 정류장까지 2분, 노원역은 그대로 20분 뒤");
  eq(liveText(r5), "🚌 지금 출발하면: 1132번 5분·13분 뒤 도착 / 4호선 1분 미만·5분 뒤", "test_watch.py와 같은 문구");
});

// ---------- boardingVehicle / rideEta (가짜 fetch) ----------
const SEG_NS: Seg = { kind: "subway", station_from: "노원역", station_to: "사당역", line: "수도권 4호선" };

Deno.test("boardingVehicle: 지하철 — 도착 중이거나 가장 먼저 오는 열차 (반대 방향·회차·떠난 열차 제외)", async () => {
  eq(await boardingVehicle(SEG_NS, fakeEnv(fakeFetch({ 노원: NOWON, 사당: SADANG }))), { trainNo: "a" }, "가장 먼저 오는 200초 열차");
  const arriving = { ...tr("1004", "하행", "오이도행 - 창동방면", 1004000411, 1004000412, 1004000456, "0", "now"), arvlCd: "1", arvlMsg2: "노원 도착" };
  const gone = { ...tr("1004", "하행", "오이도행 - 창동방면", 1004000411, 1004000412, 1004000456, "0", "gone"), arvlCd: "2", arvlMsg2: "노원 출발" };
  eq(await boardingVehicle(SEG_NS, fakeEnv(fakeFetch({ 노원: [gone, ...NOWON, arriving], 사당: SADANG }))), { trainNo: "now" }, "지금 도착 중(떠난 열차 말고)");
  const tricky = [tr("1004", "상행", "진접행 - 상계방면", 1004000411, 1004000410, 1004000405, "50", "반대"),
                  tr("1004", "하행", "한성대입구행 - 창동방면", 1004000411, 1004000412, 1004000418, "100", "회차"),
                  tr("1004", "하행", "오이도행 - 창동방면", 1004000411, 1004000412, 1004000456, "760", "c")];
  eq(await boardingVehicle(SEG_NS, fakeEnv(fakeFetch({ 노원: tricky, 사당: SADANG }))), { trainNo: "c" }, "반대 방향·회차 열차는 안 고름");
  const isu = [tr("1007", "상행", "장암행 - 내방방면", 1007000736, 1007000735, 1007000709, "300", "x"),
               tr("1007", "하행", "석남행 - 남성방면", 1007000736, 1007000737, 1007000753, "500", "y")];
  eq(await boardingVehicle({ kind: "subway", station_from: "이수역", station_to: "없는역", line: "7호선" }, fakeEnv(fakeFetch({ "총신대입구(이수)": isu }))), {}, "방향 미확정이면 {}");
  eq(await boardingVehicle({ kind: "walk", expected_sec: 60 }, fakeEnv(fakeFetch({}))), {}, "탈 구간 아니면 {}");
  eq(await boardingVehicle(SEG_NS, { ...fakeEnv(fakeFetch({ 노원: NOWON })), SUBWAY_KEY: "" }), {}, "키 없으면 {}");
});

const BUS_V = { ...BUS_NOW, vehId1: "v1", vehId2: "v2" };   // 1132번: v1 428초, v2 900초 뒤
Deno.test("boardingVehicle: 버스 — 가장 먼저 오는 차의 vehId", async () => {
  eq(await boardingVehicle(ROUTE5[0], fakeEnv(fakeFetch({}, { "11354": [BUS_V] }))), { vehId: "v1" });
  const soon = { ...BUS_V, traTime1: "0", arrmsg1: "곧 도착" };
  eq(await boardingVehicle(ROUTE5[0], fakeEnv(fakeFetch({}, { "11354": [soon] }))), { vehId: "v1" }, "곧 도착(traTime 0)도 지금 오는 차");
  const other = { rtNm: "1130", stNm: BUS_NOW.stNm, arsId: "11354", traTime1: "100", arrmsg1: "2분후", vehId1: "w1", vehId2: "0" };
  eq(await boardingVehicle({ kind: "bus", station_from: "11354", station_to: "11213", line: null }, fakeEnv(fakeFetch({}, { "11354": [BUS_V, other] }))),
     { vehId: "w1" }, "노선을 모르면 그 정류장에서 제일 먼저 오는 버스");
  eq(await boardingVehicle(ROUTE5[0], fakeEnv(fakeFetch({}, { "11354": [{ ...BUS_V, traTime1: "0", arrmsg1: "운행종료", traTime2: "0", arrmsg2: "운행종료" }] }))), {}, "운행종료면 {}");
});

Deno.test("rideEta: 지하철 — 하차역 도착 목록에서 같은 열차 번호의 barvlDt", async () => {
  const sadang = [tr("1004", "하행", "오이도행 - 남태령방면", 1004000433, 1004000434, 1004000456, "300", "x"),
                  tr("1004", "하행", "오이도행 - 남태령방면", 1004000433, 1004000434, 1004000456, "1500", "447"),
                  tr("1004", "상행", "진접행 - 총신대입구(이수)방면", 1004000433, 1004000432, 1004000405, "200", "9999")];
  const env = fakeEnv(fakeFetch({ 사당: sadang }));
  eq(await rideEta(SEG_NS, { trainNo: "447" }, env), { etaSec: 1500, source: "live" });
  eq(await rideEta(SEG_NS, { trainNo: "0447" }, env), { etaSec: 1500, source: "live" }, "앞자리 0 무시");
  eq(await rideEta(SEG_NS, { trainNo: "1234" }, env), { etaSec: null, source: "none" }, "안 보이면 none");
  eq(await rideEta(SEG_NS, { vehId: "447" }, env), { etaSec: null, source: "none" }, "지하철에 trainNo 없으면 none");
  eq(await rideEta({ ...SEG_NS, station_to: null }, { trainNo: "447" }, env), { etaSec: null, source: "none" }, "하차역 없으면 none");
  const passed = { ...sadang[1], barvlDt: "0", arvlCd: "2", arvlMsg2: "사당 출발" };
  eq(await rideEta(SEG_NS, { trainNo: "447" }, fakeEnv(fakeFetch({ 사당: [passed] }))), { etaSec: 0, source: "live" }, "하차역을 이미 지났으면 0");
  const korail = { ...sadang[1], barvlDt: "0", arvlCd: "99", arvlMsg2: "[3]번째 전역 (이촌)" };
  eq(await rideEta(SEG_NS, { trainNo: "447" }, fakeEnv(fakeFetch({ 사당: [korail] }))), { etaSec: 3 * SEC_PER_STATION, source: "live", rough: true }, "barvlDt 0이면 역 수로 추정, rough");
});

Deno.test("rideEta: 버스 — 하차 정류장에서 같은 노선·같은 vehId의 traTime", async () => {
  const alight = [{ rtNm: "1130", arsId: "11213", vehId1: "v1", traTime1: "5", arrmsg1: "곧 도착" },              // 다른 노선은 안 봄
                  { rtNm: "1132", arsId: "11213", vehId1: "x9", traTime1: "60", arrmsg1: "1분후[1번째 전]", vehId2: "v1", traTime2: "509", arrmsg2: "8분후[5번째 전]" }];
  const env = fakeEnv(fakeFetch({}, { "11213": alight }, "", { 와우패션클럽: [{ arsId: "11213", stNm: "와우패션클럽" }] }));
  eq(await rideEta(ROUTE5[0], { vehId: "v1" }, env), { etaSec: 509, source: "live" }, "traTime2 = 509초");
  eq(await rideEta(ROUTE5[0], { vehId: "x9" }, env), { etaSec: 60, source: "live" }, "traTime1");
  eq(await rideEta(ROUTE5[0], { vehId: "zz" }, env), { etaSec: null, source: "none" }, "안 보이면 none");
  eq(await rideEta({ ...ROUTE5[0], station_to: "와우패션클럽" }, { vehId: "v1" }, env), { etaSec: 509, source: "live" }, "하차 정류장이 이름이어도 찾음");
  eq(await rideEta(ROUTE5[0], { trainNo: "v1" }, env), { etaSec: null, source: "none" }, "버스에 vehId 없으면 none");
  // 탈 때 정한 차를 그대로 하차 지점에서 따라감 (boardingVehicle → rideEta)
  const env2 = fakeEnv(fakeFetch({}, { "11354": [BUS_V], "11213": alight.map((a) => ({ ...a })) }));
  const ride = await boardingVehicle(ROUTE5[0], env2);
  eq([ride, await rideEta(ROUTE5[0], ride, env2)], [{ vehId: "v1" }, { etaSec: 509, source: "live" }], "boardingVehicle → rideEta");
});

Deno.test("boardingVehicle·rideEta: 실패하면 {}·none, 로그에 키가 안 남음", async () => {
  const logs: string[] = [];
  const env: Env = { SUBWAY_KEY: "SECRET-SUBWAY-KEY", BUS_KEY: "a%2Bb%3D", fetch: fakeFetch({}, {}, "connection refused"), now, log: (m) => logs.push(m) };
  eq(await boardingVehicle(SEG_NS, env), {});
  eq(await boardingVehicle(ROUTE5[0], env), {});
  eq(await rideEta(SEG_NS, { trainNo: "447" }, env), { etaSec: null, source: "none" });
  eq(await rideEta(ROUTE5[0], { vehId: "v1" }, env), { etaSec: null, source: "none" });
  ok(logs.length === 4 && logs.every((l) => !l.includes("SECRET-SUBWAY-KEY") && !l.includes("a%2Bb%3D") && !l.includes("a+b=")), `키 가림: ${logs.join(" | ")}`);
});

// ---------- 실제 API (키가 있을 때만) ----------
async function realEnv(): Promise<Env> {
  const env: Env = { SUBWAY_KEY: Deno.env.get("SUBWAY_KEY") ?? "", BUS_KEY: Deno.env.get("BUS_KEY") ?? "", log: quiet };
  try {
    const here = new URL("../../../.env.local", import.meta.url);
    for (const line of (await Deno.readTextFile(here)).split("\n")) {
      const m = /^\s*(SUBWAY_KEY|BUS_KEY)\s*=\s*(.*?)\s*$/.exec(line);
      if (m && !env[m[1] as "SUBWAY_KEY" | "BUS_KEY"]) env[m[1] as "SUBWAY_KEY" | "BUS_KEY"] = m[2].replace(/^["']|["']$/g, "");
    }
  } catch { /* .env.local 없음 */ }
  return env;
}
const REAL = await realEnv();
const W = (s: number): Seg => ({ kind: "walk", expected_sec: s });
const S = (a: string, b: string, line: string | null, sec = 600, updn: string | null = null): Seg =>
  ({ kind: "subway", station_from: a, station_to: b, line, updn, expected_sec: sec });
const B = (a: string, b: string, line: string, sec = 600): Seg => ({ kind: "bus", station_from: a, station_to: b, line, expected_sec: sec });

Deno.test({ name: "실제 API: 버스 정류장 후보 ('노원역' → 정확 11831·11832, 나머지에 11211·11210)", ignore: !REAL.BUS_KEY, fn: async () => {
  const g = await busStopIds({ kind: "bus", station_from: "노원역" }, REAL);
  ok(new Set(g[0]).size === 2 && g[0].includes("11831") && g[0].includes("11832") && g[1].includes("11211") && g[1].includes("11210"), JSON.stringify(g));
  ok((await busStopIds({ kind: "bus", station_from: "노원역1번출구" }, REAL))[0].includes("11211"), "'노원역1번출구' = 11211");
} });

Deno.test({ name: "실제 API: 경로별 live 문구 (결과는 시각마다 다름 — 실패 없이 돌고 노선 이름이 맞는지만)", ignore: !REAL.SUBWAY_KEY || !REAL.BUS_KEY, fn: async () => {
  const cases: [string, Seg[], string][] = [
    ["4호선 노원→사당 (방향 없음)", [W(300), S("노원역", "사당역", "4호선")], "4호선"],
    ["2호선 성수→강남 (순환)", [W(180), S("성수역", "강남역", "2호선")], "2호선"],
    ["7호선 이수역→노원 (이름 보정)", [W(0), S("이수역", "노원역", "7호선")], "7호선"],
    ["1호선 서울역→시청", [W(120), S("서울역", "시청역", "1호선")], "1호선"],
    ["노선명 없음 노원→사당", [W(300), S("노원역", "사당역", null)], "4호선"],
    ["저장된 방향 상행", [W(300), S("노원역", "사당역", "4호선", 600, "상행")], "4호선"],
    ["버스 (arsId 11211)", [W(300), B("11211", "상계2동주민센터", "1142")], "1142번"],
    ["버스 (이름 노원역1번출구)", [W(300), B("노원역1번출구", "상계2동주민센터", "1142")], "1142번"],
    ["경로 5 (버스 → 노원 4호선 체인)", ROUTE5, "1132번"],
  ];
  for (const [name, segs, line] of cases) {
    const items = await liveChain(segs, 0, 0, REAL);
    console.log(`  ${name}\n     >> ${liveText(items)}${items[1] ? `\n     체인: ${items[1].chain}` : ""}`);
    ok(items.length >= 1 && items[0].line.startsWith(line), `${name}: ${JSON.stringify(items[0])}`);
    ok(items[0].note !== "실시간 조회 실패", `${name}: 조회 실패`);
  }
} });

Deno.test({ name: "실제 API: 탈 차 정하고 하차 지점 도착 예상 (시각마다 다름 — 실패 없이 도는지만)", ignore: !REAL.SUBWAY_KEY || !REAL.BUS_KEY, fn: async () => {
  const cases: [string, Seg][] = [
    ["4호선 노원→창동 (한 정거장)", S("노원역", "창동역", "4호선")],
    ["4호선 노원→사당 (멀어서 none일 수 있음)", S("노원역", "사당역", "4호선")],
    ["버스 1132 11354→11212", B("11354", "11212", "1132 (중계주공10단지.중계건영3차아파트→롯데백화점노원점.노원역4번출구)")],
  ];
  for (const [name, seg] of cases) {
    const ride = await boardingVehicle(seg, REAL);
    const eta = await rideEta(seg, ride, REAL);
    console.log(`  ${name}: 탈 차 ${JSON.stringify(ride)} → 하차 지점 ${JSON.stringify(eta)}`);
    ok(eta.source === "none" ? eta.etaSec === null : (eta.etaSec ?? -1) >= 0, `${name}: ${JSON.stringify(eta)}`);
  }
} });
