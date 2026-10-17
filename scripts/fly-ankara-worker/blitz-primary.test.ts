import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import type { BlitzortungProbeEvent } from "../research/blitzortung-probe/protocol.ts";
import type { LightningEvent } from "../live-lightning-listener/core.ts";
import type { LedgerStore } from "../lightning-publication-ledger/storage/supabase.ts";
import { AnkaraFlyPipeline } from "./runtime.ts";
import { BLITZ_ADMISSION_MAX_LATENCY_MS, BLITZ_EXACT_DEDUP_MAX_ENTRIES,
  BLITZ_EXACT_DEDUP_TTL_MS, BlitzPrimaryAdmission, blitzFingerprint,
  blitzSourceStillHealthy, shouldLogBlitzAdmissionRejection } from "./blitz-primary.ts";

const eventTimeMs = Date.parse("2026-10-09T12:00:00.000Z");

function strike(overrides: Partial<BlitzortungProbeEvent> = {}): BlitzortungProbeEvent {
  return { source: "blitzortung", sourceServer: "ws1", eventTimeMs,
    eventTimeRaw: String(BigInt(eventTimeMs) * BigInt(1_000_000)), eventTimeUnit: "nanoseconds",
    receivedAtMs: eventTimeMs + 5_000, latencyMs: 5_000, latencyEligible: true,
    latitude: 39.9, longitude: 32.6, polarityRaw: null, stationCount: 4,
    mdsRaw: 2, mcgRaw: 1, regionRaw: null, insideMonitoringArea: true, ...overrides };
}

function recorder() {
  const guard = new BlitzPrimaryAdmission();
  const admitted: LightningEvent[] = [];
  const accept = (event: LightningEvent) => { admitted.push(event); };
  return { guard, admitted, accept };
}

test("fresh Blitz strike is admitted once; exact repeat is rejected before callback", () => {
  const { guard, admitted, accept } = recorder();
  const logRows: string[] = [];
  const first = guard.admit(strike(), accept);
  const duplicate = guard.admit(strike({ sourceServer: "ws7", receivedAtMs: eventTimeMs + 6_000 }), accept);
  for (const result of [first, duplicate]) {
    if (shouldLogBlitzAdmissionRejection(result)) logRows.push(result);
  }
  assert.equal(first, "admitted");
  assert.equal(duplicate, "duplicate");
  assert.deepEqual(logRows, [], "expected exact duplicates are counter-only");
  assert.equal(admitted.length, 1);
  assert.equal(admitted[0].source, "blitzortung");
  assert.equal(admitted[0].dischargeType, "unknown");
  assert.deepEqual(guard.counters, { blitzRawEvents: 2, blitzExactDuplicates: 1,
    blitzRejectedStaleOrFuture: 0, blitzAdmittedEvents: 1 });
  assert.equal(shouldLogBlitzAdmissionRejection("duplicate"), false);
});

test("fingerprint distinguishes coordinates, raw event time, and other source identity fields", () => {
  const { guard, admitted, accept } = recorder();
  const first = strike();
  assert.equal(guard.admit(first, accept), "admitted");
  assert.equal(guard.admit(strike({ longitude: 32.600001 }), accept), "admitted");
  assert.equal(guard.admit(strike({ eventTimeMs: eventTimeMs + 1,
    eventTimeRaw: String(BigInt(eventTimeMs + 1) * BigInt(1_000_000)) }), accept), "admitted");
  assert.equal(guard.admit(strike({ mdsRaw: 3 }), accept), "admitted");
  assert.equal(admitted.length, 4);
  assert.notEqual(blitzFingerprint(first), blitzFingerprint(strike({ longitude: 32.600001 })));
});

test("freshness is inclusive at 30 seconds and excludes future and older events", () => {
  const { guard, admitted, accept } = recorder();
  const loggedRejections: string[] = [];
  assert.equal(BLITZ_ADMISSION_MAX_LATENCY_MS, 30_000);
  for (const receivedAtMs of [eventTimeMs - 1, eventTimeMs + 30_001]) {
    const rejection = guard.admit(strike({ receivedAtMs }), accept);
    assert.equal(rejection, "stale_or_future");
    if (shouldLogBlitzAdmissionRejection(rejection)) loggedRejections.push(rejection);
  }
  assert.equal(guard.admit(strike({ receivedAtMs: eventTimeMs + 30_000 }), accept), "admitted");
  assert.equal(admitted.length, 1);
  assert.equal(guard.counters.blitzRejectedStaleOrFuture, 2);
  assert.deepEqual(loggedRejections, ["stale_or_future", "stale_or_future"]);
  assert.equal(shouldLogBlitzAdmissionRejection("stale_or_future"), true);
});

