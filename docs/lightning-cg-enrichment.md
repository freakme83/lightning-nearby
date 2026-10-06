# Research: Xweather CG / IC enrichment

This isolated adapter tests one question for an explicitly selected publish-candidate incident: did a nearby Xweather cloud-to-ground (CG) or intracloud (IC) event occur close to the incident in both space and time? The live LightningMaps-compatible feed currently classifies discharge type as unknown, so that feed alone cannot support a ground-strike claim.

This is a research-only query and result model. It is not connected to the listener, incident lifecycle, composer, persistence, or any publisher. Call it only at a future publish-candidate boundary; never call once per raw feed observation.

## Reference and query

The incident lifecycle supplies `representativeLatitude`, `representativeLongitude`, and `lastActivityTimeMs`. This adapter uses that representative point with `lastActivityTimeMs`, because the centroid represents the accumulated incident and its latest event time represents the active incident at the decision point. Promotion time is a processing/receipt time and is not substituted for event time.

One explicit request uses `GET /lightning/closest` with `p`, `radius`, `limit`, and `filter=all`. It requests at most 10 records within 10 km by default. Standard access to this endpoint exposes a recent, approximately five-minute feed; this adapter does not add `from`/`to` parameters. Every returned record is still checked locally against `ob.timestampMS` (or `ob.timestamp` converted from seconds). A manual incident time outside the provider's returned recent window will normally produce `no_match`.

Credentials are read only from `XWEATHER_CLIENT_ID` and `XWEATHER_CLIENT_SECRET`. The endpoint’s query authentication parameters are added through `URLSearchParams`; the URL and provider error body are never logged or returned. Do not commit credentials. Successful access does not establish a right to publish or redistribute Xweather data; confirm current licence and billing terms before any public integration.

## Observed event shape and cost

Real manual Xweather responses included `id`, `loc.lat`, `loc.long`, `ob.timestampMS`, `ob.pulse.type` (`cg` or `ic`), `peakamp`, `numSensors`, and `relativeTo.distanceKM`. The adapter independently computes distance from the supplied incident coordinate rather than relying on `relativeTo`.

A real small `/lightning/closest` query with a 10 km radius and limit 3 returned both IC and CG events and reported `X-Cost-Tokens: 10` and `X-Cost-Multipliers: endpoint=10; spatial=1; temporal=1`. This is an observed cost for that query, not a billing guarantee. The result retains cost and rate-limit headers as diagnostics only; matching logic never depends on billing headers. Amplitude and sensor count are copied when present and have no severity, danger, damage, or certainty interpretation here.

## Matching defaults and result meanings

Initial research defaults are maximum query radius 10 km, maximum incident match distance 8 km, maximum absolute event-time difference 5 minutes, and limit 10. The existing feed clusterer uses an 8 km event-to-event grouping threshold, so 8 km is a tighter initial match bound than the query radius. Incidents can associate clusters as far as 10 km, so the choice may exclude some otherwise related events; evaluate it with paired samples before changing it. These are configurable operational research thresholds, not meteorological truth. The API radius only determines which records can be returned; local spatial and temporal checks determine whether a record matches.

Candidates are ranked by smallest absolute time difference, then smallest great-circle distance, then stable event ID. For `cg_verified`, the best-ranked matching CG event is retained even if IC candidates also match.

- `cg_verified`: a nearby Xweather CG event matched the research incident within configured spatial and temporal thresholds. It does not prove the exact same physical flash or meter-accurate impact location, and says nothing about damage or danger.
- `ic_only`: at least one IC event matched and no CG event matched within these configured bounds. This does not mean no CG occurred elsewhere or outside the window.
- `no_match`: the API request succeeded but returned no event matching both bounds. This does not mean no lightning occurred.
- `provider_unavailable`: credentials, network, HTTP, or parsing failure. It must never be interpreted as IC-only, no CG, or no lightning.

## Manual CLI

Supply an explicit reference event time as Unix milliseconds or an ISO date-time; the CLI never silently substitutes the current time:

```sh
XWEATHER_CLIENT_ID=... XWEATHER_CLIENT_SECRET=... \
  npm run --silent research:cg-enrichment -- --lat=39.095 --lon=12.272 --time=1791289205693
```

Optional flags are `--radius-km`, `--max-distance-km`, `--max-age-minutes`, and `--limit`. The query is one request per CLI invocation, with no scheduler or polling. A provider failure is emitted as structured JSON with a nonzero CLI exit code; credentials and raw provider error details are omitted.
