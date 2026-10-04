import { percentile } from "./core.ts";

export const CONNECTION_AGE_BUCKETS = ["0-30s", "30-60s", "60-120s", "120-180s", "180-300s", ">300s"] as const;
export type ConnectionAgeBucket = typeof CONNECTION_AGE_BUCKETS[number];

export type LatencyObservation = {
  eventTimeMs: number;
  receivedAtMs: number;
  latencyMs: number;
  sourceEventKey: string | null;
  connectionAgeMs: number;
  insideRequestedBox: boolean;
  reconnectIndex: number;
};

export function connectionAgeBucket(ageMs: number): ConnectionAgeBucket {
  if (ageMs < 0) throw new Error("connection age cannot be negative");
  if (ageMs < 30_000) return "0-30s";
  if (ageMs < 60_000) return "30-60s";
  if (ageMs < 120_000) return "60-120s";
  if (ageMs < 180_000) return "120-180s";
  if (ageMs < 300_000) return "180-300s";
  return ">300s";
}

export function summarizeLatencies(observations: LatencyObservation[]) {
  const values = observations.map(item => item.latencyMs);
  return {
    eventCount: values.length,
    minLatencyMs: values.length ? Math.min(...values) : null,
    p50LatencyMs: percentile(values, .5),
    p95LatencyMs: percentile(values, .95),
    maxLatencyMs: values.length ? Math.max(...values) : null,
    countLte10s: values.filter(value => value >= 0 && value <= 10_000).length,
    countLte30s: values.filter(value => value >= 0 && value <= 30_000).length,
    countLte60s: values.filter(value => value >= 0 && value <= 60_000).length,
    countLte90s: values.filter(value => value >= 0 && value <= 90_000).length,
    countLte120s: values.filter(value => value >= 0 && value <= 120_000).length,
  };
}

// In-memory ring buffer. Percentiles and counts describe retained observations
// after capacity is reached; this keeps long research runs bounded.
export class LatencyTimeline {
  private readonly slots: Array<LatencyObservation | undefined>;
  private next = 0;
  private size = 0;
  readonly capacity: number;
  constructor(capacity = 100_000) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) throw new Error("invalid capacity");
    this.capacity = capacity;
    this.slots = new Array(capacity);
  }
  record(observation: LatencyObservation): void {
    this.slots[this.next] = observation;
    this.next = (this.next + 1) % this.capacity;
    this.size = Math.min(this.capacity, this.size + 1);
  }
  observations(): LatencyObservation[] {
    if (this.size < this.capacity) return this.slots.slice(0, this.size) as LatencyObservation[];
    return [...this.slots.slice(this.next), ...this.slots.slice(0, this.next)] as LatencyObservation[];
  }
  summary() {
    const observations = this.observations();
    const connectionAgeBuckets = Object.fromEntries(CONNECTION_AGE_BUCKETS.map(bucket => [bucket,
      summarizeLatencies(observations.filter(item => connectionAgeBucket(item.connectionAgeMs) === bucket))]));
    return { retainedObservationCount: observations.length, capacity: this.capacity, connectionAgeBuckets,
      reconnectPhases: summarizeReconnectPhases(observations) };
  }
}

export function freshestEventLagMs(newestEventTimeMs: number | null, nowMs: number): number | null {
  return newestEventTimeMs === null ? null : nowMs - newestEventTimeMs;
}

export function summarizeReconnectPhases(observations: LatencyObservation[]) {
  const before = observations.filter(item => item.reconnectIndex === 0);
  const after = observations.filter(item => item.reconnectIndex > 0);
  return {
    beforeReconnect: summarizeLatencies(before),
    afterReconnect0To30s: summarizeLatencies(after.filter(item => item.connectionAgeMs < 30_000)),
    afterReconnect30To60s: summarizeLatencies(after.filter(item => item.connectionAgeMs >= 30_000 && item.connectionAgeMs < 60_000)),
    afterReconnect60sPlus: summarizeLatencies(after.filter(item => item.connectionAgeMs >= 60_000)),
  };
}
