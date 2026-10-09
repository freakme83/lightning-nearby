# Fly.io Ankara continuous shadow worker

The Fly worker is the continuous owner of LightningMaps source collection for the Ankara operational area. It reuses the repository’s existing Ankara polygon, dedupe and clustering pipeline, incident lifecycle Profile B, fresh-trigger guard, Xweather adapter, Nominatim location naming, Composer, publish-decision gate, and persistent publication ledger. The worker keeps one long-lived websocket and its incident/lifecycle state in memory; candidate enrichment and ledger work runs off the websocket message handler.

The worker stops at a pending publication record. A newly actionable row is stored in `public.publication_records` with `decision = WOULD_PUBLISH` and `approval_status = pending`. Duplicate/history checks use the existing ledger matcher and rules. A location or provider failure follows existing safe-HOLD behavior and does not stop source monitoring. An optional outbound Telegram notification reports a newly inserted pending candidate; it does not approve or publish it.

## Long-running in-memory retention

At each five-minute summary sweep, the runtime first delivers all pending cluster-close transitions, then removes closed cluster objects immediately (zero post-transition retention) and clears their `recentEvents`. Closed clusters cannot take part in association, and the lifecycle has already consumed the close event. A closed cluster may wait up to one sweep interval (five minutes) before its close transition is delivered and pruned. Candidate-expired incidents are removed once none of their source clusters remain, at the next sweep. Quiet-period closed incidents and publish-policy cooldown records are relevant through the Profile B 20-minute nearby-cooldown boundary; the periodic sweep removes them at the first sweep after that boundary, so physical retention is at most about 25 minutes. Active incidents, candidates, source-cluster references still represented by the clusterer, and candidate work currently being enriched or persisted are preserved. Per-process lifecycle metric samples retain only the latest 1,000 values per metric; aggregate counters remain cumulative. Durable duplicate history remains Supabase-authoritative and is not pruned.

## Runtime secrets and publishing boundary

Configure these four Fly app secrets before deploying Phase 2:

- `XWEATHER_CLIENT_ID`
- `XWEATHER_CLIENT_SECRET`
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

The process validates that each value is present at startup, without logging values. X/Twitter credentials remain only in GitHub Actions and are not required or read by this worker. The Fly worker cannot approve its own row, write `platform_post_id`, mark a row `PUBLISHED`, invoke the X Publisher, or send a social post. Manual Approval remains the human approval path, and the existing GitHub X Publisher remains the only X-writing component.

For pending-candidate notifications, configure these **optional** Fly secrets separately after review:

- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID` (numeric chat ID)

If either is missing or malformed, the worker continues detection and persistence, reports `telegram: false` and emits one `configuration_warning` naming the unusable setting. No token or chat ID is logged. With both settings present, `telegram: true` indicates notification capability; it does not guarantee delivery. The adapter makes at most one bounded outbound Bot API `sendMessage` attempt **after** a new `WOULD_PUBLISH`, `pending` row is confirmed inserted. Duplicates, HOLD, already-present IDs and failed writes do not notify. Telegram errors cannot roll back the row or stop the worker; no automatic retry or delivery queue exists. The bot does not poll updates or register webhooks, so it can coexist with another outbound sender using the same token. No Telegram approval buttons exist yet; Manual Approval and X Publisher remain separate GitHub Actions workflows.

## Operational verification

After a separately authorized manual deploy, inspect `fly logs -a lightning-nearby-ankara-shadow`. Useful markers are:

- `worker_start`: should report `persistence: true`, `xweather: true`, `telegram: true` when configured (otherwise `false`), `approval: false`, and `publishing: false`.
- `connected`, `source_health`, `disconnected`, and `reconnect_wait`: websocket and watchdog behavior.
- `summary`: five-minute source, filtering, clustering, lifecycle, and candidate counts.
- `source_health`: one structured event per actual source-health transition (including the initial connecting-to-live transition).
- `incident_candidate`, `candidate_rejected_stale`, `location_resolved`, and `enrichment_complete`: candidate preparation stages.
- `duplicate_detected` or `publication_pending`: persistent-history decision or a new pending row.
- `telegram_notification_sent` or `telegram_notification_failed`: one outbound notification outcome for a newly inserted pending row when configured. Match the `publicationId` against `publication_pending`; a failed notification leaves the row pending. A disabled capability emits only the startup `configuration_warning`.
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
