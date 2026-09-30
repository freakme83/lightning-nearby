# Xweather Raw versus Flash validation

Validation snapshot: 30 September 2026. This spike asks whether the lower-cost Xweather Flash endpoint preserves the current user-facing lightning information that matters enough to justify continued manual evaluation. It does not migrate production behavior.

## Release boundary

**Debug validation only.** The licensing, public redistribution, access-control, server-side rate-limit, reliability, and quota gates recorded in [the Xweather live-lightning spike](./xweather-lightning-spike.md) remain. Successful account access does not grant public production rights. The comparison route is not a public-production design.

## Endpoint semantics and comparison shape

| Side | Request used by this spike | Official endpoint semantics | Observed cost before this validation |
| --- | --- | --- | ---: |
| Raw | `GET /lightning/closest?p={lat},{lon}&radius=40km&limit=1000&filter=all` | Individual lightning pulses/strikes. Standard access covers the latest five minutes, permits up to 100 km, returns up to 1,000 records, and has a documented 10× multiplier. | 10 tokens |
| Flash | `GET /lightning/flash/closest?p={lat},{lon}&radius=40km&limit=1000` | Consolidated flashes. Multiple CG strikes within 10 km or cloud-to-cloud pulses within 20 km and split seconds may be combined. The endpoint reference documents a five-minute window, maximum 40 km radius, and up to 1,000 flashes. | 1 token |

The same coordinate, 40 km radius, result limit, and approximately the same request time are used on both sides. This avoids contaminating the primary comparison with the production Raw route's existing 50 km radius. Pulse count and flash count are different units and are never converted into an accuracy ratio.

Xweather's product overview currently describes broader Flash history, while the detailed endpoint reference and endpoint catalog state the five-minute/40 km limits. This spike follows the detailed endpoint contract and the live account's default recent response; it does not test undocumented longer Flash windows.

## What the debug comparison records

One explicit **Compare Raw vs Flash** click sends exactly one Raw request and one Flash request concurrently. Each side reports:

- success/failure and upstream HTTP status;
- activity present/absent;
- returned event-unit count;
- nearest distance, compass direction, and nearest age;
- newest and oldest ages;
- counts within 5, 10, 25, and 40 km;
- cost/multiplier and quota headers;
- rejected records and possible 1,000-result truncation.

The comparison reports presence match, direction match, and absolute nearest-distance, nearest-age, and newest-age differences without inventing a pass/fail threshold. The page includes a copyable normalized JSON block for manually collected cases. Credentials and raw upstream payloads/IDs remain server-side.

## Initial Deploy Preview cases

The PR #15 Deploy Preview was tested once at the known active candidate and once at the quiet control on 30 September 2026. Each comparison made exactly one Raw request and one Flash request; no additional locations were searched.

| Location | Raw present | Flash present | Raw nearest | Flash nearest | Raw age | Flash age | Direction match | Raw count | Flash count | Raw cost | Flash cost | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | ---: | ---: | ---: | ---: | --- |
| Active candidate — southern France, `43.58, 3.88` | Yes | Yes | 21.9 km SE | 33.1 km SE | 4.12 min | 4.12 min | Yes | 5 | 4 | 10 | 1 | Presence, direction, and nearest age agreed. Flash nearest was 11.19 km farther away. Raw newest age was 2.53 min; Flash newest age was 1.92 min. |
| Negative control — Ankara, `39.91, 32.84` | No | No | — | — | — | — | N/A | 0 | 0 | 10 | 1 | Both returned HTTP 200 healthy-zero results, with zero records in every distance band. |

Both active responses were HTTP 200 and below the provider result limit. Raw reported one pulse within 25 km and five within 40 km; Flash reported no flash within 25 km and four within 40 km. The count difference is expected because pulses/strikes and consolidated flashes are different event units. The 11.19 km nearest-distance difference is material enough to track in later cases, but Flash did not miss the active system in this first comparison and preserved its broad direction and recency.

Both control responses were also HTTP 200, successful, and below the provider result limit. Raw and Flash each returned zero within 5, 10, 25, and 40 km, preserving the distinction between healthy absence and provider failure.

Observed request diagnostics in both cases were:

- Raw: `X-Cost-Tokens: 10`, `X-Cost-Multiplier(s): endpoint=10; spatial=1; temporal=1`.
- Flash: `X-Cost-Tokens: 1`, `X-Cost-Multiplier(s): endpoint=1; spatial=1; temporal=1`.
- The responses showed `Remaining this minute: 99` for Raw and `98` for Flash, and `Remaining this period: 14753` for both. These quota headers are observations only; this spike does not infer instantaneous billing semantics or future pricing from them.

## Manual collection table

Future cases can be appended one at a time from copied debug JSON. Do not interpret differing event counts as detection accuracy without investigating presence, location, and recency.

| Location | Raw present | Flash present | Raw nearest | Flash nearest | Raw age | Flash age | Direction match | Raw count | Flash count | Raw cost | Flash cost | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | ---: | ---: | ---: | ---: | --- |
|  |  |  |  |  |  |  |  |  |  |  |  |  |

Questions for each case:

1. Did both endpoints agree that activity existed?
2. If active, how different were nearest distance, direction, and ages?
3. Did either endpoint return zero while the other showed meaningful activity?
4. Were Raw and Flash costs consistently 10 and 1 tokens respectively?
5. Were either result sets at their 1,000-record limit?

## Forty-kilometre trade-off

Flash cannot represent the current 40–50 km outer Raw band. A future production design would therefore need either:

- a 40 km precise-current radius; or
- a cheap Summary 30-minute / 50 km outer awareness layer, with Flash providing precise current activity inside 40 km.

No production radius or severity threshold changes in this spike.

## Candidate future architecture — not implemented

1. Summary 30 minutes / 50 km for a cheap broad recent-activity scan.
2. Optional narrower Summary requests only if later evidence justifies their extra cost.
3. Flash five minutes / 40 km for a cheap precise current-event layer.
4. Raw `/lightning/closest` retained as debug/reference or fallback if Flash validation exposes meaningful misses.

## Current evidence classification

**Promising — continue manual validation.** The one active comparison preserved activity presence, SE direction, and a 4.12-minute nearest age while costing one token rather than ten. The healthy-zero control also matched. However, Flash's nearest location was 11.19 km farther away and its count represented four consolidated flashes rather than five Raw pulses/strikes. One active case and one control do not establish equivalence or justify a production migration; more manually selected active systems are needed, with particular attention to nearest-distance shifts and any one-sided presence results.

## Sources

- [Xweather Lightning endpoint](https://www.xweather.com/docs/weather-api/endpoints/lightning) — Raw semantics, five-minute standard window, 100 km/1,000-record limits, and 10× multiplier.
- [Xweather Lightning Flash endpoint](https://www.xweather.com/docs/weather-api/endpoints/lightning-flash) — consolidation semantics and documented five-minute/40 km/1,000-flash limits.
- [Xweather endpoint catalog](https://www.xweather.com/docs/weather-api/endpoints) — current endpoint/action/range listing.
- [Xweather lightning product overview](https://www.xweather.com/products/weather-api/lightning) — broader marketing description; recorded separately because it conflicts with the detailed Flash endpoint limits.
- [Xweather recent-lightning history research](./xweather-lightning-history-research.md) — live Summary/Flash entitlement and observed cost findings from PR #14.
