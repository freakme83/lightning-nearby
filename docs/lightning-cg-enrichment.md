# Research: Xweather CG / IC enrichment

This adapter queries Xweather for an explicitly qualified publish-candidate incident. The live LightningMaps-compatible feed currently classifies discharge type as unknown, so that feed alone cannot support a ground-strike claim.

The Fly research worker calls it only after the independent incident lifecycle has qualified an initial publication candidate. It never queries once per raw feed observation. For initial publication, it selects a current nearby CG under the [initial CG association policy](initial-cg-association.md) before naming, composition, and ledger persistence. Repeat CG probes retain their separate matching and admission rules.

## Reference and query

The incident lifecycle supplies `representativeLatitude`, `representativeLongitude`, and `lastActivityTimeMs`. This adapter uses that representative point with `lastActivityTimeMs`, because the centroid represents the accumulated incident and its latest event time represents the active incident at the decision point. Promotion time is a processing/receipt time and is not substituted for event time.

One explicit request uses `GET /lightning/closest` with `p`, `radius`, `limit`, and `filter=all`. It requests at most 10 records within 10 km by default. Standard access to this endpoint exposes a recent, approximately five-minute feed; this adapter does not add `from`/`to` parameters. Every returned record is still checked locally against `ob.timestampMS` (or `ob.timestamp` converted from seconds). A manual incident time outside the provider's returned recent window will normally produce `no_match`.

Credentials are read only from `XWEATHER_CLIENT_ID` and `XWEATHER_CLIENT_SECRET`. The endpoint’s query authentication parameters are added through `URLSearchParams`; the URL and provider error body are never logged or returned. Do not commit credentials. Successful access does not establish a right to publish or redistribute Xweather data; confirm current licence and billing terms before any public integration.

## Observed event shape and cost

Real manual Xweather responses included `id`, `loc.lat`, `loc.long`, `ob.timestampMS`, `ob.pulse.type` (`cg` or `ic`), `peakamp`, `numSensors`, and `relativeTo.distanceKM`. The adapter independently computes distance from the supplied incident coordinate rather than relying on `relativeTo`.

A real small `/lightning/closest` query with a 10 km radius and limit 3 returned both IC and CG events and reported `X-Cost-Tokens: 10` and `X-Cost-Multipliers: endpoint=10; spatial=1; temporal=1`. This is an observed cost for that query, not a billing guarantee. The result retains cost and rate-limit headers as diagnostics only; matching logic never depends on billing headers. Amplitude and sensor count are copied when present and have no severity, danger, damage, or certainty interpretation here.

## Matching defaults and result meanings

The general matcher and manual CLI retain a maximum query radius of 10 km, maximum match distance of 8 km, maximum absolute reference-time difference of 5 minutes, and limit 10. Its raw matching diagnostics remain available. Initial Fly publication uses the same 10 km request but separately admits CG events at up to 10 km, at most 150 seconds from the reference, and at most 4 minutes old at selection and publication processing. A returned or generally matched CG does not authorize initial CG wording until this complete policy passes. These are operational research thresholds, not meteorological truth.

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
