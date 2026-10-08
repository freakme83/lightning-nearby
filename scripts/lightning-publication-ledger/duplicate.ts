import type { DecisionContext } from "../lightning-publish-decision/decision.ts";
import type { DuplicateMatchResult, PublicationRecord } from "./types.ts";

const SAME_OBSERVATION_WINDOW_MS = 2_000;
const SAME_OBSERVATION_DISTANCE_KM = 0.25;
const RADIANS = Math.PI / 180;

function distanceKm(a: PublicationRecord, b: PublicationRecord): number {
  const latitudeDelta = (b.incidentLatitude - a.incidentLatitude) * RADIANS;
  const longitudeDelta = (b.incidentLongitude - a.incidentLongitude) * RADIANS;
  const angle = Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(a.incidentLatitude * RADIANS) * Math.cos(b.incidentLatitude * RADIANS) *
    Math.sin(longitudeDelta / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.min(1, Math.sqrt(angle)));
}

function firstMatch(records: readonly PublicationRecord[], predicate: (prior: PublicationRecord) => boolean): PublicationRecord | null {
  return records.filter(predicate).sort((a, b) => a.publicationId.localeCompare(b.publicationId))[0] ?? null;
}

export function matchPublicationDuplicate(candidate: PublicationRecord,
  priorRecords: readonly PublicationRecord[]): DuplicateMatchResult {
  if (candidate.providerEventId) {
    const sameEvent = firstMatch(priorRecords, prior => prior.provider === candidate.provider &&
      prior.providerEventId === candidate.providerEventId);
    if (sameEvent) return { duplicate: true, reason: "same_provider_event", matchedPublicationId: sameEvent.publicationId };
  }
  const candidateTime = Date.parse(candidate.incidentReferenceTime);
  const sameObservation = firstMatch(priorRecords, prior => {
    // Distinct selected provider IDs are stronger evidence than a generic message.
    if (candidate.providerEventId && prior.providerEventId) return false;
    const priorTime = Date.parse(prior.incidentReferenceTime);
    return candidate.messageFingerprint === prior.messageFingerprint &&
      Number.isFinite(candidateTime) && Number.isFinite(priorTime) &&
      Math.abs(candidateTime - priorTime) <= SAME_OBSERVATION_WINDOW_MS &&
      distanceKm(candidate, prior) <= SAME_OBSERVATION_DISTANCE_KM;
  });
  return sameObservation
    ? { duplicate: true, reason: "same_observation_fingerprint", matchedPublicationId: sameObservation.publicationId }
    : { duplicate: false, reason: "no_duplicate", matchedPublicationId: null };
}

// A later storage-backed caller can supply this context to v1A. The decision
// gate never queries a ledger, and the current workflow supplies no history.
export function duplicateDecisionContext(match: DuplicateMatchResult): Pick<DecisionContext, "knownDuplicate"> {
  return { knownDuplicate: match.duplicate };
}
