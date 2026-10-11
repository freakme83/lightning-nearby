import { isDeepStrictEqual } from "node:util";
import { CG_LOCATION_SEMANTICS_VERSION, classifyCgPlace, semanticCgLocationIdentity,
  type PlaceClassification, type SemanticLocationIdentity } from "../lightning-cg-repeat-policy/location.ts";
import { PROVIDER_ADDRESS_FIELDS, type NormalizedPlace, type ProviderAddressHierarchy } from "../lightning-location-naming/types.ts";

export type CgPublicationMetadata = {
  version: typeof CG_LOCATION_SEMANTICS_VERSION;
  latitude: number;
  longitude: number;
  eventTime: string;
  location: NormalizedPlace;
  providerAddress?: ProviderAddressHierarchy;
  classification: PlaceClassification;
  semanticIdentity: SemanticLocationIdentity;
};

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

const locationFields = ["neighborhood", "locality", "district", "province", "country", "rawType"] as const;
const localityKinds = ["city", "town", "village", "hamlet", "municipality", "other"];

// Whitelist structured naming data only. Never persist arbitrary diagnostic/provider payloads.
function snapshotLocation(value: unknown): NormalizedPlace | null {
  const row = object(value);
  if (!row) return null;
  const place: NormalizedPlace = {};
  for (const key of locationFields) {
    if (row[key] === undefined) continue;
    if (typeof row[key] !== "string") return null;
    place[key] = row[key];
  }
  if (row.localityKind !== undefined) {
    if (!localityKinds.includes(String(row.localityKind))) return null;
    place.localityKind = row.localityKind as NormalizedPlace["localityKind"];
  }
  return place;
}

function snapshotHierarchy(value: unknown): ProviderAddressHierarchy | undefined {
  const row = object(value);
  if (!row) return undefined;
  const entries = PROVIDER_ADDRESS_FIELDS.map(key => [key, row[key] ?? null]);
  if (entries.some(([, value]) => value !== null && typeof value !== "string")) return undefined;
  return Object.fromEntries(entries) as ProviderAddressHierarchy;
}

export function buildCgPublicationMetadata(match: Record<string, unknown>, normalized: unknown,
  providerAddress: unknown, requested: unknown): CgPublicationMetadata | null {
  const point = object(requested);
  const location = snapshotLocation(normalized);
  const latitude = match.latitude;
  const longitude = match.longitude;
  const time = match.eventTimeMs;
  // Old artifacts remain usable by existing gates, but cannot invent trusted CG metadata.
  if (!location || match.type !== "cg" || typeof match.id !== "string" || !match.id.trim() ||
      typeof latitude !== "number" || !Number.isFinite(latitude) || Math.abs(latitude) > 90 ||
      typeof longitude !== "number" || !Number.isFinite(longitude) || Math.abs(longitude) > 180 ||
      typeof time !== "number" || !Number.isSafeInteger(time) || time < 0 || time > 8.64e15 ||
      point?.latitude !== latitude || point?.longitude !== longitude) return null;
  const hierarchy = snapshotHierarchy(providerAddress);
  if (providerAddress != null && !hierarchy) return null;
  const input = { ...location, ...(hierarchy ? { providerAddress: hierarchy } : {}) };
  return { version: CG_LOCATION_SEMANTICS_VERSION, latitude, longitude,
    eventTime: new Date(time).toISOString(), location,
    ...(hierarchy ? { providerAddress: hierarchy } : {}),
    classification: classifyCgPlace(input), semanticIdentity: semanticCgLocationIdentity(input) };
}

// Optional metadata cannot break legacy duplicate-history reads. Invalid/unknown
// versions are unavailable for future semantic comparison, never guessed from labels.
export function parseCgPublicationMetadata(value: unknown): CgPublicationMetadata | null {
  const row = object(value);
  if (!row || row.version !== CG_LOCATION_SEMANTICS_VERSION || typeof row.eventTime !== "string") return null;
  const rebuilt = buildCgPublicationMetadata({ type: "cg", id: "stored-event",
    latitude: row.latitude, longitude: row.longitude, eventTimeMs: Date.parse(row.eventTime) },
    row.location, row.providerAddress, row);
  if (!rebuilt || !isDeepStrictEqual(row.classification, rebuilt.classification) ||
      !isDeepStrictEqual(row.semanticIdentity, rebuilt.semanticIdentity)) return null;
  return rebuilt;
}
