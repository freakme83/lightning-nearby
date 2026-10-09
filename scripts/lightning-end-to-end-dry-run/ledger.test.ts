import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { continueFromPairedArtifact, withPublishDecision } from "./orchestrate.ts";
import { renderEndToEndSummary } from "./summary.ts";
import { applyPersistentLedger } from "./ledger.ts";
import { PAIRED_ARTIFACT_FIXTURES } from "../lightning-message-preview/fixtures.ts";
import type { PublicationRecord } from "../lightning-publication-ledger/types.ts";
import type { LedgerStore } from "../lightning-publication-ledger/storage/supabase.ts";

const context = { sourceHealthAtTrigger: "live" as const, now: () => "2026-10-08T11:00:00.000Z" };
const place = { latitude: 41.5, longitude: 12.8, provider: "nominatim" as const,
  country: "Italy", locality: "Lenola", district: "Latina", province: "Lazio", displayLabel: "Lenola, Latina" };
async function completed(name: keyof typeof PAIRED_ARTIFACT_FIXTURES = "cg_verified") {
  return withPublishDecision(await continueFromPairedArtifact(PAIRED_ARTIFACT_FIXTURES[name], {
    reverse: async () => place,
  }), context);
}
function store(history: PublicationRecord[] = []) {
  const written: PublicationRecord[] = [];
  const messages: string[] = [];
  const storage: LedgerStore = { loadRelevantPublicationHistory: async () => history,
    insertPublicationRecord: async (record, exactMessageText) => { written.push(record); messages.push(exactMessageText); return "inserted"; } };
  return { storage, written, messages };
}

