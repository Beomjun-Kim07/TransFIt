# watch.py 함수 시험 — 텔레그램은 보내지 않는다. 실행: python3 test_watch.py
# 앞부분은 가짜 데이터 단위 시험, 뒷부분은 실제 실시간 API(지하철·버스) 호출. 키는 .env.local에서 읽고 출력하지 않는다.
import sys, os
HERE = os.path.dirname(os.path.abspath(__file__))
os.chdir(HERE)                      # watch.py가 .env.local을 현재 폴더에서 읽는다
sys.path.insert(0, HERE)
import watch as w
from datetime import datetime

now = datetime.now(w.KST)
ok = lambda c, msg: print(("  OK  " if c else "  FAIL") + " " + msg)

print("== 순수 함수")
ok(w.norm_station("노원역") == "노원", "노원역→노원")
ok(w.norm_station("강남역(2호선)") == "강남", "강남역(2호선)→강남")
ok(w.norm_station("서울역 1호선") == "서울", "서울역 1호선→서울")
ok(w.norm_station("총신대입구(이수)역") == "총신대입구(이수)", "총신대입구(이수)역")
ok(w.same_station("이수", "총신대입구(이수)") and w.same_station("신촌", "신촌(경의중앙선)") and not w.same_station("노원", "창동"), "same_station")
ok(w.line_id("수도권 4호선") == "1004" and w.line_id("신분당선") == "1077" and w.line_id("경의중앙선") == "1063" and w.line_id("") == "", "line_id")
ok(w.id_dist("1002", 1002000243, 1002000201) == 1 and w.id_dist("1002", 1002000211, 1002000222) == 11, "2호선 순환 거리")
ok(w.route_match("146", "간선 146") and w.route_match("146", "146번") and not w.route_match("1460", "146"), "route_match")

print("== 소요시간: excluded 기록 제외")
def trip(minutes, excluded=None):
    t = {"started_at": "2026-10-30T08:00:00+09:00", "ended_at": f"2026-10-30T{8 + minutes // 60:02d}:{minutes % 60:02d}:00+09:00"}
    if excluded is not None:
        t["excluded"] = excluded
    return t
route = {"confidence": 90, "baseline_sec": 3000, "fallback_min": 40}
five = [trip(40), trip(42), trip(45, False), trip(41), trip(43)]
q90 = int(w.quantile([m * 60 for m in (40, 42, 45, 41, 43)], 0.9))
sec, why = w.estimate_duration(route, [], five + [trip(110, True)])     # 110분 지연 기록은 뺀 것
ok(sec == q90 and "5회" in why, f"excluded=true 행 제외 → {sec // 60}분 ({why})")
sec, why = w.estimate_duration(route, [], five[:4] + [trip(43, True)])  # 정상 4회 + 제외 1회 → 기록 부족
ok(sec == 3000 and why == "카카오 예상 기준(기록 쌓이면 바뀜)", f"제외하면 4회라 기준값 사용 ({why})")
ok(w.estimate_duration(route, [], five)[0] == q90, "excluded 키가 없는 행(컬럼 없음)·false는 그대로 사용")
ok(len(w.usable_durations([{"started_at": "2026-10-30T08:00:00.12345+00:00", "ended_at": "2026-10-30T08:40:00.5+00:00"}])) == 1,
   "소수 초 5자리 시각도 읽음 (파이썬 3.9)")

print("== pre 알림 문구")
same25 = [dict(trip(25), started_at=f"2026-10-{d:02d}T08:00:00+09:00", ended_at=f"2026-10-{d:02d}T08:25:00+09:00") for d in range(20, 26)]
r_eve = {"confidence": 90, "baseline_sec": None, "fallback_min": 40, "arrive_by": "21:50:00"}
segs = [{"kind": "walk", "expected_sec": 420, "distance_m": 430},
        {"kind": "subway", "station_from": "노원역", "station_to": "사당역", "line": "수도권 4호선"},
        {"kind": "transfer", "expected_sec": 120},
        {"kind": "bus", "station_from": "11234", "station_to": "21345", "line": "472 (사당역→서울대입구역)"},
        {"kind": "walk", "expected_sec": None, "distance_m": 185},      # 거리만 → 3.7km/h로 3분
        {"kind": "walk", "expected_sec": 0}]                            # 0분 도보는 요약에서 뺀다
