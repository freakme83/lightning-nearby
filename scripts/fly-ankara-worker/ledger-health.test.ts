import assert from "node:assert/strict";
import test from "node:test";
import { createLedgerHealthMonitor, LEDGER_HEALTH_INTERVAL_MS } from "./ledger-health.ts";
import { createSupabaseLedger } from "../lightning-publication-ledger/storage/supabase.ts";

const config = { url: "https://fixture.supabase.co", serviceRoleKey: "test-key" };

test("health read selects one id only and treats an empty table as healthy", async () => {
  let url: URL | undefined;
  const store = createSupabaseLedger(config, (async (input: RequestInfo | URL) => {
    url = new URL(String(input)); return Response.json([]);
  }) as typeof fetch);
  await store.checkAvailability!();
  assert.equal(url?.pathname, "/rest/v1/publication_records");
  assert.equal(url?.searchParams.get("select"), "publication_id");
  assert.equal(url?.searchParams.get("limit"), "1");
});

test("monitor emits sanitized success and failure telemetry", async () => {
  const events: Array<Record<string, unknown>> = [];
  const monitor = createLedgerHealthMonitor({ check: async () => { throw new Error("private response details"); },
    emit: (_kind, fields) => events.push(fields), now: () => 1_800_000_000_000 });
  await monitor.runOnce();
  assert.equal(events[0].status, "error");
  assert.equal(events[0].reason, "connection_error");
  assert.equal(JSON.stringify(events).includes("private response"), false);
  monitor.stop();
});

test("monitor does not overlap checks and shutdown aborts pending work", async () => {
  let release!: () => void; let calls = 0; let receivedSignal: AbortSignal | undefined;
  const events: Array<Record<string, unknown>> = [];
  const monitor = createLedgerHealthMonitor({ check: signal => { calls++; receivedSignal = signal; return new Promise<void>(resolve => { release = resolve; }); },
    emit: (_kind, fields) => events.push(fields) });
  const first = monitor.runOnce(); await monitor.runOnce();
  assert.equal(calls, 1);
  monitor.stop(); assert.equal(receivedSignal?.aborted, true);
  release(); await first; assert.equal(events.length, 0);
  assert.equal(LEDGER_HEALTH_INTERVAL_MS, 6 * 60 * 60_000);
});
