import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { activityMapData } from "./live-activity.ts";
import { EMPTY_PROVIDER_DIAGNOSTICS, type LiveLightningApiResult } from "./lightning/types.ts";
import type { BlitzExperimentalResult } from "./lightning/blitz-experimental.ts";
import { developerLiveMode, isCurrentSourceRequest, livePresentationSeverity, liveSourceEndpoint, normalizeBlitzPresentation, normalizeXweatherPresentation, type LiveLightningSource } from "./live-lightning-presentation.ts";

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

test("normal source defaults to Xweather route; dev gate is exact and not persisted", () => {
  const source: LiveLightningSource = "xweather";
  assert.equal(source, "xweather");
  assert.equal(liveSourceEndpoint(source), "/api/lightning/live");
  assert.equal(liveSourceEndpoint("blitz-experimental"), "/api/lightning/blitz-experimental");
  assert.equal(developerLiveMode(""), false);
  assert.equal(developerLiveMode("?lightningDev=0"), false);
  assert.equal(developerLiveMode("?lightningDev=true"), false);
  assert.equal(developerLiveMode("?lightningDev=1"), true);
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

test("client selector is gated and client code has no observer credentials, host, or direct socket", () => {
  const component = readFileSync(new URL("../app/live-observation.tsx", import.meta.url), "utf8");
  const page = readFileSync(new URL("../app/page.tsx", import.meta.url), "utf8");
  const presentation = readFileSync(new URL("./live-lightning-presentation.ts", import.meta.url), "utf8");
  const client = `${component}\n${page}\n${presentation}`;
  assert.match(component, /developerMode\s*&&\s*<label className="developer-source"/);
  assert.match(page, /developerLiveMode\(window\.location\.search\)/);
  const switchHandler = component.slice(component.indexOf("const changeSource"), component.indexOf("const severity"));
  assert.match(switchHandler, /sourceRef\.current = next[\s\S]*requestId\.current \+= 1[\s\S]*\.abort\(\)/);
  assert.match(switchHandler, /setResult\(null\)[\s\S]*setXweatherSummary\(null\)[\s\S]*setPlace\(null\)[\s\S]*setCheckedAt\(null\)/);
  assert.doesNotMatch(switchHandler, /checkActivity\(/);
  assert.match(component, /result\.status === "unknown"\s*\?\s*<>\s*<h1[^>]*>\{t\(locale, "observationWindowIncomplete"\)/);
  assert.match(component, /requestedSource === "xweather"/);
  assert.match(component, /JSON\.stringify\(\{ latitude, longitude \}\)/);
  assert.doesNotMatch(client, /BLITZ_OBSERVER_API_(?:BASE_URL|TOKEN)|blitzortung\.org|new\s+WebSocket/i);
  assert.match(presentation, /"\/api\/lightning\/blitz-experimental"/);
});
