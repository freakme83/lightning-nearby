import { normalizeAndLabel, extractProviderAddressHierarchy } from "../lightning-location-naming/normalize.ts";
import { buildCgPublicationMetadata } from "../lightning-publication-ledger/cg-metadata.ts";
import type { PublicationRecord } from "../lightning-publication-ledger/types.ts";
const now = Date.parse("2026-10-11T14:00:00Z");
export function cgMetadata(place = "Ayrancı", distanceKm = 0, kind = "urban", parent = "Çankaya") {
  const payload = { address: { ...(kind === "rural" ? { village: place } : { neighbourhood: place }),
    ...(kind === "unknown" ? {} : { town: parent }), county: parent, province: "Ankara", country: "Türkiye" } };
  const point = { latitude: 39.9 + distanceKm / 111.1950802335329, longitude: 32.85 };
  return buildCgPublicationMetadata({ ...point, type: "cg", id: "event", eventTimeMs: now },
    normalizeAndLabel(payload), extractProviderAddressHierarchy(payload), point)!;
}
export function cgRecord(id: string, place: string, distance = 0, scope = "scope-a", at = now, kind = "urban"): PublicationRecord {
  return { publicationId: id, runId: "run", incidentId: "i", incidentReferenceTime: new Date(at).toISOString(),
    incidentLatitude: 0, incidentLongitude: 0, provider: "xweather", enrichmentStatus: "cg_verified", providerEventId: id,
    providerEventType: "cg", locationLabel: place, messageFingerprint: "fingerprint", decision: "WOULD_PUBLISH",
    recordedAt: new Date(at).toISOString(), cgScopeId: scope, cgMetadata: cgMetadata(place, distance, kind) };
}

