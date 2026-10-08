import type { PairedResult } from "./types.ts";

const lastActivityTimeMs = Date.parse("2026-10-06T13:48:00Z");
const incident = {
  incidentId: "fixture-pair-cg-1",
  latitude: 39.90,
  longitude: 32.80,
  eventTimeMs: lastActivityTimeMs,
  firstActivityTimeMs: lastActivityTimeMs - 60_000,
  lastActivityTimeMs,
  eventCount: 7,
  clusterCount: 2,
};
const reference = { latitude: incident.latitude, longitude: incident.longitude, eventTimeMs: lastActivityTimeMs };
const thresholds = { radiusKm: 10, maxMatchDistanceKm: 8, maxTimeDifferenceMs: 300_000, limit: 10 };
const freshness = {
  incidentAgeMs: 30_000,
  maxIncidentAgeMs: 240_000,
  stalePublishCount: 0,
  freshestSkippedIncidentAgeMs: null,
  futureDatedPublishCount: 0,
  invalidTimestampPublishCount: 0,
  trackedStaleIncidentCount: 0,
  staleIncidentsWithLaterActivityCount: 0,
  reactivatedIncidentCount: 0,
};

// Synthetic records follow the paired-validation artifact schema, including diagnostics never copied to public text.
const cgVerified = {
  status: "paired_result",
  triggerMode: "fresh_would_publish",
  profile: { id: "B", name: "moderate" },
  incident,
  enrichment: {
    status: "cg_verified", provider: "xweather", reference, thresholds,
    counts: { returned: 3, matched: 2, matchedCg: 1, matchedIc: 1 },
    match: { id: "synthetic-cg-1", type: "cg", latitude: 39.902742, longitude: 32.851494,
      eventTimeMs: lastActivityTimeMs - 4_000, distanceKm: 4.5, timeDifferenceMs: 4_000, peakAmp: 85_000, numSensors: 13 },
    cost: { tokens: 10, multipliers: "endpoint=10; spatial=1; temporal=1" },
  },
  triggerFreshness: freshness,
  guardrail: { maxEnrichmentCalls: 1, enrichmentCalls: 1, providerRequestAttempted: true },
  capturedAt: "2026-10-06T13:48:30Z",
} as const satisfies PairedResult;

const icOnly = {
  ...cgVerified,
  incident: { ...incident, incidentId: "fixture-pair-ic-1" },
  enrichment: {
    ...cgVerified.enrichment, status: "ic_only",
    counts: { returned: 1, matched: 1, matchedCg: 0, matchedIc: 1 },
    match: { ...cgVerified.enrichment.match, id: "synthetic-ic-1", type: "ic" },
  },
} as const satisfies PairedResult;

const noMatch = {
  ...cgVerified,
  incident: { ...incident, incidentId: "fixture-pair-no-match-1" },
  enrichment: {
    status: "no_match", provider: "xweather", reference, thresholds,
    counts: { returned: 3, matched: 0, matchedCg: 0, matchedIc: 0 },
    cost: { tokens: 10 },
  },
} as const satisfies PairedResult;

const providerUnavailable = {
  ...cgVerified,
  incident: { ...incident, incidentId: "fixture-pair-unavailable-1" },
  enrichment: { status: "provider_unavailable", provider: "xweather", reference, thresholds, failure: "network_error" },
} as const satisfies PairedResult;

const reactivatedCg = {
  ...cgVerified,
  triggerMode: "reactivated_after_stale_publish",
  incident: { ...incident, incidentId: "fixture-pair-reactivated-1", latitude: 39.68, longitude: 32.82,
    firstActivityTimeMs: lastActivityTimeMs - 9 * 60_000, lastActivityTimeMs },
  enrichment: {
    ...cgVerified.enrichment,
    reference: { latitude: 39.68, longitude: 32.82, eventTimeMs: lastActivityTimeMs },
    match: { ...cgVerified.enrichment.match, id: "synthetic-reactivated-cg-1",
      latitude: 39.682564, longitude: 32.859372 },
  },
  triggerFreshness: { ...freshness, stalePublishCount: 1, freshestSkippedIncidentAgeMs: 9 * 60_000,
    trackedStaleIncidentCount: 1, staleIncidentsWithLaterActivityCount: 1, reactivatedIncidentCount: 1 },
  reactivation: { incidentId: "fixture-pair-reactivated-1", originalStaleAgeMs: 9 * 60_000,
    reactivationAgeMs: 30_000, maxIncidentAgeMs: 240_000, stalePublishCount: 1,
    triggeredByLaterFreshActivity: true },
} as const satisfies PairedResult;

export const PAIRED_ARTIFACT_FIXTURES = {
  cg_verified: cgVerified,
  ic_only: icOnly,
  no_match: noMatch,
  provider_unavailable: providerUnavailable,
  reactivated_cg: reactivatedCg,
  malformed: { status: "paired_result", incident: { incidentId: "incomplete" } },
} as const;

export function getPairedArtifactFixture(name: string): unknown | null {
  return Object.hasOwn(PAIRED_ARTIFACT_FIXTURES, name)
    ? PAIRED_ARTIFACT_FIXTURES[name as keyof typeof PAIRED_ARTIFACT_FIXTURES] : null;
}
