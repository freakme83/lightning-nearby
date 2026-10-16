// Explicitly manual, research-only entry point. It is not imported by any worker.
import { BLITZORTUNG_SERVERS, BLITZORTUNG_SOURCE, processBlitzortungFrame,
  type BlitzortungServer } from "./protocol.ts";
import { BlitzortungProbeState } from "./state.ts";

type Format = "human" | "jsonl";

function positiveNumber(value: string | undefined, label: string): number {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new Error(`Invalid ${label}`);
  return number;
}

function options(argv: string[]) {
  const args = new Map<string, string>();
  for (const argument of argv) {
    if (!argument.startsWith("--") || !argument.includes("=")) throw new Error(`Expected --name=value, received ${argument}`);
    const [name, ...rest] = argument.slice(2).split("=");
    if (!new Set(["duration", "summary-every", "format", "servers"]).has(name)) throw new Error(`Unknown flag: ${name}`);
    args.set(name, rest.join("="));
  }
  const format = args.get("format") ?? "jsonl";
  if (format !== "human" && format !== "jsonl") throw new Error("--format=human|jsonl");
  const servers = (args.get("servers")?.split(",") ?? [...BLITZORTUNG_SERVERS]) as BlitzortungServer[];
  if (!servers.length || servers.some(server => !BLITZORTUNG_SERVERS.includes(server))) {
    throw new Error("--servers may contain only ws1,ws7,ws8");
  }
  return {
    format: format as Format,
    servers,
    durationMs: positiveNumber(args.get("duration") ?? "10", "duration") * 60_000,
    summaryMs: positiveNumber(args.get("summary-every") ?? "60", "summary-every") * 1_000,
  };
}

const config = options(process.argv.slice(2));
const startedAtMs = Date.now();
const state = new BlitzortungProbeState(startedAtMs);
let stopping = false;
let socket: WebSocket | null = null;
let serverIndex = 0;
let reconnectAttempt = 0;

function emit(kind: string, sourceServer: BlitzortungServer | null, fields: Record<string, unknown> = {}): void {
  const record = { kind, at: new Date().toISOString(), source: BLITZORTUNG_SOURCE, sourceServer, ...fields };
  console.log(config.format === "jsonl" ? JSON.stringify(record) : `[${record.at}] ${kind} ${JSON.stringify(record)}`);
}

function endpointFor(server: BlitzortungServer): string { return `wss://${server}.blitzortung.org/`; }

function stop(reason: string): void {
  if (stopping) return;
  stopping = true;
  clearInterval(summaryTimer);
  clearTimeout(durationTimer);
  emit("blitzortung_summary", state.blitzSourceServer, { reason, ...state.summary() });
  socket?.close(1000, "probe stop");
}

process.once("SIGINT", () => stop("SIGINT"));
process.once("SIGTERM", () => stop("SIGTERM"));
const durationTimer = setTimeout(() => stop("duration"), config.durationMs);
const summaryTimer = setInterval(() => emit("blitzortung_summary", state.blitzSourceServer, state.summary()), config.summaryMs);
summaryTimer.unref();

emit("blitzortung_start", null, {
  endpoints: config.servers.map(endpointFor),
  subscription: { a: 111 },
  durationMinutes: config.durationMs / 60_000,
  summaryEverySeconds: config.summaryMs / 1_000,
  runtimeMode: "manual_read_only_probe",
});

function reconnectDelayMs(attempt: number): number {
  const ceiling = Math.min(30_000, 1_000 * 2 ** Math.min(attempt, 5));
  return Math.floor(ceiling * (0.5 + Math.random() * 0.5));
}

