// Long-running research observer. Both inputs terminate in observer-local stdout telemetry.
import { ANKARA_MONITORING_AREA } from "../../lightning-incident-lifecycle/monitoring-area.ts";
import { parseFrame, subscription } from "../../live-lightning-listener/core.ts";
import {
  BLITZORTUNG_SERVERS,
  processBlitzortungFrame,
  type BlitzortungServer,
} from "../blitzortung-probe/protocol.ts";
import {
  CrossSourceMatcher,
  FixedObservationWindows,
  LOOSE_MATCH_MAX_DISTANCE_KM,
  LOOSE_MATCH_MAX_TIME_MS,
  MATCH_FINALIZATION_DELAY_MS,
  OBSERVATION_WINDOW_MS,
  ObserverSourceState,
  STRICT_MATCH_MAX_DISTANCE_KM,
  STRICT_MATCH_MAX_TIME_MS,
  normalizeBlitzObserverEvent,
  normalizeLive2ObserverEvent,
  type MatchFinalization,
  type ObservationWindowSummary,
  type ObserverEvent,
  type ObserverSource,
} from "./core.ts";
import { createObserverHttpServer, OBSERVER_API_DEFAULT_PORT } from "./http-api.ts";
import { BlitzRecentEventCache } from "./recent-cache.ts";
import { ObserverSocketOwnership, runResilientSourceLoop } from "./runtime.ts";

const LIVE2_ENDPOINT = "wss://live2.lightningmaps.org/";
const SUMMARY_EVERY_MS = 60_000;
const FINALIZE_EVERY_MS = 1_000;
const OPEN_TIMEOUT_MS = 20_000;
const CLOSE_GRACE_MS = 5_000;
const SOURCE_QUIET_TIMEOUT_MS: Record<ObserverSource, number> = {
  live2: 90_000,
  blitzortung: 120_000,
};

type ObserverSocket = WebSocket;
type ConnectionOptions = {
  source: ObserverSource;
  sourceServer: BlitzortungServer | null;
  endpoint: string;
  state: ObserverSourceState;
  ownership: ObserverSocketOwnership<ObserverSocket>;
  signal: AbortSignal;
  onOpen: (socket: ObserverSocket) => void;
  onMessage: (data: unknown, receivedAtMs: number) => void;
};

const startedAtMs = Date.now();
const controller = new AbortController();
const matcher = new CrossSourceMatcher();
const windows = new FixedObservationWindows();
const live2State = new ObserverSourceState("live2", startedAtMs);
const blitzState = new ObserverSourceState("blitzortung", startedAtMs);
const live2Sockets = new ObserverSocketOwnership<ObserverSocket>();
const blitzSockets = new ObserverSocketOwnership<ObserverSocket>();
const blitzRecentCache = new BlitzRecentEventCache();
const httpServer = createObserverHttpServer(blitzRecentCache, process.env.OBSERVER_API_TOKEN);
let live2Sequence = 0;
let blitzSequence = 0;
let blitzServerIndex = 0;
let stopping = false;

function emit(kind: string, fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ kind, observer: "dual_source_shadow", at: new Date().toISOString(), ...fields }));
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.message : "unknown observer error";
}

function endpointForBlitz(server: BlitzortungServer): string {
  return `wss://${server}.blitzortung.org/`;
}

function sourceConnectionFields(options: ConnectionOptions): Record<string, unknown> {
  return { source: options.source, sourceServer: options.sourceServer, endpoint: options.endpoint };
}

