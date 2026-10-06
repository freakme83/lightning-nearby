import { enrichIncidentWithLightningType } from "../lightning-cg-enrichment/xweather.ts";
import { DEFAULT_THRESHOLDS } from "../lightning-cg-enrichment/match.ts";
import type { EnrichmentReference, EnrichmentResult } from "../lightning-cg-enrichment/types.ts";
import type {
  ArtifactWriter, DecisionForPairing, IncidentForPairing, IncidentPairSnapshot, PairedEnrichmentFunction,
  PairedReactivationDiagnostics, PairedRunContext, PairedValidationArtifact, TriggerFreshnessDiagnostics,
} from "./types.ts";

export const MAX_PAIRING_INCIDENT_AGE_MS = 240_000;

export class PairedValidationController {
  private readonly staleSkippedCandidates = new Map<string, { originalStaleAgeMs: number; receivedLaterActivity: boolean }>();
  private reactivatedIncidentCount = 0;
  private callClaimed = false;
  private finalized = false;
  private pending: Promise<PairedValidationArtifact> | null = null;
  private readonly enrich: PairedEnrichmentFunction;
  private readonly writeArtifact: ArtifactWriter;
  private readonly now: () => string;
  private readonly nowMs: () => number;
  private readonly onEnrichmentStarted?: () => void;
  private readonly onStaleTriggerSkipped?: (diagnostic: { incidentId: string; incidentAgeMs: number | null;
    maxIncidentAgeMs: number; skipReason: "incident_too_old" | "future_dated_incident" | "invalid_event_time" }) => void;
  private stalePublishCount = 0;
  private freshestSkippedIncidentAgeMs: number | null = null;
  private futureDatedPublishCount = 0;
  private invalidTimestampPublishCount = 0;

  constructor(dependencies: {
    enrich?: PairedEnrichmentFunction;
    writeArtifact: ArtifactWriter;
    now?: () => string;
    nowMs?: () => number;
    onEnrichmentStarted?: () => void;
    onStaleTriggerSkipped?: (diagnostic: { incidentId: string; incidentAgeMs: number | null;
      maxIncidentAgeMs: number; skipReason: "incident_too_old" | "future_dated_incident" | "invalid_event_time" }) => void;
  }) {
    this.enrich = dependencies.enrich ?? (reference => enrichIncidentWithLightningType(reference));
    this.writeArtifact = dependencies.writeArtifact;
    this.now = dependencies.now ?? (() => new Date().toISOString());
    this.nowMs = dependencies.nowMs ?? Date.now;
    this.onEnrichmentStarted = dependencies.onEnrichmentStarted;
    this.onStaleTriggerSkipped = dependencies.onStaleTriggerSkipped;
  }

  get enrichmentClaimed(): boolean { return this.callClaimed; }

  observeDecision(decision: DecisionForPairing, incident: IncidentForPairing,
    profile: PairedRunContext["profile"]): boolean {
    if (decision.action !== "WOULD_PUBLISH" || this.callClaimed || this.finalized || incident.id !== decision.incidentId) return false;
    const incidentAgeMs = this.nowMs() - incident.lastActivityTimeMs;
    if (!Number.isFinite(incidentAgeMs)) {
      this.invalidTimestampPublishCount++;
      this.onStaleTriggerSkipped?.({ incidentId: incident.id, incidentAgeMs: null,
        maxIncidentAgeMs: MAX_PAIRING_INCIDENT_AGE_MS, skipReason: "invalid_event_time" });
      return false;
    }
    // Future event times are conservatively ineligible; a clock-skewed future record must not spend the one-call budget.
    if (incidentAgeMs < 0) {
      this.futureDatedPublishCount++;
      this.onStaleTriggerSkipped?.({ incidentId: incident.id, incidentAgeMs,
        maxIncidentAgeMs: MAX_PAIRING_INCIDENT_AGE_MS, skipReason: "future_dated_incident" });
      return false;
    }
    if (incidentAgeMs > MAX_PAIRING_INCIDENT_AGE_MS) {
      this.stalePublishCount++;
      this.freshestSkippedIncidentAgeMs = this.freshestSkippedIncidentAgeMs === null
        ? incidentAgeMs : Math.min(this.freshestSkippedIncidentAgeMs, incidentAgeMs);
      if (!this.staleSkippedCandidates.has(incident.id)) {
        this.staleSkippedCandidates.set(incident.id, { originalStaleAgeMs: incidentAgeMs, receivedLaterActivity: false });
      }
      this.onStaleTriggerSkipped?.({ incidentId: incident.id, incidentAgeMs,
        maxIncidentAgeMs: MAX_PAIRING_INCIDENT_AGE_MS, skipReason: "incident_too_old" });
      return false;
    }
    // Freshness is checked before claiming. Claim synchronously before invoking the provider so repeated decisions cannot make a second call.
    return this.beginEnrichment(incident, profile, "fresh_would_publish", incidentAgeMs);
  }

