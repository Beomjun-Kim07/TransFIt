# watch.py — 10분마다 실행된다. 읽고(Supabase) → 계산하고(역산) → 받고(실시간) → 보내고(텔레그램) → 적는다(notifications).
#
# 수첩은 state.json 대신 Supabase notifications 테이블을 쓴다.
# 환경변수: SUPABASE_URL, SUPABASE_SERVICE_KEY, BOT_TOKEN, SUBWAY_KEY
# TEST=1 로 실행하면 시간 조건과 무관하게 오늘 계산 결과를 바로 보낸다 (수첩에는 안 적는다).

import os, sys, json, math
from datetime import datetime, date, time, timedelta, timezone
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
TEST = os.environ.get("TEST") == "1"

KST = timezone(timedelta(hours=9))
LIVE_WINDOW_MIN = 10          # 출발 시각 ±10분 안에 실시간 보정 알림
MIN_SAMPLES = 5               # 이만큼 기록이 쌓이면 개인 분위수를 쓴다
LOOKBACK_DAYS = 60

LINE_ID = {"1호선": "1001", "2호선": "1002", "3호선": "1003", "4호선": "1004", "5호선": "1005",
           "6호선": "1006", "7호선": "1007", "8호선": "1008", "9호선": "1009",
           "경의중앙선": "1063", "공항철도": "1065", "경춘선": "1067", "수인분당선": "1075",
           "신분당선": "1077", "우이신설선": "1092", "서해선": "1093", "경강선": "1081", "GTX-A": "1032"}

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

# ---------- 실시간 지하철 ----------
def fetch_arrivals(station):
    url = f"http://swopenapi.seoul.go.kr/api/subway/{SUBWAY_KEY}/json/realtimeStationArrival/0/20/{station}"
    r = requests.get(url, timeout=10)
    r.raise_for_status()
    return r.json().get("realtimeArrivalList", [])

def live_lines(segments, now):
    """첫 지하철 구간의 실시간 도착으로 '지금 나가면' 한 줄을 만든다."""
    walk = next((s for s in segments if s["kind"] == "walk"), None)
    sub = next((s for s in segments if s["kind"] == "subway"), None)
    if not sub or not SUBWAY_KEY:
        return []
    walk_sec = (walk["expected_sec"] if walk else 0) or 0
    line_id = LINE_ID.get(sub["line"] or "", "")
    try:
        arr = fetch_arrivals(sub["station_from"])
    except Exception as e:
        return [f"(실시간 조회 실패: {e})"]
    trains = [a for a in arr if (not line_id or a.get("subwayId") == line_id)
              and (not sub["updn"] or a.get("updnLine") == sub["updn"])]
    trains.sort(key=lambda a: int(a.get("barvlDt") or 0))
    if not trains:
        return [f"{sub['station_from']}역 {sub['line']} {sub['updn'] or ''} 열차 정보 없음"]
    catchable = [a for a in trains if int(a.get("barvlDt") or 0) >= walk_sec]
    out = []
    if catchable:
        a = catchable[0]
        wait = int(a["barvlDt"]) - walk_sec
        out.append(f"지금 나가면 {sub['station_from']}역 도착 후 {wait//60}분 뒤 열차 ({a.get('trainLineNm')})")
    else:
        a = trains[-1]
        out.append(f"다음 열차({a.get('arvlMsg2')})는 놓칠 가능성 큼 · 그다음 열차 기준으로 준비하세요")
    return out

# ---------- 메인 ----------
def main():
    now = datetime.now(KST)
    today = now.date()
    weekday = today.weekday()  # 월=0
    routes = sb_get("routes", {"select": "*"})
    print(f"[{now:%Y-%m-%d %H:%M}] routes={len(routes)} TEST={TEST}")

    for route in routes:
        days = route.get("active_days") or "MTWTF"
        active = weekday < len(days) and days[weekday] != "-"
        if not active and not TEST:
            print(f"  route {route['id']}: 오늘 비활성"); continue

        segments = sb_get("segments", {"route_id": f"eq.{route['id']}", "order": "seq"})
        since = (now - timedelta(days=LOOKBACK_DAYS)).isoformat()
        trips = sb_get("trips", {"route_id": f"eq.{route['id']}", "started_at": f"gte.{since}", "select": "started_at,ended_at"})
        dur, basis = estimate_duration(route, segments, trips)

        hh, mm = map(int, route["arrive_by"].split(":")[:2])
        arrive = datetime.combine(today, time(hh, mm), tzinfo=KST)
        depart = arrive - timedelta(seconds=dur)
        lead = route.get("lead_min") or 30
        print(f"  route {route['id']} '{route['name']}': 도착 {arrive:%H:%M} / 소요 {dur//60}분 ({basis}) / 출발 {depart:%H:%M}")

        head = f"[TransFit] {route['name']}\n도착 목표 {arrive:%H:%M} · 출발 권장 {depart:%H:%M}\n소요 {dur//60}분 — {basis}"

        if TEST:
            lines = live_lines(segments, now)
            send(route["user_id"], head + "\n(테스트 실행)" + ("\n" + "\n".join(lines) if lines else ""))
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
                    send(route["user_id"], head + f"\n{lead}분 뒤 출발이에요.")
                    print("    pre 발송")
            except Exception as e:
                print("    pre 실패:", e)

        # 알림 2: 출발 시각 ±LIVE_WINDOW_MIN, 실시간 보정
        if depart - timedelta(minutes=LIVE_WINDOW_MIN) <= now <= depart + timedelta(minutes=LIVE_WINDOW_MIN):
            try:
                sb_insert_ignore("notifications", {"user_id": route["user_id"], "route_id": route["id"],
                                                   "date": today.isoformat(), "kind": "live"}, "route_id,date,kind")
                already = sb_get("notifications", {"route_id": f"eq.{route['id']}", "date": f"eq.{today}", "kind": "eq.live", "select": "sent_at"})
                sent_at = datetime.fromisoformat(already[0]["sent_at"].replace("Z", "+00:00"))
                if (datetime.now(timezone.utc) - sent_at).total_seconds() < 120:
                    lines = live_lines(segments, now)
                    send(route["user_id"], head + "\n지금 나갈 시간이에요." + ("\n" + "\n".join(lines) if lines else ""))
                    print("    live 발송")
            except Exception as e:
                print("    live 실패:", e)

if __name__ == "__main__":
    main()
