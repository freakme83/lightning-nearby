# Fly.io Ankara continuous shadow worker

The Fly worker is the continuous owner of LightningMaps source collection for the Ankara operational area. It reuses the repository’s existing Ankara polygon, dedupe and clustering pipeline, incident lifecycle Profile B, fresh-trigger guard, Xweather adapter, Nominatim location naming, Composer, publish-decision gate, and persistent publication ledger. The worker keeps one long-lived websocket and its incident/lifecycle state in memory; candidate enrichment and ledger work runs off the websocket message handler.

The worker stops at a pending publication record. A newly actionable row is stored in `public.publication_records` with `decision = WOULD_PUBLISH` and `approval_status = pending`. Duplicate/history checks use the existing ledger matcher and rules. A location or provider failure follows existing safe-HOLD behavior and does not stop source monitoring.

## Runtime secrets and publishing boundary

Configure these four Fly app secrets before deploying Phase 2:

- `XWEATHER_CLIENT_ID`
- `XWEATHER_CLIENT_SECRET`
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

The process validates that each value is present at startup, without logging values. X/Twitter credentials remain only in GitHub Actions and are not required or read by this worker. The Fly worker cannot approve its own row, write `platform_post_id`, mark a row `PUBLISHED`, invoke the X Publisher, or send a social post. Manual Approval remains the human approval path, and the existing GitHub X Publisher remains the only X-writing component.

## Operational verification

After a separately authorized manual deploy, inspect `fly logs -a lightning-nearby-ankara-shadow`. Useful markers are:

- `worker_start`: should report `persistence: true`, `xweather: true`, `approval: false`, and `publishing: false`.
- `connected`, `source_health`, `disconnected`, and `reconnect_wait`: websocket and watchdog behavior.
- `summary`: five-minute source, filtering, clustering, lifecycle, and candidate counts.
- `incident_candidate`, `candidate_rejected_stale`, `location_resolved`, and `enrichment_complete`: candidate preparation stages.
- `duplicate_detected` or `publication_pending`: persistent-history decision or a new pending row.
- `candidate_outcome` and `candidate_processing_error`: safe non-pending outcomes and isolated pipeline failures.
- `out_of_bounds_event`: a limited sample of decoded feed points outside the Ankara subscription bounds, with approximate distance.

Do not use log absence as evidence that no lightning occurred: source gaps and provider limitations remain possible. Check Supabase read/write status through structured candidate outcomes; never paste secret values into logs or reports.

## Build and deployment

The image uses Node 22 built-in WebSocket/fetch and TypeScript stripping. It copies the complete source directories needed by the worker’s transitive research-pipeline imports, while excluding unrelated publisher code and production app assets. It does not copy secrets. The Fly config remains one Machine in `ams`, shared CPU 1x, 256 MB, no public service, no autostop, and restart policy `always`. Supabase is the durable store; the worker needs no volume.

The scheduled GitHub Ankara Monitor remains unchanged during this phase. Retire it only after pending candidate persistence has been validated with real qualifying events and an explicit operational decision.

## Rollback

If Phase 2 behaves unexpectedly, stop the Fly Machine and redeploy the previously validated passive-worker image from the prior passive-worker commit. Do not delete publication history or alter its schema. The GitHub monitor and manual approval/publisher workflows remain independent. Confirm the passive image reports `persistence: false`, `xweather: false`, `approval: false`, and `publishing: false` before resuming the shadow period.

## Billing and trial limits

Fly bills running Machines by the second. Region pricing, storage, and egress can change the total; check current Fly pricing before operating continuously. Trial limits may stop Machines automatically; do not alter billing or resource settings as part of this code change.
