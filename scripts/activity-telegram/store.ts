// Supabase access for Activity Watch notification state. Writes go only to the notification
// tables through their three RPCs; Activity Watch and Continuous Capture tables are read only.
import { supabaseConnection } from "../lightning-publication-ledger/storage/supabase.ts";
import type { PeriodRow } from "../activity-export/export.ts";

export type NotificationKind = "start" | "end";
export type ClaimedNotification = { periodId: string; kind: NotificationKind; idempotencyKey: string;
  attempts: number; prepareFailures: number; period: PeriodRow };
export type ClaimResult = { outcome: "idle" } | { outcome: "wait"; retryAtMs: number } |
  { outcome: "claimed"; notification: ClaimedNotification };
export type BeginSendResult = "proceed" | "superseded" | "lost";
export type Completion =
  | { outcome: "sent"; messageId: number | null; attachment: string | null }
  | { outcome: "ambiguous"; detail: string; attachment: string | null }
  | { outcome: "retry"; detail: string; retryAfterSeconds?: number }
  | { outcome: "failed"; detail: string }
  | { outcome: "prepare_failed"; detail: string }
  | { outcome: "release"; detail: string; retryAfterSeconds: number };
export type CompleteResult = "recorded" | "not_owner" | "invalid_transition";
export type FirstDetection = { eventTime: string; latitude: number | null; longitude: number | null };

export type NotificationStore = {
  claim(workerId: string, signal: AbortSignal): Promise<ClaimResult>;
  beginSend(workerId: string, periodId: string, kind: NotificationKind, signal: AbortSignal): Promise<BeginSendResult>;
  complete(workerId: string, periodId: string, kind: NotificationKind, completion: Completion,
    signal: AbortSignal): Promise<CompleteResult>;
  /** Earliest Activity Watch member of the period and, if archived, its coordinates. */
  firstDetection(periodId: string, signal: AbortSignal): Promise<FirstDetection | null>;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const object = (value: unknown) => value && typeof value === "object" && !Array.isArray(value)
  ? value as Record<string, unknown> : null;

export function parseClaim(value: unknown): ClaimResult {
  const row = object(value);
  if (row?.outcome === "idle") return { outcome: "idle" };
  if (row?.outcome === "wait" && typeof row.retryAt === "string" && Number.isFinite(Date.parse(row.retryAt))) {
    return { outcome: "wait", retryAtMs: Date.parse(row.retryAt) };
  }
  const note = object(row?.notification), period = object(row?.period);
  if (row?.outcome !== "claimed" || !note || !period || typeof note.period_id !== "string" || !UUID.test(note.period_id) ||
      (note.kind !== "start" && note.kind !== "end") || typeof note.idempotency_key !== "string" ||
      !Number.isSafeInteger(note.attempts) || !Number.isSafeInteger(note.prepare_failures) ||
      period.period_id !== note.period_id) {
    throw new Error("Invalid notification claim response");
  }
  return { outcome: "claimed", notification: { periodId: note.period_id, kind: note.kind,
    idempotencyKey: note.idempotency_key, attempts: note.attempts as number,
    prepareFailures: note.prepare_failures as number, period: period as unknown as PeriodRow } };
}

export function completionArgs(completion: Completion): Record<string, unknown> {
  return { p_outcome: completion.outcome,
    p_detail: "detail" in completion ? completion.detail : null,
    p_retry_after_seconds: "retryAfterSeconds" in completion ? completion.retryAfterSeconds ?? null : null,
    p_message_id: completion.outcome === "sent" ? completion.messageId : null,
    p_attachment: "attachment" in completion ? completion.attachment : null };
}

export function createNotificationStore(config: { url?: string; serviceRoleKey?: string },
  fetcher: typeof fetch = fetch): NotificationStore {
  const { endpoint, headers } = supabaseConnection(config);
  async function request(path: string, init: RequestInit, signal: AbortSignal): Promise<unknown> {
    const response = await fetcher(new URL(path, endpoint), { ...init, cache: "no-store", signal,
      headers: { ...headers, Accept: "application/json", ...(init.body ? { "Content-Type": "application/json" } : {}) } });
    // Never surface upstream bodies.
    if (!response.ok) throw new Error(`Activity notification storage HTTP ${response.status}`);
    return response.json();
  }
  const rpc = (name: string, args: Record<string, unknown>, signal: AbortSignal) =>
    request(`/rest/v1/rpc/${name}`, { method: "POST", body: JSON.stringify(args) }, signal);
  return {
    async claim(workerId, signal) {
      return parseClaim(await rpc("claim_ankara_activity_notification", { p_worker_id: workerId }, signal));
    },
    async beginSend(workerId, periodId, kind, signal) {
      const outcome = object(await rpc("begin_ankara_activity_notification_send",
        { p_worker_id: workerId, p_period_id: periodId, p_kind: kind }, signal))?.outcome;
      if (outcome !== "proceed" && outcome !== "superseded" && outcome !== "lost") {
        throw new Error("Invalid notification send response");
      }
      return outcome;
    },
    async complete(workerId, periodId, kind, completion, signal) {
      const outcome = object(await rpc("complete_ankara_activity_notification",
        { p_worker_id: workerId, p_period_id: periodId, p_kind: kind, ...completionArgs(completion) }, signal))?.outcome;
      if (outcome !== "recorded" && outcome !== "not_owner" && outcome !== "invalid_transition") {
        throw new Error("Invalid notification completion response");
      }
      return outcome;
    },
    async firstDetection(periodId, signal) {
      if (!UUID.test(periodId)) throw new Error("Invalid period ID");
      const members = await request(`/rest/v1/ankara_activity_period_events?select=event_key,event_time` +
        `&period_id=eq.${periodId}&order=event_time.asc,event_key.asc&limit=1`, { method: "GET" }, signal);
      const member = Array.isArray(members) && members.length === 1 ? object(members[0]) : null;
      if (!member) return null;
      if (typeof member.event_key !== "string" || !/^[0-9a-f]{64}$/.test(member.event_key) ||
          typeof member.event_time !== "string") throw new Error("Invalid membership row");
      const captures = await request(`/rest/v1/continuous_capture_strikes?select=latitude,longitude` +
        `&event_key=eq.${member.event_key}&limit=1`, { method: "GET" }, signal);
      const capture = Array.isArray(captures) && captures.length === 1 ? object(captures[0]) : null;
      const valid = capture && Number.isFinite(capture.latitude) && Number.isFinite(capture.longitude);
      return { eventTime: member.event_time, latitude: valid ? capture.latitude as number : null,
        longitude: valid ? capture.longitude as number : null };
    },
  };
}
