import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { activityMapData } from "./live-activity.ts";
import { EMPTY_PROVIDER_DIAGNOSTICS, type LiveLightningApiResult } from "./lightning/types.ts";
import type { BlitzExperimentalResult } from "./lightning/blitz-experimental.ts";
import { canStartLiveSourceRequest, developerLiveMode, DEVELOPER_LIVE_SOURCE_STORAGE_KEY, initialLiveSourceForCheck, isCurrentSourceRequest, livePresentationSeverity, liveSourceEndpoint, normalizeBlitzPresentation, normalizeXweatherPresentation, ownsLiveRequestController, parseStoredLiveSource, resolveDeveloperLiveSource, type LiveLightningSource } from "./live-lightning-presentation.ts";
import { t } from "./i18n.ts";

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
  assert.equal(resolveDeveloperLiveSource(true, null), "blitz-experimental");
  assert.equal(resolveDeveloperLiveSource(true, "blitz-experimental"), "blitz-experimental");
  assert.equal(resolveDeveloperLiveSource(true, "xweather"), "xweather");
  assert.equal(resolveDeveloperLiveSource(true, "unknown"), "blitz-experimental");
  assert.equal(resolveDeveloperLiveSource(false, "blitz-experimental"), "xweather");
  assert.equal(resolveDeveloperLiveSource(false, "malformed"), "xweather");
});

test("initial auto-check waits for hydration and uses exactly the resolved selected source", () => {
  const initialSource = (eligible: boolean, ready: boolean, preferenceReady: boolean, dev: boolean,
    selected: LiveLightningSource, ref: LiveLightningSource, resolved: LiveLightningSource | null) =>
    initialLiveSourceForCheck(eligible, ready, preferenceReady, dev, selected, ref, resolved);
  assert.equal(initialSource(true, false, false, true, "blitz-experimental", "blitz-experimental", "blitz-experimental"), null);
  assert.equal(initialSource(true, true, false, true, "blitz-experimental", "blitz-experimental", "blitz-experimental"), null);
  assert.equal(initialSource(true, true, true, true, "blitz-experimental", "blitz-experimental", "blitz-experimental"), "blitz-experimental");
  assert.equal(initialSource(true, true, true, true, "xweather", "xweather", "xweather"), "xweather");
  assert.equal(initialSource(true, true, true, false, "xweather", "xweather", "xweather"), "xweather");
  assert.equal(initialSource(true, true, true, false, "blitz-experimental", "blitz-experimental", "xweather"), null);
  assert.equal(initialSource(true, true, true, true, "blitz-experimental", "xweather", "blitz-experimental"), null);
  assert.equal(initialSource(false, true, true, true, "blitz-experimental", "blitz-experimental", "blitz-experimental"), null);
});

test("Blitz incomplete copy stays neutral while coverage status remains unknown", () => {
  const unknown = normalizeBlitzPresentation(blitz("unknown", [], "unknown"));
  const currentClearRecentUnknown = normalizeBlitzPresentation(blitz("clear", [], "unknown"));
  assert.equal(unknown.status, "unknown");
  assert.equal(livePresentationSeverity(unknown), null);
  assert.equal(t("tr", "observationWindowIncomplete"), "Yakın çevre izleniyor");
  assert.equal(t("tr", "observationWindowIncompleteBody"), "Şu anda yakınlarda doğrulanmış bir yıldırım kaydı görünmüyor. Gözlem verisi henüz tam olmadığı için kesin bir “aktivite yok” sonucu veremiyoruz.");
  assert.equal(t("en", "observationWindowIncomplete"), "Monitoring nearby activity");
  assert.equal(t("en", "observationWindowIncompleteBody"), "No confirmed nearby lightning is visible right now. The observation window is not yet complete, so we can’t confirm that the area is clear.");
  assert.equal(currentClearRecentUnknown.status, "clear");
  assert.equal(currentClearRecentUnknown.recentStatus, "unknown");
  assert.equal(t("tr", "blitzRecentUnknown"), "Yakın dönem gözlemi henüz tamamlanıyor.");
  assert.equal(t("en", "blitzRecentUnknown"), "Recent observation is still completing.");
  assert.equal(t("en", "liveUnavailable"), "Live lightning unavailable");
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
  const styles = readFileSync(new URL("../app/styles.css", import.meta.url), "utf8");
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
  assert.match(component, /resolveDeveloperLiveSource\(developerMode, storedSource\)/);
  assert.match(component, /const sourceChanged = restoredSource !== sourceRef\.current;\s*sourceRef\.current = restoredSource;/);
  assert.match(component, /if \(sourceChanged\) \{\s*setSource\(restoredSource\)/);
  assert.match(component, /initialLiveSourceForCheck\(autoCheckEligible, developerModeReady, sourcePreferenceReady,[\s\S]*developerMode, source, sourceRef\.current, resolvedInitialSource\.current\)/);
  assert.match(component, /requestLiveCheck\("automatic", \(\) => checkActivity\(initialSource\)\)/);
  assert.match(component, /initialAutoCheckStarted\.current = true/);
  assert.match(component, /result\?\.status === "unknown" \? "live-observing"/);
  assert.equal((component.match(/requestLiveCheck\("automatic"/g) ?? []).length, 1);
  assert.match(component, /claimInitialLiveCheck\(\(\) => window\.sessionStorage\)[\s\S]*requestLiveCheck\("automatic"/);
  assert.match(component, /result\.status === "unavailable" \? <>[\s\S]*t\(locale, topLevelFailure \? "liveUnavailable"/);
  assert.ok(component.indexOf('result.status === "unavailable"') < component.indexOf('result.status === "unknown"'));
  assert.match(styles, /\.current-hero\.live-observing\{--hero-accent:#71807b;--hero-soft:#e8eeea\}/);
  assert.match(component, /developerMode && sourcePreferenceReady && <label className="developer-source"/);
  assert.match(component, /if \(developerMode\) \{\s*try \{ localStorage\.setItem\(DEVELOPER_LIVE_SOURCE_STORAGE_KEY, next\)/);
  assert.match(component, /const next = parseStoredLiveSource\(event\.target\.value\);\s*if \(next\) changeSource\(next\);/);
  assert.match(component, /result\.status === "unknown"\s*\?\s*<>\s*<h1[^>]*>\{t\(locale, "observationWindowIncomplete"\)/);
  assert.match(component, /requestedSource === "xweather"/);
  assert.match(component, /JSON\.stringify\(\{ latitude, longitude \}\)/);
  assert.doesNotMatch(client, /BLITZ_OBSERVER_API_(?:BASE_URL|TOKEN)|blitzortung\.org|new\s+WebSocket/i);
  assert.match(presentation, /"\/api\/lightning\/blitz-experimental"/);
});
