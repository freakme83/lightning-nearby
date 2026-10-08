import type { PublisherResult } from "./publisher.ts";

export function renderPublisherSummary(result: PublisherResult): string {
  const id = /^pub_[0-9a-f]{32}$/.test(result.publicationId) ? result.publicationId : "invalid";
  const postId = result.postId && /^[0-9]+$/.test(result.postId) ? result.postId : null;
  const attemptId = result.attemptId && /^[0-9a-f-]{36}$/i.test(result.attemptId) ? result.attemptId : null;
  return ["## Research Lightning X Publisher", "",
    "- Publication ID: " + id,
    "- Outcome: " + result.outcome,
    ...(postId ? ["- X post ID: " + postId] : []),
    ...(attemptId ? ["- Reserved attempt ID: " + attemptId] : []),
    ...(result.reason ? ["- Detail: " + result.reason] : []),
    ...(result.outcome === "ledger_update_failed" || result.outcome === "publication_uncertain"
      ? ["", "**Manual reconciliation required. Do not rerun blindly or clear the attempt claim before verifying X.**"] : []),
    ""].join("\n");
}
