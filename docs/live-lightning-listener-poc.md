# Standalone live lightning listener PoC

Research-only experiment on `merge-ready` commit `f6f434f` (4 October 2026). This is **not** a production integration, a ground-strike detector, a safety warning service, or permission to redistribute provider data. It changes no forecast classifier, UI, or application runtime imports.

## Run

Node >=22.6 (the project runtime requirement); no additional dependency. From repository root:

```sh
npm run test:research:lightning-listener
npm run research:lightning-listener -- --duration=60
npm run research:lightning-listener -- --duration=15 --format=jsonl --summary-every=300
npm run research:lightning-listener -- --force-reconnect-every=300
npm run research:lightning-listener -- --duration=2 --force-reconnect-every=30 --resume=false
npm run research:lightning-listener -- --duration=15 --box=37.5,35.0,34.5,28.0
npm run research:lightning-compare -- --duration=7
```

`--duration` is minutes; omitted means until Ctrl+C. `--force-reconnect-every` and `--summary-every` are seconds. `--resume=false` sends `i:{}` on every reconnect for a controlled replay comparison; the default sends the last seen IDs. `--box` order is north,east,south,west; the default Ankara-plus-buffer box is `40.35,33.45,39.45,31.95`. `--raw=true` prints up to 4,000 characters per frame and is off by default. `--format=jsonl` emits one JSON object per line. Redirect logs only if needed, to `scripts/live-lightning-listener/logs/` (gitignored), then delete after analysis; **do not commit or retain event coordinates indefinitely**. The console streams events; for a long run, filter or redirect locally and retain aggregate summaries only.

## Current protocol and scope

The directly tested endpoint is `wss://live2.lightningmaps.org/`. Node's built-in `WebSocket` connected without browser automation, browser cookies, a supplied Origin, custom headers, or third-party packages. A minimal `{"v":24,"p":[40.35,33.45,39.45,31.95]}` subscription yielded `{"reload":59000}` and closed without strokes in a 30-second probe. The expanded v24-shaped request below **did** produce JSON stroke batches on 4 October 2026, even **without** the site's `from_lightningmaps_org` flag:

```json
{"v":24,"i":{},"s":false,"x":0,"w":0,"tx":0,"tw":1,"a":4,"z":5,"b":true,"h":"","l":1,"t":1,"p":[40.35,33.45,39.45,31.95],"r":"A"}
```

The 30-second no-identification-flag probe received a session hello and 122 stroke records. The server also sent time-only control frames. The opaque subscription fields and hello `k` behavior are **not documented**; this experiment does not attribute meanings to them. Crucially, many live coordinates lay well outside the Ankara box even after initial replay. Therefore `p` is **not verified to be a strict spatial filter** with this request, and `insideRequestedBox` is determined locally. The `i` map is carried across reconnect as a tentative source-scoped last-ID hint; actual resume semantics require measurement.

Sanitized observed batch shape (location rounded and ID replaced; live event was in the eastern Mediterranean, not Ankara):

```json
{"time":1791094944,"flags":{"2":0},"strokes":[{"time":1791094942122,"lat":36.33,"lon":33.90,"src":2,"srv":1,"id":12345678,"del":1761,"dev":1586}]}
```

`strokes[].time` is UTC Unix **milliseconds**, not nanoseconds; `time` at the outer frame is seconds. The location is a coordinate, not proof of ground contact. `src/id` forms an observed source-scoped event key; its global uniqueness/reset rules are unverified. `del`, `dev`, `flags`, `srv`, and any station/status fields have no verified published units or semantics here. `rawDelayMs` preserves `del` as a raw numeric field name only; do not treat it as measured latency. We do not infer polarity, altitude, cloud-to-ground type, quality, or confidence.

## Measurement definitions and caveats

