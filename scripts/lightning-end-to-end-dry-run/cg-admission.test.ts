import assert from "node:assert/strict";
import { test } from "node:test";
import { continueFromPairedArtifact, withPublishDecision } from "./orchestrate.ts";
import { applyPersistentLedger } from "./ledger.ts";
import { PAIRED_ARTIFACT_FIXTURES } from "../lightning-message-preview/fixtures.ts";
import type { LedgerStore } from "../lightning-publication-ledger/storage/supabase.ts";
import type { PublicationRecord } from "../lightning-publication-ledger/types.ts";
import { CG_REPEAT_POLICY_VERSION } from "../lightning-cg-repeat-policy/constants.ts";
import { normalizeAndLabel, extractProviderAddressHierarchy } from "../lightning-location-naming/normalize.ts";
import type { CgAdmissionRequest } from "../lightning-cg-repeat-policy/admission.ts";

const context = { sourceHealthAtTrigger: "live" as const, cgRepeatGate: { eligible: true } };
const admission: CgAdmissionRequest = { scopeId: "scope", kind: "repeat", policyVersion: CG_REPEAT_POLICY_VERSION,
  suppressionReason: "already_published_active_incident", referenceTime: "2026-10-11T12:00:00Z", repeatReadyAt: "2026-10-11T11:00:00Z" };
async function completed(repeat = true) {
  const artifact = structuredClone(PAIRED_ARTIFACT_FIXTURES.cg_verified) as Record<string, unknown>;
  if (repeat) artifact.triggerMode = "cg_repeat_probe";
  const payload = { address: { neighbourhood: "Balgat", town: "Çankaya", county: "Çankaya", province: "Ankara", country: "Türkiye" } };
  return withPublishDecision(await continueFromPairedArtifact(artifact, { reverse: async (latitude, longitude) => ({
    latitude, longitude, provider: "fixture", ...normalizeAndLabel(payload), providerAddress: extractProviderAddressHierarchy(payload),
  }) }), context);
}

test("repeat gate and atomic request are required independently", async () => {
  const result = await completed(); let positiveWrites = 0;
  const store: LedgerStore = { async loadRelevantPublicationHistory() { return []; },
    async insertPublicationRecord(row) { if (row.decision === "WOULD_PUBLISH") positiveWrites++; return "inserted"; } };
  assert.equal(withPublishDecision(result, { sourceHealthAtTrigger: "live" }).publishDecision?.decision, "HOLD");
  const noRequest = await applyPersistentLedger(result, context, store);
  assert.equal(noRequest.publishDecision?.decision, "HOLD");
  const noAtomicStore = await applyPersistentLedger(result, context, store, { cgAdmission: admission });
  assert.equal(noAtomicStore.publishDecision?.decision, "HOLD");
  assert.equal(positiveWrites, 0);
});

test("persistent duplicate beats override before RPC", async () => {
  const result = await completed(); let prior: PublicationRecord | undefined; let calls = 0;
  const seed: LedgerStore = { async loadRelevantPublicationHistory() { return []; },
    async insertPublicationRecord(row) { prior = row; return "inserted"; } };
  await applyPersistentLedger(await completed(false), context, seed, { runId: "seed" });
  const store: LedgerStore = { async loadRelevantPublicationHistory() { return [prior!]; },
    async insertPublicationRecord(row) { assert.equal(row.decision, "HOLD"); return "inserted"; },
    async admitCgPublication() { calls++; throw new Error("must never reach admission"); } };
  const final = await applyPersistentLedger(result, context, store, { runId: "repeat", cgAdmission: admission });
  assert.equal(final.publishDecision?.decision, "HOLD"); assert.equal(calls, 0);
  assert.equal(final.ledger?.duplicateMatch?.reason, "same_provider_event");
});

test("atomic semantic/burst denial remains HOLD through decision recomputation", async () => {
  for (const reason of ["same_semantic_location", "burst_limit", "history_unavailable"]) {
    const store: LedgerStore = { async loadRelevantPublicationHistory() { return []; },
      async insertPublicationRecord() { throw new Error("must not insert directly"); },
      async admitCgPublication() { return { outcome: "suppressed", reason }; } };
    const final = await applyPersistentLedger(await completed(), context, store, { cgAdmission: admission });
    assert.equal(final.publishDecision?.decision, "HOLD"); assert.equal(final.ledger?.recordPersisted, false);
    assert.equal(final.ledger?.approvalStatus, null);
  }
});

test("ambiguous committed insert is conservatively reserved and cannot dispatch", async () => {
  let committed: PublicationRecord | undefined; let reads = 0;
  const store: LedgerStore = { async loadRelevantPublicationHistory() { reads++; return committed ? [committed] : []; },
    async insertPublicationRecord(row) { assert.equal(row.decision, "HOLD"); return "already_present"; },
    async admitCgPublication(row) { committed = row; throw new Error("response lost after commit"); } };
  const final = await applyPersistentLedger(await completed(), context, store, { cgAdmission: admission });
  assert.equal(final.publishDecision?.decision, "HOLD"); assert.equal(final.ledger?.approvalStatus, null);
  assert.equal(final.ledger?.storageStatus, "write_failed"); assert.equal(committed!.decision, "WOULD_PUBLISH");
  assert.equal(reads, 2);
});

test("initial CG counts through RPC; duplicate/HOLD cannot consume a CG slot", async () => {
  let calls = 0;
  const store: LedgerStore = { async loadRelevantPublicationHistory() { return []; },
    async insertPublicationRecord(row) { assert.equal(row.decision, "HOLD"); return "inserted"; },
    async admitCgPublication(row, _text, request) {
      calls++; assert.equal(request.kind, "initial"); assert.equal(row.cgScopeId, "scope");
      assert.ok(row.cgMetadata); return { outcome: "inserted", reason: "admitted", rollingCount: 1 };
    } };
  const result = await completed(false);
  const first = await applyPersistentLedger(result, context, store, { cgAdmission: { ...admission, kind: "initial" } });
  assert.equal(first.ledger?.cgAdmission?.rollingCount, 1); assert.equal(first.ledger?.approvalStatus, "pending");
  await applyPersistentLedger(result, { ...context, knownDuplicate: true }, store, { cgAdmission: { ...admission, kind: "initial" } });
  assert.equal(calls, 1);
});

test("initial RPC duplicate race returns HOLD, never a fresh positive decision", async () => {
  const store: LedgerStore = { async loadRelevantPublicationHistory() { return []; },
    async insertPublicationRecord() { throw new Error("unexpected"); },
    async admitCgPublication() { return { outcome: "suppressed", reason: "same_provider_event" }; } };
  const final = await applyPersistentLedger(await completed(false), context, store, { cgAdmission: { ...admission, kind: "initial" } });
  assert.equal(final.publishDecision?.decision, "HOLD"); assert.equal(final.ledger?.recordPersisted, false);
});
