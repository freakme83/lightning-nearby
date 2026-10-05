import type { Box } from "../live-lightning-listener/core.ts";

/** GeoJSON position order: [longitude, latitude]. This is operational coverage, not an administrative boundary. */
export type GeoPosition = readonly [longitude: number, latitude: number];
export type MonitoringArea = {
  id: string;
  polygon: readonly GeoPosition[];
  bounds: Box;
};

export const ANKARA_MONITORING_POLYGON: readonly GeoPosition[] = [
  [31.1620047, 40.4361963],
  [32.58044, 40.792556],
  [33.8272463, 40.7734459],
  [33.5597124, 39.880671],
  [33.489043, 39.3752565],
  [33.9332503, 39.0506402],
  [33.7919116, 38.6575458],
  [33.3275159, 38.6614868],
  [33.0801732, 38.9211586],
  [32.2927124, 38.956496],
  [32.0605131, 38.9290136],
  [30.8995164, 39.6867178],
  [30.7733215, 40.2052809],
  [31.1620047, 40.4361963],
];

export function boundingBoxForPolygon(polygon: readonly GeoPosition[]): Box {
  if (polygon.length < 4) throw new Error("polygon must have at least four positions");
  const longitudes = polygon.map(([longitude]) => longitude);
  const latitudes = polygon.map(([, latitude]) => latitude);
  if (polygon.some(([longitude, latitude]) => !Number.isFinite(longitude) || !Number.isFinite(latitude) ||
      longitude < -180 || longitude > 180 || latitude < -90 || latitude > 90)) {
    throw new Error("polygon contains invalid longitude/latitude");
  }
  return {
    north: Math.max(...latitudes),
    east: Math.max(...longitudes),
    south: Math.min(...latitudes),
    west: Math.min(...longitudes),
  };
}

export const ANKARA_MONITORING_AREA: MonitoringArea = {
  id: "ankara",
  polygon: ANKARA_MONITORING_POLYGON,
  bounds: boundingBoxForPolygon(ANKARA_MONITORING_POLYGON),
};

function pointOnSegment(point: GeoPosition, start: GeoPosition, end: GeoPosition): boolean {
  const [x, y] = point;
  const [x1, y1] = start;
  const [x2, y2] = end;
  const cross = (x - x1) * (y2 - y1) - (y - y1) * (x2 - x1);
  const scale = Math.max(1, Math.abs(x), Math.abs(y), Math.abs(x1), Math.abs(y1), Math.abs(x2), Math.abs(y2));
  const epsilon = Number.EPSILON * scale * scale * 16;
  if (Math.abs(cross) > epsilon) return false;
  return x >= Math.min(x1, x2) - epsilon && x <= Math.max(x1, x2) + epsilon &&
    y >= Math.min(y1, y2) - epsilon && y <= Math.max(y1, y2) + epsilon;
}

/** Planar ray casting in GeoJSON [longitude, latitude] order; edge and vertex points count as inside. */
export function pointInPolygon(point: GeoPosition, polygon: readonly GeoPosition[]): boolean {
  const [longitude, latitude] = point;
  if (!Number.isFinite(longitude) || !Number.isFinite(latitude) || polygon.length < 4) return false;
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[j];
    const b = polygon[i];
    if (pointOnSegment(point, a, b)) return true;
    const [ax, ay] = a;
    const [bx, by] = b;
    if ((ay > latitude) !== (by > latitude) &&
        longitude < ((bx - ax) * (latitude - ay)) / (by - ay) + ax) inside = !inside;
  }
  return inside;
}

export function pointInMonitoringArea(point: GeoPosition, area: MonitoringArea = ANKARA_MONITORING_AREA): boolean {
  return pointInPolygon(point, area.polygon);
}
