import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { activityMapData } from "./live-activity.ts";
import { EMPTY_PROVIDER_DIAGNOSTICS, type LiveLightningApiResult } from "./lightning/types.ts";
import type { BlitzExperimentalResult } from "./lightning/blitz-experimental.ts";
import { canStartLiveSourceRequest, developerLiveMode, DEVELOPER_LIVE_SOURCE_STORAGE_KEY, isCurrentSourceRequest, livePresentationSeverity, liveSourceEndpoint, normalizeBlitzPresentation, normalizeXweatherPresentation, ownsLiveRequestController, parseStoredLiveSource, shouldRunInitialLiveSourceCheck, type LiveLightningSource } from "./live-lightning-presentation.ts";

const event = { observedAtMs: 1_790_000_000_000, latitude: 39.93, longitude: 32.85, type: "unknown" as const };
function blitz(status: "active" | "clear" | "unknown", events = status === "active" ? [event] : [], recentStatus: "active" | "clear" | "unknown" = "clear"): BlitzExperimentalResult {
  return { ok: true, summary: {
    status: "live", provider: "blitzortung-experimental", fetchedAt: event.observedAtMs,
    recent: { status: recentStatus, windowMinutes: 15, radiusKm: 50, totalDetections: recentStatus === "active" ? 1 : 0,
      oldestEventAt: recentStatus === "active" ? event.observedAtMs : null, newestEventAt: recentStatus === "active" ? event.observedAtMs : null,
      coverage: { complete: recentStatus === "clear", usable: true, requestedWindowMinutes: 15, coverageStartMs: 1, toleratedGapMs: recentStatus === "clear" ? 0 : 12_000 } },
    current: { status, windowMinutes: 5, radiusKm: 40, events, latestEventAt: events[0]?.observedAtMs ?? null,
      nearestKm: events.length ? 8 : null, nearestDirection: events.length ? "E" : null,
      nearestAgeMinutes: events.length ? 1 : null, counts: { within5Km: 0, within10Km: events.length, within25Km: events.length, within40Km: events.length },
      totalDetections: events.length, coverage: { complete: status !== "unknown", usable: status !== "unknown",
        requestedWindowMinutes: 5, coverageStartMs: 1, toleratedGapMs: 0 } },
  } };
}

function xweather(): LiveLightningApiResult {
  return { ok: true, summary: { status: "live", provider: "xweather", fetchedAt: 0,
    recentArea: { status: "active", windowMinutes: 30, radiusKm: 50, totalDetections: 2,
      oldestEventAt: 0, newestEventAt: 0, diagnostics: EMPTY_PROVIDER_DIAGNOSTICS },
    current: { status: "active", windowMinutes: 5, radiusKm: 40, events: [event], latestEventAt: event.observedAtMs,
      nearestKm: 8, nearestDirection: "E", nearestAgeMinutes: 1,
      counts: { within5Km: 0, within10Km: 1, within25Km: 1, within40Km: 1 }, totalFlashes: 1,
      rejectedEventCount: 0, mayBeTruncated: false, diagnostics: EMPTY_PROVIDER_DIAGNOSTICS },
  } };
}

test("normal source defaults to Xweather route; dev gate is exact and hostname-scoped", () => {
  const source: LiveLightningSource = "xweather";
  assert.equal(source, "xweather");
  assert.equal(liveSourceEndpoint(source), "/api/lightning/live");
  assert.equal(liveSourceEndpoint("blitz-experimental"), "/api/lightning/blitz-experimental");
  assert.equal(developerLiveMode("", "lightning-nearby.netlify.app"), false);
  assert.equal(developerLiveMode("?lightningDev=0", "lightning-nearby.netlify.app"), false);
  assert.equal(developerLiveMode("?lightningDev=true", "lightning-nearby.netlify.app"), false);
  assert.equal(developerLiveMode("?lightningDev=1", "lightning-nearby.netlify.app"), true);
  assert.equal(developerLiveMode("", "merge-ready--lightning-nearby.netlify.app"), true);
  assert.equal(developerLiveMode("", "other-branch--lightning-nearby.netlify.app"), false);
  assert.equal(developerLiveMode("", "lightning-nearby.netlify.app.evil.test"), false);
  assert.equal(DEVELOPER_LIVE_SOURCE_STORAGE_KEY, "lightning-nearby:developer-live-source");
});