arrive, depart, mins, why = w.plan(r_eve, segs, same25, now.date())
txt = w.pre_text(arrive, depart, mins, why, segs).split("\n")
print("   " + "\n   ".join(txt))
ok(txt[0] == "🚶 21:50 도착하려면 21:25에 출발하세요", "첫 줄: 도착·출발 시각")
ok(txt[1] == "예상 25분 · 내 기록 6회 90% 기준", "둘째 줄: 내 기록 기준")
ok(txt[2] == "도보 7분 → 4호선 노원→사당 → 환승 → 472번 사당역→서울대입구역 → 도보 3분", "셋째 줄: 구간 요약")
a2, d2, m2, why2 = w.plan(dict(r_eve, baseline_sec=1501), segs, [], now.date())   # 25분 1초 → 26분으로 올림
ok(w.pre_text(a2, d2, m2, why2, []) == "🚶 21:50 도착하려면 21:24에 출발하세요\n예상 26분 · 카카오 예상 기준(기록 쌓이면 바뀜)",
   "기록 부족: 카카오 기준, 분 올림이라 출발과 예상 분이 맞음, 구간 없으면 둘째 줄까지")
ok(w.seg_summary({"kind": "bus", "station_from": "노원역 11234", "station_to": "노원구청", "line": "1142"}) == "1142번 노원역→노원구청"
   and w.seg_summary({"kind": "subway", "station_from": "강남역(2호선)", "station_to": None, "line": None}) == "지하철 강남"
   and w.line_label("인천1호선") == "인천1호선" and w.line_label("", "1004") == "4호선", "구간 요약: 괄호 없는 버스·노선명 없는 지하철")

print("== live 알림 문구")
S_ = lambda label, waits, rough=False: w.live_item("subway", label, waits, rough)
B_ = lambda label, waits: w.live_item("bus", label, waits)
ok(w.live_text([S_("4호선", [180, 540]), B_("472번", [300])]) == "🚇 지금 출발하면: 4호선 3분·9분 뒤 도착 / 472번 5분 뒤", "예시 문구 그대로")
ok(w.live_text([B_("1142번", [45, 700])]) == "🚌 지금 출발하면: 1142번 1분 미만·11분 뒤 도착", "버스가 먼저면 🚌")
ok(w.live_text([S_("1호선", [240], True), w.live_item("bus", "472번", note="운행종료")]) == "🚇 지금 출발하면: 1호선 약 4분 뒤 도착 / 472번 운행종료",
   "추정 시간은 '약', 대기 대신 상태")
ok(w.live_text([]) == "🚶 지금 출발하세요 (실시간 정보 없음)", "실시간 항목 없음")

print("== 텔레그램 버튼 (실제로 보내지 않음)")
import json
sent = []
class FakeResp:
    def raise_for_status(self): pass
    def json(self): return {"ok": True, "result": {}}
real_post = w.requests.post
w.requests.post = lambda url, data=None, timeout=None: (sent.append(data), FakeResp())[1]
try:
    w.send_pre("1", 7, "\n".join(txt))
    w.send_live("1", "🚇 지금 출발하면: 4호선 3분·9분 뒤 도착")
finally:
    w.requests.post = real_post
pre, live = sent
kb = json.loads(pre["reply_markup"])["inline_keyboard"] if "reply_markup" in pre else []
ok(kb == [[{"text": "출발했어요", "callback_data": "trip:start:7"}]], f"pre 알림 버튼 = {kb}")
ok(pre["text"] == "\n".join(txt), "pre 본문 그대로")
ok("reply_markup" not in live and live["text"].startswith("🚇 지금 출발하면"), "live 알림엔 버튼 없음")
ok(len(f"trip:start:{2**31 - 1}".encode()) <= 64, "callback_data 64바이트 제한 안")

print("== 방향 판정 (가짜 데이터)")
def tr(sid, upd, tln, cur, nxt, term, bar="120", no="1"):
    return dict(subwayId=sid, updnLine=upd, trainLineNm=tln, statnId=str(cur), statnTid=str(nxt), bstatnId=str(term),
                bstatnNm=tln.split("행")[0], barvlDt=bar, arvlCd="99", arvlMsg2="", btrainNo=no, recptnDt="")
# 2호선 건대입구(212)에서 양쪽 다 '성수행' → 2단계 통과 못 하고 ID로: 성수(211)는 외선
arr = [tr("1002", "외선", "성수행 - 성수방면", 1002000212, 1002000211, 1002000211),
       tr("1002", "내선", "성수행 - 구의방면", 1002000212, 1002000213, 1002000211)]
