# Xweather recent-lightning history research

Research snapshot: 30 September 2026. This is a debug-only entitlement and cost spike, not a production feature. The existing account is described operationally as the project's free/basic account; its exact commercial tier was not inferred from credentials or quota headers. Account capability is recorded only where a real request succeeds.

## Release boundary

**Prototype only; no public release with real credentials until Xweather confirms the applicable licence and public redistribution rights in writing.** Successful authentication or endpoint access is not permission to redistribute provider data or derived results. The existing public-release cautions in [the live-lightning spike](./xweather-lightning-spike.md) remain unchanged. The debug research route has no access control or server-side rate limit and must not be treated as production-ready.

## Three separate questions

The Xweather material contains an unresolved documentation tension: the Lightning Summary page labels its time range as five minutes while also stating that strike/pulse information is available for the last 24 hours. The endpoint catalog likewise shows a five-minute range. This spike therefore keeps three kinds of evidence separate:

1. **Endpoint documentation** describes possible syntax and stated limits.
2. **Account entitlement** determines whether the configured account may use an endpoint or extended time range.
3. **Live response behavior** determines what a specific request actually returned and cost at the test time.

Documentation alone is not used to claim current-account entitlement, and a successful request is not used to claim guaranteed future pricing or licensing rights.

## Official endpoint findings

| Candidate | Current documented route and window | Returned semantics | Product fit before account testing |
| --- | --- | --- | --- |
| Standard lightning | `GET /lightning/closest`; standard access covers the most recent five minutes. Maximum standard radius is 100 km and maximum result size is 1,000 events. Older data, up to 24 hours per query and archive access from 2016, is documented under the Lightning API Enterprise add-on. | Raw pulse/strike records with coordinates and timestamps, so the app can calculate nearest distance, age, and nested distance-band counts. | Existing five-minute live observation path. The documented standard endpoint multiplier is 10×. Extended raw history is not assumed available. |
| Lightning Summary | `GET /lightning/summary/{action}`, including `/lightning/summary/closest`. `from` and `to` are reflected in the documented response range, but the page simultaneously shows “-5 minutes” and states availability for the last 24 hours. | Aggregate summary, not raw events. It includes range count/from/to/min/max timestamps and pulse totals with IC/CG counts. It does not document event coordinates, nearest distance, or precomputed distance bands. | Potentially useful for “N detections within 50 km during a recent window,” subject to entitlement and observed cost. It cannot by itself support “3 km away 12 minutes ago.” Multiple radii could approximate bands but would require multiple billable requests and are not tested here. No endpoint multiplier or cap is stated on the endpoint page/catalog, so headers from successful live requests are decisive for cost. |
| Lightning Flash | `GET /lightning/flash/{action}`, including `/lightning/flash/closest` and `/lightning/flash/route`. The documented window is the latest five minutes, maximum radius is 40 km, and maximum result size is 1,000 flashes. It is documented as available to all API subscriptions. | Individual consolidated flashes with coordinates and timestamps. A flash consolidates related pulses occurring close together in time and space. | Potentially cleaner event semantics than pulses, but it does not extend the documented history beyond five minutes, has a smaller radius, and cannot directly replace the existing 50 km query. No multiplier is stated on the endpoint page/catalog, so live headers are required. |

No other official Xweather endpoint was found that more directly provides inexpensive, raw 15- or 30-minute recent-lightning history. `/lightning/threats` is a separate nowcast capability and is not implemented or tested in this spike.

## Empty results and billing

Xweather documents `X-Cost-Tokens` as the product of endpoint, temporal, and spatial multipliers. It also states that successful 2xx API responses contain cost headers and count toward usage, while 4xx/5xx responses do not. Therefore a healthy HTTP 200 response with zero lightning still consumes the tokens reported by its headers. This is documented behavior; the spike does not intentionally spend quota manufacturing failures. A healthy zero remains semantically distinct from an unavailable or rejected request.

## Live account test matrix

Live requests are made only through the Netlify Deploy Preview and the debug-only server route. Each button press makes exactly one upstream request. Credentials remain in `XWEATHER_CLIENT_ID` and `XWEATHER_CLIENT_SECRET`; they are never serialized in the browser response.

The live-result table will be completed after the draft PR Deploy Preview is available. A known-recent-activity coordinate near Finike, Türkiye (`36.30, 30.15`, approximate) is used unless activity has moved. Unsupported paths are stopped after the first clear entitlement or parameter error.

