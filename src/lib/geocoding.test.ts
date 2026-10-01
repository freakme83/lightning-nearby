import assert from "node:assert/strict";
import test from "node:test";
import { parseCoordinateQuery } from "./geocoding.ts";

test("parses a complete latitude and longitude pair", () => {
  assert.deepEqual(parseCoordinateQuery("23.4056, 26.8215"), {
    kind: "coordinates", latitude: 23.4056, longitude: 26.8215,
  });
  assert.deepEqual(parseCoordinateQuery("23.4056,26.8215"), {
    kind: "coordinates", latitude: 23.4056, longitude: 26.8215,
  });
  assert.deepEqual(parseCoordinateQuery(" 23.4056 , 26.8215 "), {
    kind: "coordinates", latitude: 23.4056, longitude: 26.8215,
  });
});

test("parses negative coordinate values", () => {
  assert.deepEqual(parseCoordinateQuery("-23.4056, 26.8215"), {
    kind: "coordinates", latitude: -23.4056, longitude: 26.8215,
  });
  assert.deepEqual(parseCoordinateQuery("23.4056, -26.8215"), {
    kind: "coordinates", latitude: 23.4056, longitude: -26.8215,
  });
});

test("accepts latitude and longitude boundary values", () => {
  assert.deepEqual(parseCoordinateQuery("90, 180"), { kind: "coordinates", latitude: 90, longitude: 180 });
  assert.deepEqual(parseCoordinateQuery("-90, -180"), { kind: "coordinates", latitude: -90, longitude: -180 });
});

test("rejects numeric coordinate pairs outside latitude or longitude ranges", () => {
  assert.deepEqual(parseCoordinateQuery("90.0001, 0"), { kind: "invalid" });
  assert.deepEqual(parseCoordinateQuery("-90.0001, 0"), { kind: "invalid" });
  assert.deepEqual(parseCoordinateQuery("0, 180.0001"), { kind: "invalid" });
  assert.deepEqual(parseCoordinateQuery("0, -180.0001"), { kind: "invalid" });
});

test("does not treat place names as coordinate input", () => {
  assert.deepEqual(parseCoordinateQuery("Athens, Greece"), { kind: "not-coordinate" });
});

test("rejects malformed numeric coordinate pairs", () => {
  assert.deepEqual(parseCoordinateQuery("23.40.56, 26.8215"), { kind: "invalid" });
  assert.deepEqual(parseCoordinateQuery("23e5, 26.8215"), { kind: "invalid" });
});
