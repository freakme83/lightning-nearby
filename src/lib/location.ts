export type LocationSource = "geolocation" | "search" | "map";

export interface LocationSelection {
  latitude: number;
  longitude: number;
  /** IANA timezone from the selected geocoding result, when available. */
  timezone?: string;
  label?: string;
  country?: string;
  admin1?: string;
  source?: LocationSource;
}

export interface MonitoredLocation extends LocationSelection {
  savedAt: number;
}

export const LOCATION_STORAGE_KEY = "lightning-nearby.location.v1";

export interface LocationStorage {
  setItem(key: string, value: string): void;
}

export function reduceLocationPrecision(latitude: number, longitude: number): Pick<LocationSelection, "latitude" | "longitude"> {
  // Four decimals preserve useful neighborhood-scale precision for future distance calculations,
  // while still discarding the browser's unnecessary raw GPS precision.
  return {
    latitude: Math.round(latitude * 10_000) / 10_000,
    longitude: Math.round(longitude * 10_000) / 10_000,
  };
}

export function isValidCoordinates(latitude: unknown, longitude: unknown): boolean {
  return typeof latitude === "number" && Number.isFinite(latitude) && Math.abs(latitude) <= 90
    && typeof longitude === "number" && Number.isFinite(longitude) && Math.abs(longitude) <= 180;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function optionalSource(value: unknown): LocationSource | undefined {
  return value === "geolocation" || value === "search" || value === "map" ? value : undefined;
}

export function makeMonitoredLocation(selection: LocationSelection, savedAt = Date.now()): MonitoredLocation {
  if (!isValidCoordinates(selection.latitude, selection.longitude)) throw new Error("invalid-location-coordinates");
  return {
    ...reduceLocationPrecision(selection.latitude, selection.longitude),
    savedAt,
    ...(optionalString(selection.timezone) ? { timezone: optionalString(selection.timezone) } : {}),
    ...(optionalString(selection.label) ? { label: optionalString(selection.label) } : {}),
    ...(optionalString(selection.country) ? { country: optionalString(selection.country) } : {}),
    ...(optionalString(selection.admin1) ? { admin1: optionalString(selection.admin1) } : {}),
    ...(optionalSource(selection.source) ? { source: optionalSource(selection.source) } : {}),
  };
}

/** The only persistence boundary for selected locations; a null candidate is a no-op. */
export function saveMonitoredLocation(storage: LocationStorage, selection: LocationSelection | null, savedAt = Date.now()): MonitoredLocation | null {
  if (!selection) return null;
  const saved = makeMonitoredLocation(selection, savedAt);
  storage.setItem(LOCATION_STORAGE_KEY, JSON.stringify(saved));
  return saved;
}

/** Reads both the original coordinate-only storage object and the extended optional metadata shape. */
export function parseMonitoredLocation(value: unknown): MonitoredLocation | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (!isValidCoordinates(record.latitude, record.longitude) || !Number.isFinite(record.savedAt)) return null;
  return {
    latitude: record.latitude as number,
    longitude: record.longitude as number,
    savedAt: record.savedAt as number,
    ...(optionalString(record.timezone) ? { timezone: optionalString(record.timezone) } : {}),
    ...(optionalString(record.label) ? { label: optionalString(record.label) } : {}),
    ...(optionalString(record.country) ? { country: optionalString(record.country) } : {}),
    ...(optionalString(record.admin1) ? { admin1: optionalString(record.admin1) } : {}),
    ...(optionalSource(record.source) ? { source: optionalSource(record.source) } : {}),
  };
}

export function formatCoordinates(latitude: number, longitude: number): string {
  const lat = Math.abs(latitude).toFixed(2);
  const lon = Math.abs(longitude).toFixed(2);
  return `${lat}° ${latitude >= 0 ? "N" : "S"}, ${lon}° ${longitude >= 0 ? "E" : "W"}`;
}

export function formatLocationLabel(location: LocationSelection): string {
  const parts = [location.label, location.admin1, location.country]
    .filter((part, index, all): part is string => Boolean(part) && all.indexOf(part) === index);
  return parts.length ? parts.join(", ") : formatCoordinates(location.latitude, location.longitude);
}
