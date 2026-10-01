# Blitzortung integration spike and permission boundary

Research snapshot: 29 September 2026. This is a design review, not permission to consume or redistribute Blitzortung data. No upstream connection or production live feature is included in this branch.

## Decision

**No go for public Blitzortung integration today.** Blitzortung explicitly limits use of its raw lightning data to project participants and people it has expressly allowed. It also prohibits use for storm warning systems, including data obtained through third parties. A free hobby app and an informational disclaimer do not by themselves grant access or settle whether proximity notifications would be treated as warnings. Request project-specific written clarification before implementing an upstream adapter or releasing derived proximity information. [B1]

After authorization, the smallest robust shape is a single authorized collector on an always-on host, a bounded recent-strike buffer, and a small API returning a location-specific summary. Keep the existing Netlify frontend. Start with periodic client requests (for example every 15–30 seconds while the page is visible), not a second streaming protocol. A persistent relay is needed for a streaming upstream; Netlify alone is not a suitable home for that collector. An authorized, bounded HTTP polling source could change this hosting decision, but its allowed cadence and use must be confirmed first. [B2] [N1] [N2]

## Project architecture inspected

- At `merge-ready` commit `c82437c`, the app is Next.js 16.3.6, React 19.3, TypeScript, and a small client-rendered PWA. There is no `app/api`, `pages/api`, `netlify/functions`, `netlify.toml`, backend, database, account system, or server-side location store in the inspected tree. `next.config.ts` only suppresses the powered-by header. The repository and handover describe Netlify deployment, but the deployment settings themselves are not in this repository; verify the actual site configuration before provisioning.
- `src/app/page.tsx` reads one confirmed monitored point from `localStorage` after mount. The point is rounded to four decimals (`src/lib/location.ts`). Geolocation needs a user tap; place search or a map point can also set the location. Forecast and ensemble calls are issued directly from the browser on location load or replacement, with an abort controller; there is no background refresh poll. The debug page is also browser-side.
- `src/lib/weather.ts` and `src/lib/ensemble.ts` request Open-Meteo directly. Forecast and observational status should remain separate data paths and labels. Do not infer an observation from forecast model support.
- `public/sw.js` caches the same-origin app shell and fingerprinted Next static assets, and uses the shell only as an offline navigation fallback. It does not cache cross-origin weather responses or arbitrary same-origin API responses. A future live response should explicitly use `Cache-Control: no-store`, contain an observation timestamp and server status, and be shown as unavailable/stale if its source has stopped. Never render an offline shell as evidence of current lightning.
- Runtime dependencies are Next/React/Leaflet; tests use Node's built-in test runner. No current dependency provides a lightning connection. No production code or tests were added in this spike.

## What the sources establish

| Finding | Evidence class | Consequence |
| --- | --- | --- |
| The project describes its data as private/entertainment use, says it is not an official lightning authority, prohibits storm warning systems, and reserves raw lightning data for participants or explicitly permitted users. | Official Blitzortung notice [B1]; the associated archive repeats this [B3]. | Explicit project permission and an answer about proximity states/notifications are release gates. The CC BY-SA allowance on that page applies to *marked images*, not raw data. |
| Commercial use is prohibited even for network contributors. | Project documentation [B4]. | Free/non-commercial status is necessary but does not grant raw-data access. |
| A project-associated archive documents a credential-protected recent-strikes HTTP endpoint and a dedicated-credential MQTT broker with geographically partitioned topics. | Published technical documentation [B2]. | These are candidates to ask Blitzortung to authorize; documentation of an endpoint is not a general license, and access credentials are required. Confirm which interface they currently recommend, subscription scope, rate, retention, and redistribution terms. |
| Blitzortung documents embedding its own vector map. | Project documentation [B5]. | An iframe may be an alternative for merely viewing their map, but does not give strike records for local counts/states and is not the intended product. |
| A Home Assistant integration uses its own MQTT relay for its clients and describes direct client connections as contrary to its understanding of data policy. | Third-party implementation [T1], **not policy authority**. | Supports the one-collector design, without proving permission for this app or its relay. Do not assume its public broker licenses general reuse. |
| Community implementations describe an unauthenticated LightningMaps/Blitzortung WebSocket and reconnect/dedupe mechanisms. Recent forum posts ask for express permission for similar public websites, without showing approval in the inspected posts. | Third-party technical report [T2]; unanswered user requests [F1] [F2]. | Technical reachability is not authorization. The WebSocket address/protocol, continuity, and permission were not verified against an official interface contract; no handshake was attempted. |

