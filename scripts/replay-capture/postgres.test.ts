// Optional local PostgreSQL engine; never contacts hosted Supabase.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const modulePath = process.env.REPLAY_CAPTURE_POSTGRES_TEST_MODULE;
test("capture RPCs serialize starts, enforce lease, dedupe, and deny public roles",
  { skip: !modulePath }, async () => {
    const { PGlite } = await import(modulePath!);
    const db = new PGlite();
    const sql = await readFile(new URL("./migrations/20261101154731_replay_capture_sessions_v1.sql", import.meta.url), "utf8");
    const id = "c0e13ae6-d1b1-4888-9891-e5d81aaf344a";
    const other = "b0170d6c-24de-42c5-b333-c1ed8c8be082";
    const worker = "bb171fcc-27a8-449d-820e-a0e6d9e65b60";
    const replacement = "359eb5fb-f95d-46c7-913b-5545bea7a1d6";
    const rpc = async (name: string, params: unknown[] = []) =>
      (await db.query(`select public.${name}(${params.map((_, index) => `$${index + 1}`).join(",")}) as result`,
        params)).rows[0].result as Record<string, unknown>;
    try {
      await db.exec("create role anon; create role authenticated; create role service_role bypassrls");
      await db.exec(sql);
      await db.exec("set role anon");
      await assert.rejects(rpc("stop_replay_capture"), /permission denied/);
      await assert.rejects(db.query("select * from public.replay_capture_strikes"), /permission denied/);
      await db.exec("reset role; set role authenticated");
      await assert.rejects(rpc("stop_replay_capture"), /permission denied/);
      await db.exec("reset role; set role service_role");
      const start = [id, 40, 32, 25, 10];
      await assert.rejects(rpc("request_replay_capture", [id, 40, 32, 100, 7]), /Invalid replay/);
      assert.equal((await rpc("request_replay_capture", start)).outcome, "requested");
      assert.equal((await rpc("request_replay_capture", start)).outcome, "already_present");
      assert.equal((await rpc("request_replay_capture", [other, 40, 32, 25, 5])).outcome, "conflict");
      assert.equal((await rpc("sync_replay_capture", [worker, false, false, 0, [], false, false])).outcome, "waiting_for_source");
      const active = await rpc("sync_replay_capture", [worker, true, false, 0, [], true, false]);
      assert.equal(active.outcome, "active");
      const session = active.session as Record<string, string>;
      assert.equal(Date.parse(session.expires_at) - Date.parse(session.activated_at), 10 * 60_000);
      assert.equal((await rpc("sync_replay_capture", [replacement, true, false, 0, [], true, false])).outcome, "not_owner");
      const strike = { event_key: "a".repeat(64), event_time: new Date(Date.now() + 1000).toISOString(),
        received_at: new Date(Date.now() + 2000).toISOString(), latitude: 40, longitude: 32,
        source_server: "ws1", event_time_raw: String(Date.now()), station_count: 2 };
      assert.equal((await rpc("store_replay_capture_batch", [id, replacement, [strike]])).outcome, "not_active");
      const stored = await rpc("store_replay_capture_batch", [id, worker, [strike, strike]]);
      assert.equal(stored.inserted, 1);
      assert.equal((await rpc("store_replay_capture_batch", [id, worker, [strike]])).inserted, 0);
      assert.equal((await db.query("select event_count from public.replay_capture_sessions where session_id=$1", [id])).rows[0].event_count, 1);
      await db.exec("reset role");
      await db.query("update public.replay_capture_sessions set lease_until=clock_timestamp()-interval '1 second' where session_id=$1", [id]);
      await db.exec("set role service_role");
      const resumed = await rpc("sync_replay_capture", [replacement, true, false, 0, [], true, false]);
      assert.equal((resumed.session as Record<string, unknown>).capture_health, "incomplete");
      assert.equal(((resumed.session as Record<string, unknown>).coverage_gaps as unknown[]).length, 1);
      const gap = { id: "gap-1", startedAt: new Date().toISOString(), endedAt: null,
        reason: "source_disconnect" };
      await rpc("sync_replay_capture", [replacement, false, true, 0, [gap], false, false]);
      const recovered = await rpc("sync_replay_capture", [replacement, true, false, 0,
        [{ ...gap, endedAt: new Date(Date.now()+1000).toISOString() }], false, false]);
      assert.equal(((recovered.session as Record<string, unknown>).coverage_gaps as unknown[]).length, 2);
      assert.equal((recovered.session as Record<string, unknown>).gap_count, 2);
      await db.exec("reset role");
      await db.query("update public.replay_capture_sessions set activated_at=clock_timestamp()-interval '10 minutes', expires_at=clock_timestamp()-interval '10 seconds', lease_until=clock_timestamp()+interval '30 seconds' where session_id=$1", [id]);
      await db.exec("set role service_role");
      const late = { ...strike, event_key: "b".repeat(64),
        event_time: new Date(Date.now()-20_000).toISOString(), received_at: new Date().toISOString() };
      assert.equal((await rpc("store_replay_capture_batch", [id, replacement, [late]])).inserted, 1);
      assert.equal((await rpc("store_replay_capture_batch", [id, replacement, [late]])).inserted, 0);
      await assert.rejects(rpc("store_replay_capture_batch", [id, replacement,
        [{ ...late, event_key: "c".repeat(64), event_time: new Date().toISOString() }]]), /Outside replay/);
      await assert.rejects(rpc("store_replay_capture_batch", [id, replacement,
        [{ ...late, event_key: "d".repeat(64), received_at: new Date(Date.now()+51_000).toISOString() }]]), /Outside replay/);
      assert.equal((await rpc("sync_replay_capture", [replacement, true, false, 0, [], false, false])).outcome, "active");
      await db.exec("reset role");
      await db.query("update public.replay_capture_sessions set expires_at=clock_timestamp()-interval '61 seconds', lease_until=clock_timestamp()+interval '30 seconds' where session_id=$1", [id]);
      await db.exec("set role service_role");
      assert.equal((await rpc("sync_replay_capture", [replacement, true, false, 0, [], false, false])).outcome, "active");
      const completed = await rpc("sync_replay_capture", [replacement, true, false, 1, [], true, false]);
      assert.equal(completed.outcome, "completed");
      assert.equal((completed.session as Record<string, unknown>).capture_health, "incomplete");
      assert.equal((await rpc("stop_replay_capture")).outcome, "idle");
      assert.equal((await rpc("request_replay_capture", [other, 40, 32, 25, 5])).outcome, "requested");
      assert.equal((await rpc("stop_replay_capture")).outcome, "stopped");
      assert.equal((await rpc("store_replay_capture_batch", [id, replacement, [strike]])).outcome, "not_active");
    } finally { await db.exec("reset role"); await db.close(); }
});
