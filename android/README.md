# TransFit Android (출발 알리미)

Kotlin + Jetpack Compose 앱. 집을 나서는 순간과 목적지에 도착하는 순간을 **지오펜스로 자동 기록**하고, 기록으로 **출발 시각을 역산**해 알려줍니다. 서버 없이 폰 안에서 돕니다.

## 기능
- 지오펜스 3개(집·승차 역·목적지)로 출발/역 도착/도착 시각 자동 기록 (`TripRecorder`)
- 소요시간 계산 (`Estimator`): 내 기록이 5회 이상이면 90% 분위수, 아니면 카카오 길찾기 기준값
- 정체 의심 감지 (`Congestion`): 같은 요일·30분 시간대가 기준보다 5분(또는 15%) 이상 느린 날이 서로 다른 날짜로 2번 이상 반복되면 반영
- 집→역 걷기 시간 개인화 (`Walking`), 실시간 지하철 도착과 결합한 "지금 출발하면" 안내 (`Live`)
- 장소 검색(카카오 로컬), 대중교통·도보 길찾기(카카오), 지하철 실시간 도착(서울열린데이터광장)

## 준비
1. JDK 17, Android SDK (compileSdk 37). 기본 Java가 17이 아니면 `JAVA_HOME` 또는 `~/.gradle/gradle.properties`의 `org.gradle.java.home`로 JDK 17을 지정합니다.
2. 키 설정: **저장소 루트의 `.env.local`**(없으면 `android/.env.local`)에 아래 이름으로 넣습니다. `.env.local.example` 참고. 이 파일은 git에 올라가지 않습니다.
   ```
   KAKAO_REST_KEY=...
   SUBWAY_KEY=...
   ```
   키가 없어도 빌드는 되고, 해당 기능만 꺼집니다.

## 빌드·설치
```
cd android
./gradlew testDebugUnitTest assembleDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk
```
폰에서 설정 탭의 권한 점검(위치 "항상 허용", 알림, 정확한 알람, 배터리 제한 해제)을 모두 켜야 자동 기록이 됩니다.

## 주의
- **APK 안에 API 키가 들어갑니다.** 빌드한 APK를 다른 사람에게 주거나 올리지 마세요.
- 서울 지하철 실시간 API는 HTTP만 지원해서, `res/xml/network_security_config.xml`에서 이 호스트 하나만 평문 통신을 허용합니다.
- 비공개 주소(`map.naver.com/p/api/*`)는 호출하지 않습니다.

## 다음 할 일
- 기록을 Supabase `trips`에 같은 형식으로 쓰기 (`/CLAUDE.md`의 trips 스키마 참고) — 아직 미구현
- 버스 실시간 도착 (버스 키 발급 후)
