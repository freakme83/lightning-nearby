// Research-only latency/replay run. No production imports, storage, or browser headers.
import { ANKARA_BOX, backoffMs, BoundedDedupe, eventKey, inBox, parseFrame, subscription,
  type Box, type LightningEvent } from "./core.ts";
import { freshestEventLagMs, LatencyTimeline, summarizeLatencies } from "./latency-core.ts";

function positive(value: string | undefined, label: string, allowZero = false): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || (allowZero ? parsed < 0 : parsed <= 0)) throw new Error(`Invalid ${label}`);
  return parsed;
}
function readOptions(argv: string[]) {
  const args = new Map<string, string>();
  const allowed = new Set(["duration", "summary-every", "box", "reconnect-after", "reconnect-downtime", "resume"]);
  for (const arg of argv) {
    if (!arg.startsWith("--") || !arg.includes("=")) throw new Error(`Expected --name=value, received ${arg}`);
    const [name, ...values] = arg.slice(2).split("=");
    if (!allowed.has(name)) throw new Error(`Unknown flag: ${name}`);
    args.set(name, values.join("="));
  }
  const parts = args.get("box")?.split(",").map(Number);
  if (parts && (parts.length !== 4 || parts.some(value => !Number.isFinite(value)))) throw new Error("--box=north,east,south,west");
  const box: Box = parts ? { north: parts[0], east: parts[1], south: parts[2], west: parts[3] } : ANKARA_BOX;
  if (box.north > 90 || box.south < -90 || box.north <= box.south || box.east > 180 || box.west < -180 || box.east <= box.west) throw new Error("Invalid box bounds");
  const resume = args.get("resume") ?? "true";
  if (resume !== "true" && resume !== "false") throw new Error("--resume=true|false");
  return {
    box, resume: resume === "true",
    durationMs: positive(args.get("duration") ?? "15", "duration") * 60_000,
    summaryMs: positive(args.get("summary-every") ?? "30", "summary-every") * 1000,
    reconnectAfterMs: args.has("reconnect-after") ? positive(args.get("reconnect-after"), "reconnect-after") * 1000 : null,
    reconnectDowntimeMs: positive(args.get("reconnect-downtime") ?? "10", "reconnect-downtime", true) * 1000,
  };
}

const config = readOptions(process.argv.slice(2));
const endpoint = "wss://live2.lightningmaps.org/";
const runStartedAtMs = Date.now();
const timeline = new LatencyTimeline();
const dedupe = new BoundedDedupe();
const lastIds: Record<string, number> = {};
let messages = 0, decoded = 0, unique = 0, duplicates = 0, malformed = 0, reconnects = 0, successfulConnections = 0;
let newestEventTimeMs: number | null = null;
let firstEventLatencyMs: number | null = null;
let currentConnectionStartedAtMs: number | null = null;
let firstConnectionStartedAtMs: number | null = null;
let lastConnectionEndedAtMs: number | null = null;
let lastSuccessfulDisconnectAtMs: number | null = null;
let reconnectDowntimeMs: number | null = null;
let reconnectIndex = 0;
let plannedReconnectDone = false;
let stopping = false;
let currentSocket: WebSocket | null = null;
let attempt = 0;
let insideRequestedBox = 0;
const pendingWaits = new Set<() => void>();

