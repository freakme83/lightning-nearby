# Fly.io Ankara continuous shadow worker

The Fly worker is the continuous owner of LightningMaps source collection for the Ankara operational area. It reuses the repository’s existing Ankara polygon, dedupe and clustering pipeline, incident lifecycle Profile B, fresh-trigger guard, Xweather adapter, Nominatim location naming, Composer, publish-decision gate, and persistent publication ledger. The worker keeps one long-lived websocket and its incident/lifecycle state in memory; candidate enrichment and ledger work runs off the websocket message handler.

By default, the worker stops at a pending publication record. A newly actionable row is stored in `public.publication_records` with `decision = WOULD_PUBLISH` and `approval_status = pending`. Duplicate/history checks use the existing ledger matcher and rules. A location or provider failure follows existing safe-HOLD behavior and does not stop source monitoring. An optional outbound Telegram notification reports a newly inserted pending candidate. Phase 4 adds an independently optional, guarded automatic approval and dispatch mode; the existing GitHub X Publisher still performs every X write.

## Long-running in-memory retention

At each five-minute summary sweep, the runtime first delivers all pending cluster-close transitions, then removes closed cluster objects immediately (zero post-transition retention) and clears their `recentEvents`. Closed clusters cannot take part in association, and the lifecycle has already consumed the close event. A closed cluster may wait up to one sweep interval (five minutes) before its close transition is delivered and pruned. Candidate-expired incidents are removed once none of their source clusters remain, at the next sweep. Quiet-period closed incidents and publish-policy cooldown records are relevant through the Profile B 20-minute nearby-cooldown boundary; the periodic sweep removes them at the first sweep after that boundary, so physical retention is at most about 25 minutes. Active incidents, candidates, source-cluster references still represented by the clusterer, and candidate work currently being enriched or persisted are preserved. Per-process lifecycle metric samples retain only the latest 1,000 values per metric; aggregate counters remain cumulative. Durable duplicate history remains Supabase-authoritative and is not pruned.

## Runtime secrets and publishing boundary

Configure these four Fly app secrets before deploying Phase 2:

- `XWEATHER_CLIENT_ID`
- `XWEATHER_CLIENT_SECRET`
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

The process validates that each value is present at startup, without logging values. X/Twitter credentials remain only in GitHub Actions and are not required or read by this worker. With guarded auto mode configured, Fly can approve its newly inserted pending row and dispatch the existing GitHub X Publisher. It cannot write `platform_post_id`, mark a row `PUBLISHED`, or send a social post. Manual Approval remains available, and the existing GitHub X Publisher remains the only X-writing component. There is no schema migration or second publisher workflow.

For pending-candidate notifications, configure these **optional** Fly secrets separately after review:

- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID` (numeric chat ID)

If either is missing or malformed, the worker continues detection and persistence, reports `telegram: false` and emits one `configuration_warning` naming the unusable setting. No token or chat ID is logged. With both settings present, `telegram: true` indicates notification capability; it does not guarantee delivery. The adapter makes at most one bounded outbound Bot API `sendMessage` attempt **after** a new `WOULD_PUBLISH`, `pending` row is confirmed inserted. Duplicates, HOLD, already-present IDs and failed writes do not notify. Telegram errors cannot roll back the row, block automatic approval/dispatch, or stop the worker; no automatic retry or delivery queue exists. The bot does not poll updates or register webhooks, so it can coexist with another outbound sender using the same token. No Telegram approval buttons exist yet; Manual Approval and X Publisher remain separate GitHub Actions workflows.

## Phase 4: optional guarded auto-publish

Manual mode remains the default:

`candidate → Supabase pending → Telegram attempt → human Manual Approval → human X Publisher workflow`

Auto mode uses the same persisted row and existing publisher:

`candidate → Supabase pending → Telegram attempt → auto approval → existing GitHub X Publisher dispatch → X → Supabase PUBLISHED`

Configure these optional Fly settings only when enabling this mode:

| Setting | Behavior |
| --- | --- |
| `LIGHTNING_AUTO_PUBLISH_ENABLED` | Non-sensitive environment variable (or Fly secret). Only the exact string `true` requests auto mode. Missing, `false`, uppercase, whitespace, and other values leave manual mode active. Not required for startup. |
| `GITHUB_ACTIONS_DISPATCH_TOKEN` | Fly secret containing a fine-grained GitHub PAT restricted to `freakme83/lightning-nearby`, with **Actions: write** and the implicit repository metadata read permission. No Contents write, organization access, or X credentials are needed. |
| `X_PUBLISHING_ENABLED` | Existing GitHub repository Actions variable. Only exact `true` allows the existing publisher to create an X post. This remains the final independent X kill switch. |

Create the dispatch PAT with only this selected repository and the minimum Actions permission, a suitable expiration, and rotation procedures. The worker accepts the `github_pat_` format with an alphanumeric/underscore suffix of at least 20 characters; syntactic validation cannot verify its permissions, expiration, or revocation. No startup API probe runs. When auto mode is requested but the token is absent or malformed, startup emits one `configuration_warning` for `autoPublish` naming the setting, reports `autoPublish: false`, and leaves new rows pending. Persistence and Telegram remain operational. When auto mode is disabled, this token is not required or validated.

The token grants GitHub Actions dispatch authority, so keep it a Fly secret. The adapter fixes the repository, workflow, and ref; none can be supplied by a feed event. It sends one native-fetch POST to:

`https://api.github.com/repos/freakme83/lightning-nearby/actions/workflows/research-lightning-x-publisher.yml/dispatches`

