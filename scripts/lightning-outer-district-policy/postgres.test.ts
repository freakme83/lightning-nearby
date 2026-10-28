// Optional local PostgreSQL engine; never connects to hosted Supabase.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const modulePath = process.env.OUTER_GENERIC_POSTGRES_TEST_MODULE;
test("atomic per-district outer-generic admission and least-privilege RPC", { skip: !modulePath }, async () => {
  const { PGlite } = await import(modulePath!);
  const db = new PGlite();
  await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
    create table public.publication_records (
      publication_id text primary key, run_id text, incident_id text, incident_reference_time timestamptz,
      incident_latitude double precision, incident_longitude double precision, provider text, enrichment_status text,
      provider_event_id text, provider_event_type text, location_label text, message_fingerprint text,
      decision text, recorded_at timestamptz, platform_post_id text, message_text text, map_url text,
      approval_status text, approval_updated_at timestamptz, approval_actor text, cg_metadata jsonb, cg_scope_id text);
    alter table publication_records enable row level security;
    grant select, insert on publication_records to service_role;`);
  const migration = await readFile(new URL("../lightning-publication-ledger/migrations/20261024073948_outer_district_generic_global_cooldown.sql", import.meta.url), "utf8");
  const perDistrictMigration = await readFile(new URL("../lightning-publication-ledger/migrations/20261028074911_outer_district_generic_per_district_cooldown.sql", import.meta.url), "utf8");
  await db.exec(migration);
  await db.exec(perDistrictMigration);
  const record = (id: string, district: string, status = "no_match") => ({
    publication_id: id, run_id: "run", incident_id: id,
    incident_reference_time: new Date().toISOString(), incident_latitude: 40, incident_longitude: 32,
    provider: "xweather", enrichment_status: status, provider_event_id: null, provider_event_type: null,
    location_label: district, message_fingerprint: id, decision: "WOULD_PUBLISH",
    recorded_at: new Date().toISOString(), platform_post_id: null, message_text: `#ŞİMŞEK ${id}`,
    approval_status: "pending", canonical_district: district,
  });
  const admit = async (id: string, district: string, status?: string) => {
    const result = await db.query("select public.admit_outer_generic_publication($1) as result", [record(id, district, status)]);
    return result.rows[0].result as { outcome: string; reason?: string; cooldownExpiresAt?: string; admittedAt?: string };
  };
  try {
    await db.exec("set role anon");
    await assert.rejects(admit("no-access", "Haymana"), /permission denied/);
    await db.exec("reset role; set role authenticated");
    await assert.rejects(admit("no-access-authenticated", "Haymana"), /permission denied/);
    await db.exec("reset role; set role service_role");
    const first = await admit("first", "Şereflikoçhisar");
    assert.equal(first.outcome, "inserted");
    assert.ok(first.admittedAt);
    assert.equal((await admit("evren", "Evren")).outcome, "inserted");
    const [sameDistrict, sameEvren] = await Promise.all([
      admit("same-district", "Şereflikoçhisar"), admit("same-evren", "Evren"),
    ]);
    assert.deepEqual([sameDistrict.outcome, sameEvren.outcome], ["suppressed", "suppressed"]);
    assert.equal(sameDistrict.reason, "outer_district_generic_cooldown");
    assert.ok(Date.parse(sameDistrict.cooldownExpiresAt!) > Date.parse(first.admittedAt!));
    assert.equal((await admit("same-district", "Şereflikoçhisar")).outcome, "suppressed");
    assert.equal((await db.query("select count(*)::int as n from publication_records")).rows[0].n, 2);
    await assert.rejects(admit("cg", "Haymana", "cg_verified"), /Invalid outer generic admission/);
    await assert.rejects(admit("invalid", "Not an outer district"), /Invalid outer generic admission/);
    // Database clock at admission is later than this exact 30-minute boundary.
    await db.exec("reset role; update publication_records set recorded_at=clock_timestamp()-interval '30 minutes' where publication_id='first'; set role service_role");
    assert.equal((await admit("after-expiry", "Şereflikoçhisar")).outcome, "inserted");
    assert.equal((await admit("after-expiry", "Şereflikoçhisar")).outcome, "already_present");
    assert.equal((await db.query("select count(*)::int as n from publication_records")).rows[0].n, 3);
  } finally {
    await db.exec("reset role");
    await db.close();
  }
});