function emit(kind: string, data: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ kind, at: new Date().toISOString(), ...data }));
}
function eventLatencyStats() {
  return summarizeLatencies(timeline.observations());
}
function emitSample(kind: string) {
  const now = Date.now();
  emit(kind, { currentWallClock: new Date(now).toISOString(), newestEventTimeSeen: newestEventTimeMs === null ? null : new Date(newestEventTimeMs).toISOString(),
    freshestEventLagMs: freshestEventLagMs(newestEventTimeMs, now), connectionAgeMs: currentConnectionStartedAtMs === null ? null : now - currentConnectionStartedAtMs,
    totalUniqueEvents: unique, latency: eventLatencyStats(), timeline: timeline.summary() });
}
function stop(reason: string) {
  if (stopping) return;
  stopping = true;
  clearTimeout(durationTimer);
  emit("stopping", { reason });
  for (const resolve of pendingWaits) resolve();
  currentSocket?.close(1000, "research stop");
}
process.once("SIGINT", () => stop("SIGINT"));
process.once("SIGTERM", () => stop("SIGTERM"));
const durationTimer = setTimeout(() => stop("duration"), config.durationMs);
const sampleTimer = setInterval(() => emitSample("freshest_event_lag"), config.summaryMs);
sampleTimer.unref();
emit("run_start", { endpoint, box: config.box, subscription: JSON.parse(subscription(config.box)), customOrigin: false, cookies: false,
  resumeOnReconnect: config.resume, durationMinutes: config.durationMs / 60_000,
  plannedReconnectAfterSeconds: config.reconnectAfterMs === null ? null : config.reconnectAfterMs / 1000,
  plannedReconnectDowntimeSeconds: config.reconnectDowntimeMs / 1000, maxRetainedObservations: timeline.capacity });

function accept(event: LightningEvent, connectionStartedAtMs: number) {
  decoded++;
  newestEventTimeMs = Math.max(newestEventTimeMs ?? event.eventTimeMs, event.eventTimeMs);
  const key = eventKey(event);
  if (event.sourceEventKey) {
    const [src, id] = event.sourceEventKey.split("/");
    const value = Number(id);
    if (Number.isSafeInteger(value)) lastIds[src] = Math.max(lastIds[src] ?? 0, value);
  }
  if (dedupe.seen(key)) { duplicates++; return; }
  unique++;
  const latencyMs = event.receivedAtMs - event.eventTimeMs;
  firstEventLatencyMs ??= latencyMs;
  const inside = inBox(event, config.box);
  if (inside) insideRequestedBox++;
  timeline.record({ eventTimeMs: event.eventTimeMs, receivedAtMs: event.receivedAtMs, latencyMs,
    sourceEventKey: event.sourceEventKey ?? null, connectionAgeMs: event.receivedAtMs - connectionStartedAtMs,
    insideRequestedBox: inside, reconnectIndex });
}

