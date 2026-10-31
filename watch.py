# watch.py — 10분마다 실행된다. 읽고(Supabase) → 계산하고(역산) → 받고(실시간) → 보내고(텔레그램) → 적는다(notifications).
#
# 수첩은 state.json 대신 Supabase notifications 테이블을 쓴다.
# 환경변수: SUPABASE_URL, SUPABASE_SERVICE_KEY, BOT_TOKEN, SUBWAY_KEY, BUS_KEY
# TEST=1 로 실행하면 시간 조건과 무관하게 오늘 계산 결과를 바로 보낸다 (수첩에는 안 적는다).
# TEST_SEGMENTS=구간.json 을 같이 주면 DB 구간 대신 그 파일의 구간으로 실시간 줄을 만든다 (시험용, DB는 안 건드림).
# TEST일 때 텔레그램 미연결 사용자는 CHAT_ID(개발자 채팅, .env.local)로 대신 보낸다.

import os, re, json, math
from collections import defaultdict
from datetime import datetime, time, timedelta, timezone
from urllib.parse import quote, unquote
import warnings
warnings.filterwarnings("ignore")  # 맥 기본 파이썬의 LibreSSL 경고 숨김
import requests

try:
    from dotenv import load_dotenv
    load_dotenv(".env.local")
except ImportError:
    pass

SUPABASE_URL = os.environ["SUPABASE_URL"].rstrip("/")
SUPABASE_KEY = os.environ["SUPABASE_SERVICE_KEY"]
BOT_TOKEN = os.environ["BOT_TOKEN"]
SUBWAY_KEY = os.environ.get("SUBWAY_KEY", "")
BUS_KEY_RAW = os.environ.get("BUS_KEY", "")
BUS_KEY = unquote(BUS_KEY_RAW)   # 공공데이터포털 '인코딩' 키를 풀어 둔다 (requests가 params로 다시 인코딩)
TEST = os.environ.get("TEST") == "1"
TEST_SEGMENTS = os.environ.get("TEST_SEGMENTS", "")
TEST_CHAT_ID = os.environ.get("CHAT_ID", "")   # TEST에서만: 텔레그램 미연결 사용자 대신 받을 개발자 채팅

KST = timezone(timedelta(hours=9))
LIVE_WINDOW_MIN = 10          # 출발 시각 ±10분 안에 실시간 보정 알림
MIN_SAMPLES = 5               # 이만큼 기록이 쌓이면 개인 분위수를 쓴다
LOOKBACK_DAYS = 60
REALTIME_HORIZON = 30 * 60    # 실시간 API가 보여 주는 대략의 범위. 이보다 먼 환승 구간은 건너뛴다

LINE_ID = {"1호선": "1001", "2호선": "1002", "3호선": "1003", "4호선": "1004", "5호선": "1005",
           "6호선": "1006", "7호선": "1007", "8호선": "1008", "9호선": "1009",
           "경의중앙선": "1063", "공항철도": "1065", "경춘선": "1067", "수인분당선": "1075",
           "신분당선": "1077", "우이신설선": "1092", "서해선": "1093", "경강선": "1081", "GTX-A": "1032",
           # 카카오 등 다른 표기
           "경의선": "1063", "중앙선": "1063", "분당선": "1075", "수인선": "1075"}
LOOP2 = (1002000201, 1002000243)   # 2호선 본선 순환: 시청(201) → … → 충정로(243) → 시청

SUBWAY_BASE = f"http://swopenapi.seoul.go.kr/api/subway/{SUBWAY_KEY}/json"
BUS_BASE = "http://ws.bus.go.kr/api/rest"
BUS_SERVICE = {"stationinfo": "정류소정보조회", "arrive": "버스도착정보조회"}

MIN_SEC_RE = re.compile(r"(\d+)\s*분(?:\s*(\d+)\s*초)?")   # '6분 30초 후', '2분12초후[1번째 전]'
TLN_RE = re.compile(r"\s*(.+?)행\s*-\s*(.+?)방면")          # '성수행 - 홍대입구방면' → (종착, 다음 역)
STATIONS_AWAY_RE = re.compile(r"\[(\d+)\]번째 전역")         # '[14]번째 전역 (안양)'
SEC_PER_STATION = 120         # 남은 시간이 안 오고 역 수만 올 때 역당 추정 초

