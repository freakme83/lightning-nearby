import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { loadAnkaraDistrictAttributor } from "./districts.ts";
import { buildActivityExport, type CaptureRow, type MembershipRow, type PeriodRow } from "./export.ts";

// Same opt-in PGlite module as scripts/activity-watch/postgres.test.ts.
const modulePath = process.env.ACTIVITY_WATCH_POSTGRES_TEST_MODULE;
const migration = (path: string) => readFile(new URL(path, import.meta.url), "utf8");

test("periods closed by the real Activity Watch RPC export, including database-clock closed_at",
  { skip: !modulePath }, async () => {
    const { PGlite } = await import(modulePath!);
    const db = new PGlite();
    const run = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const iso = (ms: number) => new Date(ms).toISOString();
    const event = (key: string, at: number) => ({ event_key: key.repeat(64), event_time: iso(at), received_at: iso(at + 1_000) });
    // PostgREST serializes rows with to_json, so json_agg reproduces its timestamptz text.
    const rows = async <T>(sql: string): Promise<T[]> =>
      (await db.query(`select coalesce(json_agg(x), '[]'::json) as j from (${sql}) x`)).rows[0].j as T[];
    const archive = (key: string, at: number, lat: number, lon: number) => db.query(
      `insert into public.continuous_capture_strikes (event_key, event_time, event_time_raw, event_time_unit, received_at,
        latitude, longitude, source_server, station_count, polygon_id)
       values ($1, $2, $3, 'milliseconds', $4, $5, $6, 'ws1', 8, 'p')`,
      [key.repeat(64), iso(at), String(at), iso(at + 1_000), lat, lon]);
    const exportOf = async (periodId: string) => buildActivityExport({ periodId,
      period: (await rows<PeriodRow>(`select * from public.ankara_activity_periods where period_id = '${periodId}'`))[0],
      members: await rows<MembershipRow>(`select * from public.ankara_activity_period_events where period_id = '${periodId}'`),
      // Keyed join, as the store does: only this period's membership keys.
      captures: await rows<CaptureRow>(`select * from public.continuous_capture_strikes where event_key in
        (select event_key from public.ankara_activity_period_events where period_id = '${periodId}')`),
      attributor: loadAnkaraDistrictAttributor() });
    try {
      await db.exec("create role anon; create role authenticated; create role service_role bypassrls");
      await db.exec(await migration("../activity-watch/migrations/20261103123000_ankara_activity_watch_v1.sql"));
      await db.exec(await migration("../continuous-capture/migrations/20261101204137_ankara_continuous_capture_v1.sql"));
      await db.exec("set role service_role");

      // 1. Deterministic: the closing evaluation's p_now carries six fractional digits.
      const t = Date.parse("2026-11-03T12:00:00.000Z");
      const sync = (now: string, events: unknown[]) => db.query(
        "select public.sync_ankara_activity_watch($1, true, 0, 0, false, false, $2, $3)", [run, JSON.stringify(events), now]);
      await sync(iso(t + 2_000), [event("a", t + 1_000), event("b", t + 1_000)]);
      await sync(iso(t + 6_000), [event("c", t + 5_000)]);
      await sync("2026-11-03T12:30:06.123456Z", []);
      const [first] = await rows<PeriodRow>("select * from public.ankara_activity_periods where state = 'closed'");
      assert.equal(first.closed_at, "2026-11-03T12:30:06.123456+00:00");
      await archive("a", t + 1_000, 39.9208, 32.8541);
      await archive("b", t + 1_000, 39.98, 32.86);
      // "c", the last recorded detection, is missing from Continuous Capture.
      const result = await exportOf(first.period_id);
      assert.equal(result.meta.activityPeriod.closedAt, "2026-11-03T12:30:06.123456Z");
      assert.deepEqual(result.events.map(item => item.timestamp), [iso(t + 1_000), iso(t + 1_000)]);
      assert.deepEqual(result.meta.archive.missingArchiveEventKeys, ["c".repeat(64)]);
      // windowEnd follows the last Activity Watch detection, not the last surviving archive row.
      assert.equal(result.meta.activityPeriod.lastDetectionAt, iso(t + 5_000));
      assert.equal(result.meta.windowEnd, iso(t + 15_000));

      // 2. Production path: the worker omits p_now, so closure uses clock_timestamp().
      const past = Date.now() - 40 * 60_000;
      await sync(iso(past), [event("d", past - 1_000)]);
      await db.query("select public.sync_ankara_activity_watch($1, true, 0, 0, false, false, '[]'::jsonb)", [run]);
      const [second] = await rows<PeriodRow>(
        `select * from public.ankara_activity_periods where state = 'closed' and period_id <> '${first.period_id}'`);
      assert.match(String(second.closed_at), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?\+00:00$/);
      await archive("d", past - 1_000, 39.5776, 32.1462);
      const live = await exportOf(second.period_id);
      assert.equal(Date.parse(live.meta.activityPeriod.closedAt), Math.floor(Date.parse(String(second.closed_at))));
      assert.equal(live.meta.districtSummary.districts[0].district, "Polatlı");
    } finally {
      await db.close();
    }
  });
