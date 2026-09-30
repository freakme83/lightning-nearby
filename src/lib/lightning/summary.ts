import { greatCircleDistanceKm } from "./distance.ts";
import { LIGHTNING_QUERY_RADIUS_KM, LIGHTNING_WINDOW_MINUTES, type LiveLightningSummary, type LiveStrike, type ProviderDiagnostics } from "./types.ts";

const RADIUS_EPSILON_KM = 1e-8;

export function summarizeRecentActivity(
  events: readonly LiveStrike[],
  latitude: number,
  longitude: number,
  fetchedAt: number,
  rejectedEventCount = 0,
  diagnostics: ProviderDiagnostics,
  mayBeTruncated = false,
): LiveLightningSummary {
  const windowStart = fetchedAt - LIGHTNING_WINDOW_MINUTES * 60_000;
  const recent = events.flatMap((event) => {
    if (!Number.isFinite(event.observedAtMs) || event.observedAtMs < windowStart || event.observedAtMs > fetchedAt + 60_000) return [];
    const distanceKm = greatCircleDistanceKm(latitude, longitude, event.latitude, event.longitude);
    if (distanceKm > LIGHTNING_QUERY_RADIUS_KM + RADIUS_EPSILON_KM) return [];
    return [{ event, distanceKm }];
  });

  const nearest = recent.reduce<(typeof recent)[number] | null>((best, item) => !best || item.distanceKm < best.distanceKm ? item : best, null);
  const latestEventAt = recent.reduce<number | null>((latest, { event }) => latest === null || event.observedAtMs > latest ? event.observedAtMs : latest, null);
  const within = (radiusKm: number) => recent.filter(({ distanceKm }) => distanceKm <= radiusKm + RADIUS_EPSILON_KM).length;

  return {
    status: "live",
    provider: "xweather",
    observationWindowMinutes: LIGHTNING_WINDOW_MINUTES,
    fetchedAt,
    latestEventAt,
    nearestKm: nearest?.distanceKm ?? null,
    nearestAgeMinutes: nearest ? Math.max(0, (fetchedAt - nearest.event.observedAtMs) / 60_000) : null,
    counts: { within5Km: within(5), within10Km: within(10), within25Km: within(25), within50Km: within(50) },
    totalEvents: recent.length,
    rejectedEventCount,
    mayBeTruncated,
    diagnostics,
  };
}