g, why = w.pick_direction(arr, "뚝섬", {"1002": 1002000210})
ok(g and g[0]["updnLine"] == "외선", f"건대입구→뚝섬 = 외선 ({why})")
g, why = w.pick_direction(arr, "성수", {"1002": 1002000211})
ok(g and g[0]["updnLine"] == "외선" and "방면" in why, f"건대입구→성수 = 외선 ({why})")
g, why = w.pick_direction(arr, "강남", {"1002": 1002000222})
ok(g and g[0]["updnLine"] == "내선", f"건대입구→강남 = 내선 ({why})")
g, why = w.pick_direction(arr, "강남", {})
ok(g is None, f"도착역 ID 없으면 미확정 ({why})")
# 4호선 노원(411)→사당(433) 하행, 한성대입구(418)행은 회차라 빠져야
arr4 = [tr("1004", "하행", "오이도행 - 창동방면", 1004000411, 1004000412, 1004000456, no="a"),
        tr("1004", "하행", "한성대입구행 - 창동방면", 1004000411, 1004000412, 1004000418, no="b"),
        tr("1004", "상행", "진접행 - 상계방면", 1004000411, 1004000410, 1004000405, no="c")]
g, why = w.pick_direction(arr4, "사당", {"1004": 1004000433})
ok(g and {a["updnLine"] for a in g} == {"하행"}, f"노원→사당 = 하행 ({why})")
kept = w.drop_short_turn(g, {"1004": 1004000433})
ok([a["btrainNo"] for a in kept] == ["a"], "한성대입구행(회차) 제외")
kept = w.drop_short_turn(g, {"1004": 1004000415})
ok(len(kept) == 2, "도착역이 회차역 앞이면 둘 다 유지")
g, why = w.pick_direction(arr4, "오이도", {})
ok(g and g[0]["updnLine"] == "하행", f"종착역 = 도착역 ({why})")
# 창동(116) 상행(다음 115) 목록의 '용산행'(135) — 창동에 안 오는 열차
yongsan = tr("1001", "상행", "용산행 - 방학방면", 1001000116, 1001000115, 1001000135, no="y")
dongducheon = tr("1001", "상행", "동두천행 - 방학방면", 1001000116, 1001000115, 1001000101, no="d")
ok([a["btrainNo"] for a in w.drop_short_turn([yongsan, dongducheon], {})] == ["d"], "진행 방향 뒤쪽 종착(용산행) 제외")
ok(len(w.drop_short_turn(arr, {})) == 2, "2호선 순환 '성수행'은 그대로")
# 남은 시간: 코레일 구간 '[N]번째 전역'
k = dict(barvlDt="0", arvlCd="99", arvlMsg2="[14]번째 전역 (안양)", recptnDt="", ordkey="01014청량리0")
ok(w.subway_eta(k, now) == 14 * w.SEC_PER_STATION and w.is_rough(k), "[14]번째 전역 → 역 수 추정, '약' 표시")
ok(w.subway_eta(dict(k, arvlMsg2="", ordkey="02003용산0"), now) == 3 * w.SEC_PER_STATION, "ordkey로 역 수")
ok(w.subway_eta(dict(k, arvlCd="2", arvlMsg2="서울 출발"), now) is None, "출발한 열차 제외")
ok(not w.is_rough(dict(k, barvlDt="300")), "barvlDt 있으면 '약' 없음")
# 같은 도착 시간 열차 둘 → 정렬 오류 없어야
ok(len(w.timed_trains([arr4[0], arr4[1]], now)) == 2, "도착 시간 같아도 정렬 OK")

print("== live 항목 만들기 (가짜 도착 목록, 네트워크 없음)")
fake = {"노원": [tr("1004", "하행", "오이도행 - 창동방면", 1004000411, 1004000412, 1004000456, bar="200", no="a"),   # 도보 5분이라 놓침
                 tr("1004", "하행", "오이도행 - 창동방면", 1004000411, 1004000412, 1004000456, bar="400", no="b"),
                 tr("1004", "하행", "한성대입구행 - 창동방면", 1004000411, 1004000412, 1004000418, bar="500", no="t"),  # 회차
                 tr("1004", "하행", "오이도행 - 창동방면", 1004000411, 1004000412, 1004000456, bar="760", no="c"),
                 tr("1004", "하행", "오이도행 - 창동방면", 1004000411, 1004000412, 1004000456, bar="1200", no="d"),
                 tr("1004", "상행", "진접행 - 상계방면", 1004000411, 1004000410, 1004000405, bar="350", no="u")],
        "사당": [tr("1004", "하행", "오이도행 - 남태령방면", 1004000433, 1004000434, 1004000456)]}
