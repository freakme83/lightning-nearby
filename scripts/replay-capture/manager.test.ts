import assert from "node:assert/strict";
import { test } from "node:test";
import { ReplayCaptureManager, CAPTURE_QUEUE_MAX, CAPTURE_LATE_ARRIVAL_GRACE_MS,
  CAPTURE_IDLE_POLL_MS, CAPTURE_POLL_MS, CAPTURE_WAITING_POLL_MS, capturePollDelay } from "./manager.ts";
import type { CaptureSession, CaptureStore, CapturedStrike } from "./store.ts";
import type { BlitzortungProbeEvent } from "../research/blitzortung-probe/protocol.ts";

const startAt = Date.parse("2026-11-01T12:00:00Z");
function event(at: number, latitude = 40, longitude = 32, raw = String(at)): BlitzortungProbeEvent {
  return { source: "blitzortung", sourceServer: "ws1", eventTimeMs: at,
    eventTimeRaw: raw, eventTimeUnit: "milliseconds", receivedAtMs: at + 1000,
    latencyMs: 1000, latencyEligible: true, latitude, longitude, polarityRaw: null,
    stationCount: 2, mdsRaw: null, mcgRaw: null, regionRaw: null, insideMonitoringArea: false };
}
function fixture(durationMinutes = 5) {
  let now = startAt;
  let status: CaptureSession["status"] = "requested";
  let healthy = true;
  let connectionGeneration = 1;
  let failure = false;
  const saved = new Map<string, CapturedStrike>();
  const logs: Array<{ kind: string; fields: Record<string, unknown> }> = [];
  const session: CaptureSession = { sessionId: "session", status, centerLat: 40, centerLon: 32,
    sideKm: 25, durationMinutes, geometryVersion: "azimuthal-equidistant-v1",
    requestedAt: new Date(startAt - 60_000).toISOString(), activatedAt: null, expiresAt: null,
    completedAt: null, eventCount: 0, captureHealth: "unknown", sourceHealth: "unknown",
    gapCount: 0, coverageGaps: [], coverageGapsTruncated: false, errorDetails: null };
  const store: CaptureStore = {
    async request() { return { outcome: status === "requested" || status === "active" ? "conflict" : "requested" }; },
    async status() { return { ...session }; },
    async stop() { status = "stopped"; session.status = status; return { outcome: "stopped" }; },
    async sync(_workerId, sourceHealthy, hadGap, pendingCount, gapUpdates) {
      if (status === "stopped" || status === "completed") return { outcome: "idle" };
      if (status === "requested") {
        if (!sourceHealthy) return { outcome: "waiting_for_source" };
        status = "active"; session.status = status; session.activatedAt = new Date(now).toISOString();
        session.expiresAt = new Date(now + durationMinutes * 60_000).toISOString();
        session.captureHealth = "observing";
      }
      for (const gap of gapUpdates) {
        const index = session.coverageGaps.findIndex(item => item.id === gap.id);
        if (index < 0) session.coverageGaps.push(gap);
        else session.coverageGaps[index] = gap;
      }
      session.gapCount = session.coverageGaps.length;
      if (now >= Date.parse(session.expiresAt!) + CAPTURE_LATE_ARRIVAL_GRACE_MS) {
        status = "completed"; session.status = status; session.completedAt = new Date(now).toISOString();
        session.captureHealth = pendingCount || hadGap || session.captureHealth === "incomplete" || session.gapCount ?
          "incomplete" : "complete";
        return { outcome: "completed", session: { ...session } };
      }
      if (hadGap || !sourceHealthy || session.gapCount) session.captureHealth = "incomplete";
      session.sourceHealth = sourceHealthy ? "healthy" : "unhealthy";
      return { outcome: "active", session: { ...session } };
    },
    async storeBatch(_sessionId, _workerId, events) {
      if (failure) throw new Error("database unavailable");
      if (status !== "active") return { outcome: "not_active" };
      let inserted = 0;
      for (const item of events) if (!saved.has(item.event_key)) { saved.set(item.event_key, item); inserted++; }
      session.eventCount += inserted;
      return { outcome: "stored", inserted };
    },
  };
  const manager = new ReplayCaptureManager(store, () => healthy,
    (kind, fields) => { logs.push({ kind, fields }); }, () => now, () => connectionGeneration);
  return { manager, session, saved, logs, setNow(value: number) { now = value; },
    setHealthy(value: boolean) { healthy = value; }, setFailure(value: boolean) { failure = value; },
    changeConnection() { connectionGeneration++; } };
}
async function activate(f: ReturnType<typeof fixture>) {
  f.manager.start();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.session.status, "active");
}

