# CG repeat foundation (PR 1)

This change does not enable CG repeats. Profile B, initial candidate triggering,
active-incident suppression, nearby cooldown, duplicate matching, approval,
Telegram and the X publisher retain their current rules. No suppressed activity
gets an enrichment attempt. The constants in `scripts/lightning-cg-repeat-policy/constants.ts`
are future defaults only: 1 km urban, 5 km rural/unknown, a 20-minute window and
three **total** CG admissions including the initial candidate.

## Naming correctness

For `cg_verified`, orchestration reverse-geocodes the selected Xweather CG event's
full-precision coordinate. This is the same coordinate used by the composer for
the internal Maps URL and rounded public coordinate. Incident representative
coordinates and reference time remain unchanged in paired diagnostics, ledger
identity and duplicate fallback. Other enrichment states still name the incident
representative coordinate. An invalid CG coordinate stops before lookup, without
falling back to the incident centroid. The message's timestamp format/source and
fingerprint algorithm are unchanged; a corrected label naturally changes its text
and exact-text fingerprint.

## Pure place helpers and provenance

`classifyCgPlace()` and `semanticCgLocationIdentity()` consume normalized fields
plus the existing whitelisted `providerAddress` hierarchy. The hierarchy now also
retains the American-spelled `neighborhood` alias, with compatibility for old
diagnostic artifacts. Public display-label normalization is unchanged.

Explicit village/hamlet evidence wins over a town/municipality parent. Conflicting
normalized/provider data, ambiguous city_district-only small places and missing
evidence are unknown. A localityKind of city/town/municipality with a named locality
and no rural/conflicting evidence is urban. A neighborhood without locality evidence
can have a reliable identity while still receiving unknown classification.

Identity requires provenance, country, province and a reliable district-like
parent (county/district/state_district, then a distinct town fallback). It uses a
neighborhood, rural settlement or district level. An ambiguous/missing hierarchy
returns an unavailable reason. Names use NFC, whitespace cleanup, Turkish case
folding and administrative suffix cleanup; Aşağı/Yukarı remain distinct. A
versioned JSON tuple prevents delimiter collisions. No displayLabel parsing or
publication authorization is performed.

## Nullable ledger metadata and rollout

The migration `scripts/lightning-publication-ledger/migrations/20261011161256_cg_location_metadata.sql`
adds only nullable `cg_metadata jsonb` to existing publication records. It creates
no quota/scope tables and changes no duplicate indexes, RLS or approval columns.
Apply this migration **before deploying the updated ledger adapter**. It has not
been applied to the hosted database by this PR. Older code ignores the new column;
legacy rows remain NULL. Updated history reads select the new column, so an
unmigrated schema will fail closed through the existing history/storage gates.

Version `cg-location:v1` stores selected CG latitude/longitude/time, whitelisted
normalized components and provider hierarchy, classification/evidence and semantic
identity (or its unavailable reason). The selected provider event ID remains in
the existing `provider_event_id`; it is not duplicated inside JSON. Metadata is
created only for an identifiable, valid selected CG with matching naming request
coordinates. Non-CG records store NULL. Legacy, malformed and unsupported metadata
is unavailable on read without changing duplicate matching. Derived values are
validated against the stored structured hierarchy; JSONB object-key ordering is
irrelevant. Metadata does not participate in the publication-ID hash or message
fingerprint. Full-precision values never come from rounded public text or Maps URL
parsing.

The Fly Dockerfile copies the pure helper directory because the ledger now imports
it. No Fly settings or deployment workflow change is involved.

## PR 2 still required

Before allowing repeats, implement bounded fresh suppressed-activity evaluation,
history comparison, durable incident-scope identity/restart recovery and atomic
admission safeguards. Current duplicate-history queries remain narrow provider-ID
and fingerprint/time queries, not incident history. The new metadata alone cannot
recover incident continuity or enforce a burst limit. Establish the admission vs
actual-post window contract separately; this PR adds no publisher quota. Legacy
NULL metadata must never be treated as a known different place.
