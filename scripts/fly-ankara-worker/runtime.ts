// Continuous research pipeline for the Fly observer. All policy decisions are
// delegated to the existing lifecycle, paired-validation, composer, and ledger.
import { randomUUID } from "node:crypto";
import { LightningClusteringPipeline } from "../live-lightning-clustering/pipeline.ts";
import { DEFAULT_CLUSTER_PARAMETERS, type ClusterParameters } from "../live-lightning-clustering/clusterer.ts";
import { ANKARA_MONITORING_AREA, pointInMonitoringArea } from "../lightning-incident-lifecycle/monitoring-area.ts";
import { INCIDENT_POLICY_PROFILES, type IncidentTransition, type ClusterObservation, type LightningIncident } from "../lightning-incident-lifecycle/types.ts";
import { IncidentLifecycleEngine } from "../lightning-incident-lifecycle/incident-engine.ts";
import { DryRunPublishPolicy } from "../lightning-incident-lifecycle/publish-policy.ts";
import { applyTransitions } from "../lightning-incident-lifecycle/experiment.ts";
import { SourceHealthTracker, type SourceHealth } from "../lightning-incident-lifecycle/source-health.ts";
import { PairedValidationController, MAX_PAIRING_INCIDENT_AGE_MS } from "../lightning-cg-paired-validation/controller.ts";
import type { PairedEnrichmentFunction, PairedValidationArtifact } from "../lightning-cg-paired-validation/types.ts";
import { continueFromPairedArtifact, withPublishDecision } from "../lightning-end-to-end-dry-run/orchestrate.ts";
import { applyPersistentLedger } from "../lightning-end-to-end-dry-run/ledger.ts";
import { createSupabaseLedger, type LedgerStore } from "../lightning-publication-ledger/storage/supabase.ts";
import type { LightningEvent } from "../live-lightning-listener/core.ts";
import type { ReverseGeocodeResult } from "../lightning-location-naming/types.ts";
import { NominatimReverseGeocoder } from "../lightning-location-naming/nominatim.ts";
import type { AutoPublishFailureNotifier, PendingPublicationNotifier } from "../lightning-telegram-notifier/pending.ts";
import { autoPublishNewPending, type FlyAutoPublish } from "./auto-publish.ts";
import { enrichIncidentWithLightningType, enrichInitialIncidentWithLightningType } from "../lightning-cg-enrichment/xweather.ts";
import { enforceInitialCgAcceptance } from "../lightning-cg-enrichment/initial.ts";
import { CgProbeCoordinator } from "../lightning-cg-repeat-policy/coordinator.ts";
import { CG_REPEAT_REASONS, selectedRepeatEventCheck, type CgRepeatReason, type CgAdmissionRequest } from "../lightning-cg-repeat-policy/admission.ts";
import { CG_REPEAT_POLICY_VERSION, CG_REPEAT_RECOVERY_HOLD_MS } from "../lightning-cg-repeat-policy/constants.ts";
import { classifyCgPlace, semanticCgLocationIdentity } from "../lightning-cg-repeat-policy/location.ts";
import { cgProviderTelemetry } from "./telemetry.ts";
import { StormEvolutionShadow } from "./storm-evolution.ts";

type RepeatProbe = { incident: LightningIncident; observation: ClusterObservation; reason: CgRepeatReason; predecessorId?: string };

const profile = INCIDENT_POLICY_PROFILES.find(candidate => candidate.id === "B")!;
// The 5-minute housekeeping cadence is shorter than every Profile B relevance window.
const CLOSED_CLUSTER_RETENTION_MS = 0;
const LIFECYCLE_METRIC_SAMPLE_LIMIT = 1_000;
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
  notifyPending?: PendingPublicationNotifier;
  notifyAutoPublishFailure?: AutoPublishFailureNotifier;
  autoPublish?: FlyAutoPublish;
};