function connectOnce(options: ConnectionOptions): Promise<boolean> {
  options.state.connecting(options.sourceServer);
  emit("dual_source_source_connection", {
    ...sourceConnectionFields(options), action: "connecting",
  });
  const attemptedAtMs = Date.now();
  return new Promise(resolve => {
    let socket: ObserverSocket;
    try {
      socket = new WebSocket(options.endpoint);
    } catch (error) {
      options.state.disconnected();
      emit("dual_source_error", {
        ...sourceConnectionFields(options), stage: "socket_construction", reason: errorName(error),
      });
      resolve(false);
      return;
    }

    options.ownership.claim(socket);
    let settled = false;
    let opened = false;
    let receivedFrame = false;
    let closing = false;
    let lastFrameAtMs = attemptedAtMs;
    let watchdog: ReturnType<typeof setInterval> | null = null;
    let closeGrace: ReturnType<typeof setTimeout> | null = null;

    const settle = () => {
      if (settled) return;
      settled = true;
      clearTimeout(openTimer);
      if (watchdog) clearInterval(watchdog);
      if (closeGrace) clearTimeout(closeGrace);
      options.signal.removeEventListener("abort", onAbort);
      const owned = options.ownership.release(socket);
      if (owned) {
        options.state.disconnected();
        if (options.source === "blitzortung") blitzRecentCache.setObservationActive(false, Date.now());
      }
      resolve(opened && receivedFrame);
    };

    const requestClose = (code: number, reason: string) => {
      if (!options.ownership.owns(socket) || closing) return;
      closing = true;
      socket.close(code, reason);
      // A broken implementation must not block shutdown/reconnect forever. No
      // newer attempt can begin until this grace timer settles this attempt.
      closeGrace ??= setTimeout(settle, CLOSE_GRACE_MS);
    };

    const onAbort = () => requestClose(1000, "observer shutdown");
    options.signal.addEventListener("abort", onAbort, { once: true });

    const openTimer = setTimeout(() => {
      if (!options.ownership.owns(socket)) return;
      emit("dual_source_source_connection", {
        ...sourceConnectionFields(options), action: "open_timeout", timeoutMs: OPEN_TIMEOUT_MS,
      });
      requestClose(1000, "open timeout");
    }, OPEN_TIMEOUT_MS);

    socket.addEventListener("open", () => {
      if (!options.ownership.owns(socket)) return;
      opened = true;
      clearTimeout(openTimer);
      options.state.connected();
      if (options.source === "blitzortung") blitzRecentCache.setObservationActive(true, Date.now());
      try {
        options.onOpen(socket);
      } catch (error) {
        emit("dual_source_error", {
          ...sourceConnectionFields(options), stage: "subscription", reason: errorName(error),
        });
        requestClose(1011, "subscription failure");
        return;
      }
      emit("dual_source_source_connection", {
        ...sourceConnectionFields(options), action: "open", handshakeMs: Date.now() - attemptedAtMs,
      });
      watchdog = setInterval(() => {
        const quietMs = Date.now() - lastFrameAtMs;
        if (quietMs < SOURCE_QUIET_TIMEOUT_MS[options.source]) return;
        emit("dual_source_source_connection", {
          ...sourceConnectionFields(options), action: "frame_timeout", quietMs,
        });
        requestClose(1000, "frame timeout");
      }, 15_000);
      watchdog.unref();
    });

    socket.addEventListener("message", message => {
      if (!options.ownership.owns(socket)) return;
      const receivedAtMs = Date.now();
      receivedFrame = true;
      lastFrameAtMs = receivedAtMs;
      options.state.frame(receivedAtMs);
      try {
        options.onMessage(message.data, receivedAtMs);
      } catch (error) {
        emit("dual_source_error", {
          ...sourceConnectionFields(options), stage: "message_handler", reason: errorName(error),
        });
      }
    });

    socket.addEventListener("error", event => {
      if (!options.ownership.owns(socket)) return;
      emit("dual_source_source_connection", {
        ...sourceConnectionFields(options), action: "error",
        message: (event as ErrorEvent).message || "WebSocket error",
      });
    });

    socket.addEventListener("close", event => {
      const owned = options.ownership.owns(socket);
      emit("dual_source_source_connection", {
        ...sourceConnectionFields(options), action: "close", code: event.code, reason: event.reason,
        clean: event.wasClean, ignoredAsStale: !owned,
      });
      if (owned) settle();
    });
  });
}

