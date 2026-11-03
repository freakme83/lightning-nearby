import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const modulePath = process.env.ACTIVITY_WATCH_POSTGRES_TEST_MODULE;
test("atomic Activity Watch periods, 30-minute silence, recovery, idempotency and grants",
  { skip: !modulePath }, async () => {
    const { PGlite } = await import(modulePath!);
    const db = new PGlite();
    const migration = await readFile(new URL("./migrations/20261103123000_ankara_activity_watch_v1.sql", import.meta.url), "utf8");
    const run1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", run2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const t = Date.parse("2026-11-03T12:00:00.000Z");
    const iso = (ms: number) => new Date(ms).toISOString();
    const e = (key: string, at: number) => ({ event_key: key.repeat(64), event_time: iso(at), received_at: iso(at + 1000) });
    const sync = async (at: number, events: ReturnType<typeof e>[] = [], healthy = true,
      gap = { sequence: 0, maxMs: 0, unbounded: false }, run = run1, lost = false) => (await db.query(
      "select public.sync_ankara_activity_watch($1,$2,$3,$4,$5,$6,$7,$8) as result",
      [run, healthy, gap.sequence, gap.maxMs, gap.unbounded, lost, JSON.stringify(events), iso(at)])).rows[0].result as
        { state: string; periodId: string | null; processed: number };
    const active = async () => (await db.query("select * from public.ankara_activity_periods where state='active'")).rows;
    try {
      await db.exec("create role anon; create role authenticated; create role service_role bypassrls");
      await db.exec(migration);
      await db.exec("set role anon");
      await assert.rejects(sync(t), /permission denied/);
      await assert.rejects(db.query("select * from public.ankara_activity_periods"), /permission denied/);
      await db.exec("reset role; set role authenticated");
      await assert.rejects(sync(t), /permission denied/);
      await db.exec("reset role; set role service_role");
      assert.equal((await sync(t, [e("a", t - 1000)])).processed, 1);
      assert.equal((await sync(t + 1000, [e("a", t - 1000)])).processed, 0);
      assert.equal((await sync(t + 60_000, [e("b", t + 59_000)])).processed, 1);
      assert.equal((await active()).length, 1);
      assert.equal((await active())[0].detection_count, 2);
      assert.equal((await sync(t + 29 * 60_000, [e("c", t + 29 * 60_000 - 1000)])).state, "active");
      assert.equal((await sync(t + 30 * 60_000)).state, "active");
      // A source interruption resets the healthy-silence clock and remains recorded.
      assert.equal((await sync(t + 31 * 60_000, [], false)).state, "active");
      await sync(t + 32 * 60_000, [], true);
      assert.equal((await sync(t + 59 * 60_000)).state, "active");
      assert.equal((await sync(t + 62 * 60_000)).state, "idle");
      const closed = (await db.query("select * from public.ankara_activity_periods where state='closed'")).rows[0];
      assert.equal(new Date(closed.last_detection_at).toISOString(), iso(t + 29 * 60_000 - 1000));
      assert.equal(new Date(closed.closed_at).toISOString(), iso(t + 62 * 60_000));
      assert.equal(closed.coverage_uncertain, true);
      assert.equal((await sync(t + 62 * 60_000 + 1000, [e("a", t - 1000)])).processed, 0);
      // A new period opens, then worker takeover conservatively defers closure.
      await sync(t + 63 * 60_000, [e("d", t + 63 * 60_000 - 1000)]);
      await sync(t + 94 * 60_000, [], true, undefined, run2);
      assert.equal((await active()).length, 1);
      assert.equal((await active())[0].coverage_uncertain, true);
      assert.equal((await sync(t + 123 * 60_000, [], true, undefined, run2)).state, "active");
      assert.equal((await sync(t + 124 * 60_000, [], true, undefined, run2)).state, "idle");
      // Stale/future input is rejected in SQL too, without creating another period.
      await assert.rejects(sync(t + 125 * 60_000, [e("e", t + 126 * 60_000)]), /Invalid Activity Watch event time/);
      assert.equal((await active()).length, 0);
      await assert.rejects(sync(t + 125 * 60_000, [{ ...e("e", t + 125 * 60_000 - 31_000),
        received_at: iso(t + 125 * 60_000) }]), /Invalid Activity Watch event time/);
      assert.equal((await active()).length, 0);
      assert.equal((await sync(t + 125 * 60_000, [e("f", t + 124 * 60_000)])).processed, 0);
      // A gap-free period closes at the exact threshold, not a moment earlier.
      await sync(t + 126 * 60_000, [e("0", t + 126 * 60_000 - 1000)]);
      assert.equal((await sync(t + 156 * 60_000 - 1)).state, "active");
      assert.equal((await sync(t + 156 * 60_000)).state, "idle");
      assert.equal((await db.query("select coverage_uncertain from public.ankara_activity_periods order by started_at desc limit 1")).rows[0].coverage_uncertain, false);
      assert.equal((await sync(t + 157 * 60_000, [], true, undefined, run2, true)).state, "idle");
      await sync(t + 158 * 60_000, [e("1", t + 158 * 60_000 - 1000)], true, undefined, run2, true);
      assert.equal((await active())[0].coverage_uncertain, true);
      await sync(t + 188 * 60_000, [], true, undefined, run2);
      await db.exec("reset role");
      const prior = (await db.query("select count(*)::integer as count from public.ankara_activity_periods")).rows[0].count;
      await assert.rejects(db.query(`insert into public.ankara_activity_periods
        (period_id,state,started_at,last_detection_at,detection_count,source_health,worker_run_id)
        values ('11111111-1111-4111-8111-111111111111','active',now(),now(),1,'healthy',$1),
        ('22222222-2222-4222-8222-222222222222','active',now(),now(),1,'healthy',$1)`, [run1]), /duplicate key/);
      assert.equal((await db.query("select count(*)::integer as count from public.ankara_activity_periods")).rows[0].count, prior);
    } finally { await db.close(); }
  });

