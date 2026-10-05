// Standalone research listener. It is deliberately not imported by the app.
import { EXTREMADURA_ACTIVE_BOX, backoffMs, parseFrame, subscription, type Box } from "../live-lightning-listener/core.ts";
import { DEFAULT_CLUSTER_PARAMETERS, DEFAULT_PARAMETER_PROFILES, clusterShapeMetrics,
  evaluateParameterProfiles, type ClusterParameters } from "./clusterer.ts";
import { LightningClusteringPipeline } from "./pipeline.ts";

function positive(value: string | undefined, name: string): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`Invalid ${name}`);
  return n;
}
function options(argv: string[]) {
  const flags = new Map<string, string>();
  const allowed = new Set(["duration", "box", "max-distance-km", "max-gap-minutes", "freshness-minutes", "close-after-minutes", "summary-every", "format"]);
  for (const arg of argv) {
    if (!arg.startsWith("--") || !arg.includes("=")) throw new Error(`Expected --name=value: ${arg}`);
    const [key, ...rest] = arg.slice(2).split("=");
    if (!allowed.has(key)) throw new Error(`Unknown flag: ${key}`);
    flags.set(key, rest.join("="));
  }
  const coordinates = flags.get("box")?.split(",").map(Number);
  if (coordinates && (coordinates.length !== 4 || coordinates.some(n => !Number.isFinite(n)))) throw new Error("--box=north,east,south,west");
  const box: Box = coordinates ? { north: coordinates[0], east: coordinates[1], south: coordinates[2], west: coordinates[3] } : EXTREMADURA_ACTIVE_BOX;
  if (box.north > 90 || box.south < -90 || box.north <= box.south || box.east > 180 || box.west < -180 || box.east <= box.west) throw new Error("Invalid box bounds");
  const parameters: ClusterParameters = {
    maxSpatialDistanceKm: positive(flags.get("max-distance-km") ?? String(DEFAULT_CLUSTER_PARAMETERS.maxSpatialDistanceKm), "max-distance-km"),
    maxTemporalGapMinutes: positive(flags.get("max-gap-minutes") ?? String(DEFAULT_CLUSTER_PARAMETERS.maxTemporalGapMinutes), "max-gap-minutes"),
    freshnessWindowMinutes: positive(flags.get("freshness-minutes") ?? String(DEFAULT_CLUSTER_PARAMETERS.freshnessWindowMinutes), "freshness-minutes"),
    clusterCloseAfterMinutes: positive(flags.get("close-after-minutes") ?? String(DEFAULT_CLUSTER_PARAMETERS.clusterCloseAfterMinutes), "close-after-minutes"),
  };
  const format = flags.get("format") ?? "human";
  if (format !== "human" && format !== "jsonl") throw new Error("--format=human|jsonl");
  return { box, parameters, format, durationMs: positive(flags.get("duration") ?? "15", "duration") * 60_000,
    summaryMs: positive(flags.get("summary-every") ?? "60", "summary-every") * 1000 };
}

const config = options(process.argv.slice(2));
const endpoint = "wss://live2.lightningmaps.org/";
const startedAt = Date.now();
const pipeline = new LightningClusteringPipeline(config.box, config.parameters);
const lastIds: Record<string, number> = {};
let messages = 0, reconnects = 0, connections = 0, attempt = 0;
let stopping = false;
let socket: WebSocket | null = null;
const pending = new Set<() => void>();

