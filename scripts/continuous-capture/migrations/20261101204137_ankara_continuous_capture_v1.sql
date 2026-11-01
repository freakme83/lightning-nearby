-- Deliberately applied separately from the worker deployment.
create table public.continuous_capture_strikes (
  event_key text primary key check (event_key ~ '^[0-9a-f]{64}$'),
  event_time timestamptz not null,
  event_time_raw text not null,
  event_time_unit text not null check (event_time_unit in ('seconds','milliseconds','microseconds','nanoseconds')),
  received_at timestamptz not null,
  latitude double precision not null check (latitude between -90 and 90),
  longitude double precision not null check (longitude between -180 and 180),
  provider text not null default 'blitzortung' check (provider = 'blitzortung'),
  source_server text not null check (source_server in ('ws1','ws7','ws8')),
  station_count integer check (station_count >= 0),
  polygon_id text not null
);
create index continuous_capture_strikes_time on public.continuous_capture_strikes (event_time);

-- Each process has its own run ID. Missing checkpoints and run boundaries are
-- uncertain coverage, never evidence that the source was healthy.
create table public.continuous_capture_health (
  run_id uuid not null,
  sequence integer not null,
  observed_at timestamptz not null,
  source_health text not null check (source_health in ('unknown','healthy','unhealthy')),
  reason text not null,
  accepted bigint not null,
  written bigint not null,
  dropped bigint not null,
  failures bigint not null,
  queued integer not null,
  polygon_id text not null,
  primary key (run_id, sequence)
);
create index continuous_capture_health_time on public.continuous_capture_health (observed_at);

alter table public.continuous_capture_strikes enable row level security;
alter table public.continuous_capture_health enable row level security;
revoke all on public.continuous_capture_strikes, public.continuous_capture_health from public, anon, authenticated;
grant select, insert on public.continuous_capture_strikes, public.continuous_capture_health to service_role;
