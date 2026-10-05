import test from "node:test";
import assert from "node:assert/strict";
import { median } from "./stats.ts";

test("median returns null for an empty sample", () => {
  assert.equal(median([]), null);
});

test("median returns the only value in a one-item sample", () => {
  assert.equal(median([7]), 7);
});

test("median selects the middle value for an odd sample", () => {
  assert.equal(median([1, 3, 5]), 3);
});

test("median averages the two middle values for an even sample", () => {
  assert.equal(median([1, 3, 5, 7]), 4);
});

test("median sorts a copy and does not mutate unsorted input", () => {
  const values = [9, 1, 5, 3];
  assert.equal(median(values), 4);
  assert.deepEqual(values, [9, 1, 5, 3]);
});
