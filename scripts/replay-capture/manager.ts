import { createHash, randomUUID } from "node:crypto";
import { blitzFingerprint } from "../fly-ankara-worker/blitz-primary.ts";
import type { BlitzortungProbeEvent } from "../research/blitzortung-probe/protocol.ts";
import { insideCaptureSquare } from "./geometry.ts";
import type { CaptureSession, CapturedStrike, CaptureStore } from "./store.ts";

export const CAPTURE_POLL_MS = 2_000;
export const CAPTURE_IDLE_POLL_MS = 12_000;
export const CAPTURE_WAITING_POLL_MS = 10_000;
export const CAPTURE_LATE_ARRIVAL_GRACE_MS = 60_000;
export const CAPTURE_QUEUE_MAX = 500;
export const CAPTURE_BATCH_MAX = 50;
const CAPTURE_SEEN_MAX = 20_000;
const CAPTURE_GAPS_MAX = 128;

export type CaptureGap = { id: string; startedAt: string | null; endedAt: string | null;
  reason: "source_disconnect" | "source_unhealthy" | "queue_overflow" | "write_failure" };
export function capturePollDelay(outcome: "active" | "waiting_for_source" | "idle" | "completed" | "not_owner"): number {
  return outcome === "active" ? CAPTURE_POLL_MS :
    outcome === "waiting_for_source" ? CAPTURE_WAITING_POLL_MS : CAPTURE_IDLE_POLL_MS;
}

type Emit = (kind: string, fields: Record<string, unknown>) => void;
export class ReplayCaptureManager {
  private readonly store: CaptureStore;
  private readonly sourceHealthy: () => boolean;
  private readonly emit: Emit;
  private readonly now: () => number;
  private readonly workerId = randomUUID();
  private active: CaptureSession | null = null;
  private queue: CapturedStrike[] = [];
  private seen = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private busy = false;
  private hadGap = false;
  private gapsTruncated = false;
  private openGap: CaptureGap | null = null;
  private gapUpdates = new Map<string, CaptureGap>();
  private lossReasons = new Set<CaptureGap["reason"]>();
  private retryAt = 0;
  private failures = 0;
  private syncFailures = 0;
  private syncRetryAt = 0;
  private lastSummaryAt = 0;
  private counters = { matched: 0, queued: 0, persisted: 0, duplicates: 0, rejected: 0,
    queueDrops: 0, writeFailures: 0, sourceGaps: 0 };

  constructor(store: CaptureStore, sourceHealthy: () => boolean,
    emit: Emit, now: () => number = Date.now) {
    this.store = store;
    this.sourceHealthy = sourceHealthy;
    this.emit = emit;
    this.now = now;
  }

  start(): void {
    if (this.timer) return;
    this.running = true;
    void this.tick();
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    // Any unflushed data is conservatively treated as a gap on lease takeover.
    this.queue = [];
    this.active = null;
  }

  markSourceGap(reason: "source_disconnect" | "source_unhealthy" = "source_disconnect", at = this.now()): void {
    if (!this.active) return;
    if (this.openGap) return;
    const gap: CaptureGap = { id: randomUUID(), startedAt: new Date(at).toISOString(), endedAt: null, reason };
    this.openGap = gap;
    this.addGapUpdate(gap);
    this.hadGap = true;
    this.counters.sourceGaps++;
  }

  markSourceRecovery(at = this.now()): void {
    if (!this.openGap) return;
    const gap = { ...this.openGap, endedAt: new Date(at).toISOString() };
    this.openGap = null;
    this.addGapUpdate(gap);
  }

  private addGapUpdate(gap: CaptureGap): void {
    if (!this.gapUpdates.has(gap.id) && this.gapUpdates.size >= CAPTURE_GAPS_MAX) {
      this.hadGap = true;
      this.gapsTruncated = true;
      return;
    }
    this.gapUpdates.set(gap.id, gap);
  }

  private markLoss(reason: "queue_overflow" | "write_failure"): void {
    this.hadGap = true;
    if (this.lossReasons.has(reason)) return;
    this.lossReasons.add(reason);
    // Exact failure interval is unknown; never fabricate start/end times.
    this.addGapUpdate({ id: randomUUID(), startedAt: null, endedAt: null, reason });
  }

  observe(event: BlitzortungProbeEvent): void {
    const session = this.active;
    if (!session || !session.activatedAt || !session.expiresAt) return;
    const activated = Date.parse(session.activatedAt);
    const expires = Date.parse(session.expiresAt);
    if (event.receivedAtMs < activated || event.receivedAtMs >= expires + CAPTURE_LATE_ARRIVAL_GRACE_MS ||
        !insideCaptureSquare(session, event.latitude, event.longitude)) return;
    this.counters.matched++;
    // Never backfill pre-activation or future-dated strikes. No CG/IC inference.
    if (event.eventTimeMs < activated || event.eventTimeMs >= expires ||
        event.eventTimeMs > event.receivedAtMs) {
      this.counters.rejected++;
      return;
    }
    const eventKey = createHash("sha256").update(blitzFingerprint(event)).digest("hex");
    if (this.seen.has(eventKey)) { this.counters.duplicates++; return; }
    if (this.queue.length >= CAPTURE_QUEUE_MAX) {
      this.counters.queueDrops++;
      this.markLoss("queue_overflow");
      return;
    }
    this.seen.add(eventKey);
    if (this.seen.size > CAPTURE_SEEN_MAX) this.seen.delete(this.seen.values().next().value!);
    this.queue.push({ event_key: eventKey, event_time: new Date(event.eventTimeMs).toISOString(),
      received_at: new Date(event.receivedAtMs).toISOString(), latitude: event.latitude, longitude: event.longitude,
      source_server: event.sourceServer, event_time_raw: event.eventTimeRaw, station_count: event.stationCount });
    this.counters.queued++;
  }