test("five-minute capture activates on worker time, filters square, persists exact events, and expires", async () => {
  const f = fixture();
  try {
    await activate(f);
    assert.equal(Date.parse(f.session.expiresAt!) - Date.parse(f.session.activatedAt!), 5 * 60_000);
    f.manager.observe(event(startAt + 1000));
    f.manager.observe(event(startAt + 1000)); // exact replay
    f.manager.observe(event(startAt + 2000, 41)); // outside
    f.manager.observe(event(startAt - 2000)); // before activation
    await f.manager.tick();
    assert.equal(f.saved.size, 1);
    assert.equal(f.session.eventCount, 1);
    assert.equal([...f.saved.values()][0].event_time, new Date(startAt + 1000).toISOString());
    f.setNow(startAt + 5 * 60_000 + CAPTURE_LATE_ARRIVAL_GRACE_MS);
    await f.manager.tick();
    assert.equal(f.session.status, "completed");
    assert.equal(f.session.captureHealth, "complete");
  } finally { f.manager.stop(); }
});

test("ten-minute expiration and failed storage remain isolated and mark incomplete", async () => {
  const f = fixture(10);
  try {
    await activate(f);
    assert.equal(Date.parse(f.session.expiresAt!) - startAt, 10 * 60_000);
    f.manager.observe(event(startAt + 1000));
    f.setFailure(true);
    await f.manager.tick();
    assert.equal(f.saved.size, 0);
    assert.equal(f.logs.some(row => row.kind === "replay_capture_error"), true);
    f.setNow(startAt + 10 * 60_000 + CAPTURE_LATE_ARRIVAL_GRACE_MS);
    await f.manager.tick();
    assert.equal(f.session.status, "completed");
    assert.equal(f.session.captureHealth, "incomplete");
  } finally { f.manager.stop(); }
});

test("source gap and bounded queue never block observation", async () => {
  const f = fixture();
  try {
    await activate(f);
    f.manager.markSourceGap();
    for (let i = 0; i < CAPTURE_QUEUE_MAX + 3; i++) f.manager.observe(event(startAt + i * 2 + 1000));
    await f.manager.tick();
    f.setNow(startAt + 60_000);
    await f.manager.tick();
    assert.equal(f.logs.some(row => row.kind === "replay_capture_summary" &&
      Number(row.fields.queueDrops) > 0), true);
    assert.equal(f.session.captureHealth, "incomplete");
    assert.ok(f.saved.size <= 2 * 50);
    f.manager.stop();
  } finally { f.manager.stop(); }
});

test("a near-expiry backlog drains during grace before completing", async () => {
  const f = fixture();
  try {
    await activate(f);
    for (let i = 0; i < 100; i++) f.manager.observe(event(startAt + 1000 + i * 2));
    f.setNow(startAt + 5 * 60_000 - 1000);
    await f.manager.tick(); // one 50-event batch remains pending as database time approaches expiry
    assert.equal(f.session.captureHealth, "observing");
    f.setNow(startAt + 5 * 60_000 + CAPTURE_LATE_ARRIVAL_GRACE_MS);
    await f.manager.tick();
    assert.equal(f.saved.size, 100);
    assert.equal(f.session.status, "completed");
    assert.equal(f.session.captureHealth, "complete");
  } finally { f.manager.stop(); }
});

