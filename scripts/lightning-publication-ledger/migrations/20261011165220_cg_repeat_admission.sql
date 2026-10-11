-- Apply after PR #82 metadata and before deploying the updated worker.
-- Admission cap only: approval/publish attempts and X posting intervals are unchanged.
create table if not exists public.cg_repeat_scopes (
  scope_id text primary key,
  run_id text not null,
  incident_id text not null,
  predecessor_scope_id text references public.cg_repeat_scopes(scope_id),
  created_at timestamptz not null default clock_timestamp()
);
alter table public.cg_repeat_scopes enable row level security;
revoke all on public.cg_repeat_scopes from public, anon, authenticated;
grant select, insert, update on public.cg_repeat_scopes to service_role;
alter table public.publication_records add column if not exists cg_scope_id text;
create index if not exists publication_records_cg_scope_idx
  on public.publication_records (cg_scope_id, recorded_at)
  where decision in ('WOULD_PUBLISH', 'PUBLISHED') and enrichment_status = 'cg_verified';

create or replace function public.admit_cg_publication(p_record jsonb, p_request jsonb)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  -- cg-repeat:v1: keep aligned with lightning-cg-repeat-policy/constants.ts.
  urban_min_km constant double precision := 1;
  rural_min_km constant double precision := 5;
  window_duration constant interval := interval '20 minutes';
  max_admissions constant integer := 3;
  reference_delta constant interval := interval '60 seconds';
  freshness_limit constant interval := interval '4 minutes';
  scope text := p_request->>'scopeId';
  predecessor text := p_request->>'predecessorScopeId';
  kind text := p_request->>'kind';
  lock_key text;
  scope_row public.cg_repeat_scopes%rowtype;
  candidate public.publication_records%rowtype;
  prior public.publication_records%rowtype;
  metadata jsonb := p_record->'cg_metadata';
  admitted_at timestamptz;
  reference_at timestamptz;
  selected_at timestamptz;
  rolling_count integer := 0;
  history_count integer := 0;
  inserted_count integer;
  distance_km double precision;
  threshold_km double precision;
  delta_lat double precision;
  delta_lon double precision;
  haversine double precision;
  district_metadata jsonb;
