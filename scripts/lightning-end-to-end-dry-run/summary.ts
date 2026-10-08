import { formatCopyableDisplayLabel } from "../lightning-location-naming/summary.ts";
import type { DryRunResult } from "./orchestrate.ts";

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function value(input: unknown): string {
  return input === null || input === undefined || input === "" ? "not available" :
    String(input).replaceAll("|", "\\|").replaceAll("\n", " ");
}

function coordinate(point: Record<string, unknown>): string {
  return typeof point.latitude === "number" && typeof point.longitude === "number"
    ? `${point.latitude}, ${point.longitude}` : "not available";
}

function fencedText(text: string): string {
  const longestRun = Math.max(0, ...Array.from(text.matchAll(/`+/g), ([run]) => run.length));
  const fence = "`".repeat(Math.max(3, longestRun + 1));
  return `${fence}text\n${text}\n${fence}`;
}

export function renderEndToEndSummary(result: DryRunResult): string {
  const paired = record(result.paired);
  const incident = record(paired.incident);
  const enrichment = record(paired.enrichment);
  const counts = record(enrichment.counts);
  const match = record(enrichment.match);
  const freshness = record(paired.triggerFreshness);
  const reactivation = record(paired.reactivation);
  const location = record(result.location);
  const normalized = record(location.normalized);
  const rows = [
    "# Lightning end-to-end dry run",
    "",
    `Status: **${value(result.status)}**`,
    "",
    "## Live incident",
    "",
    `- Paired status: ${value(paired.status)}`,
    `- Incident ID: ${value(incident.incidentId)}`,
    `- Incident coordinate: ${coordinate(incident)}`,
    `- Incident reference time: ${typeof incident.eventTimeMs === "number" && Number.isFinite(incident.eventTimeMs) ? new Date(incident.eventTimeMs).toISOString() : "not available"}`,
    `- Profile: ${value(record(paired.profile).id)}`,
    `- Trigger mode: ${value(paired.triggerMode)}`,
    `- Freshness: age ${value(freshness.incidentAgeMs)} ms; maximum ${value(freshness.maxIncidentAgeMs)} ms; stale skipped ${value(freshness.stalePublishCount)}`,
    ...(paired.triggerMode === "reactivated_after_stale_publish"
      ? [`- Reactivation: original age ${value(reactivation.originalStaleAgeMs)} ms; fresh activity age ${value(reactivation.reactivationAgeMs)} ms`] : []),
    "",
    "## Xweather pairing",
    "",
    `- Enrichment state: ${value(enrichment.status)}`,
    `- Returned / matched / CG / IC: ${value(counts.returned)} / ${value(counts.matched)} / ${value(counts.matchedCg)} / ${value(counts.matchedIc)}`,
    `- Selected event type: ${value(match.type)}`,
    `- Selected CG coordinate: ${match.type === "cg" ? coordinate(match) : "not applicable"}`,
    `- Distance / time delta: ${value(match.distanceKm)} km / ${value(match.timeDifferenceMs)} ms`,
    `- Provider cost tokens: ${value(record(enrichment.cost).tokens)}`,
    `- Enrichment calls / HTTP attempted: ${value(result.providerCalls.xweatherEnrichmentCalls)} / ${value(result.providerCalls.xweatherRequestAttempted)}`,
    "",
    "## Location naming",
    "",
    `- Incident coordinate used for lookup: ${value(location.requested ? coordinate(record(location.requested)) : "not called")}`,
    `- Lookup status: ${value(location.status)}`,
    `- Display label: ${value(normalized.displayLabel)}`,
    `- Normalized: locality ${value(normalized.locality)}; district ${value(normalized.district)}; province ${value(normalized.province)}; country ${value(normalized.country)}`,
    `- Provider attribution: ${value(location.attribution)}`,
    `- Nominatim reverse lookups: ${result.providerCalls.nominatimReverseLookups}`,
    "",
    formatCopyableDisplayLabel(typeof normalized.displayLabel === "string" ? normalized.displayLabel : null),
    "",
    "## Final dry-run message",
    "",
  ];
  if (result.status === "message_preview_ready" && result.message?.ok) {
    const preview = result.message;
    let mapCoordinate = "not applicable";
    if (preview.mapUrl) {
      try { mapCoordinate = new URL(preview.mapUrl).searchParams.get("q") ?? "not available"; }
      catch { mapCoordinate = "not available"; }
    }
    rows.push(fencedText(preview.text), "",
      `- Character count: ${preview.characterCount}`,
      `- Event kind: ${value(preview.composer.eventKind)}`,
      `- Internal map URL available: ${preview.mapUrl ? "yes" : "no"}`,
      `- Public message contains URL: ${/https?:\/\//i.test(preview.text) ? "yes" : "no"}`,
      `- Public coordinate: ${preview.composer.coordinateText ?? "not applicable"}`,
      `- Selected map coordinate: ${mapCoordinate}`,
      ...(preview.mapUrl ? [`- Internal Maps URL: ${preview.mapUrl}`] : []));
  } else {
    rows.push(`No final message: **${value(result.status)}** — ${value(result.reason ?? (result.message?.ok === false ? result.message.error.message : null))}.`);
  }
  const decision = result.publishDecision;
  rows.push("", "## Publish decision (shadow only)", "",
    `**${decision?.decision ?? "not evaluated"}**`, "",
    ...(decision ? [
      ...decision.reasonCodes.map(code => `- ${value(code)}`),
      "",
      `- Source health at trigger: ${value(decision.sourceHealthAtTrigger)}`,
      `- Known same-incident duplicate: ${decision.duplicateIncident === null ? "not checked" : decision.duplicateIncident ? "yes" : "no"}`,
    ] : []),
    result.ledger ? `Persistent duplicate history: ${result.ledger.historyChecked ? "checked" : "unavailable"}.` :
      "Persistent duplicate history: not enabled in v1A.");
  if (result.ledger) {
    const ledger = result.ledger;
    rows.push("", "## Publication ledger", "",
      `- Persistence: ${ledger.persistenceEnabled ? "enabled" : "unavailable"}`,
      `- History checked: ${ledger.historyChecked ? "yes" : "no"}`,
      `- Records examined: ${ledger.recordsExamined}`,
      `- Duplicate: ${ledger.duplicateMatch ? (ledger.duplicateMatch.duplicate ? "yes" : "no") : "not checked"}`,
      `- Match reason: ${value(ledger.duplicateMatch?.reason)}`,
      `- Matched publication: ${value(ledger.duplicateMatch?.matchedPublicationId)}`,
      `- Record persisted: ${ledger.recordPersisted ? "yes" : "no"}`,
      `- Write disposition: ${value(ledger.writeDisposition)}`,
      `- Publication ID: ${value(ledger.persistedPublicationId)}`,
      `- Storage status: ${ledger.storageStatus}`,
      ...(ledger.reason ? [`- Storage detail: ${value(ledger.reason)}`] : []));
  }
  if (result.publishDecision?.decision === "WOULD_PUBLISH" && result.ledger?.recordPersisted &&
      result.ledger.approvalStatus === "pending") {
    rows.push("", "## Manual approval", "",
      "- Approval status: pending",
      `- Publication ID: ${value(result.ledger.persistedPublicationId)}`,
      "- Action required: approve or skip using Research Lightning Manual Approval.");
  }
  rows.push("", "Dry run only. Nothing was published.", "");
  return rows.join("\n");
}
