// Continuous research pipeline for the Fly observer. All policy decisions are
// delegated to the existing lifecycle, paired-validation, composer, and ledger.
import { LightningClusteringPipeline } from "../live-lightning-clustering/pipeline.ts";
import { DEFAULT_CLUSTER_PARAMETERS, type ClusterParameters } from "../live-lightning-clustering/clusterer.ts";
import { ANKARA_MONITORING_AREA, pointInMonitoringArea } from "../lightning-incident-lifecycle/monitoring-area.ts";
import { INCIDENT_POLICY_PROFILES, type IncidentTransition } from "../lightning-incident-lifecycle/types.ts";
import { IncidentLifecycleEngine } from "../lightning-incident-lifecycle/incident-engine.ts";
import { DryRunPublishPolicy } from "../lightning-incident-lifecycle/publish-policy.ts";
import { applyTransitions } from "../lightning-incident-lifecycle/experiment.ts";
import { SourceHealthTracker } from "../lightning-incident-lifecycle/source-health.ts";
import { PairedValidationController, MAX_PAIRING_INCIDENT_AGE_MS } from "../lightning-cg-paired-validation/controller.ts";
import type { PairedEnrichmentFunction, PairedValidationArtifact } from "../lightning-cg-paired-validation/types.ts";
import { continueFromPairedArtifact, withPublishDecision } from "../lightning-end-to-end-dry-run/orchestrate.ts";
import { applyPersistentLedger } from "../lightning-end-to-end-dry-run/ledger.ts";
import { createSupabaseLedger, type LedgerStore } from "../lightning-publication-ledger/storage/supabase.ts";
import type { LightningEvent } from "../live-lightning-listener/core.ts";
import type { ReverseGeocodeResult } from "../lightning-location-naming/types.ts";

const profile = INCIDENT_POLICY_PROFILES.find(candidate => candidate.id === "B")!;
const requiredEnvironment = [
  "XWEATHER_CLIENT_ID", "XWEATHER_CLIENT_SECRET", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY",
] as const;

export class FlyPipelineConfigurationError extends Error {
  readonly missing: string[];
  constructor(missing: string[]) {
    super(`Missing required Fly pipeline configuration: ${missing.join(", ")}`);
    this.name = "FlyPipelineConfigurationError";
    this.missing = missing;
  }
}

export function validateFlyPipelineEnvironment(environment: Record<string, string | undefined>): void {
  const missing = requiredEnvironment.filter(name => !environment[name]?.trim());
  if (missing.length) throw new FlyPipelineConfigurationError([...missing]);
}

export function createFlyPipelineStore(environment: Record<string, string | undefined>): LedgerStore {
  validateFlyPipelineEnvironment(environment);
  return createSupabaseLedger({ url: environment.SUPABASE_URL, serviceRoleKey: environment.SUPABASE_SERVICE_ROLE_KEY });
}

type RuntimeDependencies = {
  store: LedgerStore;
  emit?: (kind: string, fields?: Record<string, unknown>) => void;
  now?: () => number;
  enrich?: PairedEnrichmentFunction;
  reverse?: (latitude: number, longitude: number) => Promise<ReverseGeocodeResult>;
  clusterParameters?: ClusterParameters;
};

export class AnkaraFlyPipeline {
  readonly pipeline: LightningClusteringPipeline;
  readonly lifecycle: IncidentLifecycleEngine;
  readonly sourceHealth: SourceHealthTracker;
  private readonly policy = new DryRunPublishPolicy(profile);
  private readonly controllers = new Map<string, PairedValidationController>();
  private readonly inFlight = new Set<string>();
  private processingQueue: Promise<void> = Promise.resolve();
  private readonly closedClusterIds = new Set<string>();
  private readonly store: LedgerStore;
  private readonly emit: (kind: string, fields?: Record<string, unknown>) => void;
  private readonly now: () => number;
  private readonly enrich?: PairedEnrichmentFunction;
  private readonly reverse?: RuntimeDependencies["reverse"];
  private outOfBoundsDebugCount = 0;
  private staleCandidateCount = 0;
  private candidateCount = 0;
  private pendingCount = 0;

  constructor(dependencies: RuntimeDependencies) {
    this.store = dependencies.store;
    this.emit = dependencies.emit ?? (() => undefined);
    this.now = dependencies.now ?? Date.now;
    this.enrich = dependencies.enrich;
    this.reverse = dependencies.reverse;
    const startedAt = this.now();
    this.pipeline = new LightningClusteringPipeline(ANKARA_MONITORING_AREA.bounds,
      dependencies.clusterParameters ?? { ...DEFAULT_CLUSTER_PARAMETERS }, {
        monitoringArea: {
          id: ANKARA_MONITORING_AREA.id,
          bounds: ANKARA_MONITORING_AREA.bounds,
          contains: event => pointInMonitoringArea([event.longitude, event.latitude]),
        },
      });
    this.lifecycle = new IncidentLifecycleEngine(profile, startedAt);
    this.sourceHealth = new SourceHealthTracker(startedAt);
  }