  private async flush(): Promise<void> {
    if (!this.active || !this.queue.length || this.now() < this.retryAt) return;
    const sessionId = this.active.sessionId;
    const batch = this.queue.slice(0, CAPTURE_BATCH_MAX);
    try {
      const result = await this.store.storeBatch(sessionId, this.workerId, batch);
      if (result.outcome !== "stored") {
        this.markLoss("write_failure");
        this.queue = [];
        return;
      }
      this.queue.splice(0, batch.length);
      this.counters.persisted += result.inserted!;
      this.counters.duplicates += batch.length - result.inserted!;
      this.failures = 0;
      this.retryAt = 0;
    } catch (error) {
      this.counters.writeFailures++;
      this.markLoss("write_failure");
      this.retryAt = this.now() + Math.min(30_000, 1_000 * 2 ** Math.min(this.failures++, 5));
      this.emit("replay_capture_error", { source: "blitzortung", sessionId, stage: "store",
        reason: error instanceof Error ? error.name : "unknown", retryAt: new Date(this.retryAt).toISOString() });
    }
  }

  async tick(): Promise<void> {
    if (this.busy || !this.running || this.now() < this.syncRetryAt) return;
    this.busy = true;
    let nextPollMs = CAPTURE_IDLE_POLL_MS;
    try {
      if (this.active && !this.sourceHealthy()) this.markSourceGap("source_unhealthy");
      else if (this.active && this.sourceHealthy()) this.markSourceRecovery();
      if (this.active?.expiresAt && this.now() >= Date.parse(this.active.expiresAt)) {
        // Drain the bounded backlog before the database finalizes the session.
        for (let batch = 0; batch < Math.ceil(CAPTURE_QUEUE_MAX / CAPTURE_BATCH_MAX) && this.queue.length; batch++) {
          const before = this.queue.length;
          await this.flush();
          if (!this.running || this.queue.length >= before) break;
        }
      } else await this.flush();
      if (!this.running) return;
      const updates = [...this.gapUpdates.values()];
      const result = await this.store.sync(this.workerId, this.sourceHealthy(), this.hadGap,
        this.queue.length, updates, !this.active?.expiresAt ||
          this.now() >= Date.parse(this.active.expiresAt) + CAPTURE_LATE_ARRIVAL_GRACE_MS,
        this.gapsTruncated);
      if (!this.running) return;
      this.syncFailures = 0;
      this.syncRetryAt = 0;
      if (result.outcome !== "not_owner") {
        for (const gap of updates) if (this.gapUpdates.get(gap.id) === gap) this.gapUpdates.delete(gap.id);
      }
      nextPollMs = capturePollDelay(result.outcome);
      if (result.outcome === "active") {
        if (this.active?.sessionId !== result.session.sessionId) {
          this.queue = [];
          this.seen.clear();
          this.gapUpdates.clear();
          this.lossReasons.clear();
          this.openGap = null;
          this.hadGap = false;
          this.gapsTruncated = false;
          this.counters = { matched: 0, queued: 0, persisted: 0, duplicates: 0, rejected: 0,
            queueDrops: 0, writeFailures: 0, sourceGaps: 0 };
          this.emit("replay_capture_activated", { source: "blitzortung",
            sessionId: result.session.sessionId, activatedAt: result.session.activatedAt,
            expiresAt: result.session.expiresAt, centerLat: result.session.centerLat,
            centerLon: result.session.centerLon, sideKm: result.session.sideKm });
        }
        this.active = result.session;
      } else {
        if (this.active) this.emit("replay_capture_ended", { source: "blitzortung",
          sessionId: this.active.sessionId, outcome: result.outcome,
          captureHealth: result.outcome === "completed" ? result.session.captureHealth : "incomplete" });
        this.active = null;
        this.queue = [];
        this.gapUpdates.clear();
        this.openGap = null;
      }
      if (this.active && this.now() - this.lastSummaryAt >= 60_000) {
        this.lastSummaryAt = this.now();
        this.emit("replay_capture_summary", { source: "blitzortung", sessionId: this.active.sessionId,
          sourceHealth: this.active.sourceHealth, captureHealth: this.active.captureHealth,
          storedEventCount: this.active.eventCount, queueSize: this.queue.length, ...this.counters });
      }
    } catch (error) {
      if (this.active) this.markLoss("write_failure");
      this.syncFailures++;
      this.syncRetryAt = this.now() + Math.min(60_000, 2_000 * 2 ** Math.min(this.syncFailures - 1, 5));
      nextPollMs = Math.max(CAPTURE_POLL_MS, this.syncRetryAt - this.now());
      if ((this.syncFailures & (this.syncFailures - 1)) === 0) {
        this.emit("replay_capture_error", { source: "blitzortung", stage: "sync",
          reason: error instanceof Error ? error.name : "unknown", retryAt: new Date(this.syncRetryAt).toISOString() });
      }
    } finally {
      this.busy = false;
      if (this.running) {
        if (this.timer) clearTimeout(this.timer);
        this.timer = setTimeout(() => { this.timer = null; void this.tick(); }, nextPollMs);
        this.timer.unref();
      }
    }
  }
}
