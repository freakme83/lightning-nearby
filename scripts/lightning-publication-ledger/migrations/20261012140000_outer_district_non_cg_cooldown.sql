-- Persist normalized district identity for restart-safe non-CG admission cooldowns.
alter table public.publication_records
  add column if not exists canonical_district text;

comment on column public.publication_records.canonical_district is
  'Canonical Ankara district used by the initial non-CG publication cooldown; null for CG and out-of-scope records.';

-- Backfill only unambiguous historical location labels whose final component is
-- an explicitly selected district. Labels with missing/uncertain hierarchy stay null.
update public.publication_records
set canonical_district = case
  when translate(lower(location_label), 'çğıöşüâ', 'cgiosua') ~ ',\s*sereflikochisar$' then 'Şereflikoçhisar'
  when translate(lower(location_label), 'çğıöşüâ', 'cgiosua') ~ ',\s*bala$' then 'Balâ'
  when translate(lower(location_label), 'çğıöşüâ', 'cgiosua') ~ ',\s*haymana$' then 'Haymana'
  when translate(lower(location_label), 'çğıöşüâ', 'cgiosua') ~ ',\s*polatli$' then 'Polatlı'
  when translate(lower(location_label), 'çğıöşüâ', 'cgiosua') ~ ',\s*beypazari$' then 'Beypazarı'
  when translate(lower(location_label), 'çğıöşüâ', 'cgiosua') ~ ',\s*nallihan$' then 'Nallıhan'
  when translate(lower(location_label), 'çğıöşüâ', 'cgiosua') ~ ',\s*gudul$' then 'Güdül'
  when translate(lower(location_label), 'çğıöşüâ', 'cgiosua') ~ ',\s*camlidere$' then 'Çamlıdere'
  when translate(lower(location_label), 'çğıöşüâ', 'cgiosua') ~ ',\s*kizilcahamam$' then 'Kızılcahamam'
  when translate(lower(location_label), 'çğıöşüâ', 'cgiosua') ~ ',\s*cubuk$' then 'Çubuk'
  when translate(lower(location_label), 'çğıöşüâ', 'cgiosua') ~ ',\s*kalecik$' then 'Kalecik'
end
where canonical_district is null
  and decision in ('WOULD_PUBLISH', 'PUBLISHED')
  and enrichment_status <> 'cg_verified'
  and location_label is not null;

create index if not exists publication_records_outer_district_non_cg_cooldown_idx
  on public.publication_records (canonical_district, recorded_at desc)
  where canonical_district is not null
    and enrichment_status <> 'cg_verified'
    and decision in ('WOULD_PUBLISH', 'PUBLISHED');
