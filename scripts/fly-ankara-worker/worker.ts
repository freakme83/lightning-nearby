// Continuous Ankara observer and pending-publication preparer. It has no X publisher.
import { ANKARA_MONITORING_AREA } from "../lightning-incident-lifecycle/monitoring-area.ts";
import { backoffMs } from "../live-lightning-listener/core.ts";
import { processBlitzortungFrame, type BlitzortungServer } from "../research/blitzortung-probe/protocol.ts";
import { BLITZ_ADMISSION_MAX_LATENCY_MS, BlitzPrimaryAdmission, blitzSourceStillHealthy,
  shouldLogBlitzAdmissionRejection } from "./blitz-primary.ts";
import { createFlyPipelineStore, AnkaraFlyPipeline, FlyPipelineConfigurationError } from "./runtime.ts";
import { createPendingPublicationNotifier } from "../lightning-telegram-notifier/pending.ts";
import { createFlyAutoPublish } from "./auto-publish.ts";
import { createLedgerHealthMonitor } from "./ledger-health.ts";
import { createCaptureStore } from "../replay-capture/store.ts";
import { ReplayCaptureManager } from "../replay-capture/manager.ts";
import { CaptureSourceReadiness } from "../replay-capture/source-readiness.ts";
import { createContinuousCapture } from "./continuous-capture.ts";
import { createActivityWatch } from "./activity-watch.ts";
import { createActivityTelegram } from "../activity-telegram/dispatcher.ts";

const summaryEveryMs = 5 * 60_000;
const frameTimeoutMs = 90_000;
const WORKER_BLITZORTUNG_SERVERS = ["ws1", "ws8"] as const;
const blitzAdmission = new BlitzPrimaryAdmission();
const counters = { messages: 0, decoded: 0, connections: 0, reconnects: 0, malformed: 0 };
const startedAt = Date.now();
let stopping = false;
let sourceHealthy = false;
let lastFrameAt: number | null = null;
let socket: WebSocket | null = null;
let attempt = 0;
let serverIndex = 0;
let sleepTimer: ReturnType<typeof setTimeout> | null = null;
let resolveSleep: (() => void) | null = null;
let ledgerHealth: ReturnType<typeof createLedgerHealthMonitor> | null = null;
let replayCapture: ReplayCaptureManager | null = null;
const captureReadiness = new CaptureSourceReadiness();

function emit(kind: string, fields: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ kind, at: new Date().toISOString(), ...fields }));
}

let runtime: AnkaraFlyPipeline;
try {
  const store = createFlyPipelineStore(process.env);
  if (store.checkAvailability) {
    ledgerHealth = createLedgerHealthMonitor({ check: signal => store.checkAvailability!(signal), emit });
    ledgerHealth.start();
  }
  const telegram = createPendingPublicationNotifier(process.env);
  if (telegram.invalidSettings.length) {
    emit("configuration_warning", { capability: "telegram", disabled: true,
      invalidSettings: telegram.invalidSettings });
  }
  const autoPublish = createFlyAutoPublish(process.env, emit);
  runtime = new AnkaraFlyPipeline({ store, emit, autoPublish,
    ...(telegram.notify ? { notifyPending: telegram.notify } : {}),
    ...(telegram.notifyAutoPublishFailure ? { notifyAutoPublishFailure: telegram.notifyAutoPublishFailure } : {}) });
} catch (error) {
  if (error instanceof FlyPipelineConfigurationError) {
    emit("configuration_error", { missing: error.missing });
  } else {
    emit("configuration_error", { reason: "Supabase ledger configuration is invalid" });
  }
  process.exitCode = 1;
  throw error;
}

function summary(reason = "periodic") {
  sourceHealthy = blitzSourceStillHealthy(lastFrameAt, Date.now(), frameTimeoutMs) && !stopping;
  emit("summary", {
    reason,
    region: process.env.FLY_REGION ?? null,
    uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
    sourceHealthy,
    lastFrameAt: lastFrameAt === null ? null : new Date(lastFrameAt).toISOString(),
    ...counters,
    ...blitzAdmission.counters,
    ...runtime.summary(Date.now()),
  });
}

