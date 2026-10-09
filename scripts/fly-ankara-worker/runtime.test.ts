import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { DEFAULT_THRESHOLDS } from "../lightning-cg-enrichment/match.ts";
import type { EnrichmentReference, EnrichmentResult } from "../lightning-cg-enrichment/types.ts";
import { createSupabaseLedger, type LedgerStore } from "../lightning-publication-ledger/storage/supabase.ts";
import type { PublicationRecord } from "../lightning-publication-ledger/types.ts";
import { ANKARA_MONITORING_AREA, pointInMonitoringArea } from "../lightning-incident-lifecycle/monitoring-area.ts";
import type { ReverseGeocodeResult } from "../lightning-location-naming/types.ts";
import type { LightningEvent } from "../live-lightning-listener/core.ts";
import { AnkaraFlyPipeline, validateFlyPipelineEnvironment } from "./runtime.ts";

const baseNow = Date.parse("2026-10-09T12:00:00.000Z");

function memoryStore(seed: PublicationRecord[] = []) {
  const records = [...seed];
  let reads = 0;
  let writes = 0;
  const store: LedgerStore = {
    async loadRelevantPublicationHistory() { reads++; return [...records]; },
    async insertPublicationRecord(record, exactMessageText) {
      writes++;
      assert.ok(exactMessageText.length > 0);
      if (records.some(prior => prior.publicationId === record.publicationId)) return "already_present";
      records.push(record);
      return "inserted";
    },
  };
  return { store, records, get reads() { return reads; }, get writes() { return writes; } };
}

function verifiedCg(reference: EnrichmentReference): EnrichmentResult {
  return {
    status: "cg_verified", provider: "xweather", reference, thresholds: { ...DEFAULT_THRESHOLDS },
    counts: { returned: 1, matched: 1, matchedCg: 1, matchedIc: 0 },
    match: { id: "xw-event-1", type: "cg", latitude: 39.9, longitude: 32.6, eventTimeMs: reference.eventTimeMs,
      distanceKm: 0, timeDifferenceMs: 0 },
  };
}

function setup(options: {
  now?: () => number;
  store?: LedgerStore;
  enrich?: (reference: EnrichmentReference) => Promise<EnrichmentResult>;
  reverse?: (latitude: number, longitude: number) => Promise<ReverseGeocodeResult>;
} = {}) {
  const events: Array<{ kind: string; fields?: Record<string, unknown> }> = [];
  const memory = memoryStore();
  const runtime = new AnkaraFlyPipeline({
    store: options.store ?? memory.store,
    now: options.now ?? (() => baseNow),
    emit: (kind, fields) => events.push({ kind, fields }),
    enrich: options.enrich ?? (async reference => verifiedCg(reference)),
    reverse: options.reverse ?? (async (latitude, longitude) => ({
      latitude, longitude, provider: "fixture", displayLabel: "Çankaya, Ankara", locality: "Çankaya", district: "Çankaya",
      province: "Ankara", country: "Türkiye",
    })),
    clusterParameters: { maxSpatialDistanceKm: 1, maxTemporalGapMinutes: 10,
      freshnessWindowMinutes: 10, clusterCloseAfterMinutes: 15 },
  });
  runtime.markConnecting(baseNow - 1000);
  runtime.recordFrame(baseNow);
  return { runtime, events, memory };
}

function event(index: number, overrides: Partial<LightningEvent> = {}): LightningEvent {
  return {
    source: "lightningmaps-live2", eventTimeMs: baseNow - 1000 + index,
    receivedAtMs: baseNow, latitude: 39.9, longitude: 32.6 + index * 0.04,
    sourceEventKey: `1/${index + 1}`, dischargeType: "unknown", ...overrides,
  };
}

function qualifyingEvents(runtime: AnkaraFlyPipeline, time = baseNow): void {
  for (let index = 0; index < 3; index++) runtime.acceptEvent(event(index, {
    eventTimeMs: time - 1000 + index,
    receivedAtMs: baseNow,
    latitude: 39.9,
    longitude: 32.6,
  }), baseNow);
}

test("only unique events inside the Ankara polygon feed the lifecycle", () => {
  const { runtime } = setup();
  const insideBoundsOutsidePolygon = event(1, { latitude: 40.5, longitude: 31.0 });
  assert.ok(insideBoundsOutsidePolygon.latitude <= ANKARA_MONITORING_AREA.bounds.north);
  assert.ok(insideBoundsOutsidePolygon.longitude >= ANKARA_MONITORING_AREA.bounds.west);
  assert.equal(pointInMonitoringArea([insideBoundsOutsidePolygon.longitude, insideBoundsOutsidePolygon.latitude]), false);
  runtime.acceptEvent(insideBoundsOutsidePolygon, baseNow);
  runtime.acceptEvent(event(2), baseNow);
  assert.equal(runtime.lifecycle.metrics.clustersObserved, 1);
});

