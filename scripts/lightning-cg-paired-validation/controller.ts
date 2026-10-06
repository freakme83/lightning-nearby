import { enrichIncidentWithLightningType } from "../lightning-cg-enrichment/xweather.ts";
import { DEFAULT_THRESHOLDS } from "../lightning-cg-enrichment/match.ts";
import type { EnrichmentReference, EnrichmentResult } from "../lightning-cg-enrichment/types.ts";
import type {
  ArtifactWriter, DecisionForPairing, IncidentForPairing, IncidentPairSnapshot, PairedEnrichmentFunction,
  PairedRunContext, PairedValidationArtifact,
} from "./types.ts";

export class PairedValidationController {
  private callClaimed = false;
  private finalized = false;
  private pending: Promise<PairedValidationArtifact> | null = null;
  private readonly enrich: PairedEnrichmentFunction;
  private readonly writeArtifact: ArtifactWriter;
  private readonly now: () => string;
  private readonly onEnrichmentStarted?: () => void;

  constructor(dependencies: {
    enrich?: PairedEnrichmentFunction;
    writeArtifact: ArtifactWriter;
    now?: () => string;
    onEnrichmentStarted?: () => void;
  }) {
    this.enrich = dependencies.enrich ?? (reference => enrichIncidentWithLightningType(reference));
    this.writeArtifact = dependencies.writeArtifact;
    this.now = dependencies.now ?? (() => new Date().toISOString());
    this.onEnrichmentStarted = dependencies.onEnrichmentStarted;
  }

  get enrichmentClaimed(): boolean { return this.callClaimed; }

  observeDecision(decision: DecisionForPairing, incident: IncidentForPairing,
    profile: PairedRunContext["profile"]): boolean {
    if (decision.action !== "WOULD_PUBLISH" || this.callClaimed || this.finalized || incident.id !== decision.incidentId) return false;
    // Claim synchronously before invoking the provider so concurrent or repeated decisions cannot make a second call.
    this.callClaimed = true;
    const incidentSnapshot = this.snapshotIncident(incident);
    this.pending = this.createPairedResult(incidentSnapshot, profile);
    this.onEnrichmentStarted?.();
    return true;
  }

  async waitForCompletion(): Promise<PairedValidationArtifact | null> {
    return this.pending ? this.pending : null;
  }

  async writeNoCandidate(context: PairedRunContext): Promise<PairedValidationArtifact | null> {
    if (this.callClaimed || this.finalized) return null;
    this.finalized = true;
    const artifact: PairedValidationArtifact = {
      status: "no_publish_candidate",
      profile: { ...context.profile },
      areaSelection: context.areaSelection,
      bounds: { ...context.bounds },
      startedAtMs: context.startedAtMs,
      endedAtMs: context.endedAtMs,
      durationSeconds: Math.max(0, (context.endedAtMs - context.startedAtMs) / 1000),
      sourceHealth: context.sourceHealth,
      wouldPublishCount: context.wouldPublishCount,
      guardrail: { maxEnrichmentCalls: 1, enrichmentCalls: 0, providerRequestAttempted: false },
    };
    await this.writeArtifact(artifact);
    return artifact;
  }

  private snapshotIncident(incident: IncidentForPairing) {
    return {
      incidentId: incident.id,
      latitude: incident.representativeLatitude,
      longitude: incident.representativeLongitude,
      eventTimeMs: incident.lastActivityTimeMs,
      firstActivityTimeMs: incident.firstEventTimeMs,
      lastActivityTimeMs: incident.lastActivityTimeMs,
      eventCount: incident.totalEvents,
      clusterCount: incident.sourceClusterIds.length,
    };
  }

  private async createPairedResult(incident: IncidentPairSnapshot,
    profile: PairedRunContext["profile"]): Promise<PairedValidationArtifact> {
    const reference: EnrichmentReference = {
      latitude: incident.latitude,
      longitude: incident.longitude,
      eventTimeMs: incident.eventTimeMs,
    };
    let enrichment: EnrichmentResult;
    try {
      enrichment = await this.enrich(reference);
    } catch {
      // Do not copy arbitrary provider/fetch error messages into the artifact.
      enrichment = {
        status: "provider_unavailable", provider: "xweather", reference,
        thresholds: { ...DEFAULT_THRESHOLDS }, failure: "network_error",
      };
    }
    const artifact: PairedValidationArtifact = {
      status: "paired_result",
      trigger: "first_would_publish",
      profile: { ...profile },
      incident,
      enrichment,
      guardrail: {
        maxEnrichmentCalls: 1,
        enrichmentCalls: 1,
        providerRequestAttempted: enrichment.failure !== "missing_credentials",
      },
      capturedAt: this.now(),
    };
    await this.writeArtifact(artifact);
    return artifact;
  }
}
