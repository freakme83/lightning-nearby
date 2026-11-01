import assert from "node:assert/strict";
import { test } from "node:test";
import { CAPTURE_SIDES_KM, insideCaptureSquare, validateCaptureSettings } from "./geometry.ts";

const R = 6371.0088;
test("all four square sizes have north and east boundaries at half the side", () => {
  for (const side of CAPTURE_SIDES_KM) {
    for (const latitude of [0, 40, 65]) {
      const area = validateCaptureSettings(latitude, 32, side, 5);
      const north = latitude + (side / 2 / R) * 180 / Math.PI;
      const eastLat = Math.asin(Math.sin(latitude * Math.PI / 180) * Math.cos(side / 2 / R)) * 180 / Math.PI;
      const east = 32 + Math.atan2(Math.sin(side / 2 / R),
        Math.cos(latitude * Math.PI / 180) * Math.cos(side / 2 / R)) * 180 / Math.PI;
      assert.equal(insideCaptureSquare(area, north, 32), true);
      assert.equal(insideCaptureSquare(area, north + 0.001, 32), false);
      assert.equal(insideCaptureSquare(area, eastLat, east), true);
      assert.equal(insideCaptureSquare(area, eastLat, east + 0.001), false);
    }
  }
  assert.equal(insideCaptureSquare(validateCaptureSettings(0, 179.9, 100, 10), 0, -179.9), true);
});

test("invalid coordinates, unsupported side/duration, and polar centers are rejected", () => {
  for (const item of [[91,0,100,10],[76,0,100,10],[0,181,100,10],[0,0,75,10],[0,0,100,7]]) {
    assert.throws(() => validateCaptureSettings(...item as [number,number,number,number]));
  }
  assert.equal(insideCaptureSquare(validateCaptureSettings(0,0,25,5), Number.NaN, 0), false);
});
