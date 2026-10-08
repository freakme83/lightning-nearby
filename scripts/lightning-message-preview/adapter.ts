import { composeLightningMessage } from "../lightning-message-composer/compose.ts";
import type { ComposerEnrichmentStatus, ComposerInput } from "../lightning-message-composer/types.ts";
import type { PairedMessagePreview, PairedPreviewInput, PairedSourceStatus, PairedTriggerMode } from "./types.ts";

const statuses = new Set<ComposerEnrichmentStatus>(["cg_verified", "ic_only", "no_match", "provider_unavailable"]);
const sourceStatuses = new Set<PairedSourceStatus>([
  "paired_result", "no_publish_candidate", "no_fresh_publish_candidate",
]);

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sourceStatus(value: unknown): PairedSourceStatus {
  const status = record(value) ? value.status : undefined;
  return typeof status === "string" && sourceStatuses.has(status as PairedSourceStatus)
    ? status as PairedSourceStatus : "unknown";
}

function unavailable(input: PairedPreviewInput, status: PairedSourceStatus,
  code: "not_paired_result" | "malformed_paired_artifact", message: string): PairedMessagePreview {
  return {
    ok: false, sourceStatus: status, locationDisplayLabel: input.locationDisplayLabel,
    error: { code, message }, text: null, characterCount: null, mapUrl: null,
  };
}

export function previewPairedMessage(input: PairedPreviewInput): PairedMessagePreview {
  const artifact = input.artifact;
  const status = sourceStatus(artifact);
  if (status === "no_publish_candidate" || status === "no_fresh_publish_candidate") {
    return unavailable(input, status, "not_paired_result", "This artifact has no paired enrichment result to compose.");
  }
  if (status !== "paired_result" || !record(artifact)) {
    return unavailable(input, status, "malformed_paired_artifact", "A paired_result artifact is required.");
  }

  const triggerMode = artifact.triggerMode;
  const incident = artifact.incident;
  const enrichment = artifact.enrichment;
  if ((triggerMode !== "fresh_would_publish" && triggerMode !== "reactivated_after_stale_publish") ||
      !record(incident) || typeof incident.incidentId !== "string" || !incident.incidentId.trim() ||
      typeof incident.lastActivityTimeMs !== "number" || !Number.isSafeInteger(incident.lastActivityTimeMs) ||
      !record(enrichment) || typeof enrichment.status !== "string" ||
      !statuses.has(enrichment.status as ComposerEnrichmentStatus)) {
    return unavailable(input, status, "malformed_paired_artifact", "Required paired incident or enrichment fields are invalid.");
  }

  const enrichmentStatus = enrichment.status as ComposerEnrichmentStatus;
  // Only the selected match may supply the CG map coordinate; incident representative coordinates are never read.
  const selectedMatch = record(enrichment.match) ? enrichment.match : null;
  const match: ComposerInput["enrichment"]["match"] = enrichmentStatus === "cg_verified" && selectedMatch &&
    typeof selectedMatch.type === "string"
    ? {
      type: selectedMatch.type,
      latitude: typeof selectedMatch.latitude === "number" ? selectedMatch.latitude : undefined,
      longitude: typeof selectedMatch.longitude === "number" ? selectedMatch.longitude : undefined,
    } : undefined;
  const composerInput: ComposerInput = {
    incident: { id: incident.incidentId, lastActivityTimeMs: incident.lastActivityTimeMs },
    locationDisplayLabel: input.locationDisplayLabel,
    enrichment: { status: enrichmentStatus, match },
  };
  const composer = composeLightningMessage(composerInput);
  const metadata = {
    sourceStatus: "paired_result" as const,
    triggerMode: triggerMode as PairedTriggerMode,
    incidentId: incident.incidentId,
    locationDisplayLabel: input.locationDisplayLabel,
    enrichmentStatus,
  };
  if (!composer.ok) {
    return {
      ok: false, ...metadata, composer,
      error: { code: "composer_error", message: "The message composer rejected the mapped input." },
      text: null, characterCount: composer.characterCount ?? null, mapUrl: null,
    };
  }
  return {
    ok: true, ...metadata, locationDisplayLabel: input.locationDisplayLabel!, composer,
    text: composer.text, characterCount: composer.characterCount, mapUrl: composer.mapUrl,
  };
}