test("stored developer source accepts only the two supported values", () => {
  assert.equal(parseStoredLiveSource("xweather"), "xweather");
  assert.equal(parseStoredLiveSource("blitz-experimental"), "blitz-experimental");
  assert.equal(parseStoredLiveSource(null), null);
  assert.equal(parseStoredLiveSource("Blitz"), null);
  assert.equal(parseStoredLiveSource("unknown"), null);
  assert.equal(parseStoredLiveSource(""), null);
});

test("initial auto-check waits for hydration and only runs for selected Xweather", () => {
  assert.equal(shouldRunInitialLiveSourceCheck(true, false, false, "xweather"), false);
  assert.equal(shouldRunInitialLiveSourceCheck(true, true, false, "xweather"), false);
  assert.equal(shouldRunInitialLiveSourceCheck(true, true, true, "blitz-experimental"), false);
  assert.equal(shouldRunInitialLiveSourceCheck(true, true, true, "xweather"), true);
  assert.equal(shouldRunInitialLiveSourceCheck(false, true, true, "xweather"), false);
});

test("Xweather presentation preserves its current event view and 30-minute recent context", () => {
  const presentation = normalizeXweatherPresentation(xweather());
  assert.equal(presentation.source, "xweather");
  assert.equal(presentation.status, "active");
  assert.equal(presentation.currentWindowMinutes, 5);
  assert.equal(presentation.currentRadiusKm, 40);
  assert.equal(presentation.recentWindowMinutes, 30);
  assert.equal(presentation.recentDetections, 2);
  assert.equal(livePresentationSeverity(presentation), "high");
  assert.deepEqual(presentation.events[0], event);
});

test("Blitz active preserves unknown map type and normalizes distance/count presentation", () => {
  const presentation = normalizeBlitzPresentation(blitz("active"));
  assert.equal(presentation.source, "blitz-experimental");
  assert.equal(presentation.status, "active");
  assert.equal(presentation.recentWindowMinutes, 15);
  assert.equal(presentation.currentWindowMinutes, 5);
  assert.equal(presentation.events[0].type, "unknown");
  assert.equal(presentation.counts.within10Km, 1);
  assert.equal(livePresentationSeverity(presentation), "high");
  assert.equal(activityMapData(presentation, 39.92, 32.85)?.events.length, 1);
});

test("Blitz clear stays clear; empty incomplete coverage stays unknown, not clear", () => {
  const clear = normalizeBlitzPresentation(blitz("clear", [], "clear"));
  const unknown = normalizeBlitzPresentation(blitz("unknown", [], "unknown"));
  assert.equal(clear.status, "clear");
  assert.equal(livePresentationSeverity(clear), "none");
  assert.equal(unknown.status, "unknown");
  assert.equal(livePresentationSeverity(unknown), null);
  assert.equal(activityMapData(unknown, 0, 0), null);
});

test("source switch invalidates pending requests from either provider", () => {
  const signal = new AbortController().signal;
  assert.equal(isCurrentSourceRequest(1, 1, "xweather", "blitz-experimental", "1,2", "1,2", signal), false);
  assert.equal(isCurrentSourceRequest(1, 1, "blitz-experimental", "xweather", "1,2", "1,2", signal), false);
  assert.equal(isCurrentSourceRequest(1, 1, "xweather", "xweather", "1,2", "1,2", signal), true);
  const aborted = new AbortController(); aborted.abort();
  assert.equal(isCurrentSourceRequest(1, 1, "xweather", "xweather", "1,2", "1,2", aborted.signal), false);
});

test("explicit automatic source can only start while it remains selected", () => {
  assert.equal(canStartLiveSourceRequest("xweather", "blitz-experimental"), false);
  assert.equal(canStartLiveSourceRequest("blitz-experimental", "xweather"), false);
  assert.equal(canStartLiveSourceRequest("xweather", "xweather"), true);
  assert.equal(canStartLiveSourceRequest(undefined, "xweather"), true);
  assert.equal(canStartLiveSourceRequest(undefined, "blitz-experimental"), true);
});

test("controller cleanup ownership cannot match an older request after replacement", () => {
  const oldRequest = new AbortController();
  const newRequest = new AbortController();
  assert.equal(ownsLiveRequestController(oldRequest, oldRequest), true);
  assert.equal(ownsLiveRequestController(newRequest, oldRequest), false);
  assert.equal(ownsLiveRequestController(newRequest, newRequest), true);
});

