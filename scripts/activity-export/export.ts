// Pure, deterministic transformation of one completed Activity Watch period into a
// district summary and a Lightning Replay Studio dataset ({ meta, events }).
// No I/O, clock, randomness or physical-discharge deduplication happens here.
import { createHash } from "node:crypto";
import { ANKARA_MONITORING_AREA } from "../lightning-incident-lifecycle/monitoring-area.ts";
import { compareCodePoints, type DistrictAttributor, type UnknownDistrictReason } from "./districts.ts";

export const EXPORT_FORMAT = "lightning-nearby/ankara-activity-replay" as const;
export const EXPORT_FORMAT_VERSION = 1 as const;
export const PLAYBACK_TAIL_MS = 10_000;
/** Same identifier Continuous Capture stores in polygon_id (SHA-256 of the serialized polygon). */
export const MONITORING_POLYGON_ID =
  `ankara-sha256:${createHash("sha256").update(JSON.stringify(ANKARA_MONITORING_AREA.polygon)).digest("hex")}`;

export type PeriodRow = {
  period_id: string; state: string; started_at: string; last_detection_at: string; detection_count: number;
  closed_at: string | null; coverage_uncertain: boolean; interruption_count: number;
  source_health: string; healthy_since: string | null;
};
export type MembershipRow = { event_key: string; period_id: string; event_time: string; received_at: string };
export type CaptureRow = {
  event_key: string; event_time: string; event_time_raw: string; event_time_unit: string; received_at: string;
  latitude: number; longitude: number; provider: string; source_server: string; station_count: number | null;
  polygon_id: string;
};
export type ExportErrorCode = "invalid_period_id" | "period_not_found" | "period_active" | "invalid_period" |
  "period_membership_inconsistent" | "archive_inconsistent" | "no_archived_events" | "export_too_large";