test("late in-window events survive grace, but post-window and post-grace events do not", async () => {
  const f = fixture();
  try {
    await activate(f);
    const expiry = startAt + 5 * 60_000;
    f.setNow(expiry + 20_000);
    f.manager.observe({ ...event(expiry - 10_000), receivedAtMs: expiry + 8_000 });
    f.manager.observe({ ...event(expiry - 11_000), receivedAtMs: expiry + 20_000 });
    f.manager.observe({ ...event(expiry), receivedAtMs: expiry + 20_000 });
    f.manager.observe({ ...event(expiry - 12_000), receivedAtMs: expiry + CAPTURE_LATE_ARRIVAL_GRACE_MS });
    await f.manager.tick();
    assert.equal(f.saved.size, 2);
    assert.equal(f.session.status, "active");
    f.setNow(expiry + CAPTURE_LATE_ARRIVAL_GRACE_MS);
    await f.manager.tick();
    assert.equal(f.session.status, "completed");
  } finally { f.manager.stop(); }
});

test("failed near-finalization batch cannot report complete coverage", async () => {
  const f = fixture();
  try {
    await activate(f);
    f.manager.observe(event(startAt + 10_000));
    f.setFailure(true);
    f.setNow(startAt + 5 * 60_000 + CAPTURE_LATE_ARRIVAL_GRACE_MS);
    await f.manager.tick();
    assert.equal(f.session.status, "completed");
    assert.equal(f.session.captureHealth, "incomplete");
    assert.equal(f.saved.size, 0);
    assert.equal(f.session.coverageGaps[0].reason, "write_failure");
    assert.equal(f.session.coverageGaps[0].startedAt, null);
  } finally { f.manager.stop(); }
});

test("disconnect and recovery persist one interval without erasing incomplete coverage", async () => {
  const f = fixture();
  try {
    await activate(f);
    f.manager.markSourceGap("source_disconnect", startAt + 10_000);
    f.manager.markSourceGap("source_disconnect", startAt + 11_000);
    f.setHealthy(false);
    f.setNow(startAt + 12_000);
    await f.manager.tick();
    f.manager.markSourceRecovery(startAt + 25_000);
    f.setHealthy(true);
    f.setNow(startAt + 25_000);
    await f.manager.tick();
    assert.equal(f.session.gapCount, 1);
    assert.equal(f.session.coverageGaps[0].startedAt, new Date(startAt + 10_000).toISOString());
    assert.equal(f.session.coverageGaps[0].endedAt, new Date(startAt + 25_000).toISOString());
    assert.equal(f.session.captureHealth, "incomplete");
  } finally { f.manager.stop(); }
});

test("idle poll is twelve seconds and active poll is two seconds", () => {
  assert.equal(capturePollDelay("idle"), CAPTURE_IDLE_POLL_MS);
  assert.equal(capturePollDelay("waiting_for_source"), CAPTURE_WAITING_POLL_MS);
  assert.equal(capturePollDelay("active"), CAPTURE_POLL_MS);
  assert.equal(CAPTURE_IDLE_POLL_MS / CAPTURE_POLL_MS, 6);
});

test("a connection transition during activation RPC is persisted as uncertain coverage", async () => {
  const f = fixture();
  let resolveSync!: (value: Awaited<ReturnType<CaptureStore["sync"]>>) => void;
  let pendingArgs!: Parameters<CaptureStore["sync"]>;
  // Hold the initial activation RPC while the transport disconnects and recovers.
  const captureStore = (f.manager as unknown as { store: CaptureStore }).store;
  const realSync = captureStore.sync.bind(captureStore);
  captureStore.sync = (...args) => new Promise(resolve => { resolveSync = resolve; pendingArgs = args; });
  try {
    f.manager.start();
    await new Promise(resolve => setImmediate(resolve));
    f.changeConnection();
    resolveSync(await realSync(...pendingArgs));
    await new Promise(resolve => setImmediate(resolve));
    captureStore.sync = realSync;
    await f.manager.tick();
    assert.equal(f.session.coverageGaps.some(gap => gap.reason === "activation_transition" &&
      gap.startedAt === null && gap.endedAt === null), true);
    assert.equal(f.session.captureHealth, "incomplete");
  } finally { captureStore.sync = realSync; f.manager.stop(); }
});

test("activation without a connection transition does not create a gap", async () => {
  const f = fixture();
  try {
    await activate(f);
    assert.equal(f.session.coverageGaps.length, 0);
    assert.equal(f.session.captureHealth, "observing");
  } finally { f.manager.stop(); }
});
