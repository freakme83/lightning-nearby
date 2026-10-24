# Outer-district generic publication cooldown

An otherwise eligible initial `#ŞİMŞEK` candidate in any recognized Ankara outer district can enter the normal pending publication workflow once per shared 30-minute window. Profile B promotion, Xweather enrichment, geography, duplicate checks, and the existing publication gates run first. Central Ankara and verified CG (initial, first-CG, and repeat-CG) keep their existing paths. A cooldown denial does not cause another Xweather query.

The worker calls `admit_outer_generic_publication` only for a qualifying outer-district generic candidate whose final ledger decision is `WOULD_PUBLISH`. The service-role-only, invoker-rights function takes one transaction-level advisory lock shared by all outer districts, checks the prior **admitted** outer-generic publication rows, and inserts the pending publication row in that transaction. Its database `recorded_at` is the admission time, not an asserted external X post time. At exactly 30 minutes the previous admission is outside the window. Suppressed, held, duplicate, or failed requests do not reserve or extend the window. A missing/failing RPC holds the candidate and does not notify or dispatch it. The new nullable `canonical_district` column marks only new admitted outer-generic records; existing rows are preserved, and no ambiguous label backfill is attempted.

`outer_district_generic_admitted` identifies fresh admitted rows. `outer_district_generic_cooldown_suppressed` includes incident ID, canonical district, location label, representative coordinates, event count, incident reference time, suppression time, 30-minute duration, expiration, and reason. Ordinary ineligible candidates retain the existing candidate outcome diagnostics. These logs support future analysis only; there is no summary publication path.

## Deployment order (after review and merge)

1. Check the target project's migration history against the repository's existing ledger migrations, including the earlier cooldown-add and cooldown-drop migrations. Apply `scripts/lightning-publication-ledger/migrations/20261024073948_outer_district_generic_global_cooldown.sql` exactly once to the appropriate database.
2. Confirm the function exists, that only `service_role` can execute it, and that the column/index exist. Then deploy the updated Fly worker. A worker deployed before the migration fails closed for outer-generic admissions.

This PR applies no migration, restarts no worker, and sends no publication. The prior unconditional outer-district suppression ends only after the updated worker is deliberately deployed.
