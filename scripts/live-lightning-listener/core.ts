// Research-only LightningMaps v24 adapter. No production imports.
export type Box = { north: number; east: number; south: number; west: number };
export type LightningEvent = {
  source: "lightningmaps-live2";
  eventTimeMs: number;
  receivedAtMs: number;
  latitude: number;
  longitude: number;
  sourceEventKey?: string;
  rawDelayMs?: number;
  dischargeType: "unknown";
};

export const ANKARA_BOX: Box = { north: 40.35, east: 33.45, south: 39.45, west: 31.95 };

export function inBox(event: LightningEvent, box: Box): boolean {
  return event.latitude <= box.north && event.latitude >= box.south &&
    event.longitude <= box.east && event.longitude >= box.west;
}

// The other v24 fields remain opaque. These values were tested on 2026-10-04.
export function subscription(box: Box, ids: Record<string, number> = {}): string {
  return JSON.stringify({
    v: 24, i: ids, s: false, x: 0, w: 0, tx: 0, tw: 1, a: 4, z: 5,
    b: true, h: "", l: 1, t: 1,
    p: [box.north, box.east, box.south, box.west], r: "A",
  });
}

export type ParsedFrame =
  | { kind: "events"; events: LightningEvent[]; rejected: number }
  | { kind: "control"; control: string }
  | { kind: "malformed"; reason: string };

export function parseFrame(raw: string, receivedAtMs: number): ParsedFrame {
  let payload: unknown;
  try { payload = JSON.parse(raw); } catch { return { kind: "malformed", reason: "invalid JSON" }; }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { kind: "malformed", reason: "not an object" };
  }
  const frame = payload as Record<string, unknown>;
  if (!Array.isArray(frame.strokes)) {
    if ("cid" in frame) return { kind: "control", control: "hello" };
    if ("reload" in frame) return { kind: "control", control: "reload" };
    return { kind: "control", control: "other" };
  }
  const events: LightningEvent[] = [];
  let rejected = 0;
  for (const rawStroke of frame.strokes) {
    if (!rawStroke || typeof rawStroke !== "object" || Array.isArray(rawStroke)) { rejected++; continue; }
    const s = rawStroke as Record<string, unknown>;
    if (!Number.isSafeInteger(s.time) || (s.time as number) < 0 || (s.time as number) > 8.64e15 ||
        typeof s.lat !== "number" || !Number.isFinite(s.lat) ||
        typeof s.lon !== "number" || !Number.isFinite(s.lon) ||
        s.lat < -90 || s.lat > 90 || s.lon < -180 || s.lon > 180) { rejected++; continue; }
    const sourceEventKey = (Number.isSafeInteger(s.src) && (typeof s.id === "string" || Number.isSafeInteger(s.id)))
      ? `${s.src}/${s.id}` : undefined;
    events.push({ source: "lightningmaps-live2", eventTimeMs: s.time as number,
      receivedAtMs, latitude: s.lat, longitude: s.lon, sourceEventKey,
      rawDelayMs: typeof s.del === "number" && Number.isFinite(s.del) ? s.del : undefined,
      dischargeType: "unknown" });
  }
  return { kind: "events", events, rejected };
}

// No stable id means heuristic only; preserve milliseconds and six decimal places.
export function eventKey(event: LightningEvent): string {
  return event.sourceEventKey ?? `heuristic/${event.eventTimeMs}/${event.latitude.toFixed(6)}/${event.longitude.toFixed(6)}`;
}

export class BoundedDedupe {
  private keys = new Set<string>();
  readonly capacity: number;
  constructor(capacity = 20000) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) throw new Error("invalid capacity");
    this.capacity = capacity;
  }
  seen(key: string): boolean {
    if (this.keys.has(key)) return true;
    this.keys.add(key);
    if (this.keys.size > this.capacity) this.keys.delete(this.keys.values().next().value!);
    return false;
  }
}