async function wait(ms: number) {
  await new Promise<void>(resolve => {
    const finish = () => { clearTimeout(timer); pendingWaits.delete(finish); resolve(); };
    const timer = setTimeout(finish, ms);
    pendingWaits.add(finish);
    if (stopping) finish();
  });
}
async function connectOnce(): Promise<{ opened: boolean; intentional: boolean }> {
  let opened = false;
  let intentional = false;
  const attemptStartedAtMs = Date.now();
  let connectionOpenedAtMs: number | null = null;
  await new Promise<void>(resolve => {
    const ws = new WebSocket(endpoint);
    currentSocket = ws;
    let finished = false;
    let lastFrame = Date.now();
    let plannedTimer: ReturnType<typeof setTimeout> | null = null;
    let watchdog: ReturnType<typeof setInterval> | null = null;
    const finish = () => {
      if (finished) return;
      finished = true;
      if (plannedTimer) clearTimeout(plannedTimer);
      if (watchdog) clearInterval(watchdog);
      currentSocket = null;
      resolve();
    };
    const openTimer = setTimeout(() => {
      emit("connection_error", { message: "open timeout" });
      ws.close();
      finish();
    }, 20_000);
    ws.addEventListener("open", () => {
      clearTimeout(openTimer);
      opened = true;
      attempt = 0;
      const now = Date.now();
      connectionOpenedAtMs = now;
      currentConnectionStartedAtMs = now;
      firstConnectionStartedAtMs ??= now;
      reconnectDowntimeMs = lastSuccessfulDisconnectAtMs === null ? null : now - lastSuccessfulDisconnectAtMs;
      if (successfulConnections > 0) reconnects++;
      successfulConnections++;
      emit("connected", { connectionNumber: successfulConnections, connectionStart: new Date(now).toISOString(),
        handshakeMs: now - attemptStartedAtMs, downtimeSincePreviousDisconnectMs: reconnectDowntimeMs,
        resumeIdsSent: config.resume && reconnectIndex > 0 ? { ...lastIds } : {}, reconnectIndex });
      ws.send(subscription(config.box, config.resume && reconnectIndex > 0 ? lastIds : {}));
      if (!plannedReconnectDone && reconnectIndex === 0 && config.reconnectAfterMs !== null) {
        plannedTimer = setTimeout(() => { intentional = true; plannedReconnectDone = true;
          emit("planned_reconnect", { afterConnectionSeconds: config.reconnectAfterMs! / 1000 }); ws.close(1000, "latency resume experiment");
        }, config.reconnectAfterMs);
      }
      watchdog = setInterval(() => {
        if (Date.now() - lastFrame > 90_000) { emit("connection_error", { message: "90s without any frames" }); ws.close(); }
      }, 15_000);
    });
    ws.addEventListener("message", message => {
      lastFrame = Date.now(); messages++;
      if (typeof message.data !== "string") { malformed++; return; }
      const frame = parseFrame(message.data, lastFrame);
      if (frame.kind === "malformed") malformed++;
      else if (frame.kind === "events") { malformed += frame.rejected; for (const event of frame.events) accept(event, currentConnectionStartedAtMs ?? lastFrame); }
      else if (frame.control !== "other") emit("control", { control: frame.control });
    });
    ws.addEventListener("error", error => emit("connection_error", { message: (error as ErrorEvent).message ?? "WebSocket error" }));
    ws.addEventListener("close", event => {
      const now = Date.now();
      lastConnectionEndedAtMs = now;
      if (connectionOpenedAtMs !== null) lastSuccessfulDisconnectAtMs = now;
      currentConnectionStartedAtMs = null;
      emit("disconnected", { at: new Date(now).toISOString(), code: event.code, reason: event.reason, clean: event.wasClean,
        intentional, connectionAgeMs: connectionOpenedAtMs === null ? null : now - connectionOpenedAtMs });
      finish();
    });
  });
  return { opened, intentional };
}

while (!stopping) {
  const result = await connectOnce();
  if (stopping) break;
  if (result.intentional && !plannedReconnectDone) continue;
  if (result.intentional && plannedReconnectDone && reconnectIndex === 0) {
    emit("reconnect_downtime_start", { at: new Date().toISOString(), durationMs: config.reconnectDowntimeMs });
    await wait(config.reconnectDowntimeMs);
    if (stopping) break;
    reconnectIndex = 1;
    emit("reconnect_downtime_end", { at: new Date().toISOString() });
  } else {
    const waitMs = backoffMs(attempt++);
    emit("reconnect_wait", { waitMs, opened: result.opened });
    if (firstConnectionStartedAtMs !== null) reconnectIndex = Math.max(reconnectIndex, 1);
    await wait(waitMs);
  }
}

clearInterval(sampleTimer);
const endedAt = Date.now();
emit("run_summary", { connectionStart: firstConnectionStartedAtMs === null ? null : new Date(firstConnectionStartedAtMs).toISOString(),
  connectionEnd: lastConnectionEndedAtMs === null ? new Date(endedAt).toISOString() : new Date(lastConnectionEndedAtMs).toISOString(),
  durationSeconds: (endedAt - runStartedAtMs) / 1000, successfulConnections, messages, decoded, unique, duplicates, malformed, reconnects,
  firstEventLatencyMs, currentWallClock: new Date(endedAt).toISOString(), newestEventTimeSeen: newestEventTimeMs === null ? null : new Date(newestEventTimeMs).toISOString(),
  freshestEventLagMs: freshestEventLagMs(newestEventTimeMs, endedAt), latency: eventLatencyStats(), timeline: timeline.summary(),
  reconnectDowntimeMs, insideRequestedBox, outsideRequestedBox: unique - insideRequestedBox,
  note: "Latency summaries use bounded retained unique events; reconnect downtime is an unknown coverage interval." });
