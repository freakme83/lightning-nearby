// Foundation only: these helpers describe places and never authorize publication.
import { normalizeNominatimAddress } from "../lightning-location-naming/normalize.ts";
import type { NormalizedPlace, ProviderAddressHierarchy } from "../lightning-location-naming/types.ts";

export const CG_LOCATION_SEMANTICS_VERSION = "cg-location:v1" as const;
export type PlaceInput = NormalizedPlace & { providerAddress?: ProviderAddressHierarchy };
export type PlaceClassification = {
  classification: "urban" | "rural" | "unknown";
  evidence: string[];
};
export type SemanticLocationIdentity =
  | { available: true; key: string; level: "neighborhood" | "settlement" | "district";
      components: { country: string; province: string; parent: string; place: string | null } }
  | { available: false; reason: "missing_provenance" | "hierarchy_conflict" | "ambiguous_hierarchy" |
      "missing_geography" | "missing_parent" | "missing_place" };

export function canonicalPlaceName(value?: string | null): string | null {
  if (typeof value !== "string") return null;
  const clean = value.normalize("NFC").trim().replace(/\s+/gu, " ").toLocaleLowerCase("tr-TR")
    .replace(/\s+(?:mahallesi|ilçesi|ili)$/u, "").trim();
  return clean || null;
}

function hierarchyConflict(place: PlaceInput): boolean {
  if (!place.providerAddress) return false;
  const expected = normalizeNominatimAddress({ address: place.providerAddress });
  return (["neighborhood", "locality", "district", "province", "country"] as const)
    .some(key => canonicalPlaceName(place[key]) !== canonicalPlaceName(expected[key])) ||
    place.localityKind !== expected.localityKind;
}

function ambiguousSmallPlace(place: PlaceInput): boolean {
  const address = place.providerAddress;
  return Boolean(address?.city_district && ![address.quarter, address.neighbourhood,
    address.neighborhood, address.suburb, address.village, address.hamlet].some(canonicalPlaceName)) ||
    (!address && place.rawType === "city_district");
}

export function classifyCgPlace(place: PlaceInput): PlaceClassification {
  const rural = ["village", "hamlet"].filter(key =>
    canonicalPlaceName(place.providerAddress?.[key as "village" | "hamlet"]) ||
    place.localityKind === key || place.rawType === key);
  // Rural components may coexist legitimately with a town/municipality parent.
  if (rural.length) return { classification: "rural", evidence: rural.map(key => `rural:${key}`) };
  if (hierarchyConflict(place)) return { classification: "unknown", evidence: ["hierarchy_conflict"] };
  if (ambiguousSmallPlace(place)) return { classification: "unknown", evidence: ["ambiguous_city_district"] };
  if (place.locality && ["city", "town", "municipality"].includes(place.localityKind ?? "")) {
    return { classification: "urban", evidence: [`urban:${place.localityKind}`] };
  }
  return { classification: "unknown", evidence: ["missing_urban_or_rural_evidence"] };
}

export function semanticCgLocationIdentity(place: PlaceInput): SemanticLocationIdentity {
  const address = place.providerAddress;
  if (!address) return { available: false, reason: "missing_provenance" };
  if (hierarchyConflict(place)) return { available: false, reason: "hierarchy_conflict" };
  if (ambiguousSmallPlace(place)) return { available: false, reason: "ambiguous_hierarchy" };
  const country = canonicalPlaceName(place.country);
  const province = canonicalPlaceName(place.province);
  if (!country || !province) return { available: false, reason: "missing_geography" };

  const rural = classifyCgPlace(place).classification === "rural";
  const neighborhood = canonicalPlaceName(place.neighborhood);
  const settlement = canonicalPlaceName(address.village) ?? canonicalPlaceName(address.hamlet);
  const child = rural ? settlement : neighborhood;
  // city_district is not a trusted administrative parent. A town can supply the
  // district-like parent used by Ankara naming when explicit administration is absent.
  const parent = [address.county, address.district, address.state_district, address.town]
    .map(canonicalPlaceName).find(value => value && value !== province && value !== child);
  if (!parent) return { available: false, reason: "missing_parent" };
  if (rural && !settlement) return { available: false, reason: "missing_place" };
  const level = rural ? "settlement" : neighborhood ? "neighborhood" : "district";
  const components = { country, province, parent, place: child };
  return { available: true, level, components,
    key: JSON.stringify([CG_LOCATION_SEMANTICS_VERSION, country, province, parent, level, child]) };
}