test("LiveObservation guards explicit starts before side effects and cleans up by controller identity", () => {
  const component = readFileSync(new URL("../app/live-observation.tsx", import.meta.url), "utf8");
  const check = component.slice(component.indexOf("const checkActivity"), component.indexOf("const changeSource"));
  assert.match(check, /const checkActivity = useCallback\(async \(automaticSource\?: LiveLightningSource\) => \{\s*if \(!canStartLiveSourceRequest\(automaticSource, sourceRef\.current\)\) return;/);
  assert.ok(check.indexOf("canStartLiveSourceRequest") < check.indexOf("new AbortController()"));
  assert.ok(check.indexOf("canStartLiveSourceRequest") < check.indexOf("setLoading(true)"));
  assert.ok(check.indexOf("canStartLiveSourceRequest") < check.indexOf("setResult(null)"));
  assert.match(check, /finally \{\s*if \(ownsLiveRequestController\(controller\.current, active\)\) \{\s*controller\.current = null;\s*setLoading\(false\);/);
  assert.match(check, /if \(!isCurrent\(\)\) return;[\s\S]*setResult\(presentation\)/);
});

test("client selector is gated and client code has no observer credentials, host, or direct socket", () => {
  const component = readFileSync(new URL("../app/live-observation.tsx", import.meta.url), "utf8");
  const page = readFileSync(new URL("../app/page.tsx", import.meta.url), "utf8");
  const presentation = readFileSync(new URL("./live-lightning-presentation.ts", import.meta.url), "utf8");
  const client = `${component}\n${page}\n${presentation}`;
  assert.match(component, /developerMode\s*&&\s*sourcePreferenceReady\s*&&\s*<label className="developer-source"/);
  assert.match(page, /developerLiveMode\(window\.location\.search, window\.location\.hostname\)/);
  assert.match(page, /setDeveloperModeReady\(true\)/);
  const switchHandler = component.slice(component.indexOf("const changeSource"), component.indexOf("const severity"));
  assert.match(switchHandler, /sourceRef\.current = next[\s\S]*requestId\.current \+= 1[\s\S]*\.abort\(\)/);
  assert.match(switchHandler, /setResult\(null\)[\s\S]*setXweatherSummary\(null\)[\s\S]*setPlace\(null\)[\s\S]*setCheckedAt\(null\)/);
  assert.doesNotMatch(switchHandler, /checkActivity\(/);
  assert.match(switchHandler, /localStorage\.setItem\(DEVELOPER_LIVE_SOURCE_STORAGE_KEY, next\)/);
  assert.match(component, /restoredSource = parseStoredLiveSource\(localStorage\.getItem\(DEVELOPER_LIVE_SOURCE_STORAGE_KEY\)\) \?\? "xweather"/);
  assert.match(component, /const sourceChanged = restoredSource !== sourceRef\.current;\s*sourceRef\.current = restoredSource;/);
  assert.match(component, /if \(sourceChanged\) \{\s*setSource\(restoredSource\)/);
  assert.match(component, /shouldRunInitialLiveSourceCheck\(autoCheckEligible, developerModeReady, sourcePreferenceReady, sourceRef\.current\)/);
  assert.match(component, /developerMode && sourcePreferenceReady && <label className="developer-source"/);
  assert.match(component, /if \(developerMode\) \{\s*try \{ localStorage\.setItem\(DEVELOPER_LIVE_SOURCE_STORAGE_KEY, next\)/);
  assert.match(component, /const next = parseStoredLiveSource\(event\.target\.value\);\s*if \(next\) changeSource\(next\);/);
  assert.match(component, /result\.status === "unknown"\s*\?\s*<>\s*<h1[^>]*>\{t\(locale, "observationWindowIncomplete"\)/);
  assert.match(component, /requestedSource === "xweather"/);
  assert.match(component, /JSON\.stringify\(\{ latitude, longitude \}\)/);
  assert.doesNotMatch(client, /BLITZ_OBSERVER_API_(?:BASE_URL|TOKEN)|blitzortung\.org|new\s+WebSocket/i);
  assert.match(presentation, /"\/api\/lightning\/blitz-experimental"/);
});
