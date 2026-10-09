import { createHash } from "node:crypto";
import type { DryRunResult } from "../lightning-end-to-end-dry-run/orchestrate.ts";
import type { BuildPublicationRecordResult, PublicationRecord } from "./types.ts";

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function fingerprintMessage(exactComposerText: string): string {
  return `sha256:${createHash("sha256").update(exactComposerText, "utf8").digest("hex")}`;
}

function validCoordinate(latitude: unknown, longitude: unknown): latitude is number {
  return typeof latitude === "number" && Number.isFinite(latitude) && latitude >= -90 && latitude <= 90 &&
    typeof longitude === "number" && Number.isFinite(longitude) && longitude >= -180 && longitude <= 180;
}

function failure(code: Extract<BuildPublicationRecordResult, { ok: false }>["code"], message: string): BuildPublicationRecordResult {
  return { ok: false, code, message };
}

// This builds a shadow record from already-completed research data. It neither
// composes the message nor writes the record to any store.
export function buildPublicationRecord(result: DryRunResult,
  options: { runId?: string | null; recordedAt?: string } = {}): BuildPublicationRecordResult {
  if (result.status !== "message_preview_ready" || result.message?.ok !== true || !text(result.message.text)) {
    return failure("message_not_ready", "A completed composer preview is required.");
  }
  if (!result.publishDecision || !["WOULD_PUBLISH", "HOLD"].includes(result.publishDecision.decision)) {
    return failure("missing_decision", "A completed shadow publish decision is required.");
  }
  const paired = record(result.paired);
  const incident = record(paired.incident);
  const incidentId = text(incident.incidentId);
  const eventTimeMs = incident.eventTimeMs;
  if (paired.status !== "paired_result" || !incidentId ||
      result.message.incidentId !== incidentId || result.publishDecision.incidentId !== incidentId ||
      typeof eventTimeMs !== "number" || !Number.isSafeInteger(eventTimeMs) ||
      !Number.isFinite(new Date(eventTimeMs).getTime()) ||
      !validCoordinate(incident.latitude, incident.longitude)) {
    return failure("invalid_incident", "The paired incident identity, reference time, or coordinate is unusable.");
  }
  const enrichment = record(paired.enrichment);
  const status = enrichment.status;
  if (enrichment.provider !== "xweather" || !["cg_verified", "ic_only", "no_match", "provider_unavailable"].includes(status as string) ||
      result.message.enrichmentStatus !== status) {
    return failure("invalid_enrichment", "The paired enrichment status is unusable.");
  }
  const match = record(enrichment.match);
  const selected = status === "cg_verified" || status === "ic_only";
  if (selected && match.type !== undefined && match.type !== "cg" && match.type !== "ic") {
    return failure("invalid_enrichment", "The selected provider event type is unusable.");
  }
  if ((status === "cg_verified" && match.type && match.type !== "cg") ||
      (status === "ic_only" && match.type && match.type !== "ic")) {
    return failure("invalid_enrichment", "The selected event type disagrees with enrichment.");
  }
  const label = text(result.message.locationDisplayLabel);
  const normalized = record(record(result.location).normalized);
  if (!label || label !== text(normalized.displayLabel)) {
    return failure("invalid_location", "The completed message and normalized place label disagree.");
  }
  const recordedAt = options.recordedAt ?? new Date().toISOString();
  if (!Number.isFinite(Date.parse(recordedAt))) {
    return failure("invalid_recorded_at", "The record timestamp must be a valid date.");
  }
  const incidentReferenceTime = new Date(eventTimeMs).toISOString();
  const providerEventId = selected ? text(match.id) : null;
  const providerEventType = selected && (match.type === "cg" || match.type === "ic") ? match.type : null;
  const messageFingerprint = fingerprintMessage(result.message.text);
  const runId = text(options.runId);
  const publicationId = `pub_${createHash("sha256").update(JSON.stringify([
    "publication-record:v1", runId, incidentId, incidentReferenceTime,
    incident.latitude, incident.longitude, providerEventId, messageFingerprint,
  ])).digest("hex").slice(0, 32)}`;
  const publicationRecord: PublicationRecord = {
    publicationId, runId, incidentId, incidentReferenceTime,
    incidentLatitude: incident.latitude as number, incidentLongitude: incident.longitude as number,
    provider: "xweather", enrichmentStatus: status as PublicationRecord["enrichmentStatus"],
    providerEventId, providerEventType, locationLabel: label, messageFingerprint,
    decision: result.publishDecision.decision, recordedAt,
    mapUrl: status === "cg_verified" ? result.message.mapUrl : null,
  };
  return { ok: true, record: publicationRecord };
}
