export const MAX_COMPARISON_RADIUS_KM = 150;
export const MAX_OBSERVER_DURATION_MINUTES = 60;

const EARTH_RADIUS_KM = 6_371.0088;
const DECIMAL_NUMBER = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/;

export type ComparisonArea =
  | { mode: "ankara" }
  | { mode: "custom-radius"; centerLat: number; centerLon: number; radiusKm: number };

export type ObserverRunOptions = {
  comparisonArea: ComparisonArea;
  durationMinutes: number | null;
};

export type GeographicBounds = { north: number; east: number; south: number; west: number };

function parseNumber(name: string, raw: string): number {
  if (!DECIMAL_NUMBER.test(raw)) throw new Error(`${name} must be a finite decimal number`);
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`${name} must be a finite decimal number`);
  return value;
}

export function parseObserverArgs(args: readonly string[]): ObserverRunOptions {
  const values = new Map<string, string>();
  const allowed = new Set(["center-lat", "center-lon", "radius-km", "duration"]);
  for (const arg of args) {
    const match = /^--([a-z-]+)=(.*)$/.exec(arg);
    if (!match || !allowed.has(match[1])) throw new Error(`invalid observer argument: ${arg.split("=", 1)[0]}`);
    if (values.has(match[1])) throw new Error(`duplicate observer argument: --${match[1]}`);
    values.set(match[1], match[2]);
  }

  const areaKeys = ["center-lat", "center-lon", "radius-km"];
  const suppliedAreaKeys = areaKeys.filter(key => values.has(key));
  let comparisonArea: ComparisonArea = { mode: "ankara" };
  if (suppliedAreaKeys.length > 0 && suppliedAreaKeys.length !== areaKeys.length) {
    throw new Error("custom comparison area requires --center-lat, --center-lon, and --radius-km");
  }
  if (suppliedAreaKeys.length === areaKeys.length) {
    const centerLat = parseNumber("center-lat", values.get("center-lat")!);
    const centerLon = parseNumber("center-lon", values.get("center-lon")!);
    const radiusKm = parseNumber("radius-km", values.get("radius-km")!);
    if (centerLat < -90 || centerLat > 90) throw new Error("center-lat must be between -90 and 90");
    if (centerLon < -180 || centerLon > 180) throw new Error("center-lon must be between -180 and 180");
    if (radiusKm <= 0 || radiusKm > MAX_COMPARISON_RADIUS_KM) {
      throw new Error(`radius-km must be greater than 0 and no more than ${MAX_COMPARISON_RADIUS_KM}`);
    }
    comparisonArea = { mode: "custom-radius", centerLat, centerLon, radiusKm };
  }

  const durationRaw = values.get("duration");
  let durationMinutes: number | null = null;
  if (durationRaw !== undefined) {
    const duration = parseNumber("duration", durationRaw);
    if (!Number.isSafeInteger(duration) || duration < 1 || duration > MAX_OBSERVER_DURATION_MINUTES) {
      throw new Error(`duration must be a whole number from 1 to ${MAX_OBSERVER_DURATION_MINUTES} minutes`);
    }
    durationMinutes = duration;
  }
  return { comparisonArea, durationMinutes };
}

export function comparisonAreaMetadata(area: ComparisonArea): Record<string, string | number> {
  if (area.mode === "ankara") return { comparisonAreaMode: "ankara" };
  return {
    comparisonAreaMode: "custom-radius",
    comparisonCenterLat: area.centerLat,
    comparisonCenterLon: area.centerLon,
    comparisonRadiusKm: area.radiusKm,
  };
}

export function comparisonAreaSubscriptionBounds(
  area: ComparisonArea,
  ankaraBounds: GeographicBounds,
): GeographicBounds {
  if (area.mode === "ankara") return ankaraBounds;
  const angularRadiusDegrees = area.radiusKm / EARTH_RADIUS_KM * 180 / Math.PI;
  const north = Math.min(90, area.centerLat + angularRadiusDegrees);
  const south = Math.max(-90, area.centerLat - angularRadiusDegrees);
  const crossesPole = Math.abs(area.centerLat) + angularRadiusDegrees >= 90;
  const maxAbsoluteLatitude = Math.max(Math.abs(north), Math.abs(south));
  const cosine = Math.cos(maxAbsoluteLatitude * Math.PI / 180);
  const longitudeDelta = crossesPole || cosine <= 0
    ? 180
    : Math.min(180, angularRadiusDegrees / cosine);
  let west = area.centerLon - longitudeDelta;
  let east = area.centerLon + longitudeDelta;
  if (west < -180 || east > 180) {
    west = -180;
    east = 180;
  }
  return { north, east, south, west };
}

export function isInsideCustomRadius(
  latitude: number,
  longitude: number,
  area: Extract<ComparisonArea, { mode: "custom-radius" }>,
): boolean {
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude) ||
      latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) return false;
  const radians = (degrees: number) => degrees * Math.PI / 180;
  const lat1 = radians(area.centerLat);
  const lat2 = radians(latitude);
  const deltaLat = lat2 - lat1;
  const deltaLon = radians(longitude - area.centerLon);
  const a = Math.sin(deltaLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLon / 2) ** 2;
  const boundedA = Math.min(1, Math.max(0, a));
  const distanceKm = 2 * EARTH_RADIUS_KM * Math.atan2(Math.sqrt(boundedA), Math.sqrt(1 - boundedA));
  return distanceKm <= area.radiusKm;
}

export function isInsideComparisonArea(
  area: ComparisonArea,
  latitude: number,
  longitude: number,
  insideAnkaraPolygon: boolean,
): boolean {
  return area.mode === "ankara"
    ? insideAnkaraPolygon
    : isInsideCustomRadius(latitude, longitude, area);
}
