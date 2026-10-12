import { isAnkaraProvince } from "../lightning-location-naming/normalize.ts";
import type { NormalizedPlace } from "../lightning-location-naming/types.ts";

export const OUTER_DISTRICT_NON_CG_COOLDOWN_MS = 120 * 60_000;

const DISTRICTS = new Map<string, string>([
  ["sereflikochisar", "Şereflikoçhisar"], ["bala", "Balâ"], ["haymana", "Haymana"],
  ["polatli", "Polatlı"], ["beypazari", "Beypazarı"], ["nallihan", "Nallıhan"],
  ["gudul", "Güdül"], ["camlidere", "Çamlıdere"], ["kizilcahamam", "Kızılcahamam"],
  ["cubuk", "Çubuk"], ["kalecik", "Kalecik"],
]);

function key(value: string): string {
  return value.trim().toLocaleLowerCase("tr-TR").normalize("NFD").replace(/\p{Diacritic}/gu, "")
    .replace(/ı/gu, "i").replace(/\s+/gu, " ");
}

export type DistrictResolution =
  | { outcome: "target"; canonicalDistrict: string }
  | { outcome: "not_applicable_district" }
  | { outcome: "location_unavailable" };

/** Use only structured reverse-geocoder hierarchy; no locality or rendered-label inference. */
export function resolveOuterDistrict(place: NormalizedPlace | null | undefined): DistrictResolution {
  if (!place?.province?.trim()) return { outcome: "location_unavailable" };
  if (!isAnkaraProvince(place.province)) return { outcome: "not_applicable_district" };
  if (!place.district?.trim()) return { outcome: "location_unavailable" };
  const canonicalDistrict = DISTRICTS.get(key(place.district));
  return canonicalDistrict ? { outcome: "target", canonicalDistrict } : { outcome: "not_applicable_district" };
}

export type OuterDistrictCooldownDecision = {
  outcome: "allowed_no_prior_publication" | "allowed_cooldown_elapsed" | "held_within_cooldown";
  elapsedMs: number | null;
  remainingMs: number | null;
};

export function evaluateOuterDistrictCooldown(candidateAtMs: number, previousAtMs: number | null): OuterDistrictCooldownDecision {
  if (!Number.isFinite(candidateAtMs)) throw new RangeError("candidateAtMs must be finite");
  if (previousAtMs === null) return { outcome: "allowed_no_prior_publication", elapsedMs: null, remainingMs: null };
  if (!Number.isFinite(previousAtMs)) throw new RangeError("previousAtMs must be finite");
  const elapsedMs = candidateAtMs - previousAtMs;
  return elapsedMs < OUTER_DISTRICT_NON_CG_COOLDOWN_MS
    ? { outcome: "held_within_cooldown", elapsedMs, remainingMs: OUTER_DISTRICT_NON_CG_COOLDOWN_MS - elapsedMs }
    : { outcome: "allowed_cooldown_elapsed", elapsedMs, remainingMs: null };
}
