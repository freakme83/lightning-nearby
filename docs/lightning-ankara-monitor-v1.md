# Ankara monitor v1 — research only

`Research Lightning Ankara Monitor` automates bounded detection and persistent candidate creation for research. It reuses the existing live end-to-end pipeline; it does not approve records or publish to social media.

## Monitoring behavior

- Schedule: every 15 minutes (`*/15 * * * *`); manual `workflow_dispatch` is also available.
- Window: one ten-minute run, using existing lifecycle profile B. The existing live runner stops early when paired validation reaches its first fresh publish candidate; otherwise the window ends normally.
- Area: `--area=ankara` selects the existing `ANKARA_MONITORING_AREA` polygon. The live feed may subscribe to its enclosing box, but local polygon acceptance remains authoritative.
- Concurrency: all monitor runs use `research-lightning-ankara-monitor` with `cancel-in-progress: false`, so an active run is not cancelled and two monitor runs do not execute concurrently. GitHub keeps at most one pending run per concurrency group; a newer pending run may replace an older pending run.
- Pipeline: the monitor invokes the existing end-to-end runner, which owns feed filtering, deduplication, clustering, incident lifecycle, paired Xweather enrichment, location naming, Composer v1.1, publish-decision, and persistent ledger handling.

The wrapper does not alter thresholds, wording, duplicate matching, or lifecycle policy. It requires Supabase and Xweather configuration before starting. It reports ledger read/write/configuration failures and other pipeline failures as failed workflow runs. A candidate that passes the existing gates is persisted by the existing ledger with `approval_status=pending`. Existing safe `HOLD` results stay `HOLD`; known duplicates are successful non-actionable outcomes.

## Normal and failure outcomes

Successful outcomes include no publish candidate, no fresh candidate, no usable location label, a known persistent duplicate, a safely held observation, and a newly persisted pending candidate. No usable location label does not create an actionable record. A duplicate cannot create a second actionable pending candidate under the existing duplicate rules.

Operational failures include missing required configuration, live or paired-run failure, location lookup or message composition failure, unavailable/invalid ledger configuration, ledger history read failure, and ledger write failure. These are surfaced as a failed monitor run. Existing end-to-end stop behavior and source-health gates remain authoritative.

The Job Summary and small three-day result artifact include start/end, source health, candidate and publication ID, decision, pending approval when persisted, location and enrichment status, duplicate/history outcome, Xweather request diagnostics when available, and the exact existing candidate message. The final summary always states: **No social post was sent.** The summary and artifact contain no provider credentials.

## Approval and publishing boundary

This workflow never invokes Manual Approval or the X Publisher, never changes approval state, and has no X credentials or `X_PUBLISHING_ENABLED` variable. New actionable rows remain pending until an operator uses **Research Lightning Manual Approval**. The separate manual publisher flow is unchanged. There is no automated publishing or social post.

## GitHub default-branch caveat

GitHub scheduled workflows run from the repository default branch. A workflow also needs to be present on the default branch before its manual **Run workflow** entry is reliably available. This PR targets `merge-ready`, while the monitor implementation also remains on `merge-ready`; this PR does not register the workflow on `main`.

When the workflow definition is later registered on the default branch without the monitor implementation, a scheduled run checks out that default-branch ref and safely stops before dependency installation or provider calls. The workflow writes a summary that the implementation is unavailable on the checked-out ref. This prevents the workflow file alone from starting incomplete automation. Manual runs must select `merge-ready` so the workflow and implementation are both present.

Unattended scheduling must remain dormant until the implementation is available on the default branch, or an explicit checkout strategy for the implementation ref is separately designed, documented, and tested. This PR does not force checkout of `merge-ready`. Any later narrow workflow-registration PR must not be mistaken for enabling unattended monitoring.
