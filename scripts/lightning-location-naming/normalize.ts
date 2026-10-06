import { PROVIDER_ADDRESS_FIELDS, type LocalityKind, type NormalizedPlace, type NominatimPayload, type ProviderAddressHierarchy } from "./types.ts";

export function validateCoordinates(latitude: number, longitude: number): void {
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) throw new RangeError("latitude must be finite and between -90 and 90");
  if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) throw new RangeError("longitude must be finite and between -180 and 180");
}

type AddressComponent = { key: string; value: string };

const SMALL_PLACE_FIELDS = ["quarter", "neighbourhood", "neighborhood", "suburb", "village", "hamlet", "city_district"] as const;
const ADMIN_SUFFIX = /\s+(?:Mahallesi|İlçesi|İli)$/iu;

function cleanAdministrativeSuffix(value: string | undefined): string | undefined {
  const clean = value?.trim().replace(ADMIN_SUFFIX, "").trim();
  return clean || undefined;
}

function component(address: Record<string, unknown>, ...keys: string[]): AddressComponent | undefined {
  for (const key of keys) {
    const value = address[key];
    if (typeof value === "string") {
      const clean = cleanAdministrativeSuffix(value);
      if (clean) return { key, value: clean };
    }
  }
  return undefined;
}

function comparisonKey(value: string): string {
  return value.normalize("NFC").trim().toLocaleLowerCase("tr-TR");
}

function samePlace(left?: string, right?: string): boolean {
  return Boolean(left && right && comparisonKey(left) === comparisonKey(right));
}

export function isAnkaraProvince(province?: string): boolean {
  const normalizedProvince = cleanAdministrativeSuffix(province);
  return Boolean(normalizedProvince && samePlace(normalizedProvince, "Ankara"));
}

function smallPlaceComponent(address: Record<string, unknown>): AddressComponent | undefined {
  return component(address, ...SMALL_PLACE_FIELDS);
}

function localityComponent(address: Record<string, unknown>): AddressComponent | undefined {
  return component(address, "town", "village", "hamlet", "city", "municipality");
}

function districtComponent(address: Record<string, unknown>): AddressComponent | undefined {
  for (const key of ["county", "district", "state_district", "city_district"]) {
    const candidate = component(address, key);
    if (candidate) return candidate;
  }
  return undefined;
}

export function normalizeNominatimAddress(payload: unknown): NormalizedPlace {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new TypeError("Nominatim response must be an object");
  const row = payload as NominatimPayload;
  if (!row.address || typeof row.address !== "object" || Array.isArray(row.address)) throw new TypeError("Nominatim response has no structured address object");
  const address = row.address;
  const smallPlace = smallPlaceComponent(address);
  const localityComponentValue = localityComponent(address);
  const localityRaw = localityComponentValue?.value;
  let localityKind: LocalityKind | undefined;
  if (localityComponentValue?.key === "town") localityKind = "town";
  else if (localityComponentValue?.key === "village") localityKind = "village";
  else if (localityComponentValue?.key === "hamlet") localityKind = "hamlet";
  else if (localityComponentValue?.key === "city") localityKind = "city";
  else if (localityComponentValue?.key === "municipality") localityKind = "municipality";
  const district = districtComponent(address)?.value;
  const province = component(address, "province", "state", "region")?.value;
  const country = component(address, "country")?.value;
  const rawType = typeof row.addresstype === "string" ? row.addresstype : typeof row.type === "string" ? row.type : undefined;
  return {
    ...(smallPlace ? { neighborhood: smallPlace.value } : {}),
    ...(localityRaw ? { locality: localityRaw } : {}),
    ...(localityKind ? { localityKind } : {}),
    ...(district ? { district } : {}),
    ...(province ? { province } : {}),
    ...(country ? { country } : {}),
    ...(rawType ? { rawType } : {}),
  };
}

/** Whitelist address hierarchy only; deliberately excludes street, number, postcode and display_name. */
export function extractProviderAddressHierarchy(payload: unknown): ProviderAddressHierarchy {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new TypeError("Nominatim response must be an object");
  const row = payload as NominatimPayload;
  if (!row.address || typeof row.address !== "object" || Array.isArray(row.address)) throw new TypeError("Nominatim response has no structured address object");
  const address = row.address;
  return Object.fromEntries(PROVIDER_ADDRESS_FIELDS.map((key) => {
    const value = address[key];
    return [key, typeof value === "string" && value.trim() ? value.trim() : null];
  })) as ProviderAddressHierarchy;
}

function districtLikeParent(place: NormalizedPlace, province?: string, child?: string): string | undefined {
  const candidates = [
    place.localityKind === "town" ? cleanAdministrativeSuffix(place.locality) : undefined,
    cleanAdministrativeSuffix(place.district),
  ];
  return candidates.find((candidate): candidate is string => Boolean(candidate && !samePlace(candidate, province) && !samePlace(candidate, child)));
}

/**
 * Ankara labels retain the smallest useful local place; outside Ankara, labels
 * use a district-like parent and province to orient readers to this Ankara-focused bot.
 */
export function makeDisplayLabel(place: NormalizedPlace): string | null {
  const smallPlace = cleanAdministrativeSuffix(place.neighborhood);
  const locality = cleanAdministrativeSuffix(place.locality);
  const district = cleanAdministrativeSuffix(place.district);
  const province = cleanAdministrativeSuffix(place.province);
  const normalizedPlace = { ...place, locality, district };
  const parent = districtLikeParent(normalizedPlace, province, isAnkaraProvince(province) ? smallPlace : undefined);

  if (isAnkaraProvince(province)) {
    if (smallPlace) return parent ? `${smallPlace}, ${parent}` : smallPlace;
    if (parent) return province && !samePlace(parent, province) ? `${parent}, ${province}` : parent;
    return province ?? locality ?? null;
  }

  if (parent && province && !samePlace(parent, province)) return `${parent}, ${province}`;
  return parent ?? province ?? locality ?? null;
}

export function normalizeAndLabel(payload: unknown): NormalizedPlace & { displayLabel: string | null } {
  const normalized = normalizeNominatimAddress(payload);
  return { ...normalized, displayLabel: makeDisplayLabel(normalized) };
}
