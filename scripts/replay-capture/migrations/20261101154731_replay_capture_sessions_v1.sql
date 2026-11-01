-- Isolated replay archive. Apply deliberately before deploying the worker.
create table public.replay_capture_sessions (
  session_id uuid primary key,
  status text not null check (status in ('requested','active','completed','stopped')),
  center_lat double precision not null check (center_lat between -75 and 75),
  center_lon double precision not null check (center_lon between -180 and 180),
  side_km integer not null check (side_km in (25,50,100,200)),
  duration_minutes integer not null check (duration_minutes in (5,10,15,30,60,120,180)),
  geometry_version text not null default 'azimuthal-equidistant-v1',
  requested_at timestamptz not null default clock_timestamp(),
  activated_at timestamptz,
  expires_at timestamptz,
  completed_at timestamptz,
  event_count integer not null default 0,
  capture_health text not null default 'unknown' check (capture_health in ('unknown','observing','complete','incomplete')),
  source_health text not null default 'unknown' check (source_health in ('unknown','healthy','unhealthy')),
  gap_count integer not null default 0,
  coverage_gaps jsonb not null default '[]'::jsonb,
  coverage_gaps_truncated boolean not null default false,
  error_details text,
  lease_owner uuid,
  lease_until timestamptz
);
create unique index replay_capture_single_open_session on public.replay_capture_sessions ((true))
  where status in ('requested','active');

create table public.replay_capture_strikes (
  session_id uuid not null references public.replay_capture_sessions(session_id),
  event_key text not null check (event_key ~ '^[0-9a-f]{64}$'),
  event_time timestamptz not null,
  received_at timestamptz not null,
  latitude double precision not null check (latitude between -90 and 90),
  longitude double precision not null check (longitude between -180 and 180),
  provider text not null default 'blitzortung' check (provider = 'blitzortung'),
  source_server text not null check (source_server in ('ws1','ws7','ws8')),
  lightning_type text not null default 'unknown' check (lightning_type = 'unknown'),
  event_time_raw text not null,
  station_count integer check (station_count >= 0),
  primary key (session_id, event_key)
);
create index replay_capture_strikes_chronology on public.replay_capture_strikes(session_id, event_time);

alter table public.replay_capture_sessions enable row level security;
alter table public.replay_capture_strikes enable row level security;
revoke all on public.replay_capture_sessions, public.replay_capture_strikes from public, anon, authenticated;
grant select, insert, update on public.replay_capture_sessions to service_role;
grant select, insert on public.replay_capture_strikes to service_role;

create function public.request_replay_capture(p_session_id uuid, p_center_lat double precision,
  p_center_lon double precision, p_side_km integer, p_duration_minutes integer)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare existing public.replay_capture_sessions%rowtype;
begin
  if p_session_id is null or p_center_lat is null or p_center_lat <> p_center_lat or
     p_center_lat < -75 or p_center_lat > 75 or
     p_center_lon is null or p_center_lon <> p_center_lon or
     p_center_lon < -180 or p_center_lon > 180 or
     p_side_km is null or p_side_km not in (25,50,100,200) or
     p_duration_minutes is null or p_duration_minutes not in (5,10,15,30,60,120,180) then
    raise exception 'Invalid replay capture settings';
  end if;
  select * into existing from public.replay_capture_sessions where session_id = p_session_id;
  if found then
    if existing.center_lat is distinct from p_center_lat or existing.center_lon is distinct from p_center_lon or
       existing.side_km is distinct from p_side_km or existing.duration_minutes is distinct from p_duration_minutes then
      raise exception 'Replay session id reused with different settings';
    end if;
    return jsonb_build_object('outcome','already_present','sessionId',p_session_id);
  end if;
  begin
    insert into public.replay_capture_sessions(session_id,status,center_lat,center_lon,side_km,duration_minutes)
    values (p_session_id,'requested',p_center_lat,p_center_lon,p_side_km,p_duration_minutes);
  exception when unique_violation then
    return jsonb_build_object('outcome','conflict');
  end;
  return jsonb_build_object('outcome','requested','sessionId',p_session_id);
end;
$$;

