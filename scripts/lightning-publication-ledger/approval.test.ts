import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { applyManualApproval, type ApprovalCandidate, type ApprovalStore } from "./approval.ts";
import { renderApprovalSummary } from "./approval-summary.ts";
import { approvalExitCode } from "./approval-runner.ts";
import { fingerprintMessage } from "./record.ts";
import { matchPublicationDuplicate } from "./duplicate.ts";
import type { PublicationRecord } from "./types.ts";

const id = `pub_${"a".repeat(32)}`;
const messageText = "#YILDIRIM\n8 Ekim 2026, 09:53 TSİ\nCisterna di Latina / Latina civarında yere ulaşan yıldırım kaydedildi.\n";
const base: ApprovalCandidate = { publicationId: id, decision: "WOULD_PUBLISH", platformPostId: null,
  approvalStatus: "pending", messageFingerprint: fingerprintMessage(messageText), messageText };
function memory(start: ApprovalCandidate | null = base): { store: ApprovalStore; read: () => ApprovalCandidate | null; writes: number } {
  let state = start && { ...start };
  const holder = { writes: 0, read: () => state && { ...state },
    store: { getPublicationForApproval: async () => state && { ...state },
      transitionPendingApproval: async (_id, status) => {
        if (state?.approvalStatus !== "pending") return null;
        holder.writes++;
        state = { ...state, approvalStatus: status };
        return { ...state };
      } } as ApprovalStore };
  return holder;
}

test("pending approves or skips; reruns are idempotent and opposite action conflicts", async () => {
  for (const [action, status, already, opposite] of [
    ["approve", "approved", "already_approved", "skip"],
    ["skip", "skipped", "already_skipped", "approve"],
  ] as const) {
    const { store, read } = memory();
    const first = await applyManualApproval(id, action, store);
    assert.equal(first.outcome, "updated");
    assert.equal(first.previousStatus, "pending");
    assert.equal(first.finalStatus, status);
    assert.equal(first.messageText, messageText);
    assert.equal(read()?.messageText, messageText);
    assert.equal((await applyManualApproval(id, action, store)).outcome, already);
    assert.equal(approvalExitCode(first), 0);
    const conflict = await applyManualApproval(id, opposite, store);
    assert.equal(conflict.outcome, "transition_conflict");
    assert.equal(approvalExitCode(conflict), 1);
    assert.equal(read()?.approvalStatus, status);
  }
});

test("HOLD, PUBLISHED, platform post ID, legacy NULL, missing text, and missing ID are non-actionable", async () => {
  for (const changes of [{ decision: "HOLD" }, { decision: "PUBLISHED" }, { platformPostId: "post-1" },
    { approvalStatus: null }, { messageText: null }, { messageFingerprint: "sha256:wrong" }] as const) {
    const state = memory({ ...base, ...changes } as ApprovalCandidate);
    assert.equal((await applyManualApproval(id, "approve", state.store)).outcome, "not_eligible");
    assert.equal(state.writes, 0);
  }
  assert.equal((await applyManualApproval(id, "approve", memory(null).store)).outcome, "not_found");
  assert.equal((await applyManualApproval("bad-id", "approve", memory().store)).outcome, "not_eligible");
});

test("conditional update prevents same-action and opposite-action races", async () => {
  for (const actions of [["approve", "approve"], ["approve", "skip"]] as const) {
    const state = memory();
    const results = await Promise.all(actions.map(action => applyManualApproval(id, action, state.store)));
    assert.equal(state.writes, 1);
    assert.equal(results.filter(result => result.outcome === "updated").length, 1);
    assert.equal(results[1].outcome, actions[1] === actions[0] ? "already_approved" : "transition_conflict");
    assert.equal(state.read()?.approvalStatus, "approved");
  }
});

test("storage error is sanitized and no state is mutated", async () => {
  const result = await applyManualApproval(id, "approve", {
    getPublicationForApproval: async () => { throw new Error("SECRET_DO_NOT_LEAK"); },
    transitionPendingApproval: async () => { throw new Error("unexpected"); },
  });
  assert.equal(result.outcome, "storage_error");
  assert.doesNotMatch(JSON.stringify(result), /SECRET_DO_NOT_LEAK/);
  assert.match(renderApprovalSummary(result), /No social post was sent\./);
});

