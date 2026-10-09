import type { SourceHealth } from "../lightning-incident-lifecycle/source-health.ts";
import type { DryRunResult } from "./orchestrate.ts";

type State = SourceHealth["state"];
const states = new Set<State>(["connecting", "live", "stale", "disconnected"]);

// Read the already-captured research JSONL. The live runner intentionally disconnects
// after claiming enrichment, so its final source state is not the trigger state.
export function sourceHealthAtPairedTrigger(log: string, paired: DryRunResult["paired"]): State | null {
  const incident = paired?.incident;
  if (!incident || typeof incident !== "object" || Array.isArray(incident)) return null;
  const incidentId = (incident as Record<string, unknown>).incidentId;
  const trigger = paired?.triggerMode === "reactivated_after_stale_publish"
    ? "paired_validation_reactivated" : "WOULD_PUBLISH";
  let current: State | null = null;
  let atTrigger: State | null = null;
  for (const line of log.split("\n")) {
    let event: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
      event = parsed as Record<string, unknown>;
    } catch { continue; }
    if (event.kind === "source_health") {
      current = typeof event.to === "string" && states.has(event.to as State) ? event.to as State : null;
    }
    if (event.kind === trigger && event.incidentId === incidentId) atTrigger = current;
  }
  return atTrigger;
}