The body contains only `ref: "main"` and `inputs.publicationId`. The existing workflow is registered on `main`; its checked-out publisher reads the Supabase record by ID, so it does not need Fly's candidate code. The adapter pins API version `2022-11-28`, accepts `204 No Content`, uses a five-second timeout, refuses redirects, and never logs request headers, token values, response bodies, or exception text. Dispatch success means the workflow was accepted; it does **not** mean X publication succeeded. Fly sends no “published” Telegram message.

### Gates and exact order

1. Existing Ankara/Profile B, four-minute fresh-trigger, location, composer, publish-decision, and persistent duplicate/history gates pass.
2. The ledger confirms a **new insertion**, with `decision = WOULD_PUBLISH`, initial `approval_status = pending`, `recordPersisted = true`, `writeDisposition = inserted`, and no duplicate. An existing row, HOLD, stale trigger, unusable location, failed composition, provider-unavailable HOLD, or failed write cannot enter auto orchestration.
3. Emit `publication_pending`.
4. Attempt the existing pending-candidate Telegram notification when configured. Failure or absence of Telegram is independent of auto mode.
5. If auto mode is disabled or unconfigured, emit `auto_publish_disabled` and stop; the row stays pending for the human flow.
6. Reuse `applyManualApproval` and the existing Supabase approval store. Read and validate the persisted ID, decision, text/fingerprint, approval state, and absence of a platform post. Perform the atomic conditional `pending → approved` PATCH, recording actor `fly:guarded-auto-publish` and update time.
7. Dispatch only if **this attempt** receives a validated `updated` outcome, previous state pending, final state approved. Already-approved/skipped rows, published/non-actionable rows, and same-action or opposite-action concurrent winners do not authorize dispatch. Manual rerun semantics remain unchanged; auto reruns perform no second transition or dispatch.
8. The existing GitHub publisher independently validates its record, exact message fingerprint/public-text format, approved state, no platform post/published timestamp, no reserved attempt, credentials, and `X_PUBLISHING_ENABLED`. It claims `publish_attempt_id` before its single X create request.

The two gates apply at different stages: the Fly gate controls new automatic orchestration; the GitHub gate controls the actual X write. Disabling Fly auto mode stops future automatic approvals/dispatches. Use the GitHub kill switch to prevent X writes from already-dispatched workflows as well.

The publisher remains unchanged: only a confirmed HTTP 201 with a numeric platform ID can become PUBLISHED, ambiguous outcomes retain the attempt claim without automatic retry, and definite safe 4xx failures follow its existing conditional claim-release logic. X credentials and OAuth signing remain GitHub-only; the Fly Docker image excludes the X publisher and includes only the additional scoped GitHub dispatch directory.

### Failure and manual recovery

There is at most one orchestration attempt and one dispatch attempt per newly inserted candidate. There is no retry queue or automatic replay of historical pending/approved records.

| Outcome | Durable state and recovery |
| --- | --- |
| Auto disabled or missing/malformed dispatch token | Pending; use the existing human Manual Approval and X Publisher workflows. Fixing configuration does not replay the row. |
| `auto_approval_failed` | Actual state remains authoritative; no dispatch. Inspect the row and use Manual Approval only if it is still pending. Never reopen skipped/published states. A timeout may have committed approval despite no confirmation; inspect before recovery. |
| `auto_publish_dispatch_failed` | Approved stays approved; no rollback and no automatic retry. Inspect GitHub workflow runs and ledger, then run the existing X Publisher manually with the same publicationId if appropriate. A network/timeout failure may have accepted dispatch. The publisher's claim rules still prevent a blind duplicate X write. |
| `auto_publish_dispatch_sent` | Workflow accepted; inspect its Job Summary/artifact and Supabase for the actual outcome. Do not infer PUBLISHED from Fly logs. |
| GitHub publisher disabled or definite failure | Existing publisher recovery rules apply; approved row may be eligible for a later manual workflow run. |
| Publisher ambiguous outcome or failed post-success ledger update | Preserve `publish_attempt_id`; manually reconcile X and Supabase before any further attempt. |

