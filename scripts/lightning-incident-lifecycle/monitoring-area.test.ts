import test from "node:test";
import assert from "node:assert/strict";
import { ANKARA_MONITORING_AREA, ANKARA_MONITORING_POLYGON, boundingBoxForPolygon,
  pointInMonitoringArea, pointInPolygon } from "./monitoring-area.ts";

test("Ankara operational polygon contains broad local examples and Kırıkkale-side coverage", () => {
  assert.equal(pointInMonitoringArea([32.85, 39.92]), true); // Ankara city center
  assert.equal(pointInMonitoringArea([33.515, 39.846]), true); // Kırıkkale-side operational coverage
  assert.equal(pointInMonitoringArea([32.2, 39.4]), true);
  assert.equal(pointInMonitoringArea([35, 39.5]), false);
  assert.equal(pointInMonitoringArea([29.5, 41]), false);
});

test("polygon vertices and exact edge points are treated as inside", () => {
  assert.equal(pointInMonitoringArea(ANKARA_MONITORING_POLYGON[0]), true);
  const [a, b] = [ANKARA_MONITORING_POLYGON[0], ANKARA_MONITORING_POLYGON[1]];
  const midpoint = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] as const;
  assert.equal(pointInPolygon(midpoint, ANKARA_MONITORING_POLYGON), true);
});

test("derived subscription bounds contain every exact polygon coordinate", () => {
  const box = boundingBoxForPolygon(ANKARA_MONITORING_POLYGON);
  assert.deepEqual(box, { north: 40.792556, east: 33.9332503, south: 38.6575458, west: 30.7733215 });
  for (const [longitude, latitude] of ANKARA_MONITORING_AREA.polygon) {
    assert.ok(latitude <= box.north && latitude >= box.south);
    assert.ok(longitude <= box.east && longitude >= box.west);
  }
});
