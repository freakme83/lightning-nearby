import type { PublisherResult } from "./publisher.ts";

export function renderPublisherSummary(result: PublisherResult): string {
  const id = /^pub_[0-9a-f]{32}$/.test(result.publicationId) ? result.publicationId : "invalid";
  const postId = result.postId && /^[0-9]+$/.test(result.postId) ? result.postId : null;
  const attemptId = result.attemptId && /^[0-9a-f-]{36}$/i.test(result.attemptId) ? result.attemptId : null;
  const message = result.messageText;
  const fence = "`".repeat(Math.max(3, ...((message ?? "").match(/`+/g) ?? []).map(run => run.length + 1)));
  return ["## X publication result", "",
    "- Publication ID: " + id,
    ...(result.approvalStatus !== null ? ["- Approval status: " + result.approvalStatus] : []),
    ...(result.previousDecision ? ["- Previous publish decision: " + result.previousDecision] : []),
    ...(result.finalDecision ? ["- Final publish decision: " + result.finalDecision] : []),
    "- X outcome: " + result.outcome,
    ...(postId ? ["- X post ID: " + postId] : []),
    ...(result.publishedAt ? ["- Published at: " + result.publishedAt] : []),
    ...(attemptId ? ["- " + (result.outcome === "definite_failure" ? "Released attempt ID: " : "Reserved attempt ID: ") + attemptId] : []),
    ...(result.mapUrl ? ["- Internal map URL: " + result.mapUrl] : []),
    ...(result.reason ? ["- Detail: " + result.reason] : []),
    ...(message !== null ? ["", "### Exact candidate message", "", fence + "text", message + (message.endsWith("\n") ? "" : "\n") + fence] : []),
    ...(result.outcome === "ledger_update_failed" || result.outcome === "publication_uncertain"
      ? ["", "**Manual reconciliation required. Do not rerun blindly or clear the attempt claim before verifying X.**"] : []),
    ""].join("\n");
}