export class AnkaraFlyPipeline {
  readonly pipeline: LightningClusteringPipeline;
  readonly lifecycle: IncidentLifecycleEngine;
  readonly sourceHealth: SourceHealthTracker;
  private readonly policy = new DryRunPublishPolicy(profile);
  private readonly controllers = new Map<string, PairedValidationController>();
  private readonly inFlight = new Set<string>();
  private readonly candidateWork = new Set<string>();
  private readonly triggerHealthByIncident = new Map<string, SourceHealth["state"]>();
  private processingQueue: Promise<void> = Promise.resolve();
  private readonly closedClusterIds = new Set<string>();
  private readonly store: LedgerStore;
  private readonly runId = randomUUID();
  private readonly emit: (kind: string, fields?: Record<string, unknown>) => void;
  private readonly now: () => number;
  private readonly enrich?: PairedEnrichmentFunction;
  private readonly reverse?: RuntimeDependencies["reverse"];
  private readonly notifyPending?: PendingPublicationNotifier;
  private readonly notifyAutoPublishFailure?: AutoPublishFailureNotifier;
  private readonly autoPublish?: FlyAutoPublish;
  private outOfBoundsDebugCount = 0;
  private staleCandidateCount = 0;
  private candidateCount = 0;
  private pendingCount = 0;
  private repeatReadyAtMs: number;
  private readonly repeatProbes: CgProbeCoordinator<RepeatProbe>;
  private readonly repeatPredecessors = new Map<string, string>();
  private readonly repeatInFlight = new Set<string>();
  private readonly cgProviderResults: Record<string, number> = {};
  private cgProviderQueries = 0;
  private cgAdmissionsSuppressed = 0;
  private cgAdmissionsAccepted = 0;
  private firstCgShadowOpportunities = 0;
  private firstCgShadowEligible = 0;
  private readonly stormEvolution = new StormEvolutionShadow();
  private readonly stormEvolutionWork = new Map<string, Promise<void>>();

  constructor(dependencies: RuntimeDependencies) {
    this.store = dependencies.store;
    this.emit = dependencies.emit ?? (() => undefined);
    this.now = dependencies.now ?? Date.now;
    this.enrich = dependencies.enrich;
    this.reverse = dependencies.reverse;
    this.notifyPending = dependencies.notifyPending;
    this.notifyAutoPublishFailure = dependencies.notifyAutoPublishFailure;
    this.autoPublish = dependencies.autoPublish;
    const startedAt = this.now();
    this.repeatReadyAtMs = startedAt + CG_REPEAT_RECOVERY_HOLD_MS;
    this.pipeline = new LightningClusteringPipeline(ANKARA_MONITORING_AREA.bounds,
      dependencies.clusterParameters ?? { ...DEFAULT_CLUSTER_PARAMETERS }, {
        monitoringArea: {
          id: ANKARA_MONITORING_AREA.id,
          bounds: ANKARA_MONITORING_AREA.bounds,
          contains: event => pointInMonitoringArea([event.longitude, event.latitude]),
        },
      });
    this.lifecycle = new IncidentLifecycleEngine(profile, startedAt, { metricSampleLimit: LIFECYCLE_METRIC_SAMPLE_LIMIT });
    this.sourceHealth = new SourceHealthTracker(startedAt);
    this.repeatProbes = new CgProbeCoordinator({ now: this.now,
      eligible: (_scope, probe) => this.repeatProbeEligible(probe),
      rejectionReason: (_scope, probe) => this.repeatProbeRejection(probe) ?? "ineligible",
      execute: (_scope, probe) => this.processRepeatProbe(probe),
      onError: scopeId => this.emit("cg_repeat_outcome", { scopeId, outcome: "held", reason: "unexpected_probe_error" }),
    });
  }

  get capabilities() {
    return { persistence: true, xweather: true, telegram: Boolean(this.notifyPending),
      autoPublish: Boolean(this.autoPublish), approval: false, publishing: false } as const;
  }

  markConnecting(atMs = this.now()): void {
    this.applyHealthTransition(this.sourceHealth.connecting(atMs));
  }

