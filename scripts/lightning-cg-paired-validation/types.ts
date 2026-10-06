import type { EnrichmentReference, EnrichmentResult } from "../lightning-cg-enrichment/types.ts";
import type { Box } from "../live-lightning-listener/core.ts";
import type { IncidentPolicyProfile, LightningIncident, PublishDecision } from "../lightning-incident-lifecycle/types.ts";

export type IncidentPairSnapshot = EnrichmentReference & {
  incidentId: string;
  firstActivityTimeMs: number;
  lastActivityTimeMs: number;
  eventCount: number;
  clusterCount: number;
};

export type TriggerFreshnessDiagnostics = {
  incidentAgeMs?: number;
  maxIncidentAgeMs: number;
  stalePublishCount: number;
  freshestSkippedIncidentAgeMs: number | null;
  futureDatedPublishCount: number;
  invalidTimestampPublishCount: number;
};

export type PairedRunContext = {
  profile: Pick<IncidentPolicyProfile, "id" | "name">;
  areaSelection: string;
  bounds: Box;
  startedAtMs: number;
  endedAtMs: number;
  sourceHealth: string;
  wouldPublishCount: number;
};

type NoPairArtifactFields = {
  profile: Pick<IncidentPolicyProfile, "id" | "name">;
  areaSelection: string;
  bounds: Box;
  startedAtMs: number;
  endedAtMs: number;
  durationSeconds: number;
  sourceHealth: string;
  wouldPublishCount: number;
  triggerFreshness: TriggerFreshnessDiagnostics;
  guardrail: { maxEnrichmentCalls: 1; enrichmentCalls: 0; providerRequestAttempted: false };
};

export type PairedValidationArtifact =
  | {
      status: "paired_result";
      trigger: "first_would_publish";
      profile: Pick<IncidentPolicyProfile, "id" | "name">;
      incident: IncidentPairSnapshot;
      enrichment: EnrichmentResult;
      triggerFreshness: TriggerFreshnessDiagnostics & { incidentAgeMs: number };
      guardrail: { maxEnrichmentCalls: 1; enrichmentCalls: 1; providerRequestAttempted: boolean };
      capturedAt: string;
    }
  | (NoPairArtifactFields & { status: "no_publish_candidate" })
  | (NoPairArtifactFields & { status: "no_fresh_publish_candidate" });

export type PairedEnrichmentFunction = (reference: EnrichmentReference) => Promise<EnrichmentResult>;
export type ArtifactWriter = (artifact: PairedValidationArtifact) => Promise<void>;
export type DecisionForPairing = Pick<PublishDecision, "action" | "incidentId">;
export type IncidentForPairing = Pick<LightningIncident,
  "id" | "representativeLatitude" | "representativeLongitude" | "lastActivityTimeMs" |
  "firstEventTimeMs" | "totalEvents" | "sourceClusterIds">;
