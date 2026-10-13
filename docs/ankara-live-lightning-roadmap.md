# Ankara live-lightning research roadmap

This document is the current planning source of truth for the Ankara-focused live-lightning research track. It is separate from the production Lightning Nearby forecast PWA and should be read as experimental operational research, not as an official warning system.

## Product objective

The research system should publish concise, useful lightning information without turning into a raw strike feed. The governing idea is:

> Do not tell essentially the same thing twice, but do not suppress genuinely new electrical information.

This requires separating **meteorological event identity** from **publication information identity**. One evolving storm can contain several publishable information transitions: an initial supported lightning incident, the first verified cloud-to-ground (CG) event, a meaningfully new CG location, or a broader supported spread into new areas.

Precision remains more important than volume. A provider result should not become a public claim unless the relevant publication policy accepts it.

## Current architecture

The research path is operationally separate from the PWA:

`LightningMaps live feed -> Ankara operational polygon -> clustering -> Profile B incident lifecycle -> Xweather/Nominatim enrichment -> message composer -> Supabase publication ledger -> Telegram notification -> guarded auto-approval -> existing GitHub X Publisher -> X`

Key boundaries:

- LightningMaps provides the live observation stream used to form incidents.
- The local Ankara operational polygon is authoritative for research-area admission; it is not an administrative-boundary claim.
- Profile B remains the baseline incident qualification policy: 3 events within 10 minutes, with existing lifecycle/cooldown behavior.
- Xweather is an enrichment and CG-verification source; it does not replace independent incident qualification.
- Nominatim supplies human-readable place naming and semantic place structure; it is not an admission authority.
- Supabase provides durable publication/duplicate state and atomic CG-repeat admission.
- Telegram is an operator notification path and must not block publication.
- X credentials remain isolated in the existing GitHub publisher workflow, not on Fly.

## Current publication model

### Initial incident publication

An incident must first qualify independently through the normal lifecycle. Initial Xweather enrichment is now CG-first:

- CG distance: <= 10 km from the enrichment reference
- absolute reference-time difference: <= 150 seconds
- provider event age: 0-240 seconds
- ranking: smallest time difference, then smallest distance, then stable provider event ID

An accepted CG produces `#YILDIRIM`; provider identity, event time, coordinates, reverse-geocoded place and map output come from the selected Xweather CG event. A returned CG that fails the initial association/currentness policy does not authorize `#YILDIRIM` and falls back to the non-CG publication path.

Non-CG initial publications use `#ŞİMŞEK`.

### CG repeat / transition publication

CG repeat admission remains a separate policy from initial association. It keeps provider-event deduplication, currentness checks, semantic-location comparison, distance thresholds, persistent atomic admission and burst protection.

The intended product behavior is that a first genuinely verified CG inside an already-published `#ŞİMŞEK` incident is new information rather than merely a duplicate of the original non-CG publication. Activation of that transition policy remains a separate roadmap item.

### Public message format

Automatic posts include explicit Ankara context while keeping the format short:

```text
#ŞİMŞEK
Ankara’da, D MMMM YYYY, HH:mm TSİ
{yer} civarında şimşek kaydedildi.
```

For CG:

```text
#YILDIRIM
Ankara’da, D MMMM YYYY, HH:mm TSİ
{yer} civarında yere ulaşan yıldırım kaydedildi.

{lat}, {lon}
```

CG public coordinates remain derived from the selected Xweather CG event. The internal Google Maps reference uses the same selected provider coordinates.

## Completed milestones

### P0-A - Expired candidate recovery

Completed in PR #84.

A never-promoted candidate that expired before reaching 3/10 can be reconsidered when later observations in the same living cluster provide enough rolling support. This fixes a recall/correctness problem without lowering the incident threshold.

### P0-C - CG/provider telemetry separation

Largely complete.

Initial and repeat paths expose provider outcomes with enough detail to distinguish no CG returned, spatial rejection, reference-time rejection, provider staleness, IC-only results, accepted CG and related selected/evaluated-event diagnostics.

### P0-D - Initial CG-first association

Completed in PR #87.

The old 8 km same-event-style cutoff no longer causes an independently qualified initial incident to miss a current CG inside the existing 10 km Xweather query radius. Initial publication authorization now uses the explicit 10 km / 150 s / 240 s policy described above.

### Storm-evolution shadow

Implemented in PR #85 and running in shadow mode.

It evaluates whether an already-published incident has developed supported activity in meaningfully new semantic locations within a rolling window. It is telemetry-only and has no ledger, Telegram or X side effects.

### Ankara monitoring polygon tightening

Completed in PR #86.

The southern operational boundary was tightened after live Kulu-area publications demonstrated that the previous coarse polygon was too broad. The polygon remains operational coverage rather than a claim of exact provincial boundaries.

### Automatic message context

The automatic message composer now includes `Ankara’da` in the date/time line and uses the fixed public verb `kaydedildi` for uniform notices.

