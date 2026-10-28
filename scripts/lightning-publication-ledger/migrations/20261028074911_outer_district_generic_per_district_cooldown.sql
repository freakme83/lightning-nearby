-- Replace only the existing RPC. The original migration remains immutable and
-- the global transaction lock still serializes concurrent admissions.
create or replace function public.admit_outer_generic_publication(p_record jsonb)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  candidate public.publication_records%rowtype;
  district text := p_record->>'canonical_district';
  admitted_at timestamptz;
  latest_admission timestamptz;
  inserted_count integer;
begin
  candidate := jsonb_populate_record(null::public.publication_records, p_record);
  if district is null or district not in ('Şereflikoçhisar','Balâ','Haymana','Polatlı',
      'Beypazarı','Nallıhan','Güdül','Çamlıdere','Kızılcahamam','Çubuk','Kalecik','Evren') or
      candidate.canonical_district is distinct from district or
      candidate.publication_id is null or candidate.run_id is null or candidate.incident_id is null or
      candidate.decision is distinct from 'WOULD_PUBLISH' or
      candidate.enrichment_status is null or candidate.enrichment_status not in ('no_match','ic_only') or
      candidate.provider is distinct from 'xweather' or
      candidate.approval_status is distinct from 'pending' or candidate.platform_post_id is not null or
      candidate.message_fingerprint is null or candidate.message_text is null or candidate.message_text = '' then
    raise exception 'Invalid outer generic admission';
  end if;
  -- A single transaction lock serializes every outer district, including concurrent workers.
  perform pg_advisory_xact_lock(hashtextextended('lightning-nearby:outer-generic:v1', 0));
  admitted_at := clock_timestamp();
  if exists (select 1 from public.publication_records where publication_id = candidate.publication_id) then
    return jsonb_build_object('outcome','already_present');
  end if;
  select max(r.recorded_at) into latest_admission from public.publication_records as r
    where r.canonical_district = district and r.enrichment_status <> 'cg_verified'
      and r.decision in ('WOULD_PUBLISH','PUBLISHED')
      and r.recorded_at > admitted_at - interval '30 minutes' and r.recorded_at <= admitted_at;
  if latest_admission is not null then
    return jsonb_build_object('outcome','suppressed','reason','outer_district_generic_cooldown',
      'cooldownExpiresAt',latest_admission + interval '30 minutes');
  end if;
  -- The inserted pending publication row itself reserves the slot. Suppression and
  -- errors create no reservation. Database time is the durable admission time.
  insert into public.publication_records(publication_id, run_id, incident_id, incident_reference_time,
    incident_latitude, incident_longitude, provider, enrichment_status, provider_event_id, provider_event_type,
    location_label, message_fingerprint, decision, recorded_at, platform_post_id, message_text, map_url,
    approval_status, approval_updated_at, approval_actor, cg_metadata, cg_scope_id, canonical_district)
  values (candidate.publication_id, candidate.run_id, candidate.incident_id, candidate.incident_reference_time,
    candidate.incident_latitude, candidate.incident_longitude, candidate.provider, candidate.enrichment_status,
    candidate.provider_event_id, candidate.provider_event_type, candidate.location_label, candidate.message_fingerprint,
    candidate.decision, admitted_at, null, candidate.message_text, candidate.map_url,
    'pending', null, null, null, null, district)
  on conflict (publication_id) do nothing;
  get diagnostics inserted_count = row_count;
  if inserted_count = 1 then
    return jsonb_build_object('outcome','inserted','admittedAt',admitted_at);
  end if;
  return jsonb_build_object('outcome','already_present');
end;
$$;
revoke all on function public.admit_outer_generic_publication(jsonb) from public, anon, authenticated;
grant execute on function public.admit_outer_generic_publication(jsonb) to service_role;
