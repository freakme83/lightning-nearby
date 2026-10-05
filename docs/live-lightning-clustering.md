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

For each unique decoded event, the pipeline counts subscription-box membership and monitoring-area membership separately. Global age counters (`allUniqueFresh`, `allUniqueStale`, `allUniqueFuture`) cover every unique event. Subscription-box counters (`insideSubscriptionBoxFresh`, `insideSubscriptionBoxStale`, `insideSubscriptionBoxFuture`) cover unique events in the coarse feed box; they sum to `insideSubscriptionBox`. Monitoring-area counters (`insideMonitoringAreaFresh`, `insideMonitoringAreaStale`, `insideMonitoringAreaFuture`) cover unique events that also pass the strict local acceptance geometry; they sum to `insideMonitoringArea`. `insideSubscriptionBoxOutsideMonitoringArea` counts points in the coarse box rejected by the local acceptance geometry. Without a separately selected polygon, the custom subscription box is also the monitoring area. Only fresh, unique, locally accepted events reach clustering. The default age rule is `processing wall clock - eventTimeMs <= 10 minutes`; stale and future events are excluded. The comparison sample uses unique locally accepted points before freshness filtering so each profile receives the same eligible geographic sequence and can apply its own freshness window.

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

### Manual MacBook live validation — 4 October 2026

Command:

```sh
npm run research:lightning-clustering -- \
  --duration=15 \
  --summary-every=60 \
  --box=40.05,-2.05,38.55,-3.85
```

The box covered an active test region centered approximately near `39.30, -2.95`. The MacBook network permitted the WebSocket connection. The 900-second run had one successful connection, a roughly 385 ms handshake, zero reconnects, and a clean duration-end close. It received 337 messages and decoded 821 events: all 821 were unique, with zero duplicates and zero malformed records. Of the unique events, 275 were inside the requested box and 546 outside it. This confirms useful local observations for this run, while reinforcing that the subscription box is not itself a strict geographic filter.

#### Freshness counter scope correction

The historical run summary printed `insideBox: 275`, `fresh: 238`, and `staleReplayRejected: 85`. Those last two fields did not share a denominator: `fresh` counted fresh in-box events, while `staleReplayRejected` counted stale events across the full unique stream. The parameter replay over the same 275 in-box events reported 238 fresh and 37 stale. Thus the local accounting is `275 = 238 + 37 + 0`; the difference between the old all-stream stale count and local stale count is 48 stale events outside the box. The code and runner now emit explicit subscription-box, monitoring-area, and all-unique freshness counters. The historical counter names above are preserved here only to explain the correction; do not compare them as if they shared a scope.

#### Default profile

The baseline profile was 8 km maximum matching distance, 10-minute maximum temporal gap, 10-minute freshness, and 15-minute close interval. Against the same 275 unique in-box events, 238 were fresh, 37 stale, and 0 future-dated. The resulting 59 clusters comprised 37 active and 22 closed clusters. The largest contained 31 events; median cluster size was 1, and 33 clusters were singletons. Median duration was 0 minutes; maximum duration was approximately 21.675 minutes. Maximum approximate extent was approximately 32.93 km.

That extent is the diagonal of a cluster's geographic bounding box, not its storm size. The 8 km value is the pairwise recent-event matching distance, not a cap on cluster extent. A chain of individually nearby observations can extend farther than the matching threshold.

#### Parameter sensitivity on the same input sequence

All profiles replayed the same 275 unique in-box events; freshness-window changes affect how many of those events enter clustering. Extent is the approximate bounding-box diagonal.

| Profile (distance / gap / freshness) | Fresh / stale / future | Clusters (active / closed) | Largest | Median size | Singletons | Median duration | Max duration | Max extent |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| 5 km / 5 min / 10 min | 238 / 37 / 0 | 119 (72 / 47) | 20 | 1 | 82 | — | ~18.659 min | ~21.62 km |
| 8 km / 10 min / 10 min | 238 / 37 / 0 | 59 (37 / 22) | 31 | 1 | 33 | 0 min | ~21.675 min | ~32.93 km |
| 12 km / 10 min / 10 min | 238 / 37 / 0 | 28 (18 / 10) | 51 | 2 | 9 | ~3.749 min | ~22.235 min | ~50.12 km |
| 8 km / 5 min / 10 min | 238 / 37 / 0 | 71 (45 / 26) | 31 | 1 | 45 | — | — | ~32.93 km |
| 8 km / 10 min / 5 min | 189 / 86 / 0 | 46 (35 / 11) | 30 | — | 26 | — | ~17.792 min | ~32.93 km |
| 8 km / 10 min / 20 min | 275 / 0 / 0 | 66 (38 / 28) | 27 | — | 38 | — | ~26.446 min | ~29.60 km |

“—” means the supplied run report did not include that statistic. Across this sample, shorter spatial or temporal limits produced more groups and singletons. The 12 km profile produced fewer, larger groups and a larger chained extent. This shows directional parameter sensitivity, not meteorological correctness.

## Findings and decision

This successful 15-minute run demonstrates that the listener ingested real observations from the selected local box and that the online grouping model produced measurable groups. Replaying the exact same 275-event local sequence shows the expected direction of sensitivity: smaller thresholds fragment the sample more, while a larger distance threshold reduces group and singleton counts but allows larger chained extents. The 8 km / 10 min profile is retained as a reasonable baseline candidate between the observed 5 km / 5 min fragmentation and the larger groups at 12 km / 10 min. This is not a meteorological calibration or an optimal parameter choice.

In the baseline, 33 of 59 clusters were singletons. Those 33 correspond to about 14% of the 238 fresh in-box events. Do not change the clusterer to suppress them in this follow-up. A later incident layer can decide whether a group needs multiple detections or other evidence before promotion; that is incident-promotion / anti-spam policy, not clustering.

**Decision: GO WITH CAVEATS for incident-lifecycle / anti-spam research.** The next step can test how recent activity groups are promoted, updated, and allowed to expire, including handling singleton and very small clusters. The live sample empirically demonstrates ingestion, local filtering, clustering, and same-sequence parameter sensitivity. It does not establish correct cell boundaries, storm tracking, ground-strike grouping, or optimal thresholds.

Production integration and public real-time claims remain blocked. Do not add notifications or social posting in this research stage, and do not make permission-sensitive public use claims. The feed continues to represent generic located lightning observations with discharge type unknown; coverage and lossless completeness are not established.

## Limitations and unknowns

- The coding workspace could not reach the WebSocket, but the separate MacBook run succeeded; workspace transport failure is not evidence about source activity.
- The freshness rule uses event timestamps as supplied by the feed; timestamp delay/root cause remains unresolved by PR #29.
- A bounding box is a test filter, not a province or administrative boundary.
- The clusterer is online and order-sensitive. It does not merge clusters and a capped recent-point list may stop representing older portions of a long or moving activity group.
- Stable source IDs are deduplicated only while retained in the bounded FIFO set; sufficiently old replay after eviction can count again.
- Parameter comparison describes this one retained sample and is not an optimization objective or completeness estimate.
- Events remain generic located lightning observations; discharge type is unknown.
