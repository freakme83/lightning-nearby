# Ankara activity district attribution and Replay export v1

PR-3 is a read-only analysis and export layer over records already persisted by Continuous Capture (PR-1) and Activity Watch (PR-2). It does not change reception, decoding, fingerprinting, admission, archiving, period creation/closure, publication, the Fly worker image, feature flags or the database schema. No migration is needed. Nothing here is imported by the worker; the worker Dockerfile does not copy `scripts/activity-export/`.

## Counting unit

Every count is a **Blitzortung detection record**. Records sharing a millisecond, or lying close together, are kept as separate records with their own event key. A record is not presented as an independently verified physical discharge, and no spatial/temporal merging or deduplication threshold is applied.

## District attribution

`districts.ts` attributes a coordinate using the 25 real Ankara district polygons in `data/ankara-districts.geojson` (geoBoundaries gbOpen TUR ADM2, OpenStreetMap-derived, ODbL-1.0; provenance, pinned commit and SHA-256 in `data/NOTICE.md`). It uses planar even-odd point-in-polygon on GeoJSON `[lon, lat]`, supports Polygon and MultiPolygon (Ayaş and Güdül have exclaves) and holes. There is no nearest-centre, bounding-box, buffer or network fallback.

| Result | Meaning |
|---|---|
| `district` | Inside exactly one district polygon, not on any edge |
| `unknown` / `on_district_boundary` | Exactly on an edge or vertex (shared border, hole edge, outer edge); candidates listed |
| `unknown` / `overlapping_districts` | Inside more than one polygon; never resolved by preference |
| `unknown` / `outside_district_dataset` | Inside none of the 25 districts |
| `unknown` / `invalid_coordinate` | Non-finite or out-of-range latitude/longitude |

A 0.01° grid comparison against the same release's Ankara province polygon found no gaps and no overlaps between the 25 districts, and a 0.1° grid found every sampled point of the operational monitoring polygon inside one district. Attribution describes the **reported** coordinate only: Blitzortung location error can exceed the distance to a nearby district border.

## Completed-period selection

The export takes one explicit period ID (lowercase UUID). The period must exist and be `closed` with a `closed_at`; `active`, nonexistent, malformed or internally inconsistent periods are rejected with an explicit code. Activity Watch membership (`ankara_activity_period_events.period_id`) is the authoritative event set. It must contain exactly `detection_count` keys, its latest event time must equal `last_detection_at`, and its earliest must not be later than `started_at`. Out-of-order arrivals can make the first detection earlier than `started_at`, so both are reported. Membership keys are then joined to `continuous_capture_strikes.event_key` in batches of 50; no broad time-window query is used.

A member with no archive row is listed in `meta.archive.missingArchiveEventKeys`, counted, and makes `meta.archive.complete=false`; no coordinates are invented and the export is never marked complete. If no member has an archive row, the export fails (`no_archived_events`) because Replay Studio cannot load an empty dataset. An archive row whose event time differs from its membership row, sub-millisecond digits that would be lost, or duplicate/unexpected rows fail as `archive_inconsistent`.

Timestamps are validated by origin. Detection and receive times (`started_at`, `last_detection_at`, membership and archive `event_time`/`received_at`) are written from millisecond event times, so any non-zero sub-millisecond digit is rejected rather than silently truncated. `closed_at` is a database clock value: the RPC's `p_now` defaults to `clock_timestamp()` and the worker never passes it, so it normally carries microseconds. It is accepted at PostgreSQL's six-digit precision and exported unchanged as `activityPeriod.closedAt` in UTC with six fractional digits. Reads are GET-only, paginated (1,000 membership rows per page), have a 10-second timeout, and stop at 50,000 detections with `export_too_large` rather than truncating.

## Replay JSON contract

The output is Replay Studio's existing `{ "meta": {...}, "events": [...] }` input. Each event has Replay's `id` (the event key), `timestamp` (original event time, ISO UTC, millisecond precision), `lat`, `lon` and `type: "unknown"` (Blitzortung supplies no CG/IC classification here), plus `eventKey`, `receivedAt`, `district`, `districtStatus`, `districtReason`/`districtCandidates` when unknown, `stationCount`, `sourceServer`, `eventTimeRaw` and `eventTimeUnit`. No intensity is written. Events are sorted by event time, then event key; equal timestamps are not spread.

`meta.windowStart` is the first detection and `meta.windowEnd` is **10 seconds after the last detection**, both taken from Activity Watch membership (`activityPeriod.firstDetectionAt` / `lastDetectionAt`), so Replay Studio plays the detections with a 10-second tail rather than the 30-minute closure. The window does not shrink to the surviving archive rows: if the last detection's Continuous Capture row is missing, the final exported event ends more than 10 seconds before `windowEnd` (and likewise at the start), and `meta.archive` reports the missing keys. `meta.activityPeriod` separately keeps `periodStartedAt`, `firstDetectionAt`, `lastDetectionAt`, `closedAt`, the recorded count, `coverageUncertain`, `interruptionCount` and the source health at close. `meta.districtSummary` gives per-district counts, unknown counts by reason, and missing archive records. Also included: `format`/`formatVersion` (`lightning-nearby/ankara-activity-replay`, 1), `source`/`provider: "Blitzortung"`, `synthetic: false`, `utcOffset: "+03:00"` for display, the operational monitoring polygon identity (`polygonId` matches Continuous Capture's `polygon_id`) and its bounds, and the district dataset provenance. Output has no export timestamp and is byte-identical across repeated runs.

## Running an export

Operators who already hold the Supabase service-role credential run it locally or on a trusted server. There is no HTTP endpoint, no browser exposure and no bulk download.

```sh
SUPABASE_URL=https://<project>.supabase.co SUPABASE_SERVICE_ROLE_KEY=<service-role-key> \
  npm run activity:export -- --period-id=<uuid> --out=ankara-period.json
```

The file is never overwritten. One JSON line summarising the period and district counts goes to stdout; errors print a code and reason without upstream bodies or credentials. Load the file in Replay Studio with **Load CSV / JSON**.

## Coverage interpretation

`coverageUncertain` and `interruptionCount` are Activity Watch's own conservative period flags; a bounded reconnect of up to 10 seconds marks a period uncertain without proving that any detection was missed. Missing archive rows are a separate, direct measure of archive loss for that period. Neither indicates the true number of physical discharges.

## Tests

`npm run test:activity-export` covers attribution, boundaries/unknowns, shared milliseconds, ordering, multiple districts, missing and absent archive rows, coverage, rejection of active periods, Replay structure, determinism, the 10-second tail and the bounded read-only store. Setting `REPLAY_STUDIO_CORE_DIR` to a `lightning-replay-studio/src/core` checkout also runs Replay Studio's own parser and time-range logic against the export. Setting `ACTIVITY_WATCH_POSTGRES_TEST_MODULE` (the same PGlite module used by the Activity Watch SQL test) exports periods closed by the real `sync_ankara_activity_watch` RPC, both with a six-digit `p_now` and with the worker's default `clock_timestamp()`.
