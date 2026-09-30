import assert from "node:assert/strict";
import test from "node:test";
import { greatCircleDistanceKm } from "./lightning/distance.ts";
import { handleLiveLightningRequest } from "./lightning/handler.ts";
import { summarizeRecentActivity } from "./lightning/summary.ts";
import { EMPTY_PROVIDER_DIAGNOSTICS, LIGHTNING_QUERY_RADIUS_KM, type LiveStrike } from "./lightning/types.ts";
import { createXweatherProvider, parseXweatherLightningPayload } from "./lightning/xweather.ts";

const now = Date.UTC(2026, 8, 30, 12, 0, 0);
const origin = { latitude: 0, longitude: 0 };

function pointAtDistanceKm(distanceKm: number, latitude = 0, longitude = 0) {
  return {
    latitude,
    longitude: longitude + distanceKm / 6371.0088 * 180 / Math.PI,
  };
}

function eventAt(distanceKm: number, ageMinutes: number, type: LiveStrike["type"] = "CG"): LiveStrike {
  return {
    ...pointAtDistanceKm(distanceKm),
    observedAtMs: now - ageMinutes * 60_000,
    type,
  };
}

function xweatherRecord({ latitude = 0, longitude = 0, timestamp = now / 1000, type = "CG" } = {}) {
  return { id: "private-upstream-id", loc: { lat: latitude, long: longitude }, ob: { timestamp, pulse: { type } } };
}

function response(payload: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json", ...headers } });
}

test("Haversine distance handles a known equatorial arc and longitude wrap", () => {
  assert.ok(Math.abs(greatCircleDistanceKm(0, 0, 0, 1) - 111.195) < 0.02);
  assert.ok(greatCircleDistanceKm(0, 179.9, 0, -179.9) < 23);
});

test("summary counts events in inclusive 5/10/25/50 km bands and excludes outside the query radius", () => {
  const events = [5, 10, 25, 50, 50.01].map((km) => eventAt(km, 1));
  const summary = summarizeRecentActivity(events, 0, 0, now, 0, EMPTY_PROVIDER_DIAGNOSTICS);
  assert.deepEqual(summary.counts, { within5Km: 1, within10Km: 2, within25Km: 3, within50Km: 4 });
  assert.equal(summary.totalEvents, 4);
  assert.ok(Math.abs(summary.nearestKm! - 5) < 1e-7);
  assert.equal(LIGHTNING_QUERY_RADIUS_KM, 50);
});

test("summary finds the closest event, latest event time, and nearest event age independently", () => {
  const summary = summarizeRecentActivity([eventAt(14, 4), eventAt(3, 2), eventAt(8, 1)], 0, 0, now, 0, EMPTY_PROVIDER_DIAGNOSTICS);
  assert.ok(Math.abs(summary.nearestKm! - 3) < 1e-7);
  assert.equal(summary.nearestAgeMinutes, 2);
  assert.equal(summary.latestEventAt, now - 60_000);
});

test("an empty healthy provider response is a live zero, with unavailable distances", () => {
  const summary = summarizeRecentActivity([], 0, 0, now, 0, EMPTY_PROVIDER_DIAGNOSTICS);
  assert.equal(summary.status, "live");
  assert.equal(summary.totalEvents, 0);
  assert.deepEqual(summary.counts, { within5Km: 0, within10Km: 0, within25Km: 0, within50Km: 0 });
  assert.equal(summary.latestEventAt, null);
  assert.equal(summary.nearestKm, null);
});

test("events outside the latest five-minute window are ignored", () => {
  const summary = summarizeRecentActivity([eventAt(1, 5), eventAt(2, 5.01)], 0, 0, now, 0, EMPTY_PROVIDER_DIAGNOSTICS);
  assert.equal(summary.totalEvents, 1);
});

test("Xweather fixture parser normalizes documented coordinates, timestamp seconds, and pulse type", () => {
  const parsed = parseXweatherLightningPayload({ success: true, error: null, response: [xweatherRecord({ type: "ic" })] });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.deepEqual(parsed.events, [{ observedAtMs: now, latitude: 0, longitude: 0, type: "IC" }]);
  assert.equal(parsed.rejectedEventCount, 0);
  assert.equal(JSON.stringify(parsed).includes("private-upstream-id"), false);
});

test("reaching the standard 1,000-event limit is surfaced as potentially truncated", () => {
  const parsed = parseXweatherLightningPayload({ success: true, error: null, response: Array.from({ length: 1000 }, () => xweatherRecord()) });
  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    assert.equal(parsed.events.length, 1000);
    assert.equal(parsed.mayBeTruncated, true);
  }
});

test("provider parser skips malformed event records without trusting them as detections", () => {
  const parsed = parseXweatherLightningPayload({ success: true, error: null, response: [xweatherRecord(), { loc: { lat: 999, long: 0 }, ob: { timestamp: now / 1000 } }] });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.events.length, 1);
  assert.equal(parsed.rejectedEventCount, 1);

  const allInvalid = parseXweatherLightningPayload({ success: true, error: null, response: [{ loc: {}, ob: {} }] });
  assert.equal(allInvalid.ok, false);
  if (!allInvalid.ok) assert.equal(allInvalid.status, "malformed-response");
});