test("approval metadata never changes duplicate identity: approved and skipped WOULD_PUBLISH block", () => {
  const record: PublicationRecord = { publicationId: id, runId: "1", incidentId: "i-000001",
    incidentReferenceTime: "2026-10-08T10:00:00Z", incidentLatitude: 41.5, incidentLongitude: 12.8,
    provider: "xweather", enrichmentStatus: "cg_verified", providerEventId: "xweather-event-1",
    providerEventType: "cg", locationLabel: "Cisterna di Latina, Latina",
    messageFingerprint: base.messageFingerprint, decision: "WOULD_PUBLISH", recordedAt: "2026-10-08T10:00:01Z" };
  const candidate = { ...record, publicationId: `pub_${"b".repeat(32)}`, runId: "2" };
  for (const status of ["approved", "skipped"] as const) {
    const prior = { ...record, approvalStatus: status } as PublicationRecord;
    assert.equal(matchPublicationDuplicate(candidate, [prior]).reason, "same_provider_event");
  }
  assert.equal(matchPublicationDuplicate(candidate, [{ ...record, decision: "HOLD" }]).duplicate, false);
});

test("approval result displays exact persisted text, with no publishing integration or X secrets", async () => {
  const result = await applyManualApproval(id, "approve", memory().store);
  assert.ok(renderApprovalSummary(result).includes(`\`\`\`text\n${messageText}\n\`\`\``));
  const workflow = await readFile(new URL("../../.github/workflows/research-lightning-manual-approval.yml", import.meta.url), "utf8");
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /SUPABASE_URL: \$\{\{ secrets\.SUPABASE_URL \}\}/);
  assert.match(workflow, /SUPABASE_SERVICE_ROLE_KEY: \$\{\{ secrets\.SUPABASE_SERVICE_ROLE_KEY \}\}/);
  assert.doesNotMatch(workflow, /XWEATHER|X_API|TWITTER|webhook|schedule:|^  push:/im);
  const approvalStep = workflow.split("- name: Apply manual approval")[1].split("- name: Upload structured approval result")[0];
  assert.equal(workflow.match(/SUPABASE_SERVICE_ROLE_KEY/g)?.length, 2);
  assert.match(approvalStep, /APPROVAL_ACTION: \$\{\{ inputs\.action \}\}/);
  assert.match(approvalStep, /PUBLICATION_ID: \$\{\{ inputs\.publicationId \}\}/);
  const code = await readFile(new URL("./approval-runner.ts", import.meta.url), "utf8");
  assert.doesNotMatch(code, /XWEATHER|X_API|TWITTER|webhook|https?:\/\//i);
});

test("historical public URL text remains the immutable approval payload", async () => {
  const historicalText = messageText + "https://www.google.com/maps?q=41.4784,12.8168";
  const state = memory({ ...base, messageText: historicalText,
    messageFingerprint: fingerprintMessage(historicalText), mapUrl: null });
  const result = await applyManualApproval(id, "approve", state.store);
  assert.equal(result.outcome, "updated");
  assert.equal(result.messageText, historicalText);
  assert.equal(state.read()?.messageFingerprint, fingerprintMessage(historicalText));
  assert.ok(renderApprovalSummary(result).includes(`\`\`\`text\n${historicalText}\n\`\`\``));
  assert.doesNotMatch(renderApprovalSummary(result), /### Internal map/);
});

test("operator map is separate from exact message and unsafe map values are not rendered", async () => {
  const mapUrl = "https://www.google.com/maps?q=41.4784,12.8168";
  const result = await applyManualApproval(id, "approve", memory({ ...base, mapUrl }).store);
  assert.equal(result.mapUrl, mapUrl);
  assert.ok(renderApprovalSummary(result).includes(`\`\`\`text\n${messageText}\n\`\`\`\n\n### Internal map\n\n${mapUrl}`));
  assert.doesNotMatch(renderApprovalSummary({ ...result, mapUrl: "https://evil.example\n# FAKE" }), /evil|FAKE|### Internal map/);
});
