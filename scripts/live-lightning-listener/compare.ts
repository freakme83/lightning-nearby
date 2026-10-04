// Concurrent, bounded geographic comparison. No production imports or disk output.
import { ANKARA_BOX, EXTREMADURA_ACTIVE_BOX, backoffMs, BoundedDedupe,
  eventKey, inBox, Metrics, parseFrame, subscription, type Box, type LightningEvent } from "./core.ts";
import { overlap } from "./compare-core.ts";

const arg = process.argv.slice(2);
if (arg.length !== 1 || !/^--duration=\d+(\.\d+)?$/.test(arg[0])) {
  throw new Error("Usage: npm run research:lightning-compare -- --duration=10 (minutes)");
}
const minutes = Number(arg[0].split("=")[1]);
if (!Number.isFinite(minutes) || minutes <= 0 || minutes > 60) throw new Error("duration must be >0 and <=60 minutes");
const endpoint = "wss://live2.lightningmaps.org/";
const startedAt = Date.now();
const endsAt = startedAt + minutes * 60000;
let stopping = false;
const activeSockets = new Set<WebSocket>();
function log(kind: string, details: Record<string, unknown>) {
  console.log(JSON.stringify({ kind, at: new Date().toISOString(), ...details }));
}
function stop() {
  stopping = true;
  for (const ws of activeSockets) ws.close(1000, "research stop");
}
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
const timer = setTimeout(stop, minutes * 60000);

type Sample = { eventTime: string; receivedAt: string; latitude: number; longitude: number; latencyMs: number; sourceEventKey: string | null };
function sample(event: LightningEvent): Sample {
  return { eventTime: new Date(event.eventTimeMs).toISOString(), receivedAt: new Date(event.receivedAtMs).toISOString(),
    latitude: event.latitude, longitude: event.longitude, latencyMs: event.receivedAtMs - event.eventTimeMs,
    sourceEventKey: event.sourceEventKey ?? null };
}
class Stream {
  readonly metrics = new Metrics(startedAt);
  readonly dedupe = new BoundedDedupe();
  readonly lastIds: Record<string, number> = {};
  readonly allKeys = new Set<string>();
  readonly lowLagKeys = new Set<string>();
  readonly activeBoxKeys = new Set<string>();
  readonly activeBoxLowLagKeys = new Set<string>();
  readonly firstEvents: Sample[] = [];
  readonly insideSample: Sample[] = [];
  missingStableIds = 0;
  keyCapReached = false;
  lowLagInside = 0;
  lowLagOutside = 0;
  activeBoxReceived = 0;
  activeBoxLowLag = 0;
  connectedAt: string[] = [];
  disconnectedAt: string[] = [];
  readonly name: string;
  readonly box: Box;
  constructor(name: string, box: Box) { this.name = name; this.box = box; }
  accept(event: LightningEvent) {
    this.metrics.decoded++;
    if (this.dedupe.seen(eventKey(event))) { this.metrics.duplicates++; return; }
    if (event.sourceEventKey) {
      const [src, id] = event.sourceEventKey.split("/");
      const value = Number(id);
      if (Number.isSafeInteger(value)) this.lastIds[src] = Math.max(this.lastIds[src] ?? 0, value);
    } else this.missingStableIds++;
    const inside = inBox(event, this.box);
    const inActive = inBox(event, EXTREMADURA_ACTIVE_BOX);
    const latency = event.receivedAtMs - event.eventTimeMs;
    const lowLag = latency >= 0 && latency <= 30000;
    this.metrics.record(event, inside);
    if (lowLag) { if (inside) this.lowLagInside++; else this.lowLagOutside++; }
    if (inActive) { this.activeBoxReceived++; if (lowLag) this.activeBoxLowLag++; }
    if (this.firstEvents.length < 8) this.firstEvents.push(sample(event));
    if (inside && this.insideSample.length < 8) this.insideSample.push(sample(event));
    // Cap in-memory comparison keys; metrics keep counting if the cap is reached.
    if (event.sourceEventKey) {
      if (this.allKeys.size < 50000) {
        this.allKeys.add(event.sourceEventKey);
        if (lowLag) this.lowLagKeys.add(event.sourceEventKey);
        if (inActive) {
          this.activeBoxKeys.add(event.sourceEventKey);
          if (lowLag) this.activeBoxLowLagKeys.add(event.sourceEventKey);
        }
      } else this.keyCapReached = true;
    }
  }
  report() {
    return { name: this.name, box: this.box, connections: this.connectedAt, disconnects: this.disconnectedAt,
      ...this.metrics.summary(), outside: this.metrics.parsed - this.metrics.inside,
      lowLagInside: this.lowLagInside, lowLagOutside: this.lowLagOutside,
      activeBoxReceived: this.activeBoxReceived, activeBoxLowLag: this.activeBoxLowLag,
      missingStableIds: this.missingStableIds, keyCapReached: this.keyCapReached,
      firstEvents: this.firstEvents, insideSample: this.insideSample };
  }
}

