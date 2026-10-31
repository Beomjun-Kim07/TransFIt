# report.py — 알림 수첩: notifications(보낸 알림)와 trips(실제 출발)를 맞춰 docs/notebook.md 표를 만든다.
# GitHub Actions(report.yml)가 매일 23:50 KST에 실행하고, 바뀐 게 있을 때만 docs/notebook.md를 커밋한다.
# 저장소가 공개라 경로는 "경로 #<id>"로만 쓴다 (경로 이름 = 출발·도착 장소라 넣지 않는다).
# 환경변수: SUPABASE_URL, SUPABASE_SERVICE_KEY (텔레그램·실시간 키는 안 쓴다). 로컬: python3 report.py
import os, sys
from collections import Counter, defaultdict
from datetime import date, timedelta

HERE = os.path.dirname(os.path.abspath(__file__))
os.chdir(HERE)                      # watch.py가 .env.local을 현재 폴더에서 읽는다
sys.path.insert(0, HERE)
import watch as w                   # 같은 계산(plan·estimate_duration)을 그대로 써서 '예상 출발'을 다시 만든다

OUT = os.path.join(HERE, "docs", "notebook.md")
KIND_ORDER = {"pre": 0, "live": 1}
PAGE = 1000                         # PostgREST 한 번에 최대 행 수

def sb_all(table, params):
    """한 번에 PAGE행씩 끝까지 읽는다."""
    rows, off = [], 0
    while True:
        part = w.sb_get(table, dict(params, limit=PAGE, offset=off))
        rows += part
        if len(part) < PAGE:
            return rows
        off += PAGE

def trips_known_at(trips, when):
    """그 시각에 watch.py가 볼 수 있었던 기록: 최근 LOOKBACK_DAYS일 안에 시작, 그 뒤에 찍힌 도착은 아직 없던 것."""
    since = when - timedelta(days=w.LOOKBACK_DAYS)
    out = []
    for t in trips:
        s = w.parse_ts(t["started_at"])
        if since <= s < when:
            ended = t.get("ended_at") and w.parse_ts(t["ended_at"]) <= when
            out.append(dict(t, ended_at=t["ended_at"] if ended else None))
    return out

def build_rows(routes, segments, notifications, trips):
    """표의 행들 (최근 날짜가 위). routes/segments/trips는 route_id로 묶어 쓴다."""
    route_by = {r["id"]: r for r in routes}
    segs_by, trips_by = defaultdict(list), defaultdict(list)
    for s in segments:
        segs_by[s["route_id"]].append(s)
    for t in trips:
        trips_by[t["route_id"]].append(t)
    dup = Counter((n["route_id"], n["date"], n["kind"]) for n in notifications)

    rows = []
    for n in notifications:
        r = route_by.get(n["route_id"])
        if not r:
            continue
        day = date.fromisoformat(n["date"])
        sent = w.parse_ts(n["sent_at"]).astimezone(w.KST)
        _, depart, _, _ = w.plan(r, segs_by[r["id"]], trips_known_at(trips_by[r["id"]], sent), day)
        same_day = [t for t in trips_by[r["id"]] if w.parse_ts(t["started_at"]).astimezone(w.KST).date() == day]
        actual = min(same_day, key=lambda t: abs((w.parse_ts(t["started_at"]) - depart).total_seconds()), default=None)
        a_at = w.parse_ts(actual["started_at"]).astimezone(w.KST) if actual else None
        rows.append({
            "route_id": r["id"], "date": n["date"], "route": f"경로 #{r['id']}", "kind": n["kind"],   # 공개 저장소: 경로 이름(출발·도착 장소)은 안 쓴다
            "count": dup[(n["route_id"], n["date"], n["kind"])], "sent": sent, "depart": depart,
            "actual": a_at, "excluded": bool(actual and actual.get("excluded")),
            "diff": round((a_at - depart).total_seconds() / 60) if a_at else None,
        })
    rows.sort(key=lambda x: (x["route_id"], KIND_ORDER.get(x["kind"], 9), x["sent"]))
    rows.sort(key=lambda x: x["date"], reverse=True)
    return rows