  recordFrame(atMs = this.now()): void {
    // A gap can occur between summary polls. Do not count unseen downtime toward recovery.
    if (this.sourceHealth.state.state === "live" &&
        (atMs - this.sourceHealth.state.lastFrameAtMs >= this.sourceHealth.staleAfterMs ||
         atMs < this.sourceHealth.state.lastFrameAtMs)) this.repeatReadyAtMs = atMs + CG_REPEAT_RECOVERY_HOLD_MS;
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
    this.processTransitions(this.lifecycle.observe(observation), observation);
    const associated = this.lifecycle.incidents.find(incident => incident.status === "active" &&
      incident.sourceClusterIds.includes(observation.sourceClusterId));
    if (associated) {
      this.stormEvolution.observe(associated.id, observation.sourceClusterId,
        observation.latitude, observation.longitude, observation.eventTimeMs);
      this.scheduleStormEvolution(associated.id, processingTimeMs);
    }
    this.repeatProbes.pump();
    return accepted;
  }

  summary(nowMs = this.now()) {
    const stale = this.sourceHealth.poll(nowMs);
    this.applyHealthTransition(stale);
    const state = this.pipeline.summary(nowMs);
    this.syncClosedClusters(nowMs);
    this.processTransitions(this.lifecycle.tick(nowMs));
    this.pruneHistoricalState(nowMs);
    this.repeatProbes.pump();
    for (const incident of this.lifecycle.incidents) {
      if (incident.status !== "active") continue;
      this.scheduleStormEvolution(incident.id, nowMs);
      this.emitStormEvolution(incident.id, nowMs);
    }
    return {
      ...state,
      clusters: state.clusters.map(({ recentEvents: _events, ...cluster }) => cluster),
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
      candidateProcessingInFlight: this.candidateWork.size,
      recall: { candidatesExpired: this.lifecycle.metrics.candidatesExpired,
        eventsAfterCandidateExpiry: this.lifecycle.metrics.eventsAfterCandidateExpiry,
        candidatesRecovered: this.lifecycle.metrics.candidatesRecovered,
        promotionsAfterRecovery: this.lifecycle.metrics.promotionsAfterRecovery,
        recoveredCandidatesAssociated: this.lifecycle.metrics.recoveredCandidatesAssociated,
        eventsIgnoredClosed: this.lifecycle.metrics.eventsIgnoredClosed },
      cgRepeat: { recoveryReady: this.repeatRecoveryReady(nowMs),
        repeatReadyAt: new Date(this.repeatReadyAtMs).toISOString(),
        inFlight: this.repeatProbes.running, queued: this.repeatProbes.queued, started: this.repeatProbes.started,
        coalesced: this.repeatProbes.coalesced, dropped: this.repeatProbes.dropped,
        eligibilityRejections: { ...this.repeatProbes.eligibilityRejections }, providerQueries: this.cgProviderQueries,
        providerResults: { ...this.cgProviderResults }, admissionsSuppressed: this.cgAdmissionsSuppressed,
        admissionsAccepted: this.cgAdmissionsAccepted,
        firstCgShadowOpportunities: this.firstCgShadowOpportunities, firstCgShadowEligible: this.firstCgShadowEligible },
      stormEvolution: { ...this.stormEvolution.counters, inFlightLookups: this.stormEvolutionWork.size },
    };
  }

  async drainCandidateWork(): Promise<void> {
    await Promise.all([...this.controllers.values()].map(controller => controller.waitForCompletion()));
    await this.processingQueue;
    this.repeatProbes.pump();
    await this.repeatProbes.drain();
    await this.processingQueue;
    await Promise.all([...this.stormEvolutionWork.values()]);
  }

  private applyHealthTransition(transition: ReturnType<SourceHealthTracker["frame"]>): void {
    if (!transition) return;
    this.repeatReadyAtMs = transition.atMs + CG_REPEAT_RECOVERY_HOLD_MS;
    this.emit("cg_repeat_recovery_hold", { reason: `source_${transition.to}`,
      repeatReadyAt: new Date(this.repeatReadyAtMs).toISOString(), holdMs: CG_REPEAT_RECOVERY_HOLD_MS });
    this.lifecycle.setSourceHealth({ ...this.sourceHealth.state }, transition.atMs);
    this.emit("source_health", { from: transition.from, to: transition.to });
    this.processTransitions(this.lifecycle.tick(transition.atMs));
  }

