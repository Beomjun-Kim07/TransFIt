# TransFit — Claude Code 인수인계

THE해커톤 CAMPUS 5조(김범준·조연준) 프로젝트. 네이버 지도 대중교통 길찾기를 역설계해서, "평균 사람" 상수로 계산되는 소요시간을 **사용자별 실제 기록**으로 바꾸고, 도착 마감 시각에서 역산한 **출발 시각을 텔레그램으로 알려주는** 서비스. 상세 설계는 `plan.md`에 있고, 매뉴얼 규칙(공개 API만, 비공개 주소 호출 금지, 키는 코드에 안 씀, 원본 로고 미사용)은 반드시 지킨다.

## 대화 규칙
- 한국어로 답한다. 한 번에 하나의 복붙·행동 단위만 제시하고, 결과를 확인한 뒤 다음으로 간다.
- 사용자는 키·토큰을 채팅에 붙이지 않는다. 값은 `.env.local`에만 있고, Claude는 그 값을 출력하지 않는다.
- 커밋 전 `git status`로 `.env.local`, `.DS_Store`, HAR 파일이 안 올라가는지 확인한다.
- 네이버의 비공개 주소(`map.naver.com/p/api/*`)는 절대 호출하지 않는다. 보기만 한 것이다.

## 구조
```
plan.md                      설계·원본 해부·실험 결과 (매뉴얼 5.3 양식)
docs/api.yaml                mitmproxy2swagger 산출물 (네이버 비공개 API 명세, 참고용)
docs/navermap_screenshot/    네이버 지도 앱 캡처 26장
supabase/schema.sql          테이블 v2 (users/routes/segments/trips/notifications, RLS, 가입 트리거, trips.excluded)
supabase/functions/route/    Edge Function: 카카오 길찾기 대리 호출 + 버스 arsId(getStationByPos). 배포됨
supabase/functions/telegram/ Edge Function: 텔레그램 웹훅 (/start 연결 코드, trip:<단계>:<id> 버튼 → trips). 배포·setWebhook 완료
watch.py, test_watch.py      GitHub Actions가 10분마다 실행. Supabase 읽기 → 출발 시각 역산 → 실시간 지하철·버스 → 텔레그램 → notifications 기록
.github/workflows/watch.yml  스케줄 + 수동 실행(test=true면 즉시 발송)
web/index.html, web/config.js  웹앱 한 장, iOS 스타일 하단 탭 4개 (홈: 경로 카드·기록 버튼 / 길찾기: 검색→저장·직접 입력 / 기록: 요약·제외 / 설정: 텔레그램·알림). 배포: https://transfit-web.vercel.app
.env.local                   SUBWAY_KEY, BUS_KEY, BOT_TOKEN, CHAT_ID, SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_KEY, KAKAO_REST_KEY
```

## 외부 자원 (모두 발급 완료)
- Supabase 프로젝트 `transfit` (`https://ezpvhadfzpznzwmhaktp.supabase.co`). 테이블 v2 적용됨. Email 로그인, Confirm email 꺼짐.
- 텔레그램 봇 `@transfit_user_bot`. 범준 채팅 ID (.env.local의 CHAT_ID).
- 서울열린데이터광장 실시간 지하철 키, 공공데이터포털 버스 키(`getStationByUid`), 카카오 REST 키(카카오맵 사용 설정 필요).
- GitHub Actions Secrets 등록됨: SUPABASE_URL, SUPABASE_SERVICE_KEY, BOT_TOKEN, SUBWAY_KEY, BUS_KEY. 수동 실행(test=true)으로 텔레그램 수신 확인함.
- 이 맥엔 node가 없다. Supabase CLI는 Homebrew(`supabase` 2.122.0, 프로젝트 link 완료)라 `npx` 없이 `supabase …`로 실행. Vercel은 CLI 대신 GitHub 연동(Import)으로 배포.

