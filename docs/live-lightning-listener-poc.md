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

## Decision snapshot after the first geographic comparison

At that stage, the recommendation was **GO WITH CAVEATS for further research, beginning with latency and replay cursor semantics and then local geographic clustering; not GO for a public live feature.** The plain Node client can connect and decode structured events, and the concurrent MacBook comparison demonstrated that `p` influenced the delivered event stream and that client-side strict box filtering was necessary. That comparison produced no 0–30-second low-lag events: observed minimum latency was about 89 seconds, with medians around 90–98 seconds. The earlier 2–6-second low-lag sample remains valid for that run, but low latency was not consistently reproduced. The cause was unknown. Later latency/replay findings and the current research-stage decision are recorded below. Do not claim lossless coverage, strict server-side filtering, or real-time delivery. Public use still requires a separate provider permission decision; the earlier [permission-boundary spike](blitzortung-integration-spike.md) remains relevant.

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

### Decision at the geographic comparison stage

At the time of the geographic comparison, the recommendation was **GO WITH CAVEATS** to investigate latency / replay semantics before clustering. The subsequent experiments and updated decision are recorded below. The 0% full-stream overlap is useful only for the two subscriptions in that concurrent window, not as a global completeness result. **Public production use was not recommended:** latency, event completeness, lossless resume, and provider permission remained unresolved.

No production app imports, forecast rules, Xweather live logic, UI, production dependency, or persistence changed. No bulk live-event dataset is committed; the comparison keeps at most 50,000 stable IDs per stream in memory for a run and prints only bounded samples.

## Latency and replay-cursor follow-up — 4 October 2026

### Known prior evidence

The earlier 3-minute run contained a conditional 0–30-second low-lag subset with p50/p95 receipt latency of **2.14 / 5.71 seconds** (56 events). Its all-event distribution included historical replay and was much older. In the manual MacBook geographic comparison, p50 was **97.857 seconds** for Extremadura and **89.294 seconds** for Ankara, with no events at or below 30 seconds. These observations differ materially; the cause has not been established.

### Instrumentation and experiment design

The research-only `research:lightning-latency` runner uses the same Node WebSocket, subscription object, JSON decoder, local box check, stable `src/id` keys, and resume-ID behavior as the existing PoC. It accepts an arbitrary `--box=north,east,south,west`; the example commands below use the Extremadura box because that was the previously observed active region, but select a box around activity visible at the time of a future run.

For each unique accepted event it retains event and receipt timestamps, calculated latency, `src/id` when present, connection age, and local in-box status. The in-memory ring is capped at **100,000 observations**; bucket counts and quantiles describe retained observations if a run exceeds that capacity. It prints connection-age buckets (`0–30`, `30–60`, `60–120`, `120–180`, `180–300`, and `>300` seconds), each with count, min/p50/p95/max latency and counts at or below 10/30/60/90/120 seconds. Session summary latency percentiles use the same retained unique-event sample; duplicates are counted separately and do not enter those distributions.

Every 30 seconds by default, it reports current wall-clock time, newest event timestamp seen, `freshestEventLagMs = now - newestEventTimeSeen`, current connection age, and total unique events. If no event has arrived, newest timestamp and lag are `null`; zero activity is not reported as zero lag. The controlled reconnect option closes the first connection once, waits a fixed downtime, then reconnects. By default, the reconnect subscription carries the source IDs seen before disconnect; `--resume=false` provides an optional short empty-`i` control. The summary separates unique-event latency before reconnect, 0–30 seconds after reconnect, 30–60 seconds after reconnect, and later. The reconnect comparison does not prove lossless recovery; the intentional downtime is an unknown coverage interval.

### Manual MacBook commands

Use a currently active map region for the `--box` values. The Extremadura example is not assumed to remain active.

**A. Fifteen-minute single-stream latency run:**

```sh
npm run research:lightning-latency -- --duration=15 --summary-every=30 --box=39.8,-5.8,38.3,-7.6
```

**B. Reconnect/resume run:** collect five minutes before one intentional reconnect, wait ten seconds, then keep measuring for at least three minutes after reconnect so the early and 30–60-second phases have time to fill:

```sh
npm run research:lightning-latency -- --duration=8 --summary-every=15 --box=39.8,-5.8,38.3,-7.6 --reconnect-after=300 --reconnect-downtime=10 --resume=true
```

