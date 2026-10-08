import type { EnrichmentResult, LightningType } from "../lightning-cg-enrichment/types.ts";
import type { PublishDecision } from "../lightning-publish-decision/decision.ts";

// Domain record only. A WOULD_PUBLISH record is a shadow observation, not a post.
export type PublicationRecord = {
  publicationId: string;
  runId: string | null;
  incidentId: string | null;
  incidentReferenceTime: string;
  incidentLatitude: number;
  incidentLongitude: number;
  provider: EnrichmentResult["provider"];
  enrichmentStatus: EnrichmentResult["status"];
  providerEventId: string | null;
  providerEventType: LightningType | null;
  locationLabel: string | null;
  messageFingerprint: string;
  decision: PublishDecision["decision"] | "PUBLISHED";
  recordedAt: string;
  platformPostId?: string | null;
};

export type DuplicateMatchResult = {
  duplicate: boolean;
  reason: "same_provider_event" | "same_observation_fingerprint" | "no_duplicate";
  matchedPublicationId: string | null;
};

export type BuildPublicationRecordResult =
  | { ok: true; record: PublicationRecord }
  | { ok: false; code: "message_not_ready" | "missing_decision" | "invalid_incident" |
      "invalid_enrichment" | "invalid_location" | "invalid_recorded_at"; message: string };
