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
import { createPendingPublicationNotifier, type PendingPublicationNotifier } from "../lightning-telegram-notifier/pending.ts";
import { AnkaraFlyPipeline, validateFlyPipelineEnvironment } from "./runtime.ts";
import { createFlyAutoPublish, type FlyAutoPublish } from "./auto-publish.ts";

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
  autoPublish?: FlyAutoPublish;
} = {}) {
  const events: Array<{ kind: string; fields?: Record<string, unknown> }> = [];
  const memory = memoryStore();
  const runtime = new AnkaraFlyPipeline({
    store: options.store ?? memory.store,
    now: options.now ?? (() => baseNow),
    emit: (kind, fields) => events.push({ kind, fields }),
    enrich: options.enrich ?? (async reference => verifiedCg(reference)),
    notifyPending: options.notifyPending,
    autoPublish: options.autoPublish,
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
  approvalConflict?: boolean;
} = {}) {
  const trace: string[] = [];
  const rows: Array<Record<string, unknown>> = [];
  const warnings: Array<{ kind: string; fields?: Record<string, unknown> }> = [];
  let approvalWrites = 0;
  let dispatches = 0;
  let notifications = 0;
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
      const row = JSON.parse(String(init.body));
      assert.equal(row.approval_status, "pending");
      trace.push("insert_pending");
      rows.push(row);
      return Response.json([row]);
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
    assert.equal(candidate.messageText, rows[0].message_text);
    assert.equal(f.events.at(-1)?.kind, "publication_pending");
    if (options.telegram === "throw") throw new Error(`Bearer ${token}`);
    return options.telegram === "failure" ? { ok: false, reason: "network_error" } : { ok: true };
  } });
  return { ...f, rows, trace, warnings, token, get approvalWrites() { return approvalWrites; },
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
  assert.deepEqual(f.events.filter(event => event.kind.startsWith("auto_")).map(event => event.kind),
    ["auto_approval_succeeded", "auto_publish_dispatch_sent"]);
  assert.equal(f.events.find(event => event.kind === "auto_publish_dispatch_sent")?.fields?.publicationId,
    f.rows[0].publication_id);
  qualifyingEvents(f.runtime);
  await f.runtime.drainCandidateWork();
  assert.equal(f.dispatches, 1);
  assert.doesNotMatch(JSON.stringify({ events: f.events, summary: f.runtime.summary(), capabilities: f.runtime.capabilities }),
    /github_pat_|Bearer|Authorization|fixture-service-key/);
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
  // Still the same publication ID, approved for manual recovery by the existing workflow.
  assert.match(String(failed.rows[0].publication_id), /^pub_[0-9a-f]{32}$/);
  assert.doesNotThrow(() => failed.runtime.acceptEvent(event(12), baseNow));
  assert.equal(failed.runtime.pipeline.counters.unique, 4);
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