# ---------- 키 가리기 ----------
_SECRETS = sorted({s for s in (SUPABASE_KEY, BOT_TOKEN, SUBWAY_KEY, BUS_KEY_RAW, BUS_KEY, quote(BUS_KEY, safe="")) if s},
                  key=len, reverse=True)

def redact(text):
    """오류 문구엔 요청 주소(=키)가 섞여 나온다. 텔레그램·로그로 새지 않게 가린다."""
    s = str(text)
    for k in _SECRETS:
        s = s.replace(k, "***")
    return s

# ---------- Supabase (PostgREST) ----------
H = {"apikey": SUPABASE_KEY, "Authorization": f"Bearer {SUPABASE_KEY}", "Content-Type": "application/json"}

def sb_get(table, params):
    r = requests.get(f"{SUPABASE_URL}/rest/v1/{table}", headers=H, params=params, timeout=15)
    r.raise_for_status()
    return r.json()

def sb_insert_ignore(table, row, on_conflict):
    h = dict(H, Prefer="resolution=ignore-duplicates,return=minimal")
    r = requests.post(f"{SUPABASE_URL}/rest/v1/{table}", headers=h,
                      params={"on_conflict": on_conflict}, data=json.dumps(row), timeout=15)
    r.raise_for_status()

def fetch_trips(route_id, since):
    """최근 기록. excluded 컬럼이 아직 DB에 없으면(400, 42703) 그 컬럼 없이 다시 조회해 알림이 멈추지 않게 한다."""
    params = {"route_id": f"eq.{route_id}", "started_at": f"gte.{since}", "select": "started_at,ended_at,excluded"}
    try:
        return sb_get("trips", params)
    except requests.HTTPError as e:
        if e.response is not None and e.response.status_code == 400 and "excluded" in e.response.text:
            print("    trips.excluded 컬럼 없음 → 제외 표시 없이 조회")
            return sb_get("trips", dict(params, select="started_at,ended_at"))
        raise

# ---------- 텔레그램 ----------
def send(chat_id, text):
    r = requests.post(f"https://api.telegram.org/bot{BOT_TOKEN}/sendMessage",
                      data={"chat_id": chat_id, "text": text}, timeout=10)
    r.raise_for_status()

# ---------- 통계 (조연준 Estimator.quantile과 같은 선형보간 분위수) ----------
def quantile(values, p):
    v = sorted(values)
    if not v:
        return None
    pos = (len(v) - 1) * p
    lo, hi = math.floor(pos), math.ceil(pos)
    return v[lo] + (v[hi] - v[lo]) * (pos - lo)

def estimate_duration(route, segments, trips):
    """(초, 근거 문자열) — 기록이 충분하면 개인 분위수, 아니면 기준값."""
    durs = []
    for t in trips:
        if t.get("excluded"):              # 사용자가 '이 기록 빼기' 한 행 (지연·우회 등)
            continue
        if t["ended_at"] and t["started_at"]:
            s = datetime.fromisoformat(t["started_at"].replace("Z", "+00:00"))
            e = datetime.fromisoformat(t["ended_at"].replace("Z", "+00:00"))
            d = (e - s).total_seconds()
            if 180 <= d <= 3 * 3600:      # 3분 미만·3시간 초과는 오작동으로 본다
                durs.append(d)
    p = route["confidence"] / 100
    if len(durs) >= MIN_SAMPLES:
        q = quantile(durs, p)
        return int(q), f"내 기록 {len(durs)}회의 {route['confidence']}% 기준"
    seg_sum = sum(s["expected_sec"] or 0 for s in segments)
    if route.get("baseline_sec"):
        return int(route["baseline_sec"]), f"기준 경로 (지도 API) · 기록 {len(durs)}/{MIN_SAMPLES}회"
    if seg_sum:
        return int(seg_sum), f"구간 예상치 합 · 기록 {len(durs)}/{MIN_SAMPLES}회"
    return route["fallback_min"] * 60, "기본 소요시간"