Completed manual short no-resume control, intended to compare lag/replay depth after one reconnect:

```sh
npm run research:lightning-latency -- --duration=4 --summary-every=15 --box=39.8,-5.8,38.3,-7.6 --reconnect-after=120 --reconnect-downtime=10 --resume=false
```

No event-level output is written to disk by the runner. Save only aggregate summaries needed for the research report and delete local console captures that contain precise coordinates after analysis.

### Workspace attempt and results

A 30-second runner check was attempted from the coding workspace on the Extremadura box (2026-10-04T11:22:43Z–11:23:13Z). The client had **zero successful WebSocket opens, zero messages, and zero parsed/unique events**; connection attempts closed with code `1006`, and the 20-second open-timeout fired. No subscription could be sent. Consequently, first-event latency, age-bucket summaries, freshest-event lag, reconnect/resume behavior, and no-resume behavior are **unavailable** in this attempt. The empty latency summaries are a consequence of the failed network path and must not be read as evidence about feed lag or current storm activity. No new active-region run was completed in this workspace.

| Metric | Workspace attempt |
| --- | ---: |
| Attempt duration | 30 seconds |
| Successful connections / messages | 0 / 0 |
| Decoded / unique / duplicate / malformed events | 0 / 0 / 0 / 0 |
| First-event latency / latency percentiles | Unavailable |
| Freshest-event lag samples | Unavailable (`null`, because no event arrived) |
| Age buckets / reconnect phase samples | Empty; no connection opened |
| Planned reconnects completed | 0 |

This is consistent with the earlier workspace network-path failure documented above, and does not contradict the successful prior MacBook comparisons.

### Successful manual MacBook latency run — 4 October 2026

The runner was executed with `npm run research:lightning-latency -- --duration=15 --summary-every=30 --box=42.33,4.24,40.83,2.44`. The box covered an active region around **41.58, 3.34** in northeastern Spain. It opened one connection and had no reconnects.

Run window: **2026-10-04T11:35:42.614Z to 2026-10-04T11:50:42.706Z** (900.093 seconds). The WebSocket connected at **2026-10-04T11:35:44.419Z**.

| Metric | Observed |
| --- | ---: |
| Successful connections / reconnects | 1 / 0 |
| Messages | 1,220 |
| Decoded / unique events | 4,374 / 4,374 |
| Duplicates / malformed | 0 / 0 |
| Inside / outside requested box | 4,227 / 147 |
| First-event latency | 413,217 ms |
| Min / p50 / p95 / max latency | 88,755 / 89,197 / 363,296 / 413,217 ms |
| Final freshest-event lag | 89,537 ms |
| Events at or below 10 / 30 / 60 seconds | 0 / 0 / 0 |
| Events at or below 90 / 120 seconds | 3,545 / 3,652 |

The first event's 413-second latency and the first connection-age bucket's high p50/p95/max show the startup replay/backlog effect. Latency did not keep falling toward the earlier few-second subset after startup. Instead, all later connection-age buckets remained in a narrow band around 89 seconds:

| Connection age | Events | Min (ms) | p50 (ms) | p95 (ms) | Max (ms) |
| --- | ---: | ---: | ---: | ---: | ---: |
| 0–30 s | 949 | 88,853 | 304,977 | 401,830 | 413,217 |
| 30–60 s | 103 | 88,821 | 89,178 | 89,446 | 89,501 |
| 60–120 s | 217 | 88,832 | 89,144 | 89,353 | 89,511 |
| 120–180 s | 238 | 88,840 | 89,175 | 89,411 | 89,900 |
| 180–300 s | 473 | 88,813 | 89,156 | 89,371 | 89,669 |
| >300 s | 2,394 | 88,755 | 89,136 | 89,383 | 89,720 |

The post-startup p50 values are about **89.1–89.2 seconds**, and p95 values about **89.35–89.45 seconds**. The reported freshest-event lag stayed around **89–90 seconds**; its final value was 89,537 ms. No event in the session had latency at or below 60 seconds. This is direct evidence of a persistent delayed feed during this run after startup replay. It does not identify the cause, establish an intentional server delay, or show that other sessions or regions behave the same way.

### Manual `resume=false` reconnect control — 4 October 2026