real_fetch, real_key = w.fetch_arrivals, w.SUBWAY_KEY
w.fetch_arrivals, w.SUBWAY_KEY = (lambda st: fake.get(st, [])), (w.SUBWAY_KEY or "x")
try:
    items = w.live_lines([{"kind": "walk", "expected_sec": 300},
                          {"kind": "subway", "station_from": "노원역", "station_to": "사당역", "line": "수도권 4호선"}], now)
    late = w.live_lines([{"kind": "walk", "expected_sec": 1500},
                         {"kind": "subway", "station_from": "노원역", "station_to": "사당역", "line": "4호선"}], now)
finally:
    w.fetch_arrivals, w.SUBWAY_KEY = real_fetch, real_key
ok(w.live_text(items) == "🚇 지금 출발하면: 4호선 1분·7분 뒤 도착", f"놓칠 열차·회차·반대 방향 빼고 2대 ({w.live_text(items)})")
ok(w.live_text(late) == "🚇 지금 출발하면: 4호선 보이는 열차는 놓칠 듯 · 다음 열차 기준", "보이는 열차를 다 놓칠 때")

print("== 환승 체인: 앞 구간 대기 시간을 다음 승차 시각에 누적 (가짜 버스·지하철)")
# 경로 5 모양: 버스 1132(대기 428초=7분, 승차 509초) → 환승 도보 262초 → 노원역 = 428+509+262 = 1199초(20분) 뒤
# 대기를 안 더하면 771초(13분) 뒤로 보고 780초(13분) 열차를 고르게 된다 — 그 열차는 실제로 못 탄다.
bus_now = {"rtNm": "1132", "stNm": "중계주공10단지.중계건영3차아파트", "arsId": "11354", "adirection": "노원역",
           "traTime1": "428", "arrmsg1": "7분후[6번째 전]", "traTime2": "900", "arrmsg2": "15분후[12번째 전]"}
fake_bus = {"11354": [bus_now]}
fake = {"노원": [tr("1004", "하행", "오이도행 - 창동방면", 1004000411, 1004000412, 1004000456, bar="780", no="13분"),
                 tr("1004", "하행", "사당행 - 창동방면", 1004000411, 1004000412, 1004000433, bar="1000", no="회차"),
                 tr("1004", "하행", "오이도행 - 창동방면", 1004000411, 1004000412, 1004000456, bar="1230", no="20분"),
                 tr("1004", "하행", "오이도행 - 창동방면", 1004000411, 1004000412, 1004000456, bar="1500", no="25분")],
        "선바위": [tr("1004", "하행", "오이도행 - 경마공원방면", 1004000435, 1004000436, 1004000456)]}
route5 = [{"kind": "bus", "station_from": "11354", "station_to": "11213", "line": "1132 (중계주공10단지.중계건영3차아파트→와우패션클럽)", "expected_sec": 509},
          {"kind": "transfer", "station_from": "와우패션클럽", "station_to": "노원", "expected_sec": 262},
          {"kind": "subway", "station_from": "노원", "station_to": "선바위", "line": "4호선", "expected_sec": 3240}]
real = (w.fetch_arrivals, w.bus_get, w.SUBWAY_KEY, w.BUS_KEY)
w.fetch_arrivals = lambda st: fake.get(st, [])
w.bus_get = lambda op, **p: fake_bus.get(p.get("arsId"), []) if op == "stationinfo/getStationByUid" else []
w.SUBWAY_KEY, w.BUS_KEY = (w.SUBWAY_KEY or "x"), (w.BUS_KEY or "x")
try:
    chain_items = w.live_lines(route5, now)
    fake_bus["11354"] = [dict(bus_now, traTime1="0", arrmsg1="운행종료", traTime2="0", arrmsg2="운행종료")]
    stop_items = w.live_lines(route5, now)
finally:
    w.fetch_arrivals, w.bus_get, w.SUBWAY_KEY, w.BUS_KEY = real
print("     >>", w.live_text(chain_items))
sub = [it for it in chain_items if it["kind"] == "subway"]
ok(chain_items[0]["waits"] == [428, 900], "첫 구간 버스: 대기 7분·15분")
ok(len(sub) == 1 and sub[0]["waits"] == [1230 - 1199, 1500 - 1199],
   "노원역 = 0 + 7 + 8 + 4 = 20분 뒤 → 13분 열차는 못 타고 20분 열차부터 (대기 31초·5분)")
