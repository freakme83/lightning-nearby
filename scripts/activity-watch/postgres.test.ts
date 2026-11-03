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
      interrupted = false, run = run1, lost = false) => (await db.query(
      "select public.sync_ankara_activity_watch($1,$2,$3,$4,$5,$6) as result",
      [run, healthy, interrupted, lost, JSON.stringify(events), iso(at)])).rows[0].result as
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
      assert.equal((await sync(t + 31 * 60_000, [], false, true)).state, "active");
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
      await sync(t + 94 * 60_000, [], true, false, run2);
      assert.equal((await active()).length, 1);
      assert.equal((await active())[0].coverage_uncertain, true);
      assert.equal((await sync(t + 123 * 60_000, [], true, false, run2)).state, "active");
      assert.equal((await sync(t + 124 * 60_000, [], true, false, run2)).state, "idle");
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
      assert.equal((await sync(t + 157 * 60_000, [], true, false, run2, true)).state, "idle");
      await sync(t + 158 * 60_000, [e("1", t + 158 * 60_000 - 1000)], true, false, run2, true);
      assert.equal((await active())[0].coverage_uncertain, true);
      await sync(t + 188 * 60_000, [], true, false, run2);
      await db.exec("reset role");
      const prior = (await db.query("select count(*)::integer as count from public.ankara_activity_periods")).rows[0].count;
      await assert.rejects(db.query(`insert into public.ankara_activity_periods
        (period_id,state,started_at,last_detection_at,detection_count,source_health,worker_run_id)
        values ('11111111-1111-4111-8111-111111111111','active',now(),now(),1,'healthy',$1),
        ('22222222-2222-4222-8222-222222222222','active',now(),now(),1,'healthy',$1)`, [run1]), /duplicate key/);
      assert.equal((await db.query("select count(*)::integer as count from public.ankara_activity_periods")).rows[0].count, prior);
    } finally { await db.close(); }
  });