async function connectLoop(): Promise<void> {
  while (!stopping) {
    const sourceServer = config.servers[serverIndex++ % config.servers.length];
    const endpoint = endpointFor(sourceServer);
    state.connecting(sourceServer);
    emit("blitzortung_connection", sourceServer, { action: "connecting", endpoint });
    const attemptedAtMs = Date.now();
    let opened = false;

    await new Promise<void>((resolve) => {
      const ws = new WebSocket(endpoint);
      socket = ws;
      let settled = false;
      let lastFrameAtMs = Date.now();
      let watchdog: ReturnType<typeof setInterval> | null = null;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(openTimer);
        if (watchdog) clearInterval(watchdog);
        socket = null;
        resolve();
      };
      const openTimer = setTimeout(() => {
        emit("blitzortung_connection", sourceServer, { action: "open_timeout", endpoint });
        ws.close();
        finish();
      }, 20_000);

      ws.addEventListener("open", () => {
        opened = true;
        reconnectAttempt = 0;
        clearTimeout(openTimer);
        state.connected();
        ws.send(JSON.stringify({ a: 111 }));
        emit("blitzortung_connection", sourceServer, {
          action: "open",
          endpoint,
          handshakeMs: Date.now() - attemptedAtMs,
          subscriptionSent: { a: 111 },
        });
        watchdog = setInterval(() => {
          if (Date.now() - lastFrameAtMs > 120_000) {
            emit("blitzortung_connection", sourceServer, { action: "frame_timeout", quietMs: Date.now() - lastFrameAtMs });
            ws.close();
          }
        }, 15_000);
      });

      ws.addEventListener("message", message => {
        const receivedAtMs = Date.now();
        lastFrameAtMs = receivedAtMs;
        state.frame(receivedAtMs);
        if (typeof message.data !== "string") {
          state.decodeFailure();
          emit("blitzortung_decode_error", sourceServer, { reason: "non-text WebSocket frame" });
          return;
        }
        const encodedChars = message.data.length;
        const result = processBlitzortungFrame(message.data, receivedAtMs, sourceServer);
        if (result.kind === "decode_error") {
          state.decodeFailure();
          emit("blitzortung_decode_error", sourceServer, { reason: result.reason, encodedChars });
          return;
        }
        state.decoded();
        if (result.kind === "json_parse_error") {
          state.jsonParseFailure();
          emit("blitzortung_json_parse_error", sourceServer, { reason: result.reason, encodedChars, decodedChars: result.decodedChars });
          return;
        }
        if (result.kind === "unexpected_payload") {
          state.unexpectedPayload();
          emit("blitzortung_payload_rejected", sourceServer, { reason: result.reason, encodedChars, decodedChars: result.decodedChars });
          return;
        }
        state.event(result.event);
        emit("blitzortung_event", sourceServer, {
          receivedAt: new Date(result.event.receivedAtMs).toISOString(),
          eventTime: new Date(result.event.eventTimeMs).toISOString(),
          eventTimeRaw: result.event.eventTimeRaw,
          eventTimeUnit: result.event.eventTimeUnit,
          latencyMs: result.event.latencyMs,
          latitude: result.event.latitude,
          longitude: result.event.longitude,
          polarityRaw: result.event.polarityRaw,
          stationCount: result.event.stationCount,
          mdsRaw: result.event.mdsRaw,
          mcgRaw: result.event.mcgRaw,
          regionRaw: result.event.regionRaw,
          insideMonitoringArea: result.event.insideMonitoringArea,
          encodedChars,
          decodedChars: result.decodedChars,
        });
      });

      ws.addEventListener("error", event => emit("blitzortung_connection", sourceServer, {
        action: "error",
        endpoint,
        message: (event as ErrorEvent).message || "WebSocket error",
      }));
      ws.addEventListener("close", event => {
        state.disconnected();
        emit("blitzortung_connection", sourceServer, {
          action: "close", endpoint, code: event.code, reason: event.reason, clean: event.wasClean,
        });
        finish();
      });
    });

    if (stopping) break;
    state.reconnect();
    const waitMs = reconnectDelayMs(reconnectAttempt++);
    emit("blitzortung_connection", sourceServer, { action: "reconnect_wait", waitMs, previousConnectionOpened: opened });
    await new Promise(resolve => setTimeout(resolve, waitMs));
  }
}

await connectLoop();
