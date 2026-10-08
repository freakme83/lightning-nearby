import { fingerprintMessage } from "./record.ts";
import type { PublicationRecord } from "./types.ts";

export type ApprovalAction = "approve" | "skip";
export type ApprovalStatus = "pending" | "approved" | "skipped";
export type ApprovalCandidate = {
  publicationId: string;
  decision: PublicationRecord["decision"];
  platformPostId: string | null;
  approvalStatus: ApprovalStatus | null;
  messageFingerprint: string;
  messageText: string | null;
};
export type ApprovalStore = {
  getPublicationForApproval(publicationId: string): Promise<ApprovalCandidate | null>;
  transitionPendingApproval(publicationId: string, status: "approved" | "skipped",
    actor: string | null, updatedAt: string): Promise<ApprovalCandidate | null>;
};
export type ApprovalOutcome = "updated" | "already_approved" | "already_skipped" |
  "not_found" | "not_eligible" | "transition_conflict" | "storage_error";
export type ApprovalResult = {
  publicationId: string;
  requestedAction: ApprovalAction;
  previousStatus: ApprovalStatus | null;
  finalStatus: ApprovalStatus | null;
  outcome: ApprovalOutcome;
  decision: PublicationRecord["decision"] | null;
  messageText: string | null;
  reason: string | null;
};

function eligible(row: ApprovalCandidate): boolean {
  return row.decision === "WOULD_PUBLISH" && row.platformPostId === null &&
    typeof row.messageText === "string" && row.messageText.length > 0 &&
    fingerprintMessage(row.messageText) === row.messageFingerprint &&
    ["pending", "approved", "skipped"].includes(row.approvalStatus ?? "");
}

// The store performs a conditional pending-only UPDATE. No publication side effect.
export async function applyManualApproval(publicationId: string, action: ApprovalAction,
  store: ApprovalStore, options: { actor?: string | null; now?: () => string } = {}): Promise<ApprovalResult> {
  const target = action === "approve" ? "approved" : "skipped";
  const base: ApprovalResult = { publicationId, requestedAction: action, previousStatus: null,
    finalStatus: null, outcome: "storage_error", decision: null, messageText: null, reason: null };
  if (!/^pub_[0-9a-f]{32}$/.test(publicationId) || !["approve", "skip"].includes(action)) {
    return { ...base, outcome: "not_eligible", reason: "Invalid publication ID or action." };
  }
  try {
    const existing = await store.getPublicationForApproval(publicationId);
    if (!existing) return { ...base, outcome: "not_found", reason: "Publication record was not found." };
    const details = { ...base, previousStatus: existing.approvalStatus, finalStatus: existing.approvalStatus,
      decision: existing.decision, messageText: existing.messageText };
    if (existing.publicationId !== publicationId || !eligible(existing)) return { ...details, outcome: "not_eligible",
      reason: "The record is not an actionable, complete WOULD_PUBLISH candidate." };
    if (existing.approvalStatus === target) return { ...details,
      outcome: target === "approved" ? "already_approved" : "already_skipped" };
    if (existing.approvalStatus !== "pending") return { ...details, outcome: "transition_conflict",
      reason: "An opposite human decision was already recorded." };
    const updatedAt = (options.now ?? (() => new Date().toISOString()))();
    if (!Number.isFinite(Date.parse(updatedAt))) return { ...details, outcome: "storage_error", reason: "Invalid update time." };
    const updated = await store.transitionPendingApproval(publicationId, target, options.actor?.trim() || null, updatedAt);
    if (updated) {
      if (updated.publicationId !== publicationId || !eligible(updated) || updated.approvalStatus !== target || updated.messageText !== existing.messageText ||
          updated.messageFingerprint !== existing.messageFingerprint) {
        return { ...details, outcome: "storage_error", reason: "Updated record did not match the approved candidate." };
      }
      return { ...details, finalStatus: target, outcome: "updated" };
    }
    // Another operator won the pending-only update. Inspect the winner; never overwrite it.
    const winner = await store.getPublicationForApproval(publicationId);
    if (!winner) return { ...details, outcome: "storage_error", reason: "Record disappeared during approval." };
    if (winner.publicationId !== publicationId || !eligible(winner) || winner.messageText !== existing.messageText ||
        winner.messageFingerprint !== existing.messageFingerprint) {
      return { ...details, outcome: "storage_error", reason: "Record changed unexpectedly during approval." };
    }
    if (winner.approvalStatus === target) return { ...details, finalStatus: target,
      outcome: target === "approved" ? "already_approved" : "already_skipped" };
    if (winner.approvalStatus !== "pending") return { ...details, finalStatus: winner.approvalStatus,
      outcome: "transition_conflict", reason: "An opposite human decision won the concurrent transition." };
    return { ...details, outcome: "storage_error", reason: "Conditional approval update did not affect the pending row." };
  } catch {
    return { ...base, outcome: "storage_error", reason: "Approval storage request failed." };
  }
}