## 핵심 로직 (watch.py / web 공통)
- 소요시간: trips 기록 5회 이상이면 `confidence`% 분위수(선형보간), 아니면 `routes.baseline_sec` → segments 합 → `fallback_min`. 쓰는 기록 = 도착까지 찍힘 + `excluded`가 true 아님 + 3분~3시간 (웹 기록 탭 "제외" 토글이 `trips.excluded`를 바꾼다).
- 출발 시각 = arrive_by − 소요시간. `pre`(출발 lead_min 전)와 `live`(출발 ±10분, 실시간 열차 보정) 두 번 알림. 같은 날 같은 종류는 `notifications` 유니크로 한 번만.
- 도보 구간 초기값 = 거리 ÷ 3.7 km/h (실험으로 확인한 네이버 상수). 기록이 쌓이면 개인값으로 교체.
- 실시간 지하철: `realtimeStationArrival`, 필드 `barvlDt`(초), `btrainNo`, `updnLine`, `subwayId`(4호선=1004). updn이 비면 watch.py가 방면(다음 역)·종착역·역 ID 순서로 방향을 고른다.
- 실시간 버스: `getStationByUid`, 남은 시간은 `traTime1`/`traTime2`(초) (`exps1`·`mkTm`은 이 서비스에 없음).
- 버스 구간 저장: `station_from` = 승차 arsId, `station_to` = 하차 arsIdTo (route 응답 `steps[].arsId`/`arsIdTo`), 정류장 이름은 `line` 괄호에 — 예: `11211` / `11234` / `1142 (노원역1번출구→노원구청)`. watch.py는 station_from의 5자리로 조회하고 `route_match`가 line에서 노선 번호만 본다. 승차 번호를 못 찾으면 station_from/to에 이름을 두고 watch.py가 이름으로 찾는다.
- 카카오 길찾기 단위: `time`/`totalTime` 초, `distance` m.

## 지금 상태 (2026-10-31 20:40)
- 완료: 1 커밋·push, 2 plan.md 원본 해부(캡처·api.yaml·대응표), 3 도보·환승 역설계 실험, 4 테이블 v2, 5 watch.py 로컬·Actions 실행 성공, 6 Secrets, 7 웹앱 1차(로그인·가입 동작 확인)
  - A `e75da7f`: route 함수 버스 arsId/arsIdTo(getStationByPos), telegram 웹훅(/start 연결, 역사 안 버튼 → trips, secret 검증) — 둘 다 배포, setWebhook 등록
  - B `5341692`: 지하철 방향 자동 판정, 버스 실시간(traTime1/traTime2), 키 가리기, test_watch.py. B `393f723`: excluded 기록 계산 제외 (test 38개 통과). B `e31a46d`: pre 알림에 "출발했어요" 버튼(trip:start:<route_id>)
  - `f572e39`: schema.sql에 trips.excluded (DB엔 이미 적용)
  - C `3f28bd8`: 웹앱 모바일 정리, 텔레그램 연결 새로고침, 단계별 기록 흐름. C `c472c5d`: 경로/기록 탭, 기록 제외 토글, 버스 구간 arsId 저장. C(이번): 웹 전면 개편 — iOS 스타일 하단 탭 4개(홈·길찾기·기록·설정), 노선 공식 색 구간 막대, 다크 모드, 경로 삭제·lead_min/confidence 편집, 카카오 요금 객체 표시 버그 수정
  - **웹앱 배포: https://transfit-web.vercel.app** (Vercel GitHub 연동, Root Directory `web`, main push마다 자동 재배포. 배포본 = 저장소 `web/index.html` 확인)
  - README: 소개·배포 URL·데이터 출처. 저장소에 비밀 키·HAR 없음 확인 (공개 키 `web/config.js`, 채팅 ID만 있음)
  - 버스 정류소정보조회 승인 확인 (실제 호출 정상)
- 진행 중: C — Supabase Site URL 등록(사용자), 폰에서 배포본 확인, plan.md 나머지·발표 대본

