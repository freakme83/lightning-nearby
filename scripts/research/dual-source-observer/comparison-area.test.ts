import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_COMPARISON_RADIUS_KM,
  comparisonAreaMetadata,
  isInsideComparisonArea,
  isInsideCustomRadius,
  parseObserverArgs,
} from "./comparison-area.ts";

test("no custom arguments preserve Ankara comparison membership and metadata", () => {
  const options = parseObserverArgs([]);
  assert.deepEqual(options, { comparisonArea: { mode: "ankara" }, durationMinutes: null });
  assert.equal(isInsideComparisonArea(options.comparisonArea, 0, 0, true), true);
  assert.equal(isInsideComparisonArea(options.comparisonArea, 0, 0, false), false);
  assert.deepEqual(comparisonAreaMetadata(options.comparisonArea), { comparisonAreaMode: "ankara" });
});

test("custom radius admits in-radius coordinates and rejects outside coordinates", () => {
  const area = parseObserverArgs(["--center-lat=41.45", "--center-lon=-81.70", "--radius-km=80"]).comparisonArea;
  assert.equal(area.mode, "custom-radius");
  if (area.mode !== "custom-radius") return;
  assert.equal(isInsideCustomRadius(41.45, -81.70, area), true);
  assert.equal(isInsideCustomRadius(42.5, -81.70, area), false);
  assert.deepEqual(comparisonAreaMetadata(area), {
    comparisonAreaMode: "custom-radius", comparisonCenterLat: 41.45,
    comparisonCenterLon: -81.7, comparisonRadiusKm: 80,
  });
});

test("partial, malformed, and out-of-range custom area arguments fail", () => {
  for (const args of [
    ["--center-lat=41"], ["--center-lat=41", "--center-lon=2"],
    ["--center-lat=91", "--center-lon=2", "--radius-km=20"],
    ["--center-lat=41", "--center-lon=181", "--radius-km=20"],
    ["--center-lat=41", "--center-lon=2", "--radius-km=0"],
    ["--center-lat=41", "--center-lon=2", "--radius-km=-1"],
    ["--center-lat=41", "--center-lon=2", `--radius-km=${MAX_COMPARISON_RADIUS_KM + 1}`],
  ]) assert.throws(() => parseObserverArgs(args));
});

test("duration is optional but bounded to whole minutes from one through sixty", () => {
  assert.equal(parseObserverArgs(["--duration=30"]).durationMinutes, 30);
  for (const duration of ["0", "-1", "1.5", "61"]) {
    assert.throws(() => parseObserverArgs([`--duration=${duration}`]));
  }
});
