import { NominatimReverseGeocoder } from "../lightning-location-naming/nominatim.ts";
import { validateCoordinates } from "../lightning-location-naming/normalize.ts";
import { formatDiagnosticResult, formatLookupFailure } from "../lightning-location-naming/runner.ts";
import type { ReverseGeocodeResult } from "../lightning-location-naming/types.ts";
import { inspectPairedArtifact, previewPairedMessage } from "../lightning-message-preview/adapter.ts";
import type { PairedMessagePreview } from "../lightning-message-preview/types.ts";

export type DryRunStatus = "message_preview_ready" | "no_publish_candidate" | "no_fresh_publish_candidate" |
  "no_usable_location_label" | "paired_validation_failed" | "location_lookup_failed" | "message_composition_failed";

type LocationResult = ReturnType<typeof formatDiagnosticResult> | ReturnType<typeof formatLookupFailure>;

export type DryRunResult = {
  status: DryRunStatus;
  paired: Record<string, unknown> | null;
  location: LocationResult | null;
  message: PairedMessagePreview | null;
  reason?: string;
  capturedAt: string;
  providerCalls: {
    xweatherEnrichmentCalls: number | null;
    xweatherRequestAttempted: boolean | null;
    nominatimReverseLookups: 0 | 1;
  };
};

type Dependencies = {
  reverse?: (latitude: number, longitude: number) => Promise<ReverseGeocodeResult>;
  preview?: typeof previewPairedMessage;
  now?: () => string;
};

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function summarizePaired(value: unknown): Record<string, unknown> | null {
  if (!record(value)) return null;
  const incident = record(value.incident) ? value.incident : null;
  const enrichment = record(value.enrichment) ? value.enrichment : null;
  return {
    artifactPath: "artifacts/lightning-cg-paired-result.json",
    status: value.status ?? "unknown",
    profile: value.profile ?? null,
    areaSelection: value.areaSelection ?? null,
    sourceHealth: value.sourceHealth ?? null,
    incident: incident && {
      incidentId: incident.incidentId,
      latitude: incident.latitude,
      longitude: incident.longitude,
      eventTimeMs: incident.eventTimeMs,
      lastActivityTimeMs: incident.lastActivityTimeMs,
      eventCount: incident.eventCount,
    },
    triggerMode: value.triggerMode ?? null,
    triggerFreshness: value.triggerFreshness ?? null,
    reactivation: value.reactivation ?? null,
    enrichment: enrichment && {
      status: enrichment.status,
      counts: enrichment.counts ?? null,
      match: enrichment.match ?? null,
      cost: enrichment.cost ?? null,
      failure: enrichment.failure ?? null,
    },
    guardrail: value.guardrail ?? null,
  };
}

export function pairedValidationFailure(reason: string, artifact: unknown = null, now = () => new Date().toISOString()): DryRunResult {
  const base = initial(artifact, now);
  return { ...base, status: "paired_validation_failed", reason };
}

function initial(artifact: unknown, now: () => string): DryRunResult {
  const guardrail = record(artifact) && record(artifact.guardrail) ? artifact.guardrail : null;
  return {
    status: "paired_validation_failed",
    paired: summarizePaired(artifact),
    location: null,
    message: null,
    capturedAt: now(),
    providerCalls: {
      xweatherEnrichmentCalls: typeof guardrail?.enrichmentCalls === "number" ? guardrail.enrichmentCalls : null,
      xweatherRequestAttempted: typeof guardrail?.providerRequestAttempted === "boolean" ? guardrail.providerRequestAttempted : null,
      nominatimReverseLookups: 0,
    },
  };
}

export async function continueFromPairedArtifact(artifact: unknown, deps: Dependencies = {}): Promise<DryRunResult> {
  const base = initial(artifact, deps.now ?? (() => new Date().toISOString()));
  const inspected = inspectPairedArtifact(artifact);
  if (!inspected.ok) {
    if (inspected.status === "no_publish_candidate" || inspected.status === "no_fresh_publish_candidate") {
      return { ...base, status: inspected.status, reason: inspected.message };
    }
    return { ...base, reason: inspected.message };
  }

  const { latitude, longitude } = inspected.artifact.incident;
  try {
    validateCoordinates(latitude, longitude);
  } catch {
    return { ...base, reason: "The paired incident has no usable representative coordinate." };
  }

  const withLookup = { ...base, providerCalls: { ...base.providerCalls, nominatimReverseLookups: 1 as const } };
  let location: ReverseGeocodeResult;
  try {
    const reverse = deps.reverse ?? ((lat: number, lon: number) =>
      new NominatimReverseGeocoder().reverse(lat, lon, { includeProviderHierarchy: true }));
    location = await reverse(latitude, longitude);
  } catch (error) {
    return {
      ...withLookup, status: "location_lookup_failed",
      location: formatLookupFailure("Incident coordinate", latitude, longitude, "nominatim", error),
      reason: "The incident coordinate could not be reverse-geocoded.",
    };
  }
  const diagnostic = formatDiagnosticResult("Incident coordinate", location);
  if (typeof location.displayLabel !== "string" || !location.displayLabel.trim()) {
    return { ...withLookup, status: "no_usable_location_label", location: diagnostic,
      reason: "No usable display label was produced." };
  }

  try {
    const message = (deps.preview ?? previewPairedMessage)({
      artifact: inspected.artifact, locationDisplayLabel: location.displayLabel,
    });
    if (!message.ok) return { ...withLookup, status: "message_composition_failed", location: diagnostic,
      message, reason: message.error.message };
    return { ...withLookup, status: "message_preview_ready", location: diagnostic, message };
  } catch (error) {
    return { ...withLookup, status: "message_composition_failed", location: diagnostic,
      reason: error instanceof Error ? error.message : "Message composition failed." };
  }
}
