// Deterministic point-in-district attribution against real administrative polygons.
// No nearest-centre, buffer, bounding-box or network fallback exists: anything that
// cannot be established geometrically is reported as an explicit unknown.
import { readFileSync } from "node:fs";

type Position = readonly [longitude: number, latitude: number];
type Ring = readonly Position[];
type PolygonRings = readonly Ring[];
export type DistrictGeometry =
  | { type: "Polygon"; coordinates: PolygonRings }
  | { type: "MultiPolygon"; coordinates: readonly PolygonRings[] };
export type DistrictFeatureCollection = {
  type: "FeatureCollection";
  provenance?: Record<string, unknown>;
  features: readonly { type: "Feature"; properties: { district: string }; geometry: DistrictGeometry }[];
};

export type UnknownDistrictReason =
  | "invalid_coordinate"
  | "outside_district_dataset"
  | "on_district_boundary"
  | "overlapping_districts";
export type DistrictAttribution =
  | { status: "district"; district: string }
  | { status: "unknown"; district: null; reason: UnknownDistrictReason; candidates?: string[] };
export type DistrictAttributor = {
  attribute(latitude: number, longitude: number): DistrictAttribution;
  districts: readonly string[];
  provenance: Record<string, unknown>;
};

type Relation = "inside" | "boundary" | "outside";
type PreparedDistrict = { name: string; polygons: { bounds: [number, number, number, number]; rings: Ring[] }[] };

export const compareCodePoints = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function onSegment(x: number, y: number, [x1, y1]: Position, [x2, y2]: Position): boolean {
  const cross = (x - x1) * (y2 - y1) - (y - y1) * (x2 - x1);
  const scale = Math.max(1, Math.abs(x), Math.abs(y), Math.abs(x1), Math.abs(y1), Math.abs(x2), Math.abs(y2));
  const epsilon = Number.EPSILON * scale * scale * 16;
  if (Math.abs(cross) > epsilon) return false;
  return x >= Math.min(x1, x2) - epsilon && x <= Math.max(x1, x2) + epsilon &&
    y >= Math.min(y1, y2) - epsilon && y <= Math.max(y1, y2) + epsilon;
}

/** Planar even-odd test in GeoJSON [lon, lat] order (RFC 7946 straight edges). */
function ringRelation(x: number, y: number, ring: Ring): Relation {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];
    if (onSegment(x, y, a, b)) return "boundary";
    if ((a[1] > y) !== (b[1] > y) && x < ((b[0] - a[0]) * (y - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside ? "inside" : "outside";
}

function polygonRelation(x: number, y: number, rings: Ring[]): Relation {
  const outer = ringRelation(x, y, rings[0]);
  if (outer !== "inside") return outer;
  for (const hole of rings.slice(1)) {
    const relation = ringRelation(x, y, hole);
    if (relation === "boundary") return "boundary";
    if (relation === "inside") return "outside";
  }
  return "inside";
}

function validRing(ring: unknown): ring is Ring {
  if (!Array.isArray(ring) || ring.length < 4) return false;
  const valid = ring.every(position => Array.isArray(position) && position.length >= 2 &&
    Number.isFinite(position[0]) && Number.isFinite(position[1]) &&
    position[0] >= -180 && position[0] <= 180 && position[1] >= -90 && position[1] <= 90);
  const first = ring[0], last = ring[ring.length - 1];
  return valid && first[0] === last[0] && first[1] === last[1];
}

function prepare(collection: DistrictFeatureCollection): PreparedDistrict[] {
  if (collection?.type !== "FeatureCollection" || !Array.isArray(collection.features) || !collection.features.length) {
    throw new Error("District dataset must be a non-empty FeatureCollection");
  }
  const seen = new Set<string>();
  const districts = collection.features.map(feature => {
    const name = feature?.properties?.district;
    if (typeof name !== "string" || !name.trim() || seen.has(name)) throw new Error("District names must be unique");
    seen.add(name);
    const geometry = feature.geometry;
    const polygons: readonly PolygonRings[] | null = geometry?.type === "Polygon" ? [geometry.coordinates]
      : geometry?.type === "MultiPolygon" ? geometry.coordinates : null;
    if (!polygons?.length) throw new Error(`Unsupported geometry for ${name}`);
    return { name, polygons: polygons.map(rings => {
      if (!Array.isArray(rings) || !rings.length || !rings.every(validRing)) throw new Error(`Invalid ring in ${name}`);
      const outer = rings[0];
      return { rings: [...rings], bounds: [Math.min(...outer.map(p => p[0])), Math.min(...outer.map(p => p[1])),
        Math.max(...outer.map(p => p[0])), Math.max(...outer.map(p => p[1]))] as [number, number, number, number] };
    }) };
  });
  return districts.sort((a, b) => compareCodePoints(a.name, b.name));
}

export function createDistrictAttributor(collection: DistrictFeatureCollection): DistrictAttributor {
  const districts = prepare(collection);
  return {
    districts: districts.map(district => district.name),
    provenance: { ...(collection.provenance ?? {}) },
    attribute(latitude, longitude) {
      if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || latitude < -90 || latitude > 90 ||
          longitude < -180 || longitude > 180) return { status: "unknown", district: null, reason: "invalid_coordinate" };
      const inside: string[] = [], boundary: string[] = [];
      for (const district of districts) {
        let relation: Relation = "outside";
        for (const polygon of district.polygons) {
          const [west, south, east, north] = polygon.bounds;
          if (longitude < west || longitude > east || latitude < south || latitude > north) continue;
          const current = polygonRelation(longitude, latitude, polygon.rings);
          if (current === "boundary") { relation = "boundary"; break; }
          if (current === "inside") relation = "inside";
        }
        if (relation === "inside") inside.push(district.name);
        else if (relation === "boundary") boundary.push(district.name);
      }
      // A coordinate exactly on any edge (shared border, hole edge, outer edge) is never
      // assigned. Overlapping polygons are never resolved by preference.
      if (boundary.length) {
        return { status: "unknown", district: null, reason: "on_district_boundary",
          candidates: [...inside, ...boundary].sort(compareCodePoints) };
      }
      if (inside.length > 1) return { status: "unknown", district: null, reason: "overlapping_districts", candidates: inside };
      if (inside.length === 1) return { status: "district", district: inside[0] };
      return { status: "unknown", district: null, reason: "outside_district_dataset" };
    },
  };
}

export const ANKARA_DISTRICTS_PATH = new URL("./data/ankara-districts.geojson", import.meta.url);

export function loadAnkaraDistrictAttributor(): DistrictAttributor {
  const collection = JSON.parse(readFileSync(ANKARA_DISTRICTS_PATH, "utf8")) as DistrictFeatureCollection;
  const attributor = createDistrictAttributor(collection);
  if (attributor.districts.length !== 25) throw new Error("Ankara district dataset must contain 25 districts");
  return attributor;
}
