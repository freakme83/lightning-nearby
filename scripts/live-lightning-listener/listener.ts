// Run with Node >=22.6. Research-only: never imported by the app.
import { ANKARA_BOX, backoffMs, BoundedDedupe, eventKey, inBox, Metrics,
  parseFrame, subscription, type Box, type LightningEvent } from "./core.ts";

type Format = "human" | "jsonl";
function numberArg(value: string | undefined, label: string, allowZero = false): number {
  const number = Number(value);
  if (!Number.isFinite(number) || (allowZero ? number < 0 : number <= 0)) throw new Error(`Invalid ${label}`);
  return number;
}
function options(argv: string[]) {
  const args = new Map<string, string>();
  for (const arg of argv) {
    if (!arg.startsWith("--") || !arg.includes("=")) throw new Error(`Expected --name=value, received ${arg}`);
    const [name, ...values] = arg.slice(2).split("=");
    if (!new Set(["duration", "force-reconnect-every", "summary-every", "box", "format", "raw", "resume"]).has(name)) throw new Error(`Unknown flag: ${name}`);
    args.set(name, values.join("="));
  }
  const boxParts = args.get("box")?.split(",").map(Number);
  if (boxParts && (boxParts.length !== 4 || boxParts.some(value => !Number.isFinite(value)))) throw new Error("--box=north,east,south,west");
  const box: Box = boxParts ? { north: boxParts[0], east: boxParts[1], south: boxParts[2], west: boxParts[3] } : ANKARA_BOX;
  if (box.north > 90 || box.south < -90 || box.north <= box.south || box.east > 180 || box.west < -180 || box.east <= box.west) throw new Error("Invalid box bounds");
  const format = args.get("format") ?? "human";
  if (format !== "human" && format !== "jsonl") throw new Error("--format=human|jsonl");
  const raw = args.get("raw") ?? "false";
  if (raw !== "true" && raw !== "false") throw new Error("--raw=true|false");
  const resume = args.get("resume") ?? "true";
  if (resume !== "true" && resume !== "false") throw new Error("--resume=true|false");
  return { box, format: format as Format, raw: raw === "true", resume: resume === "true",
    durationMs: args.has("duration") ? numberArg(args.get("duration"), "duration") * 60000 : null,
    forceMs: args.has("force-reconnect-every") ? numberArg(args.get("force-reconnect-every"), "force-reconnect-every") * 1000 : null,
    summaryMs: numberArg(args.get("summary-every") ?? "300", "summary-every") * 1000 };
}

const config = options(process.argv.slice(2));
const endpoint = "wss://live2.lightningmaps.org/";
const startedAt = Date.now();
const metrics = new Metrics(startedAt);
const dedupe = new BoundedDedupe();
const lastIds: Record<string, number> = {};
let stopping = false;
let socket: WebSocket | null = null;
let connectAttempt = 0;
let lastDisconnectMs: number | null = null;
let shutdownTimer: ReturnType<typeof setTimeout> | null = null;

function output(kind: string, payload: Record<string, unknown> = {}) {
  const record = { kind, at: new Date().toISOString(), ...payload };
  if (config.format === "jsonl") console.log(JSON.stringify(record));
  else console.log(`[${record.at}] ${kind} ${JSON.stringify(payload)}`);
}
function shutdown(reason: string) {
  if (stopping) return;
  stopping = true;
  clearInterval(summaryTimer);
  output("summary", { reason, ...metrics.summary() });
  if (shutdownTimer) clearTimeout(shutdownTimer);
  socket?.close(1000, "research stop");
}
process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));
if (config.durationMs !== null) shutdownTimer = setTimeout(() => shutdown("duration"), config.durationMs);
const summaryTimer = setInterval(() => output("summary", metrics.summary()), config.summaryMs);
summaryTimer.unref();
output("start", { endpoint, box: config.box, subscription: JSON.parse(subscription(config.box)),
  customOrigin: false, cookies: false, resume: config.resume, durationMinutes: config.durationMs === null ? null : config.durationMs / 60000 });