function eventLogFields(event: ObserverEvent): Record<string, unknown> {
  return {
    source: event.source,
    sourceServer: event.sourceServer,
    observerEventId: event.observerEventId,
    sourceEventKey: event.sourceEventKey,
    receivedAt: new Date(event.receivedAtMs).toISOString(),
    eventTime: new Date(event.eventTimeMs).toISOString(),
    eventTimeRaw: event.eventTimeRaw,
    eventTimeUnit: event.eventTimeUnit,
    latencyMs: event.latencyMs,
    latencyEligible: event.latencyEligible,
    transportComparisonEligible: event.transportComparisonEligible,
    latitude: event.latitude,
    longitude: event.longitude,
    insideMonitoringArea: event.insideMonitoringArea,
    polarityRaw: event.polarityRaw,
    stationCount: event.stationCount,
    mdsRaw: event.mdsRaw,
    mcgRaw: event.mcgRaw,
    regionRaw: event.regionRaw,
  };
}

function emitFinalization(result: MatchFinalization): void {
  windows.finalized(result);
  emit("dual_source_match_finalized", {
    source: result.source,
    oppositeSource: result.oppositeSource,
    observerEventId: result.observerEventId,
    eventTime: new Date(result.eventTimeMs).toISOString(),
    receivedAt: new Date(result.receivedAtMs).toISOString(),
    latitude: result.latitude,
    longitude: result.longitude,
    nearestObserverEventId: result.nearestObserverEventId,
    nearestDistanceKm: result.nearestDistanceKm,
    absoluteEventTimeDeltaMs: result.absoluteEventTimeDeltaMs,
    receiveTimeDeltaMs: result.receiveTimeDeltaMs,
    receivedFirst: result.receivedFirst,
    matchClass: result.matchClass,
    finalizationReason: result.finalizationReason,
  });
}

function observeLocalEvent(event: ObserverEvent, extra: Record<string, unknown> = {}): void {
  if (!event.insideMonitoringArea) return;
  emit("dual_source_event", { ...eventLogFields(event), ...extra });
  windows.observe(event);
  for (const forced of matcher.observe(event)) emitFinalization(forced);
}

function handleLive2Frame(data: unknown, receivedAtMs: number): void {
  if (typeof data !== "string") {
    live2State.decodeFailure();
    emit("dual_source_error", { source: "live2", sourceServer: null, stage: "frame", reason: "non-text WebSocket frame" });
    return;
  }
  const frame = parseFrame(data, receivedAtMs);
  if (frame.kind === "malformed") {
    if (frame.reason === "invalid JSON") live2State.jsonParseFailure();
    else live2State.malformedPayload();
    emit("dual_source_error", { source: "live2", sourceServer: null, stage: "parse", reason: frame.reason });
    return;
  }
  live2State.decoded();
  if (frame.kind !== "events") return;
  if (frame.rejected) {
    live2State.malformedPayload(frame.rejected);
    emit("dual_source_error", {
      source: "live2", sourceServer: null, stage: "event_parse", reason: "rejected stroke payloads", count: frame.rejected,
    });
  }
  for (const sourceEvent of frame.events) {
    const event = normalizeLive2ObserverEvent(sourceEvent, `live2-${++live2Sequence}`);
    live2State.event(event);
    observeLocalEvent(event, { rawDelayMs: sourceEvent.rawDelayMs ?? null });
  }
}

