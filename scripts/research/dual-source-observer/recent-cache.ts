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

export class BlitzRecentEventCache {
  private events: RecentBlitzEvent[] = [];

  insert(event: ObserverEvent, nowMs: number = Date.now()): void {
    if (event.source !== "blitzortung") return;
    this.prune(nowMs);
    if (event.receivedAtMs < nowMs - BLITZ_RECENT_EVENT_RETENTION_MS) return;
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
      this.events.splice(0, this.events.length - BLITZ_RECENT_EVENT_MAX_EVENTS);
    }
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
      this.events = this.events.filter(event => event.receivedAtMs >= cutoff);
    }
  }
}
