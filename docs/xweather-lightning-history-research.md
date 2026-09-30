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

## Live account results

Live requests are made only through the Netlify Deploy Preview and the debug-only server route. Each button press makes exactly one upstream request. Credentials remain in `XWEATHER_CLIENT_ID` and `XWEATHER_CLIENT_SECRET`; they are never serialized in the browser response.

The requests below ran through draft PR #14's Netlify Deploy Preview using the existing server-side credentials. The first approximate point near Finike, Türkiye (`36.30, 30.15`) returned a healthy zero and served as the empty-result control. A previously active southern France point (`43.58, 3.88`) still had detections and supplied the positive time-window comparisons. These are small functional examples, not provider-coverage benchmarks.

| Test | Requested shape | Live result | Observed headers |
| --- | --- | --- | --- |
| Standard healthy zero | `/lightning/closest`, 50 km, provider-standard five minutes; Finike point | HTTP 200, zero raw events, with no latest or nearest event. | `X-Cost-Tokens: 10`; `endpoint=10; spatial=1; temporal=1` |
| Standard positive control | Same request; southern France point | HTTP 200, 2 raw events within 50 km. Latest event was about 17 seconds before fetch; nearest event was about 37.4 km away and 4.71 minutes old. | `10`; `endpoint=10; spatial=1; temporal=1` |
| Summary default healthy zero | `/lightning/summary/closest`, 50 km, no explicit time range; Finike point | HTTP 200, zero aggregate pulses. A no-data response did not include inferable range timestamps. | `1`; `endpoint=1; spatial=1; temporal=1` |
| Summary 15 minutes | Same endpoint, `from=-15minutes`, `to=now`; southern France point | HTTP 200, 3 aggregate pulses, all CG. Reported range was exactly 15 minutes; oldest pulse was about 11 minutes 17 seconds before fetch and newest about 4 minutes 10 seconds before fetch. | `1`; `endpoint=1; spatial=1; temporal=1` |
| Summary 30 minutes | Same endpoint, `from=-30minutes`, `to=now`; southern France point | HTTP 200, 8 aggregate pulses, all CG. Reported range was exactly 30 minutes; oldest pulse was about 29 minutes 9 seconds before fetch and newest about 3 minutes 55 seconds before fetch. | `1`; `endpoint=1; spatial=1; temporal=1` |
| Flash | `/lightning/flash/closest`, 40 km, documented five minutes; southern France point | HTTP 200, 3 consolidated flashes. Oldest was about 4 minutes 25 seconds before fetch and newest about 1 minute 37 seconds before fetch. | `1`; `endpoint=1; spatial=1; temporal=1` |

The Summary 15- and 30-minute parameters were accepted by the configured account and positive responses proved that data older than five minutes was included. The maximum window verified in this spike is therefore **30 minutes**. A 60-minute or 24-hour request was not made, so the Summary page's longer statement remains unverified for this account. The documented Flash endpoint was not tested with 15- or 30-minute parameters because its official page limits it to five minutes; the spike avoids brute-forcing undocumented combinations.

One initial positive Summary request exposed the documented action-dependent response variation: `/closest` returned the summary inside a one-item array rather than the top-level object shown by the example. The debug parser was corrected and fixture-tested before the successful positive retries. This was an implementation parsing issue, not an entitlement failure. No endpoint tested live returned an account/add-on rejection. Extended raw `/lightning` history was not attempted because the official page explicitly assigns it to the Enterprise add-on.

All successful live shapes returned `Remaining this period: 14830` during this short test, even as requests were made, and `Remaining this minute` varied from 97 to 99. As in the earlier spike, these are diagnostics only and are not treated as instantaneous balance semantics.

## Pure arithmetic cadence comparison

A 30-day month contains 8,640 five-minute intervals or 4,320 ten-minute intervals. “Manual” below is explicitly modeled as five refreshes per day, or 150 requests/month.

| Successful query shape | Observed tokens/request | Manual: 150 requests | 5-minute polling: 8,640 requests | 10-minute polling: 4,320 requests |
| --- | ---: | ---: | ---: | ---: |
| Standard `/lightning/closest` | 10 | 1,500 | 86,400 | 43,200 |
| Summary default / 15 min / 30 min | 1 | 150 | 8,640 | 4,320 |
| Flash documented 5 min | 1 | 150 | 8,640 | 4,320 |

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

| Path | Classification | Conclusion |
| --- | --- | --- |
| Standard `/lightning/closest` for current activity | **A — useful and usable now** | Raw events support current nearest distance and age, but only for the latest five minutes and at the observed 10-token cost. |
| Summary 15/30 minutes for regional history | **A — useful and usable now** | The configured account returned positive aggregate windows at 1 token. Suitable for copy such as “3 detections within 50 km in the last 15 minutes” or “8 detections within 50 km in the last 30 minutes.” |
| Extended raw `/lightning` history | **B — technically useful but unavailable under documented standard access** | It would support exact historical distance/age, but Xweather documents older-than-five-minute raw access as an Enterprise add-on. No wasteful entitlement request was made. |
| Flash for history beyond five minutes | **C — not useful for this product question** | Account access and 1-token requests work, and consolidated flashes may be a useful semantic alternative for current activity, but the documented window remains five minutes and radius is capped at 40 km. |
| Summary for exact nearest-distance history | **C — wrong granularity** | It supplies aggregate counts, IC/CG breakdown, and time bounds, but no raw coordinates, nearest distance, or distance bands. |

The key product result is therefore: the current account can cheaply provide **15- and 30-minute aggregate regional history**, but it cannot support the exact statement “Lightning was detected 3 km away 12 minutes ago.” That statement requires older raw coordinates, which remain behind the documented Enterprise boundary. Keep the production live path unchanged; if the product later needs a compact “recent activity ending” cue, add a separate provider capability that consumes one Summary window on explicit refresh, rather than distorting the raw-event provider interface. Do not add polling until licensing, abuse protection, quota policy, and product semantics are resolved.

## Sources

- [Xweather Lightning endpoint](https://www.xweather.com/docs/weather-api/endpoints/lightning) — standard and Enterprise limits, raw fields, and 10× endpoint multiplier.
- [Xweather Lightning Summary endpoint](https://www.xweather.com/docs/weather-api/endpoints/lightning-summary) — route, documented time-range tension, aggregate range, pulse and IC/CG fields.
- [Xweather Lightning Flash endpoint](https://www.xweather.com/docs/weather-api/endpoints/lightning-flash) — route, five-minute/40 km/1,000-flash limits, subscription availability, and consolidated-flash semantics.
- [Xweather endpoint catalog](https://www.xweather.com/docs/weather-api/endpoints) — endpoint availability, displayed ranges, and published multipliers where present.
- [Xweather cost headers](https://www.xweather.com/docs/weather-api/getting-started/cost-headers) — multiplier arithmetic and 2xx versus 4xx/5xx billing behavior.
- [Xweather rate limiting](https://www.xweather.com/docs/weather-api/getting-started/rate-limiting) — minute and billing-period diagnostics.
- [Existing Xweather live-lightning spike](./xweather-lightning-spike.md) — licensing, attribution, privacy, abuse-protection, and public-release gates that continue to apply.