  get capabilities() {
    return { persistence: true, xweather: true, approval: false, publishing: false } as const;
  }

  markConnecting(atMs = this.now()): void {
    this.applyHealthTransition(this.sourceHealth.connecting(atMs));
  }

  recordFrame(atMs = this.now()): void {
    this.applyHealthTransition(this.sourceHealth.frame(atMs));
  }

  recordDisconnected(atMs = this.now(), intentional = false): void {
    this.applyHealthTransition(this.sourceHealth.disconnected(atMs, !intentional));
  }

  recordMalformed(count = 1): void {
    this.pipeline.recordMalformed(count);
  }

  acceptEvent(event: LightningEvent, processingTimeMs = this.now()) {
    const accepted = this.pipeline.accept(event, processingTimeMs);
    if (!accepted.unique) return accepted;
    if (!accepted.insideSubscriptionBox) {
      this.outOfBoundsDebugCount++;
      if (this.outOfBoundsDebugCount <= 5 || this.outOfBoundsDebugCount % 100 === 0) {
        this.emit("out_of_bounds_event", {
          eventTimestamp: new Date(event.eventTimeMs).toISOString(),
          latitude: event.latitude,
          longitude: event.longitude,
          insideSubscriptionBounds: false,
          approximateDistanceToSubscriptionBoundsKm: distanceToBoundsKm(event.latitude, event.longitude,
            ANKARA_MONITORING_AREA.bounds),
          debugSample: this.outOfBoundsDebugCount,
        });
      }
      return accepted;
    }
    if (!accepted.insideMonitoringArea || !accepted.clusterId || accepted.freshness !== "fresh") return accepted;
    const observation = {
      sourceClusterId: accepted.clusterId,
      eventTimeMs: event.eventTimeMs,
      receivedAtMs: event.receivedAtMs,
      latitude: event.latitude,
      longitude: event.longitude,
    };
    this.processTransitions(this.lifecycle.tick(processingTimeMs));
    this.processTransitions(this.lifecycle.observe(observation));
    return accepted;
  }

  summary(nowMs = this.now()) {
    const stale = this.sourceHealth.poll(nowMs);
    this.applyHealthTransition(stale);
    const state = this.pipeline.summary(nowMs);
    this.syncClosedClusters(nowMs);
    this.processTransitions(this.lifecycle.tick(nowMs));
    return {
      ...state,
      profile: { ...profile },
      area: ANKARA_MONITORING_AREA.id,
      sourceHealth: { ...this.sourceHealth.state },
      sourceHealthInterruptions: this.sourceHealth.interruptions,
      activeIncidents: this.lifecycle.snapshot().activeIncidents,
      candidatesCreated: this.lifecycle.metrics.incidentCandidatesCreated,
      wouldPublishCandidates: this.policy.metrics.publishCandidatesGenerated,
      freshCandidateTriggers: this.candidateCount,
      staleCandidateTriggers: this.staleCandidateCount,
      pendingPublications: this.pendingCount,
      candidateProcessingInFlight: this.inFlight.size,
    };
  }

  async drainCandidateWork(): Promise<void> {
    await Promise.all([...this.controllers.values()].map(controller => controller.waitForCompletion()));
    await this.processingQueue;
  }

  private applyHealthTransition(transition: ReturnType<SourceHealthTracker["frame"]>): void {
    if (!transition) return;
    this.lifecycle.setSourceHealth({ ...this.sourceHealth.state }, transition.atMs);
    this.emit("source_health", { from: transition.from, to: transition.to });
    this.processTransitions(this.lifecycle.tick(transition.atMs));
  }

  private processTransitions(transitions: IncidentTransition[]): void {
    const decisions = applyTransitions(transitions, this.policy, this.lifecycle);
    for (const decision of decisions) {
      if (decision.action !== "WOULD_PUBLISH") continue;
      const incident = this.lifecycle.snapshot().incidents.find(item => item.id === decision.incidentId);
      if (!incident) continue;
      this.candidateCount++;
      this.emit("incident_candidate", { incidentId: incident.id, profile: profile.id,
        eventCount: incident.totalEvents, lastActivityAt: new Date(incident.lastActivityTimeMs).toISOString() });
      const controller = this.controllerFor(incident.id);
      const started = controller.observeDecision(decision, incident, { id: profile.id, name: profile.name });
      if (started) this.observeCompletion(controller, incident.id);
    }
    for (const transition of transitions) {
      if (transition.type === "activity") {
        const controller = this.controllers.get(transition.incident.id);
        if (controller?.observeActivity(transition.incident, { id: profile.id, name: profile.name })) {
          this.observeCompletion(controller, transition.incident.id);
        }
      }
      if (transition.type === "closed" && !this.inFlight.has(transition.incident.id)) {
        this.controllers.delete(transition.incident.id);
      }
    }
  }