function emit(kind: string, data: Record<string, unknown> = {}) {
  const row = { kind, at: new Date().toISOString(), ...data };
  if (config.format === "jsonl") console.log(JSON.stringify(row));
  else console.log(`${row.at} ${kind}: ${JSON.stringify(data)}`);
}
function outputSummary(kind: string) {
  const now = Date.now();
  const state = pipeline.summary(now);
  emit(kind, { endpoint, box: config.box, parameters: config.parameters, durationSeconds: Math.round((now - startedAt) / 1000),
    messages, connections, reconnects, malformed: state.malformed, decoded: state.decoded, unique: state.unique, duplicates: state.duplicates,
    insideSubscriptionBox: state.insideSubscriptionBox, outsideSubscriptionBox: state.outsideSubscriptionBox,
    insideSubscriptionBoxFresh: state.insideSubscriptionBoxFresh,
    insideSubscriptionBoxStale: state.insideSubscriptionBoxStale,
    insideSubscriptionBoxFuture: state.insideSubscriptionBoxFuture,
    insideMonitoringArea: state.insideMonitoringArea,
    insideMonitoringAreaFresh: state.insideMonitoringAreaFresh,
    insideMonitoringAreaStale: state.insideMonitoringAreaStale,
    insideMonitoringAreaFuture: state.insideMonitoringAreaFuture,
    insideSubscriptionBoxOutsideMonitoringArea: state.insideSubscriptionBoxOutsideMonitoringArea,
    allUniqueFresh: state.allUniqueFresh, allUniqueStale: state.allUniqueStale, allUniqueFuture: state.allUniqueFuture,
    comparisonEventsRetained: state.retainedComparisonEvents,
    comparisonEventsDropped: state.comparisonEventsDropped, clusterMetrics: clusterShapeMetrics(state.clusters),
    freshnessNote: "Freshness is processing wall clock minus estimated event timestamp; it is not a guarantee of live delivery." });
}
function stop(reason: string) {
  if (stopping) return;
  stopping = true; clearTimeout(durationTimer); clearInterval(summaryTimer); emit("stopping", { reason });
  for (const resolve of pending) resolve();
  socket?.close(1000, "research stop");
}
process.once("SIGINT", () => stop("SIGINT"));
process.once("SIGTERM", () => stop("SIGTERM"));
const durationTimer = setTimeout(() => stop("duration"), config.durationMs);
const summaryTimer = setInterval(() => outputSummary("periodic_summary"), config.summaryMs);
summaryTimer.unref();
emit("run_start", { endpoint, box: config.box, parameters: config.parameters, durationMinutes: config.durationMs / 60_000,
  cookies: false, customOrigin: false, persistence: false, maxRetainedComparisonEvents: 100_000 });

function updateResumeId(key: string | undefined) {
  if (!key) return;
  const [source, idString] = key.split("/");
  const id = Number(idString);
  if (Number.isSafeInteger(id)) lastIds[source] = Math.max(lastIds[source] ?? 0, id);
}
async function connectOnce(): Promise<void> {
  const openingAt = Date.now();
  await new Promise<void>(resolve => {
    const ws = new WebSocket(endpoint);
    socket = ws;
    let finished = false;
    const finish = () => { if (finished) return; finished = true; clearTimeout(openTimer); socket = null; resolve(); };
    const openTimer = setTimeout(() => { emit("connection_error", { message: "open timeout" }); ws.close(); finish(); }, 20_000);
    ws.addEventListener("open", () => {
      clearTimeout(openTimer); attempt = 0; connections++;
      emit("connected", { connectionNumber: connections, handshakeMs: Date.now() - openingAt, resumeIdsSent: Object.keys(lastIds).length });
      ws.send(subscription(config.box, connections > 1 ? lastIds : {}));
    });
    ws.addEventListener("message", message => {
      messages++;
      if (typeof message.data !== "string") { pipeline.recordMalformed(); return; }
      const frame = parseFrame(message.data, Date.now());
      if (frame.kind === "malformed") { pipeline.recordMalformed(); return; }
      if (frame.kind !== "events") return;
      pipeline.recordMalformed(frame.rejected);
      for (const event of frame.events) {
        updateResumeId(event.sourceEventKey);
        pipeline.accept(event, Date.now());
      }
    });
    ws.addEventListener("error", error => emit("connection_error", { message: (error as ErrorEvent).message || "WebSocket error" }));
    ws.addEventListener("close", event => { emit("disconnected", { code: event.code, reason: event.reason, clean: event.wasClean }); finish(); });
  });
}
async function wait(ms: number) {
  await new Promise<void>(resolve => {
    let done = false;
    const finish = () => { if (done) return; done = true; clearTimeout(timer); pending.delete(finish); resolve(); };
    const timer = setTimeout(finish, ms); pending.add(finish); if (stopping) finish();
  });
}

while (!stopping) {
  await connectOnce();
  if (stopping) break;
  reconnects++;
  const delay = backoffMs(attempt++);
  emit("reconnect_wait", { delayMs: delay, resumeIdGroups: Object.keys(lastIds).length });
  await wait(delay);
}
pipeline.closeAll(Date.now());
outputSummary("run_summary");
const profiles = [...DEFAULT_PARAMETER_PROFILES];
if (!profiles.some(p => JSON.stringify(p) === JSON.stringify(config.parameters))) profiles.unshift(config.parameters);
emit("parameter_sensitivity_same_unique_inside_sequence", { inputEvents: pipeline.comparisonEvents.length,
  truncated: pipeline.counters.comparisonEventsDropped > 0,
  results: evaluateParameterProfiles(pipeline.comparisonEvents, profiles, Date.now()) });