begin
  candidate := jsonb_populate_record(null::public.publication_records, p_record);
  if scope is null or length(scope) > 160 or scope = '' or
      p_request->>'policyVersion' is distinct from 'cg-repeat:v1' or
      kind is null or kind not in ('initial', 'repeat') or
      candidate.run_id is null or candidate.incident_id is null or
      candidate.cg_scope_id is distinct from scope or
      candidate.enrichment_status is distinct from 'cg_verified' or
      candidate.provider is distinct from 'xweather' or candidate.decision is distinct from 'WOULD_PUBLISH' or
      candidate.approval_status is distinct from 'pending' or candidate.platform_post_id is not null or
      candidate.publication_id is null or candidate.message_text is null or candidate.message_text = '' then
    return jsonb_build_object('outcome','suppressed','reason','invalid_admission');
  end if;
  -- All writers of a scope serialize, including initial admission. Lock related
  -- scopes in lexical order so cooldown history cannot race its predecessor.
  for lock_key in select distinct value from unnest(array[scope, predecessor]) as value
      where value is not null order by value loop
    perform pg_advisory_xact_lock(hashtextextended('cg-repeat:' || lock_key, 0));
  end loop;
  admitted_at := clock_timestamp();
  if exists (select 1 from public.publication_records where publication_id = candidate.publication_id) then
    return jsonb_build_object('outcome','already_present','reason','publication_id_exists');
  end if;
  if candidate.provider_event_id is not null and exists (
      select 1 from public.publication_records where provider = candidate.provider and
        provider_event_id = candidate.provider_event_id and decision in ('WOULD_PUBLISH','PUBLISHED')) then
    return jsonb_build_object('outcome','suppressed','reason','same_provider_event');
  end if;
  -- Preserve the existing fallback matcher for history without a selected ID.
  for prior in select * from public.publication_records where decision in ('WOULD_PUBLISH','PUBLISHED')
      and message_fingerprint = candidate.message_fingerprint
      and (provider_event_id is null or candidate.provider_event_id is null)
      and abs(extract(epoch from (incident_reference_time::timestamptz - candidate.incident_reference_time::timestamptz))) <= 2 loop
    delta_lat := radians(prior.incident_latitude - candidate.incident_latitude);
    delta_lon := radians(prior.incident_longitude - candidate.incident_longitude);
    haversine := sin(delta_lat / 2)^2 + cos(radians(candidate.incident_latitude)) *
      cos(radians(prior.incident_latitude)) * sin(delta_lon / 2)^2;
    if 2 * 6371.0088 * asin(sqrt(greatest(0, least(1, haversine)))) <= 0.25 then
      return jsonb_build_object('outcome','suppressed','reason','same_observation_fingerprint');
    end if;
  end loop;
  if kind = 'repeat' then
    if candidate.provider_event_id is null or btrim(candidate.provider_event_id) = '' or
        candidate.provider_event_type is distinct from 'cg' or
        p_request->>'suppressionReason' is null or p_request->>'suppressionReason' not in
          ('already_published_active_incident','nearby_cooldown','already_active_suppressed_incident') or
        p_request->>'repeatReadyAt' is null or (p_request->>'repeatReadyAt')::timestamptz > admitted_at or
        metadata->>'version' is distinct from 'cg-location:v1' or
        metadata#>>'{semanticIdentity,available}' is distinct from 'true' or
        metadata#>>'{semanticIdentity,key}' is null or
        jsonb_typeof(metadata#>'{semanticIdentity,key}') is distinct from 'string' or
        metadata#>>'{semanticIdentity,level}' is null or
        metadata#>>'{semanticIdentity,level}' not in ('neighborhood','settlement','district') or
        nullif(btrim(metadata#>>'{semanticIdentity,components,country}'),'') is null or
        nullif(btrim(metadata#>>'{semanticIdentity,components,province}'),'') is null or
        nullif(btrim(metadata#>>'{semanticIdentity,components,parent}'),'') is null or
        (metadata#>>'{semanticIdentity,key}')::jsonb is distinct from jsonb_build_array('cg-location:v1',
          metadata#>>'{semanticIdentity,components,country}', metadata#>>'{semanticIdentity,components,province}',
          metadata#>>'{semanticIdentity,components,parent}', metadata#>>'{semanticIdentity,level}',
          metadata#>>'{semanticIdentity,components,place}') or
        jsonb_typeof(metadata->'latitude') is distinct from 'number' or
        jsonb_typeof(metadata->'longitude') is distinct from 'number' or
        abs((metadata->>'latitude')::double precision) > 90 or
        abs((metadata->>'longitude')::double precision) > 180 or
        metadata#>>'{classification,classification}' is null or
        metadata#>>'{classification,classification}' not in ('urban','rural','unknown') then
      return jsonb_build_object('outcome','suppressed','reason','repeat_identity_or_recovery_unavailable');
    end if;
    reference_at := (p_request->>'referenceTime')::timestamptz;
    selected_at := (metadata->>'eventTime')::timestamptz;
    if reference_at is null or selected_at is null or selected_at > admitted_at or reference_at > admitted_at or
        admitted_at - reference_at > freshness_limit or admitted_at - selected_at > freshness_limit or
        abs(extract(epoch from (selected_at - reference_at))) > extract(epoch from reference_delta) then
      return jsonb_build_object('outcome','suppressed','reason','selected_event_not_current');
    end if;
    if predecessor is not null and not exists (select 1 from public.cg_repeat_scopes where scope_id = predecessor) then
      return jsonb_build_object('outcome','suppressed','reason','predecessor_history_unavailable');
    end if;
  end if;
  insert into public.cg_repeat_scopes(scope_id, run_id, incident_id, predecessor_scope_id)
    values (scope, candidate.run_id, candidate.incident_id, predecessor) on conflict (scope_id) do nothing;
  select * into scope_row from public.cg_repeat_scopes where scope_id = scope;
  if scope_row.run_id is distinct from candidate.run_id or scope_row.incident_id is distinct from candidate.incident_id or
      scope_row.predecessor_scope_id is distinct from predecessor or predecessor = scope then
    return jsonb_build_object('outcome','suppressed','reason','scope_conflict');
  end if;
  select count(*) into rolling_count from public.publication_records
    where cg_scope_id = scope and enrichment_status = 'cg_verified' and decision in ('WOULD_PUBLISH','PUBLISHED')
      and recorded_at::timestamptz > admitted_at - window_duration;
  if kind = 'repeat' then
    if rolling_count >= max_admissions then
      return jsonb_build_object('outcome','suppressed','reason','burst_limit','rollingCount',rolling_count);
    end if;
    for prior in select * from public.publication_records where enrichment_status = 'cg_verified'
        and decision in ('WOULD_PUBLISH','PUBLISHED') and cg_scope_id in (scope, predecessor) loop
      history_count := history_count + 1;
      if prior.cg_metadata->>'version' is distinct from 'cg-location:v1' or
          prior.cg_metadata#>>'{semanticIdentity,available}' is distinct from 'true' or
          prior.cg_metadata#>>'{semanticIdentity,key}' is null or
          jsonb_typeof(prior.cg_metadata->'latitude') is distinct from 'number' or
          jsonb_typeof(prior.cg_metadata->'longitude') is distinct from 'number' or
          abs((prior.cg_metadata->>'latitude')::double precision) > 90 or
          abs((prior.cg_metadata->>'longitude')::double precision) > 180 or
          jsonb_typeof(prior.cg_metadata#>'{semanticIdentity,key}') is distinct from 'string' or
          prior.cg_metadata#>>'{semanticIdentity,level}' is null or
          prior.cg_metadata#>>'{semanticIdentity,level}' not in ('neighborhood','settlement','district') or
          nullif(btrim(prior.cg_metadata#>>'{semanticIdentity,components,country}'),'') is null or
          nullif(btrim(prior.cg_metadata#>>'{semanticIdentity,components,province}'),'') is null or
          nullif(btrim(prior.cg_metadata#>>'{semanticIdentity,components,parent}'),'') is null or
          (prior.cg_metadata#>>'{semanticIdentity,key}')::jsonb is distinct from jsonb_build_array('cg-location:v1',
            prior.cg_metadata#>>'{semanticIdentity,components,country}', prior.cg_metadata#>>'{semanticIdentity,components,province}',
            prior.cg_metadata#>>'{semanticIdentity,components,parent}', prior.cg_metadata#>>'{semanticIdentity,level}',
            prior.cg_metadata#>>'{semanticIdentity,components,place}') or
          prior.cg_metadata#>>'{classification,classification}' is null or
          prior.cg_metadata#>>'{classification,classification}' not in ('urban','rural','unknown') or
          prior.recorded_at::timestamptz > admitted_at then
        return jsonb_build_object('outcome','suppressed','reason','history_unavailable','rollingCount',rolling_count);
      end if;
      if prior.cg_metadata#>>'{semanticIdentity,key}' = metadata#>>'{semanticIdentity,key}' then
        return jsonb_build_object('outcome','suppressed','reason','same_semantic_location','rollingCount',rolling_count);
      end if;
      -- Losing neighborhood detail within the same parent is not evidence of a
      -- different place. An explicitly typed town/city center is the narrow exception.
      if prior.cg_metadata#>'{semanticIdentity,components,country}' = metadata#>'{semanticIdentity,components,country}' and
          prior.cg_metadata#>'{semanticIdentity,components,province}' = metadata#>'{semanticIdentity,components,province}' and
          prior.cg_metadata#>'{semanticIdentity,components,parent}' = metadata#>'{semanticIdentity,components,parent}' then
        district_metadata := case when metadata#>>'{semanticIdentity,level}' = 'district' then metadata
          when prior.cg_metadata#>>'{semanticIdentity,level}' = 'district' then prior.cg_metadata else null end;
        if district_metadata is not null and not coalesce(
            district_metadata#>>'{classification,classification}' = 'urban' and
            district_metadata#>>'{location,rawType}' in ('city','town','municipality') and
            regexp_replace(lower(translate(regexp_replace(btrim(normalize(district_metadata#>>'{location,locality}')),
              '\s+', ' ', 'g'), 'Iİ', 'ıi')), '\s+(mahallesi|ilçesi|ili)$', '') =
                district_metadata#>>'{semanticIdentity,components,parent}', false) then
          return jsonb_build_object('outcome','suppressed','reason','semantic_change_unproven','rollingCount',rolling_count);
        end if;
      end if;
      threshold_km := case when metadata#>>'{classification,classification}' = 'urban' and
        prior.cg_metadata#>>'{classification,classification}' = 'urban' then urban_min_km else rural_min_km end;
      delta_lat := radians((prior.cg_metadata->>'latitude')::double precision - (metadata->>'latitude')::double precision);
      delta_lon := radians((prior.cg_metadata->>'longitude')::double precision - (metadata->>'longitude')::double precision);
      haversine := sin(delta_lat / 2)^2 + cos(radians((metadata->>'latitude')::double precision)) *
        cos(radians((prior.cg_metadata->>'latitude')::double precision)) * sin(delta_lon / 2)^2;
      distance_km := 2 * 6371.0088 * asin(sqrt(greatest(0, least(1, haversine))));
      if distance_km < threshold_km then
        return jsonb_build_object('outcome','suppressed','reason','distance_below_threshold',
          'rollingCount',rolling_count,'distanceKm',distance_km,'thresholdKm',threshold_km);
      end if;
    end loop;
    if history_count = 0 then
      return jsonb_build_object('outcome','suppressed','reason','no_positive_cg_history','rollingCount',rolling_count);
    end if;
  elsif exists (select 1 from public.publication_records where cg_scope_id = scope and
      enrichment_status = 'cg_verified' and decision in ('WOULD_PUBLISH','PUBLISHED')) then
    return jsonb_build_object('outcome','suppressed','reason','initial_already_reserved');
  end if;
  -- Insert is the reservation. No separate slot can survive without its pending row.
  begin
    insert into public.publication_records(publication_id, run_id, incident_id, incident_reference_time,
      incident_latitude, incident_longitude, provider, enrichment_status, provider_event_id, provider_event_type,
      location_label, message_fingerprint, decision, recorded_at, platform_post_id, message_text, map_url,
      approval_status, approval_updated_at, approval_actor, cg_metadata, cg_scope_id)
    values (candidate.publication_id, candidate.run_id, candidate.incident_id, candidate.incident_reference_time,
      candidate.incident_latitude, candidate.incident_longitude, candidate.provider, candidate.enrichment_status,
      candidate.provider_event_id, candidate.provider_event_type, candidate.location_label, candidate.message_fingerprint,
      candidate.decision, admitted_at, null, candidate.message_text, candidate.map_url, 'pending', null, null, metadata, scope)
    on conflict (publication_id) do nothing;
    get diagnostics inserted_count = row_count;
  exception when unique_violation then
    -- Preserve the existing partial provider-event index. No auto dispatch on races.
    return jsonb_build_object('outcome','suppressed','reason','concurrent_unique_conflict','rollingCount',rolling_count);
  end;
  return jsonb_build_object('outcome',case when inserted_count = 1 then 'inserted' else 'already_present' end,
    'reason','admitted','rollingCount',rolling_count + inserted_count);
end;
$$;
revoke all on function public.admit_cg_publication(jsonb,jsonb) from public, anon, authenticated;
grant execute on function public.admit_cg_publication(jsonb,jsonb) to service_role;