# ---------- 공통: 시각·문구 ----------
def age_sec(stamp, now):
    """실시간 데이터가 만들어진 뒤(recptnDt/mkTm) 흐른 초. 남은 시간에서 빼 준다."""
    try:
        t = datetime.strptime(str(stamp)[:19], "%Y-%m-%d %H:%M:%S").replace(tzinfo=KST)
    except (TypeError, ValueError):
        return 0
    return max(0, int((now - t).total_seconds()))

def wait_txt(sec):
    m = int(sec) // 60
    return f"{m}분" if m else "1분 미만"

def lead_txt(first, offset, place):
    """첫 승차 지점이면 '지금 나가면 ○○ 도착 후', 환승 지점이면 도착 예상 시각까지 붙인다."""
    return f"지금 나가면 {place} 도착 후" if first else f"환승 {place}: 약 {offset // 60}분 뒤 도착 후"

# ---------- 실시간 지하철 ----------
def norm_station(name):
    """카카오 이름('노원역', '강남역(2호선)', '서울역 1호선') → 실시간 API 이름('노원', '강남', '서울')."""
    n = (name or "").strip().split(" ")[0]
    n = re.sub(r"\([^()]*선\)$", "", n)          # 노선 꼬리표
    if len(n) > 1 and n.endswith("역"):
        n = n[:-1]
    return n

def name_parts(name):
    return {p for p in re.split(r"[(),]", norm_station(name)) if p}

def same_station(x, y):
    """'이수' == '총신대입구(이수)', '신촌' == '신촌(경의중앙선)'."""
    return bool(x and y and name_parts(x) & name_parts(y))

def line_id(line):
    """'4호선', '수도권 4호선', '수도권4호선' → '1004'. 모르면 ''."""
    s = (line or "").replace(" ", "")
    for k in sorted(LINE_ID, key=len, reverse=True):
        if k in s:
            return LINE_ID[k]
    return ""

def fetch_arrivals(station):
    r = requests.get(f"{SUBWAY_BASE}/realtimeStationArrival/0/30/{quote(station)}", timeout=10)
    r.raise_for_status()
    j = r.json()
    err = j.get("errorMessage") or j
    if err.get("code") not in (None, "INFO-000", "INFO-200"):     # INFO-200 = 해당 데이터 없음
        raise RuntimeError(f"지하철 API {err.get('code')} {err.get('message')}")
    return j.get("realtimeArrivalList") or []

_ALL_NAMES = None
def official_names(name):
    """'이수' → ['총신대입구(이수)']. 전체 도착 목록에서 정식 이름을 찾는다 (이름이 안 맞을 때만 호출)."""
    global _ALL_NAMES
    if _ALL_NAMES is None:
        try:
            r = requests.get(f"{SUBWAY_BASE}/realtimeStationArrival/ALL", timeout=20)
            r.raise_for_status()
            _ALL_NAMES = sorted({a["statnNm"] for a in r.json().get("realtimeArrivalList") or [] if a.get("statnNm")})
        except Exception as e:
            print("    역 이름 목록 조회 실패:", redact(e))
            _ALL_NAMES = []
    return [n for n in _ALL_NAMES if n != name and same_station(n, name)]

def station_arrivals(name, lid):
    """(정식 역 이름, 그 역의 도착 목록 — lid 노선만). 이름이 안 맞으면 정식 이름 후보로 다시 조회."""
    n = norm_station(name)
    if not n:
        return "", []
    by_line = lambda arr: [a for a in arr if not lid or a.get("subwayId") == lid]
    arr = by_line(fetch_arrivals(n))
    if arr:
        return n, arr
    for cand in official_names(n):
        arr = by_line(fetch_arrivals(cand))
        if arr:
            return cand, arr
    return n, []

