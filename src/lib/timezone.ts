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

/**
 * Preserve a provider civil timezone. Resolve generic Etc/GMT offsets only,
 * preferring a timezone attached to the selected place before a coordinate lookup.
 * The lookup is best-effort; failure leaves the provider timezone untouched.
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

  const url = new URL("https://api.geotimezone.com/public/timezone");
  url.searchParams.set("latitude", String(latitude));
  url.searchParams.set("longitude", String(longitude));
  try {
    const response = await fetcher(url, { signal, mode: "cors" });
    if (!response.ok) return providerTimezone;
    const payload: unknown = await response.json();
    if (signal?.aborted || typeof payload !== "object" || payload === null) return providerTimezone;
    const timezone = (payload as GeoTimeZoneResponse).iana_timezone;
    return isCivilIanaTimezone(timezone) ? timezone : providerTimezone;
  } catch {
    return providerTimezone;
  }
}
