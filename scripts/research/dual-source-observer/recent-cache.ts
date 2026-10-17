import { haversineDistanceKm, type ObserverEvent } from "./core.ts";

export const BLITZ_RECENT_EVENT_RETENTION_MS = 15 * 60_000;
export const BLITZ_RECENT_EVENT_MAX_EVENTS = 10_000;
export const MAX_COVERAGE_RECONNECT_GAP_MS = 30_000;
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
  usable: boolean;
  requestedWindowMinutes: number;
  coverageStartMs: number;
  toleratedGapMs: number;
};

type CoverageGap = { startMs: number; endMs: number; durationMs: number; tolerated: boolean };
const MAX_RECORDED_COVERAGE_GAPS = 256;

export class BlitzRecentEventCache {
  private events: RecentBlitzEvent[] = [];
  private coverageBoundaryMs: number;
  private observationActive = false;
  private hasObservedConnection = false;
  private disconnectedAtMs: number | null = null;
  private latestEvictedEventTimeMs: number | null = null;
  private coverageGaps: CoverageGap[] = [];
  private gapHistoryCoverageStartMs = Number.NEGATIVE_INFINITY;

  constructor(startedAtMs: number = Date.now()) {
    this.coverageBoundaryMs = startedAtMs;
  }

  setObservationActive(active: boolean, atMs: number): void {
    if (!active) {
      if (this.observationActive || this.disconnectedAtMs === null) this.disconnectedAtMs = atMs;
      this.observationActive = false;
      return;
    }

    if (this.observationActive) return;
    const reconnectGapMs = this.disconnectedAtMs === null ? null : atMs - this.disconnectedAtMs;
    const hasPriorDisconnect = this.hasObservedConnection && reconnectGapMs !== null;
    const tolerableReconnect = hasPriorDisconnect && reconnectGapMs >= 0 &&
      reconnectGapMs <= MAX_COVERAGE_RECONNECT_GAP_MS;
    if (hasPriorDisconnect && reconnectGapMs !== null) {
      const uncertainClock = reconnectGapMs < 0;
      const gapStartMs = uncertainClock ? atMs : this.disconnectedAtMs!;
      const gapEndMs = uncertainClock ? this.disconnectedAtMs! : atMs;
      this.recordGap({
        startMs: gapStartMs,
        endMs: gapEndMs,
        durationMs: uncertainClock ? Number.POSITIVE_INFINITY : reconnectGapMs,
        tolerated: tolerableReconnect,
      });
    }
    if (!tolerableReconnect) this.coverageBoundaryMs = atMs;
    this.hasObservedConnection = true;
    this.observationActive = true;
    this.disconnectedAtMs = null;
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
    this.pruneCoverageGaps(nowMs - BLITZ_RECENT_EVENT_RETENTION_MS);
    const retentionStartMs = nowMs - BLITZ_RECENT_EVENT_RETENTION_MS;
    const evictionStartMs = this.latestEvictedEventTimeMs === null
      ? Number.NEGATIVE_INFINITY
      : this.latestEvictedEventTimeMs + 1;
    const coverageStartMs = Math.max(
      this.coverageBoundaryMs,
      retentionStartMs,
      evictionStartMs,
      this.gapHistoryCoverageStartMs,
    );
    const relevantGaps = this.coverageGaps.filter(gap => gap.startMs < nowMs && gap.endMs > requestedStartMs);
    const maxToleratedGapMs = relevantGaps.reduce((max, gap) => gap.tolerated
      ? Math.max(max, gap.durationMs)
      : max, 0);
    const historicalCoverageAvailable = requestedStartMs >= coverageStartMs;
    const hasUnacceptableGap = relevantGaps.some(gap => !gap.tolerated);
    const usable = this.observationActive && historicalCoverageAvailable && !hasUnacceptableGap;
    return {
      complete: usable && relevantGaps.length === 0,
      usable,
      requestedWindowMinutes: windowMinutes,
      coverageStartMs,
      toleratedGapMs: maxToleratedGapMs,
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

  private recordGap(gap: CoverageGap): void {
    this.coverageGaps.push(gap);
    if (this.coverageGaps.length > MAX_RECORDED_COVERAGE_GAPS) {
      const evicted = this.coverageGaps.splice(0, this.coverageGaps.length - MAX_RECORDED_COVERAGE_GAPS);
      for (const removed of evicted) {
        this.gapHistoryCoverageStartMs = Math.max(this.gapHistoryCoverageStartMs, removed.endMs);
      }
    }
  }

  private pruneCoverageGaps(cutoffMs: number): void {
    const retained: CoverageGap[] = [];
    for (const gap of this.coverageGaps) {
      if (gap.endMs > cutoffMs) retained.push(gap);
      else this.gapHistoryCoverageStartMs = Math.max(this.gapHistoryCoverageStartMs, gap.endMs);
    }
    this.coverageGaps = retained;
  }
}
