// Research-only incident lifecycle dry-run. No application import or real publisher.
import { EXTREMADURA_ACTIVE_BOX, backoffMs, parseFrame, subscription, type Box } from "../live-lightning-listener/core.ts";
import { DEFAULT_CLUSTER_PARAMETERS } from "../live-lightning-clustering/clusterer.ts";
import { LightningClusteringPipeline } from "../live-lightning-clustering/pipeline.ts";
import { IncidentLifecycleEngine } from "./incident-engine.ts";
import { compareIncidentProfiles, applyTransitions } from "./experiment.ts";
import { DryRunPublishPolicy } from "./publish-policy.ts";
import { SourceHealthTracker } from "./source-health.ts";
import { INCIDENT_POLICY_PROFILES, type IncidentPolicyProfile, type IncidentReplaySignal, type IncidentTransition, type PublishDecision } from "./types.ts";

function positive(value: string | undefined, name: string): number {
  const result = Number(value);
  if (!Number.isFinite(result) || result <= 0) throw new Error(`Invalid ${name}`);
  return result;
}
function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}
function readOptions(argv: string[]) {
  const args = new Map<string, string>();
  const allowed = new Set(["duration", "box", "incident-profile", "summary-every", "format"]);
  for (const arg of argv) {
    if (!arg.startsWith("--") || !arg.includes("=")) throw new Error(`Expected --name=value: ${arg}`);
    const [name, ...rest] = arg.slice(2).split("=");
    if (!allowed.has(name)) throw new Error(`Unknown flag: ${name}`);
    args.set(name, rest.join("="));
  }
  const values = args.get("box")?.split(",").map(Number);
  if (values && (values.length !== 4 || values.some(n => !Number.isFinite(n)))) throw new Error("--box=north,east,south,west");
  const box: Box = values ? { north: values[0], east: values[1], south: values[2], west: values[3] } : EXTREMADURA_ACTIVE_BOX;
  if (box.north > 90 || box.south < -90 || box.north <= box.south || box.east > 180 || box.west < -180 || box.east <= box.west) {
    throw new Error("Invalid box bounds");
  }
  const selected = (args.get("incident-profile") ?? "B").toUpperCase();
  const profile = INCIDENT_POLICY_PROFILES.find(item => item.id === selected);
  if (!profile) throw new Error("--incident-profile=A|B|C");
  const format = args.get("format") ?? "human";
  if (format !== "human" && format !== "jsonl") throw new Error("--format=human|jsonl");
  return { box, profile, format, durationMs: positive(args.get("duration") ?? "15", "duration") * 60_000,
    summaryMs: positive(args.get("summary-every") ?? "60", "summary-every") * 1000 };
}

const config = readOptions(process.argv.slice(2));
const endpoint = "wss://live2.lightningmaps.org/";
const startedAtMs = Date.now();
const pipeline = new LightningClusteringPipeline(config.box, DEFAULT_CLUSTER_PARAMETERS);
const lifecycle = new IncidentLifecycleEngine(config.profile, startedAtMs);
const publishPolicy = new DryRunPublishPolicy(config.profile);
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
  emit(kind, { endpoint, box: config.box, clusterParameters: DEFAULT_CLUSTER_PARAMETERS, incidentProfile: config.profile,
    durationSeconds: Math.round((nowMs - startedAtMs) / 1000), messages, connections, reconnects,
    malformed: state.malformed, decoded: state.decoded, unique: state.unique, duplicates: state.duplicates,
    insideBox: state.insideBox, insideBoxFresh: state.insideBoxFresh, insideBoxStale: state.insideBoxStale,
    insideBoxFuture: state.insideBoxFuture, allUniqueFresh: state.allUniqueFresh,
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
emit("run_start", { endpoint, box: config.box, clusterParameters: DEFAULT_CLUSTER_PARAMETERS,
  incidentProfile: config.profile, comparisonProfiles: INCIDENT_POLICY_PROFILES.map(item => item.id),
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

const endedAtMs = Date.now();
summary(endedAtMs, "run_summary");
const comparisons = compareIncidentProfiles(replaySignals, INCIDENT_POLICY_PROFILES, endedAtMs);
emit("same_sequence_policy_comparison", { replaySignals: replaySignals.length, signalsDropped,
  inputActivityEvents: replaySignals.filter(item => item.kind === "activity").length, results: comparisons });
