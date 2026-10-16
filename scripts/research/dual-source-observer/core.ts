import { pointInMonitoringArea } from "../../lightning-incident-lifecycle/monitoring-area.ts";
import type { LightningEvent } from "../../live-lightning-listener/core.ts";
import type { BlitzortungProbeEvent, BlitzortungServer } from "../blitzortung-probe/protocol.ts";

export const OBSERVER_SOURCES = ["live2", "blitzortung"] as const;
export type ObserverSource = (typeof OBSERVER_SOURCES)[number];
export type ObserverConnectionState = "disconnected" | "connecting" | "connected" | "receiving";
export type MatchClass = "strict" | "loose" | "none";

// Shadow-analysis parameters only. They are not production or scientific classification rules.
export const STRICT_MATCH_MAX_TIME_MS = 2_000;
export const STRICT_MATCH_MAX_DISTANCE_KM = 3;
export const LOOSE_MATCH_MAX_TIME_MS = 10_000;
export const LOOSE_MATCH_MAX_DISTANCE_KM = 10;
export const MATCH_FINALIZATION_DELAY_MS = 30_000;
export const MATCH_HISTORY_TTL_MS = 60_000;
export const MAX_MATCH_BUFFER_EVENTS = 20_000;
export const OBSERVATION_WINDOW_MS = 5 * 60_000;
export const MAX_LATENCY_SAMPLES = 10_000;
// Diagnostic subset only, following the live-lightning listener convention; not an upstream or freshness guarantee.
export const LOW_LAG_LATENCY_MAX_MS = 30_000;

export type ObserverEvent = {
  observerEventId: string;
  source: ObserverSource;
  sourceServer: BlitzortungServer | null;
  sourceEventKey: string | null;
  receivedAtMs: number;
  eventTimeMs: number;
  eventTimeRaw: string;
  eventTimeUnit: "milliseconds" | BlitzortungProbeEvent["eventTimeUnit"];
  latencyMs: number;
  latencyEligible: boolean;
  transportComparisonEligible: boolean;
  latitude: number;
  longitude: number;
  insideMonitoringArea: boolean;
  polarityRaw: string | number | boolean | null;
  stationCount: number | null;
  mdsRaw: string | number | boolean | null;
  mcgRaw: string | number | boolean | null;
  regionRaw: string | number | boolean | null;
};