- `decoded` counts schema-valid stroke records before dedupe; `parsed` counts unique accepted records, across the entire received stream; `inside` counts accepted events inside the requested box. These are **not** province-polygon counts.
- Latency is local Node `Date.now()` at message callback minus stroke Unix milliseconds. It includes upstream processing/network and local clock error. Sync the host clock for a serious test; negative latency or very old replay should be reported, not silently corrected.
- p50/p95 are nearest-rank estimates on the most recent up to 100,000 accepted events; min/max span the session. Initial backlog contaminates all-session latency quantiles. For steady-state latency, separately analyze post-backlog windows in a follow-up.
- `lowLag*` is the subset with measured latency from 0 to 30 seconds, to separate the older replay backlog. These are **conditional** percentiles and cannot conceal the older events or stand alone as a feed-wide latency SLA.
- `eventsPerMinute` is accepted events divided by full session duration; `peakEventsPerMinute` uses UTC wall-clock minute buckets, so boundary effects apply. Initial replay contributes to these rates. The longest silent interval is between accepted event receipts (or since the most recent receipt) across the **whole received feed**, not just Ankara; silence does not itself establish a broken connection.
- Dedupe holds 20,000 recent keys. Stable `(src,id)` is preferred, otherwise a heuristic millisecond-time + six-decimal coordinates key. A replay beyond this memory window can be counted twice. `i` is a *hypothesis* about resume; an absence of duplicates does not prove lossless delivery.
- An unexpected close or 90 seconds without **any frame** triggers reconnect with capped exponential backoff and jitter. A forced reconnect uses a normal close. Downtime is reported and must be treated as unknown coverage, not zero lightning.

## Live observations

The deterministic tests are fixtures only; they do **not** claim a successful upstream connection. These are direct observations from 4 October 2026 on a Node process with no cookies or Origin header. Both 72-second comparisons used the Ankara request box and forced a close every 20 seconds; two reconnects completed in each.

| Forced-reconnect run | Decoded / unique / duplicates | Inside Ankara request box | Downtime after each forced close | Interpretation |
| --- | ---: | ---: | --- | --- |
| Default last-ID hint in `i` | 148 / 148 / 0 | 0 | About 6.5 and 6.4 seconds | Reconnected and continued; no replay detected within this short window. |
| `--resume=false` (`i:{}` each time) | 385 / 135 / 250 | 0 | About 8.0 and 6.4 seconds | Large replay occurred; bounded `(src,id)` dedupe recognized 250 duplicates. |

The difference supports a useful `i` resume hint, **not** a guarantee that the feed fills a downtime gap. No rate limit or auth challenge appeared in these short tests. The no-resume run's all-session p50/p95/max event-to-receipt latencies were 225,311 / 371,942 / 417,977 ms, dominated by replay of older detections; they are not steady-state delivery latency. Its 126-event peak UTC minute also includes the initial backlog, not 126 new Ankara events.

A separate **3-minute unforced** run (06:32:30–06:35:30 UTC) received 36 WebSocket messages and decoded 168 unique events, all outside the requested Ankara box. No disconnect, duplicate, or malformed record occurred. Its all-event p50/p95/max receipt latencies were **154,518 / 407,282 / 427,371 ms**, again heavily affected by the initial backlog. Among 56 events arriving within 0–30 seconds of their timestamp, conditional p50/p95/max were **2,144 / 5,705 / 28,511 ms**. The session-wide 56 events/minute and 126-event peak UTC minute include replay; they do not estimate new events/minute for Ankara or the globe.

The **15-minute unforced** run (06:28:50–06:43:50 UTC) used the same expanded subscription **with** the optional site-identification flag, before it was removed from the final listener. It received **149 messages / 323 decoded unique events / zero Ankara-box events / zero duplicates / zero malformed**. There were **no natural disconnects or reconnects**; the only close was clean shutdown at the configured duration. All-event latency min/p50/p95/max: **1,716 / 2,262 / 365,244 / 417,392 ms**. The p95 and max still reflect initial historical replay; a low p50 after 15 minutes does not erase that tail. Mean accepted rate was **21.53/min**, with **137 in the busiest UTC minute** (initial replay, not live Ankara throughput); longest interval between accepted receipts or end-of-run was **38.5 seconds**. This establishes one 15-minute stable session, **not** a 24-hour uptime or missing-event guarantee. The subsequent flagless 30-second probe also decoded 122 records; the final listener omits that flag.

No Ankara-box event occurred in these samples. The 323-event count includes eastern Mediterranean detections outside the request box, and must not be used as an Ankara activity estimate. Some subscribed coordinates were several degrees outside `p`; the cause (server region selection, viewport semantics, or other opaque fields) remains unresolved. The exact sample runs had no natural reconnect, so natural reconnect behavior remains unobserved; only the intentional two-close comparison above tests recovery.