export function backoffMs(attempt: number, random = Math.random()): number {
  return Math.floor(Math.min(30000, 1000 * 2 ** Math.min(10, Math.max(0, attempt))) *
    (0.5 + Math.max(0, Math.min(1, random)) * 0.5));
}

export function percentile(values: number[], p: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(p * sorted.length) - 1] ?? sorted[0];
}

export class Metrics {
  readonly startedAtMs: number;
  messages = 0; decoded = 0; parsed = 0; inside = 0; duplicates = 0; malformed = 0; reconnects = 0;
  lastEventTimeMs: number | null = null;
  lastReceiptMs: number | null = null;
  longestSilentMs = 0;
  private latencies: number[] = [];
  private latencyMin: number | null = null;
  private latencyMax: number | null = null;
  private latencyCursor = 0;
  private lowLagLatencies: number[] = [];
  private lowLagCursor = 0;
  private minuteCounts = new Map<number, number>();
  private firstReceiptMs: number | null = null;
  constructor(startedAtMs: number) { this.startedAtMs = startedAtMs; }
  record(event: LightningEvent, inside: boolean): void {
    this.parsed++;
    if (inside) this.inside++;
    const latency = event.receivedAtMs - event.eventTimeMs;
    this.latencyMin = Math.min(this.latencyMin ?? latency, latency);
    this.latencyMax = Math.max(this.latencyMax ?? latency, latency);
    // Bounded rolling sample, not an exact all-session percentile after 100k events.
    if (this.latencies.length < 100000) this.latencies.push(latency);
    else { this.latencies[this.latencyCursor] = latency; this.latencyCursor = (this.latencyCursor + 1) % 100000; }
    // A diagnostic subset, not an upstream guarantee of "live" delivery.
    if (latency >= 0 && latency <= 30000) {
      if (this.lowLagLatencies.length < 100000) this.lowLagLatencies.push(latency);
      else { this.lowLagLatencies[this.lowLagCursor] = latency; this.lowLagCursor = (this.lowLagCursor + 1) % 100000; }
    }
    const minute = Math.floor(event.receivedAtMs / 60000);
    this.minuteCounts.set(minute, (this.minuteCounts.get(minute) ?? 0) + 1);
    this.firstReceiptMs ??= event.receivedAtMs;
    if (this.lastReceiptMs !== null) this.longestSilentMs = Math.max(this.longestSilentMs, event.receivedAtMs - this.lastReceiptMs);
    this.lastReceiptMs = event.receivedAtMs;
    this.lastEventTimeMs = event.eventTimeMs;
  }
  summary(now = Date.now()) {
    const totalMinutes = Math.max(1 / 60, (now - this.startedAtMs) / 60000);
    return { startedAt: new Date(this.startedAtMs).toISOString(), uptimeSeconds: Math.round((now - this.startedAtMs) / 1000),
      messages: this.messages, decoded: this.decoded, parsed: this.parsed, inside: this.inside, duplicates: this.duplicates,
      malformed: this.malformed, reconnects: this.reconnects, latencyCount: this.latencies.length,
      minLatencyMs: this.latencyMin,
      p50LatencyMs: percentile(this.latencies, .5), p95LatencyMs: percentile(this.latencies, .95),
      maxLatencyMs: this.latencyMax,
      lowLagCount: this.lowLagLatencies.length,
      lowLagP50Ms: percentile(this.lowLagLatencies, .5), lowLagP95Ms: percentile(this.lowLagLatencies, .95),
      lowLagMaxMs: this.lowLagLatencies.length ? this.lowLagLatencies.reduce((max, latency) => Math.max(max, latency), 0) : null,
      eventsPerMinute: this.parsed / totalMinutes,
      peakEventsPerMinute: Math.max(0, ...this.minuteCounts.values()),
      longestSilentMs: Math.max(this.longestSilentMs, now - (this.lastReceiptMs ?? this.startedAtMs)),
      lastEventTime: this.lastEventTimeMs === null ? null : new Date(this.lastEventTimeMs).toISOString() };
  }
}
