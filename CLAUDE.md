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
supabase/schema.sql          테이블 v2 (users/routes/segments/trips/trip_events/notifications/trip_alerts/dispatch_log, RLS, 가입 트리거, trips.excluded·ride_train·ride_veh, segments.stop_names, users.alight_alerts)
supabase/functions/route/    Edge Function: 카카오 길찾기 대리 호출 + 버스 arsId(getStationByPos). 배포됨
supabase/functions/telegram/ Edge Function: 텔레그램 웹훅 (/start 연결 코드, trip:ev:<trip>:<seg>:<kind> 버튼 → trip_events, 옛 trip:<컬럼>:<id>도). 배포·setWebhook 완료
supabase/functions/places/   Edge Function: 장소 자동완성 GET ?q= → [{name,address,x,y,category}] (헤더 없이 fetch)
supabase/functions/trip/     Edge Function: 단축어·앱용 기록 API (users.api_token, docs/shortcuts.md). seg_index+kind 또는 옛 step. 탑승이면 탄 차 저장 (웹앱도 탑승 기록 뒤 부름)
supabase/functions/tick/     Edge Function: pg_cron 매분 — 이동 중 카드 고쳐 쓰기, 하차 알림(새 메시지), GitHub 깨우기(watch.yml dispatch)
supabase/functions/_shared/  realtime.ts(실시간 지하철·버스, 탈 차 boardingVehicle, 하차 정거장 rideStops) · trip_message.ts(이동 중 카드) · alight.ts(하차 알림 판단·추정·문구)
                             steps.ts(기록 단계: segments → 단계 목록, trip_events ↔ 옛 컬럼, 진행 상황, 콜백)
                             *_test.ts (deno test), testdata/ = 실제 API 응답 샘플(11/01 16:47·16:49, 키 없음) + trip_events_flow.json(환승 2번, test_watch.py와 공유)
watch.py, test_watch.py      GitHub Actions가 10분마다 실행. Supabase 읽기 → 출발 시각 역산 → 실시간 지하철·버스 → 텔레그램 → notifications 기록
report.py                    매일 23:50 KST 알림 수첩 (docs/notebook.md 커밋, .github/workflows/report.yml)
android/                     조연준 Kotlin·Compose 앱: 지오펜스 자동 기록(집·승차 역·목적지), 분위수·정체 감지·걷기 개인화, 카카오 길찾기·실시간 지하철.
                             지금은 폰 안에서만 동작(Supabase trips 연동 미구현). 키는 루트 .env.local의 KAKAO_REST_KEY·SUBWAY_KEY를 빌드 때 읽음
