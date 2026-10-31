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
ok(sec == 3000 and "4/5" in why, f"제외하면 4회라 기준값 사용 ({why})")
ok(w.estimate_duration(route, [], five)[0] == q90, "excluded 키가 없는 행(컬럼 없음)·false는 그대로 사용")

print("== 텔레그램 버튼 (실제로 보내지 않음)")
import json
sent = []
class FakeResp:
    def raise_for_status(self): pass
    def json(self): return {"ok": True, "result": {}}
real_post = w.requests.post
w.requests.post = lambda url, data=None, timeout=None: (sent.append(data), FakeResp())[1]
try:
    w.send_pre("1", 7, "[TransFit] 통학", 30)
    w.send_live("1", "[TransFit] 통학", ["지금 나가면 노원역 도착 후 대기 2분"])
finally:
    w.requests.post = real_post
pre, live = sent
kb = json.loads(pre["reply_markup"])["inline_keyboard"] if "reply_markup" in pre else []
ok(kb == [[{"text": "출발했어요", "callback_data": "trip:start:7"}]], f"pre 알림 버튼 = {kb}")
ok(pre["text"].endswith("30분 뒤 출발이에요."), "pre 문구 그대로")
ok("reply_markup" not in live and "대기 2분" in live["text"], "live 알림엔 버튼 없음")
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
ok(w.subway_eta(k, now) == 14 * w.SEC_PER_STATION and w.eta_txt(k, 600).startswith("약 "), "[14]번째 전역 → 역 수 추정, '약' 표시")
ok(w.subway_eta(dict(k, arvlMsg2="", ordkey="02003용산0"), now) == 3 * w.SEC_PER_STATION, "ordkey로 역 수")
ok(w.subway_eta(dict(k, arvlCd="2", arvlMsg2="서울 출발"), now) is None, "출발한 열차 제외")
ok(not w.eta_txt(dict(k, barvlDt="300"), 300).startswith("약"), "barvlDt 있으면 '약' 없음")
# 같은 도착 시간 열차 둘 → 정렬 오류 없어야
ok(len(w.timed_trains([arr4[0], arr4[1]], now)) == 2, "도착 시간 같아도 정렬 OK")

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
    for line in w.live_lines(segs, now):
        print("     >>", line)
