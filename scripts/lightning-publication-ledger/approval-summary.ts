import type { ApprovalResult } from "./approval.ts";

function fencedText(text: string): string {
  const longestRun = Math.max(0, ...Array.from(text.matchAll(/`+/g), ([run]) => run.length));
  const fence = "`".repeat(Math.max(3, longestRun + 1));
  return `${fence}text\n${text}\n${fence}`;
}

export function renderApprovalSummary(result: ApprovalResult): string {
  const safeId = /^pub_[0-9a-f]{32}$/.test(result.publicationId) ? result.publicationId : "invalid";
  const safeAction = result.requestedAction === "approve" || result.requestedAction === "skip" ? result.requestedAction : "invalid";
  const rows = ["## Manual approval result", "",
    `- Publication ID: ${safeId}`,
    `- Existing publish decision: ${result.decision ?? "not available"}`,
    `- Previous approval status: ${result.previousStatus ?? "not available"}`,
    `- Requested action: ${safeAction}`,
    `- Final approval status: ${result.finalStatus ?? "not available"}`,
    `- Outcome: ${result.outcome}`,
    ...(result.reason ? [`- Reason: ${result.reason}`] : []),
    "", "### Exact candidate message", "",
    result.messageText ? fencedText(result.messageText) : "No actionable candidate message is available.",
    ...(result.mapUrl && /^https:\/\/www\.google\.com\/maps\?q=-?\d+(?:\.\d+)?,-?\d+(?:\.\d+)?$/.test(result.mapUrl)
      ? ["", "### Internal map", "", result.mapUrl] : []),
    "", "No social post was sent.", ""];
  return rows.join("\n");
}