## Decision and unresolved questions

**GO WITH CAVEATS for further research, beginning with latency and replay cursor semantics and then local geographic clustering; not GO for a public live feature.** The plain Node client can connect and decode structured events, and the concurrent MacBook comparison demonstrates that `p` influences the delivered event stream and that client-side strict box filtering is necessary. However, the new comparison produced no 0–30-second low-lag events: observed minimum latency was about 89 seconds, with medians around 90–98 seconds. The earlier 2–6-second low-lag sample remains valid for that run, but low latency is not consistently reproduced. The cause of this discrepancy is unknown. Do not claim lossless coverage, strict server-side filtering, or real-time delivery. Investigate latency/replay behavior before clustering. Public use still requires a separate provider permission decision; the earlier [permission-boundary spike](blitzortung-integration-spike.md) remains relevant.

## Active Extremadura geographic comparison — 4 October 2026

At request time, the public map visibly showed dense activity east/southeast of Portalegre near the Portugal–Spain border. This is a geographic comparison, not a symbol-by-symbol match to the map. The proposed broad active box is **N39.80 E−5.80 S38.30 W−7.60**; the distant control is the existing Ankara box **N40.35 E33.45 S39.45 W31.95**.

The research-only `research:lightning-compare` command opens two concurrent plain Node WebSockets. The v24 subscription objects differ **only in `p`**. Each connection has its own resume IDs, bounded dedupe, metrics, and in-memory `src/id` sets. The output compares all stable IDs and separately the 0–30-second **low-lag subset** by shared, left-only, right-only, and Jaccard overlap (shared / union). It also compares IDs whose coordinates fall inside the active box, including the low-lag subset. An eight-event sample per connection and eight inside-box events at most appear in console output; no raw frames or event dataset are written to disk. An optional tighter local box was not added before observing coordinates.

The comparison must not be interpreted as global completeness. Sessions can start several seconds apart; replay and changing activity can skew overlap. An empty result caused by failed connections cannot establish geographic filtering or lack of activity. The initial workspace attempt and the later successful manual MacBook run are reported separately below.

### Workspace attempt: network path prevented handshake

The concurrent run started **08:32:08.641 UTC** and ended **08:39:25.289 UTC**, an actual duration of **436.648 seconds** (planned 7 minutes; the first runner version finished after its last reconnect wait). Neither WebSocket reached `open`. The Extremadura connection logged **23 failed reconnect attempts** and the Ankara control **24**, all closing with code **1006** before a subscription was sent. Independently, a single Node WebSocket probe failed the same way; `curl` could not connect to this workspace's configured `browser-proxy:8889` (exit 7), and a direct attempt without the proxy could not resolve `live2.lightningmaps.org` (exit 6). The first PoC's successful connection was earlier on the same day; this failure is **not evidence of a provider-side outage, box rejection, or rate limit**.

| Subscription | Successful connections | Messages | Decoded / unique / duplicates / malformed | Inside / outside | Low-lag events | Receipt latency |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| Extremadura active box | 0 | 0 | 0 / 0 / 0 / 0 | 0 / 0 | 0 | Unavailable |
| Ankara control | 0 | 0 | 0 / 0 / 0 / 0 | 0 / 0 | 0 | Unavailable |

**Cross-stream overlap:** shared, Extremadura-only, and Ankara-only observed ID counts were all zero because no events were received; overlap percentage and low-lag overlap percentage are **undefined**, not 0%. No inside-box coordinate/timestamp/latency sample exists. This was a workspace network-path failure before the geographic experiment, not evidence the storm ended or the listener failed at the provider.

### Successful manual MacBook comparison — 4 October 2026

The existing runner was executed from a MacBook with `npm run research:lightning-compare -- --duration=7`. The run was concurrent, lasted **420.1 seconds**, and both subscriptions differed only in `p`.

