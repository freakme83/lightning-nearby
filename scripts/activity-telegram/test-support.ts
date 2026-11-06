// Test-only adapters that execute the real migrations' SQL in PGlite with a controlled clock.
// Nothing here is imported by the worker.
import { readFile } from "node:fs/promises";
import type { ActivityExportStore } from "../activity-export/store.ts";
import type { CaptureRow, MembershipRow, PeriodRow } from "../activity-export/export.ts";
import type { ActivityStore } from "../fly-ankara-worker/activity-watch.ts";
import { eligibleActivityEvent } from "../fly-ankara-worker/activity-watch.ts";
import { parseDecodedBlitzortungPayload, type BlitzortungProbeEvent } from "../research/blitzortung-probe/protocol.ts";
import { completionArgs, parseClaim, type NotificationStore } from "./store.ts";
import type { ActivityTelegramClient, TelegramDelivery } from "./telegram.ts";

type Db = { query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  exec(sql: string): Promise<unknown>; close(): Promise<void> };
const MIGRATIONS = [
  "../continuous-capture/migrations/20261101204137_ankara_continuous_capture_v1.sql",
  "../activity-watch/migrations/20261103123000_ankara_activity_watch_v1.sql",
  "./migrations/20261106120000_ankara_activity_notifications_v1.sql",
];
export const iso = (ms: number) => new Date(ms).toISOString();

export async function createDatabase(modulePath: string): Promise<Db> {
  const { PGlite } = await import(modulePath);
  const db = new PGlite() as Db;
  await db.exec("create role anon; create role authenticated; create role service_role bypassrls");
  for (const path of MIGRATIONS) await db.exec(await readFile(new URL(path, import.meta.url), "utf8"));
  await db.exec("set role service_role");
  return db;
}

const one = async (db: Db, sql: string, params: unknown[]) => (await db.query(sql, params)).rows[0].r;
// PostgREST serializes rows with to_json; json_agg reproduces its timestamptz text.
async function rows<T>(db: Db, sql: string, params: unknown[] = []): Promise<T[]> {
  return (await db.query(`select coalesce(json_agg(x), '[]'::json) as r from (${sql}) x`, params)).rows[0].r as T[];
}

/** The production NotificationStore contract, backed by the real RPCs and a test clock. */
export function sqlNotificationStore(db: Db, clock: () => number, hooks: { failing?: () => boolean } = {}): NotificationStore {
  const guard = () => { if (hooks.failing?.()) throw new Error("database unavailable"); };
  return {
    async claim(workerId) {
      guard();
      return parseClaim(await one(db, "select public.claim_ankara_activity_notification($1, $2) as r", [workerId, iso(clock())]));
    },
    async beginSend(workerId, periodId, kind) {
      guard();
      return (await one(db, "select public.begin_ankara_activity_notification_send($1, $2, $3, $4) as r",
        [workerId, periodId, kind, iso(clock())]) as { outcome: "proceed" | "superseded" | "lost" }).outcome;
    },
    async complete(workerId, periodId, kind, completion) {
      guard();
      const a = completionArgs(completion);
      return (await one(db, "select public.complete_ankara_activity_notification($1,$2,$3,$4,$5,$6,$7,$8,$9) as r",
        [workerId, periodId, kind, a.p_outcome, a.p_detail, a.p_retry_after_seconds, a.p_message_id, a.p_attachment,
          iso(clock())]) as { outcome: "recorded" | "not_owner" | "invalid_transition" }).outcome;
    },
    async firstDetection(periodId) {
      guard();
      const [row] = await rows<{ event_time: string; latitude: number | null; longitude: number | null }>(db,
        `select m.event_time, c.latitude, c.longitude from public.ankara_activity_period_events m
         left join public.continuous_capture_strikes c using (event_key)
         where m.period_id = $1 order by m.event_time, m.event_key limit 1`, [periodId]);
      return row ? { eventTime: row.event_time, latitude: row.latitude, longitude: row.longitude } : null;
    },
  };
}

/** PR-3's ActivityExportStore contract (keyed archive join) over the same database. */
export function sqlExportStore(db: Db, hooks: { failing?: () => boolean } = {}): ActivityExportStore {
  const guard = () => { if (hooks.failing?.()) throw new Error("database unavailable"); };
  return {
    async getPeriod(periodId) {
      guard();
      return (await rows<PeriodRow>(db, "select * from public.ankara_activity_periods where period_id = $1", [periodId]))[0] ?? null;
    },
    async listMembers(periodId) {
      guard();
      return rows<MembershipRow>(db, "select * from public.ankara_activity_period_events where period_id = $1", [periodId]);
    },
    async getCaptures(keys) {
      guard();
      return rows<CaptureRow>(db, "select * from public.continuous_capture_strikes where event_key = any($1::text[])", [keys]);
    },
  };
}

/** Activity Watch's ActivityStore contract over the real RPC, with p_now from the test clock. */
export function sqlActivityStore(db: Db, clock: () => number): ActivityStore {
  return { async sync(runId, healthy, gap, events, lost) {
    return one(db, "select public.sync_ankara_activity_watch($1,$2,$3,$4,$5,$6,$7,$8) as r",
      [runId, healthy, gap.sequence, gap.maxMs, gap.unbounded, lost, JSON.stringify(events), iso(clock())]) as never;
  } };
}

export function blitzEvent(eventAtMs: number, receivedAtMs: number, lat: number, lon: number, discriminator = 0):
  BlitzortungProbeEvent {
  // Distinct raw nanoseconds keep same-millisecond detections distinct, as in the live feed.
  const parsed = parseDecodedBlitzortungPayload(JSON.stringify({ time: `${eventAtMs}${String(discriminator).padStart(6, "0")}`,
    lat, lon }), receivedAtMs, "ws1");
  if (parsed.kind !== "event") throw new Error("bad fixture");
  return parsed.event;
}

/** Writes the Continuous Capture row the worker would write for this event. */
export async function archive(db: Db, event: BlitzortungProbeEvent): Promise<string> {
  const key = eligibleActivityEvent(event)!.event_key;
  await db.query(`insert into public.continuous_capture_strikes (event_key, event_time, event_time_raw, event_time_unit,
    received_at, latitude, longitude, source_server, station_count, polygon_id)
    values ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'p') on conflict do nothing`,
  [key, iso(event.eventTimeMs), event.eventTimeRaw, event.eventTimeUnit, iso(event.receivedAtMs), event.latitude,
    event.longitude, event.sourceServer, event.stationCount]);
  return key;
}

export type SentMessage = { method: "sendMessage" | "sendDocument"; text: string; filename?: string; json?: string };
export function mockTelegram(responses: TelegramDelivery[] = []): ActivityTelegramClient & { sent: SentMessage[] } {
  const sent: SentMessage[] = [];
  let messageId = 100;
  const next = (): TelegramDelivery => responses.shift() ?? { status: "sent", messageId: ++messageId };
  return { sent,
    async sendMessage(text) { sent.push({ method: "sendMessage", text }); return next(); },
    async sendDocument(caption, filename, json) { sent.push({ method: "sendDocument", text: caption, filename, json }); return next(); },
  };
}

export async function notificationRows(db: Db) {
  return rows<{ period_id: string; kind: string; state: string; attempts: number; attachment: string | null;
    last_outcome: string | null; telegram_message_id: number | null }>(db,
    "select * from public.ankara_activity_notifications order by created_at, kind desc");
}