  private controllerFor(incidentId: string): PairedValidationController {
    let controller = this.controllers.get(incidentId);
    if (controller) return controller;
    controller = new PairedValidationController({
      ...(this.enrich ? { enrich: this.enrich } : {}),
      writeArtifact: artifact => this.queueCandidateProcessing(incidentId, artifact),
      nowMs: this.now,
      onStaleTriggerSkipped: diagnostic => {
        this.staleCandidateCount++;
        this.emit("candidate_rejected_stale", diagnostic);
      },
    });
    this.controllers.set(incidentId, controller);
    return controller;
  }

  private observeCompletion(controller: PairedValidationController, incidentId: string): void {
    void controller.waitForCompletion().catch(() => {
      this.emit("candidate_processing_error", { incidentId, stage: "paired_validation" });
    });
  }

  private queueCandidateProcessing(incidentId: string, artifact: PairedValidationArtifact): Promise<void> {
    if (this.inFlight.has(incidentId)) {
      this.emit("candidate_processing_error", { incidentId, stage: "serialization", reason: "already_in_flight" });
      return Promise.resolve();
    }
    this.inFlight.add(incidentId);
    const task = this.processingQueue.then(async () => {
      try {
        await this.processCandidate(incidentId, artifact);
      } catch {
        this.emit("candidate_processing_error", { incidentId, stage: "unexpected" });
      } finally {
        this.inFlight.delete(incidentId);
      }
    });
    this.processingQueue = task.catch(() => undefined);
    return task;
  }

  private async processCandidate(incidentId: string, artifact: PairedValidationArtifact): Promise<void> {
    this.emit("enrichment_complete", { incidentId, status: artifact.enrichment?.status ?? "unknown",
      failure: artifact.enrichment?.failure ?? null });
    try {
      let result = await continueFromPairedArtifact(artifact, {
        ...(this.reverse ? { reverse: this.reverse } : {}),
      });
      if (result.location && "normalized" in result.location && result.location.normalized.displayLabel) {
        this.emit("location_resolved", { incidentId, label: result.location.normalized.displayLabel,
          provider: "provider" in result.location ? result.location.provider ?? null : null });
      } else if (result.status === "no_usable_location_label") {
        this.emit("candidate_processing_error", { incidentId, stage: "location", outcome: "no_usable_location_label" });
      }
      result = withPublishDecision(result, { sourceHealthAtTrigger: "live" });
      result = await applyPersistentLedger(result, { sourceHealthAtTrigger: "live" }, this.store, { runId: null, configured: true });
      if (result.ledger?.duplicateMatch?.duplicate) {
        this.emit("duplicate_detected", { incidentId, publicationId: result.ledger.duplicateMatch.matchedPublicationId,
          reason: result.ledger.duplicateMatch.reason });
      }
      if (result.ledger?.approvalStatus === "pending" && result.ledger.recordPersisted) {
        this.pendingCount++;
        this.emit("publication_pending", { incidentId, publicationId: result.ledger.persistedPublicationId,
          approvalStatus: "pending", decision: result.publishDecision?.decision ?? null,
          messageText: result.message?.ok ? result.message.text : null });
      } else {
        this.emit("candidate_outcome", { incidentId, status: result.status,
          decision: result.publishDecision?.decision ?? null,
          ledgerStatus: result.ledger?.storageStatus ?? null,
          reason: result.reason ?? result.ledger?.reason ?? null });
      }
    } catch {
      this.emit("candidate_processing_error", { incidentId, stage: "pipeline" });
    }
  }

  private syncClosedClusters(nowMs: number): void {
    for (const cluster of this.pipeline.clusterer.clusters) {
      if (cluster.status !== "closed" || this.closedClusterIds.has(cluster.id)) continue;
      this.closedClusterIds.add(cluster.id);
      this.processTransitions(this.lifecycle.clusterClosed(cluster.id, nowMs));
    }
  }
}

function distanceToBoundsKm(latitude: number, longitude: number, bounds: typeof ANKARA_MONITORING_AREA.bounds): number {
  const latGap = latitude < bounds.south ? bounds.south - latitude : latitude > bounds.north ? latitude - bounds.north : 0;
  const lonGap = longitude < bounds.west ? bounds.west - longitude : longitude > bounds.east ? longitude - bounds.east : 0;
  const northSouthKm = latGap * 111.32;
  const eastWestKm = lonGap * 111.32 * Math.cos(latitude * Math.PI / 180);
  return Math.round(Math.hypot(northSouthKm, eastWestKm) * 10) / 10;
}

export const FLY_PIPELINE_FRESHNESS_LIMIT_MS = MAX_PAIRING_INCIDENT_AGE_MS;