| Metric | Extremadura active subscription | Ankara control subscription |
| --- | ---: | ---: |
| Requested box (N, E, S, W) | 39.80, −5.80, 38.30, −7.60 | 40.35, 33.45, 39.45, 31.95 |
| Connection / handshake | Connected / 8,083 ms | Connected / 510 ms |
| Messages | 156 | 77 |
| Decoded / unique events | 559 / 559 | 214 / 214 |
| Duplicates / malformed / reconnects | 0 / 0 / 0 | 0 / 0 / 0 |
| Inside requested box | 247 | 0 |
| Outside requested box | 312 | 214 |
| Missing stable IDs | 0 | 0 |
| Latency min / p50 / p95 / max | 88,791 / 97,857 / 425,721 / 456,022 ms | 88,808 / 89,294 / 400,995 / 445,107 ms |
| Low-lag subset (0–30 s) | 0 | 0 |
| Last event timestamp | 2026-10-04T11:02:02.101Z | 2026-10-04T11:01:55.143Z |

Run window: **2026-10-04T10:56:32.400Z to 2026-10-04T11:03:32.500Z**. The run had no reconnects, duplicates, or malformed records. Both endpoints accepted their subscriptions and delivered stable-ID events.

**Cross-stream comparison:** all stable IDs shared **0**, Extremadura-only **559**, Ankara-only **214**, union **773**, Jaccard overlap **0%**. In the active box, Extremadura had **247** stable IDs and Ankara had **0**, so shared **0**, Extremadura-only **247**, Ankara-only **0**. Low-lag overlap is **undefined**, because neither connection received an event with latency in the 0–30-second range; do not report this as 0% overlap.

The Extremadura stream contained 247 events inside its requested broad box and 312 outside it. A small sample of inside-box event coordinates (latitude, longitude) was: `38.719981, -6.700635`; `39.008443, -6.418184`; `38.353499, -6.492440`; `38.428205, -6.912800`; `38.613726, -7.142602`; `39.418639, -7.411804`. They are detected location records in the area that was visibly active east/southeast of Portalegre; this does not establish one-to-one matching with map symbols or classify discharge type. The Ankara subscription received events in other regions, including sample coordinates `35.936366, 31.327713`; `36.711056, 35.274874`; `36.371606, 35.767117`; `36.924153, 35.096476`; `37.375204, 34.609130`; `35.920079, 27.539651`.

#### Interpretation

1. **Does `p` appear to be a strict server-side bounding-box filter? No.** Extremadura received 312 events outside its box, and Ankara received 214 events, all outside its box.
2. **Does changing `p` influence delivery? Yes, in this sample.** The concurrent subscriptions received completely disjoint `(src,id)` sets; only the Extremadura subscription received records inside the Extremadura box. This demonstrates an observable geographic effect, not complete coverage or a stable global contract.
3. **Were active-region events ingested? Yes.** The Extremadura connection decoded 247 records locally inside the requested area. The connection proves ingestion of located records in that box; matching the visible map event-for-event was not tested.
4. **Is client-side geographic filtering viable? Yes.** The coordinates supported deterministic in-box/out-of-box classification, and this run shows why local filtering remains necessary. It does not verify a province boundary or positional completeness.
5. **Was delivery real-time in this run? No evidence supports that claim.** All events had latency above 88 seconds; p50 was about 90–98 seconds and there were no low-lag events. p95/max may include initial replay, but the high minimum and median and the last event timestamps roughly 90 seconds before run end show a substantial delay during this sample too. Its cause is unknown.

The earlier run's low-lag subset with p50 around 2.1 seconds and p95 around 5.7 seconds remains a valid observation for that run. Together, the runs show that few-second latency is **not consistently reproduced**. Do not infer CG/IC type, lossless completeness, or current-event delivery from these results.

### Next research stage

**GO WITH CAVEATS** for further research into **latency / replay cursor semantics first, then local geographic clustering**. Before clustering, run a focused latency experiment that asks whether latency falls as initial replay drains, whether a persistent roughly 90-second offset remains, whether reconnecting with resume IDs changes lag, whether subscription parameters affect replay depth/delay, and whether recent events consistently return to the earlier 2–6-second low-lag range. Do not infer the cause before measuring it. The 0% full-stream overlap is useful for the two subscriptions in this exact concurrent window, not a global completeness result. **Do not recommend public production use:** delivery latency, event completeness, lossless resume, and provider permission remain unresolved.

No production app imports, forecast rules, Xweather live logic, UI, production dependency, or persistence changed. No bulk live-event dataset is committed; the comparison keeps at most 50,000 stable IDs per stream in memory for a run and prints only bounded samples. PR #29 remains a Draft.
