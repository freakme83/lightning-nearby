import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { handleBlitzExperimentalRequest, BLITZ_OBSERVER_REQUEST_TIMEOUT_MS } from "./blitz-experimental.ts";
import { LIVE_CURRENT_EVENT_LIMIT } from "./types.ts";
import { POST } from "../../app/api/lightning/blitz-experimental/route.ts";

const baseUrl = "https://observer.example/internal";
const token = "private-token";
const location = { latitude: 0, longitude: 0 };
const fetchedAt = 1_790_000_000_000;
const coverage = (windowMinutes: number, complete = true, usable = true) => ({
  complete, usable, requestedWindowMinutes: windowMinutes,
  coverageStartMs: fetchedAt - 900_000, toleratedGapMs: complete ? 0 : 12_000,
});
const event = (latitude = 0, longitude = 0, time = fetchedAt - 60_000) => ({
  eventTimeMs: time, receivedAtMs: fetchedAt, latitude, longitude, distanceKm: 0,
  latencyMs: fetchedAt - time, transportComparisonEligible: true,
  observerEventId: "private-id", sourceServer: "ws1", mds: 5,
});
function reply(windowMinutes: number, radiusKm: number, events: object[] = [], complete = true, usable = true) {
  return { ok: true, source: "blitzortung", fetchedAt,
    query: { ...location, radiusKm, windowMinutes }, coverage: coverage(windowMinutes, complete, usable), events };
}
function mock(recent: object, current: object, verify?: (url: URL, init: RequestInit) => void): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    verify?.(url, init ?? {});
    return Response.json(url.searchParams.get("windowMinutes") === "15" ? recent : current);
  }) as typeof fetch;
}
function options(fetcher: typeof fetch) { return { baseUrl, token, fetcher }; }

test("two fixed observer reads, token, no-store and normalized active summaries", async () => {
  const seen: string[] = [];
  const result = await handleBlitzExperimentalRequest(location, options(mock(
    reply(15, 50, [event(0, 0, fetchedAt - 120_000), event(0, 0, fetchedAt - 30_000)]),
    reply(5, 40, [event(0, 0.09), event(0.09, 0), event(0, 0)]),
    (url, init) => {
      seen.push(`${url.pathname}?${url.searchParams.get("radiusKm")}/${url.searchParams.get("windowMinutes")}`);
      assert.equal(url.origin, "https://observer.example");
      assert.equal(init.method, "GET");
      assert.equal(init.cache, "no-store");
      assert.equal((init.headers as Record<string, string>)["X-Observer-Token"], token);
    })));
  assert.deepEqual(seen, ["/recent?50/15", "/recent?40/5"]);
  assert.equal(result.httpStatus, 200);
  assert.equal(result.body.ok, true);
  if (!result.body.ok) return;
  const { recent, current } = result.body.summary;
  assert.equal(recent.status, "active");
  assert.deepEqual([recent.totalDetections, recent.oldestEventAt, recent.newestEventAt], [2, fetchedAt - 120_000, fetchedAt - 30_000]);
  assert.deepEqual(recent.coverage, coverage(15));
  assert.equal(current.status, "active");
  assert.equal(current.totalDetections, 3);
  assert.deepEqual(current.counts, { within5Km: 1, within10Km: 1, within25Km: 3, within40Km: 3 });
  assert.equal(current.nearestKm, 0);
  assert.equal(current.nearestDirection, null);
  assert.equal(current.nearestAgeMinutes, 1);
  assert.equal(current.latestEventAt, fetchedAt - 60_000);
  assert.deepEqual(current.events[0], { observedAtMs: fetchedAt - 60_000, latitude: 0, longitude: 0, type: "unknown" });
  assert.equal(JSON.stringify(result.body).includes("private-id"), false);
  assert.equal(JSON.stringify(result.body).includes(token), false);
});

