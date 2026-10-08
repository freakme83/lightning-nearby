// Research-only shadow policy. This module has no provider or publishing side effects.
import type { DryRunResult } from "../lightning-end-to-end-dry-run/orchestrate.ts";
import type { SourceHealth } from "../lightning-incident-lifecycle/source-health.ts";

export type PublishDecision = {
  decision: "WOULD_PUBLISH" | "HOLD";
  reasonCodes: string[];
  incidentId: string | null;
  messageReady: boolean;
  locationUsable: boolean;
  sourceHealthy: boolean;
  sourceHealthAtTrigger: SourceHealth["state"] | null;
  duplicateIncident: boolean | null;
  persistentHistoryEnabled: boolean;
  capturedAt: string;
};

export type DecisionContext = {
  sourceHealthAtTrigger?: SourceHealth["state"] | null;
  // Set by a storage-independent record matcher. The gate does not query storage.
  knownDuplicate?: boolean;
  persistentHistoryEnabled?: boolean;
  publicationHistoryAvailable?: boolean;
  publicationRecordAvailable?: boolean;
  // Legacy run-scoped fixture context; raw incident IDs are not cross-run identities.
  previouslyPublishedIncidentIds?: ReadonlySet<string>;
  now?: () => string;
};

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function name(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function distinct(left: string | null, right: string | null): boolean {
  return Boolean(left && right && left.toLocaleLowerCase() !== right.toLocaleLowerCase());
}

export function hasUsableGeography(location: DryRunResult["location"]): boolean {
  const normalized = record(record(location).normalized);
  const label = name(normalized.displayLabel);
  if (!label) return false;
  const smallPlace = name(normalized.neighborhood);
  const locality = name(normalized.locality);
  const district = name(normalized.district);
  const province = name(normalized.province);
  const pairs = [
    [smallPlace, district], [smallPlace, locality], [locality, district],
    [locality, province], [district, province],
  ];
  // Both the structured hierarchy and the actual label must carry the useful context.
  const displayed = label.toLocaleLowerCase();
  return pairs.some(([child, parent]) => distinct(child, parent) &&
    displayed.includes(child!.toLocaleLowerCase()) && displayed.includes(parent!.toLocaleLowerCase()));
}

export function decidePublish(result: Pick<DryRunResult, "status" | "paired" | "location" | "message">,
  context: DecisionContext = {}): PublishDecision {
  const paired = record(result.paired);
  const incidentId = name(record(paired.incident).incidentId);
  const enrichment = name(record(paired.enrichment).status);
  const messageReady = result.status === "message_preview_ready" && result.message?.ok === true &&
    Boolean(name(result.message.text));
  const locationUsable = hasUsableGeography(result.location);
  const sourceHealthAtTrigger = context.sourceHealthAtTrigger ?? null;
  const sourceHealthy = sourceHealthAtTrigger === "live";
  const duplicateIncident = context.knownDuplicate ??
    (context.previouslyPublishedIncidentIds === undefined || !incidentId ? null :
      context.previouslyPublishedIncidentIds.has(incidentId));
  const reasonCodes: string[] = [];
  if (!messageReady) reasonCodes.push("message_not_ready");
  if (!locationUsable) reasonCodes.push("location_insufficient");
  if (enrichment === "provider_unavailable") reasonCodes.push("provider_unavailable");
  else if (enrichment && !["cg_verified", "ic_only", "no_match"].includes(enrichment)) reasonCodes.push("invalid_decision_input");
  if (messageReady && !sourceHealthy) reasonCodes.push("source_unhealthy");
  if (duplicateIncident) reasonCodes.push("duplicate_incident");
  if (context.publicationHistoryAvailable === false) reasonCodes.push("publication_history_unavailable");
  if (context.publicationRecordAvailable === false) reasonCodes.push("publication_record_unavailable");
  if (messageReady && (!incidentId || paired.status !== "paired_result" ||
      !result.message?.ok || result.message.incidentId !== incidentId ||
      result.message.enrichmentStatus !== enrichment || !enrichment)) {
    reasonCodes.push("invalid_decision_input");
  }
  return {
    decision: reasonCodes.length ? "HOLD" : "WOULD_PUBLISH",
    reasonCodes: reasonCodes.length ? [...new Set(reasonCodes)] :
      ["message_ready", "location_usable", "supported_enrichment", "source_healthy",
        ...(duplicateIncident === false ? ["no_known_duplicate"] : [])],
    incidentId, messageReady, locationUsable, sourceHealthy, sourceHealthAtTrigger,
    duplicateIncident, persistentHistoryEnabled: context.persistentHistoryEnabled ?? false,
    capturedAt: (context.now ?? (() => new Date().toISOString()))(),
  };
}
