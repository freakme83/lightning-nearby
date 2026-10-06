import type {
  CostDiagnostics, EnrichmentOptions, EnrichmentReference, EnrichmentResult,
  MatchCounts, MatchThresholds, XweatherLightningEvent, LightningMatch,
} from "./types.ts";

export const DEFAULT_THRESHOLDS: MatchThresholds = {
  radiusKm: 10,
  maxMatchDistanceKm: 8,
  maxTimeDifferenceMs: 5 * 60_000,
  limit: 10,
};

const EARTH_RADIUS_KM = 6371.0088;
const DEG_TO_RAD = Math.PI / 180;

export function validateReference(reference: EnrichmentReference): void {
  if (!Number.isFinite(reference.latitude) || reference.latitude < -90 || reference.latitude > 90 ||
      !Number.isFinite(reference.longitude) || reference.longitude < -180 || reference.longitude > 180) {
    throw new Error("invalid latitude/longitude");
  }
  if (!Number.isSafeInteger(reference.eventTimeMs) || reference.eventTimeMs < 0 || reference.eventTimeMs > 8.64e15) {
    throw new Error("invalid event time");
  }
}

export function resolveThresholds(options: EnrichmentOptions = {}): MatchThresholds {
  const result = { ...DEFAULT_THRESHOLDS, ...options };
  if (!Number.isFinite(result.radiusKm) || result.radiusKm <= 0 || result.radiusKm > 100) throw new Error("invalid radiusKm");
  if (!Number.isFinite(result.maxMatchDistanceKm) || result.maxMatchDistanceKm <= 0 || result.maxMatchDistanceKm > result.radiusKm) {
    throw new Error("invalid maxMatchDistanceKm");
  }
  if (!Number.isSafeInteger(result.maxTimeDifferenceMs) || result.maxTimeDifferenceMs <= 0 || result.maxTimeDifferenceMs > 24 * 60 * 60_000) {
    throw new Error("invalid maxTimeDifferenceMs");
  }
  if (!Number.isSafeInteger(result.limit) || result.limit < 1 || result.limit > 10) throw new Error("invalid limit");
  return result;
}

export function greatCircleDistanceKm(a: Pick<XweatherLightningEvent, "latitude" | "longitude">, b: EnrichmentReference): number {
  const lat1 = a.latitude * DEG_TO_RAD;
  const lat2 = b.latitude * DEG_TO_RAD;
  const dLat = (b.latitude - a.latitude) * DEG_TO_RAD;
  const dLon = (b.longitude - a.longitude) * DEG_TO_RAD;
  const haversine = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(Math.max(0, Math.min(1, haversine))));
}

function rank(a: LightningMatch, b: LightningMatch): number {
  return a.timeDifferenceMs - b.timeDifferenceMs || a.distanceKm - b.distanceKm || a.id.localeCompare(b.id);
}

function makeCounts(returned: number, matched: LightningMatch[]): MatchCounts {
  return { returned, matched: matched.length, matchedCg: matched.filter(item => item.type === "cg").length,
    matchedIc: matched.filter(item => item.type === "ic").length };
}

export function matchLightningEvents(reference: EnrichmentReference, events: XweatherLightningEvent[], thresholds: MatchThresholds,
  cost?: CostDiagnostics): EnrichmentResult {
  validateReference(reference);
  const matches: LightningMatch[] = events.flatMap(event => {
    const distanceKm = greatCircleDistanceKm(event, reference);
    const timeDifferenceMs = Math.abs(event.eventTimeMs - reference.eventTimeMs);
    if (distanceKm > thresholds.maxMatchDistanceKm || timeDifferenceMs > thresholds.maxTimeDifferenceMs) return [];
    return [{ ...event, distanceKm, timeDifferenceMs }];
  }).sort(rank);
  const counts = makeCounts(events.length, matches);
  const bestCg = matches.filter(item => item.type === "cg").sort(rank)[0];
  if (bestCg) return { status: "cg_verified", provider: "xweather", reference, thresholds, counts, match: bestCg, cost };
  const bestIc = matches.filter(item => item.type === "ic").sort(rank)[0];
  if (bestIc) return { status: "ic_only", provider: "xweather", reference, thresholds, counts, match: bestIc, cost };
  return { status: "no_match", provider: "xweather", reference, thresholds, counts, cost };
}
