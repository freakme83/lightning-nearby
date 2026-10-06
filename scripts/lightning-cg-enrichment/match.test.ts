import assert from "node:assert/strict";
import test from "node:test";
import { readdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_THRESHOLDS, matchLightningEvents, resolveThresholds, validateReference } from "./match.ts";
import { buildXweatherUrl, enrichIncidentWithLightningType, parseCostDiagnostics, parseXweatherPayload } from "./xweather.ts";
import { parseCli } from "./runner.ts";
import type { EnrichmentReference, XweatherLightningEvent } from "./types.ts";

const reference: EnrichmentReference = { latitude: 39.1, longitude: 32.9, eventTimeMs: 1_800_000_000_000 };
function event(id: string, type: "cg" | "ic", patch: Partial<XweatherLightningEvent> = {}): XweatherLightningEvent {
  return { id, type, latitude: 39.1, longitude: 32.9, eventTimeMs: reference.eventTimeMs, ...patch };
}
function classify(events: XweatherLightningEvent[], options = {}) {
  const thresholds = resolveThresholds(options);
  return matchLightningEvents(reference, events, thresholds);
}

test("matching CG event returns cg_verified", () => {
  const result = classify([event("cg1", "cg")]);
  assert.equal(result.status, "cg_verified");
  assert.equal(result.match?.id, "cg1");
});

test("matched IC events alone return ic_only", () => {
  const result = classify([event("ic1", "ic")]);
  assert.equal(result.status, "ic_only");
  assert.equal(result.counts?.matchedIc, 1);
});

test("CG outside temporal threshold is not verified", () => {
  const result = classify([event("old-cg", "cg", { eventTimeMs: reference.eventTimeMs + 300_001 })]);
  assert.equal(result.status, "no_match");
  assert.equal(result.counts?.matchedCg, 0);
});

test("CG outside spatial threshold is not verified", () => {
  const result = classify([event("far-cg", "cg", { longitude: 33.0 })]);
  assert.equal(result.status, "no_match");
});

test("matched CG and IC returns cg_verified and both counts", () => {
  const result = classify([event("ic1", "ic"), event("cg1", "cg")]);
  assert.equal(result.status, "cg_verified");
  assert.deepEqual(result.counts, { returned: 2, matched: 2, matchedCg: 1, matchedIc: 1 });
});

test("multiple matching CG events choose deterministic best candidate independent of input order", () => {
  const a = event("later-close", "cg", { eventTimeMs: reference.eventTimeMs + 50_000, longitude: 32.901 });
  const b = event("earlier-far", "cg", { eventTimeMs: reference.eventTimeMs + 20_000, longitude: 32.95 });
  assert.equal(classify([a, b]).match?.id, "earlier-far");
  assert.equal(classify([b, a]).match?.id, "earlier-far");
});

test("candidate ranking ties by time difference, then distance, then ID", () => {
  const farther = event("a-far", "cg", { longitude: 32.95 });
  const nearer = event("z-near", "cg", { longitude: 32.91 });
  assert.equal(classify([farther, nearer]).match?.id, "z-near");
  const lexicalA = event("a-id", "cg", { longitude: 32.91 });
  const lexicalB = event("b-id", "cg", { longitude: 32.91 });
  assert.equal(classify([lexicalB, lexicalA]).match?.id, "a-id");
  const closerTime = event("later-time", "cg", { eventTimeMs: reference.eventTimeMs + 1, longitude: 32.95 });
  assert.equal(classify([nearer, closerTime]).match?.id, "z-near");
});

test("successful empty provider response returns no_match", () => {
  const parsed = parseXweatherPayload({ success: true, response: [] });
  assert.equal(matchLightningEvents(reference, parsed.events, DEFAULT_THRESHOLDS).status, "no_match");
});

test("network failure is provider_unavailable without leaking thrown text", async () => {
  const result = await enrichIncidentWithLightningType(reference, {}, {
    env: { XWEATHER_CLIENT_ID: "hidden-id", XWEATHER_CLIENT_SECRET: "hidden-secret" },
    fetch: async () => { throw new Error("https://data.api.xweather.com/?client_secret=hidden-secret"); },
  });
  assert.equal(result.status, "provider_unavailable");
  assert.equal(result.failure, "network_error");
  assert.equal(JSON.stringify(result).includes("hidden-secret"), false);
});