def cell(s):
    return str(s).replace("|", "\\|").replace("\n", " ")

def signed(m):
    return f"+{m}" if m > 0 else str(m)

def render(rows):
    dups = {(x["route_id"], x["date"], x["kind"]) for x in rows if x["count"] >= 2}
    days = {(x["route_id"], x["date"]): x["diff"] for x in rows    # 경로·날짜당 오차 하나, 웹에서 뺀 기록은 평균에서 뺀다
            if x["diff"] is not None and not x["excluded"]}
    kinds = Counter(x["kind"] for x in rows)
    out = [
        "# 알림 수첩",
        "",
        "watch.py가 보낸 알림(`notifications`)과 실제 출발 기록(`trips`)을 맞춰 본 표. "
        "`report.py`가 매일 23:50(KST)에 다시 만든다 — 손으로 고치지 않는다.",
        "",
        "- **예상 출발**: 그 알림을 보낼 때까지 쌓인 기록으로 watch.py 계산을 다시 해 본 값 (경로 설정을 바꿨다면 지금 설정 기준)",
        "- **실제 출발**: 같은 날 그 경로 `trips.started_at` 중 예상 출발에 가장 가까운 것. 웹에서 뺀 기록은 `(제외)`",
        "- **오차(분)**: 실제 − 예상. `+`는 늦게, `-`는 일찍 나감",
        "- **⚠️**: 같은 날 같은 종류 알림이 2번 이상 = 중복 방지 실패",
        "",
    ]
    if not rows:
        return "\n".join(out + ["아직 보낸 알림이 없어요.", ""])
    summary = [f"알림 {len(rows)}건 (pre {kinds['pre']} · live {kinds['live']})",
               f"중복 {len(dups)}건 " + ("⚠️" if dups else "✅")]
    if days:
        v = list(days.values())
        summary.append(f"오차 평균 {signed(round(sum(v) / len(v), 1))}분 · 크기 평균 {round(sum(map(abs, v)) / len(v), 1)}분"
                       f" (실제 출발 {len(v)}일, 제외 기록 뺌)")
    else:
        summary.append("실제 출발 기록 없음")
    out += ["요약: " + " · ".join(summary), "",
            "| 날짜 | 경로 | 알림 종류 | 보낸 시각 | 예상 출발 | 실제 출발 | 오차(분) |",
            "|---|---|---|---|---|---|---:|"]
    for x in rows:
        kind = x["kind"] + (f" ⚠️ {x['count']}회" if x["count"] >= 2 else "")
        actual = f"{x['actual']:%H:%M}" + (" (제외)" if x["excluded"] else "") if x["actual"] else "-"
        diff = signed(x["diff"]) if x["diff"] is not None else "-"
        out.append(f"| {x['date']} | {cell(x['route'])} | {kind} | {x['sent']:%H:%M} | {x['depart']:%H:%M} | {actual} | {diff} |")
    return "\n".join(out + [""])

def main():
    routes = sb_all("routes", {"select": "id,arrive_by,confidence,baseline_sec,fallback_min", "order": "id"})   # name은 읽지도 않는다
    segments = sb_all("segments", {"select": "route_id,kind,expected_sec", "order": "route_id,seq"})
    notifications = sb_all("notifications", {"select": "route_id,date,kind,sent_at", "order": "id"})
    trips = sb_all("trips", {"select": "route_id,started_at,ended_at,excluded", "order": "id"})
    rows = build_rows(routes, segments, notifications, trips)
    text = render(rows)
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        f.write(text)
    print(f"docs/notebook.md: 알림 {len(rows)}행 · 중복 {sum(1 for x in rows if x['count'] >= 2)}행 "
          f"(routes {len(routes)} · trips {len(trips)})")

if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        sys.exit(f"report 실패: {w.redact(e)}")
