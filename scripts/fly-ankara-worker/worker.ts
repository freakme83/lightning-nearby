// Continuous, passive shadow observer. No incident writes, provider enrichment, or publishing.
import { ANKARA_MONITORING_AREA, pointInMonitoringArea } from "../lightning-incident-lifecycle/monitoring-area.ts";
import { BoundedDedupe, backoffMs, eventKey, parseFrame, subscription } from "../live-lightning-listener/core.ts";

const endpoint = "wss://live2.lightningmaps.org/";
const box = ANKARA_MONITORING_AREA.bounds;
const summaryEveryMs = 5 * 60_000;
const frameTimeoutMs = 90_000;
const dedupe = new BoundedDedupe(20_000);
const lastIds: Record<string, number> = {};
const counters = {
  messages: 0, decoded: 0, unique: 0, duplicates: 0, malformed: 0,
  insideSubscriptionBounds: 0, insideAnkaraPolygon: 0, connections: 0, reconnects: 0,
};
const startedAt = Date.now();
let stopping = false;
let sourceHealthy = false;
let lastFrameAt: number | null = null;
let socket: WebSocket | null = null;
let attempt = 0;
let sleepTimer: ReturnType<typeof setTimeout> | null = null;
let resolveSleep: (() => void) | null = null;

function emit(kind: string, fields: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ kind, at: new Date().toISOString(), ...fields }));
}

function summary(reason = "periodic") {
  emit("summary", {
    reason,
    region: process.env.FLY_REGION ?? null,
    uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
    sourceHealthy,
    lastFrameAt: lastFrameAt === null ? null : new Date(lastFrameAt).toISOString(),
    ...counters,
  });
}

function resumeId(sourceEventKey: string | undefined) {
  if (!sourceEventKey) return;
  const [source, rawId] = sourceEventKey.split("/");
  const id = Number(rawId);
  if (Number.isSafeInteger(id)) lastIds[source] = Math.max(lastIds[source] ?? 0, id);
}

function acceptFrame(data: unknown) {
  counters.messages++;
  lastFrameAt = Date.now();
  if (typeof data !== "string") {
    counters.malformed++;
    emit("malformed_frame", { reason: "non-text frame" });
    return;
  }
  const frame = parseFrame(data, lastFrameAt);
  if (frame.kind === "malformed") {
    counters.malformed++;
    emit("malformed_frame", { reason: frame.reason });
    return;
  }
  if (!sourceHealthy) {
    sourceHealthy = true;
    emit("source_health", { to: "live", firstFrameAt: new Date(lastFrameAt).toISOString() });
  }
  if (frame.kind !== "events") return;
  counters.malformed += frame.rejected;
  for (const event of frame.events) {
    counters.decoded++;
    resumeId(event.sourceEventKey);
    if (dedupe.seen(eventKey(event))) {
      counters.duplicates++;
      continue;
    }
    counters.unique++;
    const withinBounds = event.latitude <= box.north && event.latitude >= box.south &&
      event.longitude <= box.east && event.longitude >= box.west;
    if (withinBounds) {
      counters.insideSubscriptionBounds++;
      if (pointInMonitoringArea([event.longitude, event.latitude])) counters.insideAnkaraPolygon++;
    }
  }
}

function stop(reason: string) {
  if (stopping) return;
  stopping = true;
  clearInterval(summaryTimer);
  if (sleepTimer) clearTimeout(sleepTimer);
  resolveSleep?.();
  emit("stopping", { reason });
  socket?.close(1000, "worker stopping");
}

process.once("SIGINT", () => stop("SIGINT"));
process.once("SIGTERM", () => stop("SIGTERM"));
const summaryTimer = setInterval(() => summary(), summaryEveryMs);
summaryTimer.unref();
emit("worker_start", {
  endpoint,
  area: ANKARA_MONITORING_AREA.id,
  subscriptionBounds: box,
  polygonFilter: true,
  persistence: false,
  xweather: false,
  approval: false,
  publishing: false,
});

async function connectOnce(): Promise<void> {
  const openingAt = Date.now();
  sourceHealthy = false;
  await new Promise<void>(resolve => {
    let settled = false;
    let watchdog: ReturnType<typeof setInterval> | null = null;
    let lastFrameOnConnection = Date.now();
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(openTimer);
      if (watchdog) clearInterval(watchdog);
      socket = null;
      resolve();
    };
    const openTimer = setTimeout(() => {
      emit("connection_error", { reason: "open timeout" });
      ws.close();
      finish();
    }, 20_000);
    let ws: WebSocket;
    try {
      ws = new WebSocket(endpoint);
      socket = ws;
    } catch (error) {
      clearTimeout(openTimer);
      emit("connection_error", { reason: String(error) });
      finish();
      return;
    }
    ws.addEventListener("open", () => {
      clearTimeout(openTimer);
      attempt = 0;
      counters.connections++;
      emit("connected", { connectionNumber: counters.connections, handshakeMs: Date.now() - openingAt });
      ws.send(subscription(box, counters.connections > 1 ? lastIds : {}));
      watchdog = setInterval(() => {
        if (Date.now() - lastFrameOnConnection >= frameTimeoutMs) {
          emit("connection_error", { reason: "90s without any frames" });
          ws.close();
        }
      }, 15_000);
    });
    ws.addEventListener("message", event => {
      lastFrameOnConnection = Date.now();
      acceptFrame(event.data);
    });
    ws.addEventListener("error", () => emit("connection_error", { reason: "WebSocket error" }));
    ws.addEventListener("close", event => {
      emit("disconnected", { code: event.code, reason: event.reason, clean: event.wasClean });
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
    emit("reconnect_wait", { delayMs });
    await wait(delayMs);
  }
} finally {
  summary("shutdown");
}
