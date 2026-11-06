// Activity Watch Telegram dispatcher. It runs on its own unreferenced timer and only reads
// committed database state: it never observes lightning events, never touches Activity Watch,
// Continuous Capture or the publication pipeline, and none of its failures can reach them.
//
// Per notification: claim (lease) -> prepare text/attachment -> begin_send (durable "a request
// may now be issued" mark) -> exactly one Telegram request -> complete. Only a row that
// never reached begin_send can be retried after a crash; anything later is either confirmed,
// definitively failed, or recorded as ambiguous and left for an operator.
import { randomUUID } from "node:crypto";
import { loadAnkaraDistrictAttributor, type DistrictAttributor } from "../activity-export/districts.ts";
import { ActivityExportError, serializeActivityExport, type ActivityExport } from "../activity-export/export.ts";
import { exportPeriod } from "../activity-export/runner.ts";
import { createActivityExportStore, MAX_EXPORT_DETECTIONS, type ActivityExportStore } from "../activity-export/store.ts";
import { endCaption, endTextWithoutAttachment, replayFilename, startMessage, WORKER_ATTACHMENT_MAX_DETECTIONS,
  type AttachmentUnavailableReason, type EndSummary } from "./messages.ts";
import { createNotificationStore, type ClaimedNotification, type Completion, type NotificationStore } from "./store.ts";
import { createActivityTelegramClient, type ActivityTelegramClient, type TelegramDelivery } from "./telegram.ts";

type Emit = (kind: string, fields?: Record<string, unknown>) => void;
export const POLL_MS = 15_000;
const STORE_TIMEOUT_MS = 10_000;
/** Telegram's bot upload limit is 50 MB; stay clearly below it. */
export const MAX_ATTACHMENT_BYTES = 45 * 1024 * 1024;
/** A just-opened period's first archive row is written asynchronously (about every 2 s). */
const ARCHIVE_WAIT_MS = 60_000, ARCHIVE_RECHECK_SECONDS = 15;
const MAX_PREPARE_FAILURES = 3, MAX_PENDING_COMPLETION_TICKS = 40;

export type DispatcherDependencies = {
  store: NotificationStore;
  exportStore: ActivityExportStore;
  telegram: ActivityTelegramClient;
  emit: Emit;
  now?: () => number;
  workerId?: string;
  attributor?: () => DistrictAttributor;
  exportPeriod?: (store: ActivityExportStore, periodId: string) => Promise<ActivityExport>;
};
export type RunResult = "stopped" | "busy" | "backoff" | "idle" | "wait" | "processed" | "error";

type Content = { kind: "text"; text: string; attachment: string | null } |
  { kind: "document"; caption: string; filename: string; json: string };

export class ActivityNotificationDispatcher {
  readonly workerId: string;
  private readonly deps: DispatcherDependencies;
  private readonly now: () => number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight = false;
  private stopped = false;
  private nextAttemptAt = 0;
  private failures = 0;
  private cachedAttributor: DistrictAttributor | null | undefined;
  /** A Telegram outcome that could not yet be written; retried before any new claim. */
  private pendingCompletion: { note: ClaimedNotification; completion: Completion; ticks: number } | null = null;

