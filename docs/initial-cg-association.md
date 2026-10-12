# Initial CG association for qualified incidents

This research worker queries Xweather only after the normal incident lifecycle has produced a qualified initial publication candidate. Xweather enrichment does not relax Profile B or prove that both feeds observed the same individual flash. Its initial publication question is whether a sufficiently nearby and current verified CG can be associated with the independently qualified electrical incident.

The initial CG selection checks returned CG events within the existing 10 km provider query radius. A candidate must be at most 10 km from the incident reference, at most 150 seconds from the reference event time, and current under the provider-event freshness protection (at most 4 minutes old, with future timestamps rejected). Ranking among eligible CG events is absolute reference-time difference, distance, then stable provider event ID. The selected Xweather CG supplies event identity, timestamp, coordinates, reverse-geocoded location, and map coordinates for a `#YILDIRIM` initial publication.

When no CG passes every initial condition, the normal non-CG publication path remains available. Telemetry distinguishes no CG returned, spatial rejection, reference-time rejection, provider-event staleness, and accepted selection. The provider's returned or broadly matched CG is not itself authorization for a `#YILDIRIM` message.

This policy applies to initial publication only. Repeat-CG admission, later first-CG transitions, and storm-evolution shadow evaluation retain their separate rules.
