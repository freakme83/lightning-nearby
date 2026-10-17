import { haversineDistanceKm, type ObserverEvent } from "./core.ts";

export const BLITZ_RECENT_EVENT_RETENTION_MS = 15 * 60_000;
export const BLITZ_RECENT_EVENT_MAX_EVENTS = 10_000;
export const MAX_RECENT_RADIUS_KM = 250;
export const MAX_RECENT_WINDOW_MINUTES = 15;

export type RecentBlitzEvent = Pick<ObserverEvent,
  "observerEventId" | "sourceServer" | "eventTimeMs" | "receivedAtMs" |
  "latitude" | "longitude" | "latencyMs" | "transportComparisonEligible"
>;
export type RecentQuery = {
  latitude: number;
  longitude: number;
  radiusKm: number;
  windowMinutes: number;
};
export type RecentCoverage = {
  complete: boolean;
  requestedWindowMinutes: number;
  coverageStartMs: number;
};

export class BlitzRecentEventCache {
  private events: RecentBlitzEvent[] = [];
  private coverageBoundaryMs: number;
  private observationActive = false;
  private latestEvictedEventTimeMs: number | null = null;

  constructor(startedAtMs: number = Date.now()) {
    this.coverageBoundaryMs = startedAtMs;
  }

  setObservationActive(active: boolean, atMs: number): void {
    this.observationActive = active;
    // A reconnect starts a new continuous-coverage interval. A disconnect
    // also moves the boundary forward while preventing any complete claim.
    this.coverageBoundaryMs = atMs;
  }

  insert(event: ObserverEvent, nowMs: number = Date.now()): void {
    if (event.source !== "blitzortung") return;
    this.prune(nowMs);
    if (event.receivedAtMs < nowMs - BLITZ_RECENT_EVENT_RETENTION_MS) {
      this.recordEvicted(event);
      return;
    }
    this.events.push({
      observerEventId: event.observerEventId,
      sourceServer: event.sourceServer,
      eventTimeMs: event.eventTimeMs,
      receivedAtMs: event.receivedAtMs,
      latitude: event.latitude,
      longitude: event.longitude,
      latencyMs: event.latencyMs,
      transportComparisonEligible: event.transportComparisonEligible,
    });
    if (this.events.length > BLITZ_RECENT_EVENT_MAX_EVENTS) {
      const evicted = this.events.splice(0, this.events.length - BLITZ_RECENT_EVENT_MAX_EVENTS);
      for (const removed of evicted) this.recordEvicted(removed);
    }
  }

  coverage(windowMinutes: number, nowMs: number = Date.now()): RecentCoverage {
    this.prune(nowMs);
    const requestedStartMs = nowMs - windowMinutes * 60_000;
    const retentionStartMs = nowMs - BLITZ_RECENT_EVENT_RETENTION_MS;
    const evictionStartMs = this.latestEvictedEventTimeMs === null
      ? Number.NEGATIVE_INFINITY
      : this.latestEvictedEventTimeMs + 1;
    const coverageStartMs = Math.max(this.coverageBoundaryMs, retentionStartMs, evictionStartMs);
    return {
      complete: this.observationActive && requestedStartMs >= coverageStartMs,
      requestedWindowMinutes: windowMinutes,
      coverageStartMs,
    };
  }

  query(query: RecentQuery, nowMs: number = Date.now()): (RecentBlitzEvent & { distanceKm: number })[] {
    this.prune(nowMs);
    const earliestEventMs = nowMs - query.windowMinutes * 60_000;
    return this.events.flatMap(event => {
      if (event.eventTimeMs < earliestEventMs || event.eventTimeMs > nowMs) return [];
      const distanceKm = haversineDistanceKm(query, event);
      return distanceKm <= query.radiusKm ? [{ ...event, distanceKm }] : [];
    }).sort((a, b) => b.eventTimeMs - a.eventTimeMs || b.receivedAtMs - a.receivedAtMs ||
      a.observerEventId.localeCompare(b.observerEventId));
  }

  private prune(nowMs: number): void {
    const cutoff = nowMs - BLITZ_RECENT_EVENT_RETENTION_MS;
    // Receipts are appended in receive order; avoid scanning the full global
    // feed on every delivery when its oldest entry is still recent.
    if (this.events.length && this.events[0].receivedAtMs < cutoff) {
      const retained: RecentBlitzEvent[] = [];
      for (const event of this.events) {
        if (event.receivedAtMs >= cutoff) retained.push(event);
        else this.recordEvicted(event);
      }
      this.events = retained;
    }
  }

  private recordEvicted(event: Pick<RecentBlitzEvent, "eventTimeMs">): void {
    this.latestEvictedEventTimeMs = this.latestEvictedEventTimeMs === null
      ? event.eventTimeMs
      : Math.max(this.latestEvictedEventTimeMs, event.eventTimeMs);
  }
}
