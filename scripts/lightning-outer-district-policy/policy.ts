import { isAnkaraProvince } from "../lightning-location-naming/normalize.ts";
import type { NormalizedPlace } from "../lightning-location-naming/types.ts";

const DISTRICTS = new Map<string, string>([
  ["sereflikochisar", "Şereflikoçhisar"], ["bala", "Balâ"], ["haymana", "Haymana"],
  ["polatli", "Polatlı"], ["beypazari", "Beypazarı"], ["nallihan", "Nallıhan"],
  ["gudul", "Güdül"], ["camlidere", "Çamlıdere"], ["kizilcahamam", "Kızılcahamam"],
  ["cubuk", "Çubuk"], ["kalecik", "Kalecik"], ["evren", "Evren"],
]);

function key(value: string): string {
  return value.trim().toLocaleLowerCase("tr-TR").normalize("NFD").replace(/\p{Diacritic}/gu, "")
    .replace(/ı/gu, "i").replace(/\s+/gu, " ");
}

export type OuterDistrictResolution =
  | { outcome: "target"; canonicalDistrict: string }
  | { outcome: "not_applicable_district" }
  | { outcome: "location_unavailable" };

/** Resolve only from Ankara's structured district hierarchy; never parse rendered labels. */
export function resolveOuterDistrict(place: NormalizedPlace | null | undefined): OuterDistrictResolution {
  if (!place?.province?.trim()) return { outcome: "location_unavailable" };
  if (!isAnkaraProvince(place.province)) return { outcome: "not_applicable_district" };

  const district = place.district?.trim();
  const town = place.localityKind === "town" ? place.locality?.trim() : undefined;
  const districtMatch = district ? DISTRICTS.get(key(district)) : undefined;
  const townMatch = town ? DISTRICTS.get(key(town)) : undefined;

  if (districtMatch && townMatch && districtMatch !== townMatch) {
    return { outcome: "location_unavailable" };
  }
  const canonicalDistrict = districtMatch ?? townMatch;
  if (canonicalDistrict) return { outcome: "target", canonicalDistrict };
  return district || town ? { outcome: "not_applicable_district" } : { outcome: "location_unavailable" };
}