test("first candidate persists final WOULD_PUBLISH and keeps exact composer text", async () => {
  const result = await completed();
  const { storage, written, messages } = store();
  const final = await applyPersistentLedger(result, context, storage, { runId: "run-1" });
  assert.equal(final.publishDecision?.decision, "WOULD_PUBLISH");
  assert.equal(final.status, "message_preview_ready");
  assert.equal(final.message?.text, result.message?.text);
  assert.equal(final.ledger?.storageStatus, "ok");
  assert.equal(final.ledger?.recordPersisted, true);
  assert.equal(written[0].decision, "WOULD_PUBLISH");
  assert.equal(written[0].runId, "run-1");
  assert.equal(messages[0], result.message?.text);
  assert.equal(final.ledger?.approvalStatus, "pending");
  assert.match(renderEndToEndSummary(final), /## Publication ledger[\s\S]*Dry run only\. Nothing was published\./);
  assert.match(renderEndToEndSummary(final), /## Manual approval[\s\S]*Approval status: pending/);
});

test("stored WOULD_PUBLISH and PUBLISHED block; stored HOLD cannot block either path", async () => {
  for (const name of ["cg_verified", "no_match"] as const) {
    const result = await completed(name);
    const first = store();
    await applyPersistentLedger(result, context, first.storage, { runId: "run-1" });
    const prior = first.written[0];
    for (const decision of ["WOULD_PUBLISH", "PUBLISHED", "HOLD"] as const) {
      const next = store([{ ...prior, decision }]);
      const final = await applyPersistentLedger(result, context, next.storage, { runId: "run-2" });
      assert.equal(final.publishDecision?.decision, decision === "HOLD" ? "WOULD_PUBLISH" : "HOLD");
      assert.equal(final.ledger?.duplicateMatch?.duplicate, decision !== "HOLD");
      assert.equal(next.written[0].decision, final.publishDecision?.decision);
      assert.equal(final.ledger?.approvalStatus, decision === "HOLD" ? "pending" : null);
      if (decision !== "HOLD") assert.ok(final.publishDecision?.reasonCodes.includes("duplicate_incident"));
    }
  }
});

test("missing configuration, read outage, and write outage safely HOLD", async () => {
  const result = await completed();
  const missing = await applyPersistentLedger(result, context, null, { configured: true });
  assert.equal(missing.publishDecision?.decision, "HOLD");
  assert.ok(missing.publishDecision?.reasonCodes.includes("publication_history_unavailable"));
  assert.equal(missing.ledger?.storageStatus, "not_configured");
  const read = await applyPersistentLedger(result, context, {
    loadRelevantPublicationHistory: async () => { throw new Error("SECRET_DO_NOT_LEAK"); },
    insertPublicationRecord: async () => { throw new Error("unexpected write"); },
  });
  assert.equal(read.publishDecision?.decision, "HOLD");
  assert.equal(read.ledger?.storageStatus, "read_failed");
  assert.doesNotMatch(JSON.stringify(read), /SECRET_DO_NOT_LEAK/);
  const write = await applyPersistentLedger(result, context, {
    loadRelevantPublicationHistory: async () => [],
    insertPublicationRecord: async () => { throw new Error("write failed"); },
  });
  assert.equal(write.publishDecision?.decision, "HOLD");
  assert.ok(write.publishDecision?.reasonCodes.includes("publication_record_unavailable"));
  assert.equal(write.ledger?.storageStatus, "write_failed");
  assert.equal(write.ledger?.recordPersisted, false);
});

test("provider unique race is re-read, duplicate becomes HOLD, and HOLD audit write succeeds", async () => {
  const result = await completed();
  const first = store();
  await applyPersistentLedger(result, context, first.storage, { runId: "run-1" });
  let reads = 0;
  const written: PublicationRecord[] = [];
  const final = await applyPersistentLedger(result, context, {
    loadRelevantPublicationHistory: async () => ++reads === 1 ? [] : first.written,
    insertPublicationRecord: async record => {
      if (record.decision === "WOULD_PUBLISH") throw new Error("unique provider event violation");
      written.push(record); return "inserted";
    },
  }, { runId: "run-2" });
  assert.equal(final.publishDecision?.decision, "HOLD");
  assert.ok(final.publishDecision?.reasonCodes.includes("duplicate_incident"));
  assert.equal(final.ledger?.duplicateMatch?.reason, "same_provider_event");
  assert.equal(final.ledger?.storageStatus, "write_failed");
  assert.equal(written[0].decision, "HOLD");
});

test("no-result never accesses storage; provider-unavailable remains HOLD; reactivation alone does not block", async () => {
  let calls = 0;
  const storage: LedgerStore = {
    loadRelevantPublicationHistory: async () => { calls++; return []; },
    insertPublicationRecord: async () => { calls++; return "inserted"; },
  };
  const noResult = withPublishDecision(await continueFromPairedArtifact({ status: "no_publish_candidate" }), context);
  assert.equal(await applyPersistentLedger(noResult, context, storage), noResult);
  assert.equal(calls, 0);
  const unavailable = await applyPersistentLedger(await completed("provider_unavailable"), context, storage);
  assert.equal(unavailable.publishDecision?.decision, "HOLD");
  assert.ok(unavailable.publishDecision?.reasonCodes.includes("provider_unavailable"));
  const result = await completed();
  if (result.paired) result.paired.triggerMode = "reactivated_after_stale_publish";
  const reactivated = await applyPersistentLedger(result, context, storage);
  assert.equal(reactivated.publishDecision?.decision, "WOULD_PUBLISH");
});

test("manual workflow confines ledger secrets to orchestration step", async () => {
  const workflow = await readFile(new URL("../../.github/workflows/research-lightning-end-to-end-dry-run.yml", import.meta.url), "utf8");
  const orchestration = workflow.split("- name: Run research-only orchestration")[1].split("- name: Upload structured result")[0];
  assert.match(orchestration, /SUPABASE_URL: \$\{\{ secrets\.SUPABASE_URL \}\}/);
  assert.match(orchestration, /SUPABASE_SERVICE_ROLE_KEY: \$\{\{ secrets\.SUPABASE_SERVICE_ROLE_KEY \}\}/);
  assert.equal(workflow.match(/SUPABASE_SERVICE_ROLE_KEY/g)?.length, 2);
});
