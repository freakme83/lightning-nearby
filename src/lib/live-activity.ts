import { reverseGeocodePlace } from "./geocoding.ts";
import { REVERSE_GEOCODE_TIMEOUT_MS } from "./geolocation.ts";
import { directionLabel, formatDistance, t, type Locale } from "./i18n.ts";
import { isValidCoordinates } from "./location.ts";
import { greatCircleDistanceKm } from "./lightning/distance.ts";
import { LIVE_CURRENT_EVENT_LIMIT, type CurrentLightning, type CurrentLightningEvent } from "./lightning/types.ts";

export const ACTIVITY_MAP_MIN_ZOOM = 5;
export const ACTIVITY_MAP_MAX_ZOOM = 13;
export type MapPoint = [latitude: number, longitude: number];
export interface ActivityMapData {
  monitored: MapPoint;
  events: { event: CurrentLightningEvent; point: MapPoint; nearest: boolean }[];
  bounds: [MapPoint, MapPoint];
}
export interface ActivityPlaceContext {
  displayLabel: string;
  parentLabel?: string;
  offshore: boolean;
}

/** UI-only guards and antimeridian wrapping. API order and summary metrics remain authoritative. */
export function activityMapData(current: CurrentLightning | undefined, latitude: number, longitude: number): ActivityMapData | null {
  if (current?.status !== "active" || !isValidCoordinates(latitude, longitude)) return null;
  const events = (current.events ?? []).slice(0, LIVE_CURRENT_EVENT_LIMIT)
    .filter(event => isValidCoordinates(event.latitude, event.longitude) && Number.isFinite(event.observedAtMs))
    .map((event, index) => ({ event, nearest: index === 0,
      point: [event.latitude, longitude + ((event.longitude - longitude + 540) % 360 - 180)] as MapPoint }));
  if (!events.length) return null;
  const monitored: MapPoint = [latitude, longitude];
  const points = [monitored, ...events.map(item => item.point)];
  return { monitored, events, bounds: [
    [Math.min(...points.map(point => point[0])), Math.min(...points.map(point => point[1]))],
    [Math.max(...points.map(point => point[0])), Math.max(...points.map(point => point[1]))],
  ] };
}

/** Geographic context, never a strike address. Do not infer sea location from missing roads. */
export function parseActivityPlace(payload: unknown, latitude: number, longitude: number): ActivityPlaceContext | null {
  if (!payload || typeof payload !== "object") return null;
  const row = payload as Record<string, unknown>;
  if (!row.address || typeof row.address !== "object" || Array.isArray(row.address)) return null;
  const address = row.address as Record<string, unknown>;
  const text = (key: string) => typeof address[key] === "string" ? address[key].trim() || undefined : undefined;
  const first = (keys: string[], except?: string) => keys.map(text).find(value => value && value.toLocaleLowerCase() !== except?.toLocaleLowerCase());
  const water = first(["sea", "ocean"]);
  const offshore = Boolean(water || row.type === "sea" || row.type === "ocean");
  // Reverse lookup can return a distant mapped feature, especially offshore. Suppress its narrow locality.
  const featureLatitude = typeof row.lat === "string" && row.lat.trim() ? Number(row.lat) : row.lat;
  const featureLongitude = typeof row.lon === "string" && row.lon.trim() ? Number(row.lon) : row.lon;
  const distantFeature = isValidCoordinates(featureLatitude, featureLongitude) &&
    greatCircleDistanceKm(latitude, longitude, featureLatitude as number, featureLongitude as number) > 5;
  const locality = !distantFeature ? first(["neighbourhood", "suburb", "quarter", "city_district", "town", "village", "city", "municipality"]) : undefined;
  const region = first(["county", "state", "province", "region"]);
  const primary = locality ?? region;
  if (!primary) return water ? { displayLabel: water, offshore: false } : null;
  const parent = first(offshore ? ["state", "province", "region"] :
    distantFeature ? ["state", "province", "region"] : ["city_district", "municipality", "city", "county", "state", "province", "region"], primary);
  return { displayLabel: primary, ...(parent ? { parentLabel: parent } : {}), offshore };
}

export function formatActivityPlace(context: ActivityPlaceContext | null, locale: Locale): string | null {
  if (!context?.displayLabel) return null;
  if (context.offshore) return [t(locale, "activityOffshore", { place: context.displayLabel }),
    context.parentLabel ? t(locale, "activityAround", { place: context.parentLabel }) : null].filter(Boolean).join(" / ");
  return t(locale, "activityAround", { place: [context.displayLabel, context.parentLabel].filter(Boolean).join(" / ") });
}

/** One optional lookup per accepted Live result, with a deadline and no retries or per-event calls. */
export async function lookupActivityPlace(event: CurrentLightningEvent, signal: AbortSignal, locale: Locale,
  fetcher: typeof fetch = fetch, timeoutMs = REVERSE_GEOCODE_TIMEOUT_MS): Promise<ActivityPlaceContext | null> {
  if (signal.aborted) return null;
  const bounded = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
  try {
    return await reverseGeocodePlace(event.latitude, event.longitude,
      payload => parseActivityPlace(payload, event.latitude, event.longitude), bounded, fetcher, locale);
  } catch { return null; }
}

/** The text remains usable independently of the optional place label and map. */
export function liveActivityView(current: CurrentLightning | undefined, latitude: number, longitude: number,
  locale: Locale, place: ActivityPlaceContext | null = null) {
  if (current?.status !== "active") return null;
  const distance = current.nearestKm !== null ? `${formatDistance(current.nearestKm, locale)} km` : null;
  const direction = current.nearestDirection ? directionLabel(locale, current.nearestDirection) : null;
  const age = current.nearestAgeMinutes !== null ? t(locale, "ageMinutes", { age: Math.max(0, Math.round(current.nearestAgeMinutes)) }) : null;
  return { headline: t(locale, "lightningNearby"), placeContext: formatActivityPlace(place, locale),
    nearestLine: distance ? [[distance, direction].filter(Boolean).join(" "), age].filter(Boolean).join(" · ") : null,
    map: activityMapData(current, latitude, longitude) };
}
