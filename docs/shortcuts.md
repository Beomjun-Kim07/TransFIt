# 아이폰 단축어로 자동 기록하기 (Edge Function `trip`)

출발·승강장 도착·탑승·환승·도착 시각을 아이폰 단축어가 서버에 보내면 `trips`에 기록되고, 텔레그램으로 "🚉 승강장 도착 기록됨" 한 줄이 옵니다. 지오펜스(집을 나설 때, 역에 도착했을 때) 자동화에 붙이면 버튼을 안 눌러도 기록이 쌓입니다.

## 준비
- **토큰**: 웹앱 **설정 탭 → "자동화 토큰 복사"** 로 복사합니다. 토큰은 비밀번호처럼 다루고, 문서·채팅에 붙이지 마세요. (유출되면 설정 탭에서 다시 만들면 됩니다.)
- **route_id**: 설정 탭의 경로 목록에서 확인 (숫자).

## 요청 형식
```
POST https://ezpvhadfzpznzwmhaktp.supabase.co/functions/v1/trip
Content-Type: application/json

{"token": "<설정 탭에서 복사>", "route_id": 1, "step": "platform_at"}
```

| step | 뜻 | 텔레그램 메시지 |
|---|---|---|
| `start` | 집 출발 (오늘 첫 호출이면 새 기록 생성) | 🚶 출발 기록됨 |
| `platform_at` | 승강장 도착 | 🚉 승강장 도착 기록됨 |
| `boarded_at` | 열차 탑승 | 🚇 열차 탑승 기록됨 |
| `transfer_off_at` | 환승역 하차 | 🔄 환승 하차 기록됨 |
| `transfer_on_at` | 환승 열차 탑승 | 🚇 환승 탑승 기록됨 |
| `ended_at` | 목적지 도착 (소요시간 계산) | 🏁 도착 기록됨 · 오늘 52분 10초 |

응답:
```json
{"ok": true, "trip_id": 12, "step": "platform_at", "next_step": "boarded_at", "duplicate": false}
```
- `next_step`: 다음에 보낼 단계. `ended_at` 뒤엔 `null`.
- `duplicate: true`: 이미 적힌 단계를 또 보낸 것. 무시되고 텔레그램도 안 옵니다.
- `start` 전에 다른 단계를 보내면 `409 {"ok":false,"error":"오늘 시작한 기록이 없어요..."}`.
- 하루 기준은 한국 시간 0시. 어제 `start`만 하고 `ended_at`을 안 보냈으면 오늘 `start`가 새 기록을 만듭니다.

## 단축어 만들기 (단계별 하나씩, 예: "승강장 도착")
1. 단축어 앱 → **+** → 이름 "TransFit 승강장".
2. 동작 추가 → **사전(Dictionary)**. 항목 3개:
   - `token` (텍스트): 설정 탭에서 복사한 값
   - `route_id` (숫자): 내 경로 번호
   - `step` (텍스트): `platform_at`
3. 동작 추가 → **URL 내용 가져오기(Get Contents of URL)**:
   - URL: `https://ezpvhadfzpznzwmhaktp.supabase.co/functions/v1/trip`
   - 방식: **POST**
   - 헤더: `Content-Type` = `application/json`
   - 요청 본문: **JSON** → 위 **사전** 변수를 본문으로 선택 (또는 본문을 "파일"로 두고 사전을 넣어도 됨)
4. (선택) **알림 보이기** 동작에 "URL 내용" 결과를 넣으면 응답을 바로 볼 수 있습니다.
5. 같은 방법으로 `start`, `boarded_at`, `ended_at` 단축어를 만들거나, 하나의 단축어에서 **입력 묻기**로 step을 고르게 해도 됩니다.

## 자동화에 붙이기 (버튼 없이)
단축어 앱 → **자동화** → **+** → **도착**(또는 **출발**) → 장소 지정 → "즉시 실행" 켜기 → 위 단축어 선택.
- 집 **출발** → `start`
- 역 **도착** → `platform_at`
- 학교 **도착** → `ended_at`
- 승강장에서 열차 탑승·환승은 지오펜스로 잡기 어려우므로 텔레그램 버튼(또는 잠금화면 단축어)으로 누릅니다.

## 터미널에서 테스트 (토큰은 환경변수로)
```sh
curl -s -X POST https://ezpvhadfzpznzwmhaktp.supabase.co/functions/v1/trip \
  -H 'Content-Type: application/json' \
  -d "{\"token\":\"$TRANSFIT_TOKEN\",\"route_id\":1,\"step\":\"start\"}"
```
