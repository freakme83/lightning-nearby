import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_PROXIMITY_SCALE, proximityColor, proximityPoint, proximityScale } from "./proximity.ts";

test("adaptive range selects the requested rings at every boundary", () => {
  assert.deepEqual(proximityScale(0), { outerKm: 10, ringsKm: [2.5, 5, 10] });
  assert.deepEqual(proximityScale(5), { outerKm: 10, ringsKm: [2.5, 5, 10] });
  assert.deepEqual(proximityScale(5.01), { outerKm: 15, ringsKm: [5, 10, 15] });
  assert.deepEqual(proximityScale(10), { outerKm: 15, ringsKm: [5, 10, 15] });
  assert.deepEqual(proximityScale(10.01), { outerKm: 25, ringsKm: [10, 15, 25] });
  assert.deepEqual(proximityScale(25), { outerKm: 25, ringsKm: [10, 15, 25] });
  assert.deepEqual(proximityScale(25.01), DEFAULT_PROXIMITY_SCALE);
  assert.deepEqual(proximityScale(40), DEFAULT_PROXIMITY_SCALE);
});

test("marker color follows its separate distance bands", () => {
  assert.equal(proximityColor(10), "red");
  assert.equal(proximityColor(10.01), "amber");
  assert.equal(proximityColor(25), "amber");
  assert.equal(proximityColor(25.01), "green");
  assert.equal(proximityColor(40), "green");
});

test("marker placement preserves direction and proportional distance on selected scale", () => {
  assert.deepEqual(proximityPoint(40, "N"), { x: 50, y: 8 });
  const west = proximityPoint(5, "W", 10)!;
  assert.ok(west.x < 50 && Math.abs(west.y - 50) < 1e-10);
  assert.ok(Math.abs(Math.hypot(west.x - 50, west.y - 50) - 5 / 10 * 42) < 1e-10);
  const southeast = proximityPoint(12, "SE", 25)!;
  assert.ok(southeast.x > 50 && southeast.y > 50);
  assert.ok(Math.abs(Math.hypot(southeast.x - 50, southeast.y - 50) - 12 / 25 * 42) < 1e-10);
  assert.equal(proximityPoint(Number.NaN, "S"), null);
  assert.equal(proximityPoint(-1, "S"), null);
  assert.equal(proximityPoint(1, "S", 0), null);
});
