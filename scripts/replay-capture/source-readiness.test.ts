import assert from "node:assert/strict";
import { test } from "node:test";
import { CaptureSourceReadiness } from "./source-readiness.ts";

test("a new connection cannot inherit readiness from the previous decoded frame", () => {
  const readiness = new CaptureSourceReadiness();
  readiness.beginConnection();
  readiness.validEvent(1_000);
  assert.equal(readiness.isReady(true, 2_000, 90_000), true);
  readiness.beginConnection();
  assert.equal(readiness.isReady(true, 2_000, 90_000), false);
  readiness.validEvent(2_100);
  assert.equal(readiness.isReady(true, 2_100, 90_000), true);
  assert.equal(readiness.isReady(false, 2_100, 90_000), false);
  assert.equal(readiness.isReady(true, 92_100, 90_000), false);
});