  private processTransitions(transitions: IncidentTransition[], observation?: ClusterObservation): void {
    const recoveredIds = new Set(transitions.filter(item => item.type === "candidate_recovered").map(item => item.incident.id));
    for (const transition of transitions) {
      if (transition.type === "candidate_expired" || transition.type === "candidate_recovered" ||
          (transition.type === "promoted" && recoveredIds.has(transition.incident.id))) {
        this.emit(transition.type === "promoted" ? "candidate_promoted_after_recovery" : transition.type, {
          incidentId: transition.incident.id, clusterIds: transition.incident.sourceClusterIds,
          eventCount: transition.incident.totalEvents,
          ...(transition.type === "candidate_recovered" ? { relatedIncidentId: transition.relatedIncidentId ?? null } : {}) });
      }
    }
    const decisions = applyTransitions(transitions, this.policy, this.lifecycle);
    for (const decision of decisions) {
      const incident = this.lifecycle.snapshot().incidents.find(item => item.id === decision.incidentId);
      if (!incident) continue;
      if (decision.action !== "WOULD_PUBLISH") {
        if (decision.relatedIncidentId) this.repeatPredecessors.set(incident.id, decision.relatedIncidentId);
        if (observation && CG_REPEAT_REASONS.includes(decision.reason as CgRepeatReason)) {
          const probe: RepeatProbe = { incident, observation: { ...observation }, reason: decision.reason as CgRepeatReason,
            predecessorId: this.repeatPredecessors.get(incident.id) };
          const rejection = this.repeatProbeRejection(probe);
          if (!rejection) this.repeatProbes.offer(this.repeatScopeId(incident.id), probe);
          else this.repeatProbes.recordEligibilityRejection(rejection);
        }
        continue;
      }
      this.candidateCount++;
      this.emit("incident_candidate", { incidentId: incident.id, profile: profile.id,
        eventCount: incident.totalEvents, lastActivityAt: new Date(incident.lastActivityTimeMs).toISOString() });
      const controller = this.controllerFor(incident.id);
      const started = controller.observeDecision(decision, incident, { id: profile.id, name: profile.name });
      if (started) this.beginCandidateWork(controller, incident.id);
    }
    for (const transition of transitions) {
      if (transition.type === "activity") {
        const controller = this.controllers.get(transition.incident.id);
        if (controller?.observeActivity(transition.incident, { id: profile.id, name: profile.name })) {
          this.beginCandidateWork(controller, transition.incident.id);
        }
      }
      if (transition.type === "closed" && !this.candidateWork.has(transition.incident.id)) {
        this.controllers.delete(transition.incident.id);
        this.repeatProbes.forget(this.repeatScopeId(transition.incident.id));
      }
    }
  }