No exact attribution wording, client count limit, retention allowance, redistribution of derived counts/distances, API service level, or permission for this particular project was verified. Plan a visible `Lightning data: Blitzortung.org` link if approved, then use the wording and link the project requires. Do not apply the image license to strike data.

## Access and architecture options

| Option | Permission and technical viability | Operations, privacy, failure, hosting |
| --- | --- | --- |
| A. Each browser connects upstream | No raw-data permission; many connections, exposed protocol/credentials if required, and uncontrolled load. Reject. | No local server cost, but scales upstream load with visitors, leaks browser IP/location context and fails when the upstream changes. Browser PWA cannot reliably collect while closed. |
| B. Netlify request-based proxy | A proxy does not confer permission. It could make **authorized**, bounded HTTP requests if Blitzortung explicitly permits this pattern and cadence. It cannot maintain a shared recent history by relying on a process-local buffer. | Simple deployment but upstream requests can scale with visitors; require shared cache/storage to prevent this, plus credential secrecy and rate limiting. A Netlify function can serve a short response, not act as a durable upstream listener. [N1] |
| C. Persistent Node collector plus in-memory buffer and API | Appropriate **only after authorization** for the chosen feed, processing, and public summary. One upstream connection and compact derived output. | Needs an always-on process, reconnect/health checks, resource caps, and a host that supports it. Holding the collector inside a Next process only works on a persistent Node deployment, not the present Netlify serverless assumption. API request includes a monitored coordinate unless on-device calculation is chosen. |
| D. Small standalone relay with existing Netlify frontend | Recommended implementation of C after approval; isolate feed credentials and lifecycle from frontend deploys. | Extra low-cost always-on host, domain/CORS setup, monitoring and rate limiting. UI can poll an HTTPS summary; no SSE/WebSocket to clients initially. Collector restart creates a warm-up gap. |
| E. Official embedded map | Documented map embedding is technically plausible without raw-data processing, subject to applicable site conditions. [B5] | Few moving parts but cannot implement local counts or state, sends users to Blitzortung infrastructure, and makes Lightning Nearby a map viewer. Not the proposed live layer. |

Netlify documents request-scoped functions, a 15-minute background-function cap (no streamed response), 30-second scheduled-function execution, and a 60-second streaming response cap. Edge functions have per-request execution/response constraints. None is a durable process for a single continuous upstream MQTT/WebSocket subscription and shared in-memory ring buffer. Serverless HTTP polling with an external shared cache is a separate design, not a free persistent process. [N1] [N2] [N3] [N4]

For a small audience, host D can be a single process with HTTPS and no database. Cost depends on an always-on host plan and network usage; check current prices and geographic coverage when permission is granted. Keep credentials only on the relay. Limit and validate coordinate queries, cap request rate and concurrent work, restrict CORS to the site, and avoid logging exact coordinates. A request with the rounded saved point means the relay briefly receives that point even if it stores nothing; update the app privacy text before release. Returning a bounded area of raw strikes for browser-only calculations would avoid sending the point to the relay but increases redistribution and bandwidth, so requires specific permission too.

## Adapter and data contract for a later mock milestone

Use a provider seam that consumes normalized events, with a synthetic fixture provider initially. Do not create a real `BlitzortungProvider` or bake an undocumented WebSocket payload shape into the app. A future authorized adapter can translate an approved HTTP/MQTT/feed contract and fail closed on malformed data.

```ts
type Strike = {
  id: string;          // source-scoped upstream identity, or a documented dedupe key
  observedAtMs: number; // UTC Unix milliseconds, retaining upstream precision internally
  latitude: number;
  longitude: number;
};

type SourceStatus = {
  state: "warming" | "live" | "stale" | "unavailable";
  lastReceivedAtMs: number | null;
  coverageStartMs: number | null;
};
```

