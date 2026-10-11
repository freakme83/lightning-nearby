import assert from "node:assert/strict";
import { test } from "node:test";
import { AnkaraFlyPipeline } from "./runtime.ts";
import type { LedgerStore } from "../lightning-publication-ledger/storage/supabase.ts";
import type { PublicationRecord } from "../lightning-publication-ledger/types.ts";
import { evaluateCgRepeat } from "../lightning-cg-repeat-policy/admission.ts";
import type { EnrichmentReference, EnrichmentResult } from "../lightning-cg-enrichment/types.ts";
import { DEFAULT_THRESHOLDS } from "../lightning-cg-enrichment/match.ts";
import { normalizeAndLabel, extractProviderAddressHierarchy } from "../lightning-location-naming/normalize.ts";
import type { LightningEvent } from "../live-lightning-listener/core.ts";

function setup(recovered = true) {
  let clock = Date.parse("2026-10-11T10:00:00Z"); let sequence = 0;
  const records: PublicationRecord[] = []; const calls: EnrichmentReference[] = [];
  const events: Array<{ kind: string; fields?: Record<string, unknown> }> = [];
  let status: EnrichmentResult["status"] = "cg_verified";
  let name = "Ayrancı"; let selectedDeltaMs = 0; let selectedId: string | undefined;
  let pending: Promise<void> | undefined;
  let failAdmission = false; let unusable = false;
  const store: LedgerStore = {
    async loadRelevantPublicationHistory() { return [...records]; },
    async insertPublicationRecord(record) {
      if (records.some(row => row.publicationId === record.publicationId)) return "already_present";
      record.recordedAt = new Date(clock).toISOString(); records.push(record); return "inserted";
    },
    async admitCgPublication(record, _text, request) {
      if (failAdmission) throw new Error("ambiguous storage failure");
      if (records.some(row => row.publicationId === record.publicationId)) return { outcome: "already_present", reason: "id" };
      if (request.kind === "repeat") {
        const history = records.filter(row => row.cgScopeId === request.scopeId || row.cgScopeId === request.predecessorScopeId);
        const decision = evaluateCgRepeat(record.cgMetadata!, history, request.scopeId, clock);
        if (!decision.eligible) return { outcome: "suppressed", ...decision };
      }
      record.recordedAt = new Date(clock).toISOString(); records.push(record);
      return { outcome: "inserted", reason: "admitted" };
    },
  };
  const runtime = new AnkaraFlyPipeline({ store, now: () => clock, emit: (kind, fields) => events.push({ kind, fields }),
    enrich: async reference => {
      calls.push({ ...reference }); await pending;
      return { status, provider: "xweather", reference, thresholds: DEFAULT_THRESHOLDS,
        ...(status === "cg_verified" ? { match: { id: selectedId ?? `xw-${calls.length}`, type: "cg" as const,
          latitude: reference.latitude, longitude: reference.longitude,
          eventTimeMs: reference.eventTimeMs + selectedDeltaMs, distanceKm: 0, timeDifferenceMs: Math.abs(selectedDeltaMs) } } : {}) };
    },
    reverse: async (latitude, longitude) => {
      const payload = { address: { neighbourhood: name, town: "Çankaya", county: "Çankaya", province: "Ankara", country: "Türkiye" } };
      return { latitude, longitude, provider: "fixture", ...normalizeAndLabel(payload),
        ...(unusable ? { displayLabel: null } : {}), providerAddress: extractProviderAddressHierarchy(payload) };
    },
  });
  runtime.recordFrame(clock);
  function advance(ms: number, healthy = true) {
    const end = clock + ms;
    while (clock < end) { clock = Math.min(clock + 60_000, end); if (healthy) runtime.recordFrame(clock); }
  }
  if (recovered) advance(41 * 60_000);
  function feed(distanceKm = 0, time = clock, latitude = 39.9, longitude = 32.85) {
    const event: LightningEvent = { source: "lightningmaps-live2", sourceEventKey: String(++sequence),
      latitude: latitude + distanceKm / 111.1950802335329, longitude, eventTimeMs: time, receivedAtMs: clock,
      dischargeType: "unknown" };
    return runtime.acceptEvent(event, clock);
  }
  async function initial() { feed(0, clock - 2); feed(0, clock - 1); feed(); await runtime.drainCandidateWork(); }
  return { runtime, records, calls, events, advance, feed, initial,
    set name(value: string) { name = value; }, set status(value: EnrichmentResult["status"]) { status = value; },
    set selectedDeltaMs(value: number) { selectedDeltaMs = value; }, set selectedId(value: string) { selectedId = value; },
    set pending(value: Promise<void> | undefined) { pending = value; }, set failAdmission(value: boolean) { failAdmission = value; },
    set unusable(value: boolean) { unusable = value; }, get now() { return clock; } };
}