const continuousCapture = createContinuousCapture(process.env, emit);
const activityWatch = createActivityWatch(process.env,
  () => captureReadiness.isReady(socket?.readyState === WebSocket.OPEN, Date.now(), frameTimeoutMs), emit);
// Independent informational notifications from committed Activity Watch rows; own timer,
// disabled unless ACTIVITY_TELEGRAM_ENABLED=true, never on the frame or publication path.
const activityTelegram = createActivityTelegram(process.env, emit);

function acceptFrame(data: unknown, sourceServer: BlitzortungServer) {
  counters.messages++;
  const receivedAt = Date.now();
  if (typeof data !== "string") {
    counters.malformed++;
    runtime.recordMalformed();
    emit("malformed_frame", { reason: "non-text frame" });
    return;
  }
  const frame = processBlitzortungFrame(data, receivedAt, sourceServer);
  if (frame.kind !== "event") {
    counters.malformed++;
    runtime.recordMalformed();
    emit("malformed_frame", { source: "blitzortung", reason: frame.reason, kind: frame.kind });
    return;
  }
  sourceHealthy = true;
  lastFrameAt = receivedAt;
  captureReadiness.validEvent(receivedAt);
  replayCapture?.markSourceRecovery(receivedAt);
  continuousCapture?.sourceState("healthy", "valid_event");
  activityWatch?.sourceState(true);
  runtime.recordFrame(receivedAt);
  counters.decoded++;
  try { replayCapture?.observe(frame.event); }
  catch { emit("replay_capture_error", { source: "blitzortung", stage: "observe", reason: "unexpected_error" }); }
  continuousCapture?.observe(frame.event);
  try { activityWatch?.observe(frame.event); }
  catch { emit("activity_watch_error", { stage: "observe", reason: "unexpected_error" }); }
  const admission = blitzAdmission.admit(frame.event, (event, atMs) => { runtime.acceptEvent(event, atMs); });
  if (shouldLogBlitzAdmissionRejection(admission)) emit("blitz_admission_rejected", { reason: admission,
    sourceServer, latencyMs: frame.event.latencyMs });
}

function stop(reason: string) {
  if (stopping) return;
  stopping = true;
  sourceHealthy = false;
  runtime.recordDisconnected(Date.now(), true);
  clearInterval(summaryTimer);
  if (sleepTimer) clearTimeout(sleepTimer);
  ledgerHealth?.stop();
  replayCapture?.stop();
  continuousCapture?.stop();
  activityWatch?.stop();
  activityTelegram?.stop();
  resolveSleep?.();
  emit("stopping", { reason });
  socket?.close(1000, "worker stopping");
}

process.once("SIGINT", () => stop("SIGINT"));
process.once("SIGTERM", () => stop("SIGTERM"));
const summaryTimer = setInterval(() => summary(), summaryEveryMs);
summaryTimer.unref();
emit("worker_start", {
  endpoints: WORKER_BLITZORTUNG_SERVERS.map(server => `wss://${server}.blitzortung.org/`),
  area: ANKARA_MONITORING_AREA.id,
  subscription: { a: 111 },
  polygonFilter: true,
  incidentProfile: "B",
  freshnessLimitMs: 240_000,
  blitzAdmissionMaxLatencyMs: BLITZ_ADMISSION_MAX_LATENCY_MS,
  live2Role: "separate-shadow-observer-only",
  ...runtime.capabilities,
});
try {
  const captureStore = createCaptureStore({ url: process.env.SUPABASE_URL,
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY });
  replayCapture = new ReplayCaptureManager(captureStore,
    () => captureReadiness.isReady(socket?.readyState === WebSocket.OPEN, Date.now(), frameTimeoutMs),
    emit, Date.now, () => captureReadiness.generation());
  replayCapture.start();
} catch {
  emit("replay_capture_error", { source: "blitzortung", stage: "configuration", reason: "unavailable" });
}

