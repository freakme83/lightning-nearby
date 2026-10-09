import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { EMPTY_PROVIDER_DIAGNOSTICS, type LiveLightningApiResult } from "./lightning/types.ts";
import { currentSeverity, isCurrentLiveRequest, liveActivityCopy, liveActivitySegments, liveEventCountCopy, liveSeverity, liveSeverityLabel, requestLiveCheck } from "./live-observation.ts";

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
      events: [],
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
  assert.equal(liveSeverityLabel(live, "en"), "Nearby");
  assert.equal(liveSeverityLabel("high", "en"), "Very close");
  assert.equal(liveSeverityLabel("nearby", "en"), "In the area");
  assert.equal(liveSeverityLabel("high", "tr"), "Çok yakın");
  assert.equal(liveSeverityLabel("elevated", "tr"), "Yakın");
  assert.equal(liveSeverityLabel("nearby", "tr"), "Çevrede");
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
    assert.equal(liveActivityCopy(result.summary), "No recent lightning activity was reported within 50 km in the last 30 minutes.");
    assert.equal(result.summary.recentArea.windowMinutes, 30);
  }
});

test("recent regional activity without current lightning stays non-severe and uses qualitative context", () => {
  const result = observed(null, "clear");
  assert.equal(liveSeverity(result), "none");
  if (result.ok) {
    assert.equal(liveActivityCopy(result.summary), "However, activity was detected within 50 km during the last 30 minutes.");
    assert.equal(liveActivityCopy(result.summary, "tr"), "Ancak son 30 dakikada 50 km içinde aktivite tespit edildi.");
    assert.deepEqual(liveActivitySegments(result.summary, "tr"), [
      { text: "Ancak son 30 dakikada 50 km içinde aktivite " },
      { text: "tespit edildi", emphasize: true }, { text: "." },
    ]);
    assert.doesNotMatch(liveActivityCopy(result.summary), /flash|detections?/i);
  }
});

test("only clear-current positive-area evidence has the detection emphasis", async () => {
  const clear = observed(null, "not-requested");
  const positive = observed(null, "clear");
  if (!clear.ok || !positive.ok) throw new Error("fixture must succeed");
  assert.equal(liveActivitySegments(clear.summary, "tr").some(part => part.emphasize), false);
  assert.equal(liveActivitySegments(positive.summary, "en").filter(part => part.emphasize).map(part => part.text).join(""), "was detected");
  const component = await readFile(new URL("../app/live-observation.tsx", import.meta.url), "utf8");
  const styles = await readFile(new URL("../app/styles.css", import.meta.url), "utf8");
  assert.match(component, /className="recent-detection"/);
  assert.match(styles, /\.recent-detection\{color:#914b3e;font-weight:700\}/);
});

test("partial current-provider failure is unknown rather than clear", () => {
  const result: LiveLightningApiResult = { ok: true, summary: {
    status: "live", provider: "xweather", fetchedAt: 0,
    recentArea: { status: "active", windowMinutes: 30, radiusKm: 50, totalDetections: 3, oldestEventAt: null, newestEventAt: null, diagnostics: EMPTY_PROVIDER_DIAGNOSTICS },
    current: { status: "unavailable", windowMinutes: 5, radiusKm: 40, failureStatus: "provider-unavailable", message: "Unavailable", diagnostics: EMPTY_PROVIDER_DIAGNOSTICS },
  } };
  assert.equal(liveSeverity(result), null);
  assert.equal(liveActivityCopy(result.summary), "Activity was also detected within 50 km during the last 30 minutes, but current nearby activity is unavailable.");
  assert.doesNotMatch(liveActivityCopy(result.summary), /flash|detections?/i);
});

test("active event count uses ordinary lightning-event wording", () => {
  assert.equal(liveEventCountCopy(8, 10), "8 recent lightning events within 10 km · last 5 min");
  assert.equal(liveEventCountCopy(1, 10), "1 recent lightning event within 10 km · last 5 min");
  assert.equal(liveEventCountCopy(1, 10, "tr"), "Son 5 dakikada 10 km içinde 1 şimşek/yıldırım olayı");
  assert.equal(liveEventCountCopy(8, 25, "tr"), "Son 5 dakikada 25 km içinde 8 şimşek/yıldırım olayı");
});

test("automatic and first manual Live checks do not request an extra forecast", async () => {
  let forecastRefreshes = 0;
  let liveChecks = 0;
  const live = async () => { liveChecks++; };
  const forecast = () => { forecastRefreshes++; };
  await requestLiveCheck("automatic", live, forecast);
  await requestLiveCheck("manual-check", live, forecast);
  assert.equal(liveChecks, 2);
  assert.equal(forecastRefreshes, 0);
});

test("manual Live refresh starts both requests once and neither waits for the other", async () => {
  let completeLive!: () => void;
  const pendingLive = new Promise<void>(resolve => { completeLive = resolve; });
  const started: string[] = [];
  const live = requestLiveCheck("manual-refresh", () => { started.push("live"); return pendingLive; }, () => started.push("forecast"));
  assert.deepEqual(started, ["live", "forecast"]);
  completeLive();
  await live;

  let forecastCount = 0;
  await assert.rejects(requestLiveCheck("manual-refresh", async () => { throw new Error("live unavailable"); }, () => { forecastCount++; }), /live unavailable/);
  assert.equal(forecastCount, 1);
  let rejectForecast!: (error: Error) => void;
  const forecastFailure = new Promise<void>((_, reject) => { rejectForecast = reject; });
  const successfulLive = requestLiveCheck("manual-refresh", async () => {}, () => { rejectForecast(new Error("forecast unavailable")); });
  await assert.rejects(forecastFailure, /forecast unavailable/);
  await successfulLive;
});

test("obsolete and aborted requests cannot own a changed location", () => {
  const controller = new AbortController();
  assert.equal(isCurrentLiveRequest(1, 1, "52,-7", "52,-7", controller.signal), true);
  assert.equal(isCurrentLiveRequest(1, 2, "52,-7", "52,-7", controller.signal), false);
  assert.equal(isCurrentLiveRequest(1, 1, "52,-7", "43,3", controller.signal), false);
  controller.abort();
  assert.equal(isCurrentLiveRequest(1, 1, "52,-7", "52,-7", controller.signal), false);
});