def subway_eta(a, now):
    """이 역 도착까지 남은 초. 이미 떠났거나 알 수 없으면 None."""
    cd = str(a.get("arvlCd") or "")
    if cd == "2":                                  # 출발 — 방금 떠남
        return None
    sec = int(a.get("barvlDt") or 0)
    if sec <= 0:                                   # 1호선 등 코레일 구간은 barvlDt가 0으로 온다
        msg, ordkey = a.get("arvlMsg2") or "", str(a.get("ordkey") or "")
        m, n = MIN_SEC_RE.search(msg), STATIONS_AWAY_RE.search(msg)
        if cd in ("0", "1"):                       # 진입·도착
            sec = 0
        elif m:
            sec = int(m.group(1)) * 60 + int(m.group(2) or 0)
        elif cd in ("3", "4", "5"):                # 전역 출발·진입·도착
            sec = 90
        elif n:                                    # '[14]번째 전역 (안양)' → 역 수로 추정
            sec = int(n.group(1)) * SEC_PER_STATION
        elif ordkey[2:5].isdigit():                # ordkey 3~5번째 자리 = 남은 역 수
            sec = int(ordkey[2:5]) * SEC_PER_STATION
        else:
            return None
    return sec - age_sec(a.get("recptnDt"), now)

def eta_txt(a, sec):
    """barvlDt 없이 추정한 값이면 '약'을 붙인다."""
    rough = int(a.get("barvlDt") or 0) <= 0 and str(a.get("arvlCd") or "") not in ("0", "1")
    return ("약 " if rough else "") + wait_txt(sec)

def timed_trains(trains, now):
    """[(남은 초, 열차)] 빨리 오는 순. 남은 시간을 모르는 열차는 뺀다."""
    timed = [(subway_eta(a, now), a) for a in trains]
    return sorted(((e, a) for e, a in timed if e is not None), key=lambda x: x[0])

def parse_tln(a):
    """(종착역, 다음 역)."""
    m = TLN_RE.match(a.get("trainLineNm") or "")
    return (m.group(1).strip(), m.group(2).strip()) if m else ((a.get("bstatnNm") or ""), "")

def in_loop2(sid, *ids):
    return sid == "1002" and all(LOOP2[0] <= v <= LOOP2[1] for v in ids)

def id_dist(sid, x, y):
    """같은 노선 두 역 ID 사이 거리(≈역 개수). 2호선 본선은 순환이라 짧은 쪽."""
    if in_loop2(sid, x, y):
        n = LOOP2[1] - LOOP2[0] + 1
        d = (y - x) % n
        return min(d, n - d)
    return abs(y - x)

def station_ids(arr):
    """{subwayId: 이 역의 statnId}."""
    return {a.get("subwayId"): int(a["statnId"]) for a in arr if str(a.get("statnId") or "").isdigit()}

def pick_direction(arr, b_name, b_ids):
    """도착역 쪽으로 가는 열차만 고른다. → (열차 목록, 근거). 판정 못 하면 (None, 사유)."""
    groups = defaultdict(list)                     # 다음 역이 같으면 같은 방향
    for a in arr:
        groups[(a.get("subwayId"), a.get("statnTid"))].append(a)
    if not b_name:
        return None, "도착역 정보 없음"
    # 1) 방면(= 다음 역)이 도착역
    for g in groups.values():
        if same_station(parse_tln(g[0])[1], b_name):
            return g, f"방면이 {b_name}"
    # 2) 종착역이 도착역인 열차가 한 방향에만 있다 (2호선 '성수행'처럼 양쪽에 다 있으면 3으로)
    hit = [g for g in groups.values()
           if any(same_station(parse_tln(a)[0], b_name) or same_station(a.get("bstatnNm"), b_name) for a in g)]
    if len(hit) == 1:
        return hit[0], f"{b_name}행 열차의 방향"
    # 3) 역 ID: 다음 역 ID가 도착역 ID에 가까워지는 쪽
    best = None
    for (sid, tid), g in groups.items():
        a_id = str(g[0].get("statnId") or "")
        if sid not in b_ids or not str(tid or "").isdigit() or not a_id.isdigit():
            continue
        d_now, d_next = id_dist(sid, int(a_id), b_ids[sid]), id_dist(sid, int(tid), b_ids[sid])
        if d_next < d_now and (best is None or d_next < best[0]):
            best = (d_next, g)
    if best:
        return best[1], "역 ID 순서"
    return None, "방향 판정 실패"

