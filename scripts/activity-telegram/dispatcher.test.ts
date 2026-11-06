import test from "node:test";
import assert from "node:assert/strict";
import { ActivityExportError, type ActivityExport, type PeriodRow } from "../activity-export/export.ts";
import type { ActivityExportStore } from "../activity-export/store.ts";
import { ActivityNotificationDispatcher, createActivityTelegram } from "./dispatcher.ts";
import type { ClaimResult, Completion, NotificationKind, NotificationStore } from "./store.ts";
import { mockTelegram } from "./test-support.ts";
import type { TelegramDelivery } from "./telegram.ts";

const PID = "11111111-1111-4111-8111-111111111111";
const T = Date.parse("2026-11-06T11:32:00.000Z");
const token = "123456:THIS_IS_A_FIXTURE_TOKEN_NOT_A_SECRET";
const period = (overrides: Partial<PeriodRow> = {}): PeriodRow => ({ period_id: PID, state: "closed",
  started_at: new Date(T).toISOString(), last_detection_at: new Date(T + 60_000).toISOString(), detection_count: 3,
  closed_at: new Date(T + 31 * 60_000).toISOString(), coverage_uncertain: false, interruption_count: 0,
  source_health: "healthy", healthy_since: null, ...overrides });
const unusedExportStore: ActivityExportStore = {
  getPeriod: async () => { throw new Error("unexpected read"); }, listMembers: async () => { throw new Error("unexpected"); },
  getCaptures: async () => { throw new Error("unexpected"); } };

function fakeStore(kind: NotificationKind, row: PeriodRow, options: { prepareFailures?: number;
  begin?: "proceed" | "superseded" | "lost"; completeFails?: number; claimFails?: boolean } = {}) {
  const completions: Completion[] = [];
  let claimed = false, completeFailures = options.completeFails ?? 0;
  const store: NotificationStore = {
    async claim(): Promise<ClaimResult> {
      if (options.claimFails) throw new Error("database unavailable");
      if (claimed) return { outcome: "idle" };
      claimed = true;
      return { outcome: "claimed", notification: { periodId: PID, kind, idempotencyKey: `ankara-activity:v1:${PID}:${kind}`,
        attempts: 0, prepareFailures: options.prepareFailures ?? 0, period: row } };
    },
    async beginSend() { return options.begin ?? "proceed"; },
    async complete(_worker, _period, _kind, completion) {
      if (completeFailures-- > 0) throw new Error("database unavailable");
      completions.push(completion);
      return "recorded";
    },
    async firstDetection() { return { eventTime: row.started_at, latitude: 39.79, longitude: 32.81 }; },
  };
  return { store, completions };
}
const dispatcher = (store: NotificationStore, responses: TelegramDelivery[] = [],
  exportPeriod?: (store: ActivityExportStore, id: string) => Promise<ActivityExport>) => {
  const telegram = mockTelegram(responses);
  const logs: unknown[] = [];
  const instance = new ActivityNotificationDispatcher({ store, exportStore: unusedExportStore, telegram,
    emit: (kind, fields) => logs.push({ kind, ...fields }), now: () => T + 40 * 60_000,
    exportPeriod: exportPeriod ?? (async () => { throw new Error("unexpected export"); }) });
  return { instance, telegram, logs };
};

test("the 50,000-record ceiling yields a text-only completion without reading the archive", async () => {
  const { store, completions } = fakeStore("end", period({ detection_count: 50_001 }));
  const { instance, telegram } = dispatcher(store);
  assert.equal(await instance.tick(), "processed");
  assert.equal(telegram.sent.length, 1);
  assert.equal(telegram.sent[0].method, "sendMessage");
  assert.match(telegram.sent[0].text, /Toplam: 50\.001 Blitzortung tespit kaydı/);
  assert.match(telegram.sent[0].text, /Replay sınırını \(50\.000\) aşıyor/);
  assert.deepEqual(completions, [{ outcome: "sent", messageId: 101, attachment: "unavailable:export_too_large" }]);
});

test("periods above the in-worker attachment cap get a text-only completion without reading the archive", async () => {
  const { store, completions } = fakeStore("end", period({ detection_count: 5_001 }));
  const { instance, telegram } = dispatcher(store);
  await instance.tick();
  assert.equal(telegram.sent[0].method, "sendMessage");
  assert.match(telegram.sent[0].text, /Telegram eki sınırını \(5\.000\) aşıyor; Replay kaydı operatör aracıyla alınabilir/);
  assert.deepEqual(completions, [{ outcome: "sent", messageId: 101, attachment: "unavailable:worker_attachment_limit" }]);
});

test("export errors from PR-3 degrade to an honest text-only completion", async () => {
  for (const [code, text] of [["export_too_large", /Replay sınırını/], ["archive_inconsistent", /arşiv verisi tutarsız/],
    ["period_membership_inconsistent", /arşiv verisi tutarsız/], ["no_archived_events", /arşiv kaydı bulunamadı/]] as const) {
    const { store, completions } = fakeStore("end", period());
    const { instance, telegram } = dispatcher(store, [], async () => { throw new ActivityExportError(code, "x"); });
    await instance.tick();
    assert.equal(telegram.sent[0].method, "sendMessage");
    assert.match(telegram.sent[0].text, text);
    assert.equal((completions[0] as { attachment: string }).attachment,
      `unavailable:${code === "period_membership_inconsistent" ? "archive_inconsistent" : code}`);
  }
});

