import assert from "node:assert/strict";
import { test } from "node:test";
import { ANKARA_BOX, backoffMs, BoundedDedupe, eventKey, inBox, Metrics, parseFrame, percentile, subscription } from "./core.ts";

test("v24 subscription and box order", () => {
  const frame = JSON.parse(subscription(ANKARA_BOX, { "2": 123 }));
  assert.deepEqual(frame.p, [40.35, 33.45, 39.45, 31.95]);
  assert.equal(frame.v, 24);
  assert.equal(frame.i["2"], 123);
  assert.equal("from_lightningmaps_org" in frame, false);
});

test("parse millisecond stroke and controls; reject bad coordinates and timestamps", () => {
  assert.deepEqual(parseFrame('{"reload":59000}', 1000), { kind: "control", control: "reload" });
  assert.equal(parseFrame("!", 1000).kind, "malformed");
  const result = parseFrame(JSON.stringify({ time: 1784284365, strokes: [
    { time: 1784284363137, lat: 39.93, lon: 32.86, src: 2, id: 6034205, del: 1830 },
    { time: 1784284363137, lat: 139, lon: 32.86 },
    { time: 1784284363.137, lat: 39.93, lon: 32.86 },
  ] }), 1784284365000);
  assert.equal(result.kind, "events");
  if (result.kind !== "events") return;
  assert.equal(result.rejected, 2);
  assert.equal(result.events[0].eventTimeMs, 1784284363137);
  assert.equal(new Date(result.events[0].eventTimeMs).toISOString(), "2026-07-17T10:32:43.137Z");
  assert.equal(result.events[0].sourceEventKey, "2/6034205");
  assert.equal(result.events[0].dischargeType, "unknown");
  assert.equal(inBox(result.events[0], ANKARA_BOX), true);
});

test("bounded dedupe and heuristic when identifier missing", () => {
  const dedupe = new BoundedDedupe(2);
  assert.equal(dedupe.seen("2/1"), false);
  assert.equal(dedupe.seen("2/1"), true);
  assert.equal(dedupe.seen("2/2"), false);
  assert.equal(dedupe.seen("2/3"), false);
  assert.equal(dedupe.seen("2/1"), false);
  const frame = parseFrame('{"strokes":[{"time":1784284363137,"lat":39.93,"lon":32.86}]}', 1784284365000);
  assert.equal(frame.kind, "events");
  if (frame.kind === "events") assert.equal(eventKey(frame.events[0]), "heuristic/1784284363137/39.930000/32.860000");
});

test("capped exponential backoff with deterministic jitter", () => {
  assert.equal(backoffMs(0, 0), 500);
  assert.equal(backoffMs(2, 1), 4000);
  assert.equal(backoffMs(20, 1), 30000);
});

test("metrics: latency percentiles, inside count, peak minute and silent time", () => {
  const metrics = new Metrics(60000);
  for (const [i, latency] of [1000, 2000, 3000, 4000].entries()) {
    metrics.record({ source: "lightningmaps-live2", eventTimeMs: 61000 + i * 1000 - latency,
      receivedAtMs: 61000 + i * 1000, latitude: 39.93, longitude: 32.86,
      dischargeType: "unknown" }, i < 2);
  }
  metrics.record({ source: "lightningmaps-live2", eventTimeMs: 120000, receivedAtMs: 125000,
    latitude: 39.93, longitude: 32.86, dischargeType: "unknown" }, false);
  metrics.record({ source: "lightningmaps-live2", eventTimeMs: 0, receivedAtMs: 125000,
    latitude: 35, longitude: 30, dischargeType: "unknown" }, false);
  const result = metrics.summary(130000);
  assert.equal(result.parsed, 6);
  assert.equal(result.inside, 2);
  assert.equal(result.p50LatencyMs, 3000);
  assert.equal(result.p95LatencyMs, 125000);
  assert.equal(result.lowLagCount, 5);
  assert.equal(result.lowLagP50Ms, 3000);
  assert.equal(result.peakEventsPerMinute, 4);
  assert.equal(result.longestSilentMs, 61000);
  assert.equal(percentile([], .5), null);
});