## Active observation phase

The system is currently in a deliberate observe-and-measure phase. Avoid stacking several new behavioral publication changes at once; otherwise field evidence becomes difficult to attribute to a specific policy.

The most valuable live checks are:

- initial CG outcomes: accepted vs spatial / reference-time / stale / no-CG cases
- accepted CGs in the former 8-10 km gap
- any raw CG that is correctly rejected and falls back to `#ŞİMŞEK`
- storm-evolution shadow eligibility and false-positive/false-negative patterns
- provider latency: whether Xweather returns useful CG/IC evidence only after the initial query

## Near-term roadmap

| Priority | Work | Status / decision |
|---|---|---|
| P0-A | Expired candidate recovery | Complete - PR #84 |
| P0-C | CG/provider telemetry | Largely complete; continue field validation |
| P0-D | Initial CG association | Complete - PR #87; field validation active |
| P0-B | First verified CG transition | Detailed shadow telemetry active and collecting data (PR #98); publication transition remains inactive |
| P1 | Delayed Xweather recheck shadow | This PR: one shadow-only query about 3 minutes after qualifying initial `#ŞİMŞEK` |
| P1/P2 | Storm evolution | Shadow running; collect data before publishing activation |
| P2 | Urban relevance layer | Defer until storm-evolution evidence is sufficient |
| P3 | Cluster geometry redesign | Defer; do not solve publication semantics by prematurely shrinking meteorological clusters |

## Running shadow experiments

These are evidence-gathering experiments. Their results must not silently become publication policy; review real cases before proposing any behavior change.

- `first_cg_transition_shadow` measures whether a later verified CG would provide meaningful new information after an earlier `#ŞİMŞEK`. It observes the normal live flow and does not activate the transition.
- Delayed Xweather recheck (this PR) measures provider/reporting latency: whether an initial non-CG result becomes a current, acceptable CG on one query about 3 minutes later. It records the actual `X-Cost-Tokens` response-header value when present so query cost can be compared with normal enrichment; absent headers stay null.
- Storm evolution measures whether later electrical activity represents meaningful geographic evolution rather than repeat reporting.

The delayed check is scheduled only after an initial non-CG candidate is persisted in the normal publication flow. It makes no publication or admission decision. Pending work is in memory only and may be lost on worker restart; no recovery persistence is added.

## Design principles and guardrails

- Do not lower the base incident threshold merely to increase tweet volume.
- Do not treat a nearby provider CG as proof of exact cross-network flash identity; initial CG association is an enrichment decision for an already-qualified incident.
- Keep initial CG association and repeat/transition CG admission as separate policies.
- Provider IDs, freshness/currentness and coordinate provenance are hard protections for CG claims.
- Do not use Nominatim province/name results as the authoritative monitoring-area gate.
- Do not hard-code a list of favored Ankara neighborhoods for urban relevance. Future relevance should use semantic place structure plus evidence such as support, distance and density/population context if introduced.
- Do not add a global minimum interval between all tweets. Independent meaningful events may occur close together in time.
- Preserve bounded work: provider queries, reverse lookups, queues and retries should remain explicitly limited.
- Keep research changes isolated from the production PWA unless a separate product decision explicitly bridges them.

## Known limitations

### Chain-link clustering

Current clustering can grow into 20-25 km elongated structures because new observations may attach through recent members. This can be meteorologically useful but should not automatically define the user-facing publication unit. The preferred approach is to improve publication semantics first rather than immediately shrinking clusters.

### Provider timing

Xweather data may arrive after the initial LightningMaps-triggered query. The delayed-recheck shadow experiment is intended to measure this before changing live publication behavior.

### Semantic place ambiguity

Reverse geocoding can produce different hierarchy quality across urban/rural locations. Storm-evolution and CG-repeat logic therefore need conservative handling of ambiguous identities.

### Operational geography

The Ankara polygon is a hand-maintained operational research area. It intentionally prioritizes useful Ankara-centered coverage and does not guarantee exact administrative inclusion/exclusion at every edge.

### External-service latency

A CG is accepted at a defined policy gate before later reverse geocoding/composition work. A provider event close to the age limit may become older while downstream work completes; external lookup latency should not silently redefine the already-made acceptance decision unless future evidence shows a need for a different rule.

## What not to change yet

Until field evidence justifies it, avoid:

- weakening Profile B
- activating storm-evolution publication
- broad urban-priority publishing rules
- changing cluster geometry solely to increase publication recall
- merging initial and repeat CG policy into one global matcher
- adding repeated Xweather retries
- making geocoder output an admission authority

## Updating this document

Update this roadmap when a policy-changing research PR is merged, when a shadow experiment materially changes the evidence base, or when a roadmap item changes state. Keep detailed implementation notes in the focused documents under `docs/`; this file should remain the high-level source of truth for goals, current behavior and next decisions.