.github/workflows/watch.yml  스케줄 + 수동 실행(test=true면 즉시 발송)
web/index.html, web/config.js  웹앱 한 장, iOS 스타일 하단 탭 4개 (홈: 경로 카드·기록 버튼···· 구간 수정 / 길찾기: 자동완성 검색→저장 / 기록: 경로 리스트→상세(점 그래프·제외) / 설정: 텔레그램·알림·자동화 토큰). 배포: https://transfit-web.vercel.app
web/manifest.json, web/*.png   PWA(홈 화면 추가, "T" 아이콘 192·512·180). 서비스 워커는 일부러 안 씀 (캐시 때문에 배포 반영이 꼬임)
.env.local                   SUBWAY_KEY, BUS_KEY, BOT_TOKEN, CHAT_ID, SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_KEY, KAKAO_REST_KEY
```

## 외부 자원 (모두 발급 완료)
- Supabase 프로젝트 `transfit` (`https://ezpvhadfzpznzwmhaktp.supabase.co`). 테이블 v2 적용됨. Email 로그인, Confirm email 꺼짐.
- 텔레그램 봇 `@transfit_user_bot`. 범준 채팅 ID (.env.local의 CHAT_ID).
- 서울열린데이터광장 실시간 지하철 키, 공공데이터포털 버스 키(`getStationByUid`), 카카오 REST 키(카카오맵 사용 설정 필요).
- GitHub Actions Secrets 등록됨: SUPABASE_URL, SUPABASE_SERVICE_KEY, BOT_TOKEN, SUBWAY_KEY, BUS_KEY. 수동 실행(test=true)으로 텔레그램 수신 확인함.
- 이 맥엔 node가 없다. Supabase CLI는 Homebrew(`supabase` 2.122.0, 프로젝트 link 완료)라 `npx` 없이 `supabase …`로 실행. Vercel은 CLI 대신 GitHub 연동(Import)으로 배포.

## 핵심 로직 (watch.py / web 공통)
- 소요시간: trips 기록 5회 이상이면 `confidence`% 분위수(선형보간), 아니면 `routes.baseline_sec` → segments 합 → `fallback_min`. `routes.baseline_src`: `'kakao'`(길찾기 저장 때 카카오 totalTime, 기본값) / `'manual'`(웹 구간 수정에서 구간 합으로 바꿈 → 근거 문구 "직접 수정한 예상 기준"). 쓰는 기록 = 도착까지 찍힘 + `excluded`가 true 아님 + 3분~3시간 (웹 기록 탭 "제외" 토글이 `trips.excluded`를 바꾼다).
- 출발 시각 = arrive_by − 소요시간. `pre`(출발 lead_min 전)와 `live`(출발 ±10분, 실시간 열차 보정) 두 번 알림. 같은 날 같은 종류는 `notifications` 유니크로 한 번만.
- 도보 구간 초기값 = 거리 ÷ 3.7 km/h (실험으로 확인한 네이버 상수). 기록이 쌓이면 개인값으로 교체.
- 실시간 지하철: `realtimeStationArrival`, 필드 `barvlDt`(초), `btrainNo`, `updnLine`, `subwayId`(4호선=1004). updn이 비면 watch.py가 방면(다음 역)·종착역·역 ID 순서로 방향을 고른다.
- 실시간 버스: `getStationByUid`, 남은 시간은 `traTime1`/`traTime2`(초) (`exps1`·`mkTm`은 이 서비스에 없음).
- 버스 구간 저장: `station_from` = 승차 arsId, `station_to` = 하차 arsIdTo (route 응답 `steps[].arsId`/`arsIdTo`), 정류장 이름은 `line` 괄호에 — 예: `11211` / `11234` / `1142 (노원역1번출구→노원구청)`. watch.py는 station_from의 5자리로 조회하고 `route_match`가 line에서 노선 번호만 본다. 승차 번호를 못 찾으면 station_from/to에 이름을 두고 watch.py가 이름으로 찾는다.
- 카카오 길찾기 단위: `time`/`totalTime` 초, `distance` m. route 응답 `steps[].stops` = 정거장 이름 목록(승차·하차 포함) → 웹 저장 때 `segments.stop_names`.
- 기록 단계 (`_shared/steps.ts` · 웹 `tripSteps`, plan.md "기록 단계"): 경로 segments에서 출발 → 첫 탈것 승강장 도착 → 탑승 → 하차 → 다음 탑승 … → 목적지 도착(마지막 하차와 합침), 이름 "계양 하차"·"공항철도 탑승". 저장은 `trip_events(trip_id, seg_index, kind platform|board|alight, at)` — 환승 횟수 제한 없음. **옛 컬럼은 첫 값만 같이 채움**(첫 탈 구간 승강장·탑승·하차 → platform_at·boarded_at·transfer_off_at, 두 번째 탑승 → transfer_on_at) → watch.py·report.py·개인 첫 도보 그대로. trip_events 없는 기록은 옛 컬럼을 단계로 읽는다.
- 하차 알림 (tick 매분, `_shared/alight.ts`, plan.md "하차 알림"): 탑승 중 하차 지점까지 남은 정거장 2·1·0에 `sendMessage` 새 메시지, 지금 단계 하나만(2→0이면 0만). 셈은 지하철식(1 = 다음 역이 하차역): 지하철 `arvlCd` 0·1→0, 3·4·5→1, "[N]번째 전역"/`ordkey`→N. **버스 "[N번째 전]"은 N+1, "곧 도착"은 1** (실측: 버스 N = 지나야 할 정류장 수). 탄 차 = 탑승 버튼 때 `boardingVehicle(boarded)` → `trips.ride_train`/`ride_veh`. 못 잡으면 `stop_names` 비례 추정 "(추정)". 중복 = `trip_alerts` 유니크 insert-ignore. 끄기 = `users.alight_alerts`('2,1,0').

## 지금 상태 (2026-11-01 17:50)
- 완료: 1 커밋·push, 2 plan.md 원본 해부(캡처·api.yaml·대응표), 3 도보·환승 역설계 실험, 4 테이블 v2, 5 watch.py 로컬·Actions 실행 성공, 6 Secrets, 7 웹앱 1차(로그인·가입 동작 확인)
  - A `e75da7f`: route 함수 버스 arsId/arsIdTo(getStationByPos), telegram 웹훅(/start 연결, 역사 안 버튼 → trips, secret 검증) — 둘 다 배포, setWebhook 등록
  - A `c74ce7a`: trip 함수(단축어·앱용 trips 기록 API, users.api_token, docs/shortcuts.md). A `cbdf55d`: places 함수(장소 자동완성), route 좌표 입력(fromX/fromY/toX/toY)
  - B `5341692`: 지하철 방향 자동 판정, 버스 실시간(traTime1/traTime2), 키 가리기, test_watch.py. B `393f723`: excluded 기록 계산 제외 (test 38개 통과). B `e31a46d`: pre 알림에 "출발했어요" 버튼(trip:start:<route_id>)
  - B `7ccf1ec`: report.py 알림 수첩 + 매일 23:50 KST 커밋 잡, 알림 문구 개편. B `dad25ff`: 환승 체인(앞 구간에서 고른 차의 대기 시간을 다음 승차 시각에 누적)
  - B `b808e65`: 중복 발송 수정 — 10/31 23:04 pre 2통(원인: insert 뒤 `sent_at` 120초 이내면 내 행으로 본 판단, 2분 안 두 번 실행 시 둘 다 발송) → notifications insert `resolution=ignore-duplicates,return=representation` 응답이 비면 발송 안 함, 발송 실패 시 행 삭제 → 동시 2회 실행에도 1통 확인(23:13 live). B `6c3e628`: cron 3-59/10, concurrency group watch
  - `f572e39`: schema.sql에 trips.excluded (DB엔 이미 적용)
  - C `3f28bd8`: 웹앱 모바일 정리, 텔레그램 연결 새로고침, 단계별 기록 흐름. C `c472c5d`: 경로/기록 탭, 기록 제외 토글, 버스 구간 arsId 저장
  - C `4720584`: 웹 전면 개편 — iOS 스타일 하단 탭 4개(홈·길찾기·기록·설정), 노선 공식 색 구간 막대, 다크 모드, 경로 삭제·lead_min/confidence 편집, 카카오 요금 객체 표시 버그 수정
  - C `5018b64`: PWA(manifest·T 아이콘·홈 화면 추가 안내, 서비스 워커 없음). C `4188cc9`: 길찾기 장소 자동완성(places, 현재 위치·최근 3개, 좌표로 route) + 결과 필터 칩·정렬
  - C `174efc7`: 설정 탭 자동화 토큰 복사·재발급, route_id. C `189eee0`: 웹 출발 시각도 소요 1분 올림(watch.py plan과 일치). C `b57cc88`: 기록 탭 2단 화면(경로 리스트 → 상세·점 그래프, pushState 뒤로가기). C `8259401`: 길찾기 직접 입력 제거, 홈 ··· → 구간 수정
  - C `b591aca`: 설정 자동화 토큰을 맨 아래 "고급 · 자동 기록" 접힘으로. C: 구간 수정 저장 때 구간 합이 baseline_sec와 1분 이상 다르면 출발 기준 갱신 확인 → `baseline_sec`=구간 합, `baseline_src`='manual'. **대기: routes.baseline_src 컬럼 SQL(사용자), watch.py·telegram /next 근거 문구(B·A), schema.sql 반영**
  - C: 길찾기 저장 때 경로의 `originIsStop`/`destIsStop`(A `14d8261`~)이면 "집에서 정류장까지"·"정류장에서 목적지까지" 걷는 분을 스테퍼(기본 5분)로 물어 kind 'walk'·distance_m null 구간을 맨 앞/뒤에 넣고 baseline_sec에 더함(0분이면 안 넣음). route가 붙인 `added:true` 도보는 일반 도보로 저장, 결과 상세에 "(카카오 미제공 · 추정)"
  - 조연준 `b32df54`: 안드로이드 앱 `android/` — main 병합 `80671eb`
  - D 하차 알림 (브랜치 `claude/alight-alerts-feature-3w2dfu`, A·B·C 영역을 한 세션이 맡음 → PR): tick이 탑승 중 매분 하차 지점(환승역·정류장, 최종 하차)까지 남은 정거장을 구해 2정거장 전·1정거장 전·도착에 텔레그램 새 메시지. 실시간(지하철 `arvlCd`·`arvlMsg2`·`ordkey`, 버스 `arrmsg` "[N번째 전]"+1) → 못 잡으면 `stop_names` 비례 추정 "(추정)". `trip_alerts` 중복 방지, `users.alight_alerts` + 웹 설정 스위치 3개, 탑승 버튼(텔레그램·trip 함수·웹→trip 함수) 때 탄 차를 `ride_train`/`ride_veh`에 저장, 이동 중 카드에 "🚏 노원 하차까지 2정거장", route `steps[].stops` → 웹 저장 `stop_names`, 경로 상세에 "N개 역". 테스트: `alight_test.ts` 16개(실제 응답 testdata), realtime_test 21개, test_watch.py 80 OK(실제 DB 시험 2곳은 service 키 없는 환경이라 건너뜀). → SQL·배포 완료 (아래 E와 같이)
  - E 기록 단계 trip_events (같은 브랜치·PR, 환승 횟수 제한 없음): 단계 목록을 segments에서 만들고("계양 하차"·"공항철도 탑승"·"서울역 하차"·"4호선 탑승", 마지막 하차 = 목적지 도착) `trip_events`에 기록. 웹 홈 큰 버튼·되돌리기·기록 상세, 텔레그램 `trip:ev:<trip>:<seg>:<kind>`(옛 형식도), tick 카드("🔄 환승 이동 · 다음 4호선"), trip 함수 `seg_index`+`kind`(옛 `step`도), 하차 알림 세 번째 탈 구간까지. 옛 컬럼 첫 값만 같이 채움. telegram 🏁 메시지 "예상 없음" 버그(로컬 estimateDuration이 [초, 근거]를 돌려줌) 같이 고침. 테스트: steps_test 9개, alight_test 16개, realtime_test 21개, test_watch.py 88 OK(+8: 같은 픽스처로 watch.py·report.py·개인 첫 도보), 로컬 Postgres 16에서 SQL(옛 main 스키마 + 기록 → 옮기기 1·2회, RLS) 확인. **11/01 17:43 반영**: SQL ①+② 실행(확인 쿼리 13줄 ✅), 함수 배포 tick v13·telegram v11·trip v5(`--no-verify-jwt` 유지)·route v9(verify_jwt 유지) — 배포 뒤 확인: route 응답 `steps[].stops`(7호선 노원→수락산 = 노원·마들·수락산), trip 새 오류 문구, telegram 부팅. PR #1 (https://github.com/Beomjun-Kim07/TransFIt/pull/1) — **웹 변경(설정 스위치·stop_names 저장·trip_events 버튼)은 머지 후 Vercel 배포부터**. 배포는 `config.toml`이 없어 `supabase functions deploy tick telegram trip --no-verify-jwt --use-api --project-ref …` / `route`는 플래그 없이 (플래그 빠지면 텔레그램 웹훅 401)
  - **웹앱 배포: https://transfit-web.vercel.app** (Vercel GitHub 연동, Root Directory `web`, main push마다 자동 재배포. 배포본 = 저장소 `web/index.html` 확인)
  - README: 소개·배포 URL·데이터 출처. 저장소에 비밀 키·HAR 없음 확인 (공개 키 `web/config.js`, 채팅 ID만 있음)
  - 버스 정류소정보조회 승인 확인 (실제 호출 정상)
- 진행 중·남은 것: 아래 "남은 일"

## 남은 일 (2026-11-01 기준)
- **A (함수)**: 탑승 버튼 때 탄 차 저장·탑승 중 하차 지점 실시간은 D 하차 알림으로 끝남(SQL·배포 완료). 남은 것: `firstWalkSec`(개인 첫 도보)를 `_shared/trip_message.ts` 이동 중 카드에 연결, `rideEta`로 이동 중 카드 도착 예상 보정.
- **B (알림)**: watch.yml cron을 `'17,47 * * * *'`(30분 보험, 평소엔 tick이 workflow_dispatch로 깨움)로, Actions 조회는 `GH_DISPATCH_TOKEN` 사용. **11/01 확인: 아직 안 됨** — watch.yml은 `3-59/10` 그대로, tick엔 dispatch만 있고 실행 조회 코드 없음.
- **사용자**: B cron 변경이 push된 뒤 저장소 private 전환 → 키 교체(SUPABASE secret, KAKAO, TELEGRAM_SECRET, GH_DISPATCH_TOKEN, BOT_TOKEN). 순서·넣을 곳은 A가 체크리스트로 제공.
- **사용자 폰 확인** (https://transfit-web.vercel.app): ① 구간 수정 저장(출발 기준 갱신 확인 포함) ② 기록 탭 상세 스와이프 뒤로가기 ③ 정류장·역에서 출발/도착하는 경로 저장 때 걷는 시간 시트(저장 뒤 홈 예상 분이 고른 분만큼 늘어나는지) ④ 하차 알림: SQL·배포 뒤 경로를 **다시 저장**(정거장 목록 `stop_names`는 새로 저장한 경로부터 들어감) → 텔레그램 탑승 버튼 → 2정거장 전·다음 역·도착 새 메시지가 한 번씩 오는지, 설정 탭 스위치로 끈 단계가 안 오는지 ⑤ 환승 2번 경로(인천1→공항철도→4호선)에서 큰 버튼이 "계양 하차 → 공항철도 탑승 → 서울역 하차 → 4호선 탑승 → 목적지 도착"으로 끝까지 가는지, ··· 되돌리기, 기록 탭 상세 줄.
- **조연준**: 안드로이드 앱 → `trip` 함수(api_token) 연동, `feat/android-app` 브랜치. 환승 2번 이상이면 `step` 대신 `seg_index`+`kind`(docs/shortcuts.md), 응답 `next`를 다음 요청에 그대로.
- **결정 대기**: 웹앱 자체 알림(텔레그램 없이) — 할지 말지.
- 이전 목록에서 넘어온 것: Supabase Site URL 등록(사용자) · 반복 방지 검사(아래 5) · watch.py/telegram `baseline_src` 근거 문구(B·A, 아직 코드에 없음. 컬럼은 DB에 있음 — 11/01 확인 쿼리, schema.sql 반영됨) · plan.md 나머지·1분 발표 대본(C).

## 처음 할 일 목록 (기록용 — 남은 건 위 "남은 일")
1. ✅ (A `e75da7f`) **Edge Function `route` 배포**: `supabase login` → `supabase link --project-ref ezpvhadfzpznzwmhaktp` → `supabase secrets set KAKAO_REST_KEY=… BUS_KEY=…`(값은 .env.local에서) → `supabase functions deploy route`. 카카오 `time` 단위는 초로 확인됨.
2. ✅ (A `e75da7f`) **텔레그램 연결 함수** `supabase/functions/telegram/index.ts`: 텔레그램 웹훅. `/start <link_code>` 수신 → `users.link_code`로 찾아 `telegram_chat_id` 저장 → "연결됐어요" 답장. `setWebhook`으로 등록. 이후 역사 안 버튼(열차 탐/환승 하차/환승 탑승)도 같은 함수에서 `callback_query`로 받아 `trips`에 적는다.
3. ✅ (B `5341692`) **지하철 방향(updn) 자동 결정**: 카카오 응답엔 방향이 없다. 실시간 API의 `trainLineNm`("성수행 - 홍대입구방면")에서 다음 역/종점을 보고 segments.updn을 채우거나, watch.py에서 방면으로 필터한다.
4. ✅ (배포 https://transfit-web.vercel.app, plan.md 기록) **Vercel 배포**: `web/`를 루트로. 남은 것: Supabase Authentication → URL Configuration에 Site URL 등록.
5. **반복 방지 검사**: 로그인 계정으로 경로 하나 만들고 arrive_by를 지금+70분으로 잠시 바꿔 Actions가 pre/live를 한 번씩만 보내는지 확인. 끝나면 원래 값으로.
6. ✅ (B `5341692`, 웹 저장 C) **버스 구간 실시간**: `getStationByUid`(`traTime1`/`traTime2` 초, `rtNm`, `vehId1`)를 watch.py `live_lines`에 추가. segments.kind='bus'는 station_from=arsId, station_to=arsIdTo (위 "버스 구간 저장").
7. ✅ README(데이터 출처, 키·HAR 없음 확인). 남은 것: plan.md 나머지 섹션 채우기. 1분 발표 대본("네이버 도보 = 거리÷3.7km/h, 환승 = 역별 상수. 우리는 그 상수를 사용자 변수로 바꿨다").
8. 시간 남으면: 구글 로그인, iOS 단축어/안드로이드 앱(조연준)에서 trips 자동 기록, Capacitor로 앱 포장.

## 조연준 (팀원) 참고
Kotlin 안드로이드 앱이 `android/`로 올라왔다(`b32df54`, main 병합 `80671eb`). 지오펜스 자동 기록·분위수·정체 감지·카카오 길찾기·실시간 지하철이 있다. 다음 단계는 그 앱이 Supabase `trips`에 같은 형식으로 쓰는 것 — `trip` 함수(api_token)를 쓰면 된다. `android/`는 조연준 영역이라 A·B·C 세션은 고치지 않는다. REA로 네이버 지도를 분석한 결과는 plan.md 대응표에 반영돼 있다.

## 병렬 작업 규칙 (Claude Code 3개 동시 실행)
같은 폴더에서 세 세션이 돈다. **자기 영역 파일만** 고치고 커밋한다. 다른 영역 파일에 바꿀 게 있으면 고치지 말고 사용자에게 말한다.
- **A (함수)**: `supabase/functions/**` — route 배포, telegram 웹훅(연결 코드, 역사 안 버튼)
- **B (알림)**: `watch.py`, `.github/**` — 지하철 방향 자동 결정, 버스 실시간, 반복 방지 검사
- **C (웹·문서)**: `web/**`, `README.md`, `plan.md`, `CLAUDE.md` — 웹앱, Vercel 배포, 문서. CLAUDE.md "지금 상태" 갱신은 C만 한다.

커밋: `git add <자기 파일들>` 로 자기 파일만 올리고, `git pull --rebase` 후 `git push`. `git add -A`는 쓰지 않는다. 충돌이 나면 사용자에게 보여주고 멈춘다.
