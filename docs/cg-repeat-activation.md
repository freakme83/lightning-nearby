# Guarded CG repeat admission

This change adds an admission policy in the Fly runtime and publication ledger.
It does not deploy a worker, apply a hosted migration, or change Profile B,
Telegram, approval, dispatch or X publish-attempt behavior. It is not a hard
wall-clock X posting quota: delayed approved workflows may still post together.

## Trigger and request budget

Only unique accepted, fresh feed observations in a promoted active incident can
trigger a repeat probe, and only for `already_published_active_incident`,
`nearby_cooldown` or `already_active_suppressed_incident`. Initial paired-validation
controllers retain their one-attempt contract. A repeat uses the new observation's
coordinate/time for Xweather; incident coordinates remain separate in the artifact
and ledger. Naming and comparison use the selected full-precision provider CG.
The repeat message uses that selected CG's time. Initial message behavior is unchanged.

The dedicated coordinator permits one provider evaluation at a time across the
worker, at most one latest queued observation per scope and 32 tracked scopes.
It allows one start per scope per 120 seconds. Intake/housekeeping pumps the queue;
there is no replay timer. Queued observations are rechecked before starting.
Excess/expired work is dropped, not published. No new global tweet interval exists.

Only an identified `cg_verified` result continues. The selected event must be
nonfuture, no more than four minutes old and within 60 seconds of the probe's
reference time. Health, recovery and freshness are rechecked after asynchronous
enrichment/naming; the database also enforces selected/reference freshness.
IC, no-match, provider failure, missing identity or stale provider matches remain
suppressed. Geography, composer, duplicate and persistence gates remain authoritative.

## Semantic admission

Reliable structured identity must differ from **every** relevant admitted CG place.
Distance is measured between full-precision selected provider coordinates:
both positively urban => 1 km; either rural/unknown => 5 km. Explicit village/hamlet
evidence wins over a town parent. Missing/ambiguous identity cannot establish change.
Losing neighborhood detail within the same parent is not proof of a new place.
A positively urban, explicitly typed town/city/municipality center can establish
a village-to-center change with reliable hierarchy; the stricter 5 km still applies.

All positive rows in the current scope (and its explicit cooldown predecessor)
remain semantic comparison history while that scope is relevant. This blocks
Ayranci-to-Balgat-to-Ayranci cycling even after the first row leaves the burst window.
Only the current scope's rows admitted in `(now - 20 minutes, now]` count for its
three-total cap. Initial CG is #1; pending and approved rows reserve places/slots.
Skipped or unresolved positive rows remain conservatively reserved. A predecessor
contributes comparison history but not the new incident's burst count.

## Durable state and failure handling

`cg_repeat_scopes` persists scope identity, run/local incident owner and an explicit
predecessor relationship. Nullable `publication_records.cg_scope_id` links positive
admissions to their scope; PR #82 `cg_metadata` remains their comparison source.
Old NULL metadata is not guessed from labels, Maps URLs or rounded coordinates.
An override requires a trustworthy positive CG baseline; an initial non-CG or held
CG cannot provide it. This feature does not upgrade an initial IC-only incident to
its first CG publication later in that incident.

`admit_cg_publication` is a service-role-only, SECURITY INVOKER RPC. The scopes table
has RLS and no public/user grants. Ordered PostgreSQL transaction advisory locks
serialize current/predecessor scope checks and insertion. The successful pending
publication insert **is** the admission reservation. There is no separately consumed
quota slot. Existing publication-ID and provider-event uniqueness remain intact;
the fallback duplicate matcher is also retained in the transaction. Initial CG
accounting uses the same RPC without going through a repeat probe.

Read failure, RPC failure, ambiguous committed response, unique conflict or an
existing publication ID cannot dispatch a new publisher job. An uncertain insert
may already reserve a positive row; it is neither removed nor blindly dispatched.
After approval/dispatch failure the existing recovery semantics are unchanged.

## Restart / continuity strategy

Scopes are durable but lifecycle association is not recovered across processes.
Instead, **repeat overrides are held for 40 continuous healthy minutes after startup
or a source interruption** (Profile B close + cooldown interval). A frame gap >=90
seconds, a disconnected/stale/connecting transition or clock rollback resets that
hold. Old rolling admissions have therefore expired before a new run can probe.
Ordinary initial generic publications remain available, including independent
incidents; exact provider duplicate protection still applies across runs.

This deliberately sacrifices repeats during recovery rather than inventing scope
continuity. It is intended for the current single-Machine worker. Overlapping
independent workers with different scopes are outside this PR's scope; the database
protects concurrent writers **of the same scope** and provider IDs across scopes.

## Rollout and validation

1. Apply `20261011165220_cg_repeat_admission.sql` after the PR #82 metadata migration.
   It adds a small scopes table, nullable linkage, partial scope index and RPC.
   Existing rows/indexes/RLS and publisher columns are not repurposed.
2. Confirm the service role can execute the RPC and access its table. No anon or
   authenticated access should be granted. Refresh PostgREST's schema cache if needed.
3. Deploy the reviewed worker separately. Expect a 40-minute recovery hold.
4. Inspect `cg_repeat_probe`, `cg_repeat_outcome`, `cg_repeat_recovery_hold` and the
   concise summary fields. They expose scope, suppression cause, reference, selected
   ID/age, classification, identity availability, decision/count and distance denials;
   no credentials or arbitrary provider payloads are logged.

Policy defaults live in `lightning-cg-repeat-policy/constants.ts`. SQL independently
enforces the same versioned defaults; tuning a threshold requires updating both and
their parity tests/migration. The SQL RPC uses database time for admission timestamps.

Run all research tests with `node --experimental-strip-types --test scripts/*/*.test.ts
scripts/*/storage/*.test.ts` and TypeScript with `tsc --noEmit --incremental false`.
The local PostgreSQL contract test additionally uses an installed PGlite module via
`CG_REPEAT_POSTGRES_TEST_MODULE=/absolute/path/to/@electric-sql/pglite/dist/index.js`.
It validates migration reruns, role isolation, quota/history semantics, concurrent
request submission, uniqueness and rollback; PGlite uses one serialized connection,
so this is not a live multi-session PostgreSQL load test. No hosted queries are run.
