import { reverseGeocodeLocation, type ResolvedPlaceLabel } from "./geocoding.ts";
import { reduceLocationPrecision, type LocationSelection } from "./location.ts";

export const REVERSE_GEOCODE_TIMEOUT_MS = 5_000;

export type ReverseGeocodeLookup = (
  latitude: number,
  longitude: number,
  signal?: AbortSignal,
) => Promise<ResolvedPlaceLabel | null>;

/** Enrich reduced device coordinates when possible; place lookup never owns the coordinates. */
export async function resolveGeolocationSelection(
  latitude: number,
  longitude: number,
  signal?: AbortSignal,
  reverseLookup: ReverseGeocodeLookup = reverseGeocodeLocation,
  timeoutMs = REVERSE_GEOCODE_TIMEOUT_MS,
): Promise<LocationSelection> {
  const coordinates = reduceLocationPrecision(latitude, longitude);
  if (signal?.aborted) throw signal.reason ?? new DOMException("Location request cancelled", "AbortError");
  const lookupController = new AbortController();
  const abortLookup = () => lookupController.abort(signal?.reason);
  if (signal?.aborted) abortLookup();
  else signal?.addEventListener("abort", abortLookup, { once: true });

  const timeout = setTimeout(() => lookupController.abort(new DOMException("Reverse geocoding timed out", "TimeoutError")), timeoutMs);
  let metadata: ResolvedPlaceLabel | null = null;
  try {
    metadata = await reverseLookup(coordinates.latitude, coordinates.longitude, lookupController.signal);
  } catch (error) {
    if (signal?.aborted) throw error;
    // Reverse geocoding is optional. A timeout or provider/network error keeps coordinates usable.
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abortLookup);
  }

  if (signal?.aborted) throw signal.reason ?? new DOMException("Location request cancelled", "AbortError");
  return { ...coordinates, ...metadata, source: "geolocation" };
}

export function isCurrentGeolocationRequest(
  requestId: number,
  latestRequestId: number,
  signal: AbortSignal,
): boolean {
  return requestId === latestRequestId && !signal.aborted;
}
