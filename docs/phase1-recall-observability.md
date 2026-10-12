# Phase 1 recall observability and candidate recovery

Scope: research worker only. Preserve Profile B, clustering, nearby cooldown,
provider deduplication, atomic CG admission and publisher safety.

- Recover evaluation when a continuing cluster's expired, non-promoted candidate
  later satisfies the existing rolling three-in-ten-minute condition.
- Measure first-CG transitions in shadow telemetry only; actual admission stays HOLD.
- Distinguish supported provider/coordinator outcomes and remove recent-event arrays
  from ordinary worker summaries.

The closed `candidate_expired` identity retains a bounded rolling event-time window
while its cluster is live. A later qualifying window recovers that same incident ID
once and enters the ordinary promotion/publication policy. If an equivalent active
incident has appeared meanwhile, the cluster joins it and receives its usual
activity suppression. Previously published quiet-closed incidents do not recover.
The event that meets the threshold is counted once; the prior failed candidate's
historical detections are not replayed into an attached active incident.

Worker summaries include cluster geometry/counts but omit `recentEvents`. Their
`recall` object counts expiration, later observations, recovery, promotion, active
association and permanently ignored observations. Expiration/recovery transitions
also emit one concise event each. Full event snapshots are not emitted by default.

`cgRepeat` summarizes queued/started/coalesced/dropped probes, pre-query eligibility
rejections by reason, query and admission counts, and initial/repeat provider result
categories. `cg_repeat_provider_result` records the adapter status, supported
returned-event spatial/temporal rejection counts (which can overlap), selected
identity/coordinate/time and precise selected/reference timing. Rejections are
derived only from the bounded returned payload; a provider-wide conclusion cannot
be inferred. Earlier adapters or unavailable responses explicitly retain an
ambiguity marker.

`first_cg_transition_shadow` is emitted only when the actual atomic admission
returns `no_positive_cg_history`. It records the selected CG, duplicate/currentness
and semantic checks, classification and any other blockers. Its eligibility is a
hypothetical result; the actual decision stays HOLD, without positive insertion,
Telegram or X dispatch. Counts are candidate evaluations, not distinct provider
strikes; analyze provider IDs for distinct opportunities. Startup/recovery holds,
provider deduplication and all existing promotion/cooldown thresholds remain active.

No new publishing policy, query budget, external service or database migration.

Validation: focused regression tests, the full research test suite and TypeScript
`--noEmit --incremental false` check. No hosted deployment was performed.