## 다음 할 일 (순서대로)
1. ✅ (A `e75da7f`) **Edge Function `route` 배포**: `supabase login` → `supabase link --project-ref ezpvhadfzpznzwmhaktp` → `supabase secrets set KAKAO_REST_KEY=… BUS_KEY=…`(값은 .env.local에서) → `supabase functions deploy route`. 카카오 `time` 단위는 초로 확인됨.
2. ✅ (A `e75da7f`) **텔레그램 연결 함수** `supabase/functions/telegram/index.ts`: 텔레그램 웹훅. `/start <link_code>` 수신 → `users.link_code`로 찾아 `telegram_chat_id` 저장 → "연결됐어요" 답장. `setWebhook`으로 등록. 이후 역사 안 버튼(열차 탐/환승 하차/환승 탑승)도 같은 함수에서 `callback_query`로 받아 `trips`에 적는다.
3. ✅ (B `5341692`) **지하철 방향(updn) 자동 결정**: 카카오 응답엔 방향이 없다. 실시간 API의 `trainLineNm`("성수행 - 홍대입구방면")에서 다음 역/종점을 보고 segments.updn을 채우거나, watch.py에서 방면으로 필터한다.
4. ✅ (배포 https://transfit-web.vercel.app, plan.md 기록) **Vercel 배포**: `web/`를 루트로. 남은 것: Supabase Authentication → URL Configuration에 Site URL 등록.
5. **반복 방지 검사**: 로그인 계정으로 경로 하나 만들고 arrive_by를 지금+70분으로 잠시 바꿔 Actions가 pre/live를 한 번씩만 보내는지 확인. 끝나면 원래 값으로.
6. ✅ (B `5341692`, 웹 저장 C) **버스 구간 실시간**: `getStationByUid`(`traTime1`/`traTime2` 초, `rtNm`, `vehId1`)를 watch.py `live_lines`에 추가. segments.kind='bus'는 station_from=arsId, station_to=arsIdTo (위 "버스 구간 저장").
7. ✅ README(데이터 출처, 키·HAR 없음 확인). 남은 것: plan.md 나머지 섹션 채우기. 1분 발표 대본("네이버 도보 = 거리÷3.7km/h, 환승 = 역별 상수. 우리는 그 상수를 사용자 변수로 바꿨다").
8. 시간 남으면: 구글 로그인, iOS 단축어/안드로이드 앱(조연준)에서 trips 자동 기록, Capacitor로 앱 포장.

## 조연준 (팀원) 참고
Kotlin 안드로이드 앱 `~/departure`(조연준 맥에만 있음, 미push)에 지오펜스 자동 기록·분위수·정체 감지·카카오 길찾기 연동이 이미 있다. push되면 그 앱이 Supabase `trips`에 같은 형식으로 쓰도록 연결한다. REA로 네이버 지도를 분석한 결과는 plan.md 대응표에 반영돼 있다.

## 병렬 작업 규칙 (Claude Code 3개 동시 실행)
같은 폴더에서 세 세션이 돈다. **자기 영역 파일만** 고치고 커밋한다. 다른 영역 파일에 바꿀 게 있으면 고치지 말고 사용자에게 말한다.
- **A (함수)**: `supabase/functions/**` — route 배포, telegram 웹훅(연결 코드, 역사 안 버튼)
- **B (알림)**: `watch.py`, `.github/**` — 지하철 방향 자동 결정, 버스 실시간, 반복 방지 검사
- **C (웹·문서)**: `web/**`, `README.md`, `plan.md`, `CLAUDE.md` — 웹앱, Vercel 배포, 문서. CLAUDE.md "지금 상태" 갱신은 C만 한다.

커밋: `git add <자기 파일들>` 로 자기 파일만 올리고, `git pull --rebase` 후 `git push`. `git add -A`는 쓰지 않는다. 충돌이 나면 사용자에게 보여주고 멈춘다.
