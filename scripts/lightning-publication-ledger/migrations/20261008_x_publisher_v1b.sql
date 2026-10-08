-- Applied to the configured Supabase project as migration 20261008161633_x_publisher_v1b.
-- The nullable attempt ID is an irreversible reservation: a fresh manual run
-- cannot send again until an operator reconciles the previous outcome.
alter table public.publication_records
  add column if not exists published_at timestamptz,
  add column if not exists publish_attempt_id uuid;
