import assert from "node:assert/strict";
import { test } from "node:test";
import { createCaptureStore } from "./store.ts";
import { runCaptureControl } from "./control.ts";

const session = { session_id: "test-id", status: "active", center_lat: 40, center_lon: 32, side_km: 25,
  duration_minutes: 5, geometry_version: "azimuthal-equidistant-v1",
  requested_at: "2026-11-01T12:00:00Z", activated_at: "2026-11-01T12:00:02Z",
  expires_at: "2026-11-01T12:05:02Z", completed_at: null, event_count: 3,
  capture_health: "incomplete", source_health: "unhealthy", gap_count: 1,
  coverage_gaps: [], coverage_gaps_truncated: false, error_details: "source_unhealthy" };

test("status exposes safe session facts and commands use only own authenticated Supabase RPCs", async () => {
  const calls: Array<{ url: URL; init: RequestInit }> = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(input.toString());
    calls.push({ url, init: init! });
    if (url.pathname.endsWith("/replay_capture_sessions")) return Response.json([session]);
    if (url.pathname.endsWith("/request_replay_capture")) return Response.json({ outcome: "requested", sessionId: "test-id" });
    if (url.pathname.endsWith("/stop_replay_capture")) return Response.json({ outcome: "stopped", sessionId: "test-id" });
    throw new Error("unexpected endpoint");
  };
  const store = createCaptureStore({ url: "https://example.supabase.co", serviceRoleKey: "test-secret" }, fetcher);
  assert.equal((await store.status())?.eventCount, 3);
  assert.deepEqual((await store.status())?.captureHealth, "incomplete");
  assert.equal((await store.request("test-id", { centerLat: 40, centerLon: 32, sideKm: 25 }, 5)).outcome, "requested");
  assert.equal((await store.stop()).outcome, "stopped");
  assert.deepEqual(calls.map(call => call.url.pathname), [
    "/rest/v1/replay_capture_sessions", "/rest/v1/replay_capture_sessions",
    "/rest/v1/rpc/request_replay_capture", "/rest/v1/rpc/stop_replay_capture",
  ]);
  assert.ok(calls.every(call => new Headers(call.init.headers).get("Authorization") === "Bearer test-secret"));
  assert.ok(calls.every(call => call.init.cache === "no-store" && call.init.signal instanceof AbortSignal));
});

test("blank or malformed start settings reject before any request", async () => {
  await assert.rejects(runCaptureControl({ CAPTURE_OPERATION: "start", CAPTURE_CENTER_LAT: "",
    CAPTURE_CENTER_LON: "32", CAPTURE_SIDE_KM: "100", CAPTURE_DURATION_MINUTES: "10" }), /requires center/);
  await assert.rejects(runCaptureControl({ CAPTURE_OPERATION: "start", CAPTURE_CENTER_LAT: "40",
    CAPTURE_CENTER_LON: "32", CAPTURE_SIDE_KM: "101", CAPTURE_DURATION_MINUTES: "10" }), /Invalid capture/);
});
