import type { LocalityKind, NormalizedPlace, NominatimPayload } from "./types.ts";

export function validateCoordinates(latitude: number, longitude: number): void {
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) throw new RangeError("latitude must be finite and between -90 and 90");
  if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) throw new RangeError("longitude must be finite and between -180 and 180");
}

function field(address: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = address[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function trimSuffix(value: string | undefined, suffix: RegExp): string | undefined {
  const clean = value?.trim().replace(suffix, "").trim();
  return clean || undefined;
}

export function normalizeNominatimAddress(payload: unknown): NormalizedPlace {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new TypeError("Nominatim response must be an object");
  const row = payload as NominatimPayload;
  if (!row.address || typeof row.address !== "object" || Array.isArray(row.address)) throw new TypeError("Nominatim response has no structured address object");
  const address = row.address;
  const neighborhood = trimSuffix(field(address, "neighbourhood", "neighborhood", "quarter", "suburb"), /\s+Mahallesi$/iu);
  const localityRaw = field(address, "town", "village", "hamlet", "city", "municipality");
  let localityKind: LocalityKind | undefined;
  if (typeof localityRaw === "string" && address.town === localityRaw) localityKind = "town";
  else if (typeof localityRaw === "string" && address.village === localityRaw) localityKind = "village";
  else if (typeof localityRaw === "string" && address.hamlet === localityRaw) localityKind = "hamlet";
  else if (typeof localityRaw === "string" && address.city === localityRaw) localityKind = "city";
  else if (typeof localityRaw === "string" && address.municipality === localityRaw) localityKind = "municipality";
  // Keep Köyü because it can be a meaningful public-facing locality suffix.
  const locality = localityRaw;
  const district = trimSuffix(field(address, "county", "district", "state_district", "city_district"), /\s+İlçesi$/iu);
  const province = trimSuffix(field(address, "province", "state", "region"), /\s+İli$/iu);
  const country = field(address, "country");
  const rawType = typeof row.addresstype === "string" ? row.addresstype : typeof row.type === "string" ? row.type : undefined;
  return {
    ...(neighborhood ? { neighborhood } : {}),
    ...(locality ? { locality } : {}),
    ...(localityKind ? { localityKind } : {}),
    ...(district ? { district } : {}),
    ...(province ? { province } : {}),
    ...(country ? { country } : {}),
    ...(rawType ? { rawType } : {}),
  };
}

/**
 * Prefer a human-meaningful locality. Address-level streets and provider display_name
 * are deliberately ignored. Domestic labels omit country and collapse duplicate levels.
 */
export function makeDisplayLabel(place: NormalizedPlace): string | null {
  const neighborhood = trimSuffix(place.neighborhood, /\s+Mahallesi$/iu);
  const locality = place.locality?.trim();
  const district = trimSuffix(place.district, /\s+İlçesi$/iu);
  const province = trimSuffix(place.province, /\s+İli$/iu);
  const differs = (left?: string, right?: string) => left && right && left.normalize("NFC").toLocaleLowerCase("tr-TR") !== right.normalize("NFC").toLocaleLowerCase("tr-TR");

  if (neighborhood) {
    if (district && differs(neighborhood, district)) return `${neighborhood}, ${district}`;
    if (locality && differs(neighborhood, locality)) return `${neighborhood}, ${locality}`;
    return neighborhood;
  }

  if (locality) {
    if (place.localityKind === "village" || place.localityKind === "hamlet") {
      const parent = [district, province].find((value) => differs(value, locality));
      return parent ? `${locality}, ${parent}` : locality;
    }
    if (province && differs(locality, province)) return `${locality}, ${province}`;
    if (district && differs(locality, district)) return `${locality}, ${district}`;
    return locality;
  }

  if (district && differs(district, province)) return `${district}, ${province}`;
  return district ?? province ?? null;
}

export function normalizeAndLabel(payload: unknown): NormalizedPlace & { displayLabel: string | null } {
  const normalized = normalizeNominatimAddress(payload);
  return { ...normalized, displayLabel: makeDisplayLabel(normalized) };
}
