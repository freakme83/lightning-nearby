import test from "node:test";
import assert from "node:assert/strict";
import type { LightningEvent } from "../live-lightning-listener/core.ts";
import { ANKARA_MONITORING_AREA, pointInMonitoringArea } from "../lightning-incident-lifecycle/monitoring-area.ts";
import { IncidentLifecycleEngine } from "../lightning-incident-lifecycle/incident-engine.ts";
import { INCIDENT_POLICY_PROFILES } from "../lightning-incident-lifecycle/types.ts";
import { DEFAULT_CLUSTER_PARAMETERS } from "./clusterer.ts";
import { LightningClusteringPipeline } from "./pipeline.ts";

test("Ankara mode sends only fresh unique polygon events into clustering and lifecycle input", () => {
  const area = { ...ANKARA_MONITORING_AREA, contains: (item: LightningEvent) =>
    pointInMonitoringArea([item.longitude, item.latitude], ANKARA_MONITORING_AREA) };
  const pipeline = new LightningClusteringPipeline(area.bounds, DEFAULT_CLUSTER_PARAMETERS, { monitoringArea: area });
  const now = 1_000_000;
  const lifecycle = new IncidentLifecycleEngine(INCIDENT_POLICY_PROFILES[1], now);
  lifecycle.setSourceHealth({ state: "live", lastFrameAtMs: now }, now);
  const event = (id: string, longitude: number, latitude: number, eventTimeMs = now - 1_000): LightningEvent => ({
    source: "lightningmaps-live2", eventTimeMs, receivedAtMs: now, latitude, longitude,
    sourceEventKey: `4/${id}`, dischargeType: "unknown",
  });

  const accepted = [
    pipeline.accept(event("inside-1", 32.85, 39.92, now - 3 * 60_000), now),
    pipeline.accept(event("inside-2", 32.851, 39.921, now - 2 * 60_000), now),
    pipeline.accept(event("inside-3", 32.852, 39.922, now - 60_000), now),
  ];
  const outsidePolygon = pipeline.accept(event("outside-polygon", 33.8, 39.7), now);
  const staleInside = pipeline.accept(event("stale-inside", 32.85, 39.92, now - 11 * 60_000), now);
  const outsideBox = pipeline.accept(event("outside-box", 35, 39.5), now);

  for (const result of accepted) {
    if (!result.clusterId) continue;
    const eventTimeMs = now;
    lifecycle.observe({ sourceClusterId: result.clusterId, eventTimeMs, receivedAtMs: now,
      latitude: 39.92, longitude: 32.85 });
  }
  assert.ok(accepted.every(result => result.clusterId === "c-000001"));
  assert.equal(outsidePolygon.clusterId, undefined);
  assert.equal(staleInside.clusterId, undefined);
  assert.equal(outsideBox.clusterId, undefined);
  assert.equal(pipeline.counters.insideSubscriptionBox, 5);
  assert.equal(pipeline.counters.insideMonitoringArea, 4);
  assert.equal(pipeline.counters.insideSubscriptionBoxOutsideMonitoringArea, 1);
  assert.equal(pipeline.counters.insideMonitoringAreaFresh, 3);
  assert.equal(pipeline.counters.insideMonitoringAreaStale, 1);
  assert.equal(pipeline.counters.insideMonitoringAreaFuture, 0);
  assert.equal(pipeline.counters.insideMonitoringArea,
    pipeline.counters.insideMonitoringAreaFresh + pipeline.counters.insideMonitoringAreaStale + pipeline.counters.insideMonitoringAreaFuture);
  assert.equal(pipeline.comparisonEvents.length, 4);
  assert.equal(pipeline.clusterer.clusters.length, 1);
  assert.equal(pipeline.clusterer.clusters[0].eventCount, 3);
  assert.equal(lifecycle.snapshot().metrics.clustersObserved, 1);
  assert.equal(lifecycle.snapshot().activeIncidents, 1);
  assert.equal(lifecycle.snapshot().incidents[0].totalEvents, 3);
});
