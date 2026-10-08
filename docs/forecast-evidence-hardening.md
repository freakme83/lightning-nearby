# Forecast evidence hardening

This research adds observability to the classifier on `merge-ready` at `c82e629`.
It does not make the forecast more aggressive.

## Current classifier

The existing decision order is unchanged:

1. WMO thunderstorm codes **95 / 96 / 97 / 99 → High**, even with low direct probability.
2. Valid provider `thunderstorm_probability` takes precedence over the fallback:
   **<20 → Low**, **20–49 → Elevated**, **≥50 → High**.
3. Without direct probability, **CAPE ≥700 J/kg AND precipitation probability ≥40% → Elevated**.
4. Otherwise **Low** when deterministic evidence is sufficient: a usable weather code,
   direct probability, or a valid CAPE/precipitation pair. An isolated CAPE or precipitation
   value does not establish a qualitative result. CIN is informational only.

Ensemble support uses only weather codes from ICON-EU EPS or ICON global EPS at
center + N/S/E/W, approximately one model grid spacing, at target hour ±1 hour.
Each member enters the denominator once and supports the hour once if any code
95/96/97/99 occurs within that window. This is secondary evidence, not probability.

## Why collect this evidence?

- A non-thunderstorm weather code alone currently produces Low, but offers weaker
  negative evidence than direct probability or complete fallback ingredients.
- Low direct probability can coexist with strong CAPE/precipitation ingredients.
- Exact-point deterministic output may disagree with ensemble support covering
  nearby locations and adjacent hours. Disagreement can reflect displacement,
  timing tolerance, or differing model signals; it does not establish which is correct.
- Five requested ensemble locations may represent fewer unique returned locations.

## Internal evidence model

`forecast-evidence.ts` contains pure, observational helpers. Normalized outlook hours
carry `diagnostics`; late ensemble merges recompute them without feeding them back
into the classifier. The debug page and snapshot use the same helper.

| Source | Quality | Meaning |
| --- | --- | --- |
| `direct-thunderstorm-code` | `direct` | Thunderstorm WMO code has precedence |
| `direct-provider-probability` | `direct` | Valid direct probability, including zero |
| `cape-precip-fallback` | `ingredients` | Valid CAPE and precipitation pair, including below-threshold Low |
| `weather-code-only` | `weak` | Valid non-thunderstorm code with no usable CAPE/precipitation ingredients |
| `partial-deterministic` | `partial` | One usable CAPE/precipitation ingredient, optionally with a weather code |
| `insufficient` | `insufficient` | No usable classifying inputs; CIN alone belongs here |

Quality describes source coverage, **not calibrated confidence**. A partial hour with
a weather code can remain Low; a partial hour without a code or probability remains
qualitative unavailable. A normalized risk without raw inputs is retained by the
existing outlook logic but its evidence is correctly described as insufficient.

Conflict flags (multiple can occur together):

- `low-direct-probability-vs-strong-fallback`
- `thunderstorm-code-vs-low-direct-probability`
- `low-deterministic-vs-positive-ensemble`
- `high-elevated-deterministic-vs-zero-ensemble`

The summary also includes `ensembleSupportPresent`, `ensembleSupportAbsent`, and
`exactPointVsEnsembleAgreement`. Missing or unusable member counts yield null support
booleans, never zero-support evidence. Broad agreement describes only Low/zero or
Elevated-or-High/positive support; it is not a validation of forecast accuracy.

## Returned ensemble sample coordinates

The [Open-Meteo Ensemble API documentation](https://open-meteo.com/en/docs/ensemble-api)
documents multi-location response arrays and `cell_selection=nearest`. A manual
five-point ICON-EU EPS Ankara probe on **2 October 2026** returned top-level numeric
latitude/longitude for every sample (existing weather-code field only):

| Sample | Requested latitude, longitude (4 decimals) | Returned latitude, longitude |
| --- | --- | --- |
| Center | 39.9300, 32.8600 | 39.875, 32.875 |
| North | 40.0468, 32.8600 | 40, 32.875 |
| South | 39.8132, 32.8600 | 39.875, 32.875 |
| East | 39.9300, 33.0123 | 39.875, 33 |
| West | 39.9300, 32.7077 | 39.875, 32.75 |

**Requested 5 / returned 5 / usable 5 / unique effective coordinate pairs 4.**
This is evidence of duplicate returned locations, not proof of native ICON cell
identity. The API did not expose native grid-cell IDs in this response; location_id
identifies a response location, not a native grid cell. Returned coordinates are
retained as provider-effective coordinates, without asserting a native grid index.

`sampleDiagnostics` preserves the usable response coordinates and response indexes,
requested count for the successful batch, total returned count, usable count, and
coordinate coverage. `uniqueEffectiveLocations` counts exact returned coordinate
pairs **only when all usable responses have valid coordinates**. Missing, nonnumeric,
nonfinite, or out-of-range coordinates leave full uniqueness unavailable. No count
is inferred from requested coordinates or silently rounded. `gridCellIdentity`
remains `unconfirmed`. Unusable weather responses do not enter effective counts.

Existing `sampledLocations`, member aggregation, spatial/temporal windows, and
fallback requests retain their behavior. Counts describe response-wide coverage,
not a per-hour guarantee that every location has data. Duplicate coordinates are
diagnosed but not used to discard weather series. A successful regional center-only
retry reports requested=1, sampled=1, and spatialWindowKm=0; it does not claim five
successful locations. Failed attempts are not included in the successful batch counts.

## Debug surface and snapshot

Only `/debug/forecast` adds technical presentation: source/quality alongside raw
deterministic values and the existing result, conflict flags (or “None detected”),
cross-source status, sample counts, metadata completeness, and expandable returned
coordinates. Ensemble absence for the selected hour is distinct from the overall
fetch status. The copied JSON includes all these diagnostics alongside the selected
timestamp, coordinates, raw evidence, member counts, model and decision explanations.
The explicit snapshot schema contains no provider credentials or request URLs.

## What this PR does not change

- No classifier threshold or availability changes, including weather-code-only Low.
- No ensemble promotion or reduction of Low/Elevated/High.
- No deterministic neighborhood sampling.
- No invented probability or member-fraction probability.
- No new providers, weather variables, radar, satellite, polling, persistence, or database.
- No normal-UI CAPE/CIN/evidence-quality display, Xweather live changes, or Summary → Flash changes.

## Validation

Focused fixture tests cover source/quality, invalid inputs, conflict boundaries,
multiple flags, both ensemble disagreements, missing data, duplicate/malformed
returned coordinates, partial batches, center-only requests, snapshot contents,
and unchanged combined/late-ensemble qualitative results. Automated tests do not
call live Open-Meteo. Run the existing test, lint, TypeScript, build, and diff checks.

Preview QA should inspect a normal Low, fallback Elevated, direct probability hour,
Low with positive ensemble if available, and unavailable ensemble; verify that only
debug output gains technical detail. Document live cases unavailable during QA
separately from fixture coverage.

## Next research phase

**Deterministic neighborhood diagnostics**, debug-only first: center plus bounded
nearby samples using the existing provider and variables. Compare exact-point
deterministic, neighborhood inputs, direct probability, and ensemble support at
aligned timestamps. Record requested and returned coordinates, sample coverage,
displacement, cost, and timing before proposing classifier-v2 rules. Keep primary
classification unchanged until that evidence supports a separate decision.


## Manually curated validation cases

The initial, non-representative case corpus is documented in [Forecast validation corpus](forecast-validation-corpus.md). It records observed cases separately from diagnostic evidence and research hypotheses; it does not change classifier behavior.
