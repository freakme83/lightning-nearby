# Dual-source lightning shadow observer

## Purpose and authority boundary

This PR2 research process observes LightningMaps/live2 and Blitzortung side by side through multiple Ankara storm windows. It collects source input facts and nearest-neighbor analysis; it does not decide which source is better or production-suitable.

The existing `scripts/fly-ankara-worker/worker.ts` process remains the exclusive production authority. Its command, Fly config, subscription, state, counters, candidate/incident lifecycle, clustering, freshness, Profile B, CG policy, Xweather, Telegram, Supabase, publisher dispatch, and public UI are unchanged. Neither Blitz presence/absence nor any observer match, health, count, or latency can influence them.

## Independent process and inputs

The observer is a separate executable under `scripts/research/dual-source-observer/`. It opens its own read-only subscriptions:

- observer live2: `wss://live2.lightningmaps.org/`, using the existing v24 `subscription()` and `parseFrame()` functions with the existing Ankara monitoring polygon bounds; events are then checked against the unchanged polygon;
- observer Blitzortung: rotating `wss://ws1.blitzortung.org/`, `ws7`, and `ws8`, sending `{"a":111}` and reusing the PR108 decoder/timestamp normalizer.

Both inputs are telemetry-only inside this process. They do not call the production worker. Each has its own socket ownership, health, counters, bounded exponential reconnect backoff, cancelable reconnect wait, open timeout, quiet-frame watchdog, and shutdown path. One source failing, changing protocol, or reconnecting cannot stop or mark the other unhealthy. `SIGINT`/`SIGTERM` closes only observer sockets and clears observer timers.

Only events inside the unchanged Ankara monitoring polygon receive per-event logs and enter matching. All parsed deliveries, including outside-polygon deliveries, remain visible in source summary counts. No wider publication or observation area is introduced.

## Experimental recent Blitz API (PR-A)

The same observer's **existing single Blitz WebSocket** also fills a separate, in-memory recent-event cache after decoding/normalization and before the Ankara comparison filter. Live2 deliveries never enter this cache. It retains Blitz deliveries received within 15 minutes and at most 10,000 events, pruning on insertion and read. The cap bounds a broad/global feed even in heavy activity. No additional Blitz query, geographic request, connection, polling, archive access, persistence, or provider forwarding occurs. Cache failures are contained to observer error logs; matching keeps its existing behavior.

The observer serves only `GET /health` and `GET /recent` on `0.0.0.0:${PORT:-8080}`. `/health` returns `{ "ok": true, "observer": "dual_source_shadow" }`, which checks this API process only, not source connectivity. `/recent` requires the `X-Observer-Token` header matching the `OBSERVER_API_TOKEN` environment variable. If the variable is missing, it fails closed with 503; incorrect/missing headers return 401. Set this token as a Fly secret **only after separate deployment approval**; never put it in the Fly TOML or logs. The Fly HTTP service uses HTTPS and does not auto-stop the long-running observer. No secret is created or deployment performed by this PR.

Example local request after starting `PORT=8080 OBSERVER_API_TOKEN=<local-token> npm run research:dual-source-observer`:

```sh
curl -H 'X-Observer-Token: <local-token>' 'http://127.0.0.1:8080/recent?lat=39.92&lon=32.85&radiusKm=100&windowMinutes=15'
```

Exactly four finite numeric parameters are required: latitude `[-90, 90]`, longitude `[-180, 180]`, radiusKm `(0, 250]`, and windowMinutes `(0, 15]`. Invalid, duplicate, missing, or extra parameters return 400. All radius filtering uses the observer's existing Haversine helper locally. The requested event-time window includes its lower boundary and excludes future provider times; cache retention is separately based on receive time. Results sort by descending event time, then descending receipt time, then local observer ID. Requests do not change source state and are not logged per read.

The successful response is `{ "ok": true, "source": "blitzortung", "fetchedAt": <epoch ms>, "query": { "latitude": ..., "longitude": ..., "radiusKm": ..., "windowMinutes": ... }, "coverage": { "complete": true, "requestedWindowMinutes": ..., "coverageStartMs": ... }, "events": [...] }`. Each event has `observerEventId`, `sourceServer`, `eventTimeMs`, `receivedAtMs`, `latitude`, `longitude`, `latencyMs`, `transportComparisonEligible`, and locally computed `distanceKm`. Counts are deliveries, not unique strikes. Raw negative latency remains visible.

`events: []` by itself does **not** mean the full requested window was clear. Callers must inspect `coverage.complete`. It is true only while the Blitz observer is connected and the requested event-time window starts at or after `coverageStartMs`. A reconnect gap of at most 30 seconds preserves the prior coverage interval for this metadata only; coverage remains false while disconnected, and the source was physically disconnected during that tolerated gap. A longer gap starts a new coverage interval on reconnect. The boundary also incorporates the 15-minute receive-time retention horizon and the latest event time among capacity/retention-evicted records, which can independently make history incomplete. `coverageStartMs` is an epoch-millisecond event-time boundary; retention/pruning still operates on receive time, so evicted event timestamps are tracked to avoid asserting more coverage than the cache can establish. A future PWA must treat empty results with incomplete coverage as unknown/insufficient history, not clear.

This experimental API is not a production or public UI contract. A future PWA adapter must consume **our endpoint**, never open a browser connection to Blitz; the PWA and `/api/lightning/live` are unchanged in this PR.

## Safety and bounded memory

PR108's 16,384-character encoded-frame guard and precision-safe Blitz timestamp handling remain in use. The decoder additionally stops at 262,144 decoded characters or 131,072 cumulative LZW dictionary characters. These are generous protections relative to the few-KB strike payload scale, not protocol interpretation.

