# Research: paired LightningMaps / Xweather validation

This manual research harness captures one pair: an incident produced by the existing live LightningMaps-compatible feed pipeline and one Xweather `/lightning/closest` enrichment result. It reuses the incident runner’s filtering, clustering, source-health handling, lifecycle, and dry-run publish policy. It does not contact Nominatim and is not connected to production, a composer, or a publisher.

## Trigger and one-call guardrail

Only the first actual `WOULD_PUBLISH` decision for the selected lifecycle profile triggers enrichment. Candidates, expired candidates, suppressions, and cluster updates do not. The controller claims its single enrichment call synchronously before awaiting Xweather, so later decisions cannot start a second call. The runner stops collecting feed data after that trigger, waits for the one result, and writes a paired JSON artifact.

If the bounded live run ends first, it writes `no_publish_candidate`, reports zero enrichment calls, and makes zero Xweather requests. If credentials are absent, the existing adapter returns `provider_unavailable / missing_credentials`; no HTTP request is made. Credentials are supplied to the manual workflow only through `XWEATHER_CLIENT_ID` and `XWEATHER_CLIENT_SECRET` repository secrets.

## Trigger freshness guard

A live listener may connect with recent buffered or replayed feed activity. In one hosted paired run, the first `WOULD_PUBLISH` incident referenced activity at 15:31:31Z, while pairing began around 15:41:27Z. That roughly ten-minute-old incident still passed the lifecycle's own rules, but the resulting `no_match` request used 10 Xweather tokens and was too old for a useful recent-window comparison.

Paired validation therefore applies its own deterministic trigger guard: `Date.now() - incident.lastActivityTimeMs` must be between zero and **4 minutes** (inclusive). Four minutes is an operational research default intended to leave about one minute of margin against Xweather's approximate five-minute recent window; it is not meteorological truth. A future-dated or invalid timestamp is conservatively skipped and diagnosed. This does not invalidate, suppress, or modify the lifecycle incident.

Stale publish decisions are logged and skipped without claiming the one-call guard or stopping the feed. The run keeps listening for a later fresh `WOULD_PUBLISH`. If it ends after stale/ineligible candidates only, the artifact is `no_fresh_publish_candidate`, with stale count, freshest skipped stale age, the threshold, and zero provider requests. These skips consume no Xweather credits.

## Pair and reference fields

The incident snapshot is taken from the actual promoted incident: `representativeLatitude` and `representativeLongitude` locate the accumulated incident; `lastActivityTimeMs` is the enrichment reference event time. `firstEventTimeMs`, `totalEvents`, and `sourceClusterIds.length` are included as context. Promotion time is not used as event time because it records when the lifecycle processed the promotion.

The artifact contains the selected incident and profile, its coordinate/time/event/cluster counts, the full structured enrichment result (including thresholds, classification, selected event, counts, and cost diagnostics when present), plus the enforced one-call guardrail. `paired_result` is observational, not a PASS/FAIL score.

The paired query uses the enrichment adapter’s unchanged defaults: 10 km query radius, 8 km local match distance, ±5 minutes, limit 10, and deterministic ranking. A successful paired result means: “An Xweather CG/IC event was found near the research incident within the configured space/time thresholds.” The live sources are independent; compatible records are useful paired evidence, not proof that they represent the exact same physical flash.

- `cg_verified` means an Xweather CG event matched the incident within configured spatial and temporal thresholds. It does not prove exact flash identity, meter-level impact location, damage, danger, or public-safety-grade detection.
- `ic_only` means a matching IC event was found and no matching CG was found within these bounds; it does not claim there was no CG elsewhere.
- `no_match` is a successful query with no locally matching returned event; it is not evidence of no lightning.
- `provider_unavailable` remains distinct from both states and includes safe failure diagnostics.

The manual workflow supports the same custom bounding-box inputs as the incident research workflow and defaults to custom mode; Ankara is optional. Duration is bounded to 5–20 minutes and the default lifecycle profile is the existing moderate profile B. The workflow is manual-only, uses Node 22, has a bounded timeout and short artifact retention, and contains no schedule or automatic production trigger. The observed small-query cost was 10 tokens in one prior test; billing assumptions are not used by the guardrail.
