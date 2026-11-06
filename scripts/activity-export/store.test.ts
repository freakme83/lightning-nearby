import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ActivityExportError } from "./export.ts";
import { exportPeriod, parseArgs, runActivityExport } from "./runner.ts";
import { CAPTURE_KEYS_PER_REQUEST, createActivityExportStore, MEMBERSHIP_PAGE_SIZE } from "./store.ts";

const PID = "11111111-1111-4111-8111-111111111111";
const config = { url: "https://example.supabase.co", serviceRoleKey: "service-role-test-key" };
const t0 = Date.parse("2026-11-03T12:00:00.000Z");
const key = (n: number) => n.toString(16).padStart(64, "0");
const pg = (ms: number) => new Date(ms).toISOString().replace("Z", "+00:00");

function fakeSupabase(total: number, state = "closed", archived = (n: number) => n !== 0) {
  const requests: { method: string; url: URL; headers: Record<string, string> }[] = [];
  const members = Array.from({ length: total }, (_, n) => ({ event_key: key(n), period_id: PID,
    event_time: pg(t0 + n * 1_000), received_at: pg(t0 + n * 1_000 + 900) }));
  const fetcher = (async (input: URL, init: RequestInit) => {
    const url = new URL(input);
    requests.push({ method: String(init.method), url, headers: init.headers as Record<string, string> });
    const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200 });
    if (url.pathname === "/rest/v1/ankara_activity_periods") {
      return json(url.searchParams.get("period_id") === `eq.${PID}` ? [{ period_id: PID, state,
        started_at: pg(t0), last_detection_at: pg(t0 + (total - 1) * 1_000), detection_count: total,
        closed_at: state === "closed" ? pg(t0 + (total - 1) * 1_000 + 1_800_000) : null, coverage_uncertain: false,
        interruption_count: 0, source_health: "healthy", healthy_since: pg(t0) }] : []);
    }
    if (url.pathname === "/rest/v1/ankara_activity_period_events") {
      const offset = Number(url.searchParams.get("offset")), limit = Number(url.searchParams.get("limit"));
      return json(members.slice(offset, offset + limit));
    }
    if (url.pathname === "/rest/v1/continuous_capture_strikes") {
      const keys = /^in\.\((.*)\)$/.exec(url.searchParams.get("event_key")!)![1].split(",");
      return json(keys.map(k => parseInt(k, 16)).filter(archived).map(n => ({ event_key: key(n),
        event_time: pg(t0 + n * 1_000), event_time_raw: String(t0 + n * 1_000), event_time_unit: "milliseconds",
        received_at: pg(t0 + n * 1_000 + 900), latitude: 39.9208, longitude: 32.8541, provider: "blitzortung",
        source_server: "ws1", station_count: 9, polygon_id: "p" })));
    }
    return new Response("unexpected", { status: 404 });
  }) as typeof fetch;
  return { fetcher, requests };
}

test("bounded, read-only pagination joins membership keys to the archive", async () => {
  const total = MEMBERSHIP_PAGE_SIZE + 5;
  const { fetcher, requests } = fakeSupabase(total);
  const result = await exportPeriod(createActivityExportStore(config, fetcher), PID);
  assert.ok(requests.every(request => request.method === "GET"));
  const memberPages = requests.filter(request => request.url.pathname.endsWith("ankara_activity_period_events"));
  assert.deepEqual(memberPages.map(request => request.url.searchParams.get("offset")), ["0", String(MEMBERSHIP_PAGE_SIZE)]);
  assert.ok(memberPages.every(request => request.url.searchParams.get("order") === "event_key.asc"));
  const captureReads = requests.filter(request => request.url.pathname.endsWith("continuous_capture_strikes"));
  assert.equal(captureReads.length, Math.ceil(total / CAPTURE_KEYS_PER_REQUEST));
  // No broad time-window query is ever issued against the archive.
  assert.ok(captureReads.every(request => !request.url.searchParams.has("event_time")));
  assert.equal(result.events.length, total - 1);
  assert.deepEqual(result.meta.archive.missingArchiveEventKeys, [key(0)]);
});

test("active and nonexistent periods are rejected before any event read", async () => {
  for (const [state, id, code] of [["active", PID, "period_active"],
    ["closed", "22222222-2222-4222-8222-222222222222", "period_not_found"]] as const) {
    const { fetcher, requests } = fakeSupabase(3, state);
    await assert.rejects(exportPeriod(createActivityExportStore(config, fetcher), id),
      (error: unknown) => error instanceof ActivityExportError && error.code === code);
    assert.equal(requests.length, 1);
  }
  await assert.rejects(exportPeriod(createActivityExportStore(config, fakeSupabase(1).fetcher), "x"), /UUID/);
});

test("upstream failures do not echo response bodies", async () => {
  const fetcher = (async () => new Response("secret upstream detail", { status: 500 })) as typeof fetch;
  await assert.rejects(createActivityExportStore(config, fetcher).getPeriod(PID), error =>
    error instanceof Error && error.message === "Activity export read failed (HTTP 500)");
  assert.throws(() => createActivityExportStore({ url: "http://example.com", serviceRoleKey: "k" }), /invalid/);
});

test("runner writes deterministic JSON once and never overwrites", async () => {
  const directory = await mkdtemp(join(tmpdir(), "activity-export-"));
  try {
    const out = join(directory, "period.json");
    const logs: unknown[] = [];
    const env = { SUPABASE_URL: config.url, SUPABASE_SERVICE_ROLE_KEY: config.serviceRoleKey };
    await runActivityExport([`--period-id=${PID}`, `--out=${out}`], env, value => logs.push(value), fakeSupabase(3).fetcher);
    const first = await readFile(out, "utf8");
    assert.equal(JSON.parse(first).events.length, 2);
    assert.ok(!JSON.stringify(logs).includes(config.serviceRoleKey));
    await assert.rejects(runActivityExport([`--period-id=${PID}`, `--out=${out}`], env, () => {}, fakeSupabase(3).fetcher),
      /EEXIST/);
    const second = join(directory, "again.json");
    await runActivityExport([`--period-id=${PID}`, `--out=${second}`], env, () => {}, fakeSupabase(3).fetcher);
    assert.equal(await readFile(second, "utf8"), first);
    assert.throws(() => parseArgs([`--period-id=${PID}`]), /Usage/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