-- The worker alone activates and renews a 30-second lease. Other workers
-- cannot capture the same session. A lease takeover marks coverage incomplete.
create function public.sync_replay_capture(p_worker_id uuid, p_source_healthy boolean, p_had_gap boolean,
  p_pending_count integer, p_gap_updates jsonb, p_can_finalize boolean, p_gaps_truncated boolean)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare s public.replay_capture_sessions%rowtype; at_time timestamptz := clock_timestamp();
  gaps jsonb; gap jsonb; i integer; present boolean; truncated boolean;
begin
  if p_worker_id is null then raise exception 'Missing worker identity'; end if;
  if p_pending_count is null or p_pending_count < 0 or p_can_finalize is null or p_gaps_truncated is null or
     jsonb_typeof(p_gap_updates) is distinct from 'array' or jsonb_array_length(p_gap_updates) > 128 then
    raise exception 'Invalid capture sync';
  end if;
  select * into s from public.replay_capture_sessions
    where status in ('requested','active') order by requested_at limit 1 for update;
  if not found then return jsonb_build_object('outcome','idle'); end if;
  if s.status = 'requested' then
    if p_source_healthy is not true then return jsonb_build_object('outcome','waiting_for_source'); end if;
    update public.replay_capture_sessions set status='active', activated_at=at_time,
      expires_at=at_time + make_interval(mins => s.duration_minutes),
      lease_owner=p_worker_id, lease_until=at_time + interval '30 seconds',
      source_health='healthy', capture_health='observing'
      where session_id=s.session_id returning * into s;
    return jsonb_build_object('outcome','active','session',to_jsonb(s));
  end if;
  if s.lease_owner is distinct from p_worker_id and s.lease_until > at_time then
    return jsonb_build_object('outcome','not_owner');
  end if;
  gaps := s.coverage_gaps;
  truncated := s.coverage_gaps_truncated or p_gaps_truncated;
  for gap in select value from jsonb_array_elements(p_gap_updates) loop
    if jsonb_typeof(gap) <> 'object' or gap->>'id' is null or
       gap->>'reason' not in ('source_disconnect','source_unhealthy','queue_overflow','write_failure') or
       (gap->>'startedAt' is null and gap->>'reason' in ('source_disconnect','source_unhealthy')) or
       ((gap->>'startedAt')::timestamptz is not null and (gap->>'endedAt')::timestamptz is not null and
        (gap->>'endedAt')::timestamptz < (gap->>'startedAt')::timestamptz) then
      raise exception 'Invalid capture gap';
    end if;
    present := false;
    for i in 0..jsonb_array_length(gaps)-1 loop
      if gaps->i->>'id' = gap->>'id' then
        gaps := jsonb_set(gaps, array[i::text], gap);
        present := true;
        exit;
      end if;
    end loop;
    if not present then
      if jsonb_array_length(gaps) < 128 then gaps := gaps || jsonb_build_array(gap);
      else truncated := true; end if;
    end if;
  end loop;
  if coalesce(s.lease_until <= at_time,true) then
    if jsonb_array_length(gaps) < 128 then
      gaps := gaps || jsonb_build_array(jsonb_build_object('id','lease-' || s.session_id::text || '-' || at_time::text,
        'startedAt',null,'endedAt',null,'reason','lease_interruption'));
    else truncated := true; end if;
  end if;
  if p_can_finalize and s.expires_at + interval '60 seconds' <= at_time then
    update public.replay_capture_sessions set status='completed', completed_at=at_time,
      capture_health=case when capture_health='observing' and lease_until >= at_time
        and p_source_healthy is true and p_had_gap is not true and p_pending_count=0
        and jsonb_array_length(gaps)=0 and not truncated
        then 'complete' else 'incomplete' end, lease_owner=null, lease_until=null,
      error_details=case when capture_health='observing' and lease_until >= at_time
        and p_source_healthy is true and p_had_gap is not true and p_pending_count=0
        and jsonb_array_length(gaps)=0 and not truncated then error_details
        else coalesce(error_details,'observation_interrupted') end
      , coverage_gaps=gaps, coverage_gaps_truncated=truncated,
      gap_count=jsonb_array_length(gaps)
      where session_id=s.session_id returning * into s;
    return jsonb_build_object('outcome','completed','session',to_jsonb(s));
  end if;
  update public.replay_capture_sessions set lease_owner=p_worker_id,
    lease_until=at_time + interval '30 seconds',
    source_health=case when p_source_healthy then 'healthy' else 'unhealthy' end,
    capture_health=case when capture_health='incomplete' or p_source_healthy is not true
      or p_had_gap or jsonb_array_length(gaps)>0 or truncated or coalesce(s.lease_until <= at_time,true)
      then 'incomplete' else capture_health end,
    error_details=coalesce(error_details,case when coalesce(s.lease_until <= at_time,true) then 'lease_takeover'
      when p_had_gap then 'capture_gap'
      when p_source_healthy is not true then 'source_unhealthy' end),
    coverage_gaps=gaps, coverage_gaps_truncated=truncated, gap_count=jsonb_array_length(gaps)
    where session_id=s.session_id returning * into s;
  return jsonb_build_object('outcome','active','session',to_jsonb(s));
