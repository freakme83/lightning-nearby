# Initial CG association for qualified incidents

This research worker queries Xweather only after the normal incident lifecycle has produced a qualified initial publication candidate. Xweather enrichment does not relax Profile B or prove that both feeds observed the same individual flash. Its initial publication question is whether a sufficiently nearby and current verified CG can be associated with the independently qualified electrical incident.

The initial CG selection checks returned CG events within the existing 10 km provider query radius. A candidate must be at most 10 km from the incident reference, at most 150 seconds from the reference event time, and current under the provider-event freshness protection (at most 4 minutes old, with future timestamps rejected). Ranking among eligible CG events is absolute reference-time difference, distance, then stable provider event ID. The selected Xweather CG supplies event identity, timestamp, coordinates, reverse-geocoded location, and map coordinates for a `#YILDIRIM` initial publication.

When no CG passes every initial condition, the normal non-CG publication path remains available. Telemetry distinguishes no CG returned, spatial rejection, reference-time rejection, provider-event staleness, and accepted selection. The provider's returned or broadly matched CG is not itself authorization for a `#YILDIRIM` message. For an accepted initial CG, `enrichment_complete` also records the selected provider coordinates and event time alongside its event ID and selection metrics; rejected candidates remain distinguished as evaluated, with selected fields null.

This policy applies to initial publication only. Repeat-CG admission, later first-CG transitions, and storm-evolution shadow evaluation retain their separate rules.


## Outer-district non-CG cooldown

Initial non-CG publications in the selected outer Ankara districts use a 120-minute district-wide cooldown. The key comes from normalized district identity and is stored with the publication ledger record so the decision survives worker restarts. CG publications and repeat-CG admission do not read or update this cooldown.
