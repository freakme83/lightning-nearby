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

## Safety and bounded memory

PR108's 16,384-character encoded-frame guard and precision-safe Blitz timestamp handling remain in use. The decoder additionally stops at 262,144 decoded characters or 131,072 cumulative LZW dictionary characters. These are generous protections relative to the few-KB strike payload scale, not protocol interpretation.

Eligible latency samples are held in a 10,000-value rolling buffer per source. Matching retains at most 20,000 local events, uses a 30-second analysis grace period, and drops finalized history after 60 seconds. The grace period allows for observed source transport/processing latency differences; it is deliberately longer than the 10-second loose event-time window so a later-arriving counterpart can still be considered before an event is finalized as unmatched. This is not a meteorological or production rule and is not a scientifically canonical threshold. Buffer pressure is surfaced with `finalizationReason: "buffer_capacity"`; it is never silently allowed to grow. Five-minute observation buckets close only after the finalization grace period.

## Matching and latency definitions

The named shadow-analysis parameters are:

| Class | Absolute source event-time delta | Haversine distance |
| --- | ---: | ---: |
| strict | at most 2 seconds | at most 3 km |
| loose | at most 10 seconds | at most 10 km |
| none | no counterpart satisfying the loose window | — |

An event waits 30 seconds from observer receipt before finalization, so a later-arriving counterpart can be considered. This analysis grace period is intentionally longer than the 10-second loose event-time matching window to accommodate observed transport/processing latency differences; it is not a meteorological or production rule. The nearest eligible opposite-source event is selected deterministically by event-time delta, then distance, receipt time, and local observer ID. Matching is symmetric observation, not one-to-one assignment: one counterpart may be nearest to multiple events. `strict` and `loose` do **not** prove the same physical discharge. No cross-source or fuzzy within-source deduplication is performed; counts are deliveries/events observed, not unique strikes, and reconnect replay stays visible.

Per-source latency is observer receive time minus provider event time. Source summaries report eligible count, min, median, p95, and max separately. A future provider timestamp keeps its raw and normalized event time plus negative `latencyMs`, is marked `latencyEligible: false`, increments that source's future-timestamp count, and is excluded from aggregates. No clock correction is attempted. Matched records also report event-time and receive-time deltas and which observer input arrived first.

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

No secrets, volume, Supabase table, Telegram token, Xweather key, or publisher credential is required or read.

## Caveats and later evaluation

Blitzortung is an unofficial/raw-feed experiment. Its endpoints, handshake, compression, and fields are undocumented and fragile. Prior repository research also records unresolved usage, permission, and redistribution constraints; technical access is not permission for public reuse.

Only a long observation across multiple real storm windows can later inform source continuity, local event density, source gaps, relative transport/event timing, and whether a separate source strategy or public activity experiment deserves another PR. Quiet-weather samples and nearest-neighbor matches must not be treated as superiority, accuracy, failover readiness, or permission. Any trigger, fallback, fusion, Xweather change, persistence, or UI proposal remains out of scope and requires a separate review.
