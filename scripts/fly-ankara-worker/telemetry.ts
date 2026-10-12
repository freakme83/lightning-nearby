import type { EnrichmentResult } from "../lightning-cg-enrichment/types.ts";
import { selectedRepeatEventCheck } from "../lightning-cg-repeat-policy/admission.ts";
import { CG_REPEAT_SELECTED_MAX_REFERENCE_DELTA_MS } from "../lightning-cg-repeat-policy/constants.ts";

export function cgProviderTelemetry(enrichment: EnrichmentResult, referenceTimeMs: number, nowMs: number, maxAgeMs: number) {
  const check = selectedRepeatEventCheck(enrichment, referenceTimeMs, nowMs, maxAgeMs);
  const match = enrichment.match;
  const selectedEventAgeMs = match ? nowMs - match.eventTimeMs : null;
  const referenceAgeMs = nowMs - referenceTimeMs;
  const referenceTimeDeltaMs = match ? Math.abs(match.eventTimeMs - referenceTimeMs) : null;
  const currentnessDetails = match ? [
    ...(selectedEventAgeMs! < 0 ? ["selected_event_future"] : []),
    ...(selectedEventAgeMs! > maxAgeMs ? ["selected_event_too_old"] : []),
    ...(referenceAgeMs < 0 ? ["reference_future"] : []),
    ...(referenceAgeMs > maxAgeMs ? ["reference_too_old"] : []),
    ...(referenceTimeDeltaMs! > CG_REPEAT_SELECTED_MAX_REFERENCE_DELTA_MS ? ["selected_reference_delta_exceeded"] : []),
  ] : [];
  return {
    category: enrichment.status === "cg_verified" ? check ?? "current_cg_verified" : enrichment.status,
    enrichmentStatus: enrichment.status, failure: enrichment.failure ?? null, httpStatus: enrichment.httpStatus ?? null,
    counts: enrichment.counts ?? null, matchDiagnostics: enrichment.matchDiagnostics ?? null,
    ambiguity: enrichment.status === "provider_unavailable" ? "provider_result_unavailable" :
      !enrichment.matchDiagnostics ? "returned_event_rejections_not_available" : "limited_to_returned_provider_events",
    selectedCg: enrichment.status === "cg_verified" && match?.type === "cg",
    providerEventId: match?.id ?? null, selectedLatitude: match?.latitude ?? null, selectedLongitude: match?.longitude ?? null,
    selectedEventTimeMs: match?.eventTimeMs ?? null, selectedEventAgeMs, referenceTimeMs, referenceAgeMs, referenceTimeDeltaMs,
    selectedDistanceKm: match?.distanceKm ?? null, currentnessPassed: check === null, currentnessFailure: check, currentnessDetails,
  };
}
