import test from "node:test";
import assert from "node:assert/strict";
import type { LightningEvent } from "../live-lightning-listener/core.ts";
import { greatCircleDistanceKm, OnlineLightningClusterer, DEFAULT_CLUSTER_PARAMETERS, freshnessState,
  evaluateParameterProfiles } from "./clusterer.ts";
import { LightningClusteringPipeline } from "./pipeline.ts";
import { ANKARA_BOX } from "../live-lightning-listener/core.ts";

const minute = 60_000;
function event(id: string, time: number, latitude = 40, longitude = 33, receivedAtMs = time + 1000): LightningEvent {
  return { source: "lightningmaps-live2", eventTimeMs: time, receivedAtMs, latitude, longitude,
    sourceEventKey: `4/${id}`, dischargeType: "unknown" };
}
function clusterer(overrides: Partial<typeof DEFAULT_CLUSTER_PARAMETERS> = {}) {
  return new OnlineLightningClusterer({ ...DEFAULT_CLUSTER_PARAMETERS, ...overrides });
}

test("great-circle distance handles identical points, short local distance, longitude and dateline", () => {
  assert.equal(greatCircleDistanceKm(40, 33, 40, 33), 0);
  assert.ok(Math.abs(greatCircleDistanceKm(0, 0, 0.01, 0) - 1.11195) < 0.02);
  assert.ok(greatCircleDistanceKm(60, 0, 60, 1) < greatCircleDistanceKm(0, 0, 0, 1));
  assert.ok(Math.abs(greatCircleDistanceKm(0, 179.9, 0, -179.9) - 22.24) < 0.2);
  assert.throws(() => greatCircleDistanceKm(91, 0, 0, 0), /invalid/);
});

test("nearby events within spatial and temporal limits form one cluster", () => {
  const c = clusterer();
  c.ingest(event("1", 1_000)); c.ingest(event("2", 3 * minute, 40.02)); c.ingest(event("3", 5 * minute, 40.03));
  assert.equal(c.clusters.length, 1);
  assert.equal(c.clusters[0].eventCount, 3);
});

test("far spatial events and excessive temporal gaps form separate clusters", () => {
  const c = clusterer();
  c.ingest(event("1", 1_000)); c.ingest(event("2", 2 * minute, 40, 33.2));
  c.ingest(event("3", 20 * minute, 40, 33));
  assert.equal(c.clusters.length, 3);
});

test("moving chain matches recent events rather than only the centroid", () => {
  const c = clusterer();
  c.ingest(event("a", 1_000, 40, 33));
  c.ingest(event("b", 2 * minute, 40, 33.07));
  c.ingest(event("c", 3 * minute, 40, 33.14));
  c.ingest(event("d", 4 * minute, 40, 33.21));
  assert.equal(c.clusters.length, 1);
  assert.equal(c.clusters[0].eventCount, 4);
  assert.ok(greatCircleDistanceKm(c.clusters[0].centerLatitude, c.clusters[0].centerLongitude, 40, 33.21) > 8);
});

test("pipeline deduplicates stable replay IDs before clustering", () => {
  const p = new LightningClusteringPipeline(ANKARA_BOX, DEFAULT_CLUSTER_PARAMETERS);
  p.accept(event("same", 10_000), 11_000); p.accept(event("same", 10_000), 12_000);
  assert.equal(p.counters.fresh, 1); assert.equal(p.counters.duplicates, 1);
  assert.equal(p.clusterer.clusters[0].eventCount, 1);
});

test("stale replay is counted but cannot create an active cluster", () => {
  const p = new LightningClusteringPipeline(ANKARA_BOX, DEFAULT_CLUSTER_PARAMETERS);
  const result = p.accept(event("old", 0, 40, 33, 20 * minute), 20 * minute);
  assert.equal(result.freshness, "stale"); assert.equal(p.counters.stale, 1);
  assert.equal(p.clusterer.clusters.length, 0);
  assert.equal(freshnessState(event("future", 20_000), 10_000, 10), "future");
});

test("cluster closes once reference time reaches the configured interval", () => {
  const c = clusterer(); c.ingest(event("1", 1_000));
  assert.equal(c.advance(1_000 + 15 * minute - 1).length, 0);
  assert.equal(c.advance(1_000 + 15 * minute)[0].status, "closed");
});

test("ambiguous match resolves deterministically by most recent cluster activity", () => {
  const c = clusterer({ maxSpatialDistanceKm: 12 });
  c.ingest(event("left", 1_000, 39.9, 33));
  c.ingest(event("right", 2_000, 40.1, 33));
  const assigned = c.ingest(event("middle", 3_000, 40, 33));
  assert.equal(assigned, "c-000002");
  assert.deepEqual(c.clusters.map(item => item.eventCount), [1, 2]);
});

test("slightly out-of-order fresh event updates extrema without moving last time backward", () => {
  const c = clusterer(); c.ingest(event("later", 5 * minute)); c.ingest(event("earlier", 4 * minute, 40.001));
  const result = c.clusters[0];
  assert.equal(result.eventCount, 2); assert.equal(result.firstEventTimeMs, 4 * minute);
  assert.equal(result.lastEventTimeMs, 5 * minute); assert.equal(result.minLatitude, 40);
});

test("profile sensitivity replays the same sequence and records freshness effects", () => {
  const input = [event("1", 0, 40, 33, 1_000), event("2", minute, 40.02, 33, 20 * minute),
    event("3", 20 * minute, 40.04, 33, 20 * minute + 1_000)];
  const result = evaluateParameterProfiles(input, [
    { ...DEFAULT_CLUSTER_PARAMETERS, maxSpatialDistanceKm: 2 },
    { ...DEFAULT_CLUSTER_PARAMETERS, maxSpatialDistanceKm: 8 },
    { ...DEFAULT_CLUSTER_PARAMETERS, freshnessWindowMinutes: 5 },
  ], 20 * minute + 2_000);
  assert.equal(result[0].metrics.totalClusters, 2);
  assert.equal(result[1].metrics.totalClusters, 2);
  assert.equal(result[2].freshEvents, 2);
  assert.equal(result[2].staleRejected, 1);
});