export function normalizeBlitzObserverEvent(
  event: BlitzortungProbeEvent,
  observerEventId: string,
): ObserverEvent {
  return {
    observerEventId,
    source: "blitzortung",
    sourceServer: event.sourceServer,
    sourceEventKey: null,
    receivedAtMs: event.receivedAtMs,
    eventTimeMs: event.eventTimeMs,
    eventTimeRaw: event.eventTimeRaw,
    eventTimeUnit: event.eventTimeUnit,
    latencyMs: event.latencyMs,
    latencyEligible: event.latencyEligible,
    transportComparisonEligible: isLowLagLatency(event.latencyMs),
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

export function normalizeLive2ObserverEvent(event: LightningEvent, observerEventId: string): ObserverEvent {
  const latencyMs = event.receivedAtMs - event.eventTimeMs;
  return {
    observerEventId,
    source: "live2",
    sourceServer: null,
    sourceEventKey: event.sourceEventKey ?? null,
    receivedAtMs: event.receivedAtMs,
    eventTimeMs: event.eventTimeMs,
    eventTimeRaw: String(event.eventTimeMs),
    eventTimeUnit: "milliseconds",
    latencyMs,
    latencyEligible: latencyMs >= 0,
    transportComparisonEligible: isLowLagLatency(latencyMs),
    latitude: event.latitude,
    longitude: event.longitude,
    insideMonitoringArea: pointInMonitoringArea([event.longitude, event.latitude]),
    polarityRaw: null,
    stationCount: null,
    mdsRaw: null,
    mcgRaw: null,
    regionRaw: null,
  };
}

export function isLowLagLatency(latencyMs: number): boolean {
  return latencyMs >= 0 && latencyMs <= LOW_LAG_LATENCY_MAX_MS;
}

function percentile(sorted: readonly number[], fraction: number): number | null {
  if (sorted.length === 0) return null;
  return sorted[Math.ceil(sorted.length * fraction) - 1] ?? sorted[0];
}

class BoundedLatencySamples {
  private readonly samples: number[] = [];
  private cursor = 0;

  add(value: number): void {
    if (this.samples.length < MAX_LATENCY_SAMPLES) this.samples.push(value);
    else {
      this.samples[this.cursor] = value;
      this.cursor = (this.cursor + 1) % MAX_LATENCY_SAMPLES;
    }
  }

  summary(prefix?: "lowLag"): Record<string, number | null> {
    const sorted = [...this.samples].sort((a, b) => a - b);
    const names = prefix
      ? { count: "lowLagEligibleSampleCount", min: "lowLagLatencyMinMs", median: "lowLagLatencyMedianMs", p95: "lowLagLatencyP95Ms", max: "lowLagLatencyMaxMs" }
      : { count: "eligibleSampleCount", min: "latencyMinMs", median: "latencyMedianMs", p95: "latencyP95Ms", max: "latencyMaxMs" };
    return {
      [names.count]: sorted.length,
      [names.min]: sorted[0] ?? null,
      [names.median]: percentile(sorted, 0.5),
      [names.p95]: percentile(sorted, 0.95),
      [names.max]: sorted.at(-1) ?? null,
    };
  }
}

export class ObserverSourceState {
  readonly source: ObserverSource;
  readonly startedAtMs: number;
  connectionState: ObserverConnectionState = "disconnected";
  healthy = false;
  sourceServer: BlitzortungServer | null = null;
  connections = 0;
  reconnects = 0;
  framesReceived = 0;
  framesDecoded = 0;
  decodeFailures = 0;
  jsonParseFailures = 0;
  malformedPayloads = 0;
  eventsObserved = 0;
  eventsInsideMonitoringArea = 0;
  eventsOutsideMonitoringArea = 0;
  futureTimestampEvents = 0;
  delayedLatencyEvents = 0;
  lastFrameReceivedAtMs: number | null = null;
  lastEventTimeMs: number | null = null;
  private readonly latencies = new BoundedLatencySamples();
  private readonly lowLagLatencies = new BoundedLatencySamples();

  constructor(source: ObserverSource, startedAtMs: number) {
    this.source = source;
    this.startedAtMs = startedAtMs;
  }

  connecting(sourceServer: BlitzortungServer | null = null): void {
    this.connectionState = "connecting";
    this.healthy = false;
    this.sourceServer = sourceServer;
  }

  connected(): void {
    this.connectionState = "connected";
    this.healthy = true;
    this.connections++;
  }

  disconnected(): void {
    this.connectionState = "disconnected";
    this.healthy = false;
  }

  frame(receivedAtMs: number): void {
    this.connectionState = "receiving";
    this.healthy = true;
    this.framesReceived++;
    this.lastFrameReceivedAtMs = receivedAtMs;
  }

  decoded(count = 1): void { this.framesDecoded += count; }
  decodeFailure(): void { this.decodeFailures++; }
  jsonParseFailure(): void { this.jsonParseFailures++; }
  malformedPayload(count = 1): void { this.malformedPayloads += count; }
  reconnect(): void { this.reconnects++; }

  event(event: ObserverEvent): void {
    if (event.source !== this.source) throw new Error(`cannot record ${event.source} in ${this.source} state`);
    this.eventsObserved++;
    if (event.insideMonitoringArea) this.eventsInsideMonitoringArea++;
    else this.eventsOutsideMonitoringArea++;
    this.lastEventTimeMs = event.eventTimeMs;
    if (!event.latencyEligible) this.futureTimestampEvents++;
    else {
      this.latencies.add(event.latencyMs);
      if (isLowLagLatency(event.latencyMs)) this.lowLagLatencies.add(event.latencyMs);
      else if (event.latencyMs > LOW_LAG_LATENCY_MAX_MS) this.delayedLatencyEvents++;
    }
  }

  summary(nowMs: number): Record<string, unknown> {
    return {
      source: this.source,
      sourceServer: this.sourceServer,
      connectionState: this.connectionState,
      healthy: this.healthy,
      uptimeSeconds: Math.max(0, Math.round((nowMs - this.startedAtMs) / 1_000)),
      connections: this.connections,
      reconnects: this.reconnects,
      framesReceived: this.framesReceived,
      framesDecoded: this.framesDecoded,
      decodeFailures: this.decodeFailures,
      jsonParseFailures: this.jsonParseFailures,
      malformedPayloads: this.malformedPayloads,
      eventsObserved: this.eventsObserved,
      eventsInsideMonitoringArea: this.eventsInsideMonitoringArea,
      eventsOutsideMonitoringArea: this.eventsOutsideMonitoringArea,
      futureTimestampEvents: this.futureTimestampEvents,
      delayedLatencyEvents: this.delayedLatencyEvents,
      lastFrameReceivedAt: this.lastFrameReceivedAtMs === null ? null : new Date(this.lastFrameReceivedAtMs).toISOString(),
      lastEventTime: this.lastEventTimeMs === null ? null : new Date(this.lastEventTimeMs).toISOString(),
      ...this.latencies.summary(),
      ...this.lowLagLatencies.summary("lowLag"),
    };
  }
}

export function haversineDistanceKm(left: ObserverEvent, right: ObserverEvent): number {
  const radians = (degrees: number) => degrees * Math.PI / 180;
  const lat1 = radians(left.latitude);
  const lat2 = radians(right.latitude);
  const deltaLat = lat2 - lat1;
  const deltaLon = radians(right.longitude - left.longitude);
  const a = Math.sin(deltaLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLon / 2) ** 2;
  return 6_371.0088 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export type MatchFinalization = {
  source: ObserverSource;
  observerEventId: string;
  eventTimeMs: number;
  receivedAtMs: number;
  latitude: number;
  longitude: number;
  oppositeSource: ObserverSource;
  nearestObserverEventId: string | null;
  nearestDistanceKm: number | null;
  absoluteEventTimeDeltaMs: number | null;
  receiveTimeDeltaMs: number | null;
  receivedFirst: ObserverSource | "same_time" | null;
  matchClass: MatchClass;
  finalizationReason: "window_elapsed" | "buffer_capacity" | "shutdown";
};

type Candidate = { event: ObserverEvent; distanceKm: number; eventDeltaMs: number };

function candidateOrder(left: Candidate, right: Candidate): number {
  return left.eventDeltaMs - right.eventDeltaMs || left.distanceKm - right.distanceKm ||
    left.event.receivedAtMs - right.event.receivedAtMs ||
    left.event.observerEventId.localeCompare(right.event.observerEventId);
}

function receivedFirst(source: ObserverEvent, counterpart: ObserverEvent): ObserverSource | "same_time" {
  if (source.receivedAtMs === counterpart.receivedAtMs) return "same_time";
  return source.receivedAtMs < counterpart.receivedAtMs ? source.source : counterpart.source;
}

export class CrossSourceMatcher {
  private readonly pending: ObserverEvent[] = [];
  private readonly history: ObserverEvent[] = [];

  get bufferedEvents(): number { return this.history.length; }
  get pendingEvents(): number { return this.pending.length; }

  observe(event: ObserverEvent): MatchFinalization[] {
    if (!event.insideMonitoringArea) return [];
    this.pending.push(event);
    this.history.push(event);
    const forced: MatchFinalization[] = [];
    while (this.history.length > MAX_MATCH_BUFFER_EVENTS) {
      const oldest = this.history.shift()!;
      const pendingIndex = this.pending.indexOf(oldest);
      if (pendingIndex >= 0) {
        this.pending.splice(pendingIndex, 1);
        forced.push(this.finalizeEvent(oldest, "buffer_capacity"));
      }
    }
    return forced;
  }

  finalizeReady(nowMs: number): MatchFinalization[] {
    const ready: MatchFinalization[] = [];
    for (let index = this.pending.length - 1; index >= 0; index--) {
      const event = this.pending[index];
      if (nowMs - event.receivedAtMs < MATCH_FINALIZATION_DELAY_MS) continue;
      this.pending.splice(index, 1);
      ready.push(this.finalizeEvent(event, "window_elapsed"));
    }
    this.prune(nowMs);
    return ready.sort((a, b) => a.receivedAtMs - b.receivedAtMs || a.observerEventId.localeCompare(b.observerEventId));
  }

  finalizeAll(): MatchFinalization[] {
    const results = this.pending.map(event => this.finalizeEvent(event, "shutdown"));
    this.pending.length = 0;
    this.history.length = 0;
    return results;
  }

  private prune(nowMs: number): void {
    const cutoff = nowMs - MATCH_HISTORY_TTL_MS;
    for (let index = this.history.length - 1; index >= 0; index--) {
      const event = this.history[index];
      if (event.receivedAtMs >= cutoff || this.pending.includes(event)) continue;
      this.history.splice(index, 1);
    }
  }

  private finalizeEvent(event: ObserverEvent, finalizationReason: MatchFinalization["finalizationReason"]): MatchFinalization {
    const temporalCandidates = this.history
      .filter(candidate => candidate.source !== event.source && candidate.observerEventId !== event.observerEventId)
      .map(candidate => ({
        event: candidate,
        distanceKm: haversineDistanceKm(event, candidate),
        eventDeltaMs: Math.abs(event.eventTimeMs - candidate.eventTimeMs),
      }))
      .filter(candidate => candidate.eventDeltaMs <= LOOSE_MATCH_MAX_TIME_MS)
      .sort(candidateOrder);
    const strict = temporalCandidates.filter(candidate =>
      candidate.eventDeltaMs <= STRICT_MATCH_MAX_TIME_MS && candidate.distanceKm <= STRICT_MATCH_MAX_DISTANCE_KM)[0];
    const loose = temporalCandidates.filter(candidate => candidate.distanceKm <= LOOSE_MATCH_MAX_DISTANCE_KM)[0];
    const nearest = strict ?? loose ?? temporalCandidates[0] ?? null;
    const matchClass: MatchClass = strict ? "strict" : loose ? "loose" : "none";
    return {
      source: event.source,
      observerEventId: event.observerEventId,
      eventTimeMs: event.eventTimeMs,
      receivedAtMs: event.receivedAtMs,
      latitude: event.latitude,
      longitude: event.longitude,
      oppositeSource: event.source === "live2" ? "blitzortung" : "live2",
      nearestObserverEventId: nearest?.event.observerEventId ?? null,
      nearestDistanceKm: nearest?.distanceKm ?? null,
      absoluteEventTimeDeltaMs: nearest?.eventDeltaMs ?? null,
      receiveTimeDeltaMs: nearest ? Math.abs(event.receivedAtMs - nearest.event.receivedAtMs) : null,
      receivedFirst: nearest ? receivedFirst(event, nearest.event) : null,
      matchClass,
      finalizationReason,
    };
  }
}

type WindowBucket = {
  windowStartMs: number;
  events: Record<ObserverSource, number>;
  strict: Record<ObserverSource, number>;
  loose: Record<ObserverSource, number>;
  unmatched: Record<ObserverSource, number>;
  firstEventTimeMs: Record<ObserverSource, number | null>;
  firstReceivedAtMs: Record<ObserverSource, number | null>;
};

export type ObservationWindowSummary = {
  windowStartMs: number;
  windowEndMs: number;
  live2EventsObserved: number;
  blitzEventsObserved: number;
  live2StrictMatches: number;
  blitzStrictMatches: number;
  live2LooseMatches: number;
  blitzLooseMatches: number;
  live2Unmatched: number;
  blitzUnmatched: number;
  firstLive2EventTimeMs: number | null;
  firstBlitzEventTimeMs: number | null;
  firstEventSource: ObserverSource | "same_time" | null;
  firstEventLeadMs: number | null;
  firstReceivedSource: ObserverSource | "same_time" | null;
  firstReceiveLeadMs: number | null;
};

function firstSource(
  live2: number | null,
  blitzortung: number | null,
): { source: ObserverSource | "same_time" | null; deltaMs: number | null } {
  if (live2 === null || blitzortung === null) return { source: null, deltaMs: null };
  if (live2 === blitzortung) return { source: "same_time", deltaMs: 0 };
  return { source: live2 < blitzortung ? "live2" : "blitzortung", deltaMs: Math.abs(live2 - blitzortung) };
}

export class FixedObservationWindows {
  private readonly buckets = new Map<number, WindowBucket>();

  touch(receivedAtMs: number): void { this.bucket(receivedAtMs); }

  observe(event: ObserverEvent): void {
    if (!event.insideMonitoringArea) return;
    const bucket = this.bucket(event.receivedAtMs);
    bucket.events[event.source]++;
    bucket.firstEventTimeMs[event.source] = Math.min(bucket.firstEventTimeMs[event.source] ?? event.eventTimeMs, event.eventTimeMs);
    bucket.firstReceivedAtMs[event.source] = Math.min(bucket.firstReceivedAtMs[event.source] ?? event.receivedAtMs, event.receivedAtMs);
  }

  finalized(result: MatchFinalization): void {
    const bucket = this.bucket(result.receivedAtMs);
    if (result.matchClass === "strict") bucket.strict[result.source]++;
    else if (result.matchClass === "loose") bucket.loose[result.source]++;
    else bucket.unmatched[result.source]++;
  }

  closeReady(nowMs: number): ObservationWindowSummary[] {
    const summaries: ObservationWindowSummary[] = [];
    for (const [windowStartMs, bucket] of this.buckets) {
      if (nowMs < windowStartMs + OBSERVATION_WINDOW_MS + MATCH_FINALIZATION_DELAY_MS) continue;
      this.buckets.delete(windowStartMs);
      summaries.push(this.summary(bucket));
    }
    return summaries.sort((a, b) => a.windowStartMs - b.windowStartMs);
  }

  closeAll(): ObservationWindowSummary[] {
    const summaries = [...this.buckets.values()].map(bucket => this.summary(bucket));
    this.buckets.clear();
    return summaries.sort((a, b) => a.windowStartMs - b.windowStartMs);
  }

  private bucket(receivedAtMs: number): WindowBucket {
    const windowStartMs = Math.floor(receivedAtMs / OBSERVATION_WINDOW_MS) * OBSERVATION_WINDOW_MS;
    let bucket = this.buckets.get(windowStartMs);
    if (!bucket) {
      bucket = {
        windowStartMs,
        events: { live2: 0, blitzortung: 0 },
        strict: { live2: 0, blitzortung: 0 },
        loose: { live2: 0, blitzortung: 0 },
        unmatched: { live2: 0, blitzortung: 0 },
        firstEventTimeMs: { live2: null, blitzortung: null },
        firstReceivedAtMs: { live2: null, blitzortung: null },
      };
      this.buckets.set(windowStartMs, bucket);
    }
    return bucket;
  }

  private summary(bucket: WindowBucket): ObservationWindowSummary {
    const eventLead = firstSource(bucket.firstEventTimeMs.live2, bucket.firstEventTimeMs.blitzortung);
    const receiveLead = firstSource(bucket.firstReceivedAtMs.live2, bucket.firstReceivedAtMs.blitzortung);
    return {
      windowStartMs: bucket.windowStartMs,
      windowEndMs: bucket.windowStartMs + OBSERVATION_WINDOW_MS,
      live2EventsObserved: bucket.events.live2,
      blitzEventsObserved: bucket.events.blitzortung,
      live2StrictMatches: bucket.strict.live2,
      blitzStrictMatches: bucket.strict.blitzortung,
      live2LooseMatches: bucket.loose.live2,
      blitzLooseMatches: bucket.loose.blitzortung,
      live2Unmatched: bucket.unmatched.live2,
      blitzUnmatched: bucket.unmatched.blitzortung,
      firstLive2EventTimeMs: bucket.firstEventTimeMs.live2,
      firstBlitzEventTimeMs: bucket.firstEventTimeMs.blitzortung,
      firstEventSource: eventLead.source,
      firstEventLeadMs: eventLead.deltaMs,
      firstReceivedSource: receiveLead.source,
      firstReceiveLeadMs: receiveLead.deltaMs,
    };
  }
}
