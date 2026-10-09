import type { MonitorResult } from "./runner.ts";

function fence(text: string): string {
  const runs = Array.from(text.matchAll(/`+/g), ([run]) => run.length);
  return "`".repeat(Math.max(3, ...runs.map(size => size + 1)));
}

function display(value: string | number | boolean | null): string {
  return value === null ? "not available" : String(value).replaceAll("|", "\\|").replaceAll("\n", " ");
}

export function renderMonitorSummary(result: MonitorResult): string {
  const rows = [
    "## Ankara monitor result",
    "",
    "- Monitor mode: Ankara",
    `- Run start: ${display(result.runStartedAt)}`,
    `- Run end: ${display(result.runEndedAt)}`,
    `- Outcome: ${result.outcome}`,
    `- Source health: ${display(result.sourceHealth)}`,
    `- Candidate found: ${result.candidateFound ? "yes" : "no"}`,
    `- Candidate publication ID: ${display(result.publicationId)}`,
    `- Decision: ${display(result.decision)}`,
    `- Approval status: ${display(result.approvalStatus)}`,
    `- Location label: ${display(result.locationLabel)}`,
    `- Enrichment status: ${display(result.enrichmentStatus)}`,
    `- Duplicate/history outcome: ${result.historyOutcome}${result.duplicate === null ? "" : ` (duplicate: ${result.duplicate ? "yes" : "no"})`}`,
    `- Xweather request attempted / enrichment calls: ${display(result.xweatherRequestAttempted)} / ${display(result.xweatherRequestCount)}`,
    ...(result.reason ? [`- Detail: ${result.reason}`] : []),
  ];
  if (result.messageText !== null) {
    const marker = fence(result.messageText);
    const trailingLineBreak = result.messageText.endsWith("\n") ? "" : "\n";
    rows.push("", "### Exact candidate message", "",
      `${marker}text\n${result.messageText}${trailingLineBreak}${marker}`);
  }
  if (result.outcome === "no_publish_candidate" || result.outcome === "no_fresh_publish_candidate") {
    rows.push("", "No actionable fresh publication candidate was found in this monitoring window.");
  }
  rows.push("", "No social post was sent.", "");
  return rows.join("\n");
}