ok(w.live_text(chain_items) == "🚌 지금 출발하면: 1132번 7분·15분 뒤 도착 / 4호선 1분 미만·5분 뒤", "live 문구")
ok(w.live_text(stop_items) == "🚌 지금 출발하면: 1132번 운행종료", "첫 버스를 못 정하면 뒤 구간은 도착 시각을 몰라 생략")

print("== 버스 도착 파싱")
ok(w.bus_eta({"arrmsg1": "10분후[5번째 전]", "traTime1": "592"}, 1, now) == 592, "traTime1 초 (getStationByUid)")
ok(w.bus_eta({"arrmsg2": "곧 도착", "traTime2": "110"}, 2, now) == 110, "traTime2 / 곧 도착도 traTime 우선")
ok(w.bus_eta({"arrmsg1": "곧 도착", "traTime1": "0"}, 1, now) == 30, "traTime 없고 곧 도착=30초")
ok(w.bus_eta({"arrmsg1": "출발대기", "exps1": "0"}, 1, now) is None, "출발대기 제외")
ok(w.bus_eta({"arrmsg1": "2분12초후[1번째 전]", "exps1": "149"}, 1, now) == 149, "exps1 초")
ok(w.bus_eta({"arrmsg1": "3분5초후[2번째 전]", "exps1": "0"}, 1, now) == 185, "exps1 없으면 문구에서")
ents = [{"arsId": "11111", "nxtStn": "상계주공7단지", "rtNm": "1142"}, {"arsId": "22222", "nxtStn": "노원구청", "rtNm": "1142"}]
p, why = w.pick_bus_stop(ents, {"station_to": "노원구청"})
ok(p == [ents[1]], f"길 건너 정류장 고르기 ({why})")
ok(w.bus_stop_ids({"station_from": "노원역 11234"}) == [["11234"]], "station_from 안의 arsId 사용")

print("== 키 가리기")
leak = f"http://x/{w.SUBWAY_KEY}/json?serviceKey={w.quote(w.BUS_KEY, safe='')}&t={w.BOT_TOKEN}"
r = w.redact(leak)
ok(all(k not in r for k in (w.SUBWAY_KEY, w.BUS_KEY, w.BUS_KEY_RAW, w.BOT_TOKEN)), "오류 문구에서 키 3종 가림")

print("== report.py 알림 수첩 (가짜 데이터)")
import report
R = [{"id": 1, "name": "통학", "arrive_by": "09:00:00", "confidence": 90, "baseline_sec": 2400, "fallback_min": 40}]
N = [{"route_id": 1, "date": "2026-10-30", "kind": "pre", "sent_at": "2026-10-29T22:50:12.123+00:00"},    # 07:50 KST
     {"route_id": 1, "date": "2026-10-30", "kind": "live", "sent_at": "2026-10-29T23:20:05+00:00"},       # 08:20 KST
     {"route_id": 1, "date": "2026-10-29", "kind": "pre", "sent_at": "2026-10-28T22:50:00+00:00"},
     {"route_id": 1, "date": "2026-10-29", "kind": "pre", "sent_at": "2026-10-28T23:00:00+00:00"}]       # 중복
T = [{"route_id": 1, "started_at": "2026-10-29T23:23:10+00:00", "ended_at": "2026-10-30T00:05:00+00:00", "excluded": False},   # 10-30 08:23 KST
     {"route_id": 1, "started_at": "2026-10-29T09:00:00+00:00", "ended_at": None, "excluded": False},                        # 10-29 18:00 — 하교
     {"route_id": 1, "started_at": "2026-10-28T23:15:00+00:00", "ended_at": "2026-10-29T00:00:00+00:00", "excluded": True}]  # 10-29 08:15 제외
rows = report.build_rows(R, [], N, T)
md = report.render(rows)
print("   " + "\n   ".join(md.split("\n")[-6:]))
ok([(x["date"], x["kind"]) for x in rows] == [("2026-10-30", "pre"), ("2026-10-30", "live"), ("2026-10-29", "pre"), ("2026-10-29", "pre")],
   "최근 날짜 위, pre → live 순")