test("nearest bearing, distance and age use the full event set", async () => {
  const result = await handleBlitzExperimentalRequest(location, options(mock(reply(15, 50), reply(5, 40, [event(0, 0.09)]))));
  assert.equal(result.body.ok, true);
  if (!result.body.ok) return;
  assert.equal(result.body.summary.current.nearestDirection, "E");
  assert.ok(Math.abs(result.body.summary.current.nearestKm! - 10.00756) < 0.01);
  assert.equal(result.body.summary.current.nearestAgeMinutes, 1);
});

test("clear requires strict completeness for each independent window", async () => {
  for (const [complete, usable, expected] of [[true, true, "clear"], [false, false, "unknown"], [false, true, "unknown"]] as const) {
    const result = await handleBlitzExperimentalRequest(location, options(mock(
      reply(15, 50, [], complete, usable), reply(5, 40, [], complete, usable))));
    assert.equal(result.body.ok, true);
    if (!result.body.ok) continue;
    assert.equal(result.body.summary.recent.status, expected);
    assert.equal(result.body.summary.current.status, expected);
    assert.equal(result.body.summary.current.coverage.usable, usable);
  }
  const mixed = await handleBlitzExperimentalRequest(location, options(mock(
    reply(15, 50, [event()], false, true), reply(5, 40, [], true, true))));
  assert.equal(mixed.body.ok, true);
  if (mixed.body.ok) {
    assert.equal(mixed.body.summary.recent.status, "active");
    assert.equal(mixed.body.summary.recent.coverage.complete, false);
    assert.equal(mixed.body.summary.current.status, "clear");
  }
});

test("current events remain bounded while counts include every returned delivery", async () => {
  const events = Array.from({ length: LIVE_CURRENT_EVENT_LIMIT + 4 }, (_, index) => event(0, index * 0.001));
  const result = await handleBlitzExperimentalRequest(location, options(mock(reply(15, 50), reply(5, 40, events, false, true))));
  assert.equal(result.body.ok, true);
  if (!result.body.ok) return;
  assert.equal(result.body.summary.current.events.length, LIVE_CURRENT_EVENT_LIMIT);
  assert.equal(result.body.summary.current.totalDetections, events.length);
  assert.equal(result.body.summary.current.status, "active");
  assert.equal(result.body.summary.current.coverage.complete, false);
});

test("invalid event, coverage, query and JSON are malformed, never clear", async () => {
  const badReplies = [
    reply(15, 50, [{ ...event(), latitude: Infinity }]),
    reply(15, 50, [{ ...event(), eventTimeMs: "bad" }]),
    { ...reply(15, 50), coverage: { ...coverage(15), toleratedGapMs: -1 } },
    { ...reply(15, 50), coverage: { ...coverage(15), usable: "true" } },
    { ...reply(15, 50), query: { ...location, radiusKm: 100, windowMinutes: 15 } },
  ];
  for (const recent of badReplies) {
    const result = await handleBlitzExperimentalRequest(location, options(mock(recent, reply(5, 40))));
    assert.deepEqual([result.httpStatus, result.body.ok ? "ok" : result.body.status], [502, "malformed-response"]);
  }
  const invalidJson = (async () => new Response("bad JSON", { status: 200 })) as typeof fetch;
  const invalid = await handleBlitzExperimentalRequest(location, options(invalidJson));
  assert.equal(invalid.body.ok ? "ok" : invalid.body.status, "malformed-response");
  const badCurrent = await handleBlitzExperimentalRequest(location, options(mock(reply(15, 50), reply(5, 40, [{ ...event(), longitude: 181 }]))));
  assert.equal(badCurrent.body.ok ? "ok" : badCurrent.body.status, "malformed-response");
});

