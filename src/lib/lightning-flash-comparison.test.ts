import assert from "node:assert/strict";
import test from "node:test";
import { greatCircleDistanceKm } from "./lightning/distance.ts";
import { EMPTY_PROVIDER_DIAGNOSTICS, type LiveStrike, type ProviderResult } from "./lightning/types.ts";
import {
  buildRawFlashComparisonUrls,
  compareRawAndFlash,
  handleRawFlashComparisonRequest,
  normalizeComparableLightning,
  parseRawFlashComparisonRequest,
} from "./lightning/xweather-flash-comparison.ts";

const now = Date.UTC(2026, 8, 30, 15, 0, 0);
const origin = { latitude: 0, longitude: 0 };

function pointAtDistanceKm(distanceKm: number, bearingDegrees: number) {
  const radius = 6371.0088;
  const angularDistance = distanceKm / radius;
  const bearing = bearingDegrees * Math.PI / 180;
  const latitude = Math.asin(Math.sin(0) * Math.cos(angularDistance) + Math.cos(0) * Math.sin(angularDistance) * Math.cos(bearing));
  const longitude = Math.atan2(Math.sin(bearing) * Math.sin(angularDistance) * Math.cos(0), Math.cos(angularDistance) - Math.sin(0) * Math.sin(latitude));
  return { latitude: latitude * 180 / Math.PI, longitude: longitude * 180 / Math.PI };
}

function eventAt(distanceKm: number, bearing: number, ageMinutes: number): LiveStrike {
  return { ...pointAtDistanceKm(distanceKm, bearing), observedAtMs: now - ageMinutes * 60_000, type: "unknown" };
}

function providerResult(events: LiveStrike[]): ProviderResult {
  return { ok: true, events, rejectedEventCount: 0, mayBeTruncated: false, diagnostics: EMPTY_PROVIDER_DIAGNOSTICS };
}

function response(payload: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json", ...headers } });
}

function xweatherPayload(events: LiveStrike[]) {
  return {
    success: true,
    error: null,
    response: events.map((event, index) => ({
      id: `private-${index}`,
      loc: { lat: event.latitude, long: event.longitude },
      ob: { timestamp: event.observedAtMs / 1000 },
    })),
  };
}

test("comparison URLs use the same point, 40 km radius and 1,000-result limit", () => {
  const urls = buildRawFlashComparisonUrls({ latitude: 43.58, longitude: 3.88 }, { clientId: "private-id", clientSecret: "private-secret" });
  for (const url of [urls.raw, urls.flash]) {
    assert.equal(url.searchParams.get("p"), "43.58,3.88");
    assert.equal(url.searchParams.get("radius"), "40km");
    assert.equal(url.searchParams.get("limit"), "1000");
    assert.equal(url.searchParams.get("client_secret"), "private-secret");
  }
  assert.equal(urls.raw.pathname, "/lightning/closest");
  assert.equal(urls.raw.searchParams.get("filter"), "all");
  assert.equal(urls.flash.pathname, "/lightning/flash/closest");
  assert.equal(urls.flash.searchParams.has("filter"), false);
});

test("flash normalization derives nearest distance, direction, ages and 5/10/25/40 km bands", () => {
  const events = [eventAt(3, 315, 1), eventAt(10, 90, 2), eventAt(25, 180, 3), eventAt(40, 270, 4), eventAt(40.01, 0, 1)];
  const result = normalizeComparableLightning("consolidated-flashes", providerResult(events), 0, 0, now);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.returnedCount, 4);
  assert.equal(result.activityPresent, true);
  assert.ok(Math.abs(result.nearestKm! - 3) < 1e-7);
  assert.equal(result.nearestDirection, "NW");
  assert.equal(result.nearestAgeMinutes, 1);
  assert.equal(result.newestAgeMinutes, 1);
  assert.equal(result.oldestAgeMinutes, 4);
  assert.deepEqual(result.counts, { within5Km: 1, within10Km: 2, within25Km: 3, within40Km: 4 });
  assert.ok(Math.abs(greatCircleDistanceKm(0, 0, events[3]!.latitude, events[3]!.longitude) - 40) < 1e-7);
});

test("healthy zero remains a successful absent-activity result", () => {
  const result = normalizeComparableLightning("consolidated-flashes", providerResult([]), 0, 0, now);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.activityPresent, false);
  assert.equal(result.returnedCount, 0);
  assert.equal(result.nearestKm, null);
  assert.equal(result.nearestDirection, null);
  assert.deepEqual(result.counts, { within5Km: 0, within10Km: 0, within25Km: 0, within40Km: 0 });
});

