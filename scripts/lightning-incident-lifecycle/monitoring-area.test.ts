import test from "node:test";
import assert from "node:assert/strict";
import { ANKARA_MONITORING_AREA, ANKARA_MONITORING_POLYGON, boundingBoxForPolygon,
  pointInMonitoringArea, pointInPolygon } from "./monitoring-area.ts";

test("Ankara-centered operational polygon keeps the intended Ankara places inside", () => {
  const inside = [
    [32.8541, 39.9208], // Ankara city center
    [32.8628, 39.8897], // Çankaya / central Ankara
    [32.809, 39.79], // Gölbaşı
    [32.147, 39.584], // Polatlı
    [32.497, 39.432], // Haymana
    [33.123, 39.553], // Bala
    [33.538, 38.939], // Şereflikoçhisar
    [31.921, 40.167], // Beypazarı
  ] as const;
  for (const point of inside) assert.equal(pointInMonitoringArea(point), true, `${point} should be inside`);
});

test("Ankara operational polygon rejects Kulu-area incidents and points south of coverage", () => {
  const outside = [
    [33.08, 39.09], // Kulu center
    [33.17, 38.94], // Zincirlikuyu / Kulu incident area
    [32.965, 39.178], // Approximate Altılar / Kulu CG coordinate
    [33.5, 38.3], // Clearly south toward Konya / Aksaray
  ] as const;
  for (const point of outside) assert.equal(pointInMonitoringArea(point), false, `${point} should be outside`);
});

test("polygon is a valid finite, explicitly closed ring and edge points are treated as inside", () => {
  assert.deepEqual(ANKARA_MONITORING_POLYGON[0], ANKARA_MONITORING_POLYGON.at(-1));
  assert.ok(ANKARA_MONITORING_POLYGON.length >= 4);
  assert.ok(ANKARA_MONITORING_POLYGON.every(([longitude, latitude]) =>
    Number.isFinite(longitude) && Number.isFinite(latitude) &&
    longitude >= -180 && longitude <= 180 && latitude >= -90 && latitude <= 90));
  assert.equal(pointInMonitoringArea(ANKARA_MONITORING_POLYGON[0]), true);
  const [a, b] = [ANKARA_MONITORING_POLYGON[0], ANKARA_MONITORING_POLYGON[1]];
  const midpoint = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] as const;
  assert.equal(pointInPolygon(midpoint, ANKARA_MONITORING_POLYGON), true);
});

test("derived subscription bounds contain every exact polygon coordinate", () => {
  const box = boundingBoxForPolygon(ANKARA_MONITORING_POLYGON);
  assert.deepEqual(box, { north: 40.7462082, east: 33.8704696, south: 38.6905209, west: 30.8564432 });
  for (const [longitude, latitude] of ANKARA_MONITORING_AREA.polygon) {
    assert.ok(latitude <= box.north && latitude >= box.south);
    assert.ok(longitude <= box.east && longitude >= box.west);
  }
});