def drop_short_turn(trains, b_ids):
    """회차(중간 종착) 열차를 뺀다.
    ① 종착역이 진행 방향 뒤쪽 = 이 역에 오기 전에 끝남 (예: 창동 상행 목록의 '용산행')
    ② 종착역이 이 역과 도착역 사이 = 도착역 전에 끝남 (예: 노원→사당인데 '한성대입구행')
    2호선 본선 순환열차와, 역 ID 앞 7자리가 다른(지선 등) 경우는 판단하지 않고 남긴다."""
    keep = []
    for a in trains:
        sid, b_id = a.get("subwayId"), b_ids.get(a.get("subwayId"))
        try:
            a_id, n_id, t_id = int(a["statnId"]), int(a["statnTid"]), int(a["bstatnId"])
        except (KeyError, TypeError, ValueError):
            keep.append(a); continue
        same_block = lambda *v: len({str(x)[:7] for x in v}) == 1
        if not in_loop2(sid, a_id, t_id) and same_block(a_id, n_id, t_id) and (t_id - a_id) * (n_id - a_id) < 0:
            continue                                                   # ①
        if b_id and not in_loop2(sid, a_id, b_id) and same_block(a_id, t_id, b_id):
            dab, dat = id_dist(sid, a_id, b_id), id_dist(sid, a_id, t_id)
            if 0 < dat < dab and dat + id_dist(sid, t_id, b_id) == dab:
                continue                                               # ②
        keep.append(a)
    return keep

def subway_live(seg, offset, now, first):
    """지하철 구간 하나: 지금 나가서 이 역에 닿는 시각(offset초 뒤) 이후 첫 열차."""
    lid = line_id(seg.get("line"))
    a_name, arr = station_arrivals(seg.get("station_from"), lid)
    b_name, b_arr = station_arrivals(seg.get("station_to"), lid) if seg.get("station_to") else ("", [])
    if not lid and b_arr:                          # 노선명을 못 읽었으면 출발·도착역에 같이 서는 노선
        common = {a.get("subwayId") for a in arr} & {b.get("subwayId") for b in b_arr}
        arr = [a for a in arr if a.get("subwayId") in common] or arr
    b_ids = station_ids(b_arr)
    place = f"{a_name or seg.get('station_from')}역"
    if not arr:
        return [f"{place} {seg.get('line') or ''} 열차 정보 없음"] if first else []

    if seg.get("updn"):
        # updnLine은 상행/하행/내선/외선 — 웹에서 '내선순환', '상행선'처럼 적어도 맞게
        trains, basis = [a for a in arr if (a.get("updnLine") or "?") in seg["updn"]], f"저장된 방향 {seg['updn']}"
    else:
        trains, basis = pick_direction(arr, b_name, b_ids)
    print(f"    지하철 {a_name}→{b_name or '?'} {seg.get('line') or ''}: 방향 근거 = {basis}")

    if trains is None:                             # 방향 미확정 → 방향마다 한 줄 (섞어서 틀린 열차를 고르지 않게)
        groups = defaultdict(list)
        for a in drop_short_turn(arr, b_ids):
            groups[parse_tln(a)[1] or a.get("updnLine")].append(a)
        out = []
        for g in groups.values():
            catch = [(e, a) for e, a in timed_trains(g, now) if e >= offset]
            if catch:
                e, a = catch[0]
                out.append(f"방향 미확정 · {lead_txt(first, offset, place)} 대기 {eta_txt(a, e - offset)} · {a.get('trainLineNm')}")
        return out if (out or not first) else [f"{place} 방향 미확정 · 잡을 수 있는 열차 없음"]

    timed = timed_trains(drop_short_turn(trains, b_ids), now)
    for e, a in timed:
        print(f"      {a.get('trainLineNm')} 열차 {a.get('btrainNo')} {e}초 ({a.get('arvlMsg2')})")
    if not timed:
        return [f"{place} {seg.get('line') or ''} 열차 정보 없음"] if first else []
    catch = [(e, a) for e, a in timed if e >= offset]
    if catch:
        e, a = catch[0]
        return [f"{lead_txt(first, offset, place)} 대기 {eta_txt(a, e - offset)} · {a.get('trainLineNm')}"]
    if not first:
        return []
    a = timed[-1][1]
    return [f"{place} 다음 열차({a.get('arvlMsg2')})는 놓칠 가능성 큼 · 그다음 열차 기준으로 준비하세요"]

