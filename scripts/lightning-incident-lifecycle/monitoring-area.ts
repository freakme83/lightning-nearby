import type { Box } from "../live-lightning-listener/core.ts";

/** GeoJSON position order: [longitude, latitude]. This is operational coverage, not an administrative boundary. */
export type GeoPosition = readonly [longitude: number, latitude: number];
export type MonitoringArea = {
  id: string;
  polygon: readonly GeoPosition[];
  bounds: Box;
};

export const ANKARA_MONITORING_POLYGON: readonly GeoPosition[] = [
  [32.1754558, 38.9451017],
  [32.0198391, 38.9531338],
  [31.7947497, 39.1602879],
  [31.9559242, 39.2378138],
  [31.9781551, 39.4548602],
  [31.786414, 39.6626755],
  [31.508527, 40.008359],
  [31.1667252, 40.0253849],
  [30.9055115, 40.0168726],
  [30.7776843, 40.140197],
  [31.0853068, 40.3777283],
  [31.2962999, 40.364259],
  [31.4084872, 40.3950747],
  [31.4890741, 40.3209611],
  [31.8558849, 40.3357904],
  [32.144056, 40.5589686],
  [32.3509888, 40.6121124],
  [32.5760772, 40.7974935],
  [32.7400306, 40.7427755],
  [32.8623008, 40.6479649],
  [33.0401485, 40.5192285],
  [33.2013229, 40.4325616],
  [33.3124777, 40.449481],
  [33.4819887, 40.3965937],
  [33.786368, 40.3095417],
  [33.530712, 40.0186073],
  [33.2806137, 39.7054589],
  [33.6001837, 39.2937638],
  [33.9197537, 39.0457918],
  [33.850282, 38.9702148],
  [33.7696948, 38.9550897],
  [33.8391665, 38.8837422],
  [33.764137, 38.7690038],
  [33.722454, 38.6497402],
  [33.380653, 38.6757783],
  [33.2583829, 39.0573729],
  [33.1500068, 39.12639],
  [33.124997, 39.221178],
  // Local southern-edge kink keeps the approximate Altılar/Kulu CG point outside.
  [32.965, 39.179],
  [32.8924042, 39.1495134],
  [32.5200356, 38.9747407],
  [32.1754558, 38.9451017],
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
