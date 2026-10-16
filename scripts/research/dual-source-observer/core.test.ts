import assert from "node:assert/strict";
import test from "node:test";
import type { LightningEvent } from "../../live-lightning-listener/core.ts";
import type { BlitzortungProbeEvent } from "../blitzortung-probe/protocol.ts";
import {
  CrossSourceMatcher,
  FixedObservationWindows,
  MATCH_FINALIZATION_DELAY_MS,
  MATCH_HISTORY_TTL_MS,
  MAX_MATCH_BUFFER_EVENTS,
  LOW_LAG_LATENCY_MAX_MS,
  OBSERVATION_WINDOW_MS,
  ObserverSourceState,
  normalizeBlitzObserverEvent,
  normalizeLive2ObserverEvent,
  type MatchFinalization,
  type ObserverEvent,
  type ObserverSource,
} from "./core.ts";

function event(
  source: ObserverSource,
  observerEventId: string,
  eventTimeMs: number,
  receivedAtMs = eventTimeMs + 500,
  latitude = 39.9208,
  longitude = 32.8541,
): ObserverEvent {
  return {
    observerEventId, source, sourceServer: source === "blitzortung" ? "ws1" : null,
    sourceEventKey: source === "live2" ? `src/${observerEventId}` : null,
    receivedAtMs, eventTimeMs, eventTimeRaw: String(eventTimeMs),
    eventTimeUnit: "milliseconds",
    latencyMs: receivedAtMs - eventTimeMs, latencyEligible: receivedAtMs >= eventTimeMs,
    transportComparisonEligible: receivedAtMs - eventTimeMs >= 0 && receivedAtMs - eventTimeMs <= LOW_LAG_LATENCY_MAX_MS,
    latitude, longitude, insideMonitoringArea: true, polarityRaw: null, stationCount: null,
    mdsRaw: null, mcgRaw: null, regionRaw: null,
  };
}

test("observer Blitz normalization preserves source facts", () => {
  const source: BlitzortungProbeEvent = {
    source: "blitzortung", sourceServer: "ws7", receivedAtMs: 2_000, eventTimeMs: 2_100,
    eventTimeRaw: "2100000000", eventTimeUnit: "nanoseconds", latencyMs: -100, latencyEligible: false,
    latitude: 39.9208, longitude: 32.8541, polarityRaw: -1, stationCount: 8,
    mdsRaw: 42, mcgRaw: 7, regionRaw: 1, insideMonitoringArea: true,
  };
  assert.deepEqual(normalizeBlitzObserverEvent(source, "blitzortung-1"), {
    observerEventId: "blitzortung-1", source: "blitzortung", sourceServer: "ws7", sourceEventKey: null,
    receivedAtMs: 2_000, eventTimeMs: 2_100, eventTimeRaw: "2100000000", latencyMs: -100,
    eventTimeUnit: "nanoseconds",
    latencyEligible: false, transportComparisonEligible: false,
    latitude: 39.9208, longitude: 32.8541, insideMonitoringArea: true,
    polarityRaw: -1, stationCount: 8, mdsRaw: 42, mcgRaw: 7, regionRaw: 1,
  });
});

test("observer live2 normalization uses raw input without lifecycle invocation", () => {
  const source: LightningEvent = {
    source: "lightningmaps-live2", eventTimeMs: 1_000, receivedAtMs: 1_250,
    latitude: 39.9208, longitude: 32.8541, sourceEventKey: "4/99", rawDelayMs: 12,
    dischargeType: "unknown",
  };
  assert.deepEqual(normalizeLive2ObserverEvent(source, "live2-1"), {
    observerEventId: "live2-1", source: "live2", sourceServer: null, sourceEventKey: "4/99",
    receivedAtMs: 1_250, eventTimeMs: 1_000, eventTimeRaw: "1000", latencyMs: 250,
    eventTimeUnit: "milliseconds",
    latencyEligible: true, transportComparisonEligible: true,
    latitude: 39.9208, longitude: 32.8541, insideMonitoringArea: true,
    polarityRaw: null, stationCount: null, mdsRaw: null, mcgRaw: null, regionRaw: null,
  });
});

test("source health and counters cannot mutate the opposite source", () => {
  const live2 = new ObserverSourceState("live2", 0);
  const blitz = new ObserverSourceState("blitzortung", 0);
  live2.connecting();
  live2.connected();
  live2.frame(100);
  const before = structuredClone(blitz.summary(100));
  live2.disconnected();
  live2.reconnect();
  assert.deepEqual(blitz.summary(100), before);
  assert.equal(blitz.healthy, false);
  assert.equal(live2.healthy, false);
});