export class ActivityExportError extends Error {
  readonly code: ExportErrorCode;
  constructor(code: ExportErrorCode, message: string) { super(message); this.code = code; this.name = "ActivityExportError"; }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const EVENT_KEY = /^[0-9a-f]{64}$/;
const SOURCE_SERVERS = new Set(["ws1", "ws7", "ws8"]);
const TIME_UNITS = new Set(["seconds", "milliseconds", "microseconds", "nanoseconds"]);

export function assertPeriodId(value: unknown): string {
  if (typeof value !== "string" || !UUID.test(value)) {
    throw new ActivityExportError("invalid_period_id", "Period ID must be a lowercase UUID");
  }
  return value;
}

/** Parse a stored timestamptz without silently dropping sub-millisecond digits. */
function timeMs(value: unknown, code: ExportErrorCode, label: string): number {
  const fraction = typeof value === "string" ? /\.(\d+)/.exec(value)?.[1] ?? "" : "";
  const ms = typeof value === "string" ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(ms) || /[1-9]/.test(fraction.slice(3))) throw new ActivityExportError(code, `Invalid ${label}`);
  return ms;
}
const iso = (ms: number) => new Date(ms).toISOString();
const count = (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 0;

type ValidPeriod = { periodId: string; startedAt: number; lastDetectionAt: number; closedAt: number;
  detectionCount: number; coverageUncertain: boolean; interruptionCount: number; sourceHealthAtClose: string };

export function validateCompletedPeriod(row: PeriodRow | null, periodId: string): ValidPeriod {
  if (!row) throw new ActivityExportError("period_not_found", "Activity period does not exist");
  if (row.period_id !== periodId) throw new ActivityExportError("invalid_period", "Period row does not match the requested ID");
  if (row.state === "active") throw new ActivityExportError("period_active", "Activity period is still active; only completed periods can be exported");
  if (row.state !== "closed" || row.closed_at === null || !count(row.detection_count) || row.detection_count < 1 ||
      !count(row.interruption_count) || typeof row.coverage_uncertain !== "boolean" ||
      !["healthy", "unhealthy"].includes(row.source_health)) {
    throw new ActivityExportError("invalid_period", "Activity period row is not a valid completed period");
  }
  const period = { periodId, startedAt: timeMs(row.started_at, "invalid_period", "period start"),
    lastDetectionAt: timeMs(row.last_detection_at, "invalid_period", "period last detection"),
    closedAt: timeMs(row.closed_at, "invalid_period", "period closure"), detectionCount: row.detection_count,
    coverageUncertain: row.coverage_uncertain, interruptionCount: row.interruption_count,
    sourceHealthAtClose: row.source_health };
  if (period.startedAt > period.lastDetectionAt || period.closedAt < period.lastDetectionAt) {
    throw new ActivityExportError("invalid_period", "Activity period timestamps are out of order");
  }
  return period;
}

export type ReplayEvent = {
  id: string; timestamp: string; lat: number; lon: number; type: "unknown";
  eventKey: string; receivedAt: string; district: string | null; districtStatus: "district" | "unknown";
  districtReason?: UnknownDistrictReason; districtCandidates?: string[];
  stationCount: number | null; sourceServer: string; eventTimeRaw: string; eventTimeUnit: string;
};
export type DistrictSummary = {
  countUnit: "blitzortung_detection_record";
  recordedDetectionCount: number; exportedEventCount: number; missingArchiveRecordCount: number;
  districts: { district: string; detections: number }[];
  unknown: { detections: number; byReason: Partial<Record<UnknownDistrictReason, number>> };
};
export type ActivityExportMeta = {
  format: typeof EXPORT_FORMAT; formatVersion: typeof EXPORT_FORMAT_VERSION; name: string; description: string;
  source: "Blitzortung"; provider: "Blitzortung"; synthetic: false; utcOffset: "+03:00";
  windowStart: string; windowEnd: string; playbackTailSeconds: number;
  countUnit: "blitzortung_detection_record"; countNote: string;
  monitoringArea: { id: string; polygonId: string; note: string };
  bounds: { south: number; north: number; west: number; east: number };
  activityPeriod: { periodId: string; periodStartedAt: string; firstDetectionAt: string; lastDetectionAt: string;
    closedAt: string; closureNote: string; recordedDetectionCount: number; coverageUncertain: boolean;
    interruptionCount: number; sourceHealthAtClose: string };
  archive: { complete: boolean; exportedEventCount: number; missingArchiveRecordCount: number; missingArchiveEventKeys: string[] };
  districtAttribution: { method: string; dataset: Record<string, unknown> };
  districtSummary: DistrictSummary;
};
export type ActivityExport = { meta: ActivityExportMeta; events: ReplayEvent[] };

export function buildActivityExport(input: { periodId: string; period: PeriodRow | null; members: MembershipRow[];
  captures: CaptureRow[]; attributor: DistrictAttributor }): ActivityExport {
  const periodId = assertPeriodId(input.periodId);
  const period = validateCompletedPeriod(input.period, periodId);

  // Activity Watch membership is the authoritative event set; never a time window.
  const members = new Map<string, number>();
  for (const row of input.members) {
    if (!row || !EVENT_KEY.test(row.event_key) || row.period_id !== periodId || members.has(row.event_key)) {
      throw new ActivityExportError("period_membership_inconsistent", "Invalid or duplicate period membership row");
    }
    const at = timeMs(row.event_time, "period_membership_inconsistent", "membership event time");
    timeMs(row.received_at, "period_membership_inconsistent", "membership receive time");
    members.set(row.event_key, at);
  }
  let firstDetectionAt = Infinity, lastDetectionAt = -Infinity;
  for (const at of members.values()) { firstDetectionAt = Math.min(firstDetectionAt, at); lastDetectionAt = Math.max(lastDetectionAt, at); }
  if (members.size !== period.detectionCount || lastDetectionAt !== period.lastDetectionAt ||
      firstDetectionAt > period.startedAt) {
    throw new ActivityExportError("period_membership_inconsistent",
      `Period records ${period.detectionCount} detections but ${members.size} membership rows match its boundaries`);
  }

  const captures = new Map<string, CaptureRow>();
  for (const row of input.captures) {
    if (!row || !members.has(row.event_key) || captures.has(row.event_key) || row.provider !== "blitzortung" ||
        !SOURCE_SERVERS.has(row.source_server) || !TIME_UNITS.has(row.event_time_unit) ||
        typeof row.event_time_raw !== "string" || !Number.isFinite(row.latitude) || !Number.isFinite(row.longitude) ||
        !(row.station_count === null || count(row.station_count))) {
      throw new ActivityExportError("archive_inconsistent", "Unexpected, duplicate or invalid Continuous Capture row");
    }
    // Same SHA-256 source fingerprint implies the same normalized event time.
    if (timeMs(row.event_time, "archive_inconsistent", "archive event time") !== members.get(row.event_key)) {
      throw new ActivityExportError("archive_inconsistent", "Archive event time differs from Activity Watch membership");
    }
    timeMs(row.received_at, "archive_inconsistent", "archive receive time");
    captures.set(row.event_key, row);
  }

  const byTimeThenKey = (a: [string, number], b: [string, number]) => a[1] - b[1] || compareCodePoints(a[0], b[0]);
  const missing = [...members].filter(([key]) => !captures.has(key)).sort(byTimeThenKey);
  if (captures.size === 0) {
    throw new ActivityExportError("no_archived_events",
      `None of the period's ${members.size} detections has a Continuous Capture row; no Replay dataset can be produced`);
  }

  const districtCounts = new Map<string, number>();
  const unknownByReason: Partial<Record<UnknownDistrictReason, number>> = {};
  let unknown = 0;
  const events = [...captures.values()]
    .map(row => [row, members.get(row.event_key)!] as const)
    // Shared milliseconds stay separate rows: order by time, then the stable event key.
    .sort((a, b) => a[1] - b[1] || compareCodePoints(a[0].event_key, b[0].event_key))
    .map(([row, at]): ReplayEvent => {
      const attribution = input.attributor.attribute(row.latitude, row.longitude);
      if (attribution.status === "district") {
        districtCounts.set(attribution.district, (districtCounts.get(attribution.district) ?? 0) + 1);
      } else {
        unknown++;
        unknownByReason[attribution.reason] = (unknownByReason[attribution.reason] ?? 0) + 1;
      }
      return { id: row.event_key, timestamp: iso(at), lat: row.latitude, lon: row.longitude, type: "unknown",
        eventKey: row.event_key, receivedAt: iso(Date.parse(row.received_at)), district: attribution.district,
        districtStatus: attribution.status,
        ...(attribution.status === "unknown" ? { districtReason: attribution.reason,
          ...(attribution.candidates ? { districtCandidates: attribution.candidates } : {}) } : {}),
        stationCount: row.station_count, sourceServer: row.source_server,
        eventTimeRaw: row.event_time_raw, eventTimeUnit: row.event_time_unit };
    });

  const sortedReasons = Object.fromEntries(Object.entries(unknownByReason).sort(([a], [b]) => compareCodePoints(a, b)));
  const districtSummary: DistrictSummary = {
    countUnit: "blitzortung_detection_record",
    recordedDetectionCount: members.size, exportedEventCount: events.length, missingArchiveRecordCount: missing.length,
    districts: [...districtCounts].map(([district, detections]) => ({ district, detections }))
      .sort((a, b) => b.detections - a.detections || compareCodePoints(a.district, b.district)),
    unknown: { detections: unknown, byReason: sortedReasons },
  };
  const bounds = ANKARA_MONITORING_AREA.bounds;
  return {
    meta: {
      format: EXPORT_FORMAT, formatVersion: EXPORT_FORMAT_VERSION,
      name: `Ankara activity period ${periodId.slice(0, 8)}`,
      description: "Blitzortung detection records archived by Lightning Nearby for one completed Ankara Activity Watch period. " +
        "Each event is one archived detection record, not an independently verified physical lightning discharge.",
      source: "Blitzortung", provider: "Blitzortung", synthetic: false, utcOffset: "+03:00",
      // Replay Studio plays [windowStart, windowEnd]: first detection to 10 s after the last
      // recorded detection. The later administrative closure is kept below, not played.
      windowStart: iso(firstDetectionAt), windowEnd: iso(period.lastDetectionAt + PLAYBACK_TAIL_MS),
      playbackTailSeconds: PLAYBACK_TAIL_MS / 1000,
      countUnit: "blitzortung_detection_record",
      countNote: "Counts are Blitzortung detection records. Records sharing a millisecond or nearby positions are kept " +
        "separately; physical discharge identity cannot be established from archived fields.",
      monitoringArea: { id: ANKARA_MONITORING_AREA.id, polygonId: MONITORING_POLYGON_ID,
        note: "Operational Ankara-centred coverage polygon, not the official provincial boundary." },
      bounds: { south: bounds.south, north: bounds.north, west: bounds.west, east: bounds.east },
      activityPeriod: {
        periodId, periodStartedAt: iso(period.startedAt), firstDetectionAt: iso(firstDetectionAt),
        lastDetectionAt: iso(period.lastDetectionAt), closedAt: iso(period.closedAt),
        closureNote: "closedAt is the administrative closure after 30 minutes of observed quiet; it is not a detection time.",
        recordedDetectionCount: members.size, coverageUncertain: period.coverageUncertain,
        interruptionCount: period.interruptionCount, sourceHealthAtClose: period.sourceHealthAtClose,
      },
      archive: { complete: missing.length === 0, exportedEventCount: events.length,
        missingArchiveRecordCount: missing.length, missingArchiveEventKeys: missing.map(([key]) => key) },
      districtAttribution: { method: "Planar point-in-polygon on [lon, lat] (even-odd, holes and MultiPolygon supported). " +
        "Coordinates on a district edge, in overlapping polygons, or outside all 25 Ankara districts are unknown.",
        dataset: input.attributor.provenance },
      districtSummary,
    },
    events,
  };
}

/** Byte-stable serialization: fixed key order from construction, two-space indent, final newline. */
export function serializeActivityExport(value: ActivityExport): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