test("guarded urban repeats: same place, sub-km, three total and full history cycle", async () => {
  const f = setup(); await f.initial();
  assert.equal(f.records.filter(row => row.decision === "WOULD_PUBLISH").length, 1);
  for (const [name, distance, expected] of [["Ayrancı", 1.4, 1], ["Balgat", 0.8, 1],
    ["Balgat", 1.4, 2], ["Ayrancı", 5, 2], ["Çukurambar", 2.8, 3], ["Söğütözü", 4.2, 3]] as const) {
    f.advance(120_000); f.name = name; f.feed(distance); await f.runtime.drainCandidateWork();
    assert.equal(f.records.filter(row => row.decision === "WOULD_PUBLISH").length, expected, name);
  }
  assert.ok(f.events.some(row => row.kind === "cg_repeat_outcome" && row.fields?.outcome === "WOULD_PUBLISH"));
  assert.deepEqual(f.calls[3], { latitude: 39.9 + 1.4 / 111.1950802335329, longitude: 32.85,
    eventTimeMs: f.records[1].incidentReferenceTime ? Date.parse(f.records[1].incidentReferenceTime) : 0 });
  assert.equal(f.runtime.summary().profile.promotionMinEvents, 3);
});

test("non-CG outcomes, missing ID, old/future selected CG and ambiguous storage never publish repeat", async () => {
  for (const issue of ["ic_only", "no_match", "provider_unavailable", "missing_id", "old", "future", "write", "geography"] as const) {
    const f = setup(); await f.initial(); f.advance(120_000); f.name = "Balgat";
    if (["ic_only", "no_match", "provider_unavailable"].includes(issue)) f.status = issue as EnrichmentResult["status"];
    if (issue === "missing_id") f.selectedId = "";
    if (issue === "old") f.selectedDeltaMs = -61_000;
    if (issue === "future") f.selectedDeltaMs = 1;
    if (issue === "write") f.failAdmission = true;
    if (issue === "geography") f.unusable = true;
    f.feed(1.4); await f.runtime.drainCandidateWork();
    assert.equal(f.records.filter(row => row.decision === "WOULD_PUBLISH").length, 1, issue);
    assert.equal(f.events.filter(row => row.kind === "publication_pending").length, 1, issue);
  }
});

test("exact provider duplicate wins over semantic change", async () => {
  const f = setup(); await f.initial(); f.advance(120_000); f.name = "Balgat"; f.selectedId = "xw-1";
  f.feed(1.4); await f.runtime.drainCandidateWork();
  assert.equal(f.records.filter(row => row.decision === "WOULD_PUBLISH").length, 1);
  assert.ok(f.events.some(row => row.kind === "duplicate_detected"));
});

