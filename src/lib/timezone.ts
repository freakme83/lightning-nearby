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

// Four sparse probes at the edge of a 200 km radius. The Gulf acceptance point
// is roughly this far from Florida land; no country or bearing is presumed.
const NEARBY_PROBE_RADIUS_KM = 200;
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

interface OpenMeteoTimezoneResult {
  timezone?: unknown;
  error?: unknown;
}

/**
 * Keep the provider's civil zone and use selected-place metadata when available.
 * For a generic offshore zone, ask Open-Meteo's existing forecast host to resolve
 * four bounded nearby points with timezone=auto. This is best-effort and affects
 * display formatting only; failure leaves the provider timezone unchanged.
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

  const points = nearbyProbeCoordinates(latitude, longitude);
  const url = new URL("https://api.open-meteo.com/v1/forecast");
  url.searchParams.set("latitude", points.map(([lat]) => String(lat)).join(","));
  url.searchParams.set("longitude", points.map(([, lon]) => String(lon)).join(","));
  url.searchParams.set("current", "temperature_2m");
  url.searchParams.set("timezone", points.map(() => "auto").join(","));

  try {
    const response = await fetcher(url, { signal, cache: "no-store" });
    if (!response.ok || signal?.aborted) return providerTimezone;
    const payload: unknown = await response.json();
    if (signal?.aborted || !Array.isArray(payload)) return providerTimezone;

    // The API returns one response object per requested coordinate, in order.
    // These cardinal samples are equidistant; direction order breaks ties
    // deterministically and only a valid civil IANA result is accepted.
    for (const result of payload) {
      if (typeof result !== "object" || result === null || (result as OpenMeteoTimezoneResult).error) continue;
      const timezone = (result as OpenMeteoTimezoneResult).timezone;
      if (isCivilIanaTimezone(timezone)) return timezone;
    }
  } catch {
    // Optional display lookup must never make an otherwise usable forecast fail.
  }
  return providerTimezone;
}
