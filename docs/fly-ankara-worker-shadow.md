# Fly.io Ankara shadow worker — initial stage

This is a passive, continuous observer for a parallel reliability test. The existing GitHub Actions Ankara monitor remains enabled on its 15-minute schedule and remains the only path that can run candidate enrichment and write pending approval records.

## Worker boundary

The Fly process connects to the existing LightningMaps live WebSocket, subscribes to the bounding box derived from `ANKARA_MONITORING_AREA`, then applies the same Ankara polygon locally. It keeps a bounded dedupe set and reconnects with capped exponential backoff. It emits connection and five-minute aggregate summaries to Fly logs.

The observer does not emit individual events or coordinates. It does not call Xweather, Nominatim, or Supabase; it does not create incidents or ledger rows; it cannot approve or publish. GitHub Actions Manual Approval and X Publisher remain unchanged and are still the only approval and publishing paths.

This first stage compares connection uptime, reconnects, malformed frames, dedupe, and aggregate events in the Ankara polygon against the existing scheduled monitor. It does not claim candidate-level parity: the scheduled monitor still owns clustering, lifecycle, enrichment, and pending-candidate persistence. Do not interpret no detected events as evidence that there was no lightning; feed gaps and source limitations remain possible.

## Billing and trial limits

Fly bills running Machines by the second. The current published reference for the configured `shared-cpu-1x`, 256 MB preset is **$2.19/month** when running for a full month; region pricing, root filesystem storage, and egress can change the total. See [Fly Machine pricing](https://fly.io/docs/about/pricing/).

A new-account free trial includes two total VM hours or seven days, whichever comes first, and trial Machines automatically stop after five minutes. That is not enough for a continuous shadow period. Adding a payment method ends the trial and starts billable usage. Do not add billing details or start an always-on Machine until the user has set an acceptable monthly spending limit.

## Build and deployment

The image uses Node 22's built-in WebSocket and type stripping; it installs no app dependencies and copies only the observer and its two required source modules. The Fly app has no public service or inbound port. One Machine is intended for the shadow test.

Before the first deployment:

1. Confirm the Fly account can provision the selected region and that the app name is available. If the name is already taken, change `app` in `fly.ankara-worker.toml`.
2. From the repository root, run `fly launch --config fly.ankara-worker.toml --no-deploy`, then `fly deploy --config fly.ankara-worker.toml`.
3. Confirm exactly one Machine exists, then set its restart policy to always with `fly machine update <machine-id> --restart always`. Fly Proxy autostop is not configured because this process has no service.
4. Inspect `fly logs -a lightning-nearby-ankara-shadow` and confirm `worker_start`, `connected`, `source_health`, and periodic `summary` records.

No secrets are needed for this passive stage. Do not add Xweather, Supabase, or X credentials to Fly. Keep the Actions cron running during the observation period. Compare time-bounded summaries and treat disconnect/reconnect intervals as unknown coverage, never as zero lightning.

## Stop and rollback

Stop the Machine with `fly machine stop <machine-id>`; remove the Fly app only if the shadow test is being abandoned. GitHub Actions continues to operate independently. Remove the Fly config, Dockerfile, worker, and this note from the feature branch if the test is rejected.
