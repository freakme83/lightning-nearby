import assert from "node:assert/strict";
import test from "node:test";
import { createSupabaseLedger } from "./supabase.ts";
import type { PublicationRecord } from "../types.ts";

const candidate: PublicationRecord = {
  publicationId: "pub_candidate", runId: "2", incidentId: "i-000001",
  incidentReferenceTime: "2026-10-08T10:00:00.000Z", incidentLatitude: 41.5,
  incidentLongitude: 12.8, provider: "xweather", enrichmentStatus: "cg_verified",
  providerEventId: "event-1", providerEventType: "cg", locationLabel: "Lenola, Latina",
  messageFingerprint: "sha256:test", decision: "WOULD_PUBLISH", recordedAt: "2026-10-08T10:01:00.000Z",
};
const row = { publication_id: "pub_prior", run_id: "1", incident_id: "i-000002",
  incident_reference_time: candidate.incidentReferenceTime, incident_latitude: 41.5,
  incident_longitude: 12.8, provider: "xweather", enrichment_status: "cg_verified",
  provider_event_id: "event-1", provider_event_type: "cg", location_label: "Lenola, Latina",
  message_fingerprint: "sha256:test", decision: "PUBLISHED", recorded_at: candidate.recordedAt,
  platform_post_id: null };
const config = { url: "https://example.supabase.co", serviceRoleKey: "SECRET_DO_NOT_LEAK" };

test("scoped provider and strict fingerprint/time history queries map actual table columns", async () => {
  const urls: URL[] = [];
  const store = createSupabaseLedger(config, (async (input: RequestInfo | URL) => {
    urls.push(new URL(String(input)));
    return Response.json(urls.length === 1 ? [row] : []);
  }) as typeof fetch);
  const records = await store.loadRelevantPublicationHistory(candidate);
  assert.equal(records.length, 1);
  assert.deepEqual(records[0], { ...candidate, publicationId: "pub_prior", runId: "1", incidentId: "i-000002",
    decision: "PUBLISHED", platformPostId: null });
  assert.equal(urls[0].searchParams.get("provider"), "eq.xweather");
  assert.equal(urls[0].searchParams.get("provider_event_id"), "eq.event-1");
  assert.equal(urls[1].searchParams.get("message_fingerprint"), "eq.sha256:test");
  assert.equal(urls[1].searchParams.get("and"),
    "(incident_reference_time.gte.2026-10-08T09:59:58.000Z,incident_reference_time.lte.2026-10-08T10:00:02.000Z)");
  assert.ok(urls.every(url => url.searchParams.get("decision") === "in.(WOULD_PUBLISH,PUBLISHED)"));
  assert.ok(urls.every(url => url.searchParams.get("limit") === "101"));
});

test("no provider ID queries only strict fallback; exact publication ID write ignores conflict", async () => {
  const urls: URL[] = [];
  const store = createSupabaseLedger(config, (async (input: RequestInfo | URL, init?: RequestInit) => {
    urls.push(new URL(String(input)));
    if (init?.method === "POST") {
      assert.equal((init.headers as Record<string, string>).Prefer, "resolution=ignore-duplicates,return=representation");
      assert.deepEqual(JSON.parse(String(init.body)).publication_id, "pub_candidate");
      return Response.json([]);
    }
    return Response.json([]);
  }) as typeof fetch);
  assert.deepEqual(await store.loadRelevantPublicationHistory({ ...candidate, providerEventId: null }), []);
  assert.equal(urls.length, 1);
  assert.equal(urls[0].searchParams.get("provider_event_id"), null);
  assert.equal(await store.insertPublicationRecord(candidate), "already_present");
  assert.equal(urls[1].searchParams.get("on_conflict"), "publication_id");
});

test("configuration and response errors expose no service-role credential", async () => {
  assert.throws(() => createSupabaseLedger({ url: config.url }), /incomplete/);
  const store = createSupabaseLedger(config, (async () => new Response("secret in provider error", { status: 503 })) as typeof fetch);
  await assert.rejects(store.loadRelevantPublicationHistory(candidate), error => {
    assert.doesNotMatch(String(error), /SECRET_DO_NOT_LEAK|secret in provider error/);
    return true;
  });
  await assert.rejects(store.insertPublicationRecord(candidate), /HTTP 503/);
});

test("a bounded query never silently discards overflow rows", async () => {
  const store = createSupabaseLedger(config, (async () => Response.json(Array.from({ length: 101 }, () => row))) as typeof fetch);
  await assert.rejects(store.loadRelevantPublicationHistory(candidate), /exceeded its bounded result size/);
});