test("one enrichment invocation makes exactly one provider request", async () => {
  let calls = 0;
  const result = await enrichIncidentWithLightningType(reference, {}, {
    env: { XWEATHER_CLIENT_ID: "id", XWEATHER_CLIENT_SECRET: "secret" },
    fetch: async () => { calls++; return new Response(JSON.stringify({ success: true, response: [] }), { status: 200 }); },
  });
  assert.equal(calls, 1);
  assert.equal(result.status, "no_match");
});

test("malformed provider payload is provider_unavailable", async () => {
  const result = await enrichIncidentWithLightningType(reference, {}, {
    env: { XWEATHER_CLIENT_ID: "id", XWEATHER_CLIENT_SECRET: "secret" },
    fetch: async () => new Response(JSON.stringify({ success: true, response: { nope: true } }), { status: 200 }),
  });
  assert.equal(result.status, "provider_unavailable");
  assert.equal(result.failure, "malformed_response");
});

test("missing peakamp does not invalidate an otherwise valid event", () => {
  const parsed = parseXweatherPayload({ success: true, response: [{ id: "cg", loc: { lat: 39.1, long: 32.9 },
    ob: { timestampMS: reference.eventTimeMs, pulse: { type: "cg", numSensors: 4 } } }] });
  assert.equal(parsed.events[0].peakAmp, undefined);
  assert.equal(classify(parsed.events).status, "cg_verified");
});

test("missing numSensors does not invalidate an otherwise valid event", () => {
  const parsed = parseXweatherPayload({ success: true, response: [{ id: "cg", loc: { lat: 39.1, long: 32.9 },
    ob: { timestampMS: reference.eventTimeMs, pulse: { type: "cg", peakamp: 20 } } }] });
  assert.equal(parsed.events[0].numSensors, undefined);
  assert.equal(classify(parsed.events).status, "cg_verified");
});

test("pulse type is normalized to lowercase", () => {
  const parsed = parseXweatherPayload({ success: true, response: [{ id: "CG", loc: { lat: 39.1, long: 32.9 },
    ob: { timestampMS: reference.eventTimeMs, pulse: { type: "CG" } } }] });
  assert.equal(parsed.events[0].type, "cg");
});

test("invalid latitude and longitude are rejected", () => {
  assert.throws(() => validateReference({ ...reference, latitude: 91 }));
  assert.throws(() => validateReference({ ...reference, longitude: 181 }));
});

test("invalid event time is rejected", () => {
  assert.throws(() => validateReference({ ...reference, eventTimeMs: Number.NaN }));
  assert.throws(() => validateReference({ ...reference, eventTimeMs: 1.5 }));
});

test("invalid radius, distance, time threshold, and result limit are rejected", () => {
  assert.throws(() => resolveThresholds({ radiusKm: 0 }));
  assert.throws(() => resolveThresholds({ maxMatchDistanceKm: 11 }));
  assert.throws(() => resolveThresholds({ maxTimeDifferenceMs: -1 }));
  assert.throws(() => resolveThresholds({ limit: 11 }));
});

test("cost and rate-limit headers are parsed when present", () => {
  const cost = parseCostDiagnostics(new Headers({ "X-Cost-Tokens": "10", "X-Cost-Multipliers": "endpoint=10; spatial=1; temporal=1",
    "X-Cost-Endpoint": "10", "X-Ratelimit-Remaining": "98" }));
  assert.equal(cost.tokens, 10);
  assert.equal(cost.multipliers, "endpoint=10; spatial=1; temporal=1");
  assert.equal(cost.endpoint, "10");
  assert.equal(cost.rateLimit?.["x-ratelimit-remaining"], "98");
});

test("missing cost headers do not prevent enrichment", () => {
  const parsed = parseXweatherPayload({ success: true, response: [] });
  assert.deepEqual(parsed.cost, {});
  assert.equal(matchLightningEvents(reference, parsed.events, DEFAULT_THRESHOLDS, parsed.cost).status, "no_match");
});