async function connectOnce(): Promise<void> {
  const sourceServer = WORKER_BLITZORTUNG_SERVERS[serverIndex++ % WORKER_BLITZORTUNG_SERVERS.length];
  const endpoint = `wss://${sourceServer}.blitzortung.org/`;
  const openingAt = Date.now();
  captureReadiness.beginConnection();
  replayCapture?.markSourceGap("source_disconnect", openingAt);
  continuousCapture?.sourceState("unhealthy", "connecting");
  activityWatch?.sourceState(false);
  if (!blitzSourceStillHealthy(lastFrameAt, openingAt, frameTimeoutMs)) {
    if (sourceHealthy) runtime.recordDisconnected(openingAt);
    sourceHealthy = false;
    runtime.markConnecting(openingAt);
  }
  await new Promise<void>(resolve => {
    let settled = false;
    let watchdog: ReturnType<typeof setInterval> | null = null;
    let closeGrace: ReturnType<typeof setTimeout> | null = null;
    let watchdogTriggered = false;
    let lastFrameOnConnection = openingAt;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (!stopping && !blitzSourceStillHealthy(lastFrameAt, Date.now(), frameTimeoutMs)) {
        sourceHealthy = false;
        runtime.recordDisconnected(Date.now());
      }
      clearTimeout(openTimer);
      if (watchdog) clearInterval(watchdog);
      if (closeGrace) clearTimeout(closeGrace);
      if (socket === ws) socket = null;
      resolve();
    };
    const openTimer = setTimeout(() => {
      emit("connection_error", { sourceServer, reason: "open timeout" });
      ws.close();
      finish();
    }, 20_000);
    let ws: WebSocket;
    try {
      ws = new WebSocket(endpoint);
      socket = ws;
    } catch (error) {
      clearTimeout(openTimer);
      emit("connection_error", { sourceServer, reason: error instanceof Error ? error.name : "WebSocket construction failed" });
      finish();
      return;
    }
    ws.addEventListener("open", () => {
      if (settled || socket !== ws) return;
      clearTimeout(openTimer);
      attempt = 0;
      counters.connections++;
      emit("connected", { source: "blitzortung", sourceServer,
        connectionNumber: counters.connections, handshakeMs: Date.now() - openingAt });
      ws.send(JSON.stringify({ a: 111 }));
      watchdog = setInterval(() => {
        if (!blitzSourceStillHealthy(lastFrameAt, Date.now(), frameTimeoutMs)) {
          continuousCapture?.sourceState("unhealthy", "valid_event_timeout");
          activityWatch?.sourceState(false, false);
        }
        if (!watchdogTriggered && Date.now() - lastFrameOnConnection >= frameTimeoutMs) {
          watchdogTriggered = true;
          replayCapture?.markSourceGap("source_unhealthy");
          continuousCapture?.sourceState("unhealthy", "source_unhealthy");
          activityWatch?.sourceState(false, false);
          const previousLastFrameAt = lastFrameAt;
          emit("source_health", {
            to: "stale",
            reason: "90s without any frames",
            lastFrameAt: previousLastFrameAt === null ? null : new Date(previousLastFrameAt).toISOString(),
          });
          emit("connection_error", { sourceServer, reason: "90s without any frames" });
          ws.close();
          closeGrace = setTimeout(finish, 5_000);
        }
      }, 15_000);
    });
    ws.addEventListener("message", event => {
      if (settled || socket !== ws) return;
      lastFrameOnConnection = Date.now();
      acceptFrame(event.data, sourceServer);
    });
    ws.addEventListener("error", () => emit("connection_error", { sourceServer, reason: "WebSocket error" }));
    ws.addEventListener("close", event => {
      if (socket === ws) {
        replayCapture?.markSourceGap("source_disconnect");
        continuousCapture?.sourceState("unhealthy", "source_disconnect");
        activityWatch?.sourceState(false);
      }
      emit("disconnected", { sourceServer, code: event.code, reason: event.reason,
        clean: event.wasClean, sourceHealthyDuringReconnect: sourceHealthy });
      finish();
    });
  });
}

function wait(ms: number): Promise<void> {
  return new Promise(resolve => {
    resolveSleep = resolve;
    sleepTimer = setTimeout(() => {
      sleepTimer = null;
      resolveSleep = null;
      resolve();
    }, ms);
  });
}

try {
  while (!stopping) {
    await connectOnce();
    if (stopping) break;
    counters.reconnects++;
    const delayMs = backoffMs(attempt++);
    emit("reconnect_wait", { source: "blitzortung", delayMs, sourceHealthy });
    await wait(delayMs);
  }
} finally {
  summary("shutdown");
  await runtime.drainCandidateWork();
}
