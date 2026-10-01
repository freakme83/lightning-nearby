import assert from "node:assert/strict";
import test from "node:test";
import { EMPTY_PROVIDER_DIAGNOSTICS, type LiveLightningApiResult } from "./lightning/types.ts";
import { currentSeverity, isCurrentLiveRequest, liveActivityCopy, liveSeverity, liveSeverityLabel } from "./live-observation.ts";

function observed(nearestKm: number | null, status: "not-requested" | "clear" | "active" = nearestKm === null ? "clear" : "active"): LiveLightningApiResult {
  if (status === "not-requested") {
    return { ok: true, summary: {
      status: "live", provider: "xweather", fetchedAt: 0,
      recentArea: { status: "clear", windowMinutes: 30, radiusKm: 50, totalDetections: 0, oldestEventAt: null, newestEventAt: null, diagnostics: EMPTY_PROVIDER_DIAGNOSTICS },
      current: { status, windowMinutes: 5, radiusKm: 40 },
    } };
  }
  return { ok: true, summary: {
    status: "live", provider: "xweather", fetchedAt: 0,
    recentArea: { status: "active", windowMinutes: 30, radiusKm: 50, totalDetections: 4, oldestEventAt: null, newestEventAt: null, diagnostics: EMPTY_PROVIDER_DIAGNOSTICS },
    current: {
      status, windowMinutes: 5, radiusKm: 40, latestEventAt: null, nearestKm, nearestDirection: null, nearestAgeMinutes: null,
      counts: { within5Km: 0, within10Km: 0, within25Km: 0, within40Km: status === "active" ? 1 : 0 },
      totalFlashes: status === "active" ? 1 : 0, rejectedEventCount: 0, mayBeTruncated: false, diagnostics: EMPTY_PROVIDER_DIAGNOSTICS,
    },
  } };
}

test("live display severity uses inclusive 10/25/40 km Flash boundaries", () => {
  assert.equal(liveSeverity(observed(0)), "high");
  assert.equal(liveSeverity(observed(10)), "high");
  assert.equal(liveSeverity(observed(10.001)), "elevated");
  assert.equal(liveSeverity(observed(25)), "elevated");
  assert.equal(liveSeverity(observed(25.001)), "nearby");
  assert.equal(liveSeverity(observed(40)), "nearby");
  assert.equal(liveSeverity(observed(null)), "none");
  assert.equal(liveSeverity(observed(null, "not-requested")), "none");
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

test("live severity badge labels use the live result even when forecast severity is higher", () => {
  const live = liveSeverity(observed(25));
  assert.equal(currentSeverity("high", live), "high");
  assert.equal(liveSeverityLabel(live), "Elevated");
  assert.equal(liveSeverityLabel("high"), "High");
  assert.equal(liveSeverityLabel("nearby"), "Nearby activity");
  assert.equal(liveSeverityLabel("none"), null);
  assert.equal(liveSeverityLabel(null), null);
});

test("failed live data stays unknown and cannot lower the forecast", () => {
  const failure: LiveLightningApiResult = { ok: false, status: "provider-unavailable", message: "Unavailable", diagnostics: EMPTY_PROVIDER_DIAGNOSTICS };
  assert.equal(liveSeverity(failure), null);
  assert.equal(liveSeverity(null), null);
  assert.equal(currentSeverity("low", liveSeverity(failure)), "low");
  assert.equal(currentSeverity("high", liveSeverity(failure)), "high");
});

test("healthy zero copy describes a detected window without claiming safety", () => {
  const result = observed(null, "not-requested");
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(liveActivityCopy(result.summary), "No recent lightning detections reported within 50 km in the last 30 minutes.");
    assert.equal(result.summary.recentArea.windowMinutes, 30);
  }
});

test("recent regional activity without current Flash stays non-severe and has distinct copy", () => {
  const result = observed(null, "clear");
  assert.equal(liveSeverity(result), "none");
  if (result.ok) assert.match(liveActivityCopy(result.summary), /last 30 minutes.*no current flashes/i);
});

test("partial current-provider failure is unknown rather than clear", () => {
  const result: LiveLightningApiResult = { ok: true, summary: {
    status: "live", provider: "xweather", fetchedAt: 0,
    recentArea: { status: "active", windowMinutes: 30, radiusKm: 50, totalDetections: 3, oldestEventAt: null, newestEventAt: null, diagnostics: EMPTY_PROVIDER_DIAGNOSTICS },
    current: { status: "unavailable", windowMinutes: 5, radiusKm: 40, failureStatus: "provider-unavailable", message: "Unavailable", diagnostics: EMPTY_PROVIDER_DIAGNOSTICS },
  } };
  assert.equal(liveSeverity(result), null);
  assert.match(liveActivityCopy(result.summary), /current nearby activity is unavailable/i);
});

test("obsolete and aborted requests cannot own a changed location", () => {
  const controller = new AbortController();
  assert.equal(isCurrentLiveRequest(1, 1, "52,-7", "52,-7", controller.signal), true);
  assert.equal(isCurrentLiveRequest(1, 2, "52,-7", "52,-7", controller.signal), false);
  assert.equal(isCurrentLiveRequest(1, 1, "52,-7", "43,3", controller.signal), false);
  controller.abort();
  assert.equal(isCurrentLiveRequest(1, 1, "52,-7", "52,-7", controller.signal), false);
});