test("raw and low-lag latency retain distinct inclusion rules and future timestamps", () => {
  const state = new ObserverSourceState("live2", 0);
  const fiveSeconds = event("live2", "five-seconds", 1_000, 6_000);
  state.event(fiveSeconds);
  assert.equal(fiveSeconds.latencyMs, 5_000);
  assert.equal(fiveSeconds.latencyEligible, true);
  assert.equal(fiveSeconds.transportComparisonEligible, true);

  const boundary = event("live2", "low-lag-boundary", 2_000, 32_000);
  state.event(boundary);
  assert.equal(boundary.latencyMs, 30_000);
  assert.equal(boundary.transportComparisonEligible, true);

  const delayed = event("live2", "delayed", 3_000, 33_001);
  state.event(delayed);
  assert.equal(delayed.latencyMs, 30_001);
  assert.equal(delayed.latencyEligible, true);
  assert.equal(delayed.transportComparisonEligible, false);

  const future = event("live2", "future", 2_000, 1_999);
  assert.equal(future.latencyMs, -1);
  assert.equal(future.latencyEligible, false);
  assert.equal(future.transportComparisonEligible, false);
  state.event(future);
  const summary = state.summary(3_000);
  assert.equal(summary.futureTimestampEvents, 1);
  assert.equal(summary.eligibleSampleCount, 3);
  assert.equal(summary.latencyMinMs, 5_000);
  assert.equal(summary.latencyMedianMs, 30_000);
  assert.equal(summary.latencyP95Ms, 30_001);
  assert.equal(summary.latencyMaxMs, 30_001);
  assert.equal(summary.lowLagEligibleSampleCount, 2);
  assert.equal(summary.lowLagLatencyMinMs, 5_000);
  assert.equal(summary.lowLagLatencyMedianMs, 5_000);
  assert.equal(summary.lowLagLatencyP95Ms, 30_000);
  assert.equal(summary.lowLagLatencyMaxMs, 30_000);
  assert.equal(summary.delayedLatencyEvents, 1);
});

test("mixed startup-age samples stay in raw statistics and outside the low-lag subset", () => {
  const state = new ObserverSourceState("blitzortung", 0);
  for (const [index, latencyMs] of [2_000, 5_000, 8_000, 323_000, 665_000].entries()) {
    state.event(event("blitzortung", `mixed-${index}`, 1_000, 1_000 + latencyMs));
  }
  const summary = state.summary(700_000);
  assert.equal(summary.eligibleSampleCount, 5);
  assert.equal(summary.latencyMedianMs, 8_000);
  assert.equal(summary.latencyP95Ms, 665_000);
  assert.equal(summary.lowLagEligibleSampleCount, 3);
  assert.equal(summary.lowLagLatencyMedianMs, 5_000);
  assert.equal(summary.lowLagLatencyP95Ms, 8_000);
  assert.equal(summary.delayedLatencyEvents, 2);
});

test("low-lag latency samples and delayed counts are isolated per source", () => {
  const live2 = new ObserverSourceState("live2", 0);
  const blitz = new ObserverSourceState("blitzortung", 0);
  live2.event(event("live2", "live-delayed", 1_000, 324_000));
  blitz.event(event("blitzortung", "blitz-low-lag", 1_000, 3_000));
  const liveSummary = live2.summary(400_000);
  const blitzSummary = blitz.summary(400_000);
  assert.equal(liveSummary.eligibleSampleCount, 1);
  assert.equal(liveSummary.lowLagEligibleSampleCount, 0);
  assert.equal(liveSummary.delayedLatencyEvents, 1);
  assert.equal(blitzSummary.eligibleSampleCount, 1);
  assert.equal(blitzSummary.lowLagEligibleSampleCount, 1);
  assert.equal(blitzSummary.delayedLatencyEvents, 0);
});

