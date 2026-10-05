import assert from "node:assert/strict";
import { test } from "node:test";
import { overlap } from "./compare-core.ts";
import { ANKARA_BOX, EXTREMADURA_ACTIVE_BOX, subscription } from "./core.ts";

test("geographic comparison changes only the p subscription field", () => {
  const active = JSON.parse(subscription(EXTREMADURA_ACTIVE_BOX));
  const control = JSON.parse(subscription(ANKARA_BOX));
  assert.deepEqual(active.p, [39.8, -5.8, 38.3, -7.6]);
  assert.deepEqual(control.p, [40.35, 33.45, 39.45, 31.95]);
  delete active.p;
  delete control.p;
  assert.deepEqual(active, control);
});

test("overlap has explicit denominators and handles empty sets", () => {
  assert.deepEqual(overlap(new Set(["2/1", "2/2"]), new Set(["2/2", "2/3"])), {
    shared: 1, leftOnly: 1, rightOnly: 1, union: 3,
    overlapPctOfUnion: 100 / 3, sharedPctOfLeft: 50, sharedPctOfRight: 50,
  });
  assert.deepEqual(overlap(new Set(), new Set()), {
    shared: 0, leftOnly: 0, rightOnly: 0, union: 0,
    overlapPctOfUnion: null, sharedPctOfLeft: null, sharedPctOfRight: null,
  });
});
