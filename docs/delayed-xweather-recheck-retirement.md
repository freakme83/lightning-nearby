# Delayed Xweather recheck shadow: retirement note

## Purpose and design

The shadow experiment tested whether an initial non-CG result could become an accepted CG result after a short delay, due to provider ingestion or availability latency. After the normal initial path persisted a `#ŞİMŞEK` publication record, the worker scheduled one additional Xweather query for three minutes after the ledger admission timestamp. The worker does not receive a confirmed external-post timestamp, so the ledger timestamp was the available schedule origin.

The recheck reused the initial incident reference (latitude, longitude, and event time), applied the existing initial-CG acceptance checks at recheck time, and emitted comparison telemetry only. Its result did not alter the original publication decision, run CG admission, write another record, notify, approve, or dispatch. Telemetry included the initial and recheck provider statuses, acceptance/currentness diagnostics, timing and location comparisons, and `X-Cost-Tokens` when available; an aggregate recheck token counter was also exposed in the worker summary.

## Evidence preserved

The repository contains deterministic tests and fixtures, but no historical production recheck logs or run dataset from which to estimate live outcome rates. The fixtures demonstrate that:

- One synthetic recheck changes a prior no-match fixture to `cg_verified` and passes the current initial-CG association checks. Its event timestamp is at or before the initial enrichment completion proxy, so the fixture increments `likelyProviderLatencyRecoveries` once. This is a test case, not evidence that a live run observed such a recovery.
- That fixture encodes 2 tokens for the initial request and 5 for the recheck. Other fixtures exercise `no_match`, `ic_only`, and `provider_unavailable`; they do not establish a real-world outcome distribution.
- The recheck fixture leaves the original publication record and side-effect counts unchanged. Because the result was shadow-only, the repository does not show that it materially improved any publication decision.

## Retirement and preserved behavior

The experiment is retired because it was shadow-only, made an extra Xweather request, consumed provider tokens, and could not change the original decision. The current production priority is a simpler, lower-cost Blitz-primary pipeline.

Retirement removes only the delayed recheck. It does not change initial Xweather enrichment or accepted-CG wording, repeat-CG provider queries, urban/rural repeat-CG thresholds, publication cooldowns, Profile B promotion (2 events in 10 minutes), or Blitz source admission.
