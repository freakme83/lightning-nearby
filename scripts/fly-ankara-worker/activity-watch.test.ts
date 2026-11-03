import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ActivityWatch, createActivityWatch, eligibleActivityEvent, type ActivityStore } from "./activity-watch.ts";
import { parseDecodedBlitzortungPayload } from "../research/blitzortung-probe/protocol.ts";

const T = 1_700_000_000_000;
function event(receivedAt = T + 1000, eventAt = T, lat = 39.93) {
  const parsed = parseDecodedBlitzortungPayload(JSON.stringify({ time: `${eventAt}000000`, lat, lon: 32.85 }), receivedAt, "ws1");
  assert.equal(parsed.kind, "event");
  if (parsed.kind !== "event") throw new Error("bad fixture");
  return parsed.event;
}
const drain = () => new Promise(resolve => setImmediate(resolve));

test("disabled flag does not initialize storage or perform any request", () => {
  let calls = 0;
  const fetcher = (() => { calls++; throw new Error("unexpected"); }) as typeof fetch;
  assert.equal(createActivityWatch({ NODE_ENV: "test", ACTIVITY_WATCH_ENABLED: "false" }, () => true, () => {}, fetcher), null);
  assert.equal(createActivityWatch({ NODE_ENV: "test" }, () => true, () => {}, fetcher), null);
  assert.equal(calls, 0);
});

test("same freshness and polygon boundary as Blitz production admission; deterministic event key", () => {
  assert.ok(eligibleActivityEvent(event(T + 30_000)));
  assert.equal(eligibleActivityEvent(event(T + 30_001)), null);
  assert.equal(eligibleActivityEvent(event(T - 1)), null);
  assert.equal(eligibleActivityEvent(event(T + 1000, T + 2000)), null);
  assert.equal(eligibleActivityEvent(event(T + 1000, T, 41)), null);
  assert.equal(eligibleActivityEvent(event())?.event_key, eligibleActivityEvent({ ...event(), sourceServer: "ws8" })?.event_key);
});

test("bounded queue, duplicate coalescing and store failure never reach publication", async () => {
  let now = T + 1000, calls = 0, healthy = true;
  const log: string[] = [];
  const store: ActivityStore = { async sync() {
    calls++;
    throw new Error("database down");
  } };
  const watch = new ActivityWatch(store, () => healthy, kind => { log.push(kind); }, () => now);
  watch.observe(event()); watch.observe(event()); await drain();
  assert.equal(calls, 1);
  assert.ok(log.includes("activity_watch_error"));
  healthy = false; now += 60_000;
  watch.sourceState(false); await drain();
  watch.stop();
  const worker = readFileSync(new URL("./worker.ts", import.meta.url), "utf8");
  assert.equal((worker.match(/new WebSocket\(/g) ?? []).length, 1);
  assert.ok(worker.indexOf("activityWatch?.observe(frame.event)") < worker.indexOf("blitzAdmission.admit(frame.event"));
  const source = readFileSync(new URL("./activity-watch.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /acceptEvent\(|Telegram|autoPublish|Xweather|publication_records/);
  const { BlitzPrimaryAdmission } = await import("./blitz-primary.ts");
  let admitted = false;
  new BlitzPrimaryAdmission().admit(event(T + 1000), () => { admitted = true; });
  assert.equal(admitted, true);
});

test("transition during an in-flight sync remains pending for the next database call", async () => {
  let resolve!: (value: { state: "idle"; periodId: null; processed: number }) => void;
  const records: Array<{ healthy: boolean; interrupted: boolean }> = [];
  const store: ActivityStore = { sync(_run, healthy, interrupted) {
    records.push({ healthy, interrupted });
    if (records.length === 1) return new Promise(r => { resolve = r; });
    return Promise.resolve({ state: "idle", periodId: null, processed: 0 });
  } };
  let sourceHealthy = true;
  const watch = new ActivityWatch(store, () => sourceHealthy, () => {});
  void watch.tick();
  sourceHealthy = false; watch.sourceState(false);
  sourceHealthy = true; watch.sourceState(true);
  resolve({ state: "idle", periodId: null, processed: 0 }); await drain();
  await watch.tick();
  assert.deepEqual(records, [{ healthy: true, interrupted: false }, { healthy: true, interrupted: true }]);
  watch.stop();
});