# ---------- 실시간 버스 (서울 버스, 공공데이터포털) ----------
def bus_get(op, **params):
    r = requests.get(f"{BUS_BASE}/{op}", params=dict(serviceKey=BUS_KEY, resultType="json", **params), timeout=10)
    if r.status_code in (401, 403):
        svc = op.split("/")[0]
        raise RuntimeError(f"버스 키가 '{BUS_SERVICE.get(svc, svc)}' 서비스에 등록 안 됨 — 공공데이터포털 활용신청 확인")
    r.raise_for_status()
    j = r.json()
    h = j.get("msgHeader") or {}
    if str(h.get("headerCd")) not in ("0", "4"):   # 0 정상, 4 결과 없음
        raise RuntimeError(f"버스 API {h.get('headerCd')} {h.get('headerMsg')}")
    return (j.get("msgBody") or {}).get("itemList") or []

def norm_stop(name):
    return re.sub(r"\s", "", name or "")

def same_stop(x, y):
    a, b = norm_stop(x), norm_stop(y)
    return bool(a and b and (a == b or a.split("(")[0] == b.split("(")[0]))

def route_match(rt_nm, line):
    """rtNm '146' ↔ 카카오 노선명 '146', '146번', '간선 146'."""
    if not line:
        return True
    rt = norm_stop(rt_nm)
    toks = {t.rstrip("번") for t in re.split(r"[\s:/,()]+", line) if t} | {norm_stop(line).rstrip("번")}
    return bool(rt) and rt in toks

def bus_stop_ids(seg):
    """승차 정류장 번호(arsId) 후보 묶음 [[이름이 정확히 같은 곳], [나머지 검색 결과]].
    station_from에 5자리 번호가 있으면 그것 하나. 앞 묶음에 그 노선이 없으면 뒤 묶음을 본다
    (예: '노원역'=11831·11832엔 6100만 서고, 1142는 '노원역1번출구' 11211·'노원역9번출구' 11210)."""
    s = (seg.get("station_from") or "").strip()
    m = re.search(r"(?<!\d)(\d{5})(?!\d)", s)
    if m:
        return [[m.group(1)]]
    if not s:
        return []
    items = [it for it in bus_get("stationinfo/getStationByName", stSrch=s) if str(it.get("arsId") or "0") != "0"]
    exact = [it["arsId"] for it in items if same_stop(it.get("stNm"), s)]
    rest = [it["arsId"] for it in items if it["arsId"] not in exact]
    return [exact, rest[:10]]

def bus_eta(it, n, now):
    """n번째(1·2) 도착 예정 버스까지 남은 초. 운행 전·종료면 None."""
    msg = it.get(f"arrmsg{n}") or ""
    if not msg or any(w in msg for w in ("운행종료", "출발대기", "회차대기", "정보없음")):
        return None
    # 남은 초: getStationByUid는 traTime{n}만 준다 ('10분후[5번째 전]' ↔ traTime1 592). exps{n}은 arrive 서비스용 예비
    sec = int(it.get(f"traTime{n}") or 0) or int(it.get(f"exps{n}") or 0)
    if sec <= 0:
        if "곧 도착" in msg:
            sec = 30
        else:
            m = MIN_SEC_RE.search(msg)
            if not m:
                return None
            sec = int(m.group(1)) * 60 + int(m.group(2) or 0)
    return sec - age_sec(it.get("mkTm"), now)

def pick_bus_stop(entries, seg):
    """같은 이름 정류장이 길 양쪽에 있을 때 도착 정류장 쪽으로 가는 쪽을 고른다. → (항목들, 근거)."""
    if len(entries) <= 1:
        return entries, "정류장 하나"
    to = seg.get("station_to")
    if not to:
        return entries, "도착 정류장 정보 없음"
    nx = [e for e in entries if same_stop(e.get("nxtStn"), to)]
    if len(nx) == 1:
        return nx, "다음 정류장이 도착 정류장"
    try:   # 노선 정류장 순서 (버스도착정보조회 — 지금 키로 쓸 수 있는 서비스)
        stops = bus_get("arrive/getArrInfoByRouteAll", busRouteId=entries[0].get("busRouteId"))
    except Exception as e:
        return entries, f"노선 순서 조회 실패: {redact(e)}"
    n = len(stops)
    ords = {s.get("arsId"): int(s.get("staOrd") or 0) for s in stops}
    to_ords = [int(s.get("staOrd") or 0) for s in stops if same_stop(s.get("stNm"), to)]
    best = None
    for e in entries:
        fo = ords.get(e.get("arsId")) or int(e.get("staOrd") or 0)
        gaps = [(t - fo) % n for t in to_ords if (t - fo) % n]
        if fo and gaps and (best is None or min(gaps) < best[0]):
            best = (min(gaps), e)
    return ([best[1]], "노선 정류장 순서") if best else (entries, "방향 판정 실패")

