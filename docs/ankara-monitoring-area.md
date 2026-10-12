# Ankara-centered operational monitoring area

`ANKARA_MONITORING_AREA` is a reusable research acceptance region for Ankara-centered lightning activity. It is operational coverage, not Ankara's official administrative boundary, and it does not claim exact district or provincial boundary accuracy. The southern edge was tightened after live Kulu-area publications, including Zincirlikuyu / Kulu and Altılar / Kulu, showed that the previous coarse polygon was too broad. Ankara's southern districts remain within the intended operational coverage.

Coordinates are GeoJSON positions in `[longitude, latitude]` order. The ring is explicitly closed. The ring follows the supplied operational coverage coordinates exactly. It remains operational coverage rather than an official administrative boundary.

```json
[
  [31.8746841, 39.1475613]
  [32.0936364, 38.9727422]
  [32.2143723, 39.0459652]
  [32.3934779, 39.0114303]
  [32.5713648, 39.0416598]
  [32.7325748, 39.1452058]
  [32.8409747, 39.1624487]
  [32.8152725, 39.2103262]
  [32.7881144, 39.2586303]
  [32.8102815, 39.2766678]
  [32.9246948, 39.2650068]
  [32.9871649, 39.2636996]
  [33.049635, 39.2192402]
  [33.1492495, 39.2767705]
  [33.2049661, 39.2650068]
  [33.1475611, 39.2205482]
  [33.1745753, 39.1642809]
  [33.2589943, 39.0922454]
  [33.3045806, 39.1184486]
  [33.4160745, 39.0585633]
  [33.387372, 38.9286519]
  [33.3637346, 38.8747804]
  [33.3789301, 38.7985021]
  [33.4430886, 38.7300452]
  [33.5308844, 38.6905209]
  [33.6389408, 38.6984275]
  [33.7537507, 38.7892906]
  [33.7841416, 38.8708369]
  [33.7050082, 38.9760682]
  [33.7809854, 39.0062507]
  [33.8265718, 38.9996904]
  [33.8704696, 39.025928]
  [33.7742319, 39.053467]
  [33.6965663, 39.1072028]
  [33.5156542, 39.2161386]
  [33.3316184, 39.4712148]
  [33.2527459, 39.6020868]
  [33.1738849, 39.6601819]
  [33.2312467, 39.7815141]
  [33.2549973, 39.8850507]
  [33.4356637, 40.0299268]
  [33.56352, 40.1660003]
  [33.6405367, 40.315821]
  [33.5265414, 40.3370666]
  [33.4570543, 40.3773091]
  [33.3847878, 40.4005965]
  [33.3403525, 40.3539581]
  [33.2716183, 40.3110082]
  [33.1920383, 40.3681371]
  [33.1659979, 40.4359416]
  [33.0548186, 40.4570938]
  [32.9742136, 40.5183975]
  [32.8769317, 40.5078319]
  [32.8880496, 40.6197427]
  [32.8046651, 40.6281812]
  [32.6332646, 40.7462082]
  [32.5489527, 40.7230408]
  [32.5017015, 40.6345093]
  [32.4442597, 40.535299]
  [32.2357985, 40.5374114]
  [32.1746498, 40.4232471]
  [32.0467945, 40.380914]
  [31.9022614, 40.3088879]
  [31.7660667, 40.3067683]
  [31.6270926, 40.2643628]
  [31.4595909, 40.2604003]
  [31.2928219, 40.3282403]
  [31.0962113, 40.3427921]
  [31.0788017, 40.2328208]
  [30.8564432, 40.1266411]
  [30.9509456, 40.0458335]
  [31.1260531, 40.0841228]
  [31.4345757, 40.0756159]
  [31.7569957, 40.022424]
  [31.7470095, 39.9795966]
  [31.7733003, 39.9264638]
  [31.8880239, 39.8971316]
  [31.9143143, 39.8124751]
  [31.8211018, 39.7906968]
  [31.7948105, 39.7408368]
  [31.828272, 39.7006493]
  [31.8999738, 39.6930366]
  [31.9767374, 39.6104363]
  [31.9525562, 39.5791752]
  [32.0123081, 39.4501056]
  [32.007528, 39.3670057]
  [32.04652, 39.2782518]
  [31.967011, 39.2189599]
  [31.9287289, 39.1961419]
  [31.8639438, 39.1710336]
  [31.8746841, 39.1475613]
]
```

## Feed box and local acceptance

The feed's `p` subscription is rectangular and is not itself a strict event filter. In Ankara mode the runner derives an enclosing subscription box by taking the minimum/maximum polygon coordinates:

| Bound | Value |
|---|---:|
| North | 40.7462082 |
| East | 33.8704696 |
| South | 38.6905209 |
| West | 30.8564432 |

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
