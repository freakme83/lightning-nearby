import test from "node:test";
import assert from "node:assert/strict";
import { ANKARA_MONITORING_AREA } from "./monitoring-area.ts";
import { readIncidentRunnerOptions } from "./options.ts";

test("--area=ankara resolves the operational polygon and its derived subscription box", () => {
  const options = readIncidentRunnerOptions(["--area=ankara"]);
  assert.equal(options.areaSelection, "ankara");
  assert.equal(options.monitoringArea, ANKARA_MONITORING_AREA);
  assert.deepEqual(options.box, ANKARA_MONITORING_AREA.bounds);
});

test("--box retains arbitrary custom research boxes", () => {
  const options = readIncidentRunnerOptions(["--box=40.05,-2.05,38.55,-3.85"]);
  assert.equal(options.areaSelection, "custom");
  assert.equal(options.monitoringArea, undefined);
  assert.deepEqual(options.box, { north: 40.05, east: -2.05, south: 38.55, west: -3.85 });
});

test("--area and --box together fail with an ambiguity error", () => {
  assert.throws(() => readIncidentRunnerOptions(["--area=ankara", "--box=40,-2,38,-4"]), /cannot be supplied together/);
});