Validate finite coordinates and timestamps; reject impossible/far-future and excessively old records. Distinguish stroke observation time from relay arrival time. Some published HTTP records have nanosecond timestamps [B2]; convert safely to milliseconds without putting the nanosecond integer in a JavaScript `Number`. If the approved source lacks a stable ID, use a source-scoped hash of its documented stable fields (at least full timestamp and original coordinates), never just rounded seconds and location. A calculated ID can collide; test with source samples under the authorized contract. Keep source name/version in the adapter and response attribution, not in every in-memory event unless needed. Do not retain detector/station metadata or raw payloads.

## Bounded memory and recovery

- Start with a 60-minute time window so 5/10/30-minute summaries and a 30–45-minute ending transition can be evaluated. A 30-minute window would lose the full context for a 45-minute quiet period. Time-window length and permission for ephemeral retention need explicit approval.
- Keep an append-oriented ring/deque of accepted events and a matching ID set for dedupe. Prune by observation timestamp relative to server time on ingestion and queries. Handle late/out-of-order events with a bounded allowed lateness or time buckets; a simple head-only prune is insufficient if events arrive out of order. Expire matching dedupe entries with pruned events. Cap entries and input rate defensively and surface degraded coverage rather than silently dropping events.
- A compact normalized record might use tens of bytes for numeric fields, but a JavaScript object, string ID, array and set commonly cost much more. Budget roughly 10–30 MB per 100,000 retained events as a planning estimate, not a measured strike rate; benchmark with synthetic high-volume traffic and tune region subscription and cap. For 10,000 events, expect order-of-megabytes. Do not subscribe globally if an approved geographically bounded feed meets the service area.
- Reconnect with bounded exponential backoff and jitter. Deduplicate replays and check source health/lag; do not claim seamless completeness across a gap. After restart, the buffer is empty: use a permitted bounded backfill if explicitly available, otherwise mark the window `warming` until it fills. A genuine zero count requires source health and full relevant time-window coverage; gaps, stale upstream, and cold starts return unknown/unavailable, never “no lightning.” No database is needed for the initial volatile summary.

## Location calculations and future activity

For an approved monitored coordinate, calculate great-circle distance with Haversine on WGS84 using Earth radius about 6,371 km; account for longitude wrap and input validation. Filter by observation time first and a coarse bounding box if volume warrants, then compute exact distance. A single pass over the retained regional buffer can yield the nearest recent strike, latest strike time, and nested counts for radii **5 / 10 / 25 / 50 km** and windows **5 / 10 / 30 minutes**. Define whether the nearest distance is within 5, 10, or 30 minutes in the API contract. Counts represent detected strokes, not independent storms. Geospatial indexing/database is unnecessary at the initial scale; measure query cost under high storm volume before optimizing.

Candidate state machine for synthetic testing (thresholds illustrative, not product policy):

| Current evidence with healthy, complete coverage | Candidate state | Transition guard |
| --- | --- | --- |
| No strike in the relevant nearby window | `inactive` | Only after a complete observation window; absence of data is `unavailable`. |
| At least one within ~25 km | `nearby` | Debounce isolated detections or require persistence if tests show flicker. |
| One or more within ~10 km | `close` | Prefer prompt entry; exit only after a longer quiet window to prevent chatter. |
| Previously active, now quiet for a provisional interval | `ending` | Return to active on renewed strikes; after ~30–45 minutes of healthy quiet move to `inactive`. |

Keep source health orthogonal to activity state; on outage preserve last-known state only as explicitly timestamped historical information, not a current `inactive`. Confirm that these labels, especially `close` and any later push messages, fit Blitzortung's prohibition on storm warning systems **before** publishing them. Avoid guarantees of safety or complete detection.

