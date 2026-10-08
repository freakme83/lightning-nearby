import assert from "node:assert/strict";
import test from "node:test";
import { greatCircleDistanceKm } from "./lightning/distance.ts";
import { compassDirection, initialBearingDegrees } from "./lightning/bearing.ts";
import { handleLiveLightningRequest } from "./lightning/handler.ts";
import { summarizeCurrentFlashes, summarizeRecentActivity } from "./lightning/summary.ts";
import { EMPTY_PROVIDER_DIAGNOSTICS, LIGHTNING_QUERY_RADIUS_KM, LIVE_CURRENT_EVENT_LIMIT, type LiveStrike } from "./lightning/types.ts";
import { buildXweatherLiveUrls, parseXweatherSummaryPayload } from "./lightning/xweather-live.ts";
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

function summaryPayload(count: number, asArray = false) {
  const summary = {
    summary: {
      range: {
        count,
        minTimestamp: count ? now / 1000 - 20 * 60 : null,
        maxTimestamp: count ? now / 1000 - 60 : null,
      },
      pulse: { count, cg: count, ic: 0 },
    },
  };
  return { success: true, error: null, response: asArray ? [summary] : summary };
}

test("Haversine distance handles a known equatorial arc and longitude wrap", () => {
  assert.ok(Math.abs(greatCircleDistanceKm(0, 0, 0, 1) - 111.195) < 0.02);
  assert.ok(greatCircleDistanceKm(0, 179.9, 0, -179.9) < 23);
});

test("initial bearing handles cardinal, intercardinal and dateline routes", () => {
  assert.ok(Math.abs(initialBearingDegrees(0, 0, 1, 0)!) < 1e-8);
  assert.ok(Math.abs(initialBearingDegrees(0, 0, 0, 1)! - 90) < 1e-8);
  assert.ok(Math.abs(initialBearingDegrees(0, 0, -1, 0)! - 180) < 1e-8);
  assert.ok(Math.abs(initialBearingDegrees(0, 0, 0, -1)! - 270) < 1e-8);
  assert.equal(compassDirection(initialBearingDegrees(0, 179.9, 0, -179.9)), "E");
  assert.equal(compassDirection(initialBearingDegrees(0, 0, 1, 1)), "NE");
});

test("eight compass sectors include boundaries and wrap to north", () => {
  assert.equal(compassDirection(22.499), "N");
  assert.equal(compassDirection(22.5), "NE");
  assert.equal(compassDirection(67.5), "E");
  assert.equal(compassDirection(112.5), "SE");
  assert.equal(compassDirection(157.5), "S");
  assert.equal(compassDirection(202.5), "SW");
  assert.equal(compassDirection(247.5), "W");
  assert.equal(compassDirection(292.5), "NW");
  assert.equal(compassDirection(337.5), "N");
  assert.equal(compassDirection(-22.5), "N");
  assert.equal(compassDirection(Number.NaN), null);
});

test("coincident or ambiguous points do not invent a direction", () => {
  assert.equal(initialBearingDegrees(52, -7, 52, -7), null);
  assert.equal(initialBearingDegrees(0, 0, 0, 180), null);
  assert.equal(initialBearingDegrees(91, 0, 0, 0), null);
  assert.equal(compassDirection(null), null);
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
  assert.equal(summary.nearestDirection, null);
});