  private controllerFor(incidentId: string): PairedValidationController {
    let controller = this.controllers.get(incidentId);
    if (controller) return controller;
    controller = new PairedValidationController({
      enrich: this.enrich ?? (reference => enrichInitialIncidentWithLightningType(reference, { now: this.now })),
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

  private beginCandidateWork(controller: PairedValidationController, incidentId: string): void {
    this.candidateWork.add(incidentId);
    this.triggerHealthByIncident.set(incidentId, this.sourceHealth.state.state);
    void controller.waitForCompletion().catch(() => {
      this.emit("candidate_processing_error", { incidentId, stage: "paired_validation" });
    }).finally(() => {
      this.candidateWork.delete(incidentId);
      this.triggerHealthByIncident.delete(incidentId);
      // A completed paired run has claimed its one attempt; no further activity can use
      // its controller, even if the incident itself remains active.
      this.controllers.delete(incidentId);
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
        await this.processCandidate(incidentId, artifact, this.triggerHealthByIncident.get(incidentId) ?? this.sourceHealth.state.state);
      } catch {
        this.emit("candidate_processing_error", { incidentId, stage: "unexpected" });
      } finally {
        this.inFlight.delete(incidentId);
      }
    });
    this.processingQueue = task.catch(() => undefined);
    return task;
  }

  private async processCandidate(incidentId: string, artifact: PairedValidationArtifact,
    sourceHealthAtTrigger: SourceHealth["state"], repeat?: RepeatProbe): Promise<void> {
    if (artifact.status !== "paired_result") {
      this.emit("candidate_outcome", { incidentId, status: artifact.status, reason: "no_paired_candidate" });
      return;
    }
    // The provider's raw match is not publication authorization. Recheck currentness
    // immediately before the initial artifact can reach naming and composition.
    const publicationArtifact = repeat ? artifact : {
      ...artifact, enrichment: enforceInitialCgAcceptance(artifact.enrichment, this.now()),
    };
    if (!repeat) {
      const diagnostics = publicationArtifact.enrichment.initialCgDiagnostics!;
      this.cgProviderResults[`initial:${diagnostics.outcome}`] = (this.cgProviderResults[`initial:${diagnostics.outcome}`] ?? 0) + 1;
      this.emit("enrichment_complete", { incidentId, status: publicationArtifact.enrichment.status,
        rawStatus: artifact.enrichment.status, category: diagnostics.outcome,
        initialCgAccepted: diagnostics.outcome === "accepted", counts: artifact.enrichment.counts ?? null,
        matchDiagnostics: artifact.enrichment.matchDiagnostics ?? null, initialCgDiagnostics: diagnostics,
        providerEventId: diagnostics.selectedProviderEventId,
        selectedLatitude: diagnostics.selectedLatitude, selectedLongitude: diagnostics.selectedLongitude,
        selectedEventTimeMs: diagnostics.selectedEventTimeMs, selectedDistanceKm: diagnostics.selectedDistanceKm,
        referenceTimeDeltaMs: diagnostics.selectedReferenceDeltaMs,
        selectedEventAgeMs: diagnostics.selectedProviderAgeMs,
        evaluatedProviderEventId: diagnostics.evaluatedProviderEventId,
        evaluatedDistanceKm: diagnostics.evaluatedDistanceKm,
        evaluatedReferenceDeltaMs: diagnostics.evaluatedReferenceDeltaMs,
        evaluatedProviderAgeMs: diagnostics.evaluatedProviderAgeMs });
    }
    try {
      let result = await continueFromPairedArtifact(publicationArtifact, {
        ...(this.reverse ? { reverse: this.reverse } : {}),
      });
      if (result.location && "normalized" in result.location && result.location.normalized.displayLabel) {
        this.emit("location_resolved", { incidentId, label: result.location.normalized.displayLabel,
          provider: "provider" in result.location ? result.location.provider ?? null : null });
      } else if (result.status === "no_usable_location_label") {
        this.emit("candidate_processing_error", { incidentId, stage: "location", outcome: "no_usable_location_label" });
      }
      const repeatFailure = repeat ? (this.repeatRecoveryReady(this.now()) ?
        selectedRepeatEventCheck(artifact.enrichment, repeat.observation.eventTimeMs, this.now(), MAX_PAIRING_INCIDENT_AGE_MS)
        : "recovery_or_source_unhealthy") : null;
      const context = { sourceHealthAtTrigger, ...(repeat ? { cgRepeatGate: {
        eligible: !repeatFailure, ...(repeatFailure ? { reason: `cg_repeat_${repeatFailure}` } : {}) } } : {}) };
      const admission: CgAdmissionRequest = { scopeId: this.repeatScopeId(incidentId),
        kind: repeat ? "repeat" : "initial", policyVersion: CG_REPEAT_POLICY_VERSION,
        ...(repeat ? { suppressionReason: repeat.reason,
          referenceTime: new Date(repeat.observation.eventTimeMs).toISOString(),
          repeatReadyAt: new Date(this.repeatReadyAtMs).toISOString(),
          ...(repeat.predecessorId ? { predecessorScopeId: this.repeatScopeId(repeat.predecessorId) } : {}) } : {}) };
      result = withPublishDecision(result, context);
      result = await applyPersistentLedger(result, context, this.store,
        { runId: this.runId, configured: true, cgAdmission: admission, nowMs: this.now });
      const repeatPlace = result.location && "normalized" in result.location ? {
        ...result.location.normalized, providerAddress: result.location.providerAddress } : null;
      if (repeat) {
        if (result.ledger?.cgAdmission?.outcome === "suppressed") this.cgAdmissionsSuppressed++;
        if (result.ledger?.cgAdmission?.outcome === "inserted") this.cgAdmissionsAccepted++;
        const shadow = result.ledger?.firstCgTransitionShadow;
        if (shadow) {
          this.firstCgShadowOpportunities++;
          const telemetry = cgProviderTelemetry(artifact.enrichment, repeat.observation.eventTimeMs, this.now(), MAX_PAIRING_INCIDENT_AGE_MS);
          const otherBlockers = [...new Set([...shadow.otherBlockers,
            ...(repeatFailure ? [repeatFailure] : []), ...(telemetry.currentnessFailure ? [telemetry.currentnessFailure] : []),
            ...(!this.repeatRecoveryReady(this.now()) ? ["recovery_or_source_unhealthy"] : [])])];
          const eligible = shadow.eligible && otherBlockers.length === 0;
          if (eligible) this.firstCgShadowEligible++;
          this.emit("first_cg_transition_shadow", { ...shadow, incidentId, scopeId: admission.scopeId,
            ...telemetry, eligible, otherBlockers,
            actualDecision: result.publishDecision?.decision, actualAdmissionReason: result.ledger?.cgAdmission?.reason });
        }
        this.emit("cg_repeat_outcome", { scopeId: admission.scopeId, originalSuppressionReason: repeat.reason,
        stage: result.ledger?.cgAdmission?.outcome === "inserted" ? "admission_accepted" :
          result.ledger?.cgAdmission?.outcome === "suppressed" ? "admission_suppressed" : "held_before_admission",
        providerEventId: artifact.enrichment.match?.id ?? null,
        selectedEventAgeMs: artifact.enrichment.match ? this.now() - artifact.enrichment.match.eventTimeMs : null,
        outcome: result.publishDecision?.decision, admission: result.ledger?.cgAdmission ?? null,
        classification: repeatPlace ? classifyCgPlace(repeatPlace) : null,
        semanticIdentityAvailable: repeatPlace ? semanticCgLocationIdentity(repeatPlace).available : false,
        reason: repeatFailure ?? result.ledger?.reason ?? result.reason ?? null });
      }
      if (result.ledger?.duplicateMatch?.duplicate) {
        this.emit("duplicate_detected", { incidentId, publicationId: result.ledger.duplicateMatch.matchedPublicationId,
          reason: result.ledger.duplicateMatch.reason });
      }
      if (result.publishDecision?.decision === "WOULD_PUBLISH" && result.ledger?.approvalStatus === "pending" &&
          result.ledger.recordPersisted && result.ledger.writeDisposition === "inserted" &&
          result.ledger.duplicateMatch?.duplicate === false && result.ledger.persistedPublicationId &&
          result.message?.ok && result.publishDecision.messageReady && result.publishDecision.locationUsable &&
          result.message.enrichmentStatus !== "provider_unavailable") {
        if (!repeat && result.location && "normalized" in result.location && result.location.normalized.displayLabel) {
          const coordinate = result.location.requested;
          this.stormEvolution.setBaseline(incidentId, coordinate.latitude, coordinate.longitude, {
            ...result.location.normalized, providerAddress: result.location.providerAddress,
            latitude: coordinate.latitude, longitude: coordinate.longitude,
            displayLabel: result.location.normalized.displayLabel, provider: result.location.provider,
          });
          this.scheduleStormEvolution(incidentId, this.now());
        }
        this.pendingCount++;
        this.emit("publication_pending", { incidentId, publicationId: result.ledger.persistedPublicationId,
          approvalStatus: "pending", decision: result.publishDecision?.decision ?? null,
          messageText: result.message?.ok ? result.message.text : null });
        if (this.notifyPending) {
          const publicationId = result.ledger.persistedPublicationId;
          try {
            const sent = await this.notifyPending({ publicationId,
              hashtag: result.message.composer.hashtag, messageText: result.message.text,
              locationLabel: result.message.locationDisplayLabel,
              enrichmentStatus: result.message.enrichmentStatus, autoPublish: Boolean(this.autoPublish) });
            this.emit(sent.ok ? "telegram_notification_sent" : "telegram_notification_failed", {
              incidentId, publicationId, ...(sent.ok ? {} : { reason: sent.reason,
                ...(sent.httpStatus === undefined ? {} : { httpStatus: sent.httpStatus }) }),
            });
          } catch {
            this.emit("telegram_notification_failed", { incidentId, publicationId, reason: "unexpected_error" });
          }
        }
        await autoPublishNewPending(result.ledger.persistedPublicationId, incidentId,
          this.autoPublish, this.emit, this.now, this.notifyAutoPublishFailure);
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

  private pruneHistoricalState(nowMs: number): void {
    const removedClusterIds = this.pipeline.clusterer.pruneClosed(nowMs, CLOSED_CLUSTER_RETENTION_MS);
    for (const id of removedClusterIds) this.closedClusterIds.delete(id);
    const retainedClusterIds = new Set(this.pipeline.clusterer.clusters.map(cluster => cluster.id));
    const removedIncidentIds = this.lifecycle.pruneClosed(nowMs, retainedClusterIds, this.candidateWork);
    for (const id of removedIncidentIds) {
      this.stormEvolution.forget(id);
      this.controllers.delete(id);
      this.repeatProbes.forget(this.repeatScopeId(id));
      this.repeatPredecessors.delete(id);
    }
    this.policy.pruneClosed(nowMs);
  }

  private scheduleStormEvolution(incidentId: string, atMs: number): void {
    const requests = this.stormEvolution.takeLookupRequests(incidentId, atMs);
    if (!requests.length) return;
    const previous = this.stormEvolutionWork.get(incidentId) ?? Promise.resolve();
    const work = previous.then(async () => {
      const reverse = this.reverse ?? ((lat: number, lon: number) =>
        new NominatimReverseGeocoder().reverse(lat, lon, { includeProviderHierarchy: true }));
      // Existing Nominatim client serializes requests at the public rate limit.
      for (const request of requests) {
        let place: ReverseGeocodeResult | null = null;
        try { place = await reverse(request.latitude, request.longitude); } catch { /* Ambiguous; no eligible shadow result. */ }
        this.stormEvolution.resolve(incidentId, request.cellId, place);
      }
      this.emitStormEvolution(incidentId, this.now());
    }).finally(() => { if (this.stormEvolutionWork.get(incidentId) === work) this.stormEvolutionWork.delete(incidentId); });
    this.stormEvolutionWork.set(incidentId, work);
  }

  private emitStormEvolution(incidentId: string, atMs: number): void {
    const incident = this.lifecycle.incidents.find(item => item.id === incidentId && item.status === "active");
    if (!incident) return;
    const evaluation = this.stormEvolution.evaluate(incidentId, incident.sourceClusterIds, atMs);
    if (evaluation && this.stormEvolution.shouldEmit(incidentId, evaluation)) this.emit("storm_evolution_shadow", evaluation);
  }

  private repeatScopeId(incidentId: string): string { return `cg_${this.runId}_${incidentId}`; }

  private repeatRecoveryReady(nowMs: number): boolean {
    return Number.isFinite(nowMs) && nowMs >= this.repeatReadyAtMs && this.sourceHealth.state.state === "live" &&
      nowMs >= this.sourceHealth.state.lastFrameAtMs && nowMs - this.sourceHealth.state.lastFrameAtMs < this.sourceHealth.staleAfterMs;
  }

  private repeatProbeEligible(probe: RepeatProbe): boolean {
    return this.repeatProbeRejection(probe) === null;
  }

  private repeatProbeRejection(probe: RepeatProbe): string | null {
    const now = this.now();
    const age = now - probe.observation.eventTimeMs;
    const incident = this.lifecycle.incidents.find(item => item.id === probe.incident.id);
    if (!this.store.admitCgPublication) return "atomic_admission_unavailable";
    if (!this.repeatRecoveryReady(now)) return "recovery_or_source_unhealthy";
    if (incident?.status !== "active" || incident.promotedAtMs === undefined || incident.totalEvents < profile.promotionMinEvents) return "incident_not_promoted_active";
    if (this.candidateWork.has(incident.id) && !this.repeatInFlight.has(incident.id)) return "initial_candidate_in_flight";
    if (!CG_REPEAT_REASONS.includes(probe.reason)) return "unsupported_suppression";
    if (!Number.isFinite(age) || age < 0 || age > MAX_PAIRING_INCIDENT_AGE_MS) return "reference_not_current";
    return null;
  }

  private async processRepeatProbe(probe: RepeatProbe): Promise<void> {
    const rejection = this.repeatProbeRejection(probe);
    if (rejection) { this.repeatProbes.recordEligibilityRejection(rejection); return; }
    const reference = { latitude: probe.observation.latitude, longitude: probe.observation.longitude,
      eventTimeMs: probe.observation.eventTimeMs };
    this.candidateWork.add(probe.incident.id);
    this.repeatInFlight.add(probe.incident.id);
    try {
      this.emit("cg_repeat_probe", { scopeId: this.repeatScopeId(probe.incident.id),
        stage: "provider_query_executed", originalSuppressionReason: probe.reason, reference, recoveryReady: true,
        coalesced: this.repeatProbes.coalesced, dropped: this.repeatProbes.dropped });
      this.cgProviderQueries++;
      const enrichment = await (this.enrich ?? enrichIncidentWithLightningType)(reference);
      const telemetry = cgProviderTelemetry(enrichment, reference.eventTimeMs, this.now(), MAX_PAIRING_INCIDENT_AGE_MS);
      this.cgProviderResults[`repeat:${telemetry.category}`] = (this.cgProviderResults[`repeat:${telemetry.category}`] ?? 0) + 1;
      this.emit("cg_repeat_provider_result", { scopeId: this.repeatScopeId(probe.incident.id), incidentId: probe.incident.id, ...telemetry });
      const failure = selectedRepeatEventCheck(enrichment, reference.eventTimeMs, this.now(), MAX_PAIRING_INCIDENT_AGE_MS);
      if (failure || !this.repeatRecoveryReady(this.now())) {
        this.emit("cg_repeat_outcome", { scopeId: this.repeatScopeId(probe.incident.id), outcome: "held",
          reason: failure ?? "recovery_or_source_unhealthy" });
        return;
      }
      const artifact: PairedValidationArtifact = { status: "paired_result", triggerMode: "cg_repeat_probe",
        profile: { id: profile.id, name: profile.name }, capturedAt: new Date(this.now()).toISOString(),
        incident: { incidentId: probe.incident.id, latitude: probe.incident.representativeLatitude,
          longitude: probe.incident.representativeLongitude, eventTimeMs: reference.eventTimeMs,
          firstActivityTimeMs: probe.incident.firstEventTimeMs, lastActivityTimeMs: enrichment.match!.eventTimeMs,
          eventCount: probe.incident.totalEvents, clusterCount: probe.incident.sourceClusterIds.length },
        enrichment, guardrail: { maxEnrichmentCalls: 1, enrichmentCalls: 1, providerRequestAttempted: true },
        triggerFreshness: { incidentAgeMs: this.now() - reference.eventTimeMs, maxIncidentAgeMs: MAX_PAIRING_INCIDENT_AGE_MS,
          stalePublishCount: 0, freshestSkippedIncidentAgeMs: null, futureDatedPublishCount: 0,
          invalidTimestampPublishCount: 0, trackedStaleIncidentCount: 0, staleIncidentsWithLaterActivityCount: 0, reactivatedIncidentCount: 0 },
      };
      const work = this.processingQueue.then(() => this.processCandidate(probe.incident.id, artifact, "live", probe));
      this.processingQueue = work.catch(() => undefined);
      await work;
    } finally { this.candidateWork.delete(probe.incident.id); this.repeatInFlight.delete(probe.incident.id); }
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
