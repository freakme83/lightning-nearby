import { randomUUID } from "node:crypto";
import { fingerprintMessage } from "../lightning-publication-ledger/record.ts";
import type { XPostResult } from "./x-adapter.ts";

export type PublishRow = {
  publicationId: string;
  enrichmentStatus: "cg_verified" | "ic_only" | "no_match" | "provider_unavailable";
  decision: "WOULD_PUBLISH" | "HOLD" | "PUBLISHED";
  approvalStatus: "pending" | "approved" | "skipped" | null;
  platformPostId: string | null;
  messageText: string | null;
  messageFingerprint: string;
  publishAttemptId: string | null;
  publishedAt: string | null;
};

function safePublicText(row: PublishRow): boolean {
  const value = row.messageText;
  if (!value || /https?:\/\/|www\./i.test(value)) return false;
  const coordinate = /\n\n(-?\d{1,2}(?:\.\d{3})), (-?\d{1,3}(?:\.\d{3}))$/;
  if (row.enrichmentStatus !== "cg_verified") {
    return value.startsWith("#ŞİMŞEK\n") && !/(?:^|\n)-?\d+(?:\.\d+)?,\s*-?\d+(?:\.\d+)?(?:\n|$)/.test(value);
  }
  const match = coordinate.exec(value);
  return value.startsWith("#YILDIRIM\n") && !!match &&
    Math.abs(Number(match[1])) <= 90 && Math.abs(Number(match[2])) <= 180;
}
export type PublisherStore = {
  get(publicationId: string): Promise<PublishRow | null>;
  claim(row: PublishRow, attemptId: string): Promise<PublishRow | null>;
  finalize(publicationId: string, attemptId: string, postId: string, publishedAt: string): Promise<PublishRow | null>;
};
export type PublisherResult = {
  publicationId: string;
  outcome: "published" | "already_published" | "not_found" | "not_eligible" | "disabled" |
    "missing_credentials" | "transition_conflict" | "definite_failure" | "publication_uncertain" |
    "ledger_update_failed" | "storage_error";
  postId: string | null;
  attemptId: string | null;
  reason: string | null;
};

export async function publishApproved(publicationId: string, store: PublisherStore,
  x: { createPost(text: string): Promise<XPostResult> },
  options: { enabled: boolean; credentialsPresent: boolean; now?: () => string; attemptId?: () => string }): Promise<PublisherResult> {
  const result = (outcome: PublisherResult["outcome"], reason: string | null = null,
    postId: string | null = null, attemptId: string | null = null): PublisherResult =>
    ({ publicationId, outcome, reason, postId, attemptId });
  if (!/^pub_[0-9a-f]{32}$/.test(publicationId)) return result("not_eligible", "Invalid publication ID.");
  let row: PublishRow | null;
  try { row = await store.get(publicationId); }
  catch { return result("storage_error", "Publication record read failed."); }
  if (!row) return result("not_found", "Publication record was not found.");
  if (row.publicationId !== publicationId) return result("storage_error", "Publication record identity mismatch.");
  if (row.decision === "PUBLISHED" && row.platformPostId) return result("already_published", null, row.platformPostId);
  if (row.publishAttemptId) return result("publication_uncertain", "A prior attempt is reserved; manual reconciliation required.", row.platformPostId, row.publishAttemptId);
  if (row.decision !== "WOULD_PUBLISH" || row.approvalStatus !== "approved" || row.platformPostId !== null ||
      row.publishedAt !== null ||
      typeof row.messageText !== "string" || !row.messageText.length ||
      fingerprintMessage(row.messageText) !== row.messageFingerprint || !safePublicText(row)) {
    return result("not_eligible", "Record is not an approved, complete, unchanged candidate.");
  }
  if (!options.enabled) return result("disabled", "X_PUBLISHING_ENABLED is not exactly true.");
  if (!options.credentialsPresent) return result("missing_credentials", "X credentials are incomplete.");
  const attemptId = (options.attemptId ?? randomUUID)();
  let claimed: PublishRow | null;
  try { claimed = await store.claim(row, attemptId); }
  catch { return result("storage_error", "Attempt claim failed; inspect the ledger before retrying.", null, attemptId); }
  if (!claimed) return result("transition_conflict", "The conditional attempt claim did not affect a row.", null, attemptId);
  if (claimed.publicationId !== publicationId || claimed.publishAttemptId !== attemptId ||
      claimed.decision !== "WOULD_PUBLISH" || claimed.approvalStatus !== "approved" ||
      claimed.platformPostId !== null || claimed.publishedAt !== null ||
      claimed.enrichmentStatus !== row.enrichmentStatus || claimed.messageText !== row.messageText ||
      claimed.messageFingerprint !== row.messageFingerprint) {
    return result("publication_uncertain", "Claimed record changed; manual reconciliation required.", null, attemptId);
  }
  let posted: XPostResult;
  try { posted = await x.createPost(row.messageText); }
  catch { return result("publication_uncertain", "X transport failed; manual reconciliation required.", null, attemptId); }
  if (posted.outcome === "definite_failure") {
    return result("definite_failure", "X rejected the request (HTTP " + posted.status + "); attempt remains reserved.", null, attemptId);
  }
  if (posted.outcome === "publication_uncertain") {
    return result("publication_uncertain", "X outcome is uncertain (" + posted.reason + "); manual reconciliation required.", null, attemptId);
  }
  const publishedAt = (options.now ?? (() => new Date().toISOString()))();
  if (!Number.isFinite(Date.parse(publishedAt))) {
    return result("ledger_update_failed", "X post created, ledger update failed — manual reconciliation required", posted.postId, attemptId);
  }
  try {
    const updated = await store.finalize(publicationId, attemptId, posted.postId, publishedAt);
    if (updated && updated.publicationId === publicationId && updated.publishAttemptId === attemptId &&
        updated.decision === "PUBLISHED" && updated.approvalStatus === "approved" &&
        updated.platformPostId === posted.postId && updated.publishedAt !== null &&
        Date.parse(updated.publishedAt) === Date.parse(publishedAt)) {
      return result("published", null, posted.postId, attemptId);
    }
  } catch { /* The reserved attempt prevents another blind post. */ }
  return result("ledger_update_failed", "X post created, ledger update failed — manual reconciliation required", posted.postId, attemptId);
}
