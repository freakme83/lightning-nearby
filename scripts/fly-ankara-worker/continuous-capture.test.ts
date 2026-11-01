import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createContinuousCapture, ContinuousCapture } from "./continuous-capture.ts";
import { parseDecodedBlitzortungPayload } from "../research/blitzortung-probe/protocol.ts";
import { BlitzPrimaryAdmission } from "./blitz-primary.ts";

const config = { url: "https://example.supabase.co", serviceRoleKey: "test" };
const emit = () => {};
function event(lat = 39.93, lon = 32.85, server: "ws1" | "ws8" = "ws1") {
  const result = parseDecodedBlitzortungPayload(JSON.stringify({ time: "1700000000000000000", lat, lon, sig: [1, 2] }),
    1700000100000, server);
  assert.equal(result.kind, "event");
  if (result.kind !== "event") throw new Error("invalid fixture");
  return result.event;
}
const drain = () => new Promise(resolve => setImmediate(resolve));
// Exercise the bounded scheduler without waiting on real timers.
function tick(capture: ContinuousCapture) { (capture as unknown as { tick(): void }).tick(); }
function snapshot(capture: ContinuousCapture) {
  return capture as unknown as { queue: unknown[]; dropped: number; failures: number; nextAttempt: number };
}

test("disabled feature performs no network work", () => {
  let calls = 0;
  const fetcher = (() => { calls++; throw new Error("network"); }) as typeof fetch;
  assert.equal(createContinuousCapture({ NODE_ENV: "test" }, emit, fetcher), null);
  assert.equal(createContinuousCapture({ NODE_ENV: "test", CONTINUOUS_CAPTURE_ENABLED: "false" }, emit, fetcher), null);
  assert.equal(calls, 0);
});

test("decoded polygon membership is independent of publication freshness and duplicates are idempotent across servers", async () => {
  const saved = new Map<string, unknown>();
  const fetcher = (async (url: URL | RequestInfo, init?: RequestInit) => {
    if (String(url).includes("continuous_capture_strikes")) {
      for (const row of JSON.parse(String(init?.body))) saved.set(row.event_key, row);
    }
    return new Response(null, { status: 201 });
  }) as typeof fetch;
  const c = new ContinuousCapture(config, emit, fetcher);
  const inside = event(), outside = event(41, 29);
  assert.equal(inside.insideMonitoringArea, true);
  assert.equal(outside.insideMonitoringArea, false);
  assert.equal(new BlitzPrimaryAdmission().admit(inside, () => { throw new Error("unexpected admission"); }), "stale_or_future");
  c.observe(inside); c.observe(outside); c.observe(event(39.93, 32.85, "ws8"));
  tick(c); await drain();
  assert.equal(saved.size, 1);
  const row = [...saved.values()][0] as Record<string, unknown>;
  assert.equal(row.event_time_raw, inside.eventTimeRaw);
});

test("failed and stalled writes do not escape or stop observation and the queue stays bounded", async () => {
  let calls = 0;
  const never = (() => { calls++; return new Promise(() => {}); }) as typeof fetch;
  const c = new ContinuousCapture(config, emit, never);
  c.observe(event()); tick(c);
  for (let i = 0; i < 3000; i++) c.observe(event());
  tick(c); await drain();
  assert.equal(calls, 1);
  assert.equal(snapshot(c).queue.length, 2001);
  assert.equal(snapshot(c).dropped, 1001);
  const failed = new ContinuousCapture(config, emit, (async () => { throw new Error("offline"); }) as typeof fetch);
  failed.observe(event()); tick(failed); await drain();
  assert.equal(snapshot(failed).failures, 1);
  failed.observe(event());
  assert.equal(snapshot(failed).queue.length, 3);
});

