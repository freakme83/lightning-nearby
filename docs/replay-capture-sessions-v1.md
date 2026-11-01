# Replay capture sessions v1

PR-A archives individual Blitzortung detections for later Replay Studio work. It does not export Replay JSON, render video, provide a public API, or alter Ankara publication policy.

## Data path and geometry

The **existing production Fly worker** (`lightning-nearby-ankara-shadow`) owns the single Blitz WebSocket. After its established decoder accepts a valid event, `ReplayCaptureManager.observe()` sees that event **before** `BlitzPrimaryAdmission.admit()` applies production freshness, deduplication, and Ankara lifecycle gates. Capture has its own exact source fingerprint and bounded queue. The production admission call still runs regardless of capture outcomes. No new WebSocket, geocoding, provider query, publisher call, or second worker is introduced.

The square uses a spherical azimuthal equidistant projection (Earth radius 6371.0088 km) centered at the supplied latitude/longitude. Points qualify when both local east and north coordinates have absolute value no greater than half the selected side. Its geometry version, center, and side are stored with the session. Longitude wraps across the antimeridian. Center latitude is restricted to ±75°; side must be 25, 50, 100, or 200 km. The 100 km option is the recommended default. Duration must be 5, 10, 15, 30, 60, 120, or 180 minutes; 10 minutes is the recommended default.

## State and coverage

The GitHub runner submits one command and exits. The worker polls every 12 seconds while idle, 10 seconds while waiting for source readiness, and two seconds during active capture and finalization; RPC failures use bounded backoff. It atomically claims a requested session only after the **current** Blitz socket has yielded a valid decoded event. A newly opened socket cannot inherit readiness from the previous connection. The database activation clock sets expiration. One partial unique index prevents simultaneous requested/active sessions. A 30-second database lease ensures only one worker writes; a different worker can resume after lease expiry, marking coverage `incomplete`. A stopped session retains its strikes. A worker outage that lasts past expiration is finalized as incomplete when a worker next checks the session.

The selected duration defines the strike **event-time** interval `[activated_at, expires_at)`. A fixed 60-second receive grace accepts a delayed detection whose event time belongs to that interval, provided it arrives before `expires_at + 60 seconds`. An event at or after `expires_at`, or received at or after the grace deadline, is rejected. No historical backfill occurs. The session stays active during grace, draining eligible queued writes; it is not finalized before the grace deadline, and pending writes at finalization force `incomplete`. This grace is an opportunity for late deliveries, **not a guarantee** that all detections arrived. Original event time and receive time are both stored. The source fingerprint is SHA-256 of the existing Blitz fingerprint (raw time, coordinates, mds, mcg, polarity); it is an exact replay key, **not** a scientifically proven physical-discharge identity. The database primary key `(session_id,event_key)` makes retries and restarts idempotent.

At most 500 selected events can wait in memory, with up to 50 events per request and one batch per two-second tick. Writes have an eight-second timeout and bounded retry backoff. Queue loss, persistence errors, source disconnects, unhealthy source state, and lease takeover mark capture coverage incomplete. Session `coverage_gaps` retains up to 128 intervals with start/end timestamps for observed source interruptions; unknown retrospective boundaries for write loss and lease takeover are stored as `null`, never invented. A truncation flag preserves conservative incompleteness if that limit is reached. Recovery closes the same gap and never restores `complete` after an interruption. `event_count` is the durable stored count; `replay_capture_summary` reports matched, queued, persisted, duplicate, rejected, dropped, failed writes, source gaps, source health, and queue size. `replay_capture_activated`, `replay_capture_ended`, and `replay_capture_error` are source-labelled. No global per-event log is added. An empty capture should be interpreted as clear only if `capture_health=complete`; even then it means no detections in this feed and square, not meteorological proof of no lightning.

The separate `replay_capture_sessions` and `replay_capture_strikes` tables use RLS and explicit service-role-only grants. They do not touch publication records. The existing Supabase URL and service-role credential pattern is reused in both the Fly worker and the Actions runner. Do not expose these credentials to the browser. No new infrastructure or secrets are introduced.

## Manual controls and activation

The workflow file is `.github/workflows/replay-capture-control.yml` and its name is **Replay Capture Control**. Inputs are `operation=start|status|stop`, decimal `center_lat`/`center_lon`, and native choice dropdowns for `side_km` and `duration_minutes`. `status` reports the most recently requested session including database activation/expiry, stored count, source health, capture health, and gap count. `stop` marks only the experimental session stopped; it does not stop Fly.

GitHub requires a `workflow_dispatch` workflow file on the repository's **default branch**. Here that branch is `main`, while this PR deliberately targets `merge-ready`. Therefore merging this PR alone does **not** make its Run workflow button available. After separate review and authorization, place **only this workflow file** on `main` in a controlled change, leaving the implementation and checkout target on `merge-ready`. Until then, after migration and worker deployment are authorized, run the same command locally from a `merge-ready` checkout with already configured `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`:

```sh
CAPTURE_OPERATION=start CAPTURE_CENTER_LAT=40 CAPTURE_CENTER_LON=32 CAPTURE_SIDE_KM=25 CAPTURE_DURATION_MINUTES=5 node --experimental-strip-types scripts/replay-capture/control.ts
CAPTURE_OPERATION=status node --experimental-strip-types scripts/replay-capture/control.ts
CAPTURE_OPERATION=stop node --experimental-strip-types scripts/replay-capture/control.ts
```

The start response is `requested`; wait for `active` with a database `activated_at` before timing the five minutes. A conflict is rejected; rerunning a separate start command does not replace the session.

## Rollout after explicit approval

1. Verify the intended Supabase project's migration history. Deliberately apply `scripts/replay-capture/migrations/20261101154731_replay_capture_sessions_v1.sql` once to the intended database. This PR does **not** apply it.
2. Review the existing Fly deployment workflow's single-machine preflight and deploy the updated worker image only after approval. The Dockerfile includes the capture module, and the Fly process command and Blitz connection remain unchanged. No Fly operation occurs in this PR.
3. Confirm `replay_capture_summary` / status behavior, then authorize the small default-branch workflow activation if desired. Test a five-minute session in a selected region.

Repository inspection found `merge-ready` at `f5694c4e5ce609bff09ab580446502935b1198a0`, with the production Fly config pointing to `scripts/fly-ankara-worker/worker.ts` and a separate dual-source observer app. This environment has no authenticated Fly CLI access, so the **actual currently deployed image commit and branch could not be independently verified**; check Fly deployment metadata before rollout. Merging the code or migration file does not itself activate capture or change the hosted schema.

PR-B can read session metadata and chronological strike rows by session ID, validate capture coverage, and produce Replay-compatible JSON. It should not reinterpret `unknown` lightning type as CG/IC.