end;
$$;

create function public.stop_replay_capture()
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare s public.replay_capture_sessions%rowtype;
begin
  select * into s from public.replay_capture_sessions where status in ('requested','active')
    order by requested_at limit 1 for update;
  if not found then return jsonb_build_object('outcome','idle'); end if;
  update public.replay_capture_sessions set status='stopped', completed_at=clock_timestamp(),
    capture_health='incomplete', error_details=coalesce(error_details,'operator_stop'),
    lease_owner=null, lease_until=null
    where session_id=s.session_id returning * into s;
  return jsonb_build_object('outcome','stopped','sessionId',s.session_id);
end;
$$;

-- The row lock serializes stop/finalization against writes; unique key makes
-- retries idempotent. No rows are inserted when ownership or time is invalid.
create function public.store_replay_capture_batch(p_session_id uuid, p_worker_id uuid, p_events jsonb)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare s public.replay_capture_sessions%rowtype; inserted_count integer;
begin
  if jsonb_typeof(p_events) is distinct from 'array' or jsonb_array_length(p_events) > 50 then
    raise exception 'Invalid replay batch';
  end if;
  select * into s from public.replay_capture_sessions where session_id=p_session_id for update;
  if not found or s.status <> 'active' or s.lease_owner is distinct from p_worker_id or
      s.lease_until <= clock_timestamp() then
    return jsonb_build_object('outcome','not_active');
  end if;
  -- Reject the entire batch if any entry lies outside the event window or
  -- bounded receive grace. Never acknowledge a silently filtered event.
  if exists (select 1 from jsonb_to_recordset(p_events) as e(event_time timestamptz,received_at timestamptz)
      where e.event_time is null or e.received_at is null or
        e.event_time < s.activated_at or e.event_time >= s.expires_at or
        e.received_at < s.activated_at or e.received_at >= s.expires_at + interval '60 seconds' or
        e.event_time > e.received_at) then
    raise exception 'Outside replay capture window';
  end if;
  insert into public.replay_capture_strikes(session_id,event_key,event_time,received_at,
    latitude,longitude,source_server,event_time_raw,station_count)
  select p_session_id,e.event_key,e.event_time,e.received_at,e.latitude,e.longitude,
    e.source_server,e.event_time_raw,e.station_count
    from jsonb_to_recordset(p_events) as e(event_key text,event_time timestamptz,
      received_at timestamptz,latitude double precision,longitude double precision,
      source_server text,event_time_raw text,station_count integer)
    on conflict (session_id,event_key) do nothing;
  get diagnostics inserted_count = row_count;
  update public.replay_capture_sessions set event_count=event_count+inserted_count
    where session_id=p_session_id;
  return jsonb_build_object('outcome','stored','inserted',inserted_count);
end;
$$;

revoke all on function public.request_replay_capture(uuid,double precision,double precision,integer,integer),
  public.sync_replay_capture(uuid,boolean,boolean,integer,jsonb,boolean,boolean), public.stop_replay_capture(),
  public.store_replay_capture_batch(uuid,uuid,jsonb) from public, anon, authenticated;
grant execute on function public.request_replay_capture(uuid,double precision,double precision,integer,integer),
  public.sync_replay_capture(uuid,boolean,boolean,integer,jsonb,boolean,boolean), public.stop_replay_capture(),
  public.store_replay_capture_batch(uuid,uuid,jsonb) to service_role;