Raw non-negative and low-lag latency samples each use a 10,000-value rolling buffer per source. Matching retains at most 20,000 local events, uses a 30-second analysis grace period, and drops finalized history after 60 seconds. The grace period allows for observed source transport/processing latency differences; it is deliberately longer than the 10-second loose event-time window so a later-arriving counterpart can still be considered before an event is finalized as unmatched. This is not a meteorological or production rule and is not a scientifically canonical threshold. Buffer pressure is surfaced with `finalizationReason: "buffer_capacity"`; it is never silently allowed to grow. Five-minute observation buckets close only after the finalization grace period.

## Matching and latency definitions

The named shadow-analysis parameters are:

| Class | Absolute source event-time delta | Haversine distance |
| --- | ---: | ---: |
| strict | at most 2 seconds | at most 3 km |
| loose | at most 10 seconds | at most 10 km |
| none | no counterpart satisfying the loose window | — |

An event waits 30 seconds from observer receipt before finalization, so a later-arriving counterpart can be considered. This analysis grace period is intentionally longer than the 10-second loose event-time matching window to accommodate observed transport/processing latency differences; it is not a meteorological or production rule. The nearest eligible opposite-source event is selected deterministically by event-time delta, then distance, receipt time, and local observer ID. Matching is symmetric observation, not one-to-one assignment: one counterpart may be nearest to multiple events. `strict` and `loose` do **not** prove the same physical discharge. No cross-source or fuzzy within-source deduplication is performed; counts are deliveries/events observed, not unique strikes, and reconnect replay stays visible.

Per-source raw latency is observer receive time minus provider event time. The existing raw `latencyMs` remains unchanged on every event; source summaries retain the non-negative `eligibleSampleCount`, min, median, p95, and max, while future timestamps remain separately counted and excluded from those aggregates. No clock correction is attempted.

Each source also reports a bounded low-lag diagnostic sample for `0 <= latencyMs <= 30,000`, using the diagnostic subset convention already present in the live-lightning listener. Its event flag is `transportComparisonEligible`, and summaries include `lowLagEligibleSampleCount` plus low-lag min, median, p95, and max. Non-negative deliveries above 30 seconds remain in raw latency and increment `delayedLatencyEvents`; they are outside the low-lag comparison window, not proven replays. This subset helps keep startup/backlog-age deliveries visible without letting them dominate practical source transport-latency comparison. The 30-second cutoff is not an upstream guarantee, meteorological threshold, publication freshness rule, or production policy, and it does not classify events as false or stale for publication. Matching and event counts do not use this flag. Matched records also report event-time and receive-time deltas and which observer input arrived first.

Five-minute `dual_source_window_summary` records report each source's event count; per-source strict, loose, and unmatched finalizations; first provider event times; and first-event/first-receipt lead. These neutral windows are not production clusters, episodes, detection accuracy, or quality scores.

## Logs

All output is JSONL on stdout with `observer: "dual_source_shadow"`. The dedicated kinds are:

- `dual_source_observer_start`
- `dual_source_source_connection`
- `dual_source_event`
- `dual_source_match_finalized`
- `dual_source_window_summary`
- `dual_source_summary`
- `dual_source_error`

Source-specific records carry `source: "live2"` or `source: "blitzortung"`; Blitz records also carry `sourceServer`. Comparison/summary records explicitly name both sources. In Fly logs, filtering for `"observer":"dual_source_shadow"` isolates every observer record from production worker kinds.

Blitz event telemetry preserves receive time, normalized and raw provider time, latency/eligibility, coordinates, raw polarity/`mds`/`mcg`/region, station count, polygon membership, and endpoint. These raw values are not quality scores or CG/IC classification.

## Run locally

Node 22.6 or newer is required. This runs until interrupted and writes only stdout:

```sh
npm run research:dual-source-observer
```

No normal automated test makes live WebSocket calls.

## Fly deployment after separate approval

The observer uses `fly.dual-source-observer.toml` and `Dockerfile.fly-dual-source-observer` in a separate Fly app, `lightning-nearby-dual-source-shadow`. The image includes the observer, the two parsers, and the pure geometry helper only; it excludes production lifecycle and every external side-effect adapter. Merging this PR alone starts nothing. Deploying the existing Ankara worker also starts nothing from this observer.

After merge and an explicit operational approval, create the separate app once (replace the organization placeholder), then deploy it:

```sh
fly apps create lightning-nearby-dual-source-shadow --org <fly-organization>
fly deploy --config fly.dual-source-observer.toml --ha=false
```

If the app already exists at zero scale, start only its observer process with:

```sh
fly scale count observer=1 --app lightning-nearby-dual-source-shadow
```

Stop only the observer, without touching production live2:

```sh
fly scale count observer=0 --app lightning-nearby-dual-source-shadow
```

The optional `/recent` API requires `OBSERVER_API_TOKEN` set as an observer-app secret when enabled; without it, the observer still collects source telemetry and `/recent` responds 503. No volume, Supabase table, Telegram token, Xweather key, or publisher credential is required or read.

## Caveats and later evaluation

Blitzortung is an unofficial/raw-feed experiment. Its endpoints, handshake, compression, and fields are undocumented and fragile. This observer access is used under the project's existing permission arrangement; any future public redistribution or use must remain within that permission's scope.

Only a long observation across multiple real storm windows can later inform source continuity, local event density, source gaps, relative transport/event timing, and whether a separate source strategy or public activity experiment deserves another PR. Quiet-weather samples and nearest-neighbor matches must not be treated as superiority, accuracy, failover readiness, or permission. Any trigger, fallback, fusion, Xweather change, persistence, or UI proposal remains out of scope and requires a separate review.
