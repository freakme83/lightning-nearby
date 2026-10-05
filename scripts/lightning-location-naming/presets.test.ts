import assert from "node:assert/strict";
import test from "node:test";
import { ANKARA_MONITORING_AREA, pointInMonitoringArea } from "../lightning-incident-lifecycle/monitoring-area.ts";
import { getLocationResearchPreset, LOCATION_RESEARCH_PRESETS } from "./presets.ts";

test("research presets have stable representative coordinates for all requested areas", () => {
  assert.deepEqual(
    ["ankara-center", "ayranci", "bahcelievler", "eryaman", "polatli", "haymana", "sereflikochisar", "kirikkale", "keskin", "rural-ankara"].map((id) => {
      const { latitude, longitude } = getLocationResearchPreset(id);
      return [latitude, longitude];
    }),
    [
      [39.919874, 32.854271], [39.902861, 32.849819], [39.92781, 32.82649], [39.9723, 32.62128],
      [39.577155, 32.141317], [39.43414, 32.49879], [38.93925, 33.538599], [39.845278, 33.506389],
      [39.673056, 33.613611], [39.583333, 33.15],
    ],
  );
  const rural = getLocationResearchPreset("rural-ankara");
  assert.equal(pointInMonitoringArea([rural.longitude, rural.latitude], ANKARA_MONITORING_AREA), true);
  for (const preset of Object.values(LOCATION_RESEARCH_PRESETS)) assert.ok(preset.coordinateSource.startsWith("https://"));
});

test("unknown preset fails clearly", () => {
  assert.throws(() => getLocationResearchPreset("unknown"), /Unknown location research preset/);
});

