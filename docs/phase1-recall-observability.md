# Phase 1 recall observability and candidate recovery

Scope: research worker only. Preserve Profile B, clustering, nearby cooldown,
provider deduplication, atomic CG admission and publisher safety.

- Recover evaluation when a continuing cluster's expired, non-promoted candidate
  later satisfies the existing rolling three-in-ten-minute condition.
- Measure first-CG transitions in shadow telemetry only; actual admission stays HOLD.
- Distinguish supported provider/coordinator outcomes and remove recent-event arrays
  from ordinary worker summaries.

No new publishing policy, query budget, external service or database migration.
Implementation details and validation will be recorded before this draft is ready.