test("latency over 30 seconds does not exclude events from cross-source matching", () => {
  const matcher = new CrossSourceMatcher();
  const eventTimeMs = 10_000;
  const liveReceivedAtMs = eventTimeMs + 323_000;
  const blitzReceivedAtMs = eventTimeMs + 324_000;
  const live = event("live2", "live-delayed-match", eventTimeMs, liveReceivedAtMs);
  const blitz = event("blitzortung", "blitz-delayed-match", eventTimeMs + 500, blitzReceivedAtMs);
  assert.ok(live.latencyMs > LOW_LAG_LATENCY_MAX_MS);
  assert.ok(blitz.latencyMs > LOW_LAG_LATENCY_MAX_MS);
  assert.equal(live.transportComparisonEligible, false);
  assert.equal(blitz.transportComparisonEligible, false);
  matcher.observe(live);
  assert.deepEqual(matcher.finalizeReady(liveReceivedAtMs + 1_000), []);
  matcher.observe(blitz);
  const liveFinalized = matcher.finalizeReady(liveReceivedAtMs + MATCH_FINALIZATION_DELAY_MS);
  assert.equal(liveFinalized.find(result => result.observerEventId === live.observerEventId)?.matchClass, "strict");
  assert.equal(liveFinalized.some(result => result.observerEventId === blitz.observerEventId), false);
  const blitzFinalized = matcher.finalizeReady(blitzReceivedAtMs + MATCH_FINALIZATION_DELAY_MS);
  assert.equal(blitzFinalized.find(result => result.observerEventId === blitz.observerEventId)?.matchClass, "strict");
});

test("strict match includes the exact two-second temporal boundary", () => {
  const matcher = new CrossSourceMatcher();
  matcher.observe(event("live2", "live", 10_000, 11_000));
  matcher.observe(event("blitzortung", "blitz", 12_000, 11_100));
  const finalized = matcher.finalizeReady(11_100 + MATCH_FINALIZATION_DELAY_MS);
  assert.equal(finalized.find(result => result.observerEventId === "live")?.matchClass, "strict");
  assert.equal(finalized.find(result => result.observerEventId === "live")?.absoluteEventTimeDeltaMs, 2_000);
});

test("counterpart arriving after 15 seconds is considered before the 30-second finalization", () => {
  assert.equal(MATCH_FINALIZATION_DELAY_MS, 30_000);
  const matcher = new CrossSourceMatcher();
  const liveReceivedAtMs = 11_000;
  matcher.observe(event("live2", "live-delivery", 10_000, liveReceivedAtMs));

  // Before the counterpart arrives, the event is still pending at 19 seconds.
  assert.deepEqual(matcher.finalizeReady(liveReceivedAtMs + 19_000), []);
  const blitzReceivedAtMs = liveReceivedAtMs + 20_000;
  matcher.observe(event("blitzortung", "blitz-delivery", 10_500, blitzReceivedAtMs));

  // It remains pending at 29 seconds and matches when the 30s grace expires.
  assert.deepEqual(matcher.finalizeReady(liveReceivedAtMs + 29_000), []);
  const finalized = matcher.finalizeReady(liveReceivedAtMs + MATCH_FINALIZATION_DELAY_MS);
  const liveResult = finalized.find(result => result.observerEventId === "live-delivery");
  assert.equal(liveResult?.matchClass, "strict");
  assert.equal(liveResult?.nearestObserverEventId, "blitz-delivery");
  assert.equal(liveResult?.absoluteEventTimeDeltaMs, 500);
});

test("event outside strict limits but inside loose limits is loose-only", () => {
  const matcher = new CrossSourceMatcher();
  matcher.observe(event("live2", "live", 10_000, 11_000));
  matcher.observe(event("blitzortung", "blitz", 15_000, 11_100, 39.9658, 32.8541));
  const result = matcher.finalizeReady(11_100 + MATCH_FINALIZATION_DELAY_MS)
    .find(candidate => candidate.observerEventId === "live");
  assert.equal(result?.matchClass, "loose");
  assert.equal(result?.absoluteEventTimeDeltaMs, 5_000);
  assert.ok((result?.nearestDistanceKm ?? 0) > 4.9 && (result?.nearestDistanceKm ?? 99) < 5.1);
});

test("outside temporal window finalizes unmatched", () => {
  const matcher = new CrossSourceMatcher();
  matcher.observe(event("live2", "live", 10_000, 11_000));
  matcher.observe(event("blitzortung", "blitz", 20_001, 11_100));
  const result = matcher.finalizeReady(11_100 + MATCH_FINALIZATION_DELAY_MS)
    .find(candidate => candidate.observerEventId === "live");
  assert.equal(result?.matchClass, "none");
  assert.equal(result?.nearestObserverEventId, null);
});

