import { createHash } from "node:crypto";
import type { LightningEvent } from "../live-lightning-listener/core.ts";
import type { BlitzortungProbeEvent } from "../research/blitzortung-probe/protocol.ts";

export const BLITZ_ADMISSION_MAX_LATENCY_MS = 30_000;
export const BLITZ_EXACT_DEDUP_TTL_MS = 2 * 60_000;
export const BLITZ_EXACT_DEDUP_MAX_ENTRIES = 10_000;

export function shouldLogBlitzAdmissionRejection(reason: "admitted" | "duplicate" | "stale_or_future"): boolean {
  return reason === "stale_or_future";
}

export function blitzSourceStillHealthy(lastFrameAtMs: number | null, nowMs: number, timeoutMs: number): boolean {
  return lastFrameAtMs !== null && nowMs - lastFrameAtMs < timeoutMs;
}

// Source identity only. Receipt time, server, and derived fields must not affect it.
export function blitzFingerprint(event: BlitzortungProbeEvent): string {
  return JSON.stringify([event.eventTimeRaw, event.latitude, event.longitude,
    event.mdsRaw, event.mcgRaw, event.polarityRaw]);
}

export class BlitzPrimaryAdmission {
  private readonly seen = new Map<string, number>();
  readonly counters = { blitzRawEvents: 0, blitzExactDuplicates: 0,
    blitzRejectedStaleOrFuture: 0, blitzAdmittedEvents: 0 };

  get dedupEntryCount(): number { return this.seen.size; }

  admit(event: BlitzortungProbeEvent, accept: (event: LightningEvent, atMs: number) => void):
    "admitted" | "duplicate" | "stale_or_future" {
    this.counters.blitzRawEvents++;
    for (const [key, seenAt] of this.seen) {
      if (event.receivedAtMs - seenAt <= BLITZ_EXACT_DEDUP_TTL_MS) break;
      this.seen.delete(key);
    }
    const fingerprint = blitzFingerprint(event);
    const prior = this.seen.get(fingerprint);
    if (prior !== undefined && event.receivedAtMs - prior <= BLITZ_EXACT_DEDUP_TTL_MS) {
      this.counters.blitzExactDuplicates++;
      return "duplicate";
    }
    const latency = event.receivedAtMs - event.eventTimeMs;
    if (latency < 0 || latency > BLITZ_ADMISSION_MAX_LATENCY_MS) {
      this.counters.blitzRejectedStaleOrFuture++;
      return "stale_or_future";
    }
    this.seen.delete(fingerprint);
    this.seen.set(fingerprint, event.receivedAtMs);
    if (this.seen.size > BLITZ_EXACT_DEDUP_MAX_ENTRIES) this.seen.delete(this.seen.keys().next().value!);
    const sourceEventKey = `blitz/${createHash("sha256").update(fingerprint).digest("hex")}`;
    this.counters.blitzAdmittedEvents++;
    accept({ source: "blitzortung", eventTimeMs: event.eventTimeMs,
      receivedAtMs: event.receivedAtMs, latitude: event.latitude, longitude: event.longitude,
      sourceEventKey, dischargeType: "unknown" }, event.receivedAtMs);
    return "admitted";
  }
}
