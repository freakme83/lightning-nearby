// Research-only incident lifecycle dry-run. No application import or real publisher.
import { writeFile } from "node:fs/promises";
import { backoffMs, parseFrame, subscription, type LightningEvent } from "../live-lightning-listener/core.ts";
import { LightningClusteringPipeline } from "../live-lightning-clustering/pipeline.ts";
import { IncidentLifecycleEngine } from "./incident-engine.ts";
import { compareIncidentProfiles, applyTransitions } from "./experiment.ts";
import { DryRunPublishPolicy } from "./publish-policy.ts";
import { median } from "./stats.ts";
import { SourceHealthTracker } from "./source-health.ts";
import { INCIDENT_POLICY_PROFILES, type IncidentPolicyProfile, type IncidentReplaySignal, type IncidentTransition, type PublishDecision } from "./types.ts";
import { pointInMonitoringArea } from "./monitoring-area.ts";
import { readIncidentRunnerOptions } from "./options.ts";
import { PairedValidationController } from "../lightning-cg-paired-validation/controller.ts";

const config = readIncidentRunnerOptions(process.argv.slice(2));
const profile = INCIDENT_POLICY_PROFILES.find(item => item.id === config.profileId)!;
const endpoint = "wss://live2.lightningmaps.org/";
const startedAtMs = Date.now();
const monitoringAcceptance = config.monitoringArea ? {
  id: config.monitoringArea.id,
  bounds: config.monitoringArea.bounds,
  contains: (event: LightningEvent) =>
    pointInMonitoringArea([event.longitude, event.latitude], config.monitoringArea!),
} : undefined;
const pipeline = new LightningClusteringPipeline(config.box, config.parameters,
  monitoringAcceptance ? { monitoringArea: monitoringAcceptance } : {});