function handleBlitzFrame(data: unknown, receivedAtMs: number, sourceServer: BlitzortungServer): void {
  if (typeof data !== "string") {
    blitzState.decodeFailure();
    emit("dual_source_error", {
      source: "blitzortung", sourceServer, stage: "frame", reason: "non-text WebSocket frame",
    });
    return;
  }
  const encodedChars = data.length;
  const result = processBlitzortungFrame(data, receivedAtMs, sourceServer);
  if (result.kind === "decode_error") {
    blitzState.decodeFailure();
    emit("dual_source_error", {
      source: "blitzortung", sourceServer, stage: "decode", reason: result.reason, encodedChars,
    });
    return;
  }
  blitzState.decoded();
  if (result.kind === "json_parse_error") {
    blitzState.jsonParseFailure();
    emit("dual_source_error", {
      source: "blitzortung", sourceServer, stage: "json_parse", reason: result.reason,
      encodedChars, decodedChars: result.decodedChars,
    });
    return;
  }
  if (result.kind === "unexpected_payload") {
    blitzState.malformedPayload();
    emit("dual_source_error", {
      source: "blitzortung", sourceServer, stage: "payload", reason: result.reason,
      encodedChars, decodedChars: result.decodedChars,
    });
    return;
  }
  const event = normalizeBlitzObserverEvent(result.event, `blitzortung-${++blitzSequence}`);
  blitzState.event(event);
  try {
    blitzRecentCache.insert(event, receivedAtMs);
  } catch (error) {
    emit("dual_source_error", { source: "blitzortung", sourceServer, stage: "recent_cache", reason: errorName(error) });
  }
  observeLocalEvent(event, { encodedChars, decodedChars: result.decodedChars });
}

function emitWindow(summary: ObservationWindowSummary, reason: "elapsed" | "shutdown"): void {
  emit("dual_source_window_summary", {
    sources: ["live2", "blitzortung"],
    reason,
    windowStart: new Date(summary.windowStartMs).toISOString(),
    windowEnd: new Date(summary.windowEndMs).toISOString(),
    ...summary,
  });
}

function finalizeReady(): void {
  const nowMs = Date.now();
  windows.touch(nowMs);
  for (const result of matcher.finalizeReady(nowMs)) emitFinalization(result);
  for (const summary of windows.closeReady(nowMs)) emitWindow(summary, "elapsed");
}

function emitSummary(reason: "periodic" | "shutdown"): void {
  const nowMs = Date.now();
  emit("dual_source_summary", {
    sources: ["live2", "blitzortung"],
    reason,
    uptimeSeconds: Math.max(0, Math.round((nowMs - startedAtMs) / 1_000)),
    observerLive2Healthy: live2State.healthy,
    observerBlitzHealthy: blitzState.healthy,
    matchBufferedEvents: matcher.bufferedEvents,
    matchPendingEvents: matcher.pendingEvents,
    live2: live2State.summary(nowMs),
    blitzortung: blitzState.summary(nowMs),
  });
}

function stop(reason: "SIGINT" | "SIGTERM"): void {
  if (stopping) return;
  stopping = true;
  emit("dual_source_source_connection", { sources: ["live2", "blitzortung"], action: "stopping", reason });
  controller.abort(reason);
  if (httpServer.listening) httpServer.close();
}

process.once("SIGINT", () => stop("SIGINT"));
process.once("SIGTERM", () => stop("SIGTERM"));

const finalizationTimer = setInterval(finalizeReady, FINALIZE_EVERY_MS);
finalizationTimer.unref();
const summaryTimer = setInterval(() => emitSummary("periodic"), SUMMARY_EVERY_MS);
summaryTimer.unref();
windows.touch(startedAtMs);

httpServer.on("error", error => emit("dual_source_error", {
  source: "blitzortung", sourceServer: null, stage: "http_server", reason: errorName(error),
}));
const httpPort = Number(process.env.PORT ?? OBSERVER_API_DEFAULT_PORT);
if (Number.isInteger(httpPort) && httpPort > 0 && httpPort <= 65_535) {
  try {
    httpServer.listen(httpPort, "0.0.0.0");
  } catch (error) {
    emit("dual_source_error", { source: "blitzortung", sourceServer: null, stage: "http_listen", reason: errorName(error) });
  }
} else {
  emit("dual_source_error", { source: "blitzortung", sourceServer: null, stage: "http_port", reason: "invalid PORT" });
}

