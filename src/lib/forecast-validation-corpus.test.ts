import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const corpus = JSON.parse(readFileSync(
  new URL("../../research/forecast-validation/cases.json", import.meta.url), "utf8",
));
const expectedIds = [
  "saint-gilles-2026-10-07-low-false-negative",
  "villahermosa-2026-10-07-elevated-true-positive-zero-ensemble",
  "dosemealti-2026-10-08-spatial-false-low",
  "ponza-2026-10-08-canonical-high-true-positive",
];

test("manual forecast corpus has unique expected cases and valid evidence fields", () => {
  assert.equal(corpus.corpusKind, "manual_forecast_validation");
  const ids = corpus.cases.map((item: { id: string }) => item.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual(ids, expectedIds);

  for (const item of corpus.cases) {
    assert.ok(Number.isFinite(item.coordinates.latitude));
    assert.ok(item.coordinates.latitude >= -90 && item.coordinates.latitude <= 90);
    assert.ok(Number.isFinite(item.coordinates.longitude));
    assert.ok(item.coordinates.longitude >= -180 && item.coordinates.longitude <= 180);
    assert.ok(["low", "elevated", "high"].includes(item.deterministic.qualitativeRisk));
    assert.ok(item.deterministic.thunderstormProbabilityPercent === null
      || (item.deterministic.thunderstormProbabilityPercent >= 0
        && item.deterministic.thunderstormProbabilityPercent <= 100));
    assert.ok(item.ensemble.supportingMembers >= 0);
    assert.ok(item.ensemble.availableMembers > 0);
    assert.ok(item.ensemble.supportingMembers <= item.ensemble.availableMembers);
    assert.ok(!Object.keys(item.ensemble).some((key: string) => /probability/i.test(key)));
    assert.equal(item.deterministic.evidenceType, "app_debug_snapshot");
    assert.ok(Array.isArray(item.observations) && item.observations.length > 0);
    assert.ok(item.observations.every((observation: { evidenceType: string }) =>
      ["app_live_observation", "manual_blitzortung_check", "manual_windy_ecmwf_check", "user_observed_activity"]
        .includes(observation.evidenceType)));
  }
});
