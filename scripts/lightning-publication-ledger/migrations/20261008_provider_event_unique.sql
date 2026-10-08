-- Only a positive shadow decision or future real publication reserves an event.
-- HOLD audit records remain insertable and never block a later valid candidate.
CREATE UNIQUE INDEX IF NOT EXISTS publication_records_blocking_provider_event_unique
  ON public.publication_records (provider, provider_event_id)
  WHERE provider_event_id IS NOT NULL
    AND decision IN ('WOULD_PUBLISH', 'PUBLISHED');