test("routine 361-second rotations tolerate bounded gaps, pending events extend activity, long gaps defer closure",
  { skip: !modulePath }, async () => {
    const { PGlite } = await import(modulePath!);
    const db = new PGlite();
    const migration = await readFile(new URL("./migrations/20261103123000_ankara_activity_watch_v1.sql", import.meta.url), "utf8");
    const run = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const t = Date.parse("2026-11-03T12:00:00.000Z");
    const iso = (ms: number) => new Date(ms).toISOString();
    const e = (key: string, at: number) => ({ event_key: key.repeat(64), event_time: iso(at), received_at: iso(at + 1000) });
    const sync = async (at: number, events: ReturnType<typeof e>[] = [], healthy = true,
      sequence = 0, maxMs = 0, unbounded = false) => (await db.query(
      "select public.sync_ankara_activity_watch($1,$2,$3,$4,$5,$6,$7,$8) as result",
      [run, healthy, sequence, maxMs, unbounded, false, JSON.stringify(events), iso(at)])).rows[0].result as
      { state: string; periodId: string | null; processed: number };
    const active = async () => (await db.query("select * from public.ankara_activity_periods where state='active'")).rows[0];
    try {
      await db.exec("create role anon; create role authenticated; create role service_role bypassrls");
      await db.exec(migration);
      await db.exec("set role service_role");
      await sync(t, [e("a", t - 1000)]);
      for (const [index, duration] of [1000, 4000, 10_000, 1000].entries()) {
        const disconnectAt = t + (index + 1) * 361_000;
        assert.equal((await sync(disconnectAt, [], false, index)).state, "active");
        assert.equal((await sync(disconnectAt + duration, [], true, index + 1, duration)).state, "active");
      }
      assert.equal((await active()).coverage_uncertain, true);
      assert.equal((await active()).interruption_count, 4);
      // The event was already pending when the quiet-time RPC reached the boundary.
      assert.equal((await sync(t + 1_800_000, [e("b", t + 1_799_000)], true, 4)).state, "active");
      assert.equal((await active()).detection_count, 2);
      assert.equal((await sync(t + 3_599_000 - 1, [], true, 4)).state, "active");
      assert.equal((await sync(t + 3_599_000, [], true, 4)).state, "idle");
      const closed = (await db.query("select * from public.ankara_activity_periods order by started_at limit 1")).rows[0];
      assert.equal(new Date(closed.last_detection_at).toISOString(), iso(t + 1_799_000));
      assert.equal(closed.coverage_uncertain, true);
      // With no pending event, the same routine gaps close at last event + 30 minutes.
      await sync(t + 3_600_000, [e("c", t + 3_599_000)], true, 4);
      const second = (await active()).period_id;
      for (const [index, duration] of [1000, 4000, 1000, 1000].entries()) {
        const disconnectAt = t + 3_600_000 + (index + 1) * 361_000;
        await sync(disconnectAt, [], false, 4 + index);
        await sync(disconnectAt + duration, [], true, 5 + index, duration);
      }
      assert.equal((await sync(t + 5_400_000 - 1, [], true, 8)).state, "active");
      assert.equal((await sync(t + 5_400_000, [], true, 8)).state, "idle");
      assert.equal((await db.query("select coverage_uncertain from public.ankara_activity_periods where period_id=$1", [second])).rows[0].coverage_uncertain, true);
      // An 11-second gap resets the recovery clock, while retaining last event time.
      await sync(t + 6_000_000, [e("d", t + 5_999_000)], true, 8);
      await sync(t + 6_361_000, [], false, 8);
      await sync(t + 6_372_000, [], true, 9, 11_000);
      assert.equal((await sync(t + 7_800_000, [], true, 9)).state, "active");
      assert.equal((await sync(t + 8_172_000, [], true, 9)).state, "idle");
      // An unhealthy interval without a bounded completion is also long/unresolved.
      await sync(t + 9_000_000, [e("e", t + 8_999_000)], true, 9);
      await sync(t + 9_361_000, [], false, 9);
      await sync(t + 9_362_000, [], true, 10, 1000, true);
      assert.equal((await sync(t + 10_800_000, [], true, 10)).state, "active");
      assert.equal((await sync(t + 11_162_000, [], true, 10)).state, "idle");
    } finally { await db.close(); }
  });
