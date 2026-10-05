# Lightning activity incident lifecycle research

Status: standalone research track. This experiment produces lifecycle metrics and synthetic `WOULD_PUBLISH` / `SUPPRESS` decisions only. It has no publisher and is not imported by the Lightning Nearby application.

## Purpose and boundaries

The incident layer explores when an observational lightning activity cluster might become an incident candidate, promote to an active incident, remain active, close after a known quiet period, or be held back as a similar nearby repeat. The decision thresholds are comparison profiles, not product or meteorological rules.

Dependency direction is one-way: `scripts/lightning-incident-lifecycle/` reuses the research listener and clustering code. No production UI/API, forecast classifier, Xweather flow, service worker, notification, persistence, reverse-geocoding, map-link, or social-posting code is used or changed. Inputs remain generic located lightning observations; discharge type is unknown.

## Run it

```sh
npm run research:lightning-incidents -- \
  --duration=15 \
  --summary-every=60 \
  --box=40.05,-2.05,38.55,-3.85 \
  --incident-profile=B
```

`--incident-profile` accepts `A`, `B`, or `C`; the selected profile is used for the live dry-run view, while all profiles are compared against the same retained incident-signal sequence at the end. `--box=north,east,south,west` accepts any strict local rectangle. `--format=jsonl` emits structured output. The default cluster parameters remain those from the clustering research: 8 km maximum recent-point match, 10-minute event-time gap, 10-minute freshness, and 15-minute cluster close. The live listener uses the existing plain Node WebSocket, subscription, resume IDs, and bounded dedupe.

Only bounded in-memory signals are retained (100,000). Nothing is written to disk. If the cap is reached, the comparison reports dropped signals and describes only the retained prefix. `WOULD_PUBLISH` is synthetic; the runner creates no message or social text and sends nothing.

## Separation of layers

The experimental flow is:

1. Listener decodes and deduplicates events; the existing clustering pipeline applies the 10-minute freshness rule and strict local box.
2. Fresh, unique, in-box events update the unchanged default clustering model.
3. The incident layer consumes cluster-ID-tagged activity observations and cluster-close transitions. It does not modify the clusterer.
4. A separate dry-run policy consumes incident promotions, repeated active activity, and close transitions to produce synthetic decisions.

The data concepts remain distinct: `LightningEvent`, `LightningCluster`, `ClusterObservation`, `LightningIncident`, and `PublishDecision`.

## Incident state and experimental profiles

An incident candidate is seeded by an observed cluster. It promotes only when the configured number of events fall within the configured **event-time** window. A candidate that reaches its processing-time expiry while source health is live, or whose source cluster closes while health is live, closes as `candidate_expired` and never generates a publish candidate. A candidate with one event contributes to the singleton-ignored metric.

Promoted incidents become `active`. Events already mapped to that incident update its event count and event-time extrema. A new cluster within 10 km can attach to a nearby active incident while it is within that incident's close interval. It does not create another incident. Matching is deterministic by nearest representative point, then most recent incident activity, then stable incident ID.

| Profile | Promotion threshold | Candidate window | Quiet close | Nearby cooldown |
|---|---|---:|---:|---|
| A — permissive | 2 events | 5 min | 20 min | none |
| B — moderate | 3 events | 10 min | 20 min | 10 km / 20 min |
| C — conservative | 3 events | 10 min | 30 min | 10 km / 30 min |

All profiles use a 10 km active-incident association radius. These are experimental policy values. They are not calibrated to lightning physics or user notification tolerance.

The publication policy creates one `WOULD_PUBLISH` decision on a promotion unless the promotion is similar to a recently **published dry-run** incident that closed within that profile's cooldown distance and period. Further activity in the same incident is counted as `SUPPRESS already_published_active_incident`; it does not create another publish candidate. A cooldown-suppressed active incident stays an observational incident, but its later events do not create repeated suppression log spam. Closing an incident never publishes. Only prior `WOULD_PUBLISH` incidents seed the nearby cooldown history.

## Clock and source-health semantics

The runner keeps these clocks separate:

