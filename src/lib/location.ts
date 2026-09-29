export interface MonitoredLocation {
  latitude: number;
  longitude: number;
  savedAt: number;
}

export const LOCATION_STORAGE_KEY = "lightning-nearby.location.v1";

export function reduceLocationPrecision(latitude: number, longitude: number): Pick<MonitoredLocation, "latitude" | "longitude"> {
  // Three decimals are roughly 100 m; keep only the precision needed for a
  // useful grid-cell forecast instead of persisting the browser's full fix.
  return {
    latitude: Math.round(latitude * 1000) / 1000,
    longitude: Math.round(longitude * 1000) / 1000,
  };
}

export function formatCoordinates(latitude: number, longitude: number): string {
  const lat = Math.abs(latitude).toFixed(2);
  const lon = Math.abs(longitude).toFixed(2);
  return `${lat}° ${latitude >= 0 ? "N" : "S"}, ${lon}° ${longitude >= 0 ? "E" : "W"}`;
}