test("nearest eligible counterpart reports distance, event delta, receive delta, and receive order", () => {
  const matcher = new CrossSourceMatcher();
  matcher.observe(event("live2", "live", 10_000, 12_000));
  matcher.observe(event("blitzortung", "farther-time", 11_000, 11_500, 39.9298, 32.8541));
  matcher.observe(event("blitzortung", "nearest-time", 10_500, 12_500, 39.9298, 32.8541));
  const result = matcher.finalizeReady(12_500 + MATCH_FINALIZATION_DELAY_MS)
    .find(candidate => candidate.observerEventId === "live");
  assert.equal(result?.nearestObserverEventId, "nearest-time");
  assert.equal(result?.absoluteEventTimeDeltaMs, 500);
  assert.equal(result?.receiveTimeDeltaMs, 500);
  assert.equal(result?.receivedFirst, "live2");
  assert.ok((result?.nearestDistanceKm ?? 0) > 0.9 && (result?.nearestDistanceKm ?? 99) < 1.1);
});

test("matching history expires and total buffer remains bounded", () => {
  const matcher = new CrossSourceMatcher();
  matcher.observe(event("live2", "old", 1_000, 1_500));
  matcher.finalizeReady(1_500 + MATCH_FINALIZATION_DELAY_MS);
  matcher.finalizeReady(1_500 + MATCH_HISTORY_TTL_MS + 1);
  assert.equal(matcher.bufferedEvents, 0);

  for (let index = 0; index <= MAX_MATCH_BUFFER_EVENTS; index++) {
    matcher.observe(event("live2", `capacity-${index}`, 100_000 + index, 100_500 + index));
  }
  assert.equal(matcher.bufferedEvents, MAX_MATCH_BUFFER_EVENTS);
  assert.equal(matcher.pendingEvents, MAX_MATCH_BUFFER_EVENTS);
});

test("fixed observation window counts source events and match classes", () => {
  const windows = new FixedObservationWindows();
  const start = OBSERVATION_WINDOW_MS * 10;
  windows.observe(event("live2", "live-strict", start, start + 100));
  windows.observe(event("live2", "live-none", start + 1_000, start + 1_100));
  windows.observe(event("blitzortung", "blitz-loose", start + 2_000, start + 2_100));

  const finalized = (source: ObserverSource, matchClass: MatchFinalization["matchClass"], receivedAtMs: number): MatchFinalization => ({
    source, observerEventId: `${source}-${matchClass}`, eventTimeMs: receivedAtMs - 100, receivedAtMs,
    latitude: 39.92, longitude: 32.85, oppositeSource: source === "live2" ? "blitzortung" : "live2",
    nearestObserverEventId: null, nearestDistanceKm: null, absoluteEventTimeDeltaMs: null,
    receiveTimeDeltaMs: null, receivedFirst: null, matchClass, finalizationReason: "window_elapsed",
  });
  windows.finalized(finalized("live2", "strict", start + 100));
  windows.finalized(finalized("live2", "none", start + 1_100));
  windows.finalized(finalized("blitzortung", "loose", start + 2_100));

  const [summary] = windows.closeReady(start + OBSERVATION_WINDOW_MS + MATCH_FINALIZATION_DELAY_MS);
  assert.deepEqual(summary, {
    windowStartMs: start, windowEndMs: start + OBSERVATION_WINDOW_MS,
    live2EventsObserved: 2, blitzEventsObserved: 1,
    live2StrictMatches: 1, blitzStrictMatches: 0,
    live2LooseMatches: 0, blitzLooseMatches: 1,
    live2Unmatched: 1, blitzUnmatched: 0,
    firstLive2EventTimeMs: start, firstBlitzEventTimeMs: start + 2_000,
    firstEventSource: "live2", firstEventLeadMs: 2_000,
    firstReceivedSource: "live2", firstReceiveLeadMs: 2_000,
  });
});

test("fixed observation windows report connected-but-quiet periods", () => {
  const windows = new FixedObservationWindows();
  const start = OBSERVATION_WINDOW_MS * 20;
  windows.touch(start + 1);
  const [summary] = windows.closeReady(start + OBSERVATION_WINDOW_MS + MATCH_FINALIZATION_DELAY_MS);
  assert.equal(summary.live2EventsObserved, 0);
  assert.equal(summary.blitzEventsObserved, 0);
  assert.equal(summary.firstEventSource, null);
  assert.equal(summary.firstReceivedSource, null);
});