test("worker integration keeps one socket and no capture calls into publication or replay modules", () => {
  const worker = readFileSync(new URL("./worker.ts", import.meta.url), "utf8");
  const capture = readFileSync(new URL("./continuous-capture.ts", import.meta.url), "utf8");
  assert.equal((worker.match(/new WebSocket\(/g) ?? []).length, 1);
  assert.ok(worker.indexOf("continuousCapture?.observe(frame.event)") < worker.indexOf("blitzAdmission.admit(frame.event"));
  assert.doesNotMatch(capture, /ReplayCapture|Telegram|autoPublish|acceptEvent|Xweather/);
});

test("request timeout signal and bounded retries record loss without changing observation", async () => {
  let now = 1_700_000_000_000, calls = 0;
  const failing = (async (_url: URL | RequestInfo, init?: RequestInit) => {
    calls++;
    assert.ok(init?.signal instanceof AbortSignal);
    throw new Error("timeout");
  }) as typeof fetch;
  const c = new ContinuousCapture(config, emit, failing, () => now);
  c.observe(event());
  for (let attempt = 0; attempt < 3; attempt++) { tick(c); await drain(); now += 30_000; }
  assert.equal(calls, 3);
  assert.ok(snapshot(c).dropped >= 1);
  c.observe(event());
  assert.ok(snapshot(c).queue.length > 0);
});

test("a restart repeats the same event key independently of receipt and server", async () => {
  const rows: Record<string, unknown>[] = [];
  const fetcher = (async (url: URL | RequestInfo, init?: RequestInit) => {
    if (String(url).includes("continuous_capture_strikes")) rows.push(...JSON.parse(String(init?.body)));
    return new Response(null, { status: 201 });
  }) as typeof fetch;
  const first = new ContinuousCapture(config, emit, fetcher), second = new ContinuousCapture(config, emit, fetcher);
  first.observe(event()); second.observe({ ...event(39.93, 32.85, "ws8"), receivedAtMs: 1700000200000 });
  tick(first); tick(second); await drain();
  assert.equal(rows.length, 2);
  assert.equal(rows[0].event_key, rows[1].event_key);
});

test("throwing telemetry does not count a lost strike or prevent production admission", () => {
  const c = new ContinuousCapture(config, () => { throw new Error("logger"); });
  c.sourceState("unhealthy", "test");
  c.observe(event());
  let processed = false;
  const fresh = { ...event(), receivedAtMs: event().eventTimeMs };
  c.observe(fresh);
  new BlitzPrimaryAdmission().admit(fresh, () => { processed = true; });
  assert.equal(processed, true);
  assert.equal(snapshot(c).dropped, 0);
});

test("failed strike batches report loss after recovery; transient failures do not", async () => {
  let now = 1_700_000_000_000, calls = 0, offline = true;
  const health: Record<string, unknown>[] = [];
  const fetcher = (async (url: URL | RequestInfo, init?: RequestInit) => {
    calls++;
    if (offline) throw new Error("offline");
    if (String(url).includes("continuous_capture_health")) health.push(...JSON.parse(String(init?.body)));
    return new Response(null, { status: 201 });
  }) as typeof fetch;
  const c = new ContinuousCapture(config, emit, fetcher, () => now);
  c.observe(event());
  tick(c); await drain(); now += 30000;
  assert.equal(snapshot(c).dropped, 0);
  tick(c); await drain(); now += 30000;
  tick(c); await drain(); now += 30000;
  assert.equal(snapshot(c).dropped, 1);
  offline = false;
  for (let i = 0; i < 10; i++) { tick(c); await drain(); now += 30000; }
  assert.ok(calls > 3);
  assert.ok(health.some(row => Number(row.dropped) === 1 && Number(row.failures) >= 3));
});

test("health backlog remains bounded and a lost health batch leaves a gap marker", async () => {
  let now = 1_700_000_000_000, offline = true;
  const health: Record<string, unknown>[] = [];
  const fetcher = (async (_url: URL | RequestInfo, init?: RequestInit) => {
    if (offline) throw new Error("offline");
    health.push(...JSON.parse(String(init?.body)));
    return new Response(null, { status: 201 });
  }) as typeof fetch;
  const c = new ContinuousCapture(config, emit, fetcher, () => now);
  for (let i = 0; i < 300; i++) { c.sourceState(i % 2 ? "healthy" : "unhealthy", "transition"); }
  assert.ok(snapshot(c).queue.length <= 128);
  for (let i = 0; i < 3; i++) { tick(c); await drain(); now += 30000; }
  offline = false;
  for (let i = 0; i < 8; i++) { tick(c); await drain(); now += 30000; }
  assert.ok(health.some(row => row.reason === "health_gap"));
});

test("a transient write failure followed by success is not strike loss", async () => {
  let now = 1_700_000_000_000, calls = 0;
  const c = new ContinuousCapture(config, emit, (async () => {
    if (++calls === 1) throw new Error("temporary");
    return new Response(null, { status: 201 });
  }) as typeof fetch, () => now);
  c.observe(event()); tick(c); await drain(); now += 30000;
  tick(c); await drain();
  assert.equal(calls, 2);
  assert.equal(snapshot(c).dropped, 0);
  assert.equal(snapshot(c).failures, 1);
});
