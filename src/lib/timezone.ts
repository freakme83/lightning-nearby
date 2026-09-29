/** Open-Meteo can return nautical/fixed offsets for points outside civil zones. */
export function isGenericFixedOffsetTimezone(timezone: string): boolean {
  return /^Etc\/GMT(?:[+-]\d{1,2})?$/.test(timezone);
}

/** Format an unchanged Unix forecast timestamp in the chosen civil timezone. */
export function formatForecastLocalTime(epoch: number, timezone: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(epoch * 1000);
}

function isCivilIanaTimezone(timezone: unknown): timezone is string {
  if (typeof timezone !== "string" || !timezone.trim() || isGenericFixedOffsetTimezone(timezone)) return false;
  try {
    new Intl.DateTimeFormat("en", { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

interface GeoTimeZoneResponse {
  iana_timezone?: unknown;
}

// GeoTimeZone resolves the zone containing a coordinate; it does not promise
// a nearest-land result. A 150 km cardinal ring reaches nearby coastal land
// for the Gulf regression point while remaining a small, bounded search.
const NEARBY_PROBE_RADIUS_KM = 150;
const NEARBY_PROBE_DIRECTIONS = ["north", "east", "south", "west"] as const;

function nearbyProbeCoordinates(latitude: number, longitude: number): Array<[number, number]> {
  const latitudeDelta = NEARBY_PROBE_RADIUS_KM / 111.32;
  const longitudeDelta = latitudeDelta / Math.max(Math.cos(latitude * Math.PI / 180), 0.01);
  const wrapLongitude = (value: number) => ((value + 540) % 360) - 180;
  return NEARBY_PROBE_DIRECTIONS.map((direction) => {
    const probeLatitude = latitude + (direction === "north" ? latitudeDelta : direction === "south" ? -latitudeDelta : 0);
    const probeLongitude = longitude + (direction === "east" ? longitudeDelta : direction === "west" ? -longitudeDelta : 0);
    return [Math.max(-90, Math.min(90, probeLatitude)), wrapLongitude(probeLongitude)];
  });
}

async function lookupCivilTimezone(
  latitude: number,
  longitude: number,
  signal: AbortSignal | undefined,
  fetcher: typeof fetch,
): Promise<{ timezone: string | null; failed: boolean }> {
  if (signal?.aborted) return { timezone: null, failed: true };
  const url = new URL("https://api.geotimezone.com/public/timezone");
  url.searchParams.set("latitude", String(latitude));
  url.searchParams.set("longitude", String(longitude));
  try {
    const response = await fetcher(url, { signal, mode: "cors" });
    if (!response.ok || signal?.aborted) return { timezone: null, failed: true };
    const payload: unknown = await response.json();
    if (signal?.aborted) return { timezone: null, failed: true };
    if (typeof payload !== "object" || payload === null) return { timezone: null, failed: false };
    const timezone = (payload as GeoTimeZoneResponse).iana_timezone;
    return { timezone: isCivilIanaTimezone(timezone) ? timezone : null, failed: false };
  } catch {
    return { timezone: null, failed: true };
  }
}

/**
 * Preserve a provider civil timezone. Resolve generic Etc/GMT offsets only,
 * preferring selected-place metadata, then exact coordinates, then four
 * bounded nearby probes. Failure leaves the provider timezone untouched.
 */
export async function resolveDisplayTimezone(
  latitude: number,
  longitude: number,
  providerTimezone: string,
  placeTimezone?: string,
  signal?: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<string> {
  if (!isGenericFixedOffsetTimezone(providerTimezone)) return providerTimezone;
  if (isCivilIanaTimezone(placeTimezone)) return placeTimezone;
  if (signal?.aborted) return providerTimezone;

  const exactLookup = await lookupCivilTimezone(latitude, longitude, signal, fetcher);
  if (exactLookup.timezone) return exactLookup.timezone;
  if (exactLookup.failed) return providerTimezone;
  if (signal?.aborted) return providerTimezone;

  for (const [probeLatitude, probeLongitude] of nearbyProbeCoordinates(latitude, longitude)) {
    const nearbyLookup = await lookupCivilTimezone(probeLatitude, probeLongitude, signal, fetcher);
    if (nearbyLookup.timezone) return nearbyLookup.timezone;
    if (nearbyLookup.failed) return providerTimezone;
    if (signal?.aborted) return providerTimezone;
  }
  return providerTimezone;
}