Approach/retreat is deferred. Later, compare spatially robust summaries over multiple rolling windows: weighted centroid or robust median of strike clusters, distance to the monitored point, density changes in concentric zones, and an estimated movement vector. Require enough strikes distributed across several time bins, reject scattered/multiple cells and weak trends, use hysteresis and confidence thresholds, and emit `movement unclear` when evidence fails. A single nearest strike is too noisy. Wording could be “Activity appears to be approaching/moving away” only if permitted and empirically validated; a movement label is not a storm-track or safety forecast.

## Permission request and go/no-go gates

Present Blitzortung with the actual free hobby site, the forecast/live separation, proposed on-demand proximity summaries (radii/windows and nearest distance), planned states, possible later notifications, expected audience/load, proposed single collector, authorized interface, regional filtering, 60-minute volatile retention, derived-data API, clear credit, and non-official wording. Ask for a written answer to each:

1. May this public app ingest raw strikes, and which current credentialed endpoint/protocol is approved? Are service credentials available to this project?
2. May it temporarily retain 60 minutes in memory, perform distance/count computations, and redistribute **derived** summaries to anonymous users? What limits apply to raw coordinates or caching?
3. Are `nearby`/`close` activity labels and user-initiated viewing permissible? Does the explicit storm-warning prohibition rule out push notifications or proximity alerts even with disclaimers? Do not launch alerts unless expressly resolved.
4. What geographical scope, query/subscription rate, reconnect/backfill behavior, maximum viewers, credit text/link, and branding constraints are required? Is a one-collector relay acceptable?

**Go** only with express project-specific permission for the actual use, a documented and authenticated access path, accepted retention and redistribution conditions, and compatible product language. Then test the authorized source privately for latency, volume, outage and duplicate behavior, and deploy a small relay with observability. **No go** for public Blitzortung data/derived live summaries if approval is absent, denied, ambiguous, or the planned proximity messaging conflicts with its warning restriction. A third-party relay or technically open feed does not bypass this gate.

**Next implementation milestone:** while permission is sought, implement small pure TypeScript logic against synthetic fixtures only: distance, radius/window summary, bounded out-of-order retention and dedupe, source-health handling, and tentative activity transitions. Unit-test boundary times, high volume, duplicate/reconnect, stale feed and warming behavior. Keep it off the normal UI and do not add a network adapter. This documentation-only spike avoids premature protocol commitments.

## Sources and confidence

- [B1] [Blitzortung.org contact/notice](https://www.blitzortung.org/en/contact.php?PrivacyPolicy=1) — **official usage restriction**; accessed 2026-09-29.
- [B2] [Blitzortung data archive: Live Data](https://www.limaps.org/live-data.html) — **project-associated technical documentation** for protected HTTP and credentialed MQTT; accessed 2026-09-29. It is not a grant to this app.
- [B3] [Archive terms](https://www.limaps.org/terms-of-conditions.html) — repeats raw-data and warning limits; accessed 2026-09-29.
- [B4] [Blitzortung/LightningMaps documentation introduction](https://docs.lightningmaps.org/) — non-commercial and private/entertainment framing; accessed 2026-09-29.
- [B5] [Project documentation: map embedding](https://docs.lightningmaps.org/web/blitzortung_org/) — map iframe examples only; accessed 2026-09-29.
- [F1] [August 2026 permission request for GdzieGrzmi.pl](https://forum.blitzortung.org/mybb/printthread.php?tid=4284) and [F2] [GermanLightning request](https://forum.blitzortung.org/mybb/showthread.php?tid=4293) — applicant questions, **not project approvals**.
- [T1] [Home Assistant Blitzortung integration](https://github.com/mrk-its/homeassistant-blitzortung/blob/master/info.md), [T2] [community streaming feeder](https://github.com/clemensv/real-time-sources/blob/main/feeders/blitzortung/README.md) — third-party implementation practice, **not permission authority**.
- [N1] [Netlify background functions](https://docs.netlify.com/build/functions/background-functions/), [N2] [Netlify function streaming](https://docs.netlify.com/build/functions/api/), [N3] [Netlify scheduled functions](https://docs.netlify.com/build/functions/scheduled-functions/), [N4] [Netlify edge limits](https://docs.netlify.com/build/edge-functions/limits/) — hosting runtime boundaries; accessed 2026-09-29.
