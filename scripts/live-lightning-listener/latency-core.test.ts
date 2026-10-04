import assert from "node:assert/strict";
import { test } from "node:test";
import { connectionAgeBucket, freshestEventLagMs, LatencyTimeline, summarizeReconnectPhases } from "./latency-core.ts";

const observation = (latencyMs: number, connectionAgeMs: number, reconnectIndex = 0) => ({
  eventTimeMs: 100_000, receivedAtMs: 100_000 + latencyMs, latencyMs,
  sourceEventKey: `2/${latencyMs}`, connectionAgeMs, insideRequestedBox: true, reconnectIndex,
});

test("connection age bucket boundaries are stable", () => {
  assert.equal(connectionAgeBucket(0), "0-30s");
  assert.equal(connectionAgeBucket(29_999), "0-30s");
  assert.equal(connectionAgeBucket(30_000), "30-60s");
  assert.equal(connectionAgeBucket(60_000), "60-120s");
  assert.equal(connectionAgeBucket(120_000), "120-180s");
  assert.equal(connectionAgeBucket(180_000), "180-300s");
  assert.equal(connectionAgeBucket(300_000), ">300s");
  assert.throws(() => connectionAgeBucket(-1));
});

test("freshest event lag uses the newest timestamp and is empty when no event exists", () => {
  assert.equal(freshestEventLagMs(1_000, 4_000), 3_000);
  assert.equal(freshestEventLagMs(null, 4_000), null);
});

test("timeline summarizes age buckets and keeps bounded recent observations", () => {
  const timeline = new LatencyTimeline(2);
  timeline.record(observation(8_000, 10_000));
  timeline.record(observation(40_000, 35_000));
  timeline.record(observation(125_000, 65_000));
  const summary = timeline.summary();
  assert.equal(summary.retainedObservationCount, 2);
  assert.equal(summary.connectionAgeBuckets["30-60s"].eventCount, 1);
  assert.equal(summary.connectionAgeBuckets["60-120s"].countLte120s, 0);
  assert.equal(summary.connectionAgeBuckets["60-120s"].minLatencyMs, 125_000);
});

test("reconnect phase summaries separate pre-reconnect and first two post-reconnect windows", () => {
  const summary = summarizeReconnectPhases([
    observation(90_000, 200_000, 0), observation(80_000, 5_000, 1), observation(70_000, 40_000, 1),
  ]);
  assert.equal(summary.beforeReconnect.eventCount, 1);
  assert.equal(summary.beforeReconnect.p50LatencyMs, 90_000);
  assert.equal(summary.afterReconnect0To30s.eventCount, 1);
  assert.equal(summary.afterReconnect30To60s.p50LatencyMs, 70_000);
  assert.equal(summary.afterReconnect60sPlus.eventCount, 0);
  const empty = summarizeReconnectPhases([]);
  assert.equal(empty.beforeReconnect.eventCount, 0);
  assert.equal(empty.afterReconnect0To30s.p50LatencyMs, null);
});

test("empty timeline reports null latency percentiles and empty age windows", () => {
  const timeline = new LatencyTimeline();
  const summary = timeline.summary();
  assert.equal(summary.retainedObservationCount, 0);
  assert.equal(summary.connectionAgeBuckets["0-30s"].eventCount, 0);
  assert.equal(summary.connectionAgeBuckets["0-30s"].p50LatencyMs, null);
  assert.equal(summary.reconnectPhases.beforeReconnect.maxLatencyMs, null);
});
