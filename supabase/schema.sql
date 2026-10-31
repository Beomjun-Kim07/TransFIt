-- TransFit 테이블 정의. Supabase SQL Editor에서 실행.

-- 사용자: 텔레그램 채팅 ID가 그대로 기본키
create table users (
  id bigint primary key,
  name text,
  created_at timestamptz default now()
);

-- 경로: 사용자당 여러 개 가능
create table routes (
  id serial primary key,
  user_id bigint references users(id),
  name text not null,
  arrive_by time not null,
  active_days text default 'MTWTF',
  confidence int default 90,
  lead_min int default 30,
  fallback_min int default 40,
  baseline_sec int,
  created_at timestamptz default now()
);

-- 구간: 경로를 순서대로 구성 (kind: walk / subway / transfer / bus)
create table segments (
  id serial primary key,
  route_id int references routes(id),
  seq int not null,
  kind text not null,
  station_from text,
  station_to text,
  line text,
  updn text,
  expected_sec int
);

-- 기록: 조연준 앱의 trips 컬럼과 같은 구조
create table trips (
  id serial primary key,
  user_id bigint references users(id),
  route_id int references routes(id),
  started_at timestamptz not null,
  boarded_at timestamptz,
  ended_at timestamptz,
  source text default 'bot',
  expected_sec int,
  walk_expected_sec int,
  created_at timestamptz default now()
);

-- 수첩: 오늘 무슨 알림을 보냈나 (같은 날 같은 종류는 한 번만)
create table notifications (
  id serial primary key,
  user_id bigint references users(id),
  route_id int references routes(id),
  date date not null,
  kind text not null,
  sent_at timestamptz default now(),
  unique (route_id, date, kind)
);