test("successful warn_no_data response means no current events, but provider errors do not", () => {
  const empty = parseXweatherLightningPayload({ success: true, error: { code: "warn_no_data" }, response: [] });
  assert.equal(empty.ok, true);
  if (empty.ok) assert.equal(empty.events.length, 0);

  const quota = parseXweatherLightningPayload({ success: false, error: { code: "maxhits" }, response: [] });
  assert.equal(quota.ok, false);
  if (!quota.ok) assert.equal(quota.status, "provider-quota-exceeded");
});

test("coordinates reject missing, non-numeric, non-finite, and out-of-range values", async () => {
  for (const body of [null, {}, { latitude: "0", longitude: 0 }, { latitude: NaN, longitude: 0 }, { latitude: 90.01, longitude: 0 }, { latitude: 0, longitude: -180.01 }]) {
    const result = await handleLiveLightningRequest(body, { clientId: "id", clientSecret: "secret" });
    assert.equal(result.httpStatus, 400);
    assert.equal(result.body.ok, false);
    if (!result.body.ok) assert.equal(result.body.status, "invalid-coordinates");
  }
});

test("missing credentials return provider-not-configured and do not call upstream", async () => {
  let called = false;
  const result = await handleLiveLightningRequest(origin, { fetcher: async () => { called = true; throw new Error("must not call"); } });
  assert.equal(called, false);
  assert.equal(result.httpStatus, 503);
  assert.equal(result.body.ok, false);
  if (!result.body.ok) assert.equal(result.body.status, "provider-not-configured");
});

test("the standard request uses /lightning/closest with a 50 km radius and keeps credentials server-side", async () => {
  const requestedUrls: URL[] = [];
  let requestCache: RequestCache | undefined;
  const handlerResult = await handleLiveLightningRequest(origin, {
    clientId: "private-test-id",
    clientSecret: "private-test-secret",
    now: () => now,
    fetcher: async (input, init) => {
      requestedUrls.push(new URL(String(input)));
      requestCache = init?.cache;
      return response({ success: true, error: null, response: [xweatherRecord({ timestamp: now / 1000 - 60 })] }, 200, {
        "X-Cost-Tokens": "10", "X-Cost-Multiplier": "endpoint=10; spatial=1; temporal=1", "X-RateLimit-Remaining-Period": "14990",
      });
    },
  });

  assert.equal(handlerResult.httpStatus, 200);
  assert.equal(requestedUrls.length, 1);
  const requestedUrl = requestedUrls[0]!;
  assert.equal(requestedUrl.origin, "https://data.api.xweather.com");
  assert.equal(requestedUrl.pathname, "/lightning/closest");
  assert.equal(requestedUrl.searchParams.get("radius"), "50km");
  assert.equal(requestedUrl.searchParams.get("limit"), "1000");
  assert.equal(requestedUrl.searchParams.get("client_secret"), "private-test-secret");
  assert.equal(requestCache, "no-store");
  const serialized = JSON.stringify(handlerResult.body);
  assert.equal(serialized.includes("private-test-id"), false);
  assert.equal(serialized.includes("private-test-secret"), false);
  assert.equal(serialized.includes("private-upstream-id"), false);
  assert.equal(serialized.includes('"costTokens":"10"'), true);
  assert.equal(serialized.includes("14990"), true);
});

test("upstream quota and authentication failures are not converted to zero events", async () => {
  const quota = await handleLiveLightningRequest(origin, {
    clientId: "id", clientSecret: "secret",
    fetcher: async () => response({ success: false, error: { code: "maxhits" }, response: [] }, 429),
  });
  assert.equal(quota.body.ok, false);
  if (!quota.body.ok) assert.equal(quota.body.status, "provider-quota-exceeded");

  const auth = await handleLiveLightningRequest(origin, {
    clientId: "id", clientSecret: "secret",
    fetcher: async () => response({}, 401),
  });
  assert.equal(auth.body.ok, false);
  if (!auth.body.ok) assert.equal(auth.body.status, "provider-auth-error");
});

test("malformed upstream payload is unavailable rather than an empty live result", async () => {
  const result = await handleLiveLightningRequest(origin, {
    clientId: "id", clientSecret: "secret", fetcher: async () => response({ success: true, response: null }),
  });
  assert.equal(result.body.ok, false);
  if (!result.body.ok) assert.equal(result.body.status, "malformed-response");
});

test("network failure is unavailable rather than zero activity", async () => {
  const result = await createXweatherProvider({ clientId: "id", clientSecret: "secret" }, async () => { throw new Error("network failure"); })
    .fetchRecentActivity(0, 0);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.status, "provider-unavailable");
});