The documented no-resume command was run in the same active-region box, with `--duration=4 --reconnect-after=120 --reconnect-downtime=10 --resume=false`. The run started at **2026-10-04T16:18:42.998Z**, first connected at **16:18:43.352Z**, reconnected at **16:20:53.749Z** after approximately **10.299 seconds** of downtime, and ended at **16:22:43.093Z**. Total duration was **240.095 seconds**; there were two successful connections and one reconnect. The second subscription sent an empty resume map: `resumeIdsSent: {}`.

| Metric | Observed |
| --- | ---: |
| Messages | 146 |
| Decoded events | 1,772 |
| Unique / duplicate events | 1,012 / 760 |
| Malformed | 0 |
| Inside / outside requested box | 188 / 824 |
| First-event latency | 753,995 ms |
| All-session min / p50 / p95 / max latency | 88,865 / 302,193 / 714,138 / 753,995 ms |
| Final freshest-event lag | 93,019 ms |
| Events at or below 10 / 30 / 60 seconds | 0 / 0 / 0 |
| Events at or below 90 / 120 seconds | 246 / 287 |

All-session percentiles include startup and reconnect replay, so the high p50/p95/max should not be read as post-reconnect steady-state latency. Before reconnect, the 30–60-second connection-age bucket returned to approximately 89.1-second p50 and 89.4-second p95 (22 events in an earlier periodic report, 45 by the run's end); the 60–120-second bucket was in the same approximate band.

After reconnect without resume IDs, unique-event latency was:

| Reconnect phase | Events | Min (ms) | p50 (ms) | p95 (ms) | Max (ms) |
| --- | ---: | ---: | ---: | ---: | ---: |
| 0–30 s | 30 | 88,973 | 89,332 | 99,653 | 99,657 |
| 30–60 s | 23 | 88,946 | 89,186 | 89,401 | 89,404 |
| 60 s+ | 60 | 88,920 | 89,153 | 89,412 | 89,483 |

The first post-reconnect phase briefly reached about 100 seconds at p95/max; the following phases returned to the same narrow approximately 89-second band. Compared with the earlier `resume=true` reconnect test, which had no duplicates and a similar ~89-second steady-state lag, this control did **not** reduce latency. It did produce substantial replay/duplicate traffic: 760 of 1,772 decoded events were duplicates. This supports the limited conclusion that resume IDs help suppress replay in these observed tests but do not make delivery more recent. Empty-cursor reconnect can repeat already-seen records, so deduplication remains useful. These runs do not prove lossless continuity or completeness through downtime, and they do not establish the server's buffering or cursor implementation.

### Interpretation and next step

**Run-specific latency classification: B. Persistent delayed feed.** The first 0–30-second connection-age bucket shows the startup replay/backlog, but subsequent buckets stay around an 89-second latency floor. The 15-minute northeastern Spain run did not approach the earlier few-second low-lag range and had no events at or below 60 seconds. This run's steady band is clear; its cause is unknown. Do not infer that the server deliberately imposes an exact 89-second delay or that every session and region will behave this way.

**Broader cross-run latency classification: C. Mixed / variable.** The earlier run's conditional low-lag p50/p95 of about **2.14 / 5.71 seconds** remains valid for that run, while the recent longer active-region runs show a persistent ~89-second steady-state lag. The empty-cursor reconnect returned to approximately the same lag as the baseline and the earlier resume-enabled reconnect test. This strengthens the conclusion that the observed ~89-second offset does not appear to be caused by resume cursor use, without establishing its root cause or generalizing to all sessions and regions. The short workspace attempt contributes no latency evidence.

The latency/replay investigation is sufficient to proceed to the next research stage: **local spatiotemporal clustering of observed lightning activity**. That stage should turn raw point events into user-meaningful summaries of recent observed activity while keeping forecast logic and production behavior unchanged. It is research-only; this update does not implement clustering.

**GO WITH CAVEATS for clustering research.** Raw ingestion has been demonstrated; geographic filtering has been demonstrated, with strict client-side filtering still required; and resume IDs were useful for replay suppression in the observed reconnect tests. Recent longer active-region runs show approximately 89 seconds of steady-state lag after startup replay. Real-time or safety-grade claims are not supported. Public production use remains blocked by the provider permission/redistribution constraints. Do not claim lossless recovery, coverage completeness, strict server-side geographic filtering, or CG/IC classification. The cause of the delay remains unknown.
