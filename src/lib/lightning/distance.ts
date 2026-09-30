import { isValidCoordinates } from "../location.ts";

const EARTH_RADIUS_KM = 6371.0088;

export function greatCircleDistanceKm(
  latitude1: number,
  longitude1: number,
  latitude2: number,
  longitude2: number,
): number {
  if (![latitude1, longitude1, latitude2, longitude2].every(Number.isFinite)
    || !isValidCoordinates(latitude1, longitude1) || !isValidCoordinates(latitude2, longitude2)) {
    throw new Error("invalid-coordinates");
  }

  const radians = (degrees: number) => degrees * Math.PI / 180;
  const latitudeDelta = radians(latitude2 - latitude1);
  const longitudeDelta = radians(longitude2 - longitude1);
  const haversine = Math.sin(latitudeDelta / 2) ** 2
    + Math.cos(radians(latitude1)) * Math.cos(radians(latitude2)) * Math.sin(longitudeDelta / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(Math.min(1, Math.max(0, haversine))));
}