test("upstream auth, 5xx, network failure and timeout are contained without retry", async () => {
  for (const [status, expected] of [[401, "provider-auth-error"], [503, "provider-unavailable"], [500, "provider-unavailable"]] as const) {
    let calls = 0;
    const fetcher = (async () => { calls++; return new Response(null, { status }); }) as typeof fetch;
    const result = await handleBlitzExperimentalRequest(location, options(fetcher));
    assert.equal(result.body.ok ? "ok" : result.body.status, expected);
    assert.equal(calls, 1);
  }
  const network = (async () => { throw new Error("network"); }) as typeof fetch;
  const result = await handleBlitzExperimentalRequest(location, options(network));
  assert.equal(result.body.ok ? "ok" : result.body.status, "provider-unavailable");
  let calls = 0;
  const hangs = ((_: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_, reject) => {
    calls++;
    init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  })) as typeof fetch;
  const before = Date.now();
  const timed = await handleBlitzExperimentalRequest(location, options(hangs));
  assert.equal(timed.body.ok ? "ok" : timed.body.status, "provider-unavailable");
  assert.equal(calls, 1);
  assert.ok(Date.now() - before >= BLITZ_OBSERVER_REQUEST_TIMEOUT_MS - 100);
});

test("configuration and client validation short circuit HTTP; route returns 400 no-store", async () => {
  let calls = 0;
  const fetcher = (async () => { calls++; throw new Error("unexpected"); }) as typeof fetch;
  for (const body of [null, {}, { latitude: 91, longitude: 0 }, { latitude: 0, longitude: NaN }, { latitude: 0, longitude: -181 }]) {
    const result = await handleBlitzExperimentalRequest(body, options(fetcher));
    assert.equal(result.httpStatus, 400);
  }
  const unconfigured = await handleBlitzExperimentalRequest(location, { fetcher });
  assert.equal(unconfigured.body.ok ? "ok" : unconfigured.body.status, "provider-not-configured");
  assert.equal(calls, 0);
  const response = await POST(new Request("http://localhost/api/lightning/blitz-experimental", {
    method: "POST", body: JSON.stringify({ latitude: 100, longitude: 0 }),
  }));
  assert.equal(response.status, 400);
  assert.match(response.headers.get("Cache-Control") ?? "", /no-store/);
});

test("experimental route reads server configuration and emits a private no-store response", async () => {
  const previousFetch = globalThis.fetch;
  const previousBase = process.env.BLITZ_OBSERVER_API_BASE_URL;
  const previousToken = process.env.BLITZ_OBSERVER_API_TOKEN;
  const calls: string[] = [];
  try {
    process.env.BLITZ_OBSERVER_API_BASE_URL = baseUrl;
    process.env.BLITZ_OBSERVER_API_TOKEN = token;
    globalThis.fetch = mock(reply(15, 50), reply(5, 40), (url, init) => {
      calls.push(url.pathname);
      assert.equal((init.headers as Record<string, string>)["X-Observer-Token"], token);
    });
    const response = await POST(new Request("http://localhost/api/lightning/blitz-experimental", {
      method: "POST", body: JSON.stringify(location),
    }));
    assert.equal(response.status, 200);
    assert.match(response.headers.get("Cache-Control") ?? "", /no-store/);
    const body = await response.json();
    assert.equal(body.summary.recent.status, "clear");
    assert.equal(JSON.stringify(body).includes(token), false);
    assert.deepEqual(calls, ["/recent", "/recent"]);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousBase === undefined) delete process.env.BLITZ_OBSERVER_API_BASE_URL;
    else process.env.BLITZ_OBSERVER_API_BASE_URL = previousBase;
    if (previousToken === undefined) delete process.env.BLITZ_OBSERVER_API_TOKEN;
    else process.env.BLITZ_OBSERVER_API_TOKEN = previousToken;
  }
});

test("new adapter and route have no provider protocol, WebSocket or production lifecycle imports", () => {
  const source = readFileSync(new URL("./blitz-experimental.ts", import.meta.url), "utf8");
  const route = readFileSync(new URL("../../app/api/lightning/blitz-experimental/route.ts", import.meta.url), "utf8");
  for (const text of [source, route]) {
    assert.doesNotMatch(text, /from\s+["'][^"']*(?:research|worker|xweather|supabase|telegram|publisher|protocol|decoder)[^"']*["']/i);
    assert.doesNotMatch(text, /new\s+WebSocket|blitzortung\.org|lightningmaps\.org|NEXT_PUBLIC_/);
  }
  assert.match(source, /fetcher\(requestUrl/);
  assert.match(source, /new URL\("\/recent", url\)/);
});