test("restart/recovery hold preserves initial path; uninterrupted recovery later allows repeat", async () => {
  const f = setup(false); await f.initial(); assert.equal(f.calls.length, 1);
  f.advance(5 * 60_000); f.name = "Balgat"; f.feed(1.4); await f.runtime.drainCandidateWork();
  assert.equal(f.calls.length, 1);
  // Keep the same incident alive while the hold expires, without probing it.
  for (let i = 0; i < 8; i++) { f.advance(5 * 60_000); f.feed(1.4); await f.runtime.drainCandidateWork(); }
  assert.ok(f.calls.length >= 2);
  assert.equal(f.records.filter(row => row.decision === "WOULD_PUBLISH").length, 2);
  f.runtime.recordDisconnected(f.now); f.advance(60_000); f.runtime.recordFrame(f.now);
  f.name = "Çukurambar"; f.feed(2.8); await f.runtime.drainCandidateWork();
  assert.equal(f.records.filter(row => row.decision === "WOULD_PUBLISH").length, 2);
  assert.equal(f.runtime.summary().cgRepeat.recoveryReady, false);
});

test("accepted unique, promoted and fresh live-only trigger; separate incident stays independent", async () => {
  const f = setup(); f.feed(); await f.runtime.drainCandidateWork(); assert.equal(f.calls.length, 0);
  await f.initial(); f.advance(120_000); f.name = "Balgat";
  f.feed(1.4, f.now - 300_000); f.feed(1.4, f.now + 1); await f.runtime.drainCandidateWork(); assert.equal(f.calls.length, 1);
  const outside = f.feed(0, f.now, 0, 0); assert.equal(outside.insideSubscriptionBox, false);
  f.runtime.recordDisconnected(f.now); f.feed(1.4); await f.runtime.drainCandidateWork(); assert.equal(f.calls.length, 1);
  // An unrelated newly promoted incident can still take its initial generic path.
  f.runtime.recordFrame(f.now); f.name = "Elsewhere";
  f.feed(30, f.now - 2); f.feed(30, f.now - 1); f.feed(30); await f.runtime.drainCandidateWork();
  assert.equal(f.records.filter(row => row.decision === "WOULD_PUBLISH").length, 2);
  assert.notEqual(f.records[0].cgScopeId, f.records[1].cgScopeId);
});

test("bounded repeat flight coalesces later accepted observations and rechecks delayed freshness", async () => {
  const f = setup(); await f.initial(); f.advance(120_000); f.name = "Balgat";
  let release!: () => void; f.pending = new Promise<void>(resolve => { release = resolve; });
  f.feed(1.4); await Promise.resolve();
  for (let i = 0; i < 50; i++) f.feed(1.4, f.now - i);
  assert.equal(f.calls.length, 2); assert.ok(f.runtime.summary().cgRepeat.coalesced > 0);
  f.advance(300_000); release(); f.pending = undefined; await f.runtime.drainCandidateWork();
  assert.equal(f.calls.length, 2, "expired queued observation is discarded before a provider call");
  assert.equal(f.records.filter(row => row.decision === "WOULD_PUBLISH").length, 1);
});

test("nearby cooldown and later suppressed activity compare predecessor without inheriting its quota", async () => {
  const f = setup(); await f.initial();
  f.advance(20 * 60_000); f.runtime.summary();
  assert.equal(f.runtime.lifecycle.incidents[0].status, "closed");
  f.advance(60_000); f.name = "Balgat";
  f.feed(1.4, f.now - 2); f.feed(1.4, f.now - 1); f.feed(1.4); await f.runtime.drainCandidateWork();
  assert.equal(f.records.filter(row => row.decision === "WOULD_PUBLISH").length, 2);
  assert.notEqual(f.records[0].cgScopeId, f.records[1].cgScopeId);
  assert.ok(f.events.some(row => row.kind === "cg_repeat_probe" && row.fields?.originalSuppressionReason === "nearby_cooldown"));
  f.advance(120_000); f.name = "Çukurambar"; f.feed(2.8); await f.runtime.drainCandidateWork();
  assert.equal(f.records.filter(row => row.decision === "WOULD_PUBLISH").length, 3);
  assert.ok(f.events.some(row => row.kind === "cg_repeat_probe" && row.fields?.originalSuppressionReason === "already_active_suppressed_incident"));
});