function accept(event: LightningEvent) {
  metrics.decoded++;
  const key = eventKey(event);
  if (dedupe.seen(key)) { metrics.duplicates++; return; }
  if (event.sourceEventKey) {
    const [src, id] = event.sourceEventKey.split("/");
    const value = Number(id);
    if (Number.isSafeInteger(value)) lastIds[src] = Math.max(lastIds[src] ?? 0, value);
  }
  const inside = inBox(event, config.box);
  metrics.record(event, inside);
  output("event", { source: event.source, eventTime: new Date(event.eventTimeMs).toISOString(),
    receivedAt: new Date(event.receivedAtMs).toISOString(), latencyMs: event.receivedAtMs - event.eventTimeMs,
    latitude: event.latitude, longitude: event.longitude, sourceEventKey: event.sourceEventKey ?? null,
    insideRequestedBox: inside, rawDelayMs: event.rawDelayMs ?? null, dischargeType: "unknown" });
}

async function connect(): Promise<void> {
  while (!stopping) {
    const attemptStart = Date.now();
    output("connecting", { endpoint });
    let opened = false;
    let closeInfo: { code: number; reason: string; clean: boolean } | null = null;
    let forced = false;
    try {
      await new Promise<void>((resolve) => {
        const ws = new WebSocket(endpoint); // No browser headers, Origin, cookies, or WebSocket dependency.
        socket = ws;
        let settled = false;
        let forceTimer: ReturnType<typeof setTimeout> | null = null;
        let watchdog: ReturnType<typeof setInterval> | null = null;
        let lastFrame = Date.now();
        const finish = () => {
          if (settled) return;
          settled = true;
          clearTimeout(openTimer);
          if (forceTimer) clearTimeout(forceTimer);
          if (watchdog) clearInterval(watchdog);
          socket = null;
          resolve();
        };
        const openTimer = setTimeout(() => {
          output("connection_error", { message: "open timeout" });
          ws.close();
          finish();
        }, 20000);
        ws.addEventListener("open", () => {
          clearTimeout(openTimer);
          opened = true;
          connectAttempt = 0;
          const now = Date.now();
          output("connected", { handshakeMs: now - attemptStart,
            downtimeMs: lastDisconnectMs === null ? null : now - lastDisconnectMs });
          ws.send(subscription(config.box, config.resume ? lastIds : {}));
          if (config.forceMs) forceTimer = setTimeout(() => {
            forced = true;
            output("forced_reconnect", { afterSeconds: config.forceMs! / 1000 });
            ws.close(1000, "research reconnect");
          }, config.forceMs);
          watchdog = setInterval(() => {
            if (Date.now() - lastFrame > 90000) {
              output("connection_error", { message: "90s without any frames" });
              ws.close();
            }
          }, 15000);
        });
        ws.addEventListener("message", message => {
          lastFrame = Date.now();
          metrics.messages++;
          if (typeof message.data !== "string") { metrics.malformed++; output("malformed", { reason: "non-text frame" }); return; }
          if (config.raw) output("raw_frame", { data: message.data.slice(0, 4000), truncated: message.data.length > 4000 });
          const frame = parseFrame(message.data, lastFrame);
          if (frame.kind === "malformed") { metrics.malformed++; output("malformed", { reason: frame.reason }); }
          else if (frame.kind === "events") {
            metrics.malformed += frame.rejected;
            for (const event of frame.events) accept(event);
          } else if (frame.control !== "other") output("control", { control: frame.control });
        });
        ws.addEventListener("error", error => output("connection_error", { message: (error as ErrorEvent).message ?? "WebSocket error",
          detail: (error as ErrorEvent).error instanceof Error ? (error as ErrorEvent).error.message : undefined }));
        ws.addEventListener("close", event => {
          closeInfo = { code: event.code, reason: event.reason, clean: event.wasClean };
          output("disconnected", { ...closeInfo, forced, atMs: Date.now() });
          lastDisconnectMs = Date.now();
          finish();
        });
      });
    } catch (error) { output("connection_error", { message: String(error) }); }
    if (stopping) break;
    metrics.reconnects++;
    const waitMs = backoffMs(connectAttempt++);
    output("reconnect_wait", { waitMs, opened, closeInfo });
    await new Promise(resolve => setTimeout(resolve, waitMs));
  }
}

await connect();
