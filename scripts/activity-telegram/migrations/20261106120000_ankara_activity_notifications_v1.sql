-- Activity Watch Telegram notification state. Apply separately, before enabling
-- ACTIVITY_TELEGRAM_ENABLED. Additive only: no Activity Watch, Continuous Capture or
-- publication object is altered, and no trigger is attached to Activity Watch tables.

-- One row. enabled_at is set by the first dispatcher claim after enablement; periods that
-- started earlier are never announced, so enabling cannot replay history.
create table public.ankara_activity_notification_settings (
  singleton boolean primary key default true check (singleton),
  enabled_at timestamptz not null,
  last_send_at timestamptz,
  blocked_until timestamptz
);

-- No foreign key to ankara_activity_periods: a key-share lock on the period row would
-- contend with sync_ankara_activity_watch's FOR UPDATE and couple the two features.
create table public.ankara_activity_notifications (
  period_id uuid not null,
  kind text not null check (kind in ('start', 'end')),
  idempotency_key text not null unique,
  -- pending: may be claimed at next_attempt_at; claimed: being prepared, nothing sent yet;
  -- sending: a Telegram request may have been issued; terminal: sent, ambiguous, failed,
  -- superseded (start never sent before the period closed), expired (too old to report).
  state text not null check (state in ('pending', 'claimed', 'sending', 'sent', 'ambiguous',
    'failed', 'superseded', 'expired')),
  attempts integer not null default 0 check (attempts >= 0),
  prepare_failures integer not null default 0 check (prepare_failures >= 0),
  next_attempt_at timestamptz not null,
  lease_owner uuid,
  lease_until timestamptz,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  sent_at timestamptz,
  telegram_message_id bigint,
  last_outcome text check (last_outcome ~ '^[a-z0-9_:]{1,80}$'),
  attachment text check (attachment ~ '^(attached|unavailable:[a-z0-9_]{1,64})$'),
  primary key (period_id, kind),
  check (idempotency_key = 'ankara-activity:v1:' || period_id::text || ':' || kind),
  check (state not in ('claimed', 'sending') or (lease_owner is not null and lease_until is not null)),
  check (state in ('claimed', 'sending') or lease_until is null)
);
create index ankara_activity_notifications_due on public.ankara_activity_notifications (next_attempt_at)
  where state = 'pending';
create index ankara_activity_notifications_leased on public.ankara_activity_notifications (lease_until)
  where state in ('claimed', 'sending');

alter table public.ankara_activity_notification_settings enable row level security;
alter table public.ankara_activity_notifications enable row level security;
revoke all on public.ankara_activity_notification_settings, public.ankara_activity_notifications
  from public, anon, authenticated;
grant select, insert, update on public.ankara_activity_notification_settings,
  public.ankara_activity_notifications to service_role;

-- Plans due notifications from committed Activity Watch rows, recovers expired leases and
-- claims at most one notification. Serialized across workers by one advisory lock.
create function public.claim_ankara_activity_notification(
  p_worker_id uuid, p_now timestamptz default clock_timestamp()
) returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  settings public.ankara_activity_notification_settings%rowtype;
  note public.ankara_activity_notifications%rowtype;
  period public.ankara_activity_periods%rowtype;
  horizon constant interval := interval '12 hours';
  scan constant interval := interval '7 days';
  archive_delay constant interval := interval '10 seconds';
  min_spacing constant interval := interval '3 seconds';