test("summary sends derived direction without nearest event coordinates", () => {
  const summary = summarizeRecentActivity([eventAt(2, 1)], 0, 0, now, 0, EMPTY_PROVIDER_DIAGNOSTICS);
  assert.equal(summary.nearestDirection, "E");
  assert.equal(JSON.stringify(summary).includes("longitude"), false);
  assert.equal(JSON.stringify(summary).includes("latitude"), false);
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

test("production URLs use Summary 30m / 50 km and Flash 5m / 40 km without Raw", () => {
  const urls = buildXweatherLiveUrls(43.58, 3.88, { clientId: "private-test-id", clientSecret: "private-test-secret" });
  assert.equal(urls.summary.pathname, "/lightning/summary/closest");
  assert.equal(urls.summary.searchParams.get("radius"), "50km");
  assert.equal(urls.summary.searchParams.get("from"), "-30minutes");
  assert.equal(urls.summary.searchParams.get("to"), "now");
  assert.equal(urls.flash.pathname, "/lightning/flash/closest");
  assert.equal(urls.flash.searchParams.get("radius"), "40km");
  assert.equal(urls.flash.searchParams.get("limit"), "1000");
  assert.equal([urls.summary, urls.flash].some((url) => url.pathname === "/lightning/closest"), false);
});

test("Summary parser accepts object, single-item array and warn_no_data without exposing provider data", () => {
  for (const payload of [summaryPayload(3), summaryPayload(3, true)]) {
    const parsed = parseXweatherSummaryPayload(payload);
    assert.equal(parsed.ok, true);
    if (parsed.ok) {
      assert.equal(parsed.totalDetections, 3);
      assert.equal(parsed.oldestEventAt, now - 20 * 60_000);
      assert.equal(parsed.newestEventAt, now - 60_000);
    }
  }
  const empty = parseXweatherSummaryPayload({ success: true, error: { code: "warn_no_data" } });
  assert.equal(empty.ok, true);
  if (empty.ok) assert.equal(empty.totalDetections, 0);
  const malformed = parseXweatherSummaryPayload({ success: true, error: null, response: [] });
  assert.equal(malformed.ok, false);
  if (!malformed.ok) assert.equal(malformed.status, "malformed-response");
});

test("quiet Summary makes exactly one upstream request and does not request Flash", async () => {
  const requestedUrls: URL[] = [];
  let requestCache: RequestCache | undefined;
  const handlerResult = await handleLiveLightningRequest(origin, {
    clientId: "private-test-id",
    clientSecret: "private-test-secret",
    now: () => now,
    fetcher: async (input, init) => {
      requestedUrls.push(new URL(String(input)));
      requestCache = init?.cache;
      return response(summaryPayload(0), 200, {
        "X-Cost-Tokens": "1", "X-Cost-Multiplier": "endpoint=1; spatial=1; temporal=1", "X-RateLimit-Remaining-Period": "14990",
      });
    },
  });

  assert.equal(handlerResult.httpStatus, 200);
  assert.equal(requestedUrls.length, 1);
  const requestedUrl = requestedUrls[0]!;
  assert.equal(requestedUrl.origin, "https://data.api.xweather.com");
  assert.equal(requestedUrl.pathname, "/lightning/summary/closest");
  assert.equal(requestedUrl.searchParams.get("radius"), "50km");
  assert.equal(requestedUrl.searchParams.get("from"), "-30minutes");
  assert.equal(requestedUrl.searchParams.get("client_secret"), "private-test-secret");
  assert.equal(requestCache, "no-store");
  assert.equal(handlerResult.body.ok, true);
  if (handlerResult.body.ok) {
    assert.equal(handlerResult.body.summary.recentArea.totalDetections, 0);
    assert.equal(handlerResult.body.summary.current.status, "not-requested");
    assert.equal("events" in handlerResult.body.summary.current, false);
  }
  const serialized = JSON.stringify(handlerResult.body);
  assert.equal(serialized.includes("private-test-id"), false);
  assert.equal(serialized.includes("private-test-secret"), false);
  assert.equal(serialized.includes("private-upstream-id"), false);
  assert.equal(serialized.includes('"costTokens":"1"'), true);
  assert.equal(serialized.includes("14990"), true);
});

test("positive Summary makes exactly two ordered requests and preserves both diagnostics", async () => {
  const paths: string[] = [];
  const result = await handleLiveLightningRequest(origin, {
    clientId: "id", clientSecret: "secret", now: () => now,
    fetcher: async (input) => {
      const path = new URL(String(input)).pathname;
      paths.push(path);
      return path === "/lightning/summary/closest"
        ? response(summaryPayload(8), 200, { "X-Cost-Tokens": "1" })
        : response({ success: true, error: null, response: [xweatherRecord({ longitude: pointAtDistanceKm(9).longitude, timestamp: now / 1000 - 60 })] }, 200, { "X-Cost-Tokens": "1" });
    },
  });
  assert.deepEqual(paths, ["/lightning/summary/closest", "/lightning/flash/closest"]);
  assert.equal(result.body.ok, true);
  if (!result.body.ok) return;
  assert.equal(result.body.summary.recentArea.totalDetections, 8);
  assert.equal(result.body.summary.recentArea.diagnostics.costTokens, "1");
  assert.equal(result.body.summary.current.status, "active");
  if (result.body.summary.current.status === "active") {
    assert.equal(result.body.summary.current.totalFlashes, 1);
    assert.equal(result.body.summary.current.diagnostics.costTokens, "1");
  }
});

test("Flash filtering uses the request-start time across a slow response", async () => {
  let clock = now;
  const result = await handleLiveLightningRequest(origin, {
    clientId: "id", clientSecret: "secret", now: () => clock,
    fetcher: async (input) => {
      const path = new URL(String(input)).pathname;
      if (path === "/lightning/summary/closest") return response(summaryPayload(1));
      clock += 10_000;
      return response({ success: true, error: null, response: [xweatherRecord({ timestamp: now / 1000 - 4 * 60 - 59 })] });
    },
  });

  assert.equal(result.body.ok, true);
  if (result.body.ok) {
    assert.equal(result.body.summary.fetchedAt, now);
    assert.equal(result.body.summary.current.status, "active");
    if (result.body.summary.current.status === "active") assert.equal(result.body.summary.current.nearestAgeMinutes, 4 + 59 / 60);
  }
});

test("Summary failure makes one request and never calls Flash", async () => {
  const paths: string[] = [];
  const quota = await handleLiveLightningRequest(origin, {
    clientId: "id", clientSecret: "secret",
    fetcher: async (input) => {
      paths.push(new URL(String(input)).pathname);
      return response({ success: false, error: { code: "maxhits" }, response: [] }, 429);
    },
  });
  assert.deepEqual(paths, ["/lightning/summary/closest"]);
  assert.equal(quota.body.ok, false);
  if (!quota.body.ok) assert.equal(quota.body.status, "provider-quota-exceeded");
});

test("Flash failure after positive Summary preserves partial regional context", async () => {
  const paths: string[] = [];
  const result = await handleLiveLightningRequest(origin, {
    clientId: "id", clientSecret: "secret", now: () => now,
    fetcher: async (input) => {
      const path = new URL(String(input)).pathname;
      paths.push(path);
      return path === "/lightning/summary/closest" ? response(summaryPayload(4), 200, { "X-Cost-Tokens": "1" }) : response({}, 503, { "X-Cost-Tokens": "1" });
    },
  });
  assert.deepEqual(paths, ["/lightning/summary/closest", "/lightning/flash/closest"]);
  assert.equal(result.httpStatus, 200);
  assert.equal(result.body.ok, true);
  if (!result.body.ok) return;
  assert.equal(result.body.summary.recentArea.totalDetections, 4);
  assert.equal(result.body.summary.current.status, "unavailable");
  assert.equal("events" in result.body.summary.current, false);
  if (result.body.summary.current.status === "unavailable") assert.equal(result.body.summary.current.failureStatus, "provider-unavailable");
});

test("positive Summary with healthy-zero Flash is recent but currently clear", async () => {
  const result = await handleLiveLightningRequest(origin, {
    clientId: "id", clientSecret: "secret", now: () => now,
    fetcher: async (input) => new URL(String(input)).pathname === "/lightning/summary/closest"
      ? response(summaryPayload(2))
      : response({ success: true, error: { code: "warn_no_data" } }),
  });
  assert.equal(result.body.ok, true);
  if (result.body.ok) {
    assert.equal(result.body.summary.current.status, "clear");
    if (result.body.summary.current.status === "clear") assert.deepEqual(result.body.summary.current.events, []);
  }
});

test("successful Flash exposes every usable event below the cap, nearest-first, with only public fields", () => {
  const events = [eventAt(14, 4, "unknown"), eventAt(3, 2), eventAt(8, 1, "IC")];
  const original = events.map(event => ({ ...event }));
  const summary = summarizeCurrentFlashes(events, 0, 0, now, 2, EMPTY_PROVIDER_DIAGNOSTICS, false);
  assert.deepEqual(summary.events, [events[1], events[2], events[0]]);
  assert.deepEqual(events, original);
  assert.ok(Math.abs(summary.nearestKm! - 3) < 1e-7);
  assert.equal(summary.nearestDirection, "E");
  assert.equal(summary.nearestAgeMinutes, 2);
  assert.equal(summary.latestEventAt, now - 60_000);
  assert.equal(summary.totalFlashes, 3);
  assert.equal(summary.rejectedEventCount, 2);
  assert.ok(summary.events.every(event => Object.keys(event).sort().join(",") === "latitude,longitude,observedAtMs,type"));
});

test("nearest 12 are bounded deterministically while all Flash records contribute to summary metrics", () => {
  const distances = [...Array.from({ length: 16 }, (_, i) => i + 1), 26, 39];
  const events = distances.map(km => eventAt(km, km === 39 ? 0.5 : 2));
  const summary = summarizeCurrentFlashes([...events].reverse(), 0, 0, now, 3, EMPTY_PROVIDER_DIAGNOSTICS, true);
  assert.equal(LIVE_CURRENT_EVENT_LIMIT, 12);
  assert.equal(summary.events.length, 12);
  assert.deepEqual(summary.events, events.slice(0, 12));
  assert.deepEqual(summary.events, summarizeCurrentFlashes(events, 0, 0, now, 3, EMPTY_PROVIDER_DIAGNOSTICS, true).events);
  assert.equal(summary.totalFlashes, 18);
  assert.deepEqual(summary.counts, { within5Km: 5, within10Km: 10, within25Km: 16, within40Km: 18 });
  assert.equal(summary.latestEventAt, events[17].observedAtMs);
  assert.equal(summary.nearestAgeMinutes, 2);
  assert.equal(summary.nearestDirection, "E");
  assert.equal(summary.rejectedEventCount, 3);
  assert.equal(summary.mayBeTruncated, true);
});

test("equal-distance public events use newer time, latitude, longitude and type ties independent of provider order", () => {
  const step = pointAtDistanceKm(1).longitude;
  const older = { ...eventAt(1, 4), type: "unknown" as const };
  const tied: LiveStrike[] = [
    { observedAtMs: now, latitude: -step, longitude: 0, type: "CG" },
    { observedAtMs: now, latitude: 0, longitude: -step, type: "CG" },
    { observedAtMs: now, latitude: 0, longitude: step, type: "CG" },
    { observedAtMs: now, latitude: 0, longitude: step, type: "IC" },
    { observedAtMs: now, latitude: step, longitude: 0, type: "CG" },
  ];
  const summarize = (events: LiveStrike[]) => summarizeCurrentFlashes(events, 0, 0, now, 0, EMPTY_PROVIDER_DIAGNOSTICS, false);
  const summary = summarize([older, ...tied].reverse());
  assert.deepEqual(summary.events, [...tied, older]);
  assert.deepEqual(summarize([older, ...tied]).events, summary.events);
  // Existing nearest-summary tie behavior remains based on the full input, not on the UI ordering.
  assert.equal(summarize([older, ...tied]).nearestAgeMinutes, 4);
});

test("handler exposes only normalized and currently usable Flash events, excluding rejected and filtered records", async () => {
  const paths: string[] = [];
  const records = [
    xweatherRecord({ longitude: pointAtDistanceKm(2).longitude, type: "ic" }),
    xweatherRecord({ longitude: pointAtDistanceKm(1).longitude, type: "unsupported" }),
    xweatherRecord({ latitude: 999 }),
    { loc: { lat: 0, long: 0 }, ob: {} },
    xweatherRecord({ longitude: pointAtDistanceKm(3).longitude, timestamp: now / 1000 - 301 }),
    xweatherRecord({ longitude: pointAtDistanceKm(41).longitude }),
    xweatherRecord({ timestamp: now / 1000 + 61 }),
  ];
  const result = await handleLiveLightningRequest(origin, {
    clientId: "id", clientSecret: "secret", now: () => now,
    fetcher: async input => {
      const path = new URL(String(input)).pathname;
      paths.push(path);
      return response(path === "/lightning/summary/closest" ? summaryPayload(9) : { success: true, error: null, response: records });
    },
  });
  assert.deepEqual(paths, ["/lightning/summary/closest", "/lightning/flash/closest"]);
  assert.ok(result.body.ok);
  if (!result.body.ok || result.body.summary.current.status !== "active") assert.fail("expected active Flash result");
  const current = result.body.summary.current;
  assert.deepEqual(current.events, [eventAt(1, 0, "unknown"), eventAt(2, 0, "IC")]);
  assert.equal(current.rejectedEventCount, 2);
  assert.equal(current.totalFlashes, 2);
  assert.equal(JSON.stringify(current.events).includes("private-upstream-id"), false);
});

test("network failure is unavailable rather than zero activity", async () => {
  const result = await createXweatherProvider({ clientId: "id", clientSecret: "secret" }, async () => { throw new Error("network failure"); })
    .fetchRecentActivity(0, 0);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.status, "provider-unavailable");
});
