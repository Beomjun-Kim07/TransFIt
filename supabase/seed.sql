-- 테스트용 경로 한 줄. Supabase SQL Editor에서 실행.
-- 노원역(4호선) → 동대문역사문화공원 환승 → 신촌(2호선) → 연세대, 09:00 도착 목표.
-- 사용자 id는 텔레그램 채팅 ID.

insert into users (id, name) values (5991126583, '범준')
on conflict (id) do nothing;

insert into routes (user_id, name, arrive_by, active_days, confidence, lead_min, fallback_min, baseline_sec)
values (5991126583, '집 → 연세대 신촌', '09:00', 'MTWTF', 90, 30, 40, 65*60)
returning id;

-- 위 returning으로 나온 id가 1이라고 가정 (첫 경로). 아니면 아래 route_id를 바꾼다.
insert into segments (route_id, seq, kind, station_from, station_to, line, updn, expected_sec) values
(1, 1, 'walk',     '집',              '노원',            null,    null,   8*60),
(1, 2, 'subway',   '노원',            '동대문역사문화공원', '4호선', '하행', 25*60),
(1, 3, 'transfer', '동대문역사문화공원', '동대문역사문화공원', '4→2',  null,   5*60),
(1, 4, 'subway',   '동대문역사문화공원', '신촌',            '2호선', '외선', 15*60),
(1, 5, 'walk',     '신촌',            '연세대 강의실',     null,    null,   12*60);