begin
  if p_worker_id is null or p_now is null then raise exception 'Invalid notification claim input'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('ankara_activity_notifications_v1'));
  insert into public.ankara_activity_notification_settings (singleton, enabled_at) values (true, p_now)
    on conflict do nothing;
  select * into settings from public.ankara_activity_notification_settings;

  -- Nothing was sent under an expired preparation lease: it can be retried. An expired
  -- sending lease may hide an accepted Telegram message, so it is never retried.
  update public.ankara_activity_notifications set state = 'pending', lease_owner = null, lease_until = null,
    last_outcome = 'lease_expired_before_send', updated_at = p_now
    where state = 'claimed' and lease_until <= p_now;
  -- The owner is kept so that its late confirmation can still record 'sent'.
  update public.ankara_activity_notifications set state = 'ambiguous', lease_until = null,
    last_outcome = 'lease_expired_while_sending', updated_at = p_now
    where state = 'sending' and lease_until <= p_now;

  insert into public.ankara_activity_notifications (period_id, kind, idempotency_key, state,
    next_attempt_at, created_at, updated_at)
  select p.period_id, k.kind, 'ankara-activity:v1:' || p.period_id::text || ':' || k.kind, 'pending',
    -- The first detection's archive row is written asynchronously; give it a moment.
    case when k.kind = 'start' then greatest(p_now, p.started_at + archive_delay) else p_now end, p_now, p_now
  from public.ankara_activity_periods p
  cross join lateral (select case when p.state = 'active' then 'start' else 'end' end as kind) k
  where p.started_at >= settings.enabled_at and p.started_at >= p_now - scan
    and (p.state = 'active' or p.closed_at >= p_now - horizon)
  on conflict do nothing;
  -- A start that was never handed to Telegram is not sent once the period has ended;
  -- the completion report stands alone.
  update public.ankara_activity_notifications n set state = 'superseded', last_outcome = 'period_closed',
    updated_at = p_now
    from public.ankara_activity_periods p
    where n.period_id = p.period_id and n.kind = 'start' and n.state = 'pending' and p.state = 'closed';
  update public.ankara_activity_notifications n set state = 'expired', last_outcome = 'closure_too_old',
    updated_at = p_now
    from public.ankara_activity_periods p
    where n.period_id = p.period_id and n.kind = 'end' and n.state = 'pending' and p.closed_at < p_now - horizon;

  if settings.blocked_until > p_now then
    return jsonb_build_object('outcome', 'wait', 'retryAt', settings.blocked_until);
  end if;
  if settings.last_send_at > p_now - min_spacing then
    return jsonb_build_object('outcome', 'wait', 'retryAt', settings.last_send_at + min_spacing);
  end if;
  select * into note from public.ankara_activity_notifications
    where state = 'pending' and next_attempt_at <= p_now
    order by (kind = 'start') desc, created_at, period_id limit 1 for update;
  if note.period_id is null then return jsonb_build_object('outcome', 'idle'); end if;
  select * into period from public.ankara_activity_periods where period_id = note.period_id;
  update public.ankara_activity_notifications set state = 'claimed', lease_owner = p_worker_id,
    lease_until = p_now + interval '5 minutes', updated_at = p_now
    where period_id = note.period_id and kind = note.kind returning * into note;
  return jsonb_build_object('outcome', 'claimed', 'notification', jsonb_build_object(
      'period_id', note.period_id, 'kind', note.kind, 'idempotency_key', note.idempotency_key,
      'attempts', note.attempts, 'prepare_failures', note.prepare_failures),
    'period', to_jsonb(period) - 'worker_run_id' - 'last_gap_sequence');
end;
$$;

-- Must succeed immediately before any Telegram request. Idempotent for the same owner so a
-- lost response can be retried without a second claim; a start whose period has closed is
-- superseded instead of sent.
create function public.begin_ankara_activity_notification_send(
  p_worker_id uuid, p_period_id uuid, p_kind text, p_now timestamptz default clock_timestamp()
) returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  note public.ankara_activity_notifications%rowtype;
begin
  if p_worker_id is null or p_period_id is null or p_kind not in ('start', 'end') or p_now is null then
    raise exception 'Invalid notification send input';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('ankara_activity_notifications_v1'));
  select * into note from public.ankara_activity_notifications
    where period_id = p_period_id and kind = p_kind for update;
  if note.period_id is null or note.lease_owner is distinct from p_worker_id or note.lease_until <= p_now then
    return jsonb_build_object('outcome', 'lost');
  end if;
  if note.state = 'sending' then return jsonb_build_object('outcome', 'proceed'); end if;
  if note.state <> 'claimed' then return jsonb_build_object('outcome', 'lost'); end if;
  if p_kind = 'start' and not exists (select 1 from public.ankara_activity_periods
      where period_id = p_period_id and state = 'active') then
    update public.ankara_activity_notifications set state = 'superseded', last_outcome = 'period_closed',
      lease_owner = null, lease_until = null, updated_at = p_now where period_id = p_period_id and kind = p_kind;
    return jsonb_build_object('outcome', 'superseded');
  end if;
  update public.ankara_activity_notifications set state = 'sending', attempts = attempts + 1,
    lease_until = p_now + interval '3 minutes', updated_at = p_now
    where period_id = p_period_id and kind = p_kind;
  update public.ankara_activity_notification_settings set last_send_at = p_now;
  return jsonb_build_object('outcome', 'proceed');
end;
$$;

-- Records what the worker knows. Only the lease owner can complete; 'sent' may also
-- resolve a row that expired to 'ambiguous' because its confirmation arrived late.
create function public.complete_ankara_activity_notification(
  p_worker_id uuid, p_period_id uuid, p_kind text, p_outcome text,
  p_detail text default null, p_retry_after_seconds integer default null,
  p_message_id bigint default null, p_attachment text default null,
  p_now timestamptz default clock_timestamp()
) returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  note public.ankara_activity_notifications%rowtype;
  max_attempts constant integer := 5;
  delay interval;
