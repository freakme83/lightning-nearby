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

The Job Summary and small three-day result artifact include start/end, source health, candidate and publication ID, decision, pending approval when persisted, location and enrichment status, duplicate/history outcome, Xweather request diagnostics when available, and the exact existing candidate message. They also record the GitHub event, run ID/attempt, cron expression, actual wrapper start, and monitor duration. The final summary always states: **No social post was sent.** The summary and artifact contain no provider credentials.

GitHub's schedule event provides the triggering cron expression but no intended-occurrence timestamp. The monitor therefore records the expression and actual start but leaves scheduled slot and delay unavailable. It does not infer a slot by rounding the actual start, because that can report a falsely recent slot when a run starts more than one interval late. Timing telemetry does not affect monitoring outcomes.

## Approval and publishing boundary

This workflow never invokes Manual Approval or the X Publisher, never changes approval state, and has no X credentials or `X_PUBLISHING_ENABLED` variable. New actionable rows remain pending until an operator uses **Research Lightning Manual Approval**. The separate manual publisher flow is unchanged. There is no automated publishing or social post.

## Default-branch operation after integration

After integration PR #71 is merged, `main` is the canonical branch and contains both this implementation and its workflow. GitHub scheduled workflows run from the repository default branch, so the `*/15 * * * *` schedule will then run from `main`. Manual runs remain available through `workflow_dispatch`.

The workflow retains a safe implementation-availability check for refs that do not contain the monitor. That check is not the normal post-integration scheduled path. The workflow uses its selected/current ref with normal checkout behavior; it does not force checkout of `merge-ready`.

The earlier registration-only phase, when the workflow file existed on `main` without its implementation and scheduled runs safely skipped, is historical and superseded by PR #71. Integration activates unattended detection and pending-candidate creation on the default branch; it does not automate approval or publishing. Actionable candidates remain `approval_status=pending`, Manual Approval remains manual, and the X Publisher remains manual. No automatic X publishing exists. Schedule telemetry records available GitHub run timing data to assess schedule jitter, with a null slot and delay until GitHub supplies a reliable intended occurrence timestamp.
