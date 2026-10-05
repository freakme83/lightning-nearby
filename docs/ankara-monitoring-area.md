# Ankara-centered operational monitoring area

`ANKARA_MONITORING_AREA` is a reusable research acceptance region for Ankara-centered lightning activity. It is operational coverage, not Ankara's official administrative boundary. The polygon intentionally extends beyond the city/province area, including nearby Kırıkkale-side activity, while keeping a tighter footprint than a wide rectangular acceptance zone.

Coordinates are the supplied GeoJSON positions in `[longitude, latitude]` order. The ring is explicitly closed; it is not simplified or smoothed.

```json
[
  [31.1620047, 40.4361963],
  [32.58044, 40.792556],
  [33.8272463, 40.7734459],
  [33.5597124, 39.880671],
  [33.489043, 39.3752565],
  [33.9332503, 39.0506402],
  [33.7919116, 38.6575458],
  [33.3275159, 38.6614868],
  [33.0801732, 38.9211586],
  [32.2927124, 38.956496],
  [32.0605131, 38.9290136],
  [30.8995164, 39.6867178],
  [30.7733215, 40.2052809],
  [31.1620047, 40.4361963]
]
```

## Feed box and local acceptance

The feed's `p` subscription is rectangular and is not itself a strict event filter. In Ankara mode the runner derives an enclosing subscription box by taking the minimum/maximum polygon coordinates:

| Bound | Value |
|---|---:|
| North | 40.792556 |
| East | 33.9332503 |
| South | 38.6575458 |
| West | 30.7733215 |

The research pipeline first deduplicates and checks membership in that subscription box, then applies the polygon locally. Only fresh unique events inside both geometries reach clustering and incident lifecycle. Points exactly on an edge or vertex count as inside. Membership uses deterministic planar ray casting in longitude/latitude coordinates; no map projection is applied.

## Use

```sh
npm run research:lightning-incidents -- --duration=15 --area=ankara --incident-profile=B
```

Custom regions remain supported with `--box=north,east,south,west`. Supplying `--area=ankara` and `--box` together is rejected as ambiguous. In the manual GitHub Actions workflow, choose **ankara** in the area input; coordinate fields apply only when **custom** is selected.

Run summaries distinguish unique events inside the subscription box, events accepted by the monitoring polygon, events in the box but outside the polygon, and fresh/stale/future counts for each scope. A zero fresh count is not proof of regional inactivity or feed completeness.

This helper and its consumers remain in the research track. A process started during already-dense activity may produce an initial burst of publish candidates; this is a low-frequency operational edge case to revisit before production deployment. This work adds no startup suppression behavior. The polygon is not a district lookup, storm-cell boundary, or production-ready location model.

## Short local execution attempt — 5 October 2026

The runner was invoked with `--duration=0.1 --summary-every=5 --area=ankara --format=jsonl`. It selected the derived Ankara subscription box correctly, then made four WebSocket attempts that closed with code `1006` before handshake; successful connections: 0, messages: 0. This workspace network failure does not indicate absence of lightning. No hosted workflow run was triggered.