  constructor(deps: DispatcherDependencies) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
    this.workerId = deps.workerId ?? randomUUID();
  }

  start() {
    if (this.timer || this.stopped) return;
    this.timer = setInterval(() => { void this.tick(); }, POLL_MS);
    this.timer.unref();
    void this.tick();
  }

  /** Stops scheduling. An in-flight Telegram request is not aborted (that would make it ambiguous). */
  stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(): Promise<RunResult> {
    if (this.stopped) return "stopped";
    if (this.inFlight) return "busy";
    if (this.now() < this.nextAttemptAt) return "backoff";
    this.inFlight = true;
    let result: RunResult = "error";
    try {
      result = await this.runOnce();
    } catch {
      result = "error";
      this.backoff("unexpected");
    } finally {
      this.inFlight = false;
    }
    // Drain further due notifications promptly; SQL enforces spacing between sends.
    if (result === "processed" && !this.stopped && this.timer) setImmediate(() => { void this.tick(); });
    return result;
  }

  private async runOnce(): Promise<RunResult> {
    if (this.pendingCompletion) {
      const pending = this.pendingCompletion;
      if (!await this.record(pending.note, pending.completion)) {
        if (++pending.ticks >= MAX_PENDING_COMPLETION_TICKS) {
          this.pendingCompletion = null;
          this.log("activity_telegram_error", { stage: "complete", reason: "abandoned", periodId: pending.note.periodId,
            notification: pending.note.kind });
        }
        this.backoff("complete");
        return "backoff";
      }
      this.pendingCompletion = null;
    }
    let claim;
    try {
      claim = await this.deps.store.claim(this.workerId, AbortSignal.timeout(STORE_TIMEOUT_MS));
    } catch {
      this.backoff("claim");
      return "backoff";
    }
    this.failures = 0;
    this.nextAttemptAt = 0;
    if (claim.outcome === "idle") return "idle";
    if (claim.outcome === "wait") {
      this.nextAttemptAt = claim.retryAtMs;
      return "wait";
    }
    const note = claim.notification;
    const content = note.kind === "start" ? await this.prepareStart(note) : await this.prepareEnd(note);
    if (!content) return "processed";
    await this.send(note, content);
    return "processed";
  }

  private async prepareStart(note: ClaimedNotification): Promise<Content | null> {
    let first = null;
    try {
      first = await this.deps.store.firstDetection(note.periodId, AbortSignal.timeout(STORE_TIMEOUT_MS));
    } catch {
      if (note.prepareFailures < MAX_PREPARE_FAILURES - 1) {
        await this.record(note, { outcome: "prepare_failed", detail: "first_detection_unavailable" });
        return null;
      }
    }
    const firstMs = Date.parse(first?.eventTime ?? note.period.started_at);
    // Wait briefly for the asynchronous archive row; after that, announce without a location.
    if (first && first.latitude === null && this.now() - firstMs < ARCHIVE_WAIT_MS) {
      await this.record(note, { outcome: "release", detail: "awaiting_archive", retryAfterSeconds: ARCHIVE_RECHECK_SECONDS });
      return null;
    }
    let district: string | null = null;
    if (first?.latitude != null && first.longitude != null) {
      const attribution = this.attributor()?.attribute(first.latitude, first.longitude);
      district = attribution?.status === "district" ? attribution.district : null;
    }
    return { kind: "text", attachment: null, text: startMessage({ firstDetectionMs: firstMs, nowMs: this.now(), district,
      latitude: first?.latitude ?? null, longitude: first?.longitude ?? null }) };
  }

  private async prepareEnd(note: ClaimedNotification): Promise<Content | null> {
    const period = note.period;
    const base: EndSummary = { periodId: note.periodId, firstDetectionMs: Date.parse(period.started_at),
      firstDetectionExact: false, lastDetectionMs: Date.parse(period.last_detection_at),
      closedMs: Date.parse(String(period.closed_at)), recordedDetectionCount: period.detection_count,
      coverageUncertain: period.coverage_uncertain, interruptionCount: period.interruption_count };
    const withoutAttachment = async (reason: AttachmentUnavailableReason): Promise<Content> => {
      try {
        const first = await this.deps.store.firstDetection(note.periodId, AbortSignal.timeout(STORE_TIMEOUT_MS));
        if (first) Object.assign(base, { firstDetectionMs: Date.parse(first.eventTime), firstDetectionExact: true });
      } catch { /* the period start is shown, labelled as such */ }
      return { kind: "text", attachment: `unavailable:${reason}`, text: endTextWithoutAttachment(base, reason) };
    };
    // PR-3's ceiling is checked before reading anything; an oversized period is still reported.
    if (period.detection_count > MAX_EXPORT_DETECTIONS) return withoutAttachment("export_too_large");
    // Protects the shared worker process (publication, capture) from a memory spike.
    if (period.detection_count > WORKER_ATTACHMENT_MAX_DETECTIONS) return withoutAttachment("worker_attachment_limit");
    if (note.prepareFailures >= MAX_PREPARE_FAILURES) return withoutAttachment("export_unavailable");
    let result: ActivityExport;
    try {
      result = await (this.deps.exportPeriod ?? exportPeriod)(this.deps.exportStore, note.periodId);
    } catch (error) {
      if (error instanceof ActivityExportError) {
        this.log("activity_telegram_export_unavailable", { periodId: note.periodId, code: error.code });
        return withoutAttachment(error.code === "export_too_large" ? "export_too_large"
          : error.code === "no_archived_events" ? "no_archived_events" : "archive_inconsistent");
      }
      // A transient read failure: retry the preparation later instead of reporting it.
      await this.record(note, { outcome: "prepare_failed", detail: "export_read_failed" });
      return null;
    }
    const meta = result.meta;
    const summary: EndSummary = { ...base, firstDetectionMs: Date.parse(meta.activityPeriod.firstDetectionAt),
      firstDetectionExact: true, archive: { exportedEventCount: meta.archive.exportedEventCount,
        missingArchiveRecordCount: meta.archive.missingArchiveRecordCount, districts: meta.districtSummary.districts,
        unknownDistrictCount: meta.districtSummary.unknown.detections } };
    const json = serializeActivityExport(result);
    if (Buffer.byteLength(json) > MAX_ATTACHMENT_BYTES) {
      return { kind: "text", attachment: "unavailable:attachment_too_large",
        text: endTextWithoutAttachment(summary, "attachment_too_large") };
    }
    return { kind: "document", caption: endCaption(summary), json,
      filename: replayFilename(note.periodId, summary.firstDetectionMs) };
  }

  private async send(note: ClaimedNotification, content: Content) {
    let begin: Awaited<ReturnType<NotificationStore["beginSend"]>> | null = null;
    // begin_send is idempotent for this owner, so a lost response can safely be retried.
    for (let attempt = 0; attempt < 3 && begin === null; attempt++) {
      try { begin = await this.deps.store.beginSend(this.workerId, note.periodId, note.kind, AbortSignal.timeout(STORE_TIMEOUT_MS)); }
      catch { begin = null; }
    }
    if (begin !== "proceed") {
      // Nothing was sent. If begin_send committed unseen, its lease expires as ambiguous.
      this.log("activity_telegram_notification", { periodId: note.periodId, notification: note.kind,
        outcome: begin ?? "reservation_unavailable" });
      if (begin === null) this.backoff("begin_send");
      return;
    }
    const attachment = content.kind === "document" ? "attached" : content.attachment;
    let delivery: TelegramDelivery;
    try {
      delivery = content.kind === "document"
        ? await this.deps.telegram.sendDocument(content.caption, content.filename, content.json)
        : await this.deps.telegram.sendMessage(content.text);
    } catch {
      delivery = { status: "ambiguous", detail: "client_error" };
    }
    const completion: Completion = delivery.status === "sent" ? { outcome: "sent", messageId: delivery.messageId, attachment }
      : delivery.status === "ambiguous" ? { outcome: "ambiguous", detail: delivery.detail, attachment }
      : delivery.status === "retry" ? { outcome: "retry", detail: delivery.detail,
        ...(delivery.retryAfterSeconds === undefined ? {} : { retryAfterSeconds: delivery.retryAfterSeconds }) }
      : { outcome: "failed", detail: delivery.detail };
    this.log("activity_telegram_notification", { periodId: note.periodId, notification: note.kind,
      outcome: delivery.status, ...("detail" in delivery ? { detail: delivery.detail } : {}),
      ...(attachment ? { attachment } : {}) });
    if (!await this.record(note, completion)) {
      this.pendingCompletion = { note, completion, ticks: 0 };
      this.backoff("complete");
    }
  }

  /** Writes a completion, retrying briefly. Returns false if it could not be stored. */
  private async record(note: ClaimedNotification, completion: Completion): Promise<boolean> {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const outcome = await this.deps.store.complete(this.workerId, note.periodId, note.kind, completion,
          AbortSignal.timeout(STORE_TIMEOUT_MS));
        if (outcome !== "recorded") this.log("activity_telegram_error", { stage: "complete", reason: outcome,
          periodId: note.periodId, notification: note.kind });
        return true;
      } catch { /* retry */ }
    }
    return false;
  }

  private attributor(): DistrictAttributor | null {
    if (this.cachedAttributor === undefined) {
      try { this.cachedAttributor = (this.deps.attributor ?? loadAnkaraDistrictAttributor)(); }
      catch {
        this.cachedAttributor = null;
        this.log("activity_telegram_error", { stage: "districts", reason: "unavailable" });
      }
    }
    return this.cachedAttributor;
  }

  private backoff(stage: string) {
    this.failures++;
    const delay = Math.min(300_000, 2_000 * 2 ** Math.min(this.failures, 8));
    this.nextAttemptAt = this.now() + delay;
    this.log("activity_telegram_error", { stage, reason: "unavailable", retryAfterMs: delay });
  }

  private log(kind: string, fields: Record<string, unknown>) { try { this.deps.emit(kind, fields); } catch { /* isolated */ } }
}

/**
 * Disabled unless ACTIVITY_TELEGRAM_ENABLED is exactly "true". Missing or invalid settings
 * disable only this feature; the worker and existing notifications are unaffected.
 */
export function createActivityTelegram(env: Record<string, string | undefined>, emit: Emit,
  fetcher: typeof fetch = fetch): ActivityNotificationDispatcher | null {
  if (env.ACTIVITY_TELEGRAM_ENABLED !== "true") return null;
  const safeEmit: Emit = (kind, fields) => { try { emit(kind, fields); } catch { /* isolated */ } };
  try {
    const { client, invalidSettings } = createActivityTelegramClient(env, fetcher);
    if (!client) {
      safeEmit("configuration_warning", { capability: "activity_telegram", disabled: true, invalidSettings });
      return null;
    }
    const config = { url: env.SUPABASE_URL, serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY };
    const dispatcher = new ActivityNotificationDispatcher({ store: createNotificationStore(config, fetcher),
      exportStore: createActivityExportStore(config, fetcher), telegram: client, emit: safeEmit });
    dispatcher.start();
    return dispatcher;
  } catch {
    safeEmit("activity_telegram_error", { stage: "configuration", reason: "unavailable" });
    return null;
  }
}