test("non-qualifying individual events never call Xweather or Supabase", async () => {
  let enrichCalls = 0;
  const memory = memoryStore();
  const { runtime } = setup({ store: memory.store, enrich: async reference => { enrichCalls++; return verifiedCg(reference); } });
  runtime.acceptEvent(event(1), baseNow);
  await runtime.drainCandidateWork();
  assert.equal(enrichCalls, 0);
  assert.equal(memory.reads, 0);
  assert.equal(memory.writes, 0);
});

test("fresh WOULD_PUBLISH candidate follows enrichment, existing composer, duplicate check, and pending persistence", async () => {
  let enrichCalls = 0;
  let reverseCalls = 0;
  const memory = memoryStore();
  const { runtime, events } = setup({ store: memory.store,
    enrich: async reference => { enrichCalls++; return verifiedCg(reference); },
    reverse: async (latitude, longitude) => { reverseCalls++; return {
      latitude, longitude, provider: "fixture", displayLabel: "Çankaya, Ankara", locality: "Çankaya",
      district: "Çankaya", province: "Ankara", country: "Türkiye",
    }; },
  });
  qualifyingEvents(runtime);
  await runtime.drainCandidateWork();
  assert.equal(enrichCalls, 1);
  assert.equal(reverseCalls, 1);
  assert.equal(memory.reads, 1);
  assert.equal(memory.records.length, 1);
  assert.equal(memory.records[0].decision, "WOULD_PUBLISH");
  assert.equal(memory.records[0].publicationId.length > 0, true);
  assert.equal(events.some(row => row.kind === "publication_pending" && row.fields?.approvalStatus === "pending"), true);
});

test("closed lifecycle state is retained until asynchronous candidate work completes", async () => {
  let resolveEnrichment!: (value: EnrichmentResult) => void;
  const pendingEnrichment = new Promise<EnrichmentResult>(resolve => { resolveEnrichment = resolve; });
  const { runtime } = setup({ enrich: async () => pendingEnrichment });
  qualifyingEvents(runtime);
  assert.equal(runtime.summary(baseNow).candidateProcessingInFlight, 1);

  const closedAt = baseNow + 20 * 60_000;
  runtime.recordFrame(closedAt);
  runtime.summary(closedAt);
  assert.equal(runtime.lifecycle.incidents[0].status, "closed");
  runtime.recordFrame(closedAt + 21 * 60_000);
  runtime.summary(closedAt + 21 * 60_000);
  assert.equal(runtime.lifecycle.incidents.length, 1);
  assert.equal(runtime.summary(closedAt + 21 * 60_000).candidateProcessingInFlight, 1);

  resolveEnrichment(verifiedCg({ latitude: 39.9, longitude: 32.6, eventTimeMs: baseNow }));
  await runtime.drainCandidateWork();
  assert.equal(runtime.summary(closedAt + 21 * 60_000).candidateProcessingInFlight, 0);
});

test("the existing Supabase adapter writes an actionable Fly candidate as pending", async () => {
  const writes: Array<Record<string, unknown>> = [];
  const store = createSupabaseLedger({ url: "https://fixture.supabase.co", serviceRoleKey: "fixture-only" },
    async (_input, init) => {
      if (init?.method === "POST") writes.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return Response.json(init?.method === "POST" ? [{ publication_id: "inserted" }] : []);
    });
  const { runtime } = setup({ store });
  qualifyingEvents(runtime);
  await runtime.drainCandidateWork();
  assert.equal(writes.length, 1);
  assert.equal(writes[0].approval_status, "pending");
  assert.equal(writes[0].decision, "WOULD_PUBLISH");
  assert.equal(writes[0].platform_post_id, null);
  assert.equal(typeof writes[0].message_text, "string");
});

test("stale WOULD_PUBLISH trigger is rejected before enrichment and persistence", async () => {
  let enrichCalls = 0;
  const memory = memoryStore();
  const { runtime, events } = setup({ store: memory.store,
    enrich: async reference => { enrichCalls++; return verifiedCg(reference); } });
  qualifyingEvents(runtime, baseNow - 5 * 60_000);
  await runtime.drainCandidateWork();
  assert.equal(enrichCalls, 0);
  assert.equal(memory.reads, 0);
  assert.equal(memory.writes, 0);
  assert.equal(events.some(row => row.kind === "candidate_rejected_stale"), true);
});

test("a duplicate represented in persistent history does not create a second pending row", async () => {
  const memory = memoryStore();
  const first = setup({ store: memory.store });
  qualifyingEvents(first.runtime);
  await first.runtime.drainCandidateWork();
  assert.equal(memory.records.length, 1);
  const second = setup({ store: memory.store });
  qualifyingEvents(second.runtime);
  await second.runtime.drainCandidateWork();
  assert.equal(memory.records.filter(record => record.decision === "WOULD_PUBLISH").length, 1);
  assert.equal(memory.records.at(-1)?.decision, "HOLD");
  assert.equal(second.events.some(row => row.kind === "duplicate_detected"), true);
  assert.equal(second.runtime.summary().pendingPublications, 0);
});

