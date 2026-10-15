import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { DEFAULT_THRESHOLDS, greatCircleDistanceKm } from "../lightning-cg-enrichment/match.ts";
import type { EnrichmentReference, EnrichmentResult } from "../lightning-cg-enrichment/types.ts";
import { createSupabaseLedger, type LedgerStore } from "../lightning-publication-ledger/storage/supabase.ts";
import type { PublicationRecord } from "../lightning-publication-ledger/types.ts";
import type { ApprovalCandidate } from "../lightning-publication-ledger/approval.ts";
import { ANKARA_MONITORING_AREA, pointInMonitoringArea } from "../lightning-incident-lifecycle/monitoring-area.ts";
import type { ReverseGeocodeResult } from "../lightning-location-naming/types.ts";
import { extractProviderAddressHierarchy, makeDisplayLabel, normalizeNominatimAddress } from "../lightning-location-naming/normalize.ts";
import type { LightningEvent } from "../live-lightning-listener/core.ts";
import { createPendingPublicationNotifier, type PendingPublicationNotifier } from "../lightning-telegram-notifier/pending.ts";
import { AnkaraFlyPipeline, validateFlyPipelineEnvironment } from "./runtime.ts";
import { createFlyAutoPublish, type FlyAutoPublish } from "./auto-publish.ts";
import { matchInitialCgEvents } from "../lightning-cg-enrichment/initial.ts";

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
  notifyPending?: PendingPublicationNotifier;
  notifyAutoPublishFailure?: (failure: { publicationId: string; httpStatus?: number }) => Promise<{ ok: true } | {
    ok: false; reason: "timeout" | "network_error" | "http_error" | "invalid_response"; httpStatus?: number }>;
  autoPublish?: FlyAutoPublish;
  schedule?: (delayMs: number, callback: () => void) => unknown;
} = {}) {
  const events: Array<{ kind: string; fields?: Record<string, unknown> }> = [];
  const memory = memoryStore();
  let currentNow = baseNow;
  const now = options.now ?? (() => currentNow);
  const startedAt = now();
  const runtime = new AnkaraFlyPipeline({
    store: options.store ?? memory.store,
    now,
    emit: (kind, fields) => events.push({ kind, fields }),
    enrich: options.enrich ?? (async reference => verifiedCg(reference)),
    notifyPending: options.notifyPending,
    notifyAutoPublishFailure: options.notifyAutoPublishFailure,
    autoPublish: options.autoPublish,
    schedule: options.schedule,
    reverse: options.reverse ?? (async (latitude, longitude) => ({
      latitude, longitude, provider: "fixture", displayLabel: "Çankaya, Ankara", locality: "Çankaya", district: "Çankaya",
      province: "Ankara", country: "Türkiye",
    })),
    clusterParameters: { maxSpatialDistanceKm: 1, maxTemporalGapMinutes: 10,
      freshnessWindowMinutes: 10, clusterCloseAfterMinutes: 15 },
  });
  runtime.markConnecting(startedAt - 1000);
  runtime.recordFrame(startedAt);
  return { runtime, events, memory, setNow(value: number) { currentNow = value; } };
}

function event(index: number, overrides: Partial<LightningEvent> = {}): LightningEvent {
  return {
    source: "lightningmaps-live2", eventTimeMs: baseNow - 1000 + index,
    receivedAtMs: baseNow, latitude: 39.9, longitude: 32.6 + index * 0.04,
    sourceEventKey: `1/${index + 1}`, dischargeType: "unknown", ...overrides,
  };
}

function qualifyingEvents(runtime: AnkaraFlyPipeline, time = baseNow, processingTimeMs = baseNow): void {
  for (let index = 0; index < 3; index++) runtime.acceptEvent(event(index, {
    eventTimeMs: time - 1000 + index,
    receivedAtMs: processingTimeMs,
    latitude: 39.9,
    longitude: 32.6,
  }), processingTimeMs);
}

function feedSparseEvent(runtime: AnkaraFlyPipeline, index: number, latitude: number, longitude: number,
  eventTimeMs: number, processingTimeMs = baseNow): void {
  runtime.acceptEvent(event(index, { latitude, longitude, eventTimeMs, receivedAtMs: processingTimeMs }), processingTimeMs);
}

function primaryPairWithNeighbor(runtime: AnkaraFlyPipeline, neighborLongitude = 32.0): void {
  feedSparseEvent(runtime, 100, 40.1437, 31.9162, baseNow - 2_000);
  feedSparseEvent(runtime, 101, 40.1447, 31.9162, baseNow - 1_000);
  feedSparseEvent(runtime, 102, 40.1437, neighborLongitude, baseNow - 500);
}

async function processOuterDistrictCandidate(memory: ReturnType<typeof memoryStore>, at: number,
  district: string, options: { province?: string; locality?: string; localityKind?: ReverseGeocodeResult["localityKind"];
    neighborhood?: string; cg?: boolean; missingDistrict?: boolean; notifyPending?: PendingPublicationNotifier;
    autoPublish?: FlyAutoPublish; schedule?: (delayMs: number, callback: () => void) => unknown } = {}) {
  const current = at;
  const locality = options.missingDistrict ? district : options.locality ?? "Yamak";
  const reverse = async (latitude: number, longitude: number): Promise<ReverseGeocodeResult> => ({
    latitude, longitude, provider: "fixture",
    displayLabel: options.missingDistrict ? (options.neighborhood ? `${options.neighborhood}, ${district}` :
      `${district}, ${options.province ?? "Ankara"}`) : `${locality}, ${district}`,
    locality,
    ...(options.localityKind ? { localityKind: options.localityKind } : {}),
    ...(options.neighborhood ? { neighborhood: options.neighborhood } : {}),
    ...(options.missingDistrict ? {} : { district }), province: options.province ?? "Ankara", country: "Türkiye",
  });
  const fixture = setup({ store: memory.store, now: () => current, reverse,
    notifyPending: options.notifyPending, autoPublish: options.autoPublish,
    schedule: options.schedule,
    enrich: async reference => options.cg ? verifiedCg(reference) : matchInitialCgEvents(reference, [], current) });
  qualifyingEvents(fixture.runtime, at, at);
  await fixture.runtime.drainCandidateWork();
  return fixture;
}