| Test | Requested shape | Live result | Observed cost |
| --- | --- | --- | --- |
| Control | `/lightning/closest`, 50 km, provider-standard five minutes | Pending Deploy Preview | Pending |
| Summary default | `/lightning/summary/closest`, 50 km, no explicit time range | Pending Deploy Preview | Pending |
| Summary 15 minutes | Same endpoint, `from=-15minutes`, `to=now` | Pending; attempted only if summary access succeeds | Pending |
| Summary 30 minutes | Same endpoint, `from=-30minutes`, `to=now` | Pending; attempted only if the preceding test succeeds | Pending |
| Flash | `/lightning/flash/closest`, 40 km, documented five minutes | Pending Deploy Preview | Pending |

The documented Flash endpoint is not tested with 15- or 30-minute parameters because its official page limits it to five minutes; the task explicitly avoids brute-forcing undocumented combinations. A 60-minute Summary request is omitted unless the shorter configured windows succeed and the observed cost makes one additional request justified.

## Pure arithmetic cadence comparison

A 30-day month contains 8,640 five-minute intervals or 4,320 ten-minute intervals. “Manual” below is explicitly modeled as five refreshes per day, or 150 requests/month. Multiply these request counts by each mode's observed `X-Cost-Tokens` value after live validation.

| Cadence assumption | Requests per 30-day month | Tokens per month at observed cost `C` |
| --- | ---: | ---: |
| Manual: 5 refreshes/day | 150 | `150 × C` |
| Poll every 5 minutes | 8,640 | `8,640 × C` |
| Poll every 10 minutes | 4,320 | `4,320 × C` |

These are arithmetic comparisons, not an implementation proposal. This spike adds no polling, caching, persistence, or background work. The advertised allowance, token cost, and quota-header semantics can change and are not guaranteed to behave identically forever.

## Debug-only implementation

- `/api/lightning/debug-research` validates coordinates and one of four explicit modes: Summary default, Summary 15 minutes, Summary 30 minutes, or Flash documented five minutes.
- The route performs one no-store upstream request and returns only normalized aggregate/time-bound diagnostics. It does not return credentials, raw upstream payloads, IDs, or flash coordinates.
- `/debug/lightning` adds a clearly marked manual research section. The existing `/api/lightning/live`, provider interface, product UI, forecast logic, and live severity logic are unchanged.
- Summary parsing preserves healthy zero versus error. Flash parsing reports only count and oldest/newest timestamps. Tests use fixtures and never call Xweather.

## Decision framework

After live validation, each path is classified as:

- **A — Useful and usable now:** succeeds on the configured account, has suitable semantics, and has a reasonable observed cost.
- **B — Technically useful but unavailable:** could answer the product question but requires a different entitlement, add-on, or permission.
- **C — Not useful for this product question:** cannot extend the time window, lacks the required granularity, or has an unsuitable cost/shape.

The key distinction is that Summary can establish count and time bounds within a query radius but not a particular event's distance. Unless extended raw `/lightning` access succeeds, the exact statement “Lightning was detected 3 km away 12 minutes ago” cannot be derived from Summary alone.

## Sources

- [Xweather Lightning endpoint](https://www.xweather.com/docs/weather-api/endpoints/lightning) — standard and Enterprise limits, raw fields, and 10× endpoint multiplier.
- [Xweather Lightning Summary endpoint](https://www.xweather.com/docs/weather-api/endpoints/lightning-summary) — route, documented time-range tension, aggregate range, pulse and IC/CG fields.
- [Xweather Lightning Flash endpoint](https://www.xweather.com/docs/weather-api/endpoints/lightning-flash) — route, five-minute/40 km/1,000-flash limits, subscription availability, and consolidated-flash semantics.
- [Xweather endpoint catalog](https://www.xweather.com/docs/weather-api/endpoints) — endpoint availability, displayed ranges, and published multipliers where present.
- [Xweather cost headers](https://www.xweather.com/docs/weather-api/getting-started/cost-headers) — multiplier arithmetic and 2xx versus 4xx/5xx billing behavior.
- [Xweather rate limiting](https://www.xweather.com/docs/weather-api/getting-started/rate-limiting) — minute and billing-period diagnostics.
- [Existing Xweather live-lightning spike](./xweather-lightning-spike.md) — licensing, attribution, privacy, abuse-protection, and public-release gates that continue to apply.
