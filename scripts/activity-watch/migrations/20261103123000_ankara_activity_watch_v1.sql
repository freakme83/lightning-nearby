-- Apply separately before enabling ACTIVITY_WATCH_ENABLED. No existing archive rows change.
create table public.ankara_activity_periods (
  period_id uuid primary key,
  state text not null check (state in ('active', 'closed')),
  started_at timestamptz not null,
  last_detection_at timestamptz not null,
  detection_count integer not null check (detection_count >= 1),
  closed_at timestamptz,
  source_health text not null check (source_health in ('healthy', 'unhealthy')),
  healthy_since timestamptz,
  coverage_uncertain boolean not null default false,
  interruption_count integer not null default 0,
  last_gap_sequence bigint not null default 0,
  worker_run_id uuid not null,
  check ((state = 'active' and closed_at is null) or (state = 'closed' and closed_at is not null))
);
create unique index ankara_activity_one_active on public.ankara_activity_periods ((true)) where state = 'active';
create index ankara_activity_periods_started on public.ankara_activity_periods (started_at);

-- Same SHA-256 key as continuous_capture_strikes.event_key. Archive writes are
-- independent/asynchronous, so a foreign key would reject legitimate observations.
create table public.ankara_activity_period_events (
  event_key text primary key check (event_key ~ '^[0-9a-f]{64}$'),
  period_id uuid not null references public.ankara_activity_periods(period_id),
  event_time timestamptz not null,
  received_at timestamptz not null
);
create index ankara_activity_period_events_period on public.ankara_activity_period_events (period_id);

alter table public.ankara_activity_periods enable row level security;
alter table public.ankara_activity_period_events enable row level security;
revoke all on public.ankara_activity_periods, public.ankara_activity_period_events from public, anon, authenticated;
grant select, insert, update on public.ankara_activity_periods to service_role;
grant select, insert on public.ankara_activity_period_events to service_role;

create function public.sync_ankara_activity_watch(
  p_worker_run_id uuid, p_source_healthy boolean, p_gap_sequence bigint,
  p_gap_max_ms integer, p_gap_unbounded boolean, p_lost boolean,
  p_events jsonb, p_now timestamptz default clock_timestamp()
) returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  period public.ankara_activity_periods%rowtype;
  item jsonb;
  key text;
  occurred timestamptz;
  received timestamptz;
  inserted text;
  processed integer := 0;
  new_gaps bigint := 0;
  run_changed boolean := false;
  reset_silence boolean := false;
  max_bounded_reconnect_gap_ms constant integer := 10000;
begin
  if p_worker_run_id is null or p_source_healthy is null or p_gap_sequence is null or p_gap_sequence < 0 or
     p_gap_max_ms is null or p_gap_max_ms < 0 or p_gap_unbounded is null or p_lost is null or
     p_now is null or jsonb_typeof(p_events) <> 'array' or jsonb_array_length(p_events) > 50 then
    raise exception 'Invalid Activity Watch sync input';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('ankara_activity_watch_v1'));
  select * into period from public.ankara_activity_periods where state = 'active' for update;

  if period.period_id is not null then
    run_changed := period.worker_run_id <> p_worker_run_id;
    new_gaps := case when run_changed then 0 else greatest(0, p_gap_sequence - period.last_gap_sequence) end;
    -- A completed, precisely bounded reconnect of at most 10 seconds is
    -- uncertain coverage but does not restart the event-time silence clock.
    reset_silence := run_changed or p_lost or
      (new_gaps > 0 and (p_gap_unbounded or p_gap_max_ms > max_bounded_reconnect_gap_ms)) or
      (p_source_healthy and period.source_health = 'unhealthy' and new_gaps = 0);
    update public.ankara_activity_periods set
      coverage_uncertain = coverage_uncertain or run_changed or p_lost or
        not p_source_healthy or new_gaps > 0,
      interruption_count = interruption_count + case when run_changed then 1 else new_gaps end,
      source_health = case when p_source_healthy then 'healthy' else 'unhealthy' end,
      healthy_since = case when p_source_healthy and (reset_silence or healthy_since is null) then p_now
        when reset_silence then null else healthy_since end,
      worker_run_id = p_worker_run_id, last_gap_sequence = p_gap_sequence
    where period_id = period.period_id returning * into period;
  end if;

  for item in select value from jsonb_array_elements(p_events) as t(value) loop
    if not p_source_healthy or jsonb_typeof(item) <> 'object' then
      raise exception 'Invalid Activity Watch event';
    end if;
    key := item->>'event_key';
    if key is null or key !~ '^[0-9a-f]{64}$' then raise exception 'Invalid Activity Watch event key'; end if;
    occurred := (item->>'event_time')::timestamptz;
    received := (item->>'received_at')::timestamptz;
    if occurred is null or received is null or occurred > received or
       received - occurred > interval '30 seconds' or received > p_now + interval '5 seconds' then
      raise exception 'Invalid Activity Watch event time';
    end if;
    -- A buffered event from a prolonged outage cannot open a historical period.
    if received < p_now - interval '30 seconds' then
      if period.period_id is not null then
        update public.ankara_activity_periods set coverage_uncertain = true where period_id = period.period_id;
      end if;
      continue;
    end if;
    if exists (select 1 from public.ankara_activity_period_events where event_key = key) then continue; end if;
    -- Process queued eligible events before the final quiet-time evaluation.
    -- A genuinely new event beyond a fully observed 30-minute boundary starts
    -- the next period even when the periodic evaluation was delayed.
    if period.period_id is not null and period.healthy_since is not null and
       occurred >= greatest(period.last_detection_at, period.healthy_since) + interval '30 minutes' then
      update public.ankara_activity_periods set state = 'closed', closed_at = p_now
        where period_id = period.period_id;
      period.period_id := null;
    end if;
    if period.period_id is null then
      insert into public.ankara_activity_periods
        (period_id, state, started_at, last_detection_at, detection_count, source_health, healthy_since,
         coverage_uncertain, interruption_count, last_gap_sequence, worker_run_id)
      values (pg_catalog.gen_random_uuid(), 'active', occurred, occurred, 1, 'healthy', p_now,
        p_lost, case when p_lost then 1 else 0 end, p_gap_sequence, p_worker_run_id)
      returning * into period;
    else
      update public.ankara_activity_periods set last_detection_at = greatest(last_detection_at, occurred),
        detection_count = detection_count + 1 where period_id = period.period_id returning * into period;
    end if;
    insert into public.ankara_activity_period_events (event_key, period_id, event_time, received_at)
      values (key, period.period_id, occurred, received) on conflict do nothing returning event_key into inserted;
    if inserted is null then raise exception 'Activity Watch event identity race'; end if;
    inserted := null;
    processed := processed + 1;
  end loop;
  -- An eligible event in this batch may have extended the period. Never close
  -- based on the pre-batch last_detection_at value.
  if period.period_id is not null and p_source_healthy and period.healthy_since is not null and
     p_now >= greatest(period.last_detection_at, period.healthy_since) + interval '30 minutes' then
    update public.ankara_activity_periods set state = 'closed', closed_at = p_now
      where period_id = period.period_id;
    period.period_id := null;
  end if;
  return jsonb_build_object('state', case when period.period_id is null then 'idle' else 'active' end,
    'periodId', period.period_id, 'processed', processed);
end;
$$;
revoke all on function public.sync_ankara_activity_watch(uuid, boolean, bigint, integer, boolean, boolean, jsonb, timestamptz) from public, anon, authenticated;
grant execute on function public.sync_ankara_activity_watch(uuid, boolean, bigint, integer, boolean, boolean, jsonb, timestamptz) to service_role;
