import assert from "node:assert/strict";
import test from "node:test";
import { EMPTY_PROVIDER_DIAGNOSTICS, type LiveLightningApiResult } from "./lightning/types.ts";
import { currentSeverity, isCurrentLiveRequest, liveActivityCopy, liveSeverity } from "./live-observation.ts";

function observed(nearestKm: number | null, totalEvents = nearestKm === null ? 0 : 1): LiveLightningApiResult {
  return { ok: true, summary: {
    status: "live", provider: "xweather", fetchedAt: 0, latestEventAt: null,
    observationWindowMinutes: 5, nearestKm, nearestAgeMinutes: null,
    counts: { within5Km: 0, within10Km: 0, within25Km: 0, within50Km: totalEvents },
    totalEvents, rejectedEventCount: 0, mayBeTruncated: false,
    diagnostics: EMPTY_PROVIDER_DIAGNOSTICS,
  } };
}

test("live display severity uses inclusive 10/25/50 km boundaries", () => {
  assert.equal(liveSeverity(observed(0)), "high");
  assert.equal(liveSeverity(observed(10)), "high");
  assert.equal(liveSeverity(observed(10.001)), "elevated");
  assert.equal(liveSeverity(observed(25)), "elevated");
  assert.equal(liveSeverity(observed(25.001)), "nearby");
  assert.equal(liveSeverity(observed(50)), "nearby");
  assert.equal(liveSeverity(observed(null)), "none");
  assert.equal(liveSeverity(observed(null, 1)), null);
});

test("current picture selects strongest evidence without changing either source", () => {
  assert.equal(currentSeverity("low", "none"), "low");
  assert.equal(currentSeverity("low", liveSeverity(observed(18))), "elevated");
  assert.equal(currentSeverity("low", liveSeverity(observed(4))), "high");
  assert.equal(currentSeverity("high", "none"), "high");
  assert.equal(currentSeverity("elevated", liveSeverity(observed(40))), "elevated");
  assert.equal(currentSeverity(null, "nearby"), "nearby");
  assert.equal(currentSeverity(null, "none"), null);
});

test("failed live data stays unknown and cannot lower the forecast", () => {
  const failure: LiveLightningApiResult = { ok: false, status: "provider-unavailable", message: "Unavailable", diagnostics: EMPTY_PROVIDER_DIAGNOSTICS };
  assert.equal(liveSeverity(failure), null);
  assert.equal(liveSeverity(null), null);
  assert.equal(currentSeverity("low", liveSeverity(failure)), "low");
  assert.equal(currentSeverity("high", liveSeverity(failure)), "high");
});

test("healthy zero copy describes a detected window without claiming safety", () => {
  const result = observed(null);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(liveActivityCopy(result.summary), "No recent lightning activity detected within 50 km.");
    assert.equal(result.summary.observationWindowMinutes, 5);
  }
});

test("obsolete and aborted requests cannot own a changed location", () => {
  const controller = new AbortController();
  assert.equal(isCurrentLiveRequest(1, 1, "52,-7", "52,-7", controller.signal), true);
  assert.equal(isCurrentLiveRequest(1, 2, "52,-7", "52,-7", controller.signal), false);
  assert.equal(isCurrentLiveRequest(1, 1, "52,-7", "43,3", controller.signal), false);
  controller.abort();
  assert.equal(isCurrentLiveRequest(1, 1, "52,-7", "52,-7", controller.signal), false);
});
