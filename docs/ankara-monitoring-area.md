# Ankara-centered operational monitoring area

`ANKARA_MONITORING_AREA` is a reusable research acceptance region for Ankara-centered lightning activity. It is operational coverage, not Ankara's official administrative boundary, and it does not claim exact district or provincial boundary accuracy. The southern edge was tightened after live Kulu-area publications, including Zincirlikuyu / Kulu and Altılar / Kulu, showed that the previous coarse polygon was too broad. Ankara's southern districts remain within the intended operational coverage.

Coordinates are GeoJSON positions in `[longitude, latitude]` order. The ring is explicitly closed. A single local vertex near the southeastern edge was added to put the approximate Altılar / Kulu CG point `[32.965, 39.178]` outside the polygon; the rest of the supplied ring is unchanged.

```json
[
  [32.1754558, 38.9451017],
  [32.0198391, 38.9531338],
  [31.7947497, 39.1602879],
  [31.9559242, 39.2378138],
  [31.9781551, 39.4548602],
  [31.786414, 39.6626755],
  [31.508527, 40.008359],
  [31.1667252, 40.0253849],
  [30.9055115, 40.0168726],
  [30.7776843, 40.140197],
  [31.0853068, 40.3777283],
  [31.2962999, 40.364259],
  [31.4084872, 40.3950747],
  [31.4890741, 40.3209611],
  [31.8558849, 40.3357904],
  [32.144056, 40.5589686],
  [32.3509888, 40.6121124],
  [32.5760772, 40.7974935],
  [32.7400306, 40.7427755],
  [32.8623008, 40.6479649],
  [33.0401485, 40.5192285],
  [33.2013229, 40.4325616],
  [33.3124777, 40.449481],
  [33.4819887, 40.3965937],
  [33.786368, 40.3095417],
  [33.530712, 40.0186073],
  [33.2806137, 39.7054589],
  [33.6001837, 39.2937638],
  [33.9197537, 39.0457918],
  [33.850282, 38.9702148],
  [33.7696948, 38.9550897],
  [33.8391665, 38.8837422],
  [33.764137, 38.7690038],
  [33.722454, 38.6497402],
  [33.380653, 38.6757783],
  [33.2583829, 39.0573729],
  [33.1500068, 39.12639],
  [33.124997, 39.221178],
  [32.965, 39.179],
  [32.8924042, 39.1495134],
  [32.5200356, 38.9747407],
  [32.1754558, 38.9451017]
]
```

## Feed box and local acceptance

The feed's `p` subscription is rectangular and is not itself a strict event filter. In Ankara mode the runner derives an enclosing subscription box by taking the minimum/maximum polygon coordinates:

| Bound | Value |
|---|---:|
| North | 40.7974935 |
| East | 33.9197537 |
| South | 38.6497402 |
| West | 30.7776843 |

The research pipeline first deduplicates and checks membership in that subscription box, then applies the polygon locally. The rectangular feed subscription may still include events outside the polygon; local polygon acceptance remains authoritative. Only fresh unique events inside both geometries reach clustering and incident lifecycle. Points exactly on an edge or vertex count as inside. Membership uses deterministic planar ray casting in longitude/latitude coordinates; no map projection is applied.

## Use

```sh
npm run research:lightning-incidents -- --duration=15 --area=ankara --incident-profile=B
```

Custom regions remain supported with `--box=north,east,south,west`. Supplying `--area=ankara` and `--box` together is rejected as ambiguous. In the manual GitHub Actions workflow, choose **ankara** in the area input; coordinate fields apply only when **custom** is selected.

Run summaries distinguish unique events inside the subscription box, events accepted by the monitoring polygon, events in the box but outside the polygon, and fresh/stale/future counts for each scope. A zero fresh count is not proof of regional inactivity or feed completeness.

This helper and its consumers remain in the research track. A process started during already-dense activity may produce an initial burst of publish candidates; this is a low-frequency operational edge case to revisit before production deployment. This work adds no startup suppression behavior. The polygon is not a district lookup, storm-cell boundary, or production-ready location model.

## Short local execution attempt — 5 October 2026

The runner was invoked with `--duration=0.1 --summary-every=5 --area=ankara --format=jsonl`. It selected the derived Ankara subscription box correctly, then made four WebSocket attempts that closed with code `1006` before handshake; successful connections: 0, messages: 0. This workspace network failure does not indicate absence of lightning. No hosted workflow run was triggered.
