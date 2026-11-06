import test from "node:test";
import assert from "node:assert/strict";
import { loadAnkaraDistrictAttributor } from "./districts.ts";
import { ActivityExportError, buildActivityExport, MONITORING_POLYGON_ID, serializeActivityExport,
  type CaptureRow, type MembershipRow, type PeriodRow } from "./export.ts";

const PID = "11111111-1111-4111-8111-111111111111";
const t0 = Date.parse("2026-11-03T12:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();
const pg = (ms: number) => iso(ms).replace("Z", "+00:00"); // PostgREST timestamptz form
const key = (n: number) => n.toString(16).padStart(64, "0");
const attributor = loadAnkaraDistrictAttributor();
const KIZILAY = [39.9208, 32.8541], KECIOREN = [39.98, 32.86], POLATLI = [39.5776, 32.1462], KIRIKKALE = [39.8468, 33.5153];

const period = (overrides: Partial<PeriodRow> = {}): PeriodRow => ({ period_id: PID, state: "closed",
  started_at: pg(t0), last_detection_at: pg(t0 + 120_000), detection_count: 4, closed_at: pg(t0 + 120_000 + 31 * 60_000),
  coverage_uncertain: false, interruption_count: 0, source_health: "healthy", healthy_since: pg(t0), ...overrides });
const member = (n: number, at: number): MembershipRow => ({ event_key: key(n), period_id: PID, event_time: pg(at),
  received_at: pg(at + 1_500) });
const capture = (n: number, at: number, [lat, lon]: number[], extra: Partial<CaptureRow> = {}): CaptureRow => ({
  event_key: key(n), event_time: pg(at), event_time_raw: String(BigInt(at) * BigInt(1_000_000) + BigInt(n)), event_time_unit: "nanoseconds",
  received_at: pg(at + 1_500), latitude: lat, longitude: lon, provider: "blitzortung", source_server: "ws1",
  station_count: 12, polygon_id: MONITORING_POLYGON_ID, ...extra });

// Two detections share one millisecond (distinct raw nanoseconds and positions).
const members = [member(4, t0 + 120_000), member(2, t0 + 60_000), member(1, t0), member(3, t0 + 60_000)];
const captures = [capture(3, t0 + 60_000, KECIOREN), capture(1, t0, KIZILAY, { source_server: "ws8", station_count: null }),
  capture(4, t0 + 120_000, POLATLI), capture(2, t0 + 60_000, KIZILAY)];
const build = (overrides: Partial<Parameters<typeof buildActivityExport>[0]> = {}) =>
  buildActivityExport({ periodId: PID, period: period(), members, captures, attributor, ...overrides });
const rejects = (fn: () => unknown, code: string) =>
  assert.throws(fn, (error: unknown) => error instanceof ActivityExportError && error.code === code);

test("completed period with multiple districts: summary, ordering and shared milliseconds", () => {
  const result = build();
  assert.deepEqual(result.events.map(event => event.id), [key(1), key(2), key(3), key(4)]);
  // Same-millisecond detections remain two events with the identical timestamp, ordered by key.
  assert.equal(result.events[1].timestamp, result.events[2].timestamp);
  assert.equal(result.events[1].timestamp, iso(t0 + 60_000));
  assert.notEqual(result.events[1].eventTimeRaw, result.events[2].eventTimeRaw);
  assert.deepEqual(result.meta.districtSummary, { countUnit: "blitzortung_detection_record",
    recordedDetectionCount: 4, exportedEventCount: 4, missingArchiveRecordCount: 0,
    districts: [{ district: "Çankaya", detections: 2 }, { district: "Keçiören", detections: 1 },
      { district: "Polatlı", detections: 1 }], unknown: { detections: 0, byReason: {} } });
  assert.deepEqual(result.events[0], { id: key(1), timestamp: iso(t0), lat: KIZILAY[0], lon: KIZILAY[1], type: "unknown",
    eventKey: key(1), receivedAt: iso(t0 + 1_500), district: "Çankaya", districtStatus: "district",
    stationCount: null, sourceServer: "ws8", eventTimeRaw: String(BigInt(t0) * BigInt(1_000_000) + BigInt(1)), eventTimeUnit: "nanoseconds" });
  const meta = result.meta;
  assert.equal(meta.activityPeriod.periodId, PID);
  assert.equal(meta.activityPeriod.firstDetectionAt, iso(t0));
  assert.equal(meta.activityPeriod.lastDetectionAt, iso(t0 + 120_000));
  assert.equal(meta.activityPeriod.closedAt, "2026-11-03T12:33:00.000000Z");
  assert.equal(meta.source, "Blitzortung");
  assert.equal(meta.countUnit, "blitzortung_detection_record");
  assert.match(meta.description, /not an independently verified physical lightning discharge/);
  assert.equal(meta.monitoringArea.polygonId, MONITORING_POLYGON_ID);
  assert.equal(meta.archive.complete, true);
});

test("playback ends 10 seconds after the last detection, never at the 30-minute closure", () => {
  const meta = build().meta;
  assert.equal(meta.windowStart, iso(t0));
  assert.equal(meta.windowEnd, iso(t0 + 120_000 + 10_000));
  assert.equal(meta.playbackTailSeconds, 10);
  assert.ok(Date.parse(meta.windowEnd) < Date.parse(meta.activityPeriod.closedAt));
});

test("unknown attribution is counted, not assigned", () => {
  const result = build({ captures: [...captures.slice(0, 2), capture(4, t0 + 120_000, KIRIKKALE), captures[3]] });
  assert.deepEqual(result.meta.districtSummary.unknown, { detections: 1, byReason: { outside_district_dataset: 1 } });
  const event = result.events.find(item => item.id === key(4))!;
  assert.equal(event.district, null);
  assert.equal(event.districtStatus, "unknown");
  assert.equal(event.districtReason, "outside_district_dataset");
});

test("missing Continuous Capture rows are reported, never invented or hidden", () => {
  const result = build({ captures: captures.filter(row => row.event_key !== key(3) && row.event_key !== key(4)) });
  const meta = result.meta;
  assert.deepEqual(result.events.map(event => event.id), [key(1), key(2)]);
  assert.deepEqual(meta.archive, { complete: false, exportedEventCount: 2, missingArchiveRecordCount: 2,
    missingArchiveEventKeys: [key(3), key(4)] });
  assert.equal(result.meta.districtSummary.recordedDetectionCount, 4);
  assert.equal(result.meta.districtSummary.missingArchiveRecordCount, 2);
  // Playback still covers the recorded period: the window follows membership, not surviving rows.
  assert.equal(meta.windowEnd, iso(t0 + 130_000));
});

test("a period with no archived rows fails clearly", () => {
  rejects(() => build({ captures: [] }), "no_archived_events");
});

test("coverage uncertainty and short interruptions are carried through", () => {
  const meta = build({ period: period({ coverage_uncertain: true, interruption_count: 2 }) }).meta;
  assert.equal(meta.activityPeriod.coverageUncertain, true);
  assert.equal(meta.activityPeriod.interruptionCount, 2);
});

test("a database-clock closed_at with microseconds is valid and preserved; event times stay millisecond-strict", () => {
  // Activity Watch closes with p_now = clock_timestamp(), e.g. as PostgREST returns it:
  const closedAt = "2026-11-03T12:33:00.123456+00:00";
  const meta = build({ period: period({ closed_at: closedAt }) }).meta;
  assert.equal(meta.activityPeriod.closedAt, "2026-11-03T12:33:00.123456Z");
  assert.equal(build({ period: period({ closed_at: "2026-11-03T15:33:00.000001+03:00" }) }).meta.activityPeriod.closedAt,
    "2026-11-03T12:33:00.000001Z");
  // A millisecond closure is reported at the same six-digit precision.
  assert.equal(build().meta.activityPeriod.closedAt, `${iso(t0 + 120_000 + 31 * 60_000).slice(0, -1)}000Z`);
  rejects(() => build({ period: period({ closed_at: "2026-11-03T12:33:00.1234567+00:00" }) }), "invalid_period");
  // Detection timestamps come from millisecond event times and must not lose digits.
  rejects(() => build({ period: period({ last_detection_at: "2026-11-03T12:02:00.000123+00:00" }) }), "invalid_period");
  rejects(() => build({ period: period({ started_at: "2026-11-03T12:00:00.000500+00:00" }) }), "invalid_period");
  rejects(() => build({ members: [...members.slice(0, 3), { ...members[3], event_time: "2026-11-03T12:01:00.000001+00:00" }] }),
    "period_membership_inconsistent");
});

test("active, nonexistent, invalid and incomplete periods are rejected", () => {
  rejects(() => build({ period: period({ state: "active", closed_at: null }) }), "period_active");
  rejects(() => build({ period: null }), "period_not_found");
  rejects(() => build({ periodId: "not-a-uuid" }), "invalid_period_id");
  rejects(() => build({ period: period({ state: "closed", closed_at: null }) }), "invalid_period");
  rejects(() => build({ period: period({ closed_at: pg(t0) }) }), "invalid_period");
  rejects(() => build({ members: members.slice(1) }), "period_membership_inconsistent");
  rejects(() => build({ members: [...members.slice(0, 3), { ...members[3], period_id: "22222222-2222-4222-8222-222222222222" }] }),
    "period_membership_inconsistent");
  rejects(() => build({ period: period({ last_detection_at: pg(t0 + 119_000) }) }), "period_membership_inconsistent");
  rejects(() => build({ captures: [...captures, capture(9, t0, KIZILAY)] }), "archive_inconsistent");
  rejects(() => build({ captures: [captures[0], captures[0]] }), "archive_inconsistent");
  rejects(() => build({ captures: [{ ...captures[0], event_time: pg(t0 + 60_001) }] }), "archive_inconsistent");
  rejects(() => build({ captures: [{ ...captures[0], event_time: "2026-11-03T12:01:00.000123+00:00" }] }), "archive_inconsistent");
});

test("repeated exports are byte-identical regardless of input order", () => {
  const first = serializeActivityExport(build());
  const second = serializeActivityExport(build({ members: [...members].reverse(), captures: [...captures].reverse() }));
  assert.equal(first, second);
  assert.ok(first.endsWith("}\n"));
});

test("output matches Replay Studio's { meta, events } input contract", () => {
  const parsed = JSON.parse(serializeActivityExport(build()));
  assert.deepEqual(Object.keys(parsed), ["meta", "events"]);
  assert.equal(typeof parsed.meta, "object");
  for (const event of parsed.events) {
    assert.equal(typeof event.id, "string");
    assert.match(event.timestamp, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    assert.ok(event.lat >= -90 && event.lat <= 90 && event.lon >= -180 && event.lon <= 180);
    assert.equal(event.type, "unknown");
    // No field may alias Replay Studio's intensity column or an alternative time/position column.
    for (const field of ["intensity", "amplitude", "peak_current", "time", "datetime", "x", "y", "t", "latitude", "longitude"]) {
      assert.equal(field in event, false, field);
    }
  }
  assert.ok(parsed.meta.windowStart <= parsed.events[0].timestamp);
  assert.ok(parsed.meta.windowEnd >= parsed.events.at(-1).timestamp);
  assert.equal(parsed.meta.synthetic, false);
  assert.equal(parsed.meta.utcOffset, "+03:00");
});

// Optional cross-repository check, like the PGlite SQL tests: point this at a checkout of
// lightning-replay-studio's src/core/parse.js and src/core/replay.js directory.
const studioCore = process.env.REPLAY_STUDIO_CORE_DIR;
test("Replay Studio's own parser accepts the export unchanged", { skip: !studioCore }, async () => {
  const { parseDataset } = await import(`${studioCore}/parse.js`);
  const { resolveTimeRange } = await import(`${studioCore}/replay.js`);
  const text = serializeActivityExport(build());
  const dataset = parseDataset(text, "ankara-activity.json");
  assert.equal(dataset.ok, true);
  assert.deepEqual(dataset.errors, []);
  assert.equal(dataset.events.length, 4);
  assert.deepEqual(dataset.events.map((event: { id: string }) => event.id), [key(1), key(2), key(3), key(4)]);
  assert.equal(dataset.displayOffsetMin, 180);
  assert.deepEqual(resolveTimeRange(dataset, null), { start: t0, end: t0 + 130_000 });
});
