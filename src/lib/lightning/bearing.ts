import { isValidCoordinates } from "../location.ts";

export type CompassDirection = "N" | "NE" | "E" | "SE" | "S" | "SW" | "W" | "NW";

const DIRECTIONS: CompassDirection[] = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];

/** Initial great-circle bearing; coincident and ambiguous points have no direction. */
export function initialBearingDegrees(fromLat: number, fromLon: number, toLat: number, toLon: number): number | null {
  if (!isValidCoordinates(fromLat, fromLon) || !isValidCoordinates(toLat, toLon)) return null;
  if (fromLat === toLat && fromLon === toLon) return null;
  const radians = (degrees: number) => degrees * Math.PI / 180;
  const phi1 = radians(fromLat);
  const phi2 = radians(toLat);
  const delta = radians(toLon - fromLon);
  const east = Math.sin(delta) * Math.cos(phi2);
  const north = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(delta);
  if (Math.hypot(east, north) < 1e-12) return null;
  return (Math.atan2(east, north) * 180 / Math.PI + 360) % 360;
}

export function compassDirection(bearing: number | null): CompassDirection | null {
  if (bearing === null || !Number.isFinite(bearing)) return null;
  const normalized = ((bearing % 360) + 360) % 360;
  return DIRECTIONS[Math.floor(((normalized + 22.5) % 360) / 45)];
}
