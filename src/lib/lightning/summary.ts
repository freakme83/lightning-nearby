import { greatCircleDistanceKm } from "./distance.ts";
import { compassDirection, initialBearingDegrees } from "./bearing.ts";
import {
  LIGHTNING_QUERY_RADIUS_KM,
  LIGHTNING_WINDOW_MINUTES,
  LIVE_CURRENT_RADIUS_KM,
  LIVE_CURRENT_WINDOW_MINUTES,
  LIVE_CURRENT_EVENT_LIMIT,
  type CurrentLightningAvailable,
  type LiveStrike,
  type ProviderDiagnostics,
} from "./types.ts";

const RADIUS_EPSILON_KM = 1e-8;

export function summarizeRecentActivity(
  events: readonly LiveStrike[],
  latitude: number,
  longitude: number,
  fetchedAt: number,
  rejectedEventCount = 0,
  diagnostics: ProviderDiagnostics,
  mayBeTruncated = false,
): {
  status: "live";
  provider: "xweather";
  observationWindowMinutes: number;
  fetchedAt: number;
  latestEventAt: number | null;
  nearestKm: number | null;
  nearestDirection: ReturnType<typeof compassDirection>;
  nearestAgeMinutes: number | null;
  counts: { within5Km: number; within10Km: number; within25Km: number; within50Km: number };
  totalEvents: number;
  rejectedEventCount: number;
  mayBeTruncated: boolean;
  diagnostics: ProviderDiagnostics;
} {
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
    nearestDirection: nearest ? compassDirection(initialBearingDegrees(latitude, longitude, nearest.event.latitude, nearest.event.longitude)) : null,
    nearestAgeMinutes: nearest ? Math.max(0, (fetchedAt - nearest.event.observedAtMs) / 60_000) : null,
    counts: { within5Km: within(5), within10Km: within(10), within25Km: within(25), within50Km: within(50) },
    totalEvents: recent.length,
    rejectedEventCount,
    mayBeTruncated,
    diagnostics,
  };
}

export function summarizeCurrentFlashes(
  events: readonly LiveStrike[],
  latitude: number,
  longitude: number,
  fetchedAt: number,
  rejectedEventCount: number,
  diagnostics: ProviderDiagnostics,
  mayBeTruncated: boolean,
): CurrentLightningAvailable {
  const windowStart = fetchedAt - LIVE_CURRENT_WINDOW_MINUTES * 60_000;
  const recent = events.flatMap((event) => {
    if (!Number.isFinite(event.observedAtMs) || event.observedAtMs < windowStart || event.observedAtMs > fetchedAt + 60_000) return [];
    const distanceKm = greatCircleDistanceKm(latitude, longitude, event.latitude, event.longitude);
    if (distanceKm > LIVE_CURRENT_RADIUS_KM + RADIUS_EPSILON_KM) return [];
    return [{ event, distanceKm }];
  });
  const nearest = recent.reduce<(typeof recent)[number] | null>((best, item) => !best || item.distanceKm < best.distanceKm ? item : best, null);
  const latestEventAt = recent.reduce<number | null>((latest, { event }) => latest === null || event.observedAtMs > latest ? event.observedAtMs : latest, null);
  const within = (radiusKm: number) => recent.filter(({ distanceKm }) => distanceKm <= radiusKm + RADIUS_EPSILON_KM).length;
  // Public map subset only. Summary metrics and the existing nearest-event tie behavior use the full set.
  const representativeEvents = [...recent].sort((a, b) => a.distanceKm - b.distanceKm ||
    b.event.observedAtMs - a.event.observedAtMs || a.event.latitude - b.event.latitude ||
    a.event.longitude - b.event.longitude || (a.event.type < b.event.type ? -1 : a.event.type > b.event.type ? 1 : 0))
    .slice(0, LIVE_CURRENT_EVENT_LIMIT)
    .map(({ event }) => ({ observedAtMs: event.observedAtMs, latitude: event.latitude,
      longitude: event.longitude, type: event.type }));
  return {
    status: recent.length > 0 ? "active" : "clear",
    events: representativeEvents,
    windowMinutes: LIVE_CURRENT_WINDOW_MINUTES,
    radiusKm: LIVE_CURRENT_RADIUS_KM,
    latestEventAt,
    nearestKm: nearest?.distanceKm ?? null,
    nearestDirection: nearest ? compassDirection(initialBearingDegrees(latitude, longitude, nearest.event.latitude, nearest.event.longitude)) : null,
    nearestAgeMinutes: nearest ? Math.max(0, (fetchedAt - nearest.event.observedAtMs) / 60_000) : null,
    counts: { within5Km: within(5), within10Km: within(10), within25Km: within(25), within40Km: within(40) },
    totalFlashes: recent.length,
    rejectedEventCount,
    mayBeTruncated,
    diagnostics,
  };
}
