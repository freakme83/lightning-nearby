# AGENTS.md

## Repository

Repository:
https://github.com/freakme83/lightning-nearby

This repository contains the Lightning Nearby application and an Ankara-focused live-lightning research/worker system.

For worker, research, telemetry, shadow experiments, and runtime work:

- `merge-ready` is the source of truth
- `main` must NOT be modified unless explicitly requested
- new branches must start from current `merge-ready`
- PRs for worker/research/runtime work must target `merge-ready`

Do not assume `main` is current for worker/runtime behavior.

## Default safety rules

Unless the task explicitly says otherwise:

- do NOT merge PRs
- do NOT deploy
- do NOT modify `main`
- do NOT write to Supabase
- do NOT send Telegram messages
- do NOT publish to X
- do NOT trigger production publication paths
- do NOT change secrets
- do NOT create or apply database migrations
- do NOT make live provider calls unless the task explicitly permits them
- do NOT broaden the scope of the task
- do NOT refactor unrelated code

Prefer narrow, reversible changes.

## Branch and PR discipline

For implementation tasks:

1. branch from current `merge-ready`
2. keep the branch focused on one coherent change
3. target PR to `merge-ready`
4. open PR as DRAFT unless explicitly asked otherwise
5. do not merge
6. use `[skip netlify]` in commit messages for backend/research/worker-only changes when appropriate

In the final report include:

- branch name
- commit SHA
- PR number/link
- changed files
- tests run and results
- any known failures or pre-existing failures
- explicit confirmation of whether production behavior changed

## Production behavior

The Ankara live-lightning worker has real publication side effects.

Treat any change affecting the following as production-sensitive:

- candidate lifecycle
- promotion thresholds
- clustering
- incident association
- outer-district policy
- Xweather enrichment
- CG / repeat-CG behavior
- publication decisions
- Supabase ledger
- Telegram notifications
- approval flow
- publisher dispatch
- X publishing
- restart/recovery behavior

If a task is described as:

- shadow-only
- telemetry-only
- read-only
- experiment
- comparison

then production behavior must remain unchanged.

Shadow code must not silently call providers, write persistence, notify users, approve publications, dispatch publishers, or alter lifecycle state.

## Current Profile B baseline

Unless explicitly changed by the task:

- promotionMinEvents = 3
- promotionWindowMinutes = 10
- closeAfterMinutes = 20
- activeAssociationDistanceKm = 10

Do not lower or reinterpret these thresholds casually.

## Testing expectations

For code changes:

- run focused tests for the changed area
- run relevant regression tests
- run TypeScript checks
- run lint if practical
- preserve existing production behavior unless the task explicitly changes it

Do not claim tests passed unless they were actually run.

If unrelated pre-existing failures occur:
- identify them clearly
- distinguish them from regressions introduced by the change

## Review behavior

For review-only tasks:

- do not modify code
- inspect the actual diff, not only the PR description
- compare against current `merge-ready`
- identify blockers separately from observations
- verify that claimed safety boundaries are real
- check for unintended production side effects
- check whether telemetry/state is bounded
- check whether tests cover the intended behavior

Do not approve an implementation based only on author summary.

## Supabase

Database changes require explicit authorization.

Before applying or proposing a migration that may already exist:

- inspect current migration history first
- do not blindly reapply migrations
- do not assume repository filenames match manually applied migration history

## Live providers

Provider calls may cost money or affect rate limits.

Do not make live Xweather or other provider calls unless the task explicitly allows it.

Tests should prefer mocks.

## Fly deployment

Do not deploy unless explicitly asked.

If asked to prepare for deployment:
- verify the correct workflow/branch behavior first
- do not assume a workflow deploys `main`
- report exactly what would be deployed

## Working style

Prefer:
- narrow diffs
- explicit state transitions
- bounded in-memory telemetry
- deterministic tests
- structured logs
- minimal coupling between shadow experiments and production logic

Avoid:
- broad refactors
- speculative architecture changes
- silent policy changes
- hidden provider calls
- hidden persistence
- modifying unrelated workflows

## Escalation

Stop and ask for clarification before proceeding if the task would require:

- touching `main`
- merging
- deploying
- applying a migration
- changing publication policy
- changing thresholds
- adding paid/live provider calls
- changing secrets
- sending user-facing messages
- publishing to X
- expanding beyond the requested scope
