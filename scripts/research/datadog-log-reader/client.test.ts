import assert from "node:assert/strict";
import test from "node:test";
import {
  DATADOG_LOGS_SEARCH_URL,
  DATADOG_QUERY,
  DatadogClientError,
  MAX_LOG_RESULTS,
  searchDatadogLogs,
} from "./client.ts";

const credentials = { apiKey: "api-key-test-only", appKey: "app-key-test-only" };
const range = { from: "2026-10-16T00:00:00.000Z", to: "2026-10-16T12:00:00.000Z" };

function page(data: unknown[], after?: string): Response {
  return Response.json({ data, meta: { page: { after: after ?? null } } });
}

test("sends fixed EU Logs Search request, auth headers, descending sort, and preserves structured logs", async () => {
  let requestUrl = "";
  let request: RequestInit | undefined;
  const structuredLog = { id: "abc", attributes: { message: "hello", kind: "source_health", sourceHealthy: true, nested: { count: 2 } } };
  const result = await searchDatadogLogs({
    ...credentials, ...range,
    fetcher: async (input, init) => { requestUrl = String(input); request = init; return page([structuredLog]); },
  });
  assert.equal(requestUrl, DATADOG_LOGS_SEARCH_URL);
  assert.equal(request?.method, "POST");
  const headers = new Headers(request?.headers);
  assert.equal(headers.get("DD-API-KEY"), credentials.apiKey);
  assert.equal(headers.get("DD-APPLICATION-KEY"), credentials.appKey);
  const body = JSON.parse(String(request?.body));
  assert.deepEqual(body, {
    filter: { query: DATADOG_QUERY, from: range.from, to: range.to },
    sort: "-timestamp",
    page: { limit: 1_000 },
  });
  assert.deepEqual(result, { logs: [structuredLog], truncated: false });
});

test("follows meta.page.after as the next page cursor", async () => {
  const requests: Record<string, unknown>[] = [];
  const result = await searchDatadogLogs({
    ...credentials, ...range, resultCap: 3,
    fetcher: async (_input, init) => {
      const body = JSON.parse(String(init?.body));
      requests.push(body);
      return requests.length === 1 ? page([{ id: 1 }], "cursor-one") : page([{ id: 2 }]);
    },
  });
  assert.equal((requests[0].page as Record<string, unknown>).cursor, undefined);
  assert.equal((requests[1].page as Record<string, unknown>).cursor, "cursor-one");
  assert.deepEqual(result.logs.map(log => log.id), [1, 2]);
  assert.equal(result.truncated, false);
});

test("marks results truncated when the local cap is reached and another cursor exists", async () => {
  let calls = 0;
  const result = await searchDatadogLogs({
    ...credentials, ...range, resultCap: 2,
    fetcher: async () => { calls++; return page([{ id: 1 }, { id: 2 }], "more-results"); },
  });
  assert.equal(calls, 1);
  assert.deepEqual(result.logs.map(log => log.id), [1, 2]);
  assert.equal(result.truncated, true);
});

test("caps requested results at 5,000 even if a caller asks for more", async () => {
  const requestedLimits: number[] = [];
  let calls = 0;
  const result = await searchDatadogLogs({
    ...credentials, ...range, resultCap: 50_000,
    fetcher: async (_input, init) => {
      calls++;
      requestedLimits.push(JSON.parse(String(init?.body)).page.limit);
      return page(Array.from({ length: 1_000 }, (_, index) => ({ id: (calls - 1) * 1_000 + index })), `cursor-${calls}`);
    },
  });
  assert.equal(MAX_LOG_RESULTS, 5_000);
  assert.deepEqual(requestedLimits, [1_000, 1_000, 1_000, 1_000, 1_000]);
  assert.equal(calls, 5);
  assert.equal(result.logs.length, MAX_LOG_RESULTS);
  assert.equal(result.truncated, true);
});

test("times out a stalled Datadog request", async () => {
  await assert.rejects(searchDatadogLogs({
    ...credentials, ...range, timeoutMs: 5,
    fetcher: (_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }),
  }), error => error instanceof DatadogClientError && error.code === "timeout");
});

test("timeout remains active while reading the Datadog response body", async () => {
  await assert.rejects(searchDatadogLogs({
    ...credentials, ...range, timeoutMs: 5,
    fetcher: async () => ({
      ok: true,
      json: () => new Promise((_resolve, reject) => setTimeout(() => reject(new Error("body stalled")), 20)),
    } as Response),
  }), error => error instanceof DatadogClientError && error.code === "timeout");
});

for (const status of [401, 403, 500, 503]) {
  test(`maps Datadog HTTP ${status} to a safe upstream error`, async () => {
    await assert.rejects(searchDatadogLogs({
      ...credentials, ...range,
      fetcher: async () => new Response("sensitive upstream body", { status }),
    }), error => error instanceof DatadogClientError && error.code === "upstream" &&
      !error.message.includes(credentials.apiKey) && !error.message.includes(credentials.appKey));
  });
}

test("rejects malformed JSON and malformed search envelopes", async () => {
  await assert.rejects(searchDatadogLogs({
    ...credentials, ...range, fetcher: async () => new Response("not-json", { status: 200 }),
  }), error => error instanceof DatadogClientError && error.code === "malformed");
  await assert.rejects(searchDatadogLogs({
    ...credentials, ...range, fetcher: async () => Response.json({ data: {} }),
  }), error => error instanceof DatadogClientError && error.code === "malformed");
});

test("stops safely rather than looping on a repeated pagination cursor", async () => {
  let calls = 0;
  await assert.rejects(searchDatadogLogs({
    ...credentials, ...range, resultCap: 5,
    fetcher: async () => { calls++; return page([{ id: calls }], "same-cursor"); },
  }), error => error instanceof DatadogClientError && error.code === "malformed");
  assert.equal(calls, 2);
});
