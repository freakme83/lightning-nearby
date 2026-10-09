-- Applied to the configured Supabase project as migration 20261008161633_x_publisher_v1b.
-- The nullable attempt ID blocks blind retries after ambiguous outcomes;
-- a confirmed definite X rejection can conditionally release its exact claim.
alter table public.publication_records
  add column if not exists published_at timestamptz,
  add column if not exists publish_attempt_id uuid;