test("an admitted strike repeated outside freshness stays a duplicate; a future strike can later be admitted", () => {
  const { guard, admitted, accept } = recorder();
  guard.admit(strike(), accept);
  assert.equal(guard.admit(strike({ receivedAtMs: eventTimeMs + 40_000 }), accept), "duplicate");
  const future = strike({ latitude: 39.901, receivedAtMs: eventTimeMs - 1 });
  assert.equal(guard.admit(future, accept), "stale_or_future");
  assert.equal(guard.admit({ ...future, receivedAtMs: eventTimeMs + 1_000 }, accept), "admitted");
  assert.equal(admitted.length, 2);
});

test("exact dedup is bounded by both TTL and capacity", () => {
  const { guard, accept } = recorder();
  assert.equal(BLITZ_EXACT_DEDUP_TTL_MS, 120_000);
  guard.admit(strike(), accept);
  assert.equal(guard.admit(strike({ receivedAtMs: eventTimeMs + 30_000 }), accept), "duplicate");
  // The local guard's memory cap is fixed even if source identities vary.
  for (let index = 0; index < BLITZ_EXACT_DEDUP_MAX_ENTRIES + 1; index++) {
    guard.admit(strike({ longitude: 32.6 + index * 0.000001 }), accept);
  }
  assert.equal(guard.dedupEntryCount, BLITZ_EXACT_DEDUP_MAX_ENTRIES);
});

test("duplicate does not increase clustering or Profile B event counts", () => {
  const store: LedgerStore = {
    async loadRelevantPublicationHistory() { return []; },
    async insertPublicationRecord() { throw new Error("unexpected publication write"); },
  };
  const runtime = new AnkaraFlyPipeline({ store, now: () => eventTimeMs + 5_000,
    enrich: async () => { throw new Error("unexpected Xweather call"); },
    reverse: async () => { throw new Error("unexpected location lookup"); } });
  runtime.markConnecting(eventTimeMs);
  runtime.recordFrame(eventTimeMs + 5_000);
  const guard = new BlitzPrimaryAdmission();
  const accept = (event: LightningEvent, atMs: number) => { runtime.acceptEvent(event, atMs); };
  guard.admit(strike(), accept);
  const before = runtime.summary(eventTimeMs + 5_000);
  guard.admit(strike({ sourceServer: "ws8", receivedAtMs: eventTimeMs + 5_100 }), accept);
  const after = { ...guard.counters, ...runtime.summary(eventTimeMs + 5_100) };
  assert.equal(after.decoded, before.decoded);
  assert.equal(after.insideMonitoringArea, before.insideMonitoringArea);
  assert.equal(after.candidatesCreated, before.candidatesCreated);
  assert.equal(after.blitzExactDuplicates, 1);
  assert.equal(after.blitzRejectedStaleOrFuture, 0);
  assert.equal(after.blitzAdmittedEvents, 1);
  assert.equal(after.outsideSubscriptionBox, 0);
  assert.equal(after.insideSubscriptionBox, 1);
  assert.equal(runtime.lifecycle.incidents[0]?.totalEvents, 1);
});

test("short Blitz reconnect preserves source health; a real quiet gap does not", () => {
  assert.equal(blitzSourceStillHealthy(null, eventTimeMs, 90_000), false);
  assert.equal(blitzSourceStillHealthy(eventTimeMs, eventTimeMs + 10_000, 90_000), true);
  assert.equal(blitzSourceStillHealthy(eventTimeMs, eventTimeMs + 89_999, 90_000), true);
  assert.equal(blitzSourceStillHealthy(eventTimeMs, eventTimeMs + 90_000, 90_000), false);
});

test("worker admits only Blitz; live2 remains a separate shadow source", async () => {
  const worker = await readFile(path.join(import.meta.dirname, "worker.ts"), "utf8");
  assert.match(worker, /blitzAdmission\.admit\(frame\.event/);
  assert.match(worker, /shouldLogBlitzAdmissionRejection\(admission\)/);
  assert.match(worker, /\.\.\.blitzAdmission\.counters/);
  assert.match(worker, /\.\.\.runtime\.summary\(Date\.now\(\)\)/);
  assert.doesNotMatch(worker, /live2\.lightningmaps\.org|parseFrame\(|subscription\(/);
  assert.equal((worker.match(/runtime\.acceptEvent\(/g) ?? []).length, 1);
  const observer = await readFile(path.join(import.meta.dirname,
    "../research/dual-source-observer/runner.ts"), "utf8");
  assert.match(observer, /live2\.lightningmaps\.org/);
});
