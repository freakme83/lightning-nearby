import assert from "node:assert/strict";
import test from "node:test";
import { proximityPoint } from "./proximity.ts";

test("proximity schematic maps distance radially and compass direction angularly", () => {
  assert.deepEqual(proximityPoint(0, "N"), { x: 50, y: 50 });
  assert.deepEqual(proximityPoint(40, "N"), { x: 50, y: 8 });
  assert.deepEqual(proximityPoint(40, "E"), { x: 92, y: 50 });
  const southeast = proximityPoint(12, "SE")!;
  assert.ok(southeast.x > 50 && southeast.y > 50);
  assert.ok(Math.abs(Math.hypot(southeast.x - 50, southeast.y - 50) - 12 / 40 * 42) < 1e-10);
});

test("proximity schematic rejects invalid distance and caps provider-edge values", () => {
  assert.equal(proximityPoint(Number.NaN, "S"), null);
  assert.equal(proximityPoint(-1, "S"), null);
  assert.deepEqual(proximityPoint(45, "S"), { x: 50, y: 92 });
});
