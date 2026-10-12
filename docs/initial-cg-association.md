# Initial CG association for qualified incidents

This research worker queries Xweather only after the normal incident lifecycle has produced a qualified initial publication candidate. Xweather enrichment does not relax Profile B or prove that both feeds observed the same individual flash. Its initial publication question is whether a sufficiently nearby and current verified CG can be associated with the independently qualified electrical incident.

The initial CG selection checks returned CG events within the existing 10 km provider query radius. A candidate must be at most 10 km from the incident reference, at most 150 seconds from the reference event time, and current under the provider-event freshness protection (at most 4 minutes old, with future timestamps rejected). Ranking among eligible CG events is absolute reference-time difference, distance, then stable provider event ID. The selected Xweather CG supplies event identity, timestamp, coordinates, reverse-geocoded location, and map coordinates for a `#YILDIRIM` initial publication.

When no CG passes every initial condition, the normal non-CG publication path remains available. Telemetry distinguishes no CG returned, spatial rejection, reference-time rejection, provider-event staleness, and accepted selection. The provider's returned or broadly matched CG is not itself authorization for a `#YILDIRIM` message. For an accepted initial CG, `enrichment_complete` also records the selected provider coordinates and event time alongside its event ID and selection metrics; rejected candidates remain distinguished as evaluated, with selected fields null.

This policy applies to initial publication only. Repeat-CG admission, later first-CG transitions, and storm-evolution shadow evaluation retain their separate rules.


## Outer-district non-CG cooldown

Initial non-CG `#ŞİMŞEK` candidates in the selected outer Ankara districts use a 120-minute district-wide cooldown. The key comes from normalized Ankara province and district identity, not locality or rendered text, and is stored with each admitted publication ledger record so the decision survives worker restarts. The admission `recorded_at` timestamp starts the window; records at exactly 120 minutes are eligible again. Only these districts are covered: Şereflikoçhisar, Balâ/Bala, Haymana, Polatlı, Beypazarı, Nallıhan, Güdül, Çamlıdere, Kızılcahamam, Çubuk, and Kalecik. CG publications and repeat-CG admission do not read or update this cooldown.

The ledger migration backfills legacy rows only when the stored location label ends in an exact allowlisted district component. Other historical labels remain unkeyed rather than being guessed. A held candidate exits before ledger insertion, pending approval, Telegram, or X dispatch. If normalized district identity is missing or ambiguous, telemetry records the condition and existing publication behavior continues. If cooldown history cannot be read, the candidate is held to avoid publishing without the district-wide check. Apply the migration before deploying the worker that reads the new ledger column.