  observeActivity(incident: IncidentForPairing, profile: PairedRunContext["profile"]): boolean {
    if (this.callClaimed || this.finalized || incident.status !== "active") return false;
    const staleCandidate = this.staleSkippedCandidates.get(incident.id);
    if (!staleCandidate) return false;
    staleCandidate.receivedLaterActivity = true;

    const reactivationAgeMs = this.nowMs() - incident.lastActivityTimeMs;
    if (!Number.isFinite(reactivationAgeMs) || reactivationAgeMs < 0 ||
        reactivationAgeMs > MAX_PAIRING_INCIDENT_AGE_MS) return false;

    this.reactivatedIncidentCount++;
    const reactivation: PairedReactivationDiagnostics = {
      incidentId: incident.id,
      originalStaleAgeMs: staleCandidate.originalStaleAgeMs,
      reactivationAgeMs,
      maxIncidentAgeMs: MAX_PAIRING_INCIDENT_AGE_MS,
      stalePublishCount: this.stalePublishCount,
      triggeredByLaterFreshActivity: true,
    };
    return this.beginEnrichment(incident, profile, "reactivated_after_stale_publish", reactivationAgeMs, reactivation);
  }

  async waitForCompletion(): Promise<PairedValidationArtifact | null> {
    return this.pending ? this.pending : null;
  }

  async writeNoCandidate(context: PairedRunContext): Promise<PairedValidationArtifact | null> {
    if (this.callClaimed || this.finalized) return null;
    this.finalized = true;
    const base = {
      profile: { ...context.profile },
      areaSelection: context.areaSelection,
      bounds: { ...context.bounds },
      startedAtMs: context.startedAtMs,
      endedAtMs: context.endedAtMs,
      durationSeconds: Math.max(0, (context.endedAtMs - context.startedAtMs) / 1000),
      sourceHealth: context.sourceHealth,
      wouldPublishCount: context.wouldPublishCount,
      guardrail: { maxEnrichmentCalls: 1 as const, enrichmentCalls: 0 as const, providerRequestAttempted: false as const },
      triggerFreshness: this.freshnessDiagnostics(),
    };
    const status = this.stalePublishCount || this.futureDatedPublishCount || this.invalidTimestampPublishCount
      ? "no_fresh_publish_candidate" as const : "no_publish_candidate" as const;
    const artifact: PairedValidationArtifact = {
      ...base,
      status,
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

  private freshnessDiagnostics(): TriggerFreshnessDiagnostics;
  private freshnessDiagnostics(incidentAgeMs: number): TriggerFreshnessDiagnostics & { incidentAgeMs: number };
  private freshnessDiagnostics(incidentAgeMs?: number): TriggerFreshnessDiagnostics {
    return {
      ...(incidentAgeMs === undefined ? {} : { incidentAgeMs }),
      maxIncidentAgeMs: MAX_PAIRING_INCIDENT_AGE_MS,
      stalePublishCount: this.stalePublishCount,
      freshestSkippedIncidentAgeMs: this.freshestSkippedIncidentAgeMs,
      futureDatedPublishCount: this.futureDatedPublishCount,
      invalidTimestampPublishCount: this.invalidTimestampPublishCount,
      trackedStaleIncidentCount: this.staleSkippedCandidates.size,
      staleIncidentsWithLaterActivityCount: [...this.staleSkippedCandidates.values()]
        .filter(candidate => candidate.receivedLaterActivity).length,
      reactivatedIncidentCount: this.reactivatedIncidentCount,
    };
  }

  private beginEnrichment(incident: IncidentForPairing, profile: PairedRunContext["profile"],
    triggerMode: "fresh_would_publish" | "reactivated_after_stale_publish", incidentAgeMs: number,
    reactivation?: PairedReactivationDiagnostics): boolean {
    this.callClaimed = true;
    const incidentSnapshot = this.snapshotIncident(incident);
    this.pending = this.createPairedResult(incidentSnapshot, profile, triggerMode,
      this.freshnessDiagnostics(incidentAgeMs), reactivation);
    this.onEnrichmentStarted?.();
    return true;
  }

  private async createPairedResult(incident: IncidentPairSnapshot,
    profile: PairedRunContext["profile"],
    triggerMode: "fresh_would_publish" | "reactivated_after_stale_publish",
    triggerFreshness: TriggerFreshnessDiagnostics & { incidentAgeMs: number },
    reactivation?: PairedReactivationDiagnostics): Promise<PairedValidationArtifact> {
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
    const common = {
      status: "paired_result" as const,
      profile: { ...profile },
      incident,
      enrichment,
      triggerFreshness,
      guardrail: {
        maxEnrichmentCalls: 1 as const,
        enrichmentCalls: 1 as const,
        providerRequestAttempted: enrichment.failure !== "missing_credentials",
      },
      capturedAt: this.now(),
    };
    const artifact: PairedValidationArtifact = triggerMode === "reactivated_after_stale_publish" && reactivation
      ? { ...common, triggerMode, reactivation }
      : { ...common, triggerMode: "fresh_would_publish" };
    await this.writeArtifact(artifact);
    return artifact;
  }
}
