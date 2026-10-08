# Forecast validation corpus

This is an initial, manually curated validation corpus gathered from Lightning Nearby debug snapshots, Live observations, and manual Blitzortung/Windy ECMWF visual checks. It is not a statistically representative dataset or independently machine-verified ground truth.

The machine-readable cases live in [`research/forecast-validation/cases.json`](../research/forecast-validation/cases.json). Each record separates deterministic forecast evidence, ICON ensemble member support, observed activity, manual corroboration, and interpretation. External visual agreement does not establish exact event identity with Xweather Live events. ICON supporting-member counts are counts, not a probability. Live totals are Xweather Flash events and must not be described as cloud-to-ground strikes.

| Case | CAPE | Precip. | CIN | Direct TS signal | ICON EPS support | Current result | Observed activity | Research interpretation |
| --- | ---: | ---: | ---: | --- | ---: | --- | --- | --- |
| Saint-Gilles | 290 J/kg | 68% | 4 J/kg | None supplied | 0 / 40 | Low | Substantial broader-area activity manually observed; Windy ECMWF visual signal | False-Low candidate; possible low/moderate-CAPE convection, forcing/low inhibition, or missing direct evidence |
| Villahermosa / La Palma | 1,640 J/kg | 60% | 0 J/kg | None supplied | 0 / 40 | Elevated | Live showed strong nearby activity; one card reported 116 Flash events/10 km/5 min; Blitzortung showed broader-area activity | Useful CAPE + precipitation fallback; preserve deterministic positive results when ensemble support is zero |
| Döşemealtı | 550 J/kg | 10% | 41 J/kg | None supplied | 0 / 40 | Low | Live check reported nearest activity ~2.9 km southwest and 8 Flash events/10 km/5 min; Windy field appeared adjacent, especially south/east | Possible exact-point spatial miss/displacement; lowering the CAPE threshold alone would not address the low point precipitation |
| Ponza | 1,030 J/kg | 83% | 11 J/kg | WMO 95 | 29 / 40 | High | Later Live check reported one Flash event ~9.4 km east; Blitzortung showed broader-area detections | Canonical positive case: direct thunderstorm code, supportive ingredients, and strong secondary ensemble support |

## What these cases suggest

These four manually selected cases illustrate different regimes:

1. The current CAPE + precipitation fallback can be useful (Villahermosa).
2. Convection may occur with lower CAPE and weak inhibition when direct thunder evidence is missing (Saint-Gilles).
3. Exact-point deterministic evidence may miss nearby displaced convection (Döşemealtı).
4. A direct thunderstorm code plus strong ensemble support can form a canonical positive regression guard (Ponza).

The evidence is useful for designing later evaluation, but four cases are not enough to recalibrate production thresholds.

## Research hypotheses, not decisions

### Secondary low-CAPE fallback

A candidate for offline comparison only, when direct thunderstorm probability is unavailable:

- CAPE >= 250 J/kg
- precipitation probability >= 65%
- CIN <= 25 J/kg

Saint-Gilles motivates study of this combination. Döşemealtı shows it would not solve every false-Low candidate: point precipitation there was 10%. This rule is not implemented.

### Deterministic neighborhood diagnostics

For an exact-point Low with direct thunderstorm probability unavailable, investigate whether deterministic evidence at the center and nearby north/east/south/west points within roughly 10–15 km reveals displaced convection. Keep this debug/research-only until validated; this corpus does not add provider calls.

### ECMWF lightning density

Investigate whether direct ECMWF lightning-density evidence can identify ingredient-only misses. The existing [lightning-density verification](lightning-density-verification.md) documents the current availability findings. This corpus adds no provider requests or production integration.

## Evidence and limitations

- `app_debug_snapshot` records the forecast inputs and result at the stated debug coordinate/time.
- `app_live_observation` records an Xweather Flash-based Live result. It is a separate observation and may use a nearby, non-identical selected location/time.
- `manual_blitzortung_check` and `manual_windy_ecmwf_check` are visual manual cross-checks, not independently verified event labels.
- `user_observed_activity` records broader-area activity reported during manual validation.
- Interpretations and tags are research hypotheses. They do not alter the production classifier.
- Counts from different providers or event products are not directly comparable without provider and event-unit analysis.

A small deterministic test checks case IDs, coordinates, qualitative values, member count bounds, and that ensemble support is not represented as a probability. Run it with the normal `npm test` suite.