def bus_live(seg, offset, now, first):
    """버스 구간 하나: 지금 나가서 이 정류장에 닿는 시각(offset초 뒤) 이후 첫 버스."""
    entries = []
    for group in bus_stop_ids(seg):                # 이름 정확히 같은 정류장부터, 그 노선이 없으면 나머지 후보
        entries = [it for ars in group
                   for it in bus_get("stationinfo/getStationByUid", arsId=ars) if route_match(it.get("rtNm"), seg.get("line"))]
        if entries:
            break
    stop, line = seg.get("station_from") or "정류장", seg.get("line") or "버스"
    if not entries:
        return [f"{stop} {line} 버스 정보 없음"] if first else []
    if seg.get("line"):
        picked, basis = pick_bus_stop(entries, seg)
    else:                                          # 노선을 모르면 그 정류장 버스 중 빨리 오는 3개
        soon = lambda e: (lambda x: 1e9 if x is None else x)(bus_eta(e, 1, now))
        picked, basis = sorted(entries, key=soon)[:3], "노선 미지정"
    print(f"    버스 {stop}→{seg.get('station_to') or '?'} {line}: 정류장 근거 = {basis}")
    out = []
    for e in picked:
        print(f"      {e.get('rtNm')} {e.get('stNm')}({e.get('arsId')}) {e.get('adirection')}방향 "
              f"vehId1={e.get('vehId1')} traTime1={e.get('traTime1')} ({e.get('arrmsg1')})")
        place = f"{e.get('stNm') or stop} 정류장"
        tag = f"{e.get('rtNm')}번" + (f" ({e.get('adirection')} 방향)" if len(picked) > 1 and e.get("adirection") else "")
        etas = sorted(x for x in (bus_eta(e, 1, now), bus_eta(e, 2, now)) if x is not None)
        catch = [x for x in etas if x >= offset]
        if catch:
            out.append(f"{lead_txt(first, offset, place)} 대기 {wait_txt(catch[0] - offset)} · {tag}")
        elif first and etas:
            out.append(f"{place} {tag} 다음 버스({e.get('arrmsg1')})는 놓칠 가능성 큼 · 그다음 버스 기준으로 준비하세요")
        elif first:
            out.append(f"{place} {tag} 도착 정보 없음 ({e.get('arrmsg1') or '-'})")
    return out

# ---------- 실시간 묶음 ----------
def live_lines(segments, now):
    """구간을 순서대로 따라가며, 지금 나가면 각 승차 지점에 닿는 시각 이후 첫 열차·버스를 고른다.
    첫 승차 구간은 항상 한 줄, 뒤 환승 구간은 잡을 수 있는 차가 보일 때만."""
    out, offset, first = [], 0, True
    for seg in segments:
        kind = seg.get("kind")
        if kind in ("subway", "bus") and (first or offset <= REALTIME_HORIZON):
            if SUBWAY_KEY if kind == "subway" else BUS_KEY:
                try:
                    out += (subway_live if kind == "subway" else bus_live)(seg, offset, now, first)
                except Exception as e:
                    print(f"    {kind} 실시간 실패: {redact(e)}")
                    if first:
                        out.append(f"({'지하철' if kind == 'subway' else '버스'} 실시간 조회 실패: {redact(e)})")
            first = False
        offset += seg.get("expected_sec") or 0
    return out

