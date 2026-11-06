import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createDistrictAttributor, loadAnkaraDistrictAttributor, ANKARA_DISTRICTS_PATH,
  type DistrictAttribution, type DistrictFeatureCollection } from "./districts.ts";
import { ANKARA_DISTRICT_SHAPES, DISTRICT_SOURCE } from "./extract-districts.ts";

const square = (w: number, s: number, e: number, n: number) => [[w, s], [e, s], [e, n], [w, n], [w, s]] as [number, number][];
const reason = (result: DistrictAttribution) => (result.status === "unknown" ? result.reason : null);
const fixture = { type: "FeatureCollection", features: [
  { type: "Feature", properties: { district: "West" }, geometry: { type: "Polygon", coordinates: [square(0, 0, 1, 1)] } },
  { type: "Feature", properties: { district: "East" }, geometry: { type: "Polygon", coordinates: [square(1, 0, 2, 1)] } },
  { type: "Feature", properties: { district: "Ring" }, geometry: { type: "Polygon",
    coordinates: [square(10, 10, 14, 14), square(11, 11, 13, 13)] } },
  { type: "Feature", properties: { district: "Islands" }, geometry: { type: "MultiPolygon",
    coordinates: [[square(20, 20, 21, 21)], [square(22, 20, 23, 21)]] } },
  { type: "Feature", properties: { district: "OverlapA" }, geometry: { type: "Polygon", coordinates: [square(30, 30, 32, 32)] } },
  { type: "Feature", properties: { district: "OverlapB" }, geometry: { type: "Polygon", coordinates: [square(31, 31, 33, 33)] } },
] } as unknown as DistrictFeatureCollection;

test("a coordinate clearly inside one polygon is attributed to it", () => {
  const attributor = createDistrictAttributor(fixture);
  assert.deepEqual(attributor.attribute(0.5, 0.5), { status: "district", district: "West" });
  assert.deepEqual(attributor.attribute(0.5, 1.5), { status: "district", district: "East" });
  // MultiPolygon parts and the area of a polygon outside its hole both count.
  assert.deepEqual(attributor.attribute(20.5, 22.5), { status: "district", district: "Islands" });
  assert.deepEqual(attributor.attribute(10.5, 10.5), { status: "district", district: "Ring" });
});

test("shared edges, vertices, holes, overlaps and outside points are explicit unknowns", () => {
  const attributor = createDistrictAttributor(fixture);
  assert.deepEqual(attributor.attribute(0.5, 1), { status: "unknown", district: null, reason: "on_district_boundary",
    candidates: ["East", "West"] });
  assert.deepEqual(attributor.attribute(1, 1), { status: "unknown", district: null, reason: "on_district_boundary",
    candidates: ["East", "West"] });
  assert.deepEqual(attributor.attribute(0, 0.5), { status: "unknown", district: null, reason: "on_district_boundary",
    candidates: ["West"] });
  assert.equal(reason(attributor.attribute(12, 11)), "on_district_boundary"); // hole edge
  assert.deepEqual(attributor.attribute(12, 12), { status: "unknown", district: null, reason: "outside_district_dataset" });
  assert.deepEqual(attributor.attribute(20.5, 21.5), { status: "unknown", district: null, reason: "outside_district_dataset" });
  assert.deepEqual(attributor.attribute(31.5, 31.5), { status: "unknown", district: null, reason: "overlapping_districts",
    candidates: ["OverlapA", "OverlapB"] });
  for (const [lat, lon] of [[Number.NaN, 0], [91, 0], [0, 181], [0, Number.POSITIVE_INFINITY]]) {
    assert.equal(reason(attributor.attribute(lat, lon)), "invalid_coordinate");
  }
});

test("invalid district datasets are rejected rather than repaired", () => {
  const open = structuredClone(fixture) as unknown as { features: { geometry: { coordinates: number[][][] } }[] };
  open.features[0].geometry.coordinates[0].pop();
  assert.throws(() => createDistrictAttributor(open as unknown as DistrictFeatureCollection), /Invalid ring/);
  const duplicate = { ...fixture, features: [fixture.features[0], fixture.features[0]] };
  assert.throws(() => createDistrictAttributor(duplicate), /unique/);
  const point = { ...fixture, features: [{ ...fixture.features[0], geometry: { type: "Point", coordinates: [0, 0] } }] };
  assert.throws(() => createDistrictAttributor(point as unknown as DistrictFeatureCollection), /Unsupported geometry/);
});

test("the committed Ankara dataset is the pinned, licensed geoBoundaries extract", () => {
  const collection = JSON.parse(readFileSync(ANKARA_DISTRICTS_PATH, "utf8")) as {
    provenance: Record<string, unknown>; features: { properties: { shapeID: string; district: string } }[] };
  assert.equal(collection.provenance.sha256, DISTRICT_SOURCE.sha256);
  assert.equal(collection.provenance.commit, DISTRICT_SOURCE.commit);
  assert.match(String(collection.provenance.license), /ODbL-1\.0/);
  assert.match(String(collection.provenance.attribution), /OpenStreetMap contributors/);
  assert.deepEqual(Object.fromEntries(collection.features.map(f => [f.properties.shapeID, f.properties.district])),
    ANKARA_DISTRICT_SHAPES);
  assert.equal(loadAnkaraDistrictAttributor().districts.length, 25);
});

test("real Ankara coordinates resolve to their districts; outside and shared-vertex points do not", () => {
  const attributor = loadAnkaraDistrictAttributor();
  const district = (lat: number, lon: number) => attributor.attribute(lat, lon).district;
  assert.equal(district(39.9208, 32.8541), "Çankaya"); // Kızılay
  assert.equal(district(39.9416, 32.8549), "Altındağ"); // Ulus
  assert.equal(district(39.5776, 32.1462), "Polatlı");
  assert.equal(district(39.8468, 33.5153), null); // Kırıkkale
  assert.equal(reason(attributor.attribute(39.7767, 30.5206)), "outside_district_dataset"); // Eskişehir
  // Every vertex shared by two neighbouring districts lies on both boundaries.
  const collection = JSON.parse(readFileSync(ANKARA_DISTRICTS_PATH, "utf8")) as DistrictFeatureCollection;
  const flat = (name: string) => {
    const geometry = collection.features.find(f => f.properties.district === name)!.geometry;
    const polygons = (geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates) as unknown as number[][][][];
    return new Set(polygons.flat(2).map(p => `${p[0]},${p[1]}`));
  };
  const shared = [...flat("Çankaya")].find(p => flat("Gölbaşı").has(p));
  assert.ok(shared, "Çankaya and Gölbaşı share boundary vertices");
  const [lon, lat] = shared.split(",").map(Number);
  const result = attributor.attribute(lat, lon);
  assert.equal(reason(result), "on_district_boundary");
  assert.ok(result.status === "unknown" && result.candidates?.includes("Çankaya") && result.candidates.includes("Gölbaşı"));
  // The committed extract is byte-stable (regenerate with extract-districts.ts).
  assert.equal(createHash("sha256").update(readFileSync(ANKARA_DISTRICTS_PATH)).digest("hex"),
    "edae5c78b50ce9dde76f1e08cdcdf2820f7cb79f67775f4d9fc30b4dc1da220c");
});