const lifecycle = new IncidentLifecycleEngine(profile, startedAtMs);
const publishPolicy = new DryRunPublishPolicy(profile);
const sourceHealth = new SourceHealthTracker(startedAtMs);
const resumeIds: Record<string, number> = {};
const replaySignals: IncidentReplaySignal[] = [];
const maxSignals = 100_000;
const loggedSuppressions = new Set<string>();
let signalsDropped = 0;
let messages = 0;
let connections = 0;
let reconnects = 0;
let attempt = 0;
let stopping = false;
let socket: WebSocket | null = null;
const closedClusterIds = new Set<string>();
const pendingWaits = new Set<() => void>();
const pairedValidation = config.pairedValidationOutput ? new PairedValidationController({
  onEnrichmentStarted: () => stop("first_fresh_would_publish_paired_validation"),
  onStaleTriggerSkipped: diagnostic => emit("paired_validation_stale_trigger_skipped", diagnostic),
  writeArtifact: async artifact => {
    await writeFile(config.pairedValidationOutput!, `${JSON.stringify(artifact, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    emit("paired_validation_artifact_written", { status: artifact.status, path: config.pairedValidationOutput });
  },
}) : null;

function emit(kind: string, data: Record<string, unknown> = {}) {
  const row = { kind, at: new Date().toISOString(), ...data };
  console.log(config.format === "jsonl" ? JSON.stringify(row) : `${row.at} ${kind}: ${JSON.stringify(data)}`);
}
function retain(signal: IncidentReplaySignal) {
  if (replaySignals.length < maxSignals) replaySignals.push(signal);
  else signalsDropped++;
}
function logDecision(decision: PublishDecision) {
  if (decision.action === "WOULD_PUBLISH") {
    emit("WOULD_PUBLISH", { incidentId: decision.incidentId, reason: decision.reason,
      events: lifecycle.snapshot().incidents.find(item => item.id === decision.incidentId)?.totalEvents });
    if (pairedValidation) {
      const incident = lifecycle.snapshot().incidents.find(item => item.id === decision.incidentId);
      if (incident) pairedValidation.observeDecision(decision, incident, profile);
    }
  } else {
    const key = `${decision.incidentId}:${decision.reason}`;
    if (loggedSuppressions.has(key)) return;
    loggedSuppressions.add(key);
    emit("SUPPRESS", { incidentId: decision.incidentId, reason: decision.reason, relatedIncidentId: decision.relatedIncidentId });
  }
}
function processTransitions(transitions: IncidentTransition[]) {
  for (const transition of transitions) {
    if (transition.type === "candidate_created") emit("CANDIDATE", { incidentId: transition.incident.id, events: transition.incident.totalEvents });
    if (transition.type === "candidate_expired") emit("CANDIDATE_EXPIRED", { incidentId: transition.incident.id,
      events: transition.incident.totalEvents, reason: transition.incident.closeReason });
    if (transition.type === "closed") emit("INCIDENT_CLOSED", { incidentId: transition.incident.id,
      events: transition.incident.totalEvents, reason: transition.incident.closeReason });
  }
  for (const decision of applyTransitions(transitions, publishPolicy, lifecycle)) logDecision(decision);
  if (pairedValidation) {
    for (const transition of transitions) {
      if (transition.type === "activity" && pairedValidation.observeActivity(transition.incident, profile)) {
        emit("paired_validation_reactivated", { incidentId: transition.incident.id });
      }
    }
  }
}
function recordHealthTransition(transition: ReturnType<SourceHealthTracker["frame"]>, intentional = false) {
  if (!transition) return;
  const state = { ...sourceHealth.state };
  retain({ kind: "source_health", atMs: transition.atMs, health: state, intentional });
  lifecycle.setSourceHealth(state, transition.atMs);
  emit("source_health", { from: transition.from, to: transition.to });
  processTransitions(lifecycle.tick(transition.atMs));
}
function syncClosedClusters(nowMs: number) {
  for (const cluster of pipeline.clusterer.clusters) {
    if (cluster.status !== "closed" || closedClusterIds.has(cluster.id)) continue;
    closedClusterIds.add(cluster.id);
    const signal: IncidentReplaySignal = { kind: "cluster_closed", sourceClusterId: cluster.id, atMs: nowMs };
    retain(signal);
    processTransitions(lifecycle.clusterClosed(cluster.id, nowMs));
  }
}
function updateResumeId(key: string | undefined) {
  if (!key) return;
  const [source, idText] = key.split("/");
  const id = Number(idText);
  if (Number.isSafeInteger(id)) resumeIds[source] = Math.max(resumeIds[source] ?? 0, id);
}
function summary(nowMs: number, kind: string) {
  const stale = sourceHealth.poll(nowMs);
  recordHealthTransition(stale);
  if (stale) socket?.close(4000, "source health stale; research reconnect");
  const state = pipeline.summary(nowMs);
  syncClosedClusters(nowMs);
  processTransitions(lifecycle.tick(nowMs));
  const incident = lifecycle.snapshot();
  const publish = publishPolicy.summary();
  const eventsAtPromotion = incident.metrics.eventsAtPromotion;
  emit(kind, { endpoint, box: config.box, areaSelection: config.areaSelection,
    monitoringArea: config.monitoringArea?.id ?? null,
    clusterParameters: config.parameters, incidentProfile: profile,
    durationSeconds: Math.round((nowMs - startedAtMs) / 1000), messages, connections, reconnects,
    malformed: state.malformed, decoded: state.decoded, unique: state.unique, duplicates: state.duplicates,
    insideSubscriptionBox: state.insideSubscriptionBox,
    insideSubscriptionBoxOutsideMonitoringArea: state.insideSubscriptionBoxOutsideMonitoringArea,
    insideSubscriptionBoxFresh: state.insideSubscriptionBoxFresh,
    insideSubscriptionBoxStale: state.insideSubscriptionBoxStale,
    insideSubscriptionBoxFuture: state.insideSubscriptionBoxFuture,
    insideMonitoringArea: state.insideMonitoringArea,
    insideMonitoringAreaFresh: state.insideMonitoringAreaFresh,
    insideMonitoringAreaStale: state.insideMonitoringAreaStale,
    insideMonitoringAreaFuture: state.insideMonitoringAreaFuture,
    outsideSubscriptionBox: state.outsideSubscriptionBox,
    allUniqueFresh: state.allUniqueFresh,
    allUniqueStale: state.allUniqueStale, allUniqueFuture: state.allUniqueFuture,
    clustersObserved: incident.metrics.clustersObserved, candidatesCreated: incident.metrics.incidentCandidatesCreated,
    candidatesExpired: incident.metrics.candidatesExpired, singletonClustersIgnored: incident.metrics.singletonClustersIgnored,
    promoted: incident.metrics.incidentsPromoted,
    averageEventsAtPromotion: eventsAtPromotion.length
      ? eventsAtPromotion.reduce((sum, count) => sum + count, 0) / eventsAtPromotion.length : null,
    medianTimeToPromotionMinutes: median(incident.metrics.timeToPromotionMs) === null ? null
      : median(incident.metrics.timeToPromotionMs)! / 60_000,
    wouldPublish: publish.publishCandidatesGenerated, suppressions: publish.suppressions,
    suppressionsByReason: publish.suppressionsByReason, nearbyRepeatSuppressions: publish.nearbyRepeatSuppressions,
    reopenedOrRecreated: incident.metrics.reopenedOrRecreated,
    closedIncidents: incident.metrics.incidentsClosed, activeIncidents: incident.activeIncidents,
    medianIncidentDurationMinutes: median(incident.metrics.incidentDurationMs) === null ? null
      : median(incident.metrics.incidentDurationMs)! / 60_000,
    sourceHealth: sourceHealth.state, sourceHealthInterruptions: sourceHealth.interruptions,
    retainedReplaySignals: replaySignals.length, replaySignalsDropped: signalsDropped,
    note: "WOULD_PUBLISH is a synthetic research decision; no message is created or sent." });
}

function stop(reason: string) {
  if (stopping) return;
  stopping = true;
  clearTimeout(durationTimer);
  clearInterval(summaryTimer);
  emit("stopping", { reason });
  for (const resolve of pendingWaits) resolve();
  socket?.close(1000, "research stop");
}
process.once("SIGINT", () => stop("SIGINT"));
process.once("SIGTERM", () => stop("SIGTERM"));
const durationTimer = setTimeout(() => stop("duration"), config.durationMs);
const summaryTimer = setInterval(() => summary(Date.now(), "periodic_summary"), config.summaryMs);
summaryTimer.unref();
emit("run_start", { endpoint, box: config.box, areaSelection: config.areaSelection,
  monitoringArea: config.monitoringArea?.id ?? null, clusterParameters: config.parameters,
  incidentProfile: profile, comparisonProfiles: INCIDENT_POLICY_PROFILES.map(item => item.id),
  durationMinutes: config.durationMs / 60_000, cookies: false, customOrigin: false,
  maxRetainedReplaySignals: maxSignals, persistence: false });

async function connectOnce(): Promise<void> {
  const openingAt = Date.now();
  await new Promise<void>(resolve => {
    const ws = new WebSocket(endpoint);
    socket = ws;
    let finished = false;
    let opened = false;
    const finish = () => { if (finished) return; finished = true; clearTimeout(openTimer); socket = null; resolve(); };
    const openTimer = setTimeout(() => {
      emit("connection_error", { message: "open timeout" });
      recordHealthTransition(sourceHealth.disconnected(Date.now()));
      ws.close(); finish();
    }, 20_000);
    ws.addEventListener("open", () => {
      clearTimeout(openTimer); opened = true; connections++; attempt = 0;
      recordHealthTransition(sourceHealth.connecting(Date.now()));
      emit("connected", { connectionNumber: connections, handshakeMs: Date.now() - openingAt,
        resumeIdGroups: Object.keys(resumeIds).length });
      ws.send(subscription(config.box, connections > 1 ? resumeIds : {}));
    });
    ws.addEventListener("message", message => {
      const receivedAtMs = Date.now();
      messages++;
      recordHealthTransition(sourceHealth.frame(receivedAtMs));
      const frame = typeof message.data === "string" ? parseFrame(message.data, receivedAtMs) : null;
      if (!frame || frame.kind === "malformed") { pipeline.recordMalformed(); return; }
      if (frame.kind !== "events") return;
      pipeline.recordMalformed(frame.rejected);
      for (const event of frame.events) {
        updateResumeId(event.sourceEventKey);
        const result = pipeline.accept(event, receivedAtMs);
        if (!result.clusterId) continue;
        const observation = { sourceClusterId: result.clusterId, eventTimeMs: event.eventTimeMs,
          receivedAtMs, latitude: event.latitude, longitude: event.longitude };
        retain({ kind: "activity", atMs: receivedAtMs, observation });
        processTransitions(lifecycle.tick(receivedAtMs));
        processTransitions(lifecycle.observe(observation));
      }
      syncClosedClusters(receivedAtMs);
    });
    ws.addEventListener("error", error => emit("connection_error", { message: (error as ErrorEvent).message || "WebSocket error" }));
    ws.addEventListener("close", event => {
      if (finished) return;
      recordHealthTransition(sourceHealth.disconnected(Date.now(), !stopping), stopping);
      emit("disconnected", { code: event.code, reason: event.reason, clean: event.wasClean, opened });
      finish();
    });
  });
}
async function wait(ms: number) {
  await new Promise<void>(resolve => {
    let done = false;
    const finish = () => { if (done) return; done = true; clearTimeout(timer); pendingWaits.delete(finish); resolve(); };
    const timer = setTimeout(finish, ms); pendingWaits.add(finish); if (stopping) finish();
  });
}

while (!stopping) {
  await connectOnce();
  if (stopping) break;
  reconnects++;
  const delay = backoffMs(attempt++);
  emit("reconnect_wait", { delayMs: delay, resumeIdGroups: Object.keys(resumeIds).length });
  await wait(delay);
}

await pairedValidation?.waitForCompletion();
const endedAtMs = Date.now();
summary(endedAtMs, "run_summary");
const comparisons = compareIncidentProfiles(replaySignals, INCIDENT_POLICY_PROFILES, endedAtMs);
emit("same_sequence_policy_comparison", { replaySignals: replaySignals.length, signalsDropped,
  inputActivityEvents: replaySignals.filter(item => item.kind === "activity").length, results: comparisons });
if (pairedValidation) {
  await pairedValidation.writeNoCandidate({
    profile: { id: profile.id, name: profile.name },
    areaSelection: config.areaSelection,
    bounds: config.box,
    startedAtMs,
    endedAtMs,
    sourceHealth: sourceHealth.state.state,
    wouldPublishCount: publishPolicy.summary().publishCandidatesGenerated,
  });
}
