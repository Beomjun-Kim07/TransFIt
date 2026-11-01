-- TransFit 테이블 정의 v2 (로그인 계정 기준). Supabase SQL Editor에서 실행.
-- 처음 실행이 아니면 아래 drop으로 지우고 다시 만든다 (테스트 데이터만 있을 때).

drop table if exists trip_alerts, dispatch_log, notifications, trips, segments, routes, users cascade;

-- 사용자: Supabase 로그인 계정(auth.users)과 1:1. 텔레그램은 나중에 연결.
create table users (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  telegram_chat_id bigint unique,
  link_code text unique,            -- 봇 연결용 일회 코드 (t.me/봇?start=코드)
  api_token text unique default replace(gen_random_uuid()::text, '-', ''),  -- 단축어·앱 자동 기록용 (Edge Function trip)
  alight_alerts text default '2,1,0', -- 하차 알림 켠 단계: 2 = 2정거장 전, 1 = 1정거장 전, 0 = 도착 ('' = 모두 끔, 웹 설정 탭)
  created_at timestamptz default now()
);

-- 기존 DB에 api_token 추가할 때 (한 번만):
-- alter table users add column if not exists api_token text unique default replace(gen_random_uuid()::text, '-', ''); update users set api_token = replace(gen_random_uuid()::text, '-', '') where api_token is null;

-- 로그인하면 users 행을 자동으로 만든다
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.users (id, email, link_code)
  values (new.id, new.email, substr(md5(random()::text || new.id::text), 1, 12))
  on conflict (id) do nothing;
  return new;
end $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- 경로: 사용자당 여러 개 (등교·하교 따로)
create table routes (
  id serial primary key,
  user_id uuid references users(id) on delete cascade,
  name text not null,
  arrive_by time not null,
  active_days text default 'MTWTF',
  confidence int default 90,
  lead_min int default 30,
  fallback_min int default 40,
  baseline_sec int,
  baseline_src text default 'kakao', -- baseline_sec 출처: 'kakao'(길찾기 저장 때 totalTime) / 'manual'(웹 구간 수정에서 구간 합)
  created_at timestamptz default now()
);

-- 구간: 경로를 순서대로 구성 (kind: walk / subway / transfer / bus)
create table segments (
  id serial primary key,
  route_id int references routes(id) on delete cascade,
  seq int not null,
  kind text not null,
  station_from text,
  station_to text,
  line text,
  updn text,
  distance_m int,                   -- 도보 구간: 초기 예상 = 거리 ÷ 3.7 km/h (네이버와 같은 기준)
  expected_sec int,
  stop_names jsonb                  -- 지하철·버스: 정거장 이름 배열(승차·하차 포함, 카카오 stops). 하차 알림 비례 추정용
);

-- 기록: 실외는 자동(지오펜스/단축어), 실내는 버튼
create table trips (
  id serial primary key,
  user_id uuid references users(id) on delete cascade,
  route_id int references routes(id) on delete cascade,
  started_at timestamptz not null,  -- 집 출발
  platform_at timestamptz,          -- 승강장 도착 (버튼)
  boarded_at timestamptz,           -- 열차 탑승 (버튼)
  transfer_off_at timestamptz,      -- 환승역 하차 (버튼)
  transfer_on_at timestamptz,       -- 환승 열차 탑승 (버튼)
  ended_at timestamptz,             -- 목적지 도착
  source text default 'web',
  expected_sec int,
  walk_expected_sec int,
  excluded boolean default false,   -- true면 소요시간 계산에서 제외 (이상치·잘못 누른 기록)
  live_msg_id bigint,               -- 이동 중 안내 텔레그램 message_id (Edge Function tick이 고쳐 씀, 도착 후 null)
  ride_train text,                  -- 지금 탄 지하철 열차 번호 btrainNo (탑승·환승 탑승 버튼 때 boardingVehicle, 하차 알림이 따라감)
  ride_veh text,                    -- 지금 탄 버스 차량 ID vehId (같은 때). 못 정하면 둘 다 null → 하차 알림은 추정
  created_at timestamptz default now()
);

-- 기존 DB에 live_msg_id 추가할 때 (한 번만):
-- alter table trips add column if not exists live_msg_id bigint;

-- 수첩: 오늘 무슨 알림을 보냈나 (같은 날 같은 종류는 한 번만)
create table notifications (
  id serial primary key,
  user_id uuid references users(id) on delete cascade,
  route_id int references routes(id) on delete cascade,
  date date not null,
  kind text not null,
  sent_at timestamptz default now(),
  unique (route_id, date, kind)
);

-- 하차 알림 수첩: trip의 탄 구간(seg_index = segments를 seq 순으로 놓은 0부터 index)마다 단계(kind '2'·'1'·'0')를 한 번만.
-- tick이 보내기 전에 ignore-duplicates로 넣고, 응답이 비면(다른 실행이 먼저 넣음) 안 보낸다. 발송 실패면 행을 지운다.
create table trip_alerts (
  id serial primary key,
  trip_id int references trips(id) on delete cascade,
  seg_index int not null,
  kind text not null,               -- '2' 2정거장 전 / '1' 1정거장 전 / '0' 도착
  source text,                      -- 'live' 실시간 / 'estimate' 추정
  sent_at timestamptz default now(),
  unique (trip_id, seg_index, kind)
);

-- 기존 DB에 하차 알림 추가할 때 (한 번만, 여러 번 실행해도 안전):
-- alter table users add column if not exists alight_alerts text default '2,1,0';
-- alter table segments add column if not exists stop_names jsonb;
-- alter table trips add column if not exists ride_train text; alter table trips add column if not exists ride_veh text;
-- alter table routes add column if not exists baseline_src text default 'kakao';
-- create table if not exists trip_alerts (…위와 같음…); alter table trip_alerts enable row level security; (정책은 아래)

-- 깨우기 기록: tick이 watch.yml을 workflow_dispatch로 돌린 시각 (4분 안 재호출 방지)
create table dispatch_log (
  id serial primary key,
  route_id int references routes(id) on delete set null,
  kind text,                        -- pre / live (깨운 계기가 된 알림)
  dispatched_at timestamptz default now()
);
-- 기존 DB에 추가할 때 (한 번만):
-- create table if not exists dispatch_log (id serial primary key, route_id int references routes(id) on delete set null, kind text, dispatched_at timestamptz default now()); alter table dispatch_log enable row level security;

-- 행 단위 접근 제어: 로그인한 사람은 자기 것만. service_role(watch.py, 봇)은 전부.
alter table users enable row level security;
alter table routes enable row level security;
alter table segments enable row level security;
alter table trips enable row level security;
alter table notifications enable row level security;
alter table dispatch_log enable row level security;   -- 정책 없음 = service_role만
alter table trip_alerts enable row level security;    -- 쓰기는 service_role(tick)만, 읽기는 내 trip 것만

create policy "own user" on users for all using (auth.uid() = id) with check (auth.uid() = id);
create policy "own routes" on routes for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own segments" on segments for all
  using (exists (select 1 from routes r where r.id = route_id and r.user_id = auth.uid()))
  with check (exists (select 1 from routes r where r.id = route_id and r.user_id = auth.uid()));
create policy "own trips" on trips for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own notifications" on notifications for select using (auth.uid() = user_id);
create policy "own trip_alerts" on trip_alerts for select
  using (exists (select 1 from trips t where t.id = trip_id and t.user_id = auth.uid()));
