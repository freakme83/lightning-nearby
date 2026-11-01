import { createHash, randomUUID } from "node:crypto";
import { ANKARA_MONITORING_AREA } from "../lightning-incident-lifecycle/monitoring-area.ts";
import { supabaseConnection } from "../lightning-publication-ledger/storage/supabase.ts";
import type { BlitzortungProbeEvent } from "../research/blitzortung-probe/protocol.ts";
import { blitzFingerprint } from "./blitz-primary.ts";

const QUEUE_LIMIT = 2000, HEALTH_LIMIT = 128, BATCH_SIZE = 50, MAX_QUEUE_BYTES = 2_000_000;
const FLUSH_MS = 2000, HEARTBEAT_MS = 60_000, TIMEOUT_MS = 5000, MAX_ATTEMPTS = 3;
type Row = Record<string, string | number | null>;
type Item = { bytes: number; table: "continuous_capture_strikes" | "continuous_capture_health"; row: Row; attempts: number };
type Emit = (kind: string, fields?: Record<string, unknown>) => void;

// Hash the actual polygon, so a boundary change automatically changes its identity.
export const POLYGON_ID = `ankara-sha256:${createHash("sha256").update(JSON.stringify(ANKARA_MONITORING_AREA.polygon)).digest("hex")}`;

export class ContinuousCapture {
  private queue: Item[] = [];
  private inFlight = false;
  private strikeCount = 0;
  private healthCount = 0;
  private queueBytes = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private nextAttempt = 0;
  private lastHeartbeat = 0;
  private source: "unknown" | "healthy" | "unhealthy" = "unknown";
  private runId = randomUUID();
  private sequence = 0;
  private dropped = 0;
  private failures = 0;
  private healthLost = 0;
  private healthPending = false;
  private accepted = 0;
  private written = 0;
  private readonly endpoint: URL;
  private readonly headers: Record<string, string>;

  private emit: Emit;
  private fetcher: typeof fetch;
  private now: () => number;

  constructor(config: { url?: string; serviceRoleKey?: string }, emit: Emit,
    fetcher: typeof fetch = fetch, now: () => number = Date.now) {
    this.emit = emit;
    this.fetcher = fetcher;
    this.now = now;
    const connection = supabaseConnection(config);
    this.endpoint = connection.endpoint;
    this.headers = connection.headers;
  }

  start() {
    this.safe(() => {
      this.checkpoint("start");
      this.timer = setInterval(() => this.tick(), FLUSH_MS);
      this.timer.unref();
      this.log("continuous_capture_init", { polygon: POLYGON_ID, queueLimit: QUEUE_LIMIT, batchSize: BATCH_SIZE });
    });
  }

  observe(event: BlitzortungProbeEvent) {
    let pending = false;
    try {
      if (!event.insideMonitoringArea) return;
      pending = true;
      if (this.strikeCount >= QUEUE_LIMIT) {
        this.dropped++;
        pending = false;
        if (this.dropped === 1 || this.dropped % 100 === 0) this.log("continuous_capture_overflow", { dropped: this.dropped });
        return;
      }
      const eventKey = createHash("sha256").update(blitzFingerprint(event)).digest("hex");
      const row: Row = {
        event_key: eventKey, event_time: new Date(event.eventTimeMs).toISOString(),
        event_time_raw: event.eventTimeRaw, event_time_unit: event.eventTimeUnit,
        received_at: new Date(event.receivedAtMs).toISOString(), latitude: event.latitude,
        longitude: event.longitude, source_server: event.sourceServer, station_count: event.stationCount,
        polygon_id: POLYGON_ID,
      };
      if (!this.enqueue("continuous_capture_strikes", row)) {
        this.dropped++;
        pending = false;
        if (this.dropped === 1 || this.dropped % 100 === 0) this.log("continuous_capture_overflow", { dropped: this.dropped });
        return;
      }
      this.accepted++;
      pending = false;
    } catch {
      if (pending) this.dropped++;
      this.log("continuous_capture_error", { stage: "observe" });
    }
  }

  sourceState(state: "healthy" | "unhealthy", reason: string) {
    this.safe(() => {
      if (this.source === state) return;
      this.source = state;
      this.checkpoint(reason);
      if (state === "unhealthy") this.log("continuous_capture_source_interruption", { reason });
    });
  }

  private log(kind: string, fields: Record<string, unknown>) { try { this.emit(kind, fields); } catch { /* isolated */ } }
  private safe(fn: () => void) { try { fn(); } catch { this.log("continuous_capture_error", { stage: "observer" }); } }