Each auto outcome includes `publicationId`, `incidentId`, a fixed sanitized reason on failure, and HTTP status when available. Failures after insertion never delete the row or stop continuous intake. No optional confirmed-publication Telegram enhancement is included; the existing pending notification remains.

## Operational verification

After a separately authorized manual deploy, inspect `fly logs -a lightning-nearby-ankara-shadow`. Useful markers are:

- `worker_start`: should report `persistence: true`, `xweather: true`, `telegram: true` when configured (otherwise `false`), `autoPublish: true` only when requested with a syntactically valid token (otherwise `false`), `approval: false`, and `publishing: false`. `autoPublish` describes orchestration capability, not guaranteed delivery. `approval: false` continues to denote no standalone human approval interface on Fly; guarded automatic transitions are represented by `autoPublish`. Fly itself always has `publishing: false`.
- `connected`, `source_health`, `disconnected`, and `reconnect_wait`: websocket and watchdog behavior.
- `summary`: five-minute source, filtering, clustering, lifecycle, and candidate counts.
- `source_health`: one structured event per actual source-health transition (including the initial connecting-to-live transition).
- `incident_candidate`, `candidate_rejected_stale`, `location_resolved`, and `enrichment_complete`: candidate preparation stages.
- `duplicate_detected` or `publication_pending`: persistent-history decision or a new pending row.
- `telegram_notification_sent` or `telegram_notification_failed`: one outbound notification outcome for a newly inserted pending row when configured. Match the `publicationId` against `publication_pending`; a failed notification does not determine approval or publication state. A disabled Telegram capability emits only the startup `configuration_warning`.
- `auto_publish_disabled`, `auto_approval_succeeded`, `auto_approval_failed`, `auto_publish_dispatch_sent`, and `auto_publish_dispatch_failed`: correlate using the same publicationId and incidentId. Dispatch markers are orchestration outcomes, never proof of a successful X post.
- `candidate_outcome` and `candidate_processing_error`: safe non-pending outcomes and isolated pipeline failures.
- `out_of_bounds_event`: a limited sample of decoded feed points outside the Ankara subscription bounds, with approximate distance.

Do not use log absence as evidence that no lightning occurred: source gaps and provider limitations remain possible. Check Supabase read/write status through structured candidate outcomes; never paste secret values into logs or reports.

After a separately authorized deployment, first leave both gates disabled and verify persistence/Telegram/manual paths with a genuinely qualifying fresh candidate. Configure the restricted dispatch token and verify startup capability without logging its value. With the GitHub X kill switch still disabled, enable the Fly gate and verify pending → Telegram attempt → approval → dispatch for one new candidate, then confirm the GitHub publisher reports disabled and no X post exists. Inspect the approved row for manual recovery and turn the Fly gate off after this check. Only in a separately authorized live publishing check should both gates be enabled; correlate a new publicationId across Fly logs, GitHub result, confirmed X post ID, and Supabase PUBLISHED. Verify duplicate activity creates no second orchestration, then restore the intended operational gate settings. None of these live checks are performed by this PR's mocked validation.

## Build and deployment

The image uses Node 22 built-in WebSocket/fetch and TypeScript stripping. It copies the complete source directories needed by the worker’s transitive research-pipeline imports, while excluding unrelated publisher code and production app assets. It does not copy secrets. The Fly config remains one Machine in `ams`, shared CPU 1x, 256 MB, no public service, no autostop, and restart policy `always`. Supabase is the durable store; the worker needs no volume.

The scheduled GitHub Ankara Monitor remains unchanged during this phase. Retire it only after pending candidate persistence has been validated with real qualifying events and an explicit operational decision.

## Rollback

For Phase 4, disable `LIGHTNING_AUTO_PUBLISH_ENABLED` to restore the pending-only human flow; disable GitHub `X_PUBLISHING_ENABLED` when an immediate X write stop is required. Neither setting deletes history or reverts approval. Approved records already dispatched remain governed by the publisher's safety/idempotency rules and require inspection before manual recovery.

If Phase 2 behaves unexpectedly, stop the Fly Machine and redeploy the previously validated passive-worker image from the prior passive-worker commit. Do not delete publication history or alter its schema. The GitHub monitor and manual approval/publisher workflows remain independent. Confirm the passive image reports `persistence: false`, `xweather: false`, `approval: false`, and `publishing: false` before resuming the shadow period.

## Billing and trial limits

Fly bills running Machines by the second. Region pricing, storage, and egress can change the total; check current Fly pricing before operating continuously. Trial limits may stop Machines automatically; do not alter billing or resource settings as part of this code change.