test("no usable location label does not persist", async () => {
  const memory = memoryStore();
  const { runtime } = setup({ store: memory.store,
    reverse: async (latitude, longitude) => ({ latitude, longitude, provider: "fixture", displayLabel: null }) });
  qualifyingEvents(runtime);
  await runtime.drainCandidateWork();
  assert.equal(memory.reads, 0);
  assert.equal(memory.writes, 0);
});

test("provider_unavailable follows the existing HOLD policy", async () => {
  const memory = memoryStore();
  const { runtime } = setup({ store: memory.store, enrich: async reference => ({
    status: "provider_unavailable", provider: "xweather", reference, thresholds: { ...DEFAULT_THRESHOLDS }, failure: "network_error",
  }) });
  qualifyingEvents(runtime);
  await runtime.drainCandidateWork();
  assert.equal(memory.records.length, 1);
  assert.equal(memory.records[0].decision, "HOLD");
  assert.equal(runtime.summary().pendingPublications, 0);
});

test("candidate-processing failures are isolated from continuous event intake", async () => {
  const memory = memoryStore();
  const { runtime } = setup({ store: memory.store,
    reverse: async () => { throw new Error("fixture reverse-geocoder failure"); } });
  qualifyingEvents(runtime);
  await runtime.drainCandidateWork();
  assert.doesNotThrow(() => runtime.acceptEvent(event(9), baseNow));
  assert.equal(runtime.pipeline.counters.unique, 4);
});

test("Fly runtime needs no X publisher credentials or code", async () => {
  validateFlyPipelineEnvironment({ XWEATHER_CLIENT_ID: "id", XWEATHER_CLIENT_SECRET: "secret",
    SUPABASE_URL: "https://example.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "key" });
  const worker = await readFile(new URL("./worker.ts", import.meta.url), "utf8");
  const runtime = await readFile(new URL("./runtime.ts", import.meta.url), "utf8");
  assert.doesNotMatch(worker, /emit\("source_health",\s*\{\s*to:\s*"live"/);
  assert.doesNotMatch(worker, /X_API_KEY|X_ACCESS_TOKEN|api\.x\.com|XPublisher/);
  assert.doesNotMatch(runtime, /X_API_KEY|X_ACCESS_TOKEN|api\.x\.com|XPublisher/);
  assert.match(worker, /frameTimeoutMs\s*=\s*90_000/);
  assert.match(worker, /summaryEveryMs\s*=\s*5\s*\*\s*60_000/);
  assert.match(worker, /backoffMs\(attempt\+\+\)/);
  const dockerfile = await readFile(new URL("../../Dockerfile.fly-ankara-worker", import.meta.url), "utf8");
  for (const directory of ["fly-ankara-worker", "live-lightning-listener", "live-lightning-clustering", "lightning-incident-lifecycle",
    "lightning-cg-paired-validation", "lightning-cg-enrichment", "lightning-location-naming",
    "lightning-message-preview", "lightning-message-composer", "lightning-publish-decision",
    "lightning-end-to-end-dry-run", "lightning-publication-ledger"]) {
    assert.match(dockerfile, new RegExp(`scripts/${directory}/`));
  }
  assert.doesNotMatch(dockerfile, /lightning-x-publisher|COPY scripts\/ \./);
});

test("startup validation names missing Fly pipeline settings without revealing values", () => {
  assert.throws(() => validateFlyPipelineEnvironment({}), error => {
    assert.match(String(error), /XWEATHER_CLIENT_ID/);
    assert.match(String(error), /SUPABASE_SERVICE_ROLE_KEY/);
    assert.doesNotMatch(String(error), /secret-value|token-value/i);
    return true;
  });
});

test("source-health connection transitions remain represented, and out-of-bounds diagnostics do not alter filtering", () => {
  const { runtime, events } = setup();
  runtime.recordFrame(baseNow + 1);
  assert.equal(events.filter(row => row.kind === "source_health" && row.fields?.to === "live").length, 1);
  const before = { ...runtime.pipeline.counters };
  const outside = event(20, { latitude: 41.5, longitude: 34.2 });
  const accepted = runtime.acceptEvent(outside, baseNow);
  assert.equal(accepted.insideSubscriptionBox, false);
  assert.equal(runtime.pipeline.counters.outsideSubscriptionBox, before.outsideSubscriptionBox + 1);
  const diagnostic = events.find(row => row.kind === "out_of_bounds_event");
  assert.equal(diagnostic?.fields?.insideSubscriptionBounds, false);
  assert.equal(typeof diagnostic?.fields?.approximateDistanceToSubscriptionBoundsKm, "number");
  runtime.recordDisconnected(baseNow + 1);
  assert.equal(runtime.sourceHealth.state.state, "disconnected");
  assert.equal(runtime.sourceHealth.interruptions, 1);
});
