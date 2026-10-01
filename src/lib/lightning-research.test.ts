import assert from "node:assert/strict";
import test from "node:test";
import { EMPTY_PROVIDER_DIAGNOSTICS } from "./lightning/types.ts";
import {
  buildXweatherResearchUrl,
  handleXweatherResearchRequest,
  parseXweatherFlashResearch,
  parseXweatherSummaryResearch,
} from "./lightning/xweather-research.ts";

const now = Date.UTC(2026, 8, 30, 12, 0, 0);

function response(payload: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json", ...headers } });
}

function summaryPayload(count = 3) {
  return {
    success: true,
    error: null,
    response: {
      summary: {
        range: {
          count,
          fromTimestamp: now / 1000 - 900,
          toTimestamp: now / 1000,
          minTimestamp: count ? now / 1000 - 720 : null,
          maxTimestamp: count ? now / 1000 - 60 : null,
        },
        pulse: { count, cg: count > 0 ? 1 : 0, ic: count > 0 ? count - 1 : 0 },
      },
    },
  };
}

test("research URLs keep credentials server-side and use endpoint-specific radius and time parameters", () => {
  const credentials = { clientId: "private-id", clientSecret: "private-secret" };
  const summary = buildXweatherResearchUrl({ latitude: 36.3, longitude: 30.15, mode: "summary-15m" }, credentials);
  assert.equal(summary.pathname, "/lightning/summary/closest");
  assert.equal(summary.searchParams.get("radius"), "50km");
  assert.equal(summary.searchParams.get("from"), "-15minutes");
  assert.equal(summary.searchParams.get("to"), "now");

  const defaultSummary = buildXweatherResearchUrl({ latitude: 36.3, longitude: 30.15, mode: "summary-default" }, credentials);
  assert.equal(defaultSummary.searchParams.has("from"), false);
  assert.equal(defaultSummary.searchParams.has("to"), false);

  const flash = buildXweatherResearchUrl({ latitude: 36.3, longitude: 30.15, mode: "flash-5m" }, credentials);
  assert.equal(flash.pathname, "/lightning/flash/closest");
  assert.equal(flash.searchParams.get("radius"), "40km");
  assert.equal(flash.searchParams.get("limit"), "1000");
});

test("summary research parses aggregate counts and reported time range", () => {
  const result = parseXweatherSummaryResearch(summaryPayload(), "summary-15m", now, EMPTY_PROVIDER_DIAGNOSTICS);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.dataKind, "aggregate-summary");
  assert.equal(result.requestedWindowMinutes, 15);
  assert.equal(result.returnedCount, 3);
  assert.deepEqual(result.pulseCounts, { total: 3, cloudToGround: 1, intracloud: 2 });
  assert.equal(result.actualRangeFrom, now - 15 * 60_000);
  assert.equal(result.oldestEventAt, now - 12 * 60_000);
  assert.equal(result.newestEventAt, now - 60_000);
});

test("summary research accepts the documented action-dependent single-item response array", () => {
  const payload = summaryPayload();
  const result = parseXweatherSummaryResearch({ ...payload, response: [payload.response] }, "summary-30m", now, EMPTY_PROVIDER_DIAGNOSTICS);
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.returnedCount, 3);
});

test("healthy zero summary is distinct from provider rejection", () => {
  const zero = parseXweatherSummaryResearch(summaryPayload(0), "summary-default", now, EMPTY_PROVIDER_DIAGNOSTICS);
  assert.equal(zero.ok, true);
  if (zero.ok) {
    assert.equal(zero.returnedCount, 0);
    assert.equal(zero.oldestEventAt, null);
  }

  const rejected = parseXweatherSummaryResearch({ success: false, error: { code: "insufficient_scope" }, response: [] }, "summary-30m", now, EMPTY_PROVIDER_DIAGNOSTICS);
  assert.equal(rejected.ok, false);
  if (!rejected.ok) {
    assert.equal(rejected.status, "provider-auth-error");
    assert.equal(rejected.providerCode, "insufficient_scope");
  }
});

test("flash research returns only normalized counts and time bounds", () => {
  const result = parseXweatherFlashResearch({
    success: true,
    error: null,
    response: [
      { id: "private-a", loc: { lat: 36.3, long: 30.15 }, ob: { timestamp: now / 1000 - 120 } },
      { id: "private-b", loc: { lat: 36.4, long: 30.2 }, ob: { timestamp: now / 1000 - 30 } },
    ],
  }, now, EMPTY_PROVIDER_DIAGNOSTICS);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.returnedCount, 2);
  assert.equal(result.oldestEventAt, now - 120_000);
  assert.equal(result.newestEventAt, now - 30_000);
  assert.equal(JSON.stringify(result).includes("private-a"), false);
  assert.equal(JSON.stringify(result).includes("latitude"), false);
});

test("research handler makes one no-store request and does not expose credentials", async () => {
  let calls = 0;
  let requestedUrl: URL | null = null;
  const result = await handleXweatherResearchRequest({ latitude: 36.3, longitude: 30.15, mode: "summary-30m" }, {
    clientId: "private-id",
    clientSecret: "private-secret",
    now: () => now,
    fetcher: async (input, init) => {
      calls += 1;
      requestedUrl = new URL(String(input));
      assert.equal(init?.cache, "no-store");
      return response(summaryPayload(), 200, {
        "X-Cost-Tokens": "4",
        "X-Cost-Multipliers": "endpoint=1; spatial=1; temporal=4",
      });
    },
  });
  assert.equal(calls, 1);
  assert.equal(requestedUrl!.searchParams.get("client_secret"), "private-secret");
  assert.equal(result.httpStatus, 200);
  assert.equal(JSON.stringify(result.body).includes("private-secret"), false);
  assert.equal(JSON.stringify(result.body).includes('"costTokens":"4"'), true);
});

test("invalid research input and missing credentials never call upstream", async () => {
  let calls = 0;
  const fetcher = async () => { calls += 1; throw new Error("must not run"); };
  const invalid = await handleXweatherResearchRequest({ latitude: 91, longitude: 0, mode: "summary-15m" }, { clientId: "id", clientSecret: "secret", fetcher });
  const unconfigured = await handleXweatherResearchRequest({ latitude: 0, longitude: 0, mode: "flash-5m" }, { fetcher });
  assert.equal(invalid.httpStatus, 400);
  assert.equal(unconfigured.httpStatus, 503);
  assert.equal(calls, 0);
});
