-- Existing rows remain NULL: they do not become pending approval tasks.
ALTER TABLE public.publication_records
  ADD COLUMN IF NOT EXISTS message_text text,
  ADD COLUMN IF NOT EXISTS approval_status text,
  ADD COLUMN IF NOT EXISTS approval_updated_at timestamptz,
  ADD COLUMN IF NOT EXISTS approval_actor text;

ALTER TABLE public.publication_records
  ADD CONSTRAINT publication_records_approval_status_check
  CHECK (approval_status IS NULL OR approval_status IN ('pending', 'approved', 'skipped'));