  private checkpoint(reason: string) {
    if (this.healthPending) reason = "health_gap";
    this.lastHeartbeat = this.now();
    if (this.healthCount >= HEALTH_LIMIT) {
      this.healthLost++;
      this.healthPending = true;
      return;
    }
    const row: Row = {
      run_id: this.runId, sequence: this.sequence++, observed_at: new Date(this.lastHeartbeat).toISOString(),
      source_health: this.source, reason, accepted: this.accepted, written: this.written,
      dropped: this.dropped, failures: this.failures, queued: this.strikeCount, polygon_id: POLYGON_ID,
    };
    if (!this.enqueue("continuous_capture_health", row)) { this.healthLost++; this.healthPending = true; }
    else this.healthPending = false;
  }

  private enqueue(table: Item["table"], row: Row): boolean {
    const bytes = Buffer.byteLength(JSON.stringify(row));
    if (this.queueBytes + bytes > MAX_QUEUE_BYTES) return false;
    this.queue.push({ table, row, attempts: 0, bytes });
    this.queueBytes += bytes;
    if (table === "continuous_capture_strikes") this.strikeCount++; else this.healthCount++;
    return true;
  }

  private remove(count: number) {
    for (const item of this.queue.splice(0, count)) {
      this.queueBytes -= item.bytes;
      if (item.table === "continuous_capture_strikes") this.strikeCount--; else this.healthCount--;
    }
  }

  private tick() {
    this.safe(() => {
      if (this.now() - this.lastHeartbeat >= HEARTBEAT_MS) {
        this.checkpoint("heartbeat");
        this.log("continuous_capture_stats", { queued: this.queue.length, accepted: this.accepted,
          written: this.written, dropped: this.dropped, healthLost: this.healthLost, failures: this.failures, source: this.source });
      }
      if (this.healthPending && this.healthCount < HEALTH_LIMIT && this.queueBytes < MAX_QUEUE_BYTES - 1024) this.checkpoint("health_gap");
      if (!this.inFlight && this.queue.length && this.now() >= this.nextAttempt) {
        this.inFlight = true;
        void this.flush().catch(() => { this.failures++; }).finally(() => { this.inFlight = false; });
      }
    });
  }

  private async flush() {
    const table = this.queue[0].table;
    // Only contiguous entries: preserve checkpoint order and never overlap writes.
    const batch = this.queue.slice(0, BATCH_SIZE).filter((item, i, all) =>
      item.table === table && all.slice(0, i).every(previous => previous.table === table));
    try {
      const url = new URL(`/rest/v1/${table}`, this.endpoint);
      url.searchParams.set("on_conflict", table === "continuous_capture_strikes" ? "event_key" : "run_id,sequence");
      const response = await this.fetcher(url, { method: "POST", headers: { ...this.headers,
        "Content-Type": "application/json", Prefer: "resolution=ignore-duplicates,return=minimal" },
        body: JSON.stringify(batch.map(item => item.row)), signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!response.ok) throw new Error("write failed");
      this.remove(batch.length);
      if (table === "continuous_capture_strikes") this.written += batch.length;
      this.nextAttempt = 0;
      if (this.healthPending) this.checkpoint("health_gap");
      this.safe(() => this.log("continuous_capture_batch", { table, count: batch.length }));
    } catch {
      this.failures++;
      const attempts = ++batch[0].attempts;
      if (attempts >= MAX_ATTEMPTS) {
        this.remove(batch.length);
        if (table === "continuous_capture_strikes") this.dropped += batch.length;
        else { this.healthLost += batch.length; this.healthPending = true; }
      }
      this.nextAttempt = this.now() + Math.min(30_000, 2000 * 2 ** (attempts - 1));
      this.safe(() => this.log("continuous_capture_write_failure", { attempts, dropped: this.dropped, retryInMs: this.nextAttempt - this.now() }));
    }
  }

  stop() {
    this.safe(() => {
      if (this.timer) clearInterval(this.timer);
      this.timer = null;
      this.source = "unhealthy";
      this.checkpoint("shutdown");
      this.tick(); // best effort only; production shutdown never waits for this
      this.log("continuous_capture_shutdown", { queued: this.queue.length, dropped: this.dropped });
    });
  }
}

export function createContinuousCapture(env: NodeJS.ProcessEnv, emit: Emit, fetcher: typeof fetch = fetch): ContinuousCapture | null {
  if (env.CONTINUOUS_CAPTURE_ENABLED !== "true") return null;
  try {
    const capture = new ContinuousCapture({ url: env.SUPABASE_URL, serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY }, emit, fetcher);
    capture.start();
    return capture;
  } catch {
    try { emit("continuous_capture_error", { stage: "configuration" }); } catch { /* isolated */ }
    return null;
  }
}