test("a transient export read failure is retried later, then reported without an attachment", async () => {
  const failing = async () => { throw new Error("HTTP 503"); };
  const first = fakeStore("end", period());
  const run = dispatcher(first.store, [], failing);
  assert.equal(await run.instance.tick(), "processed");
  assert.equal(run.telegram.sent.length, 0);
  assert.deepEqual(first.completions, [{ outcome: "prepare_failed", detail: "export_read_failed" }]);
  const later = fakeStore("end", period(), { prepareFailures: 3 });
  const retry = dispatcher(later.store, [], failing);
  await retry.instance.tick();
  assert.match(retry.telegram.sent[0].text, /arşive geçici olarak erişilemedi/);
});

test("Telegram outcomes map to durable completions; ambiguity is never a failure", async () => {
  const cases: [TelegramDelivery, Completion][] = [
    [{ status: "ambiguous", detail: "timeout" }, { outcome: "ambiguous", detail: "timeout", attachment: null }],
    [{ status: "retry", detail: "telegram_429", retryAfterSeconds: 30 },
      { outcome: "retry", detail: "telegram_429", retryAfterSeconds: 30 }],
    [{ status: "failed", detail: "telegram_403" }, { outcome: "failed", detail: "telegram_403" }],
  ];
  for (const [delivery, completion] of cases) {
    const { store, completions } = fakeStore("start", period({ state: "active", closed_at: null }));
    const { instance } = dispatcher(store, [delivery]);
    await instance.tick();
    assert.deepEqual(completions, [completion]);
  }
});

test("a superseded or lost reservation sends nothing", async () => {
  for (const begin of ["superseded", "lost"] as const) {
    const { store, completions } = fakeStore("start", period({ state: "active", closed_at: null }), { begin });
    const { instance, telegram } = dispatcher(store);
    await instance.tick();
    assert.equal(telegram.sent.length, 0);
    assert.deepEqual(completions, []);
  }
});

test("an unrecorded confirmation is retried before any new claim and never resent", async () => {
  const { store, completions } = fakeStore("start", period({ state: "active", closed_at: null }), { completeFails: 4 });
  let now = T;
  const telegram = mockTelegram();
  const instance = new ActivityNotificationDispatcher({ store, exportStore: unusedExportStore, telegram, emit: () => {},
    now: () => now });
  assert.equal(await instance.tick(), "processed");
  assert.equal(telegram.sent.length, 1);
  assert.deepEqual(completions, []);
  now += 10 * 60_000;
  assert.equal(await instance.tick(), "idle"); // the stored confirmation came first, then the claim
  assert.deepEqual(completions, [{ outcome: "sent", messageId: 101, attachment: null }]);
  assert.equal(telegram.sent.length, 1);
});

test("database outages back off without throwing or sending", async () => {
  const { store } = fakeStore("start", period(), { claimFails: true });
  const { instance, telegram, logs } = dispatcher(store);
  assert.equal(await instance.tick(), "backoff");
  assert.equal(await instance.tick(), "backoff");
  assert.equal(telegram.sent.length, 0);
  assert.ok(logs.some(log => (log as { kind: string }).kind === "activity_telegram_error"));
});

test("the flag disables only Activity notifications; enabled mode uses existing credentials safely", async () => {
  const calls: string[] = [];
  const fetcher = (async (input: URL | string) => {
    calls.push(String(input));
    return new Response(JSON.stringify({ outcome: "idle" }), { status: 200 });
  }) as typeof fetch;
  const env = { TELEGRAM_BOT_TOKEN: token, TELEGRAM_CHAT_ID: "-1001", SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "service-role-test-key" };
  const logs: unknown[] = [];
  const emit = (kind: string, fields?: Record<string, unknown>) => logs.push({ kind, ...fields });
  for (const flag of [undefined, "false", "TRUE", "1"]) {
    assert.equal(createActivityTelegram({ ...env, ACTIVITY_TELEGRAM_ENABLED: flag }, emit, fetcher), null);
  }
  assert.deepEqual(calls, []);
  assert.equal(createActivityTelegram({ ...env, ACTIVITY_TELEGRAM_ENABLED: "true", TELEGRAM_BOT_TOKEN: "" }, emit, fetcher), null);
  assert.deepEqual(logs, [{ kind: "configuration_warning", capability: "activity_telegram", disabled: true,
    invalidSettings: ["TELEGRAM_BOT_TOKEN"] }]);
  assert.equal(createActivityTelegram({ ...env, ACTIVITY_TELEGRAM_ENABLED: "true", SUPABASE_URL: "http://bad" }, emit, fetcher),
    null);
  const enabled = createActivityTelegram({ ...env, ACTIVITY_TELEGRAM_ENABLED: "true" }, emit, fetcher);
  assert.ok(enabled);
  await new Promise(resolve => setImmediate(resolve));
  enabled.stop();
  assert.deepEqual(calls, ["https://example.supabase.co/rest/v1/rpc/claim_ankara_activity_notification"]);
  assert.ok(!JSON.stringify(logs).includes(token) && !JSON.stringify(logs).includes("service-role-test-key"));
});
