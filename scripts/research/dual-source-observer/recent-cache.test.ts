import assert from "node:assert/strict";
import test from "node:test";
import { haversineDistanceKm, type ObserverEvent } from "./core.ts";
import {
  BLITZ_RECENT_EVENT_MAX_EVENTS,
  BLITZ_RECENT_EVENT_RETENTION_MS,
  BlitzRecentEventCache,
  type RecentQuery,
} from "./recent-cache.ts";

const NOW = 1_790_000_000_000;
const QUERY: RecentQuery = { latitude: 39.92, longitude: 32.85, radiusKm: 100, windowMinutes: 15 };

function event(id: string, changes: Partial<ObserverEvent> = {}): ObserverEvent {
  return {
    observerEventId: id, source: "blitzortung", sourceServer: "ws1", sourceEventKey: null,
    eventTimeMs: NOW - 1_000, receivedAtMs: NOW, eventTimeRaw: String(NOW - 1_000),
    eventTimeUnit: "milliseconds", latencyMs: 1_000, latencyEligible: true,
    transportComparisonEligible: true, latitude: 39.92, longitude: 32.85,
    insideMonitoringArea: true, polarityRaw: null, stationCount: null,
    mdsRaw: null, mcgRaw: null, regionRaw: null, ...changes,
  };
}

test("cache stores only Blitz deliveries, including those outside Ankara, preserving latency flags", () => {
  const cache = new BlitzRecentEventCache();
  cache.insert(event("live", { source: "live2" }), NOW);
  cache.insert(event("blitz", { insideMonitoringArea: false, latencyMs: -10, transportComparisonEligible: false }), NOW);
  assert.deepEqual(cache.query(QUERY, NOW).map(item => item.observerEventId), ["blitz"]);
  assert.equal(cache.query(QUERY, NOW)[0].latencyMs, -10);
  assert.equal(cache.query(QUERY, NOW)[0].transportComparisonEligible, false);
});

test("fresh active cache reports an empty 15-minute query as incomplete", () => {
  const cache = new BlitzRecentEventCache(NOW);
  cache.setObservationActive(true, NOW);
  assert.deepEqual(cache.query(QUERY, NOW), []);
  assert.deepEqual(cache.coverage(15, NOW), {
    complete: false, requestedWindowMinutes: 15, coverageStartMs: NOW,
  });
});

test("continuous history spanning the request can prove an empty area clear", () => {
  const startedAt = NOW - BLITZ_RECENT_EVENT_RETENTION_MS;
  const cache = new BlitzRecentEventCache(startedAt);
  cache.setObservationActive(true, startedAt);
  assert.deepEqual(cache.query(QUERY, NOW), []);
  assert.deepEqual(cache.coverage(15, NOW), {
    complete: true, requestedWindowMinutes: 15, coverageStartMs: startedAt,
  });
});

test("shorter windows become complete before a full 15-minute window", () => {
  const startedAt = NOW - 5 * 60_000;
  const cache = new BlitzRecentEventCache(startedAt);
  cache.setObservationActive(true, startedAt);
  assert.equal(cache.coverage(5, NOW).complete, true);
  assert.equal(cache.coverage(15, NOW).complete, false);
});

test("cap eviction makes affected history incomplete while retained events remain queryable", () => {
  const startedAt = NOW - BLITZ_RECENT_EVENT_RETENTION_MS;
  const cache = new BlitzRecentEventCache(startedAt);
  cache.setObservationActive(true, startedAt);
  for (let i = 0; i <= BLITZ_RECENT_EVENT_MAX_EVENTS; i++) {
    cache.insert(event(`capped-${i}`, { eventTimeMs: NOW - 30_000 }), NOW);
  }
  assert.equal(cache.query(QUERY, NOW).length, BLITZ_RECENT_EVENT_MAX_EVENTS);
  assert.equal(cache.coverage(15, NOW).complete, false);
  assert.equal(cache.coverage(1, NOW).complete, false);
});

test("disconnected observer cannot claim complete coverage after its prior interval", () => {
  const startedAt = NOW - BLITZ_RECENT_EVENT_RETENTION_MS;
  const cache = new BlitzRecentEventCache(startedAt);
  cache.setObservationActive(true, startedAt);
  cache.setObservationActive(false, NOW - 1_000);
  assert.equal(cache.coverage(1, NOW).complete, false);
});

test("retention expiry, event-time window, and hard event cap are independent", () => {
  const cache = new BlitzRecentEventCache();
  cache.insert(event("expired", { receivedAtMs: NOW - BLITZ_RECENT_EVENT_RETENTION_MS - 1 }), NOW);
  cache.insert(event("old-event", { eventTimeMs: NOW - 11 * 60_000 }), NOW);
  cache.insert(event("future-event", { eventTimeMs: NOW + 1 }), NOW);
  assert.deepEqual(cache.query({ ...QUERY, windowMinutes: 10 }, NOW).map(item => item.observerEventId), []);
  for (let i = 0; i <= BLITZ_RECENT_EVENT_MAX_EVENTS; i++) {
    cache.insert(event(`item-${i}`, { eventTimeMs: NOW - 100 - i }), NOW);
  }
  const all = cache.query(QUERY, NOW);
  assert.equal(all.length, BLITZ_RECENT_EVENT_MAX_EVENTS);
  assert.ok(!all.some(item => item.observerEventId === "item-0"));
  assert.equal(cache.query(QUERY, NOW + BLITZ_RECENT_EVENT_RETENTION_MS + 1).length, 0);
});

test("radius is inclusive on its calculated boundary and excludes just beyond it", () => {
  const cache = new BlitzRecentEventCache();
  const point = event("boundary", { longitude: 33 });
  const distance = haversineDistanceKm(QUERY, point);
  cache.insert(point, NOW);
  assert.equal(cache.query({ ...QUERY, radiusKm: distance }, NOW).length, 1);
  assert.equal(cache.query({ ...QUERY, radiusKm: distance - 0.000001 }, NOW).length, 0);
});

test("newest event time sorts first with stable receipt and local ID tie breaks", () => {
  const cache = new BlitzRecentEventCache();
  cache.insert(event("z", { eventTimeMs: NOW - 2_000 }), NOW);
  cache.insert(event("b", { eventTimeMs: NOW - 1_000 }), NOW);
  cache.insert(event("a", { eventTimeMs: NOW - 1_000 }), NOW);
  cache.insert(event("new", { eventTimeMs: NOW - 1_000, receivedAtMs: NOW + 1 }), NOW);
  assert.deepEqual(cache.query(QUERY, NOW).map(item => item.observerEventId), ["new", "a", "b", "z"]);
});
