import type { SourceHealth } from "./source-health.ts";
import { IncidentLifecycleEngine } from "./incident-engine.ts";
import { DryRunPublishPolicy } from "./publish-policy.ts";
import { median } from "./stats.ts";
import type { IncidentPolicyProfile, IncidentReplaySignal, IncidentTransition, LightningIncident, PublishDecision } from "./types.ts";

export type IncidentExperimentResult = {
  profile: IncidentPolicyProfile;
  clustersObserved: number;
  incidentCandidatesCreated: number;
  candidatesExpired: number;
  incidentsPromoted: number;
  incidentsClosed: number;
  publishCandidatesGenerated: number;
  suppressions: number;
  suppressionsByReason: Record<string, number>;
  nearbyRepeatSuppressions: number;
  reopenedOrRecreated: number;
  singletonClustersIgnored: number;
  sourceHealthInterruptions: number;
  averageEventsAtPromotion: number | null;
  medianTimeToPromotionMinutes: number | null;
  medianIncidentDurationMinutes: number | null;
  activeIncidents: number;
  candidates: number;
  closedIncidents: number;
};

export function applyTransitions(transitions: IncidentTransition[], policy: DryRunPublishPolicy,
  engine: IncidentLifecycleEngine): PublishDecision[] {
  const decisions: PublishDecision[] = [];
  for (const transition of transitions) {
    if (transition.type === "promoted") {
      const decision = policy.onPromotion(transition.incident, transition.incident.promotedAtMs ?? transition.incident.lastActivityTimeMs);
      if (decision.action === "WOULD_PUBLISH") engine.recordWouldPublish(transition.incident.id);
      decisions.push(decision);
    } else if (transition.type === "activity") {
      const decision = policy.onActivity(transition.incident);
      if (decision) decisions.push(decision);
    } else if (transition.type === "closed") policy.onClosed(transition.incident);
  }
  return decisions;
}

function countHealthInterruptions(signals: IncidentReplaySignal[]): number {
  let health: SourceHealth["state"] = "disconnected";
  let interruptions = 0;
  for (const signal of signals) {
    if (signal.kind !== "source_health") continue;
    if (!signal.intentional && health === "live" && signal.health.state !== "live") interruptions++;
    health = signal.health.state;
  }
  return interruptions;
}

export function runIncidentExperiment(signals: IncidentReplaySignal[], profile: IncidentPolicyProfile, finishAtMs: number) {
  const engine = new IncidentLifecycleEngine(profile, signals[0]?.atMs ?? finishAtMs);
  const policy = new DryRunPublishPolicy(profile);
  const decisions: PublishDecision[] = [];
  for (const signal of signals) {
    if (signal.kind === "source_health") {
      engine.setSourceHealth(signal.health, signal.atMs);
      decisions.push(...applyTransitions(engine.tick(signal.atMs), policy, engine));
    } else {
      decisions.push(...applyTransitions(engine.tick(signal.atMs), policy, engine));
      const transitions = signal.kind === "activity"
        ? engine.observe(signal.observation)
        : engine.clusterClosed(signal.sourceClusterId, signal.atMs);
      decisions.push(...applyTransitions(transitions, policy, engine));
    }
  }
  decisions.push(...applyTransitions(engine.tick(finishAtMs), policy, engine));
  const snapshot = engine.snapshot();
  const pub = policy.summary();
  const eventsAtPromotion = snapshot.metrics.eventsAtPromotion;
  const durationMs = snapshot.metrics.incidentDurationMs;
  return {
    engine, policy, decisions,
    result: {
      profile: { ...profile }, clustersObserved: snapshot.metrics.clustersObserved,
      incidentCandidatesCreated: snapshot.metrics.incidentCandidatesCreated,
      candidatesExpired: snapshot.metrics.candidatesExpired, incidentsPromoted: snapshot.metrics.incidentsPromoted,
      incidentsClosed: snapshot.metrics.incidentsClosed, publishCandidatesGenerated: pub.publishCandidatesGenerated,
      suppressions: pub.suppressions, suppressionsByReason: pub.suppressionsByReason,
      nearbyRepeatSuppressions: pub.nearbyRepeatSuppressions,
      reopenedOrRecreated: snapshot.metrics.reopenedOrRecreated,
      singletonClustersIgnored: snapshot.metrics.singletonClustersIgnored,
      sourceHealthInterruptions: countHealthInterruptions(signals),
      averageEventsAtPromotion: eventsAtPromotion.length
        ? eventsAtPromotion.reduce((sum, value) => sum + value, 0) / eventsAtPromotion.length : null,
      medianTimeToPromotionMinutes: median(snapshot.metrics.timeToPromotionMs) === null ? null
        : median(snapshot.metrics.timeToPromotionMs)! / 60_000,
      medianIncidentDurationMinutes: median(durationMs) === null ? null : median(durationMs)! / 60_000,
      activeIncidents: snapshot.activeIncidents, candidates: snapshot.candidates, closedIncidents: snapshot.closedIncidents,
    } satisfies IncidentExperimentResult,
  };
}

export function compareIncidentProfiles(signals: IncidentReplaySignal[], profiles: IncidentPolicyProfile[], finishAtMs: number): IncidentExperimentResult[] {
  return profiles.map(profile => runIncidentExperiment(signals, profile, finishAtMs).result);
}