# ---------- 메인 ----------
def main():
    now = datetime.now(KST)
    today = now.date()
    weekday = today.weekday()  # 월=0
    routes = sb_get("routes", {"select": "*,users(telegram_chat_id)"})
    print(f"[{now:%Y-%m-%d %H:%M}] routes={len(routes)} TEST={TEST}")

    for route in routes:
        chat_id = (route.get("users") or {}).get("telegram_chat_id")
        if not chat_id and TEST and TEST_CHAT_ID:
            chat_id = TEST_CHAT_ID
            print(f"  route {route['id']}: 텔레그램 미연결 → TEST라 CHAT_ID(개발자 채팅)로 보냄")
        if not chat_id:
            print(f"  route {route['id']}: 텔레그램 미연결"); continue
        days = route.get("active_days") or "MTWTF"
        active = weekday < len(days) and days[weekday] != "-"
        if not active and not TEST:
            print(f"  route {route['id']}: 오늘 비활성"); continue

        if TEST and TEST_SEGMENTS:
            with open(TEST_SEGMENTS, encoding="utf-8") as f:
                segments = json.load(f)
        else:
            segments = sb_get("segments", {"route_id": f"eq.{route['id']}", "order": "seq"})
        since = (now - timedelta(days=LOOKBACK_DAYS)).isoformat()
        trips = fetch_trips(route["id"], since)
        dur, basis = estimate_duration(route, segments, trips)

        hh, mm = map(int, route["arrive_by"].split(":")[:2])
        arrive = datetime.combine(today, time(hh, mm), tzinfo=KST)
        depart = arrive - timedelta(seconds=dur)
        lead = route.get("lead_min") or 30
        print(f"  route {route['id']} '{route['name']}': 도착 {arrive:%H:%M} / 소요 {dur//60}분 ({basis}) / 출발 {depart:%H:%M}")

        head = f"[TransFit] {route['name']}\n도착 목표 {arrive:%H:%M} · 출발 권장 {depart:%H:%M}\n소요 {dur//60}분 — {basis}"

        if TEST:
            lines = live_lines(segments, now)
            for l in lines:
                print("    |", l)
            send(chat_id, head + "\n(테스트 실행)" + ("\n" + "\n".join(lines) if lines else ""))
            print("    TEST 발송"); continue

        # 알림 1: 출발 lead_min 전 구간
        if depart - timedelta(minutes=lead) <= now < depart:
            try:
                sb_insert_ignore("notifications", {"user_id": route["user_id"], "route_id": route["id"],
                                                   "date": today.isoformat(), "kind": "pre"}, "route_id,date,kind")
                already = sb_get("notifications", {"route_id": f"eq.{route['id']}", "date": f"eq.{today}", "kind": "eq.pre", "select": "sent_at"})
                # ignore-duplicates라 새로 들어갔는지 알 수 없어 sent_at으로 판정: 방금 생긴 행이면 보낸다
                sent_at = datetime.fromisoformat(already[0]["sent_at"].replace("Z", "+00:00"))
                if (datetime.now(timezone.utc) - sent_at).total_seconds() < 120:
                    send(chat_id, head + f"\n{lead}분 뒤 출발이에요.")
                    print("    pre 발송")
            except Exception as e:
                print("    pre 실패:", redact(e))

        # 알림 2: 출발 시각 ±LIVE_WINDOW_MIN, 실시간 보정
        if depart - timedelta(minutes=LIVE_WINDOW_MIN) <= now <= depart + timedelta(minutes=LIVE_WINDOW_MIN):
            try:
                sb_insert_ignore("notifications", {"user_id": route["user_id"], "route_id": route["id"],
                                                   "date": today.isoformat(), "kind": "live"}, "route_id,date,kind")
                already = sb_get("notifications", {"route_id": f"eq.{route['id']}", "date": f"eq.{today}", "kind": "eq.live", "select": "sent_at"})
                sent_at = datetime.fromisoformat(already[0]["sent_at"].replace("Z", "+00:00"))
                if (datetime.now(timezone.utc) - sent_at).total_seconds() < 120:
                    lines = live_lines(segments, now)
                    send(chat_id, head + "\n지금 나갈 시간이에요." + ("\n" + "\n".join(lines) if lines else ""))
                    print("    live 발송")
            except Exception as e:
                print("    live 실패:", redact(e))

if __name__ == "__main__":
    main()