emit("dual_source_observer_start", {
  sources: ["live2", "blitzortung"],
  runtimeMode: "read_only_dual_source_shadow",
  productionAuthority: "live2-production-worker-outside-this-process",
  persistence: false,
  publication: false,
  eventLogScope: "inside_ankara_monitoring_polygon",
  live2Endpoint: LIVE2_ENDPOINT,
  live2SubscriptionBounds: ANKARA_MONITORING_AREA.bounds,
  blitzEndpoints: BLITZORTUNG_SERVERS.map(endpointForBlitz),
  blitzSubscription: { a: 111 },
  strictMatch: { maxTimeMs: STRICT_MATCH_MAX_TIME_MS, maxDistanceKm: STRICT_MATCH_MAX_DISTANCE_KM },
  looseMatch: { maxTimeMs: LOOSE_MATCH_MAX_TIME_MS, maxDistanceKm: LOOSE_MATCH_MAX_DISTANCE_KM },
  matchFinalizationDelayMs: MATCH_FINALIZATION_DELAY_MS,
  observationWindowMs: OBSERVATION_WINDOW_MS,
});

const live2Loop = runResilientSourceLoop({
  source: "live2",
  signal: controller.signal,
  connectOnce: () => connectOnce({
    source: "live2",
    sourceServer: null,
    endpoint: LIVE2_ENDPOINT,
    state: live2State,
    ownership: live2Sockets,
    signal: controller.signal,
    onOpen: socket => socket.send(subscription(ANKARA_MONITORING_AREA.bounds)),
    onMessage: handleLive2Frame,
  }),
  onFailure: error => emit("dual_source_error", {
    source: "live2", sourceServer: null, stage: "connection_loop", reason: errorName(error),
  }),
  onReconnectWait: (waitMs, attempt) => {
    live2State.reconnect();
    emit("dual_source_source_connection", {
      source: "live2", sourceServer: null, endpoint: LIVE2_ENDPOINT,
      action: "reconnect_wait", waitMs, attempt,
    });
  },
});

const blitzLoop = runResilientSourceLoop({
  source: "blitzortung",
  signal: controller.signal,
  connectOnce: () => {
    const sourceServer = BLITZORTUNG_SERVERS[blitzServerIndex++ % BLITZORTUNG_SERVERS.length];
    return connectOnce({
      source: "blitzortung",
      sourceServer,
      endpoint: endpointForBlitz(sourceServer),
      state: blitzState,
      ownership: blitzSockets,
      signal: controller.signal,
      onOpen: socket => socket.send(JSON.stringify({ a: 111 })),
      onMessage: (data, receivedAtMs) => handleBlitzFrame(data, receivedAtMs, sourceServer),
    });
  },
  onFailure: error => emit("dual_source_error", {
    source: "blitzortung", sourceServer: blitzState.sourceServer,
    stage: "connection_loop", reason: errorName(error),
  }),
  onReconnectWait: (waitMs, attempt) => {
    blitzState.reconnect();
    emit("dual_source_source_connection", {
      source: "blitzortung", sourceServer: blitzState.sourceServer,
      endpoint: blitzState.sourceServer ? endpointForBlitz(blitzState.sourceServer) : null,
      action: "reconnect_wait", waitMs, attempt,
    });
  },
});

try {
  await Promise.all([live2Loop, blitzLoop]);
} finally {
  if (httpServer.listening) httpServer.close();
  clearInterval(finalizationTimer);
  clearInterval(summaryTimer);
  for (const result of matcher.finalizeAll()) emitFinalization(result);
  for (const summary of windows.closeAll()) emitWindow(summary, "shutdown");
  emitSummary("shutdown");
}
