-- Foundation only. Existing columns, duplicate indexes, approval and publication
-- state remain unchanged; historical records retain NULL metadata.
ALTER TABLE public.publication_records
  ADD COLUMN IF NOT EXISTS cg_metadata jsonb;

COMMENT ON COLUMN public.publication_records.cg_metadata IS
  'Nullable cg-location:v1 selected CG coordinate/time and structured naming provenance; not admission authorization. Provider identity remains provider_event_id.';
