import assert from "node:assert/strict";
import test from "node:test";
import { DatadogClientError } from "./client.ts";
import { handleLogReaderRequest, readLogReaderConfig, LogReaderConfigError } from "./service.ts";

const TEST_TOKEN = "test-log-reader-token";
const authorized = { logReaderToken: TEST_TOKEN, authorizationHeaderValues: [`Bearer ${TEST_TOKEN}`] };

test("health is available without Datadog configuration and makes no provider request", async () => {
  let searchCalls = 0;
  const result = await handleLogReaderRequest("GET", "/health", {
    searchLogs: async () => { searchCalls++; throw new Error("must not run"); },
  });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { status: "healthy" });
  assert.equal(searchCalls, 0);
});

test("defaults to 12 hours and returns structured log payloads and metadata", async () => {
  const now = Date.parse("2026-10-16T12:00:00.000Z");
  const structuredLog = { attributes: { kind: "source_health", recall: { count: 3 }, rollingCandidateShadow: { active: true } } };
  let searchInput: { from: string; to: string; resultCap: number } | undefined;
  const result = await handleLogReaderRequest("GET", "/logs", {
    ...authorized,
    now: () => now,
    searchLogs: async input => { searchInput = input; return { logs: [structuredLog], truncated: false }; },
  });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { requestedHours: 12, returnedCount: 1, truncated: false, logs: [structuredLog] });
  assert.deepEqual(searchInput, {
    from: "2026-10-16T00:00:00.000Z", to: "2026-10-16T12:00:00.000Z", resultCap: 5_000,
  });
});

test("accepts a custom whole-hour range", async () => {
  let requestedHours: string | undefined;
  const result = await handleLogReaderRequest("GET", "/logs?hours=6", {
    ...authorized,
    searchLogs: async input => {
      requestedHours = String((Date.parse(input.to) - Date.parse(input.from)) / 3_600_000);
      return { logs: [], truncated: false };
    },
  });
  assert.equal(result.status, 200);
  assert.equal(requestedHours, "6");
});

for (const hours of ["0", "-1", "1.5", "abc", "49", "1e2", "", "2&hours=3"]) {
  test(`rejects invalid hours input ${JSON.stringify(hours)}`, async () => {
    let searchCalls = 0;
    const result = await handleLogReaderRequest("GET", `/logs?hours=${hours}`, {
      ...authorized,
      searchLogs: async () => { searchCalls++; return { logs: [], truncated: false }; },
    });
    assert.equal(result.status, 400);
    assert.equal(searchCalls, 0);
  });
}

test("rejects user-supplied query and arbitrary search parameters", async () => {
  const searchLogs = async () => ({ logs: [], truncated: false });
  assert.equal((await handleLogReaderRequest("GET", "/logs?query=%2A", { ...authorized, searchLogs })).status, 400);
  assert.equal((await handleLogReaderRequest("GET", "/logs?hours=12&filter=x", { ...authorized, searchLogs })).status, 400);
});

test("does not return credentials or upstream error details", async () => {
  const result = await handleLogReaderRequest("GET", "/logs", {
    ...authorized,
    searchLogs: async () => { throw new Error(`mock values, ${TEST_TOKEN}, Authorization: Bearer ${TEST_TOKEN}`); },
  });
  assert.equal(result.status, 502);
  const body = JSON.stringify(result.body);
  assert.ok(!body.includes("mock values"));
  assert.ok(!body.includes("sensitive upstream body"));
  assert.ok(!body.includes(TEST_TOKEN));
  assert.ok(!body.includes("Authorization"));
});

test("maps client timeout to 504 and upstream failures to 502", async () => {
  const timeout = await handleLogReaderRequest("GET", "/logs", {
    ...authorized,
    searchLogs: async () => { throw new DatadogClientError("timeout"); },
  });
  assert.equal(timeout.status, 504);
  assert.deepEqual(timeout.body, { error: "datadog_timeout" });
  const upstream = await handleLogReaderRequest("GET", "/logs", {
    ...authorized,
    searchLogs: async () => { throw new DatadogClientError("upstream"); },
  });
  assert.equal(upstream.status, 502);
  assert.deepEqual(upstream.body, { error: "datadog_request_failed" });
});

test("missing Datadog variables or token fail startup without revealing values", () => {
  assert.throws(() => readLogReaderConfig({}), error => error instanceof LogReaderConfigError &&
    error.message === "DATADOG_API_KEY, DATADOG_APP_KEY, and LOG_READER_TOKEN are required");
  assert.throws(() => readLogReaderConfig({ DATADOG_API_KEY: "only-api" }), LogReaderConfigError);
  assert.throws(() => readLogReaderConfig({ DATADOG_API_KEY: "api", DATADOG_APP_KEY: "app" }), LogReaderConfigError);
  assert.throws(() => readLogReaderConfig({ DATADOG_API_KEY: "api", DATADOG_APP_KEY: "app", LOG_READER_TOKEN: "  " }), LogReaderConfigError);
  const base = { DATADOG_API_KEY: " api ", DATADOG_APP_KEY: " app ", LOG_READER_TOKEN: ` ${TEST_TOKEN} ` };
  assert.deepEqual(readLogReaderConfig(base), {
    apiKey: "api", appKey: "app", token: TEST_TOKEN, host: "127.0.0.1", port: 3030,
  });
  assert.equal(readLogReaderConfig({ ...base, HOST: "0.0.0.0" }).host, "0.0.0.0");
  for (const host of ["localhost", "::", "192.168.1.2", " 0.0.0.0"]) {
    assert.throws(() => readLogReaderConfig({ ...base, HOST: host }), LogReaderConfigError);
  }
});

test("logs requires one correct bearer token and rejects other credential locations", async () => {
  let searchCalls = 0;
  const searchLogs = async () => { searchCalls++; return { logs: [], truncated: false }; };
  const request = (authorizationHeaderValues?: string[], path = "/logs") => handleLogReaderRequest("GET", path, {
    logReaderToken: TEST_TOKEN, authorizationHeaderValues, searchLogs,
  });
  const missing = await request();
  const malformed = await request([`Basic ${TEST_TOKEN}`]);
  const wrong = await request(["Bearer wrong-token"]);
  const duplicate = await request([`Bearer ${TEST_TOKEN}`, `Bearer ${TEST_TOKEN}`]);
  const query = await request(undefined, `/logs?token=${TEST_TOKEN}`);
  const cookie = await handleLogReaderRequest("GET", "/logs", {
    logReaderToken: TEST_TOKEN, authorizationHeaderValues: [], searchLogs,
  });
  for (const result of [missing, malformed, wrong, duplicate, query, cookie]) {
    assert.equal(result.status, 401);
    assert.deepEqual(result.body, { error: "unauthorized" });
    assert.ok(!JSON.stringify(result.body).includes(TEST_TOKEN));
  }
  assert.equal(searchCalls, 0);
});

test("logs proceeds with the correct bearer token", async () => {
  const result = await handleLogReaderRequest("GET", "/logs?hours=1", {
    ...authorized,
    searchLogs: async input => ({ logs: [{ id: input.from }], truncated: false }),
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.returnedCount, 1);
  assert.ok(!JSON.stringify(result.body).includes(TEST_TOKEN));
});

test("returns method and path errors without querying Datadog", async () => {
  let searchCalls = 0;
  const searchLogs = async () => { searchCalls++; return { logs: [], truncated: false }; };
  assert.equal((await handleLogReaderRequest("POST", "/health", { searchLogs })).status, 405);
  assert.equal((await handleLogReaderRequest("GET", "/admin", { searchLogs })).status, 404);
  assert.equal(searchCalls, 0);
});
