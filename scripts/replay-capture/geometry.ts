// Spherical azimuthal equidistant coordinates in kilometres, centered on the
// requested point. The square is |east|, |north| <= sideKm / 2.
export const CAPTURE_GEOMETRY_VERSION = "azimuthal-equidistant-v1";
export const CAPTURE_SIDES_KM = [25, 50, 100, 200] as const;
export const CAPTURE_DURATIONS_MINUTES = [5, 10, 15, 30, 60, 120, 180] as const;
const EARTH_RADIUS_KM = 6371.0088;
const RADIANS = Math.PI / 180;

export type CaptureArea = { centerLat: number; centerLon: number; sideKm: (typeof CAPTURE_SIDES_KM)[number] };

export function validateCaptureSettings(centerLat: number, centerLon: number, sideKm: number,
  durationMinutes: number): CaptureArea & { durationMinutes: number } {
  if (!Number.isFinite(centerLat) || Math.abs(centerLat) > 75 ||
      !Number.isFinite(centerLon) || Math.abs(centerLon) > 180 ||
      !CAPTURE_SIDES_KM.some(value => value === sideKm) ||
      !CAPTURE_DURATIONS_MINUTES.some(value => value === durationMinutes)) {
    throw new Error("Invalid capture coordinates, square size, or duration (latitude must be within ±75°).");
  }
  return { centerLat, centerLon, sideKm: sideKm as CaptureArea["sideKm"], durationMinutes };
}

export function insideCaptureSquare(area: CaptureArea, latitude: number, longitude: number): boolean {
  if (!Number.isFinite(latitude) || Math.abs(latitude) > 90 ||
      !Number.isFinite(longitude) || Math.abs(longitude) > 180) return false;
  const lat0 = area.centerLat * RADIANS;
  const lat = latitude * RADIANS;
  const deltaLon = Math.atan2(Math.sin((longitude - area.centerLon) * RADIANS),
    Math.cos((longitude - area.centerLon) * RADIANS));
  const cosC = Math.max(-1, Math.min(1, Math.sin(lat0) * Math.sin(lat) +
    Math.cos(lat0) * Math.cos(lat) * Math.cos(deltaLon)));
  const c = Math.acos(cosC);
  if (c > Math.PI / 2) return false;
  const scale = c < 1e-7 ? 1 : c / Math.sin(c);
  const east = EARTH_RADIUS_KM * scale * Math.cos(lat) * Math.sin(deltaLon);
  const north = EARTH_RADIUS_KM * scale *
    (Math.cos(lat0) * Math.sin(lat) - Math.sin(lat0) * Math.cos(lat) * Math.cos(deltaLon));
  return Math.abs(east) <= area.sideKm / 2 + 1e-7 && Math.abs(north) <= area.sideKm / 2 + 1e-7;
}