async function observe(stream: Stream): Promise<void> {
  let retry = 0;
  while (!stopping && Date.now() < endsAt) {
    const attemptAt = Date.now();
    try {
      await new Promise<void>(resolve => {
        const ws = new WebSocket(endpoint); // No Origin/cookies/custom headers.
        activeSockets.add(ws);
        let finished = false;
        let lastFrame = Date.now();
        const finish = () => { if (finished) return; finished = true;
          clearTimeout(openTimer); clearInterval(watchdog); activeSockets.delete(ws); resolve(); };
        const openTimer = setTimeout(() => { log("open_timeout", { stream: stream.name }); ws.close(); finish(); }, 20000);
        const watchdog = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN && Date.now() - lastFrame > 90000) {
            log("frame_timeout", { stream: stream.name }); ws.close();
          }
        }, 15000);
        ws.addEventListener("open", () => {
          clearTimeout(openTimer);
          retry = 0;
          const at = new Date().toISOString();
          stream.connectedAt.push(at);
          log("connected", { stream: stream.name, handshakeMs: Date.now() - attemptAt, at });
          ws.send(subscription(stream.box, stream.lastIds));
        });
        ws.addEventListener("message", message => {
          lastFrame = Date.now();
          stream.metrics.messages++;
          if (typeof message.data !== "string") { stream.metrics.malformed++; return; }
          const frame = parseFrame(message.data, lastFrame);
          if (frame.kind === "malformed") stream.metrics.malformed++;
          else if (frame.kind === "events") {
            stream.metrics.malformed += frame.rejected;
            for (const event of frame.events) stream.accept(event);
          }
        });
        ws.addEventListener("error", error => log("connection_error", {
          stream: stream.name, message: (error as ErrorEvent).message ||
            String((error as ErrorEvent).error ?? "WebSocket error") }));
        ws.addEventListener("close", event => {
          const at = new Date().toISOString();
          stream.disconnectedAt.push(at);
          log("disconnected", { stream: stream.name, at, code: event.code, reason: event.reason });
          finish();
        });
      });
    } catch (error) { log("connection_error", { stream: stream.name, message: String(error) }); }
    if (stopping || Date.now() >= endsAt) break;
    stream.metrics.reconnects++;
    await new Promise(resolve => setTimeout(resolve, Math.min(backoffMs(retry++), Math.max(0, endsAt - Date.now()))));
  }
}

const active = new Stream("extremadura", EXTREMADURA_ACTIVE_BOX);
const control = new Stream("ankara", ANKARA_BOX);
log("start", { endpoint, startedAt: new Date(startedAt).toISOString(), plannedDurationMinutes: minutes,
  subscriptionsDifferOnlyInP: true, activeBox: EXTREMADURA_ACTIVE_BOX, controlBox: ANKARA_BOX });
await Promise.all([observe(active), observe(control)]);
clearTimeout(timer);
log("comparison", { startedAt: new Date(startedAt).toISOString(), endedAt: new Date().toISOString(),
  durationSeconds: (Date.now() - startedAt) / 1000,
  comparable: active.connectedAt.length > 0 && control.connectedAt.length > 0,
  inconclusiveReason: active.connectedAt.length && control.connectedAt.length ? null : "one or both subscriptions never connected",
  active: active.report(), control: control.report(),
  allStableIds: overlap(active.allKeys, control.allKeys),
  lowLagStableIds: overlap(active.lowLagKeys, control.lowLagKeys),
  activeBoxStableIds: overlap(active.activeBoxKeys, control.activeBoxKeys),
  activeBoxLowLagStableIds: overlap(active.activeBoxLowLagKeys, control.activeBoxLowLagKeys) });
