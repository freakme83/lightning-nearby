import { createHash, randomUUID } from "node:crypto";
import { supabaseConnection } from "../lightning-publication-ledger/storage/supabase.ts";
import type { BlitzortungProbeEvent } from "../research/blitzortung-probe/protocol.ts";
import { blitzFingerprint, BLITZ_ADMISSION_MAX_LATENCY_MS } from "./blitz-primary.ts";

const TICK_MS = 10_000, BATCH_SIZE = 50, QUEUE_LIMIT = 2_000, TIMEOUT_MS = 5_000;
export type ActivityEvent = { event_key: string; event_time: string; received_at: string };
export type ActivitySync = { state: "idle" | "active"; periodId: string | null; processed: number };
export type ActivityStore = { sync(runId: string, healthy: boolean, interrupted: boolean,
  events: ActivityEvent[], lost: boolean, signal: AbortSignal): Promise<ActivitySync> };
type Emit = (kind: string, fields?: Record<string, unknown>) => void;

export function eligibleActivityEvent(event: BlitzortungProbeEvent): ActivityEvent | null {
  const latency = event.receivedAtMs - event.eventTimeMs;
  if (!event.insideMonitoringArea || !Number.isFinite(event.eventTimeMs) ||
      !Number.isFinite(event.receivedAtMs) || latency < 0 || latency > BLITZ_ADMISSION_MAX_LATENCY_MS) return null;
  return { event_key: createHash("sha256").update(blitzFingerprint(event)).digest("hex"),
    event_time: new Date(event.eventTimeMs).toISOString(), received_at: new Date(event.receivedAtMs).toISOString() };
}

export function createActivityStore(config: { url?: string; serviceRoleKey?: string },
  fetcher: typeof fetch = fetch): ActivityStore {
  const { endpoint, headers } = supabaseConnection(config);
  const url = new URL("/rest/v1/rpc/sync_ankara_activity_watch", endpoint);
  return { async sync(runId, healthy, interrupted, events, lost, signal) {
    const response = await fetcher(url, { method: "POST", headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ p_worker_run_id: runId, p_source_healthy: healthy,
        p_interrupted: interrupted, p_events: events, p_lost: lost }), cache: "no-store", signal });
    if (!response.ok) throw new Error(`Activity Watch RPC HTTP ${response.status}`);
    const result: unknown = await response.json();
    if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("Invalid Activity Watch result");
    const row = result as Record<string, unknown>;
    if ((row.state !== "idle" && row.state !== "active") ||
        (row.periodId !== null && typeof row.periodId !== "string") ||
        !Number.isSafeInteger(row.processed) || Number(row.processed) < 0 || Number(row.processed) > events.length) {
      throw new Error("Invalid Activity Watch result");
    }
    return row as ActivitySync;
  } };
}

// Entirely separate from Continuous Capture and the production admission path.
export class ActivityWatch {
  private readonly store: ActivityStore;
  private readonly healthy: () => boolean;
  private readonly emit: Emit;
  private readonly now: () => number;
  private readonly runId = randomUUID();
  private readonly queue: ActivityEvent[] = [];
  private readonly pendingKeys = new Set<string>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private controller: AbortController | null = null;
  private inFlight = false;
  private stopped = false;
  private interrupted = false;
  private lost = false;
  private sourceSignaled: boolean | null = null;
  private lastState: ActivitySync["state"] | null = null;
  private generation = 0;
  private nextAttemptAt = 0;
  private failures = 0;

  constructor(store: ActivityStore, healthy: () => boolean, emit: Emit, now: () => number = Date.now) {
    this.store = store;
    this.healthy = healthy;
    this.emit = emit;
    this.now = now;
  }

  start() {
    if (this.timer || this.stopped) return;
    this.timer = setInterval(() => { void this.tick(); }, TICK_MS);
    this.timer.unref();
    void this.tick();
  }

  observe(event: BlitzortungProbeEvent) {
    if (this.stopped) return;
    const item = eligibleActivityEvent(event);
    if (!item || this.pendingKeys.has(item.event_key)) return;
    if (this.queue.length >= QUEUE_LIMIT) {
      this.lost = true;
      this.generation++;
      this.log("activity_watch_loss", { reason: "queue_limit" });
      return;
    }
    this.queue.push(item);
    this.pendingKeys.add(item.event_key);
    void this.tick();
  }

  sourceState(healthy: boolean) {
    if (this.stopped) return;
    if (this.sourceSignaled === healthy) return;
    this.sourceSignaled = healthy;
    if (!healthy) { this.interrupted = true; this.generation++; }
    void this.tick();
  }

  async tick() {
    if (this.stopped || this.inFlight || this.now() < this.nextAttemptAt) return;
    let healthy: boolean;
    try { healthy = this.healthy(); }
    catch { this.log("activity_watch_error", { stage: "source_health", reason: "unavailable" }); return; }
    const batch = healthy ? this.queue.slice(0, BATCH_SIZE) : [];
    const interrupted = this.interrupted, lost = this.lost, generation = this.generation;
    const controller = new AbortController();
    this.controller = controller;
    this.inFlight = true;
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const result = await this.store.sync(this.runId, healthy, interrupted, batch, lost, controller.signal);
      if (this.stopped) return;
      for (const item of batch) this.pendingKeys.delete(item.event_key);
      this.queue.splice(0, batch.length);
      if (this.generation === generation) {
        this.interrupted = false;
        // Loss before the first durable period must remain visible on the next open.
        if (result.state === "active") this.lost = false;
      }
      this.failures = 0;
      this.nextAttemptAt = 0;
      if (result.processed || result.state !== this.lastState) this.log("activity_watch_sync", result);
      this.lastState = result.state;
    } catch {
      if (!this.stopped) {
        this.failures++;
        this.nextAttemptAt = this.now() + Math.min(60_000, 2_000 * 2 ** Math.min(this.failures, 5));
        this.log("activity_watch_error", { stage: "sync", reason: "unavailable", retryAfterMs: this.nextAttemptAt - this.now() });
      }
    } finally {
      clearTimeout(timeout);
      if (this.controller === controller) this.controller = null;
      this.inFlight = false;
      if (!this.stopped && healthy && this.queue.length && this.nextAttemptAt === 0) void this.tick();
    }
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.controller?.abort();
  }

  private log(kind: string, fields: Record<string, unknown>) { try { this.emit(kind, fields); } catch { /* isolated */ } }
}

export function createActivityWatch(env: NodeJS.ProcessEnv, healthy: () => boolean, emit: Emit,
  fetcher: typeof fetch = fetch): ActivityWatch | null {
  if (env.ACTIVITY_WATCH_ENABLED !== "true") return null;
  try {
    const watch = new ActivityWatch(createActivityStore({ url: env.SUPABASE_URL,
      serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY }, fetcher), healthy, emit);
    watch.start();
    return watch;
  } catch {
    try { emit("activity_watch_error", { stage: "configuration", reason: "unavailable" }); } catch { /* isolated */ }
    return null;
  }
}