| Clock | Use |
|---|---|
| Event time (`eventTimeMs`) | Promotion-window membership; incident first/last activity timestamps. Out-of-order observations update min/max without moving the maximum backward. |
| Receipt/processing time | Candidate expiry, promotion-decision timestamp, quiet-period closure, and incident duration after promotion. |
| Source-health wall time | Detects when data coverage is stale or disconnected and gates lifecycle timers. |

Source health begins `disconnected`, becomes `connecting` at socket open, becomes `live` after the first frame, becomes `stale` after 90 seconds without a frame, and becomes `disconnected` on socket close. Stale connections are closed by the research runner to trigger its reconnect loop. Candidate expiry and incident quiet-close timers advance only while health is `live`. When health returns from stale/disconnected to live, candidate and active-incident processing-time timers restart from recovery; the unknown outage interval is not interpreted as inactivity. An intentional run-end close is not counted as a source interruption and does not close active incidents.

The clusterer retains its own event-time lifecycle and can close a cluster after its baseline interval. The incident's longer profile close interval is separate. Closing one cluster does not automatically close an active incident; incident quiet-close remains gated by live source health.

## Metrics and same-sequence comparison

The run reports clusters observed, candidates created/expired, promotions, quiet closes, synthetic publish candidates, suppressions by reason, nearby-repeat suppressions, recreated nearby candidates, ignored singleton candidates, source-health interruptions, average event count at promotion, median time-to-promotion, and median duration after promotion.

At completion, profiles A/B/C are replayed over the **same ordered activity, cluster-close, and source-health signal sequence**. This compares policy behavior on identical cluster evidence. If the in-memory signal cap was reached, the comparison is over the retained prefix and says so. Fewer publish candidates alone do not establish a better profile.

## Deterministic validation

The offline tests cover singleton withholding, 2- and 3-event promotion, candidate expiry, active-incident continuity, repeated-activity suppression, quiet close, disconnect protection, recovery timer reset, nearby renewal, cooldown suppression and expiry, geographically separate incidents, out-of-order event timestamps, deterministic replay, directional profile comparisons, and source-health interruption accounting. Tests do not connect to the WebSocket or pretend a live connection succeeded.

## Live validation attempt — 5 October 2026

Command:

```sh
npm run research:lightning-incidents -- --duration=0.5 --summary-every=5 --box=40.05,-2.05,38.55,-3.85
```

The attempt started at `2026-10-05T08:23:54.275Z` and was stopped after about 15 seconds of repeated connection failures. Five WebSocket attempts ended with close code `1006` before the handshake; successful connections: 0; messages: 0; decoded events: 0; candidates/promotions/publish decisions: 0. This is a coding-workspace network failure, not evidence that the box had no activity. No 10–15 minute incident-policy comparison was possible.

The 4 October MacBook clustering run recorded 821 unique listener events and aggregate cluster/profile metrics, but no event-level sequence was committed or retained for this experiment. Those aggregate cluster totals cannot be transformed into incident decisions without inventing event order and timing. Obtain a new manual live run and retain only the runner's aggregate output before evaluating policy profiles on real observations.

## Findings and decision

The deterministic engine supports candidate promotion, anti-repeat decisions, quiet closure with a live source, and source-outage protection. Its thresholds and behavior have not yet been evaluated on a real incident-signal sequence. Therefore the run cannot answer whether the profiles suppress noisy clusters appropriately, whether a nearby cooldown feels calm, or which profile has the best balance. No empirical candidate/promotion/publish counts are claimed.

**Decision: GO WITH CAVEATS for message-composer / dry-run posting research after a successful manual incident run.** The next experiment may assess synthetic decisions and policy balance on an identical live-derived signal sequence, without creating or sending message text. Until then, policy usefulness remains unvalidated. Production integration, public real-time claims, storm-cell/ground-strike claims, notification or social posting, and permission-sensitive public use remain out of scope.

## Limitations

- No event-level MacBook capture is available to replay through incident policies.
- Feed delay and completeness remain unresolved; freshness is not a real-time guarantee.
- Closure is a research timer gated by observed source health, not proof that lightning stopped.
- Representative coordinates and 10 km association/cooldown radii are geometric heuristics.
- The engine does not infer severity, storm type, movement, direction, danger, or ground-strike status.
- The profile comparison is a sensitivity tool, not a method for selecting a meteorologically correct threshold.