test("provider errors do not serialize credentials", async () => {
  const id = "private-client-id";
  const secret = "private-client-secret";
  const result = await enrichIncidentWithLightningType(reference, {}, {
    env: { XWEATHER_CLIENT_ID: id, XWEATHER_CLIENT_SECRET: secret },
    fetch: async () => new Response("forbidden", { status: 401 }),
  });
  assert.equal(result.failure, "http_error");
  assert.equal(JSON.stringify(result).includes(id), false);
  assert.equal(JSON.stringify(result).includes(secret), false);
});

test("timestamp seconds fallback parses, and event details remain diagnostic only", () => {
  const parsed = parseXweatherPayload({ success: true, response: [{ id: "cg", loc: { lat: 39.1, long: 32.9 },
    ob: { timestamp: reference.eventTimeMs / 1000, pulse: { type: "cg", peakamp: 99, numSensors: 7 } } }] });
  assert.equal(parsed.events[0].eventTimeMs, reference.eventTimeMs);
  assert.equal(parsed.events[0].peakAmp, 99);
  assert.equal(parsed.events[0].numSensors, 7);
});

test("outside time and distance candidate is not counted as a match", () => {
  const result = classify([event("unmatched", "ic", { eventTimeMs: reference.eventTimeMs + 900_000, longitude: 33.2 })]);
  assert.deepEqual(result.counts, { returned: 1, matched: 0, matchedCg: 0, matchedIc: 0 });
  assert.equal(result.status, "no_match");
});

test("Xweather unavailable response remains distinct from healthy empty data", async () => {
  const result = await enrichIncidentWithLightningType(reference, {}, { env: {}, fetch: fetch });
  assert.equal(result.status, "provider_unavailable");
  assert.equal(result.failure, "missing_credentials");
  assert.equal(classify([]).status, "no_match");
});

test("manual request URL uses closest, coordinates, small limit, and query-string auth", () => {
  const url = buildXweatherUrl(reference, 10, 3, { clientId: "id value", clientSecret: "secret&value" });
  assert.equal(url.pathname, "/lightning/closest");
  assert.equal(url.searchParams.get("p"), "39.1,32.9");
  assert.equal(url.searchParams.get("radius"), "10km");
  assert.equal(url.searchParams.get("limit"), "3");
  assert.equal(url.searchParams.get("filter"), "all");
  assert.equal(url.searchParams.get("client_id"), "id value");
  assert.equal(url.searchParams.get("client_secret"), "secret&value");
});

test("CLI requires explicit coordinates and time and accepts epoch milliseconds", () => {
  assert.throws(() => parseCli(["--lat=39.1", "--lon=32.9"]));
  const parsed = parseCli(["--lat=39.1", "--lon=32.9", "--time=1800000000000"]);
  assert.equal(parsed.reference.eventTimeMs, 1_800_000_000_000);
});

test("CLI accepts an ISO time and validated optional controls", () => {
  const parsed = parseCli(["--lat=39.1", "--lon=32.9", "--time=2027-01-15T12:00:00Z",
    "--radius-km=10", "--max-distance-km=8", "--max-age-minutes=5", "--limit=5"]);
  assert.equal(parsed.reference.eventTimeMs, Date.parse("2027-01-15T12:00:00Z"));
  assert.deepEqual(parsed.options, { radiusKm: 10, maxMatchDistanceKm: 8, maxTimeDifferenceMs: 300_000, limit: 5 });
});

test("CLI rejects unknown, duplicate, malformed, and silently defaulted arguments", () => {
  assert.throws(() => parseCli(["--lat=39.1", "--lon=32.9", "--time=1800000000000", "--unknown=x"]));
  assert.throws(() => parseCli(["--lat=39.1", "--lat=39.2", "--lon=32.9", "--time=1800000000000"]));
  assert.throws(() => parseCli(["--lat=39.1", "--lon=32.9", "--time=bad"]));
  assert.throws(() => parseCli(["--lat=39.1", "--lon=32.9", "--time=1800000000000", "--limit=11"]));
});

test("production source does not import or reference the research adapter", async () => {
  const srcRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../src");
  const pending = [srcRoot];
  while (pending.length) {
    const directory = pending.pop()!;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (/\.tsx?$/.test(entry.name)) {
        const source = await readFile(path, "utf8");
        assert.equal(/lightning-cg-enrichment|enrichIncidentWithLightningType/.test(source), false, `${path} references research adapter`);
      }
    }
  }
});
