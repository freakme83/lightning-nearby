import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { DEFAULT_THRESHOLDS } from "../lightning-cg-enrichment/match.ts";
import type { EnrichmentReference, EnrichmentResult } from "../lightning-cg-enrichment/types.ts";
import { createSupabaseLedger, type LedgerStore } from "../lightning-publication-ledger/storage/supabase.ts";
import type { PublicationRecord } from "../lightning-publication-ledger/types.ts";
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
} = {}) {
  const events: Array<{ kind: string; fields?: Record<string, unknown> }> = [];
  const memory = memoryStore();
  const now = options.now ?? (() => baseNow);
  const startedAt = now();
  const runtime = new AnkaraFlyPipeline({
    store: options.store ?? memory.store,
    now,
    emit: (kind, fields) => events.push({ kind, fields }),
    enrich: options.enrich ?? (async reference => verifiedCg(reference)),
    notifyPending: options.notifyPending,
    notifyAutoPublishFailure: options.notifyAutoPublishFailure,
    autoPublish: options.autoPublish,
    reverse: options.reverse ?? (async (latitude, longitude) => ({
      latitude, longitude, provider: "fixture", displayLabel: "Çankaya, Ankara", locality: "Çankaya", district: "Çankaya",
      province: "Ankara", country: "Türkiye",
    })),
    clusterParameters: { maxSpatialDistanceKm: 1, maxTemporalGapMinutes: 10,
      freshnessWindowMinutes: 10, clusterCloseAfterMinutes: 15 },
  });
  runtime.markConnecting(startedAt - 1000);
  runtime.recordFrame(startedAt);
  return { runtime, events, memory };
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

async function processOuterDistrictCandidate(memory: ReturnType<typeof memoryStore>, at: number,
  district: string, options: { province?: string; locality?: string; localityKind?: ReverseGeocodeResult["localityKind"];
    neighborhood?: string; cg?: boolean; missingDistrict?: boolean; notifyPending?: PendingPublicationNotifier;
    autoPublish?: FlyAutoPublish } = {}) {
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
    enrich: async reference => options.cg ? verifiedCg(reference) : matchInitialCgEvents(reference, [], current) });
  qualifyingEvents(fixture.runtime, at, at);
  await fixture.runtime.drainCandidateWork();
  return fixture;
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
  let clock = baseNow; let sequence = 0;
  const { runtime, memory, events } = setup({ now: () => clock, enrich: async reference => ({
    status: "no_match", provider: "xweather", reference, thresholds: DEFAULT_THRESHOLDS,
  }) });
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
  assert.equal(runtime.summary().recall.eventsAfterCandidateExpiry, 2);
  assert.equal(runtime.summary().recall.promotionsAfterRecovery, 1);
  assert.equal(runtime.summary().profile.promotionMinEvents, 3);
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

test("selected outer-district CG and central Ankara non-CG keep their existing publication behavior", async () => {
  const memory = memoryStore();
  const cg = await processOuterDistrictCandidate(memory, baseNow, "Haymana", { cg: true });
  assert.equal(memory.records.length, 1);
  assert.equal(memory.records[0].enrichmentStatus, "cg_verified");
  assert.equal(cg.events.some(row => row.kind === "outer_district_non_cg_suppressed"), false);
  assert.equal(cg.events.some(row => row.kind === "publication_pending"), true);

  const central = await processOuterDistrictCandidate(memory, baseNow + 60_000, "Çankaya", { locality: "Ayrancı" });
  assert.equal(central.events.some(row => row.kind === "outer_district_non_cg_suppressed"), false);
  assert.equal(central.events.some(row => row.kind === "publication_pending"), true);
  assert.equal(memory.records.length, 2);
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