ok("| 2026-10-30 | 경로 #1 | pre | 07:50 | 08:20 | 08:23 | +3 |" in md, "예상 08:20 (카카오 40분) · 실제 08:23 · 오차 +3")
ok("| 2026-10-29 | 경로 #1 | pre ⚠️ 2회 | 07:50 | 08:20 | 08:15 (제외) | -5 |" in md, "같은 날 pre 2번 → ⚠️, 예상에 가까운 출발 기록 (제외 표시)")
ok("통학" not in md and "경로 #1" in md, "경로 이름(출발·도착 장소)은 수첩에 안 나옴 — 경로 #<id>만")
ok("중복 1건 ⚠️" in md and "오차 평균 +3.0분" in md and "(실제 출발 1일, 제외 기록 뺌)" in md, "요약 줄 (오차 평균은 제외 기록 빼고)")
ok(report.render([]).rstrip().endswith("아직 보낸 알림이 없어요."), "알림 없으면 안내 문장")
five_before = [dict(T[0], started_at=f"2026-10-{d:02d}T23:00:00+00:00", ended_at=f"2026-10-{d + 1:02d}T00:00:00+00:00", excluded=False) for d in range(10, 15)]
late = [dict(five_before[0], started_at="2026-10-29T22:00:00+00:00", ended_at="2026-10-29T23:30:00+00:00")]   # 알림 뒤에 끝난 기록
x = report.build_rows(R, [], N[:1], five_before + late)[0]
ok(f"{x['depart']:%H:%M}" == "08:00", "예상 출발은 그 알림 전까지 끝난 기록 5회(60분)로 다시 계산 — 알림 뒤 도착은 안 셈")

print("== 실제 DB: trips 조회 (excluded 컬럼이 아직 없어도 실패하지 않아야)")
from datetime import timedelta
rows = w.fetch_trips(1, (now - timedelta(days=w.LOOKBACK_DAYS)).isoformat())
ok(isinstance(rows, list), f"fetch_trips 정상 ({len(rows)}행)")

print("== 실제 API: 버스 정류장 후보")
g = w.bus_stop_ids({"station_from": "노원역"})
ok(set(g[0]) == {"11831", "11832"} and {"11211", "11210"} <= set(g[1]), f"'노원역' 후보 묶음 정확={g[0]} 나머지에 11211·11210")
ok("11211" in w.bus_stop_ids({"station_from": "노원역1번출구"})[0], "'노원역1번출구' 정확 일치 = 11211")
stops = w.bus_get("arrive/getArrInfoByRouteAll", busRouteId="100100157")      # 1142
o = next(int(x["staOrd"]) for x in stops if x["arsId"] == "11211")
AHEAD3 = next(x["stNm"] for x in stops if int(x["staOrd"]) == o + 3)
print("   1142 11211 순번", o, "→ 3정거장 뒤", AHEAD3)
print("== 실제 API")
W = lambda s: {"kind": "walk", "expected_sec": s}
S = lambda a, b, line, sec=600, updn=None: {"kind": "subway", "station_from": a, "station_to": b, "line": line, "updn": updn, "expected_sec": sec}
B = lambda a, b, line, sec=600: {"kind": "bus", "station_from": a, "station_to": b, "line": line, "expected_sec": sec}
cases = {
    "4호선 노원→사당 (방향 없음)": [W(300), S("노원역", "사당역", "4호선")],
    "4호선 노원→창동 (방면 일치)": [W(300), S("노원역", "창동역", "수도권 4호선")],
    "2호선 성수→강남 (순환)": [W(180), S("성수역", "강남역", "2호선")],
    "7호선 이수역→노원 (이름 보정)": [W(0), S("이수역", "노원역", "7호선")],
    "1호선 서울역→시청": [W(120), S("서울역", "시청역", "1호선")],
    "노선명 없음 노원→사당": [W(300), S("노원역", "사당역", None)],
    "저장된 방향 내선순환 (2호선 성수→강남)": [W(180), S("성수역", "강남역", "2호선", updn="내선순환")],
    "저장된 방향 상행": [W(300), S("노원역", "사당역", "4호선", updn="상행")],
    "환승: 노원→창동 4호선, 창동→도봉산 1호선": [W(300), S("노원역", "창동역", "4호선", 240), {"kind": "transfer", "expected_sec": 180}, S("창동역", "도봉산역", "1호선")],
    "버스 (arsId 11211)": [W(300), B("11211", "상계2동주민센터", "1142")],
    "버스 (이름 노원역1번출구)": [W(300), B("노원역1번출구", "상계2동주민센터", "1142")],
    "버스 (이름 '노원역' → 다른 출구 후보 + 길 건너 고르기)": [W(60), B("노원역", AHEAD3, "1142")],
}
for name, segs in cases.items():
    print(f"-- {name}")
    print("     >>", w.live_text(w.live_lines(segs, now)))
