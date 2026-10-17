import assert from "node:assert/strict";
import { request } from "node:http";
import test from "node:test";
import { createObserverHttpServer } from "./http-api.ts";
import { BlitzRecentEventCache } from "./recent-cache.ts";
import type { ObserverEvent } from "./core.ts";

async function withServer(
  token: string | undefined,
  cache: BlitzRecentEventCache,
  check: (get: (path: string, method?: string, suppliedToken?: string) => Promise<{ status: number; body: Record<string, unknown> }>) => Promise<void>,
): Promise<void> {
  const server = createObserverHttpServer(cache, token);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing test server address");
  const get = (path: string, method = "GET", suppliedToken?: string) => new Promise<{ status: number; body: Record<string, unknown> }>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: address.port, path, method,
      headers: suppliedToken ? { "X-Observer-Token": suppliedToken } : {} }, response => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", chunk => { body += chunk; });
      response.on("end", () => resolve({ status: response.statusCode ?? 0, body: JSON.parse(body) }));
    });
    req.on("error", reject);
    req.end();
  });
  try { await check(get); } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
}

const PATH = "/recent?lat=39.92&lon=32.85&radiusKm=100&windowMinutes=1";

test("localhost API returns a bounded in-memory Blitz response with no upstream request", async () => {
  const cache = new BlitzRecentEventCache();
  const now = Date.now();
  cache.setObservationActive(true, now - 5 * 60_000);
  cache.insert({ source: "blitzortung", observerEventId: "blitz-1", sourceServer: "ws7",
    eventTimeMs: now - 1_000, receivedAtMs: now, latitude: 39.92, longitude: 32.85,
    latencyMs: 1_000, transportComparisonEligible: true } as ObserverEvent, now);
  await withServer("test-secret", cache, async get => {
    assert.deepEqual(await get("/health"), { status: 200, body: { ok: true, observer: "dual_source_shadow" } });
    assert.equal((await get(PATH)).status, 401);
    assert.equal((await get(PATH, "GET", "wrong")).status, 401);
    const { status, body } = await get(PATH, "GET", "test-secret");
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.source, "blitzortung");
    assert.deepEqual(body.query, { latitude: 39.92, longitude: 32.85, radiusKm: 100, windowMinutes: 1 });
    assert.deepEqual(body.coverage, {
      complete: true, usable: true, requestedWindowMinutes: 1,
      coverageStartMs: now - 5 * 60_000, toleratedGapMs: 0,
    });
    assert.equal(typeof body.fetchedAt, "number");
    assert.deepEqual(body.events, [{ observerEventId: "blitz-1", sourceServer: "ws7",
      eventTimeMs: now - 1_000, receivedAtMs: now, latitude: 39.92, longitude: 32.85,
      latencyMs: 1_000, transportComparisonEligible: true, distanceKm: 0 }]);
  });
});

test("invalid coordinates, radius, window, duplicate and unknown parameters fail locally", async () => {
  await withServer("test-secret", new BlitzRecentEventCache(), async get => {
    for (const query of [
      "lat=91&lon=32&radiusKm=10&windowMinutes=15", "lat=nope&lon=32&radiusKm=10&windowMinutes=15",
      "lat=39&lon=-181&radiusKm=10&windowMinutes=15", "lat=39&lon=32&radiusKm=0&windowMinutes=15",
      "lat=39&lon=32&radiusKm=251&windowMinutes=15", "lat=39&lon=32&radiusKm=10&windowMinutes=0",
      "lat=39&lon=32&radiusKm=10&windowMinutes=16", "lat=39&lon=32&radiusKm=10&windowMinutes=oops",
      "lat=0x28&lon=32&radiusKm=10&windowMinutes=15",
      "lat=39&lon=32&radiusKm=10&windowMinutes=15&lat=40",
      "lat=39&lon=32&radiusKm=10&windowMinutes=15&extra=yes",
    ]) assert.equal((await get(`/recent?${query}`, "GET", "test-secret")).status, 400, query);
    assert.equal((await get(PATH, "POST", "test-secret")).status, 405);
    assert.equal((await get("/other", "GET", "test-secret")).status, 404);
  });
  await withServer(undefined, new BlitzRecentEventCache(), async get => {
    assert.equal((await get(PATH, "GET", "anything")).status, 503);
    assert.equal((await get("/health")).status, 200);
  });
});

test("a cache read failure returns 500 for one request; subsequent health requests still work", async () => {
  const cache = new BlitzRecentEventCache();
  cache.query = () => { throw new Error("test cache failure"); };
  await withServer("test-secret", cache, async get => {
    assert.deepEqual(await get(PATH, "GET", "test-secret"),
      { status: 500, body: { ok: false, error: "request_failed" } });
    assert.equal((await get("/health")).status, 200);
  });
});
