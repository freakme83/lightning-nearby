# Outer-district generic publication cooldown

A recognized Ankara outer district may admit an otherwise eligible initial generic (`#ŞİMŞEK`) publication once per shared 30-minute window. The window is measured from durable ledger admission, across all recognized outer districts. Suppressed candidates do not advance it. Central districts and verified CG publications retain their existing paths. Xweather classification occurs before this admission decision.

The worker must call an atomic, service-role-only Supabase admission function for eligible outer-district initial generic candidates. A denied or unavailable admission cannot notify or publish. Structured suppression telemetry records incident, place, reference, and expiration context for later analysis; it does not publish a summary.

Apply the accompanying database migration before deploying a worker built from this change. The migration and worker are not deployed by this PR.
