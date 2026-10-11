import assert from "node:assert/strict";
import test from "node:test";
import { continueFromPairedArtifact, withPublishDecision } from "../lightning-end-to-end-dry-run/orchestrate.ts";
import { normalizeAndLabel, extractProviderAddressHierarchy } from "../lightning-location-naming/normalize.ts";
import { PAIRED_ARTIFACT_FIXTURES } from "../lightning-message-preview/fixtures.ts";
import { buildPublicationRecord, fingerprintMessage } from "./record.ts";
import { buildCgPublicationMetadata, parseCgPublicationMetadata } from "./cg-metadata.ts";
import { matchPublicationDuplicate } from "./duplicate.ts";
import { createSupabaseLedger } from "./storage/supabase.ts";

const payload = { address: { quarter: "Aşağı Ayrancı", town: "Çankaya", county: "Çankaya",
  province: "Ankara", country: "Türkiye", road: "DO NOT STORE" } };

async function completed(status: "cg_verified" | "ic_only" | "no_match" | "provider_unavailable" = "cg_verified") {
  const source = PAIRED_ARTIFACT_FIXTURES[status];
  const artifact = status === "cg_verified" ? { ...PAIRED_ARTIFACT_FIXTURES.cg_verified,
    enrichment: { ...PAIRED_ARTIFACT_FIXTURES.cg_verified.enrichment,
      match: { ...PAIRED_ARTIFACT_FIXTURES.cg_verified.enrichment.match,
        latitude: 39.902743123, longitude: 32.851495123 } } } : source;
  return withPublishDecision(await continueFromPairedArtifact(artifact, {
    reverse: async (latitude, longitude) => ({ latitude, longitude, provider: "fixture",
      ...normalizeAndLabel(payload), providerAddress: extractProviderAddressHierarchy(payload) }),
  }), { sourceHealthAtTrigger: "live" });
}

test("CG record captures selected full precision, time, structured provenance and semantic identity", async () => {
  const result = await completed();
  const built = buildPublicationRecord(result, { runId: "foundation" });
  assert.ok(built.ok && result.message?.ok);
  const metadata = built.record.cgMetadata;
  assert.ok(metadata);
  assert.equal(metadata.latitude, 39.902743123);
  assert.equal(metadata.longitude, 32.851495123);
  assert.equal(metadata.eventTime, new Date(PAIRED_ARTIFACT_FIXTURES.cg_verified.enrichment.match.eventTimeMs).toISOString());
  assert.equal(metadata.classification.classification, "urban");
  assert.equal(metadata.semanticIdentity.available, true);
  assert.equal(metadata.location.neighborhood, "Aşağı Ayrancı");
  assert.equal(metadata.providerAddress?.quarter, "Aşağı Ayrancı");
  assert.equal("road" in (metadata.providerAddress ?? {}), false);
  assert.equal(built.record.providerEventId, PAIRED_ARTIFACT_FIXTURES.cg_verified.enrichment.match.id);
  assert.equal(built.record.incidentLatitude, PAIRED_ARTIFACT_FIXTURES.cg_verified.incident.latitude);
  assert.equal(built.record.messageFingerprint, fingerprintMessage(result.message.text));
  assert.deepEqual(parseCgPublicationMetadata(metadata), metadata);
});

test("metadata is independent of publication ID/fingerprint and cannot escape provider duplicates", async () => {
  const built = buildPublicationRecord(await completed(), { runId: "foundation" });
  assert.ok(built.ok);
  const without = { ...built.record, cgMetadata: null };
  assert.equal(without.publicationId, built.record.publicationId);
  assert.equal(matchPublicationDuplicate({ ...built.record, cgMetadata: null }, [without]).reason, "same_provider_event");
  const result = await completed();
  const noProvenance = { ...result, location: result.location && "normalized" in result.location
    ? { ...result.location, providerAddress: undefined } : result.location };
  const legacyBuilt = buildPublicationRecord(noProvenance, { runId: "foundation" });
  assert.ok(legacyBuilt.ok);
  assert.equal(legacyBuilt.record.publicationId, built.record.publicationId);
  assert.equal(legacyBuilt.record.cgMetadata?.semanticIdentity.available, false);
});

test("non-CG records do not invent selected CG metadata", async () => {
  for (const status of ["ic_only", "no_match", "provider_unavailable"] as const) {
    const built = buildPublicationRecord(await completed(status));
    assert.ok(built.ok);
    assert.equal(built.record.cgMetadata, null);
  }
});

test("unaligned or legacy naming cannot invent trusted CG metadata", async () => {
  const result = await completed();
  const location = result.location;
  assert.ok(location && "requested" in location);
  const built = buildPublicationRecord({ ...result, location: { ...location,
    requested: { latitude: 0, longitude: 0 } } });
  assert.ok(built.ok);
  assert.equal(built.record.cgMetadata, null);
});

test("storage round-trip retains JSONB metadata and accepts missing/null legacy metadata", async () => {
  const built = buildPublicationRecord(await completed());
  assert.ok(built.ok);
  let row: Record<string, unknown> = {};
  const store = createSupabaseLedger({ url: "https://fixture.supabase.co", serviceRoleKey: "fixture" },
    (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") {
        row = JSON.parse(String(init.body));
        assert.deepEqual(row.cg_metadata, built.record.cgMetadata);
        return Response.json([row]);
      }
      assert.ok(new URL(String(input)).searchParams.get("select")?.includes("cg_metadata"));
      return Response.json([row]);
    }) as typeof fetch);
  const result = await completed();
  assert.ok(result.message?.ok);
  assert.equal(await store.insertPublicationRecord(built.record, result.message.text), "inserted");
  assert.deepEqual((await store.loadRelevantPublicationHistory(built.record))[0].cgMetadata, built.record.cgMetadata);
  for (const value of [null, undefined, { version: "future" }, { bad: "metadata" }]) {
    row.cg_metadata = value;
    assert.equal((await store.loadRelevantPublicationHistory(built.record))[0].cgMetadata, undefined);
  }
});

test("metadata parsing tolerates JSONB key reordering and rejects tampered derived values", async () => {
  const built = buildPublicationRecord(await completed());
  assert.ok(built.ok && built.record.cgMetadata);
  const metadata = built.record.cgMetadata;
  const reordered = JSON.parse(JSON.stringify(metadata, (_, value) =>
    value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).reverse()) : value));
  assert.deepEqual(parseCgPublicationMetadata(reordered), metadata);
  assert.equal(parseCgPublicationMetadata({ ...metadata,
    classification: { classification: "rural", evidence: [] } }), null);
  assert.equal(parseCgPublicationMetadata({ ...metadata, latitude: 91 }), null);
});

test("stored village provenance survives a town parent and metadata round-trip", () => {
  const payload = { address: { village: "Yenipeçenek", town: "Sincan", province: "Ankara", country: "Türkiye" } };
  const metadata = buildCgPublicationMetadata({ id: "cg-village", type: "cg", latitude: 40, longitude: 32,
    eventTimeMs: Date.parse("2026-10-11T10:00:00Z") }, normalizeAndLabel(payload),
    extractProviderAddressHierarchy(payload), { latitude: 40, longitude: 32 });
  assert.ok(metadata);
  assert.equal(metadata.location.localityKind, "town");
  assert.equal(metadata.providerAddress?.village, "Yenipeçenek");
  assert.equal(metadata.classification.classification, "rural");
  assert.equal(metadata.semanticIdentity.available, true);
  assert.deepEqual(parseCgPublicationMetadata(JSON.parse(JSON.stringify(metadata))), metadata);
});
