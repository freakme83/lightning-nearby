-- The outer-district non-CG publication cooldown has been replaced by a
-- stateless CG-only publication rule. Historical cooldown migration remains immutable.
drop index if exists public.publication_records_outer_district_non_cg_cooldown_idx;
alter table public.publication_records drop column if exists canonical_district;
