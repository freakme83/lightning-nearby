# Live lightning activity clustering research

Status: research-only proof of concept. This code is not imported by the Lightning Nearby application and must not be treated as a production lightning source or alerting system.

## Purpose and boundaries

This experiment asks whether unique LightningMaps observations can be grouped into useful local lightning activity clusters. It stops at ingestion, freshness gating, strict local bounding-box filtering, clustering, and aggregate reporting. It does not publish incidents, identify storm cells, or make meteorological claims.

The dependency direction is one-way: `scripts/live-lightning-clustering/` reuses research-only event parsing, subscription, deduplication, and bounding-box helpers from `scripts/live-lightning-listener/`. No production application path imports either research module. No event database or event log is written; each run retains a bounded in-memory comparison sample only.

## Run it

The default test box is the Extremadura research box previously used in listener experiments. It is only a default test rectangle and is not assumed to be active.

```sh
npm run research:lightning-clustering -- --duration=15 --summary-every=60 --box=39.8,-5.8,38.3,-7.6
```

Use any local test rectangle with `--box=north,east,south,west`. The adjustable research parameters are:

```sh
npm run research:lightning-clustering -- \
  --duration=15 \
  --box=39.8,-5.8,38.3,-7.6 \
  --max-distance-km=8 \
  --max-gap-minutes=10 \
  --freshness-minutes=10 \
  --close-after-minutes=15 \
  --summary-every=60 \
  --format=human
```

`--format=jsonl` emits machine-readable summary/control rows. Ctrl+C ends an indefinite or active run cleanly. The runner reconnects with capped exponential backoff and carries the maximum observed `src/id` per source into the next subscription. Raw event payloads and precise event logs are not printed or persisted.

At run end, the runner replays the same bounded set of unique in-box events through six parameter profiles. The default comparison changes spatial distance, temporal gap, or freshness window while holding the other values fixed. Each result includes cluster count, largest and median cluster size, singleton count, duration measures, active/closed counts, and an approximate bounding-box diagonal. This comparison is conditional on the retained sample (capacity 100,000); it is not a global coverage or completeness test.

## Event pipeline and research model

The input remains the PR #29 research event shape: `source`, `eventTimeMs`, `receivedAtMs`, coordinates, optional stable source key and raw delay, and `dischargeType: "unknown"`. Clustering uses `eventTimeMs`; processing wall time is used for freshness. Duplicate suppression uses the listener's `src/id` event key when available and a bounded 20,000-key dedupe window. Dedupe is separate from cluster assignment.

For each unique decoded event the pipeline counts whether it is inside the configured rectangle. It then applies the age gate, whose default is `processing wall clock - eventTimeMs <= 10 minutes`; stale and future events are counted and excluded. Only fresh, unique, in-box events reach the clusterer. The comparison sample contains unique in-box events before freshness filtering so all profiles receive the same event sequence and can apply their own freshness window.

Default parameters are research values:

| Parameter | Default | Meaning |
|---|---:|---|
| Maximum spatial distance | 8 km | New event may match if it is within this distance of any sufficiently recent retained event in a cluster. |
| Maximum temporal gap | 10 min | Candidate event-time separation from a retained cluster event. |
| Freshness window | 10 min | Maximum estimated event age at processing time. |
| Close after | 15 min | Cluster closes after this much time without an event, using event time. |

Recent matching state is capped at 256 points per cluster. Clusters do not merge. If multiple clusters match, assignment orders by nearest matching point, then most recent cluster event, then stable cluster ID. Coordinates and timestamps are not changed by assignment. An out-of-order but fresh event may update the cluster's first time, running centroid, and extent; `lastEventTimeMs` remains the maximum event time observed. The centroid is a simple descriptive centroid, not a storm-cell center. Extent is an approximate bounding-box diagonal.

## Validation

### Deterministic tests

The clustering unit tests cover distance calculations, spatial/temporal splits, a moving A→B→C→D chain, stable-key duplicate suppression, stale replay rejection, close timing, deterministic ambiguous assignment, out-of-order events, and replaying the same input through multiple profiles. They never open a WebSocket.

### Live attempt from the coding workspace — 4 October 2026

Command attempted:

```sh
npm run research:lightning-clustering -- --duration=10 --summary-every=60 --box=39.8,-5.8,38.3,-7.6
```

The runner started at `2026-10-04T17:04:25.561Z`. The Node WebSocket client immediately received transport errors and close code `1006` on repeated connection attempts. No `connected` event, message, decoded event, or cluster was observed before the attempt was stopped after approximately 2.4 seconds. This is an environment/network failure, not evidence about feed activity, clustering quality, replay volume, or source availability. The requested 10-minute live session was therefore not completed, and this workspace run provides no live clustering results.

Prior PR #29 MacBook research directly demonstrated successful plain Node consumption and local filtering, including an Extremadura comparison with 247 unique events inside the box. Those historical observations establish listener feasibility only; they are not input data for this clustering run, and no event dataset was available here to replay. No live cluster count, cluster stability, moving-area behavior, over-splitting/merging rate, singleton prevalence, or parameter sensitivity on real observations can be reported yet.

### Manual live validation

Run the command above from a network that permits outbound WebSockets and preferably select a currently active region with `--box`. A 10–15 minute run is useful. Preserve only the aggregate console output if sharing results; do not commit raw event coordinates or bulk event logs. The end-of-run profile comparison is calculated against the same retained unique in-box sequence.

## Findings and decision

The implementation demonstrates that a simple, bounded nearest-recent-event rule can be tested deterministically and that its moving-chain case stays together. This is unit-test evidence about the algorithm, not evidence that real activity produces stable, human-meaningful groups. A suitable active-region dataset was not observed in the workspace, so whether groups are over-split or over-merged, how common singletons are, and how sensitive the output is to the parameters remain unknown. Replay backlog cannot create new clusters once it is older than the configured freshness window, but its scale in this clustering run is unknown.

**Decision: GO WITH CAVEATS for the next research stage, conditional on collecting and reviewing a successful manual live sample first.** The next experiment may study local spatiotemporal clustering and then incident-lifecycle / anti-spam behavior using observed discharge clusters. Keep its conclusions observational and parameter-specific. The current evidence does not support production integration, public real-time claims, complete coverage, lossless replay, ground-strike claims, or storm-cell identification.

## Limitations and unknowns

- No live event was ingested in the coding workspace; no empirical cluster output is available.
- The freshness rule uses event timestamps as supplied by the feed; timestamp delay/root cause remains unresolved by PR #29.
- A bounding box is a test filter, not a province or administrative boundary.
- The clusterer is online and order-sensitive. It does not merge clusters and a capped recent-point list may stop representing older portions of a long or moving activity group.
- Stable source IDs are deduplicated only while retained in the bounded FIFO set; sufficiently old replay after eviction can count again.
- Parameter comparison only describes the events retained by one run and is not an optimization objective or completeness estimate.
- Events remain generic located lightning observations; discharge type is unknown.
