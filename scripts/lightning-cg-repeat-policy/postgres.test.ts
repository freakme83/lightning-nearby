// Optional local PostgreSQL engine, never hosted Supabase. Set this to an installed
// @electric-sql/pglite module entrypoint; no package or deployed-schema changes.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { cgRecord } from "./test-fixtures.ts";
import { CG_REPEAT_POLICY_VERSION } from "./constants.ts";
import { fingerprintMessage } from "../lightning-publication-ledger/record.ts";

const modulePath = process.env.CG_REPEAT_POSTGRES_TEST_MODULE;
test("local PostgreSQL atomic admission, rollback, history, scope and role contracts", { skip: !modulePath }, async t => {
  const { PGlite } = await import(modulePath!);
  const db = new PGlite();
  await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
    create table public.publication_records (
      publication_id text primary key, run_id text, incident_id text, incident_reference_time timestamptz,
      incident_latitude double precision, incident_longitude double precision, provider text, enrichment_status text,
      provider_event_id text, provider_event_type text, location_label text, message_fingerprint text,
      decision text, recorded_at timestamptz, platform_post_id text, message_text text, map_url text,
      approval_status text, approval_updated_at timestamptz, approval_actor text, cg_metadata jsonb);
    alter table publication_records enable row level security;
    grant select,insert,update on publication_records to service_role;
    insert into publication_records(publication_id,decision) values('legacy','HOLD');`);
  await db.exec(await readFile(new URL("../lightning-publication-ledger/migrations/20261008_provider_event_unique.sql", import.meta.url), "utf8"));
  const migration = await readFile(new URL("../lightning-publication-ledger/migrations/20261011165220_cg_repeat_admission.sql", import.meta.url), "utf8");
  await db.exec(migration); await db.exec(migration);
  function request(id: string, place: string, distance = 0, scope = "scope-a", kind: "initial" | "repeat" = "repeat", classification = "urban", predecessor?: string) {
    const at = Date.now() - 1000;
    const row = cgRecord(id, place, distance, scope, at, classification);
    row.cgMetadata!.eventTime = new Date(at).toISOString();
    const record = { publication_id: id, run_id: "run", incident_id: scope, incident_reference_time: row.incidentReferenceTime,
      incident_latitude: row.incidentLatitude, incident_longitude: row.incidentLongitude, provider: row.provider,
      enrichment_status: row.enrichmentStatus, provider_event_id: row.providerEventId, provider_event_type: row.providerEventType,
      location_label: place, message_fingerprint: fingerprintMessage(id), message_text: id, decision: row.decision,
      recorded_at: row.recordedAt, platform_post_id: null, approval_status: "pending", cg_metadata: row.cgMetadata,
      cg_scope_id: scope };
    return { record, options: { scopeId: scope, kind, predecessorScopeId: predecessor,
      policyVersion: CG_REPEAT_POLICY_VERSION, suppressionReason: "already_published_active_incident",
      repeatReadyAt: new Date(at - 2_400_000).toISOString(), referenceTime: new Date(at).toISOString() } };
  }
  async function admit(value: ReturnType<typeof request>) {
    const result = await db.query("select public.admit_cg_publication($1,$2) as result", [value.record, value.options]);
    return result.rows[0].result;
  }
  try {
    await t.test("roles and legacy NULL", async () => {
      assert.equal((await db.query("select cg_scope_id from publication_records where publication_id='legacy'")).rows[0].cg_scope_id, null);
      await db.exec("set role anon");
      await assert.rejects(admit(request("unauthorized", "A")), /permission denied/);
      await db.exec("reset role; set role service_role");
      assert.equal((await admit(request("one", "Ayrancı", 0, "scope-a", "initial"))).outcome, "inserted");
      await db.exec("reset role");
    });
    await t.test("same provider, same location and 800 m cannot escape", async () => {
      const duplicate = request("other-id", "Balgat", 1.4); duplicate.record.provider_event_id = "one";
      assert.equal((await admit(duplicate)).reason, "same_provider_event");
      assert.equal((await admit(request("same-place", "Ayrancı", 5))).reason, "same_semantic_location");
      assert.equal((await admit(request("boundary-noise", "Balgat", 0.8))).reason, "distance_below_threshold");
    });
    await t.test("initial counts, pending and approved reserve, concurrent requests cannot exceed three", async () => {
      assert.equal((await admit(request("two", "Balgat", 1.4))).rollingCount, 2);
      await db.exec("update publication_records set approval_status='approved' where publication_id='two'");
      const results = await Promise.all([admit(request("three", "Çukurambar", 2.8)), admit(request("four", "Söğütözü", 4.2))]);
      assert.equal(results.filter(result => result.outcome === "inserted").length, 1);
      assert.equal(results.find(result => result.outcome === "suppressed").reason, "burst_limit");
      assert.equal((await db.query("select count(*)::int as n from publication_records where cg_scope_id='scope-a'")).rows[0].n, 3);
    });
    await t.test("expiry frees quota, full history prevents cycling, separate scope independent", async () => {
      await db.exec("update publication_records set recorded_at=clock_timestamp()-interval '20 minutes' where publication_id='one'");
      assert.equal((await admit(request("cycle", "Ayrancı", 5))).reason, "same_semantic_location");
      assert.equal((await admit(request("after-expiry", "Söğütözü", 4.2))).outcome, "inserted");
      assert.equal((await admit(request("independent", "Elsewhere", 30, "scope-b", "initial"))).rollingCount, 1);
    });
    await t.test("rural + town and unknown require 5 km", async () => {
      await admit(request("rural-one", "Village A", 0, "rural", "initial", "rural"));
      assert.equal((await admit(request("rural-two", "Village B", 2, "rural", "repeat", "rural"))).thresholdKm, 5);
      assert.equal((await admit(request("rural-seven", "Village B", 7, "rural", "repeat", "rural"))).outcome, "inserted");
      await admit(request("unknown-one", "Place A", 0, "unknown", "initial", "unknown"));
      assert.equal((await admit(request("unknown-two", "Place B", 2, "unknown", "repeat", "unknown"))).thresholdKm, 5);
    });
    await t.test("same-parent hierarchy loss is conservative, reliable town center may qualify", async () => {
      await admit(request("hierarchy-one", "Ayrancı", 0, "hierarchy", "initial"));
      assert.equal((await admit(request("hierarchy-missing", "", 7, "hierarchy"))).reason, "semantic_change_unproven");
      await admit(request("center-village", "Village A", 0, "center", "initial", "rural"));
      const center = request("center-town", "", 7, "center"); center.record.cg_metadata!.location.rawType = "town";
      assert.equal((await admit(center)).outcome, "inserted");
    });
    await t.test("cooldown predecessor compared, own count independent", async () => {
      const first = await admit(request("cooldown-one", "New place", 6, "cooldown", "repeat", "urban", "scope-a"));
      assert.equal(first.outcome, "inserted"); assert.equal(first.rollingCount, 1);
      assert.equal((await admit(request("cooldown-cycle", "Ayrancı", 8, "cooldown", "repeat", "urban", "scope-a"))).reason, "same_semantic_location");
      assert.equal((await admit(request("missing-history", "X", 20, "missing", "repeat", "urban", "absent"))).reason, "predecessor_history_unavailable");
    });
    await t.test("identity, selected freshness and recovery fail closed", async () => {
      for (const issue of ["id", "semantic", "old", "future", "recovery", "reference"] as const) {
        const value = request(`bad-${issue}`, "Another", 10, "scope-a");
        if (issue === "id") value.record.provider_event_id = "";
        if (issue === "semantic") value.record.cg_metadata!.semanticIdentity = { available: false, reason: "ambiguous_hierarchy" };
        if (issue === "old") value.record.cg_metadata!.eventTime = new Date(Date.now() - 61_001).toISOString();
        if (issue === "future") value.record.cg_metadata!.eventTime = new Date(Date.now() + 60_000).toISOString();
        if (issue === "recovery") value.options.repeatReadyAt = new Date(Date.now() + 2_400_000).toISOString();
        if (issue === "reference") value.options.referenceTime = new Date(Date.now() - 300_000).toISOString();
        assert.equal((await admit(value)).outcome, "suppressed", issue);
      }
    });
    await t.test("same-provider cross-scope race and exact ID rerun", async () => {
      const a = request("race-a", "A", 0, "race-a", "initial");
      const b = request("race-b", "B", 7, "race-b", "initial");
      a.record.provider_event_id = b.record.provider_event_id = "same-race-event";
      const results = await Promise.all([admit(a), admit(b)]);
      assert.equal(results.filter(result => result.outcome === "inserted").length, 1);
      assert.equal((await admit(a)).outcome, "already_present");
    });
    await t.test("transaction rollback cannot leave a slot without a positive row", async () => {
      await db.exec("begin");
      assert.equal((await admit(request("rolled-back", "A", 0, "rollback", "initial"))).outcome, "inserted");
      await db.exec("rollback");
      assert.equal((await db.query("select count(*)::int as n from publication_records where cg_scope_id='rollback'")).rows[0].n, 0);
      assert.equal((await db.query("select count(*)::int as n from cg_repeat_scopes where scope_id='rollback'")).rows[0].n, 0);
    });
  } finally { await db.close(); }
});
