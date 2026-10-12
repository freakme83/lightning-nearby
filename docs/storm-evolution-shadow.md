# Storm evolution shadow measurement

An actual newly inserted pending publication supplies the original location and
coordinate. Subsequent fresh unique LightningMaps detections remain associated
with their existing incident. In-memory, per-incident rolling history is limited
to 20 minutes and 96 points; spatial cells have a 3 km support radius. No
clustering, incident, publication, ledger or CG rule changes.

At least four recent detections and two in a new local cell, a 4 km separation
from the original coordinate, and a 4 km footprint are required before an
urban candidate can qualify. The selected location must have provenance-backed
neighborhood identity, an urban classification based on existing place
hierarchy, and a semantic key different from the original. A rural settlement
requires four local detections and 7 km separation. Unknown classifications,
district-only identities and missing hierarchy remain ineligible. Distinct
supported places are aggregated into one evaluation (up to four labels). Once
reported, semantic keys do not qualify again; later genuinely new keys can.

Only cells with multiple detections are reverse-geocoded, at most four per
incident lifetime, using the existing Nominatim rate-limited client and its
provider hierarchy. No additional Xweather calls are made. Reverse lookup
failure is an ambiguous location. The worker emits compact
`storm_evolution_shadow` records when diagnostic state changes, plus summary
counters. This is measurement only: no copy, ledger row, Telegram message or X
dispatch is produced.

Limits: a pending publication is an observable message baseline, but the worker
does not receive final X publication confirmation. A single reverse-geocoded
cell represents multiple nearby detections; this remains susceptible to
boundary naming error. The urban classifier uses address hierarchy, not
population density. State and semantic deduplication reset with the worker;
late expansion after the 20-minute window or after four lookups can be missed.