test("comparison logic reports presence, direction and numeric differences without comparing counts as accuracy", () => {
  const raw = normalizeComparableLightning("raw-pulses", providerResult([eventAt(3, 315, 1), eventAt(8, 90, 2)]), 0, 0, now);
  const flash = normalizeComparableLightning("consolidated-flashes", providerResult([eventAt(3.4, 315, 1.2)]), 0, 0, now);
  const comparison = compareRawAndFlash(origin, raw, flash, now);
  assert.equal(comparison.presenceMatch, true);
  assert.equal(comparison.directionMatch, true);
  assert.ok(Math.abs(comparison.nearestDistanceDifferenceKm! - 0.4) < 1e-7);
  assert.ok(Math.abs(comparison.nearestAgeDifferenceMinutes! - 0.2) < 1e-7);
  assert.equal(comparison.summaryLines.includes("Presence match: yes"), true);
  assert.equal(comparison.summaryLines.some((line) => line.includes("accuracy")), false);
});

test("comparison logic surfaces one-sided activity as a discrepancy", () => {
  const raw = normalizeComparableLightning("raw-pulses", providerResult([eventAt(4, 0, 1)]), 0, 0, now);
  const flash = normalizeComparableLightning("consolidated-flashes", providerResult([]), 0, 0, now);
  const comparison = compareRawAndFlash(origin, raw, flash, now);
  assert.equal(comparison.presenceMatch, false);
  assert.equal(comparison.directionMatch, null);
  assert.equal(comparison.nearestDistanceDifferenceKm, null);
  assert.equal(comparison.summaryLines.includes("Presence match: no"), true);
});

test("debug request validation rejects missing, non-numeric and out-of-range coordinates", () => {
  assert.deepEqual(parseRawFlashComparisonRequest(origin), origin);
  for (const body of [null, {}, { latitude: "0", longitude: 0 }, { latitude: 91, longitude: 0 }, { latitude: 0, longitude: -181 }]) {
    assert.equal(parseRawFlashComparisonRequest(body), null);
  }
});

test("handler makes exactly one raw and one flash request and never serializes credentials or upstream IDs", async () => {
  const requested: URL[] = [];
  const event = eventAt(4, 45, 1);
  const result = await handleRawFlashComparisonRequest(origin, {
    clientId: "private-id",
    clientSecret: "private-secret",
    now: () => now,
    fetcher: async (input, init) => {
      const url = new URL(String(input));
      requested.push(url);
      assert.equal(init?.cache, "no-store");
      const cost = url.pathname === "/lightning/closest" ? "10" : "1";
      return response(xweatherPayload([event]), 200, {
        "X-Cost-Tokens": cost,
        "X-Cost-Multipliers": `endpoint=${cost}; spatial=1; temporal=1`,
      });
    },
  });
  assert.equal(requested.length, 2);
  assert.deepEqual(requested.map((url) => url.pathname).sort(), ["/lightning/closest", "/lightning/flash/closest"]);
  assert.equal(result.httpStatus, 200);
  assert.equal(result.body.ok, true);
  const serialized = JSON.stringify(result.body);
  assert.equal(serialized.includes("private-id"), false);
  assert.equal(serialized.includes("private-secret"), false);
  assert.equal(serialized.includes("private-0"), false);
  assert.equal(serialized.includes('"costTokens":"10"'), true);
  assert.equal(serialized.includes('"costTokens":"1"'), true);
});

test("malformed Flash response is unavailable rather than healthy zero while Raw remains visible", async () => {
  const result = await handleRawFlashComparisonRequest(origin, {
    clientId: "id",
    clientSecret: "secret",
    now: () => now,
    fetcher: async (input) => new URL(String(input)).pathname === "/lightning/closest"
      ? response(xweatherPayload([eventAt(2, 90, 1)]))
      : response({ success: true, error: null, response: [{ loc: {}, ob: {} }] }),
  });
  assert.equal(result.body.ok, true);
  if (!result.body.ok) return;
  assert.equal(result.body.comparison.raw.ok, true);
  assert.equal(result.body.comparison.flash.ok, false);
  if (!result.body.comparison.flash.ok) assert.equal(result.body.comparison.flash.status, "malformed-response");
  assert.equal(result.body.comparison.presenceMatch, null);
});

test("missing credentials and invalid input make no upstream requests", async () => {
  let calls = 0;
  const fetcher = async () => { calls += 1; throw new Error("must not run"); };
  const invalid = await handleRawFlashComparisonRequest({ latitude: 100, longitude: 0 }, { clientId: "id", clientSecret: "secret", fetcher });
  const unconfigured = await handleRawFlashComparisonRequest(origin, { fetcher });
  assert.equal(invalid.httpStatus, 400);
  assert.equal(unconfigured.httpStatus, 503);
  assert.equal(calls, 0);
});