async function evaluateFirstCgShadowFixture(staleAtEvaluation = false, earlierPublicationAvailable = true) {
  let current = baseNow;
  const calls = { enrichment: 0, reverse: 0, historyReads: 0, writes: 0,
    notifications: 0, approvalReads: 0, approvalTransitions: 0, dispatches: 0 };
  const records: PublicationRecord[] = [];
  const approvalRows = new Map<string, ApprovalCandidate>();
  const candidate = (record: PublicationRecord, messageText: string,
    approvalStatus: ApprovalCandidate["approvalStatus"]): ApprovalCandidate => ({
      publicationId: record.publicationId, decision: record.decision, platformPostId: null,
      approvalStatus, messageFingerprint: record.messageFingerprint, messageText, mapUrl: record.mapUrl,
    });
  const store: LedgerStore = {
    async loadRelevantPublicationHistory() {
      calls.historyReads++;
      if (staleAtEvaluation && calls.historyReads === 2) current = baseNow + 6 * 60_000;
      return [];
    },
    async insertPublicationRecord(record, messageText) {
      calls.writes++;
      records.push(record);
      approvalRows.set(record.publicationId, candidate(record, messageText,
        record.decision === "WOULD_PUBLISH" ? "pending" : null));
      return "inserted";
    },
    async admitCgPublication(_record, _messageText, request) {
      assert.equal(request.kind, "repeat");
      return { outcome: "suppressed", reason: "no_positive_cg_history" };
    },
  };
  const autoPublish: FlyAutoPublish = {
    approvalStore: {
      async getPublicationForApproval(publicationId) {
        calls.approvalReads++;
        return approvalRows.get(publicationId) ?? null;
      },
      async transitionPendingApproval(publicationId, status) {
        calls.approvalTransitions++;
        const previous = approvalRows.get(publicationId);
        if (!previous) return null;
        const updated = { ...previous, approvalStatus: status };
        approvalRows.set(publicationId, updated);
        return updated;
      },
    },
    async dispatchPublisher() {
      calls.dispatches++;
      return { ok: true, httpStatus: 204 };
    },
  };
  const fixture = setup({
    store, autoPublish, now: () => current,
    notifyPending: async () => { calls.notifications++; return { ok: true }; },
    enrich: async reference => {
      calls.enrichment++;
      if (calls.enrichment === 1) return earlierPublicationAvailable
        ? { status: "no_match", provider: "xweather", reference,
            thresholds: { ...DEFAULT_THRESHOLDS }, counts: { returned: 0, matched: 0, matchedCg: 0, matchedIc: 0 } }
        : { status: "provider_unavailable", provider: "xweather", reference,
            thresholds: { ...DEFAULT_THRESHOLDS }, failure: "network_error" };
      const selected = verifiedCg(reference);
      return { ...selected, match: { ...selected.match!, latitude: 39.95,
        longitude: 32.65, eventTimeMs: reference.eventTimeMs } };
    },
    reverse: async (latitude, longitude) => {
      calls.reverse++;
      const payload = { address: { neighbourhood: "Aşağı Ayrancı", town: "Çankaya", county: "Çankaya",
        state: "Ankara", country: "Türkiye" } };
      const normalized = normalizeNominatimAddress(payload);
      return { latitude, longitude, provider: "fixture", ...normalized,
        displayLabel: makeDisplayLabel(normalized), providerAddress: extractProviderAddressHierarchy(payload) };
    },
  });
  qualifyingEvents(fixture.runtime);
  await fixture.runtime.drainCandidateWork();
  assert.equal(records.length, 1, earlierPublicationAvailable
    ? "the earlier non-CG candidate is the only persisted record"
    : "the initial HOLD record is the only persisted record");

  const incident = fixture.runtime.lifecycle.incidents.find(value => value.status === "active");
  assert.ok(incident);
  const internals = fixture.runtime as unknown as {
    repeatReadyAtMs: number;
    processRepeatProbe(probe: {
      incident: (typeof fixture.runtime.lifecycle.incidents)[number];
      observation: { sourceClusterId: string; eventTimeMs: number; receivedAtMs: number; latitude: number; longitude: number };
      reason: "already_published_active_incident";
    }): Promise<void>;
  };
  current = baseNow + 3 * 60_000;
  fixture.runtime.recordFrame(current);
  internals.repeatReadyAtMs = current;
  await internals.processRepeatProbe({
    incident,
    observation: { sourceClusterId: incident.sourceClusterIds[0], eventTimeMs: baseNow + 60_000,
      receivedAtMs: current, latitude: incident.representativeLatitude, longitude: incident.representativeLongitude },
    reason: "already_published_active_incident",
  });
  return { ...fixture, calls, records };
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

test("worker summaries omit event arrays without altering clustering snapshots", () => {
  const { runtime } = setup(); qualifyingEvents(runtime);
  const summary = runtime.summary();
  assert.ok(summary.clusters.length > 0);
  assert.equal(JSON.stringify(summary).includes("recentEvents"), false);
  assert.equal(summary.clusters[0].eventCount, 3);
  assert.equal(runtime.pipeline.clusterer.clusters[0].recentEvents.length, 3);
  assert.equal(summary.cgRepeat.queued, 0);
  assert.equal(JSON.stringify(summary.stormEvolution).includes("recentEvents"), false);
  assert.equal(summary.rollingCandidateShadow.productionAndRollingBothPromoted, 1);
  assert.equal(summary.rollingCandidateShadow.rollingShadowPromotions, 0);
});

test("neighbor-supported two-event candidate emits one shadow opportunity without production side effects", () => {
  let providerCalls = 0; let notifications = 0;
  const { runtime, events, memory } = setup({
    enrich: async reference => { providerCalls++; return matchInitialCgEvents(reference, [], baseNow); },
    notifyPending: async () => { notifications++; return { ok: true }; },
  });
  primaryPairWithNeighbor(runtime);
  const opportunities = events.filter(row => row.kind === "neighbor_supported_sparse_activity");
  assert.equal(opportunities.length, 1);
  const fields = opportunities[0].fields!;
  assert.equal(fields.primaryEventCount, 2);
  assert.ok(fields.incidentId);
  assert.ok(Array.isArray(fields.primaryClusterIds));
  assert.ok((fields.neighborClusterIds as string[]).length > 0);
  assert.equal(fields.neighborFreshEventCount, 1);
  assert.ok((fields.nearestNeighborDistanceKm as number) > 1 &&
    (fields.nearestNeighborDistanceKm as number) < 15);
  assert.equal(fields.nearestNeighborTimeDeltaSeconds, .5);
  assert.equal(fields.sourceHealthy, true);
  assert.equal(fields.promotionThreshold, 3);
  assert.equal(fields.spatialWindowKm, 15);
  assert.equal(fields.temporalWindowMinutes, 10);
  assert.equal(fields.shadowOnly, true);
  assert.equal(runtime.summary().profile.promotionMinEvents, 3);
  assert.equal(runtime.lifecycle.snapshot().activeIncidents, 0);
  assert.equal(runtime.lifecycle.snapshot().incidents.find(item => item.id === fields.incidentId)?.totalEvents, 2,
    "neighbor events do not become candidate events");
  assert.equal(providerCalls, 0, "the opportunity itself does not trigger enrichment");
  assert.equal(memory.records.length, 0);
  assert.equal(memory.writes, 0);
  assert.equal(notifications, 0);
  assert.deepEqual(runtime.summary().neighborSupportedSparseActivity, { opportunities: 1, promoted: 0, expired: 0 });
  // Rechecking an unchanged candidate state does not repeat the event.
  runtime.summary();
  assert.equal(events.filter(row => row.kind === "neighbor_supported_sparse_activity").length, 1);
});

test("only separate fresh neighboring events inside both sparse windows qualify", () => {
  const isolated = setup();
  feedSparseEvent(isolated.runtime, 110, 40.1437, 31.9162, baseNow - 2_000);
  feedSparseEvent(isolated.runtime, 111, 40.1447, 31.9162, baseNow - 1_000);
  assert.equal(isolated.events.some(row => row.kind === "neighbor_supported_sparse_activity"), false);

  for (const neighbor of [
    { name: "stale", longitude: 32.0, time: baseNow - 11 * 60_000 },
    { name: "future", longitude: 32.0, time: baseNow + 1 },
    { name: "distant", longitude: 32.11, time: baseNow - 500 },
  ]) {
    const fixture = setup();
    feedSparseEvent(fixture.runtime, 120, 40.1437, 31.9162, baseNow - 2_000);
    feedSparseEvent(fixture.runtime, 121, 40.1447, 31.9162, baseNow - 1_000);
    feedSparseEvent(fixture.runtime, 122, 40.1437, neighbor.longitude, neighbor.time);
    assert.equal(fixture.events.some(row => row.kind === "neighbor_supported_sparse_activity"), false, neighbor.name);
  }

  const sameCluster = setup({ enrich: async reference => matchInitialCgEvents(reference, [], baseNow) });
  feedSparseEvent(sameCluster.runtime, 130, 40.1437, 31.9162, baseNow - 2_000);
  feedSparseEvent(sameCluster.runtime, 131, 40.1447, 31.9162, baseNow - 1_000);
  feedSparseEvent(sameCluster.runtime, 132, 40.1437, 31.9172, baseNow - 500);
  assert.equal(sameCluster.events.some(row => row.kind === "neighbor_supported_sparse_activity"), false,
    "same-cluster events remain primary evidence and are never recounted as neighbors");
  assert.equal(sameCluster.runtime.lifecycle.snapshot().activeIncidents, 1,
    "normal three-event promotion remains unchanged");
});

test("sparse opportunity correlates later normal promotion and its existing provider result", async () => {
  let enrichmentCalls = 0;
  const fixture = setup({ enrich: async reference => {
    enrichmentCalls++;
    return matchInitialCgEvents(reference, [], baseNow);
  } });
  primaryPairWithNeighbor(fixture.runtime);
  assert.equal(enrichmentCalls, 0);

  const promotionAt = baseNow + 120_000;
  fixture.setNow(promotionAt); fixture.runtime.recordFrame(promotionAt);
  feedSparseEvent(fixture.runtime, 103, 40.1437, 31.9162, promotionAt, promotionAt);
  await fixture.runtime.drainCandidateWork();

  const outcome = fixture.events.find(row => row.kind === "neighbor_supported_sparse_outcome")?.fields;
  assert.equal(outcome?.outcome, "promoted_normally");
  assert.equal(outcome?.normalPromotionDelaySeconds, 120);
  assert.equal(outcome?.resultingIncidentId, outcome?.incidentId);
  const normalResult = fixture.events.find(row => row.kind === "neighbor_supported_sparse_normal_result")?.fields;
  assert.equal(normalResult?.eventualProviderStatus, "no_match");
  assert.equal(normalResult?.publicationDecision, "WOULD_PUBLISH");
  assert.equal(enrichmentCalls, 1, "only the normal promoted-candidate enrichment ran");
  assert.equal(fixture.memory.records.length, 1, "only the unchanged normal publication flow wrote a record");
  assert.deepEqual(fixture.runtime.summary().neighborSupportedSparseActivity,
    { opportunities: 1, promoted: 1, expired: 0 });
});

test("sparse normal result retains provider outcome when outer-district policy suppresses publication", async () => {
  let enrichmentCalls = 0; let notifications = 0; let approvals = 0; let dispatches = 0;
  const fixture = setup({
    enrich: async reference => {
      enrichmentCalls++;
      return matchInitialCgEvents(reference, [], baseNow);
    },
    reverse: async (latitude, longitude) => ({ latitude, longitude, provider: "fixture",
      displayLabel: "Beypazarı, Ankara", locality: "Beypazarı", localityKind: "town",
      district: "Beypazarı", province: "Ankara", country: "Türkiye" }),
    notifyPending: async () => { notifications++; return { ok: true }; },
    autoPublish: {
      approvalStore: {
        async getPublicationForApproval() { approvals++; return null; },
        async transitionPendingApproval() { approvals++; return null; },
      },
      dispatchPublisher: async () => { dispatches++; return { ok: true, httpStatus: 204 }; },
    },
  });
  primaryPairWithNeighbor(fixture.runtime);
  const opportunity = fixture.events.find(row => row.kind === "neighbor_supported_sparse_activity")?.fields;
  assert.ok(opportunity?.incidentId);

  const promotionAt = baseNow + 120_000;
  fixture.setNow(promotionAt); fixture.runtime.recordFrame(promotionAt);
  feedSparseEvent(fixture.runtime, 103, 40.1437, 31.9162, promotionAt, promotionAt);
  await fixture.runtime.drainCandidateWork();

  const sparseResults = fixture.events.filter(row => row.kind === "neighbor_supported_sparse_normal_result");
  assert.equal(sparseResults.length, 1);
  const normalResult = sparseResults[0].fields!;
  assert.equal(normalResult.incidentId, opportunity.incidentId);
  assert.equal(normalResult.eventualProviderStatus, "no_match");
  assert.equal(normalResult.rawProviderStatus, "no_match");
  assert.equal(normalResult.normalPromotionDelaySeconds, 120);
  assert.equal(normalResult.publicationDecision, "WOULD_PUBLISH", "retains the pre-policy decision separately");
  assert.equal(normalResult.productionOutcome, "HOLD");
  assert.equal(normalResult.suppressionReason, "outer_district_non_cg_suppressed");
  assert.equal(normalResult.publicationRecordId, null);
  assert.equal(fixture.events.some(row => row.kind === "outer_district_non_cg_suppressed" &&
    row.fields?.canonicalDistrict === "Beypazarı"), true);
  assert.equal(fixture.events.some(row => row.kind === "candidate_outcome" &&
    row.fields?.decision === "HOLD" && row.fields?.reason === "outer_district_non_cg_suppressed"), true);
  assert.equal(enrichmentCalls, 1, "only normal promoted-candidate enrichment ran");
  assert.equal(fixture.runtime.summary().profile.promotionMinEvents, 3);
  assert.equal(fixture.memory.records.length, 0);
  assert.equal(fixture.memory.writes, 0);
  assert.equal(notifications, 0);
  assert.equal(approvals, 0);
  assert.equal(dispatches, 0);
});

test("sparse opportunity reports normal candidate expiry without triggering enrichment", () => {
  let providerCalls = 0;
  const fixture = setup({ enrich: async reference => {
    providerCalls++;
    return matchInitialCgEvents(reference, [], baseNow);
  } });
  primaryPairWithNeighbor(fixture.runtime);
  for (let minute = 1; minute <= 10; minute++) {
    const at = baseNow + minute * 60_000;
    fixture.setNow(at); fixture.runtime.recordFrame(at); fixture.runtime.summary(at);
  }
  const outcome = fixture.events.find(row => row.kind === "neighbor_supported_sparse_outcome")?.fields;
  assert.equal(outcome?.outcome, "expired_without_promotion");
  assert.equal(outcome?.expiredWithoutPromotion, true);
  assert.ok(fixture.events.some(row => row.kind === "candidate_expired" &&
    row.fields?.incidentId === outcome?.incidentId), "the candidate still expires through its normal lifecycle");
  assert.equal(providerCalls, 0);
  assert.equal(fixture.memory.records.length, 0);
  assert.deepEqual(fixture.runtime.summary().neighborSupportedSparseActivity,
    { opportunities: 1, promoted: 0, expired: 1 });
});

test("sparse opportunity state remains isolated between candidate incidents", () => {
  const fixture = setup();
  primaryPairWithNeighbor(fixture.runtime);
  feedSparseEvent(fixture.runtime, 140, 40.1437, 32.65, baseNow - 2_000);
  feedSparseEvent(fixture.runtime, 141, 40.1447, 32.65, baseNow - 1_000);
  const opportunities = fixture.events.filter(row => row.kind === "neighbor_supported_sparse_activity");
  assert.equal(opportunities.length, 1);
  assert.equal(fixture.runtime.lifecycle.snapshot().candidates, 3);
  assert.equal(fixture.runtime.summary().neighborSupportedSparseActivity.opportunities, 1);
});

test("published active incident's new supported neighborhood is shadow-only", async () => {
  let lookupCalls = 0; let notifications = 0;
  const { runtime, memory, events } = setup({
    enrich: async reference => ({ status: "no_match", provider: "xweather", reference,
      thresholds: DEFAULT_THRESHOLDS, counts: { returned: 0, matched: 0, matchedCg: 0, matchedIc: 0 } }),
    notifyPending: async () => { notifications++; return { ok: true }; },
    reverse: async (latitude, longitude) => {
      lookupCalls++;
      const payload = { address: { neighbourhood: longitude > 32.64 ? "Törekent" : "Etiler",
        city: "Ankara", county: longitude > 32.64 ? "Sincan" : "Etimesgut",
        state: "Ankara", country: "Türkiye" } };
      const normalized = normalizeNominatimAddress(payload);
      return { ...normalized, latitude, longitude, provider: "fixture",
        displayLabel: makeDisplayLabel(normalized), providerAddress: extractProviderAddressHierarchy(payload) };
    },
  });
  qualifyingEvents(runtime);
  await runtime.drainCandidateWork();
  assert.equal(memory.records.length, 1);
  runtime.acceptEvent(event(50, { latitude: 39.9, longitude: 32.6 }), baseNow);
  runtime.acceptEvent(event(51, { latitude: 39.9, longitude: 32.67 }), baseNow);
  runtime.acceptEvent(event(52, { latitude: 39.9001, longitude: 32.67 }), baseNow);
  await runtime.drainCandidateWork();
  const candidate = events.find(row => row.kind === "storm_evolution_shadow" && row.fields?.eligible === true);
  assert.ok(candidate);
  assert.equal((candidate.fields?.newlySupportedLocations as string[]).length, 1);
  assert.equal(memory.records.length, 1);
  assert.equal(notifications, 1);
  assert.equal(lookupCalls, 2, "one normal naming call and one bounded shadow lookup");
  assert.equal(runtime.summary().stormEvolution.stormEvolutionEligible, 1);
  assert.equal(JSON.stringify(runtime.summary()).includes("recentEvents"), false);
});

test("worker recovers an expired continuing cluster through the unchanged initial publication path", async () => {
  let clock = baseNow; let sequence = 0; let enrichmentCalls = 0;
  const { runtime, memory, events } = setup({ now: () => clock, enrich: async reference => {
    enrichmentCalls++;
    return { status: "no_match", provider: "xweather", reference, thresholds: DEFAULT_THRESHOLDS };
  } });
  function feed(at: number) {
    clock = baseNow + at * 60_000; runtime.recordFrame(clock);
    runtime.acceptEvent(event(++sequence, { sourceEventKey: `recovery/${sequence}`, latitude: 39.9, longitude: 32.6,
      eventTimeMs: clock, receivedAtMs: clock }), clock);
  }
  feed(0); feed(9); clock = baseNow + 10 * 60_000; runtime.recordFrame(clock); runtime.summary();
  assert.equal(runtime.summary().recall.candidatesExpired, 1);
  assert.equal(memory.records.length, 0);
  feed(12); feed(14); await runtime.drainCandidateWork(); feed(15); await runtime.drainCandidateWork();
  assert.equal(memory.records.filter(row => row.decision === "WOULD_PUBLISH").length, 1);
  assert.equal(events.filter(row => row.kind === "candidate_promoted_after_recovery").length, 1);
  assert.equal(events.filter(row => row.kind === "candidate_recovered").length, 1);
  assert.equal(events.filter(row => row.kind === "rolling_candidate_shadow_promotion").length, 0,
    "production recovery is agreement, not a missed-production shadow promotion");
  assert.equal(runtime.summary().recall.eventsAfterCandidateExpiry, 2);
  assert.equal(runtime.summary().recall.promotionsAfterRecovery, 1);
  assert.equal(runtime.summary().rollingCandidateShadow.productionAndRollingBothPromoted, 1);
  assert.equal(runtime.summary().rollingCandidateShadow.rollingShadowPromotions, 0);
  assert.equal(enrichmentCalls, 1, "the shadow adds no query beyond normal recovered promotion enrichment");
  assert.equal(runtime.summary().profile.promotionMinEvents, 3);
});

test("rolling candidate shadow observes viable expiry without provider or publication side effects", async () => {
  let clock = baseNow; let sequence = 0; let providerCalls = 0; let notifications = 0;
  let approvals = 0; let dispatches = 0;
  const { runtime, memory, events } = setup({ now: () => clock,
    enrich: async reference => { providerCalls++; return verifiedCg(reference); },
    notifyPending: async () => { notifications++; return { ok: true }; },
    autoPublish: {
      approvalStore: {
        async getPublicationForApproval() { approvals++; return null; },
        async transitionPendingApproval() { approvals++; return null; },
      },
      dispatchPublisher: async () => { dispatches++; return { ok: true, httpStatus: 204 }; },
    } });
  function feed(atMinutes: number) {
    clock = baseNow + atMinutes * 60_000; runtime.recordFrame(clock);
    runtime.acceptEvent(event(++sequence, { sourceEventKey: `rolling/${sequence}`,
      latitude: 39.9, longitude: 32.6, eventTimeMs: clock, receivedAtMs: clock }), clock);
  }
  feed(0); feed(4);
  clock = baseNow + 10 * 60_000; runtime.recordFrame(clock); runtime.summary(clock);
  await runtime.drainCandidateWork();

  const stateEvents = events.filter(row => row.kind === "rolling_candidate_shadow_state");
  assert.equal(stateEvents.length, 1);
  assert.equal(stateEvents[0].fields?.rollingEventCount, 2);
  assert.equal(stateEvents[0].fields?.productionState, "candidate_expired");
  assert.equal(stateEvents[0].fields?.shadowOnly, true);
  assert.equal(events.filter(row => row.kind === "rolling_candidate_shadow_promotion").length, 0);
  assert.deepEqual(runtime.summary(clock).rollingCandidateShadow, {
    rollingCandidateEvaluations: 2,
    productionExpiredWhileRollingViable: 1,
    rollingShadowPromotions: 0,
    rollingShadowPromotionsAfterProductionExpiry: 0,
    productionAndRollingBothPromoted: 0,
  });
  assert.equal(providerCalls, 0);
  assert.equal(memory.reads, 0);
  assert.equal(memory.writes, 0);
  assert.equal(notifications, 0);
  assert.equal(approvals, 0);
  assert.equal(dispatches, 0);
});

test("stale, future and duplicate feed observations do not advance rolling shadow state", () => {
  const { runtime } = setup();
  runtime.acceptEvent(event(400, { sourceEventKey: "rolling/stale", latitude: 39.9, longitude: 32.6,
    eventTimeMs: baseNow - 11 * 60_000, receivedAtMs: baseNow }), baseNow);
  runtime.acceptEvent(event(401, { sourceEventKey: "rolling/future", latitude: 39.9, longitude: 32.6,
    eventTimeMs: baseNow + 1, receivedAtMs: baseNow }), baseNow);
  const duplicate = event(402, { sourceEventKey: "rolling/duplicate", latitude: 39.9, longitude: 32.6,
    eventTimeMs: baseNow, receivedAtMs: baseNow });
  runtime.acceptEvent(duplicate, baseNow);
  runtime.acceptEvent(duplicate, baseNow);
  assert.equal(runtime.summary().rollingCandidateShadow.rollingCandidateEvaluations, 1);
  assert.equal(runtime.summary().rollingCandidateShadow.rollingShadowPromotions, 0);
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

test("CG foundation leaves Profile B, active suppression and nearby cooldown unchanged", async () => {
  let clock = baseNow;
  let calls = 0;
  const { runtime, memory } = setup({ now: () => clock,
    enrich: async reference => { calls++; return verifiedCg(reference); } });
  qualifyingEvents(runtime);
  await runtime.drainCandidateWork();
  const expected = { id: "B", name: "moderate", promotionMinEvents: 3, promotionWindowMinutes: 10,
    closeAfterMinutes: 20, activeAssociationDistanceKm: 10, nearbyCooldownDistanceKm: 10, nearbyCooldownMinutes: 20 };
  assert.deepEqual(runtime.summary(clock).profile, expected);
  clock += 5 * 60_000;
  runtime.recordFrame(clock);
  runtime.acceptEvent(event(20, { eventTimeMs: clock, receivedAtMs: clock, longitude: 32.62 }), clock);
  await runtime.drainCandidateWork();
  assert.equal(calls, 1, "active CG activity still cannot get a second enrichment attempt");
  clock += 20 * 60_000;
  runtime.recordFrame(clock);
  assert.equal(runtime.summary(clock).activeIncidents, 0);
  clock += 5 * 60_000;
  runtime.recordFrame(clock);
  for (let index = 30; index < 34; index++) runtime.acceptEvent(event(index, {
    eventTimeMs: clock - 1000 + index, receivedAtMs: clock, longitude: 32.6 }), clock);
  await runtime.drainCandidateWork();
  assert.equal(runtime.summary(clock).activeIncidents, 1);
  assert.equal(calls, 1, "cooldown suppression still cannot reach enrichment");
  assert.equal(memory.records.filter(row => row.decision === "WOULD_PUBLISH").length, 1);
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

test("qualified initial incident publishes a current 9 km CG with provider identity, time, place and map", async () => {
  const selectedTime = baseNow - 90_000;
  const lookupCoordinates: Array<[number, number]> = [];
  const { runtime, memory, events } = setup({
    enrich: async reference => ({ status: "cg_verified", provider: "xweather", reference,
      thresholds: { ...DEFAULT_THRESHOLDS }, counts: { returned: 1, matched: 0, matchedCg: 0, matchedIc: 0 },
      match: { id: "fixture-bayindir-cg", type: "cg", latitude: 39.9, longitude: 32.704,
        eventTimeMs: selectedTime, distanceKm: 0, timeDifferenceMs: 0 } }),
    reverse: async (latitude, longitude) => {
      lookupCoordinates.push([latitude, longitude]);
      return { latitude, longitude, provider: "fixture", displayLabel: "Bayındır, Mamak",
        locality: "Bayındır", district: "Mamak", province: "Ankara", country: "Türkiye" };
    },
  });
  qualifyingEvents(runtime);
  await runtime.drainCandidateWork();
  assert.deepEqual(lookupCoordinates, [[39.9, 32.704]]);
  assert.equal(memory.records.length, 1);
  assert.equal(memory.records[0].enrichmentStatus, "cg_verified");
  assert.equal(memory.records[0].providerEventId, "fixture-bayindir-cg");
  assert.equal(memory.records[0].locationLabel, "Bayındır, Mamak");
  assert.equal(memory.records[0].cgMetadata?.eventTime, new Date(selectedTime).toISOString());
  assert.equal(memory.records[0].cgMetadata?.latitude, 39.9);
  assert.equal(memory.records[0].cgMetadata?.longitude, 32.704);
  assert.equal(memory.records[0].mapUrl, "https://www.google.com/maps?q=39.9,32.704");
  const pending = events.find(row => row.kind === "publication_pending")?.fields?.messageText as string;
  assert.match(pending, /^#YILDIRIM\n9 Ekim 2026, 14:58 TSİ\nBayındır \/ Mamak civarında/);
  assert.ok(pending.endsWith("\n\n39.900, 32.704"));
  const telemetry = events.find(row => row.kind === "enrichment_complete")?.fields;
  assert.equal(telemetry?.category, "accepted");
  assert.equal(telemetry?.providerEventId, "fixture-bayindir-cg");
  assert.equal(telemetry?.selectedLatitude, memory.records[0].cgMetadata?.latitude);
  assert.equal(telemetry?.selectedLongitude, memory.records[0].cgMetadata?.longitude);
  assert.equal(telemetry?.selectedEventTimeMs, selectedTime);
  assert.equal(memory.records[0].mapUrl,
    `https://www.google.com/maps?q=${telemetry?.selectedLatitude},${telemetry?.selectedLongitude}`);
  assert.ok((telemetry?.selectedDistanceKm as number) > 8.5);
  assert.ok((telemetry?.selectedDistanceKm as number) < 9.5);
  assert.ok((telemetry?.referenceTimeDeltaMs as number) < 150_000);
  assert.equal(telemetry?.selectedEventAgeMs, 90_000);
});

test("selected outer-district non-CG candidate is internally processed then suppressed before external side effects", async () => {
  const memory = memoryStore();
  let notifications = 0;
  let approvalReads = 0;
  let dispatches = 0;
  const autoPublish: FlyAutoPublish = {
    approvalStore: {
      async getPublicationForApproval() { approvalReads++; throw new Error("suppressed candidate must not reach approval"); },
      async transitionPendingApproval() { throw new Error("suppressed candidate must not transition approval"); },
    },
    async dispatchPublisher() { dispatches++; return { ok: true, httpStatus: 204 }; },
  };
  const fixture = await processOuterDistrictCandidate(memory, baseNow, "Haymana", {
    notifyPending: async () => { notifications++; return { ok: true }; }, autoPublish,
  });
  const suppression = fixture.events.find(row => row.kind === "outer_district_non_cg_suppressed")?.fields;
  assert.ok(suppression?.incidentId);
  assert.deepEqual({ ...suppression, incidentId: undefined }, {
    incidentId: undefined, district: "Haymana", locality: "Yamak", canonicalDistrict: "Haymana",
    candidateKind: "non_cg", outcome: "suppressed", reason: "outer_district_non_cg_suppressed",
  });
  assert.equal(fixture.events.some(row => row.kind === "enrichment_complete"), true);
  assert.equal(fixture.events.some(row => row.kind === "location_resolved"), true);
  assert.equal(fixture.events.some(row => row.kind === "candidate_outcome" &&
    row.fields?.decision === "HOLD" && row.fields?.reason === "outer_district_non_cg_suppressed"), true);
  assert.equal(memory.records.length, 0);
  assert.equal(memory.writes, 0);
  assert.equal(memory.reads, 0);
  assert.equal(notifications, 0);
  assert.equal(approvalReads, 0);
  assert.equal(dispatches, 0);
  assert.equal(fixture.runtime.summary().outerDistrictNonCgPublication.suppressed, 1);
});

test("town-level Haymana and Nallıhan non-CG candidates stay suppressed without cooldown expiry", async () => {
  const memory = memoryStore();
  const first = await processOuterDistrictCandidate(memory, baseNow, "Haymana", {
    missingDistrict: true, localityKind: "town", neighborhood: "Güzelcekale",
  });
  const firstSuppression = first.events.find(row => row.kind === "outer_district_non_cg_suppressed")?.fields;
  assert.equal(firstSuppression?.canonicalDistrict, "Haymana");
  assert.equal(firstSuppression?.district, null);
  assert.equal(firstSuppression?.locality, "Haymana");
  assert.equal(memory.records.length, 0);

  const laterHaymana = await processOuterDistrictCandidate(memory, baseNow + 5 * 60 * 60_000, "Haymana", {
    missingDistrict: true, localityKind: "town", neighborhood: "Yamak",
  });
  assert.equal(laterHaymana.events.find(row => row.kind === "outer_district_non_cg_suppressed")?.fields?.reason,
    "outer_district_non_cg_suppressed");

  const nallihan = await processOuterDistrictCandidate(memory, baseNow + 6 * 60 * 60_000, "Nallıhan");
  assert.equal(nallihan.events.find(row => row.kind === "outer_district_non_cg_suppressed")?.fields?.canonicalDistrict,
    "Nallıhan");
  assert.equal(memory.records.length, 0, "selected-district non-CG events never create publication records");
});

test("outer-district CG remains eligible after non-CG suppression; central non-CG is unchanged", async () => {
  const memory = memoryStore();
  const nonCg = await processOuterDistrictCandidate(memory, baseNow, "Haymana");
  assert.equal(nonCg.events.some(row => row.kind === "outer_district_non_cg_suppressed"), true);
  assert.equal(memory.records.length, 0);

  const cg = await processOuterDistrictCandidate(memory, baseNow + 2 * 60_000, "Haymana", { cg: true });
  assert.equal(memory.records.length, 1);
  assert.equal(memory.records[0].enrichmentStatus, "cg_verified");
  assert.equal(cg.events.some(row => row.kind === "outer_district_non_cg_suppressed"), false);
  assert.equal(cg.events.some(row => row.kind === "publication_pending"), true);

  const central = await processOuterDistrictCandidate(memory, baseNow + 3 * 60_000, "Çankaya", { locality: "Ayrancı" });
  assert.equal(central.events.some(row => row.kind === "outer_district_non_cg_suppressed"), false);
  assert.equal(central.events.some(row => row.kind === "publication_pending"), true);
  assert.equal(memory.records.length, 2);
});

test("Evren non-CG is suppressed while verified CG remains eligible", async () => {
  const memory = memoryStore();
  const nonCg = await processOuterDistrictCandidate(memory, baseNow, "Evren");
  assert.equal(nonCg.events.find(row => row.kind === "outer_district_non_cg_suppressed")?.fields?.canonicalDistrict,
    "Evren");
  assert.equal(nonCg.events.some(row => row.kind === "candidate_outcome" &&
    row.fields?.decision === "HOLD" && row.fields?.reason === "outer_district_non_cg_suppressed"), true);
  assert.equal(memory.records.length, 0);

  const cg = await processOuterDistrictCandidate(memory, baseNow + 2 * 60_000, "Evren", { cg: true });
  assert.equal(cg.events.some(row => row.kind === "outer_district_non_cg_suppressed"), false);
  assert.equal(memory.records.length, 1);
  assert.equal(memory.records[0].enrichmentStatus, "cg_verified");
  const cgMessage = cg.events.find(row => row.kind === "publication_pending")?.fields?.messageText as string;
  assert.match(cgMessage, /^#YILDIRIM ⚡\n/);
});

test("raw CG matches failing each initial condition fall back to non-CG without a CG map", async () => {
  const cases = [
    { name: "distance", longitude: 32.724, time: baseNow - 1_000, referenceTime: baseNow,
      outcome: "rejected_spatial" },
    { name: "reference delta", longitude: 32.67, time: baseNow - 170_000, referenceTime: baseNow,
      outcome: "rejected_reference_time" },
    { name: "provider stale", longitude: 32.67, time: baseNow - 250_000, referenceTime: baseNow - 230_000,
      outcome: "rejected_provider_stale" },
  ] as const;
  for (const item of cases) {
    const { runtime, memory, events } = setup({ enrich: async reference => ({
      status: "cg_verified", provider: "xweather", reference, thresholds: { ...DEFAULT_THRESHOLDS },
      match: { id: `raw-${item.name}`, type: "cg", latitude: 39.9, longitude: item.longitude,
        eventTimeMs: item.time, distanceKm: 0, timeDifferenceMs: 0 },
    }) });
    qualifyingEvents(runtime, item.referenceTime);
    await runtime.drainCandidateWork();
    assert.equal(memory.records.length, 1, item.name);
    assert.equal(memory.records[0].enrichmentStatus, "no_match", item.name);
    assert.equal(memory.records[0].providerEventId, null, item.name);
    assert.equal(memory.records[0].mapUrl, null, item.name);
    const pending = events.find(row => row.kind === "publication_pending")?.fields?.messageText as string;
    assert.match(pending, /^#ŞİMŞEK\n/, item.name);
    const telemetry = events.find(row => row.kind === "enrichment_complete")?.fields;
    assert.equal(telemetry?.rawStatus, "cg_verified", item.name);
    assert.equal(telemetry?.category, item.outcome, item.name);
    assert.equal(telemetry?.initialCgAccepted, false, item.name);
    assert.equal(telemetry?.selectedLatitude, null, item.name);
    assert.equal(telemetry?.selectedLongitude, null, item.name);
    assert.equal(telemetry?.selectedEventTimeMs, null, item.name);
    assert.equal(telemetry?.evaluatedProviderEventId, `raw-${item.name}`, item.name);
    assert.equal(telemetry?.evaluatedProviderAgeMs, baseNow - item.time, item.name);
  }
});

test("initial IC-only and empty provider results keep ŞİMŞEK wording", async () => {
  for (const candidate of ["ic_only", "no_match"] as const) {
    const { runtime, memory, events } = setup({ enrich: async reference => matchInitialCgEvents(reference,
      candidate === "ic_only" ? [{ id: "ic-1", type: "ic", latitude: reference.latitude,
        longitude: reference.longitude, eventTimeMs: reference.eventTimeMs }] : [], baseNow) });
    qualifyingEvents(runtime);
    await runtime.drainCandidateWork();
    assert.equal(memory.records[0].enrichmentStatus, candidate);
    assert.match(events.find(row => row.kind === "publication_pending")?.fields?.messageText as string, /^#ŞİMŞEK\n/);
    const telemetry = events.find(row => row.kind === "enrichment_complete")?.fields;
    assert.equal(telemetry?.category, "no_cg_returned");
    assert.equal(telemetry?.selectedLatitude, null);
    assert.equal(telemetry?.selectedLongitude, null);
    assert.equal(telemetry?.selectedEventTimeMs, null);
  }
});

test("a new pending row is notified exactly once, after Supabase insertion, using exact composer output", async () => {
  const memory = memoryStore();
  const sent: Array<{ publicationId: string; messageText: string }> = [];
  const { runtime, events } = setup({ store: memory.store, notifyPending: async candidate => {
    assert.equal(memory.records.length, 1);
    assert.equal(memory.records[0].decision, "WOULD_PUBLISH");
    assert.equal(events.some(row => row.kind === "publication_pending"), true);
    sent.push(candidate);
    return { ok: true };
  } });
  assert.equal(runtime.capabilities.telegram, true);
  qualifyingEvents(runtime);
  await runtime.drainCandidateWork();
  assert.equal(memory.writes, 1);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].publicationId, memory.records[0].publicationId);
  assert.equal(sent[0].messageText, events.find(row => row.kind === "publication_pending")?.fields?.messageText);
  assert.equal(events.filter(row => row.kind === "telegram_notification_sent").length, 1);
});

test("duplicate, HOLD, already-present, and failed writes never notify", async () => {
  let notificationCalls = 0;
  const notifyPending: PendingPublicationNotifier = async () => { notificationCalls++; return { ok: true }; };
  const memory = memoryStore();
  const first = setup({ store: memory.store });
  qualifyingEvents(first.runtime);
  await first.runtime.drainCandidateWork();
  const duplicate = setup({ store: memory.store, notifyPending });
  qualifyingEvents(duplicate.runtime);
  await duplicate.runtime.drainCandidateWork();
  assert.equal(duplicate.events.some(row => row.kind === "duplicate_detected"), true);

  const hold = setup({ notifyPending, enrich: async reference => ({
    status: "provider_unavailable", provider: "xweather", reference,
    thresholds: { ...DEFAULT_THRESHOLDS }, failure: "network_error",
  }) });
  qualifyingEvents(hold.runtime);
  await hold.runtime.drainCandidateWork();
  assert.equal(hold.memory.records[0].decision, "HOLD");

  const alreadyPresent = setup({ notifyPending, store: {
    async loadRelevantPublicationHistory() { return []; },
    async insertPublicationRecord() { return "already_present"; },
  } });
  qualifyingEvents(alreadyPresent.runtime);
  await alreadyPresent.runtime.drainCandidateWork();
  assert.equal(alreadyPresent.runtime.summary().pendingPublications, 0);

  const failedWrite = setup({ notifyPending, store: {
    async loadRelevantPublicationHistory() { return []; },
    async insertPublicationRecord() { throw new Error("fixture write failure"); },
  } });
  qualifyingEvents(failedWrite.runtime);
  await failedWrite.runtime.drainCandidateWork();
  assert.equal(failedWrite.events.some(row => row.kind === "candidate_outcome"), true);
  assert.equal(notificationCalls, 0);
});

test("Telegram failures never roll back a pending record or stop continuous intake", async () => {
  const memory = memoryStore();
  const { runtime, events } = setup({ store: memory.store, notifyPending: async () => ({
    ok: false, reason: "http_error", httpStatus: 401,
  }) });
  qualifyingEvents(runtime);
  await runtime.drainCandidateWork();
  assert.equal(memory.records.length, 1);
  assert.equal(memory.records[0].decision, "WOULD_PUBLISH");
  assert.equal(runtime.summary().pendingPublications, 1);
  assert.equal(events.find(row => row.kind === "telegram_notification_failed")?.fields?.reason, "http_error");
  assert.doesNotThrow(() => runtime.acceptEvent(event(12), baseNow));

  const throwing = setup({ notifyPending: async () => { throw new Error("secret must not enter logs"); } });
  qualifyingEvents(throwing.runtime);
  await throwing.runtime.drainCandidateWork();
  assert.equal(throwing.memory.records.length, 1);
  assert.equal(throwing.events.find(row => row.kind === "telegram_notification_failed")?.fields?.reason, "unexpected_error");
  assert.doesNotMatch(JSON.stringify(throwing.events), /secret must not enter logs/);
});

test("missing Telegram configuration reports disabled while candidate persistence remains operational", async () => {
  const telegram = createPendingPublicationNotifier({});
  assert.equal(telegram.notify, null);
  const { runtime, memory, events } = setup();
  assert.deepEqual(runtime.capabilities, { persistence: true, xweather: true, telegram: false,
    autoPublish: false, approval: false, publishing: false });
  qualifyingEvents(runtime);
  await runtime.drainCandidateWork();
  assert.equal(memory.records[0].decision, "WOULD_PUBLISH");
  assert.equal(events.some(row => row.kind.startsWith("telegram_notification_")), false);
});

test("eligible first-CG shadow emits detailed telemetry without publication side effects", async () => {
  const fixture = await evaluateFirstCgShadowFixture();
  const events = fixture.events.filter(row => row.kind === "first_cg_transition_shadow");
  assert.equal(events.length, 1);
  const fields = events[0].fields!;
  assert.equal(fields.opportunityDetected, true);
  assert.equal(fields.eligible, true);
  assert.equal(fields.transitionKind, "generic_to_first_cg");
  assert.equal(fields.initialRouteContext, null);
  assert.equal(fields.eligibilityReason, "eligible");
  assert.ok(fields.incidentId);
  assert.ok(fields.scopeId);
  assert.ok(Array.isArray(fields.clusterIds));
  assert.ok(Number.isFinite(fields.evaluationAtMs as number));
  assert.equal(fields.providerEventId, "xw-event-1");
  assert.equal(fields.selectedEventTimeMs, baseNow + 60_000);
  assert.equal(fields.selectedLatitude, 39.95);
  assert.equal(fields.selectedLongitude, 32.65);
  assert.equal(fields.selectedEventAgeMs, 120_000);
  assert.equal(fields.referenceTimeMs, baseNow + 60_000);
  assert.equal(fields.referenceTimeDeltaMs, 0);
  assert.equal(fields.selectedDistanceKm, 0);
  assert.equal(fields.enrichmentStatus, "cg_verified");
  assert.equal(fields.currentnessPassed, true);
  assert.equal(fields.actualAdmissionReason, "no_positive_cg_history");
  assert.equal(fields.admissionReportedNoPositiveCgHistory, true);
  assert.equal(fields.firstVerifiedCgObservedForScope, undefined);
  assert.equal(fields.providerEventAlreadyRecorded, false);
  assert.equal(fields.equivalentCgPublicationExists, false);
  const earlier = fields.earlierPublication as Record<string, unknown>;
  assert.equal(earlier.isNonCg, true);
  assert.equal(earlier.publicationRecordId, fixture.records[0].publicationId);
  assert.equal(earlier.eventKind, "#ŞİMŞEK");
  assert.equal(earlier.providerStatus, "no_match");
  assert.equal(earlier.publishedAt, new Date(baseNow).toISOString());
  assert.equal(earlier.latitude, 39.9);
  assert.equal(earlier.longitude, 32.6);
  assert.equal(earlier.locationLabel, "Aşağı Ayrancı, Çankaya");
  assert.deepEqual(earlier.structuredLocation, {
    neighborhood: "Aşağı Ayrancı", locality: "Çankaya", localityKind: "town",
    district: "Çankaya", province: "Ankara", country: "Türkiye", rawType: null,
  });
  assert.equal(earlier.unavailableReason, null);
  const transition = fields.transitionElapsedSeconds as Record<string, unknown>;
  assert.equal(transition.earlierPublicationToCg, 60);
  assert.equal(transition.earlierPublicationToEvaluation, 180);
  assert.equal(transition.earlierPublicationToCgDistanceKm,
    greatCircleDistanceKm({ latitude: 39.9, longitude: 32.6 },
      { latitude: 39.95, longitude: 32.65, eventTimeMs: baseNow + 60_000 }));
  assert.equal(fixture.records.length, 1, "shadow evaluation must not persist another publication");
  assert.equal(fixture.calls.writes, 1);
  assert.equal(fixture.calls.notifications, 1);
  assert.equal(fixture.calls.approvalReads, 1);
  assert.equal(fixture.calls.approvalTransitions, 1);
  assert.equal(fixture.calls.dispatches, 1);
  assert.equal(fixture.calls.enrichment, 2, "only initial enrichment and the existing repeat probe ran");
  assert.equal(fixture.calls.reverse, 2, "only normal initial and repeat location resolution ran");
  assert.equal(fixture.calls.historyReads, 2, "no telemetry-only ledger read was added");
  assert.equal(fixture.runtime.summary(baseNow).cgRepeat.firstCgShadowOpportunities, 1);
  assert.equal(fixture.runtime.summary(baseNow).cgRepeat.firstCgShadowEligible, 1);
});

test("first-CG shadow leaves earlier-publication fields null when this runtime did not observe one", async () => {
  const fixture = await evaluateFirstCgShadowFixture(false, false);
  const events = fixture.events.filter(row => row.kind === "first_cg_transition_shadow");
  assert.equal(events.length, 1);
  const fields = events[0].fields!;
  assert.deepEqual(fields.earlierPublication, {
    isNonCg: null, publicationRecordId: null, eventKind: null, providerStatus: null,
    publishedAt: null, latitude: null, longitude: null, locationLabel: null, structuredLocation: null,
    unavailableReason: "not_observed_in_runtime_memory",
  });
  assert.deepEqual(fields.transitionElapsedSeconds, {
    earlierPublicationToCg: null, earlierPublicationToEvaluation: null, earlierPublicationToCgDistanceKm: null,
  });
  assert.equal(fixture.calls.historyReads, 2, "only the normal initial and repeat ledger history reads ran");
  assert.equal(fixture.calls.enrichment, 2, "only the initial and existing repeat provider queries ran");
  assert.equal(fixture.calls.reverse, 2, "only the normal initial and repeat location lookups ran");
});

test("ineligible first-CG shadow emits one evaluation with the currentness rejection", async () => {
  const fixture = await evaluateFirstCgShadowFixture(true);
  const events = fixture.events.filter(row => row.kind === "first_cg_transition_shadow");
  assert.equal(events.length, 1);
  const fields = events[0].fields!;
  assert.equal(fields.opportunityDetected, true);
  assert.equal(fields.eligible, false);
  assert.equal(fields.eligibilityReason, "selected_event_not_current");
  assert.equal(fields.currentnessPassed, false);
  assert.ok((fields.selectedEventAgeMs as number) > 240_000);
  assert.ok((fields.otherBlockers as string[]).includes("selected_event_not_current"));
  assert.equal(fixture.records.length, 1);
  assert.equal(fixture.calls.writes, 1);
  assert.equal(fixture.calls.notifications, 1);
  assert.equal(fixture.calls.approvalReads, 1);
  assert.equal(fixture.calls.approvalTransitions, 1);
  assert.equal(fixture.calls.dispatches, 1);
  assert.equal(fixture.calls.enrichment, 2);
  assert.equal(fixture.calls.reverse, 2);
  assert.equal(fixture.calls.historyReads, 2);
  assert.equal(fixture.runtime.summary(baseNow).cgRepeat.firstCgShadowOpportunities, 1);
  assert.equal(fixture.runtime.summary(baseNow).cgRepeat.firstCgShadowEligible, 0);
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
    async (input, init) => {
      const rpc = String(input).includes("/rpc/");
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body));
        writes.push(rpc ? body.p_record : body);
      }
      return Response.json(rpc ? { outcome: "inserted", reason: "admitted", rollingCount: 1 } :
        init?.method === "POST" ? [{ publication_id: "inserted" }] : []);
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
  let notifications = 0;
  const memory = memoryStore();
  const { runtime, events } = setup({ store: memory.store,
    notifyPending: async () => { notifications++; return { ok: true }; },
    enrich: async reference => { enrichCalls++; return verifiedCg(reference); } });
  qualifyingEvents(runtime, baseNow - 5 * 60_000);
  await runtime.drainCandidateWork();
  assert.equal(enrichCalls, 0);
  assert.equal(memory.reads, 0);
  assert.equal(memory.writes, 0);
  assert.equal(notifications, 0);
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
  let notifications = 0;
  const { runtime } = setup({ store: memory.store,
    notifyPending: async () => { notifications++; return { ok: true }; },
    reverse: async (latitude, longitude) => ({ latitude, longitude, provider: "fixture", displayLabel: null }) });
  qualifyingEvents(runtime);
  await runtime.drainCandidateWork();
  assert.equal(memory.reads, 0);
  assert.equal(memory.writes, 0);
  assert.equal(notifications, 0);
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

test("persisted initial ŞİMŞEK schedules one +3 minute shadow query with no publication side effects", async () => {
  let current = baseNow;
  const timers: Array<{ delayMs: number; callback: () => void }> = [];
  const memory = memoryStore();
  const calls = { enrichment: 0, reverse: 0, notifications: 0, admissions: 0, approvalReads: 0, dispatches: 0 };
  const store: LedgerStore = { ...memory.store,
    async admitCgPublication() { calls.admissions++; throw new Error("shadow must not admit CG"); } };
  const autoPublish: FlyAutoPublish = {
    approvalStore: {
      async getPublicationForApproval() { calls.approvalReads++; throw new Error("shadow must not read approval"); },
      async transitionPendingApproval() { throw new Error("shadow must not approve"); },
    },
    async dispatchPublisher() { calls.dispatches++; return { ok: true, httpStatus: 204 }; },
  };
  const fixture = setup({ store, now: () => current, autoPublish,
    schedule: (delayMs, callback) => { timers.push({ delayMs, callback }); },
    enrich: async reference => {
      calls.enrichment++;
      return calls.enrichment === 1
        ? matchInitialCgEvents(reference, [], current, { tokens: 2 })
        : matchInitialCgEvents(reference, [{ id: "delayed-cg-1", type: "cg", latitude: 39.9,
          longitude: 32.66, eventTimeMs: baseNow - 50_000 }], current, { tokens: 5 });
    },
    reverse: async (latitude, longitude) => {
      calls.reverse++;
      return { latitude, longitude, provider: "fixture", displayLabel: "Çankaya, Ankara",
        locality: "Çankaya", district: "Çankaya", province: "Ankara", country: "Türkiye" };
    },
    notifyPending: async () => { calls.notifications++; return { ok: true }; },
  });
  qualifyingEvents(fixture.runtime);
  await fixture.runtime.drainCandidateWork();
  assert.equal(timers.length, 1);
  assert.equal(timers[0].delayMs, 180_000);
  assert.equal(calls.enrichment, 1);
  assert.equal(memory.records.length, 1);
  assert.equal(memory.writes, 1);
  const initialNotifications = calls.notifications;
  const initialReads = memory.reads;
  const initialApprovals = calls.approvalReads;
  const initialDispatches = calls.dispatches;
  current = baseNow + 180_000;
  timers[0].callback();
  await fixture.runtime.drainCandidateWork();

  const records = fixture.events.filter(row => row.kind === "delayed_xweather_recheck_shadow");
  assert.equal(records.length, 1);
  const fields = records[0].fields!;
  assert.equal(fields.publicationRecordId, memory.records[0].publicationId);
  assert.equal(fields.originalEventKind, "#ŞİMŞEK");
  assert.equal(fields.delayedProviderStatus, "cg_verified");
  assert.equal(fields.delayedEnrichmentStatus, "cg_verified");
  assert.equal(fields.selectedProviderEventId, "delayed-cg-1");
  assert.equal(fields.selectedLatitude, 39.9);
  assert.equal(fields.selectedLongitude, 32.66);
  assert.equal(fields.selectedCgEventTimeMs, baseNow - 50_000);
  assert.equal(fields.referenceTimeDeltaMs, 49_002);
  assert.equal(fields.selectedProviderAgeMs, 230_000);
  assert.equal(fields.providerCostTokens, 5);
  assert.equal(fields.initialProviderCostTokens, 2);
  assert.equal((fields.comparison as Record<string, unknown>).wouldSatisfyCurrentInitialCgAssociation, true);
  assert.equal((fields.comparison as Record<string, unknown>).likelyProviderLatencyRecovery, true);
  assert.equal((fields.comparison as Record<string, unknown>).initialPublicationToSelectedCgEventSeconds, -50);
  assert.equal(fields.actualDelaySeconds, 180);
  const expectedDistance = greatCircleDistanceKm({ latitude: 39.9, longitude: 32.6 },
    { latitude: 39.9, longitude: 32.66, eventTimeMs: baseNow });
  assert.ok(Math.abs((fields.selectedDistanceKm as number) - expectedDistance) < 0.001);
  assert.ok(Math.abs(((fields.comparison as Record<string, number>).originalPublicationCoordinatesToSelectedCgDistanceKm) - expectedDistance) < 0.001);
  assert.equal(calls.enrichment, 2);
  assert.equal(calls.reverse, 1, "the recheck does not geocode again");
  assert.equal(memory.records.length, 1, "the recheck does not add a publication record");
  assert.equal(memory.writes, 1);
  assert.equal(memory.reads, initialReads, "the recheck does not read ledger history");
  assert.equal(calls.notifications, initialNotifications, "the recheck does not notify");
  assert.equal(calls.approvalReads, initialApprovals, "the recheck does not enter approval");
  assert.equal(calls.dispatches, initialDispatches, "the recheck does not dispatch a publisher");
  assert.equal(calls.admissions, 0, "the recheck does not run CG admission");
  assert.deepEqual(fixture.runtime.summary().delayedXweatherRechecks, {
    scheduled: 1, executed: 1, cgVerified: 1, noMatch: 0, icOnly: 0, providerUnavailable: 0,
    other: 0, providerCostTokensTotal: 5, changedToAcceptedCg: 1, likelyProviderLatencyRecoveries: 1,
  });
  assert.equal(fixture.events.find(row => row.kind === "enrichment_complete")?.fields?.providerCostTokens, 2);
});

test("delayed recheck logs no_match, IC-only, and provider-unavailable results distinctly", async () => {
  for (const delayedStatus of ["no_match", "ic_only", "provider_unavailable"] as const) {
    let current = baseNow;
    const timers: Array<() => void> = [];
    let enrichments = 0;
    const fixture = setup({ now: () => current, schedule: (_delay, callback) => timers.push(callback),
      enrich: async reference => {
        enrichments++;
        if (enrichments === 1 || delayedStatus === "no_match") return matchInitialCgEvents(reference, [], current);
        if (delayedStatus === "ic_only") return matchInitialCgEvents(reference, [{ id: "delayed-ic", type: "ic",
          latitude: reference.latitude, longitude: reference.longitude, eventTimeMs: reference.eventTimeMs }], current);
        return { status: "provider_unavailable", provider: "xweather", reference,
          thresholds: { ...DEFAULT_THRESHOLDS }, failure: "network_error" };
      } });
    qualifyingEvents(fixture.runtime);
    await fixture.runtime.drainCandidateWork();
    assert.equal(timers.length, 1);
    current += 180_000;
    timers[0]();
    await fixture.runtime.drainCandidateWork();
    const fields = fixture.events.find(row => row.kind === "delayed_xweather_recheck_shadow")?.fields;
    assert.ok(fields, delayedStatus);
    const expected = delayedStatus === "provider_unavailable" ? "provider_unavailable" : delayedStatus;
    assert.equal(fields.delayedEnrichmentStatus, expected, delayedStatus);
    assert.equal(fields.providerCostTokens, null, delayedStatus);
    assert.equal(fixture.runtime.summary().delayedXweatherRechecks.executed, 1);
  }
});

test("initial CG, outer-district suppression, HOLD, and duplicate candidates do not schedule delayed rechecks", async () => {
  const cgTimers: Array<() => void> = [];
  const cg = setup({ schedule: (_delay, callback) => cgTimers.push(callback) });
  qualifyingEvents(cg.runtime);
  await cg.runtime.drainCandidateWork();
  assert.equal(cgTimers.length, 0, "accepted initial CG does not schedule");

  const suppressedTimers: Array<() => void> = [];
  const outerMemory = memoryStore();
  await processOuterDistrictCandidate(outerMemory, baseNow, "Haymana", {
    schedule: (_delay, callback) => suppressedTimers.push(callback),
  });
  assert.equal(suppressedTimers.length, 0, "outer-district suppression does not schedule");

  const holdTimers: Array<() => void> = [];
  const hold = setup({ schedule: (_delay, callback) => holdTimers.push(callback), enrich: async reference => ({
    status: "provider_unavailable", provider: "xweather", reference, thresholds: { ...DEFAULT_THRESHOLDS },
    failure: "network_error",
  }) });
  qualifyingEvents(hold.runtime);
  await hold.runtime.drainCandidateWork();
  assert.equal(holdTimers.length, 0, "provider unavailable HOLD does not schedule");

  const duplicateMemory = memoryStore();
  const first = setup({ store: duplicateMemory.store,
    enrich: async reference => matchInitialCgEvents(reference, [], baseNow) });
  qualifyingEvents(first.runtime);
  await first.runtime.drainCandidateWork();
  const duplicateTimers: Array<() => void> = [];
  const duplicate = setup({ store: duplicateMemory.store,
    schedule: (_delay, callback) => duplicateTimers.push(callback),
    enrich: async reference => matchInitialCgEvents(reference, [], baseNow) });
  qualifyingEvents(duplicate.runtime);
  await duplicate.runtime.drainCandidateWork();
  assert.equal(duplicateTimers.length, 0, "duplicate/already-present record does not schedule");
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
  for (const file of ["./auto-publish.ts", "../lightning-github-dispatch/publisher.ts"]) {
    const source = await readFile(new URL(file, import.meta.url), "utf8");
    assert.doesNotMatch(source, /X_API_KEY|X_ACCESS_TOKEN|api\.x\.com|oauthHeader|createXAdapter/);
    assert.doesNotMatch(source, /from\s+["'][^"']*lightning-x-publisher\//);
  }
  assert.match(worker, /frameTimeoutMs\s*=\s*90_000/);
  assert.match(worker, /summaryEveryMs\s*=\s*5\s*\*\s*60_000/);
  assert.match(worker, /backoffMs\(attempt\+\+\)/);
  const dockerfile = await readFile(new URL("../../Dockerfile.fly-ankara-worker", import.meta.url), "utf8");
  for (const directory of ["fly-ankara-worker", "live-lightning-listener", "live-lightning-clustering", "lightning-incident-lifecycle",
    "lightning-cg-paired-validation", "lightning-cg-enrichment", "lightning-location-naming",
    "lightning-message-preview", "lightning-message-composer", "lightning-publish-decision",
    "lightning-end-to-end-dry-run", "lightning-publication-ledger", "lightning-telegram-notifier", "lightning-github-dispatch"]) {
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

// Shared mocked transport exercises the actual ledger/approval/dispatch adapters
// together. Providers remain the existing injected fixtures from setup().
function autoPipelineFixture(options: {
  enabled?: string;
  token?: string;
  dispatchStatus?: number;
  telegram?: "ok" | "failure" | "throw";
  failureTelegram?: "ok" | "failure" | "throw";
  approvalConflict?: boolean;
} = {}) {
  const trace: string[] = [];
  const rows: Array<Record<string, unknown>> = [];
  const warnings: Array<{ kind: string; fields?: Record<string, unknown> }> = [];
  let approvalWrites = 0;
  let dispatches = 0;
  let notifications = 0;
  let failureNotifications = 0;
  const failureTelegramTexts: string[] = [];
  const token = options.token ?? `github_pat_${"fixture_only_".repeat(3)}`;
  const environment = { LIGHTNING_AUTO_PUBLISH_ENABLED: options.enabled ?? "true",
    GITHUB_ACTIONS_DISPATCH_TOKEN: token, SUPABASE_URL: "https://fixture.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "fixture-service-key" };
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname === "api.github.com") {
      assert.equal(rows[0].approval_status, "approved");
      assert.deepEqual(JSON.parse(String(init?.body)), {
        ref: "main", inputs: { publicationId: rows[0].publication_id } });
      dispatches++;
      trace.push("dispatch");
      return new Response(null, { status: options.dispatchStatus ?? 204 });
    }
    assert.equal(url.hostname, "fixture.supabase.co");
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body));
      const rpc = url.pathname.includes("/rpc/");
      const row = rpc ? body.p_record : body;
      assert.equal(row.approval_status, "pending");
      trace.push("insert_pending");
      rows.push(row);
      return Response.json(rpc ? { outcome: "inserted", reason: "admitted", rollingCount: 1 } : [row]);
    }
    if (init?.method === "PATCH") {
      trace.push("approve");
      approvalWrites++;
      assert.equal(url.searchParams.get("publication_id"), `eq.${rows[0].publication_id}`);
      assert.equal(url.searchParams.get("approval_status"), "eq.pending");
      assert.equal(url.searchParams.get("decision"), "eq.WOULD_PUBLISH");
      assert.equal(url.searchParams.get("platform_post_id"), "is.null");
      const patch = JSON.parse(String(init.body));
      assert.deepEqual(Object.keys(patch).sort(), ["approval_actor", "approval_status", "approval_updated_at"]);
      if (options.approvalConflict) {
        rows[0].approval_status = "skipped";
        return Response.json([]);
      }
      Object.assign(rows[0], patch);
      return Response.json([rows[0]]);
    }
    return Response.json(rows);
  };
  const autoPublish = createFlyAutoPublish(environment,
    (kind, fields) => warnings.push({ kind, fields }), fetcher);
  const store = createSupabaseLedger({ url: environment.SUPABASE_URL,
    serviceRoleKey: environment.SUPABASE_SERVICE_ROLE_KEY }, fetcher);
  const f = setup({ store, autoPublish, notifyPending: async candidate => {
    notifications++;
    trace.push("telegram");
    assert.equal(rows[0].approval_status, "pending");
    assert.equal(candidate.autoPublish, f.runtime.capabilities.autoPublish);
    assert.equal(candidate.messageText, rows[0].message_text);
    assert.equal(f.events.at(-1)?.kind, "publication_pending");
    if (options.telegram === "throw") throw new Error(`Bearer ${token}`);
    return options.telegram === "failure" ? { ok: false, reason: "network_error" } : { ok: true };
  }, notifyAutoPublishFailure: async failure => {
    failureNotifications++;
    trace.push("telegram_dispatch_failure");
    failureTelegramTexts.push(`❌ Otomatik yayın başlatılamadı\nYayın ID: ${failure.publicationId}` +
      `${failure.httpStatus === undefined ? "" : `\nHTTP: ${failure.httpStatus}`}`);
    if (options.failureTelegram === "throw") throw new Error(`raw exception ${token}`);
    if (options.failureTelegram === "failure") return { ok: false, reason: "network_error" };
    return { ok: true };
  } });
  return { ...f, rows, trace, warnings, token, failureTelegramTexts,
    get failureNotifications() { return failureNotifications; }, get approvalWrites() { return approvalWrites; },
    get dispatches() { return dispatches; }, get notifications() { return notifications; } };
}

test("enabled Fly path inserts pending, emits, notifies, approves, then dispatches once", async () => {
  const f = autoPipelineFixture();
  assert.equal(f.runtime.capabilities.autoPublish, true);
  assert.equal(f.runtime.capabilities.publishing, false);
  qualifyingEvents(f.runtime);
  await f.runtime.drainCandidateWork();
  assert.deepEqual(f.trace, ["insert_pending", "telegram", "approve", "dispatch"]);
  assert.equal(f.rows.length, 1);
  assert.equal(f.rows[0].approval_status, "approved");
  assert.equal(f.rows[0].decision, "WOULD_PUBLISH");
  assert.equal(f.rows[0].platform_post_id, null);
  assert.equal(f.approvalWrites, 1);
  assert.equal(f.dispatches, 1);
  assert.equal(f.notifications, 1);
  assert.equal(f.failureNotifications, 0);
  assert.equal(f.events.some(event => event.kind === "telegram_auto_publish_failure_notification_sent"), false);
  assert.deepEqual(f.events.filter(event => event.kind.startsWith("auto_")).map(event => event.kind),
    ["auto_approval_succeeded", "auto_publish_dispatch_sent"]);
  assert.equal(f.events.find(event => event.kind === "auto_publish_dispatch_sent")?.fields?.publicationId,
    f.rows[0].publication_id);
  qualifyingEvents(f.runtime);
  await f.runtime.drainCandidateWork();
  assert.equal(f.dispatches, 1);
  assert.doesNotMatch(JSON.stringify({ events: f.events, summary: f.runtime.summary(), capabilities: f.runtime.capabilities }),
    /github_pat_|Bearer|Authorization|fixture-service-key/);
  assert.doesNotMatch(JSON.stringify(f.failureTelegramTexts), /Yayınlandı|yayımlandı/i);
});

test("disabled and requested-but-missing/malformed-token configurations keep new candidates pending and Telegram working", async () => {
  for (const options of [{ enabled: "false" }, { enabled: "TRUE" }, { token: "" }, { token: "malformed" }]) {
    const f = autoPipelineFixture(options);
    assert.equal(f.runtime.capabilities.autoPublish, false);
    qualifyingEvents(f.runtime);
    await f.runtime.drainCandidateWork();
    assert.equal(f.rows[0].approval_status, "pending");
    assert.deepEqual(f.trace, ["insert_pending", "telegram"]);
    assert.equal(f.approvalWrites, 0);
    assert.equal(f.dispatches, 0);
    assert.equal(f.notifications, 1);
    assert.equal(f.warnings.length, "token" in options ? 1 : 0);
    assert.equal(f.events.some(event => event.kind === "auto_publish_disabled"), true);
  }
});

test("Telegram failure or exception does not prevent automatic approval and dispatch", async () => {
  for (const telegram of ["failure", "throw"] as const) {
    const f = autoPipelineFixture({ telegram });
    qualifyingEvents(f.runtime);
    await f.runtime.drainCandidateWork();
    assert.deepEqual(f.trace, ["insert_pending", "telegram", "approve", "dispatch"]);
    assert.equal(f.rows[0].approval_status, "approved");
    assert.equal(f.events.some(event => event.kind === "telegram_notification_failed"), true);
    assert.equal(f.events.some(event => event.kind === "auto_publish_dispatch_sent"), true);
    assert.doesNotMatch(JSON.stringify(f.events), /github_pat_|Bearer|Authorization/);
  }
});

test("approval conflict blocks dispatch; dispatch failure leaves approved row and worker intake operational", async () => {
  const conflict = autoPipelineFixture({ approvalConflict: true });
  qualifyingEvents(conflict.runtime);
  await conflict.runtime.drainCandidateWork();
  assert.equal(conflict.rows[0].approval_status, "skipped");
  assert.equal(conflict.dispatches, 0);
  assert.equal(conflict.events.some(event => event.kind === "auto_approval_failed"), true);

  const failed = autoPipelineFixture({ dispatchStatus: 503 });
  qualifyingEvents(failed.runtime);
  await failed.runtime.drainCandidateWork();
  assert.equal(failed.rows[0].approval_status, "approved");
  assert.equal(failed.rows[0].decision, "WOULD_PUBLISH");
  assert.equal(failed.rows[0].platform_post_id, null);
  assert.equal(failed.dispatches, 1);
  assert.equal(failed.approvalWrites, 1);
  assert.equal(failed.events.find(event => event.kind === "auto_publish_dispatch_failed")?.fields?.httpStatus, 503);
  assert.deepEqual(failed.trace, ["insert_pending", "telegram", "approve", "dispatch", "telegram_dispatch_failure"]);
  assert.equal(failed.failureNotifications, 1);
  assert.match(failed.failureTelegramTexts[0], new RegExp(String(failed.rows[0].publication_id)));
  assert.match(failed.failureTelegramTexts[0], /HTTP: 503/);
  // Still the same publication ID, approved for manual recovery by the existing workflow.
  assert.match(String(failed.rows[0].publication_id), /^pub_[0-9a-f]{32}$/);
  assert.doesNotThrow(() => failed.runtime.acceptEvent(event(12), baseNow));
  assert.equal(failed.runtime.pipeline.counters.unique, 4);
});

test("dispatch-failure Telegram error is best-effort and cannot roll back approval, retry dispatch, or stop intake", async () => {
  for (const failureTelegram of ["failure", "throw"] as const) {
    const f = autoPipelineFixture({ dispatchStatus: 403, failureTelegram });
    qualifyingEvents(f.runtime);
    await f.runtime.drainCandidateWork();
    assert.equal(f.failureNotifications, 1);
    assert.equal(f.rows[0].approval_status, "approved");
    assert.equal(f.dispatches, 1);
    assert.equal(f.trace.filter(item => item === "dispatch").length, 1);
    assert.equal(f.events.find(event => event.kind === "telegram_auto_publish_failure_notification_failed")?.fields?.reason,
      failureTelegram === "throw" ? "unexpected_error" : "network_error");
    assert.doesNotMatch(JSON.stringify(f.events), /raw exception|github_pat_|fixture-service-key|Authorization/);
    assert.doesNotThrow(() => f.runtime.acceptEvent(event(12), baseNow));
  }
});

test("enabled mode rejects duplicate, HOLD, already-present, stale, failed writes, no-location and composer failure before approval", async () => {
  let approvalReads = 0;
  let dispatches = 0;
  let notifications = 0;
  const autoPublish: FlyAutoPublish = {
    approvalStore: {
      async getPublicationForApproval() { approvalReads++; throw new Error("must not approve unsafe candidate"); },
      async transitionPendingApproval() { throw new Error("unexpected approval transition"); },
    },
    async dispatchPublisher() { dispatches++; return { ok: true, httpStatus: 204 }; },
  };
  const notifyPending: PendingPublicationNotifier = async () => { notifications++; return { ok: true }; };
  const common = { autoPublish, notifyPending };
  const memory = memoryStore();
  const first = setup({ store: memory.store });
  qualifyingEvents(first.runtime);
  await first.runtime.drainCandidateWork();
  const duplicate = setup({ ...common, store: memory.store });
  const hold = setup({ ...common, enrich: async reference => ({
    status: "provider_unavailable", provider: "xweather", reference,
    thresholds: { ...DEFAULT_THRESHOLDS }, failure: "network_error",
  }) });
  const alreadyPresent = setup({ ...common, store: {
    async loadRelevantPublicationHistory() { return []; },
    async insertPublicationRecord() { return "already_present"; },
  } });
  const failedWrite = setup({ ...common, store: {
    async loadRelevantPublicationHistory() { return []; },
    async insertPublicationRecord() { throw new Error("fixture write failed"); },
  } });
  const noLocation = setup({ ...common, reverse: async (latitude, longitude) => ({
    latitude, longitude, provider: "fixture", displayLabel: null,
  }) });
  const failedComposer = setup({ ...common, reverse: async (latitude, longitude) => ({
    latitude, longitude, provider: "fixture", displayLabel: `${"x".repeat(300)}, Ankara`,
    district: "x".repeat(300), province: "Ankara",
  }) });
  const stale = setup(common);
  for (const f of [duplicate, hold, alreadyPresent, failedWrite, noLocation, failedComposer, stale]) {
    qualifyingEvents(f.runtime, f === stale ? baseNow - 5 * 60_000 : baseNow);
    await f.runtime.drainCandidateWork();
    assert.equal(f.runtime.capabilities.autoPublish, true);
    assert.equal(f.events.some(event => event.kind.startsWith("auto_")), false);
  }
  assert.equal(duplicate.events.some(event => event.kind === "duplicate_detected"), true);
  assert.equal(hold.memory.records[0].decision, "HOLD");
  assert.equal(stale.events.some(event => event.kind === "candidate_rejected_stale"), true);
  assert.equal(failedComposer.events.find(event => event.kind === "candidate_outcome")?.fields?.status, "message_composition_failed");
  assert.equal(approvalReads, 0);
  assert.equal(dispatches, 0);
  assert.equal(notifications, 0);
});