begin
  if p_worker_id is null or p_period_id is null or p_kind not in ('start', 'end') or p_now is null or
     p_outcome not in ('sent', 'ambiguous', 'retry', 'failed', 'prepare_failed', 'release') or
     (p_detail is not null and p_detail !~ '^[a-z0-9_:]{1,80}$') or
     (p_retry_after_seconds is not null and (p_retry_after_seconds < 0 or p_retry_after_seconds > 86400)) then
    raise exception 'Invalid notification completion input';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('ankara_activity_notifications_v1'));
  select * into note from public.ankara_activity_notifications
    where period_id = p_period_id and kind = p_kind for update;
  if note.period_id is null or note.lease_owner is distinct from p_worker_id then
    -- Idempotent repeat of a confirmation that was already recorded.
    if note.state = 'sent' and p_outcome = 'sent' then return jsonb_build_object('outcome', 'recorded'); end if;
    return jsonb_build_object('outcome', 'not_owner');
  end if;
  if p_outcome = 'sent' and note.state in ('sending', 'ambiguous') then
    update public.ankara_activity_notifications set state = 'sent', sent_at = p_now, telegram_message_id = p_message_id,
      attachment = p_attachment, last_outcome = 'sent', lease_owner = null, lease_until = null, updated_at = p_now
      where period_id = p_period_id and kind = p_kind;
  elsif p_outcome = 'ambiguous' and note.state = 'sending' then
    update public.ankara_activity_notifications set state = 'ambiguous', attachment = p_attachment,
      last_outcome = coalesce(p_detail, 'ambiguous'), lease_owner = null, lease_until = null, updated_at = p_now
      where period_id = p_period_id and kind = p_kind;
  elsif p_outcome = 'retry' and note.state = 'sending' then
    -- Telegram definitively did not deliver: bounded retries with exponential backoff, or
    -- longer when Telegram specified retry_after (which also pauses every notification).
    delay := greatest(interval '30 seconds' * power(2, greatest(note.attempts - 1, 0)),
      coalesce(p_retry_after_seconds, 0) * interval '1 second');
    update public.ankara_activity_notifications set
      state = case when note.attempts >= max_attempts then 'failed' else 'pending' end,
      next_attempt_at = p_now + delay, last_outcome = coalesce(p_detail, 'retry'),
      lease_owner = null, lease_until = null, updated_at = p_now
      where period_id = p_period_id and kind = p_kind;
    if p_retry_after_seconds is not null then
      update public.ankara_activity_notification_settings
        set blocked_until = greatest(coalesce(blocked_until, p_now), p_now + p_retry_after_seconds * interval '1 second');
    end if;
  elsif p_outcome = 'failed' and note.state = 'sending' then
    update public.ankara_activity_notifications set state = 'failed', last_outcome = coalesce(p_detail, 'failed'),
      lease_owner = null, lease_until = null, updated_at = p_now
      where period_id = p_period_id and kind = p_kind;
  elsif p_outcome = 'prepare_failed' and note.state = 'claimed' then
    update public.ankara_activity_notifications set state = 'pending', prepare_failures = prepare_failures + 1,
      next_attempt_at = p_now + least(interval '10 minutes', interval '1 minute' * power(2, note.prepare_failures)),
      last_outcome = coalesce(p_detail, 'prepare_failed'), lease_owner = null, lease_until = null, updated_at = p_now
      where period_id = p_period_id and kind = p_kind;
  elsif p_outcome = 'release' and note.state = 'claimed' then
    update public.ankara_activity_notifications set state = 'pending',
      next_attempt_at = p_now + coalesce(p_retry_after_seconds, 0) * interval '1 second',
      last_outcome = coalesce(p_detail, 'released'), lease_owner = null, lease_until = null, updated_at = p_now
      where period_id = p_period_id and kind = p_kind;
  else
    return jsonb_build_object('outcome', 'invalid_transition', 'state', note.state);
  end if;
  return jsonb_build_object('outcome', 'recorded');
end;
$$;

revoke all on function public.claim_ankara_activity_notification(uuid, timestamptz) from public, anon, authenticated;
revoke all on function public.begin_ankara_activity_notification_send(uuid, uuid, text, timestamptz)
  from public, anon, authenticated;
revoke all on function public.complete_ankara_activity_notification(uuid, uuid, text, text, text, integer, bigint, text,
  timestamptz) from public, anon, authenticated;
grant execute on function public.claim_ankara_activity_notification(uuid, timestamptz) to service_role;
grant execute on function public.begin_ankara_activity_notification_send(uuid, uuid, text, timestamptz) to service_role;
grant execute on function public.complete_ankara_activity_notification(uuid, uuid, text, text, text, integer, bigint, text,
  timestamptz) to service_role;
