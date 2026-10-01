import assert from "node:assert/strict";
import test from "node:test";
import { parseCoordinateQuery, parsePlaceResults, searchPlaces, visiblePlaceResults, type PlaceResult } from "./geocoding.ts";

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

function place(label: string, metadata: Partial<PlaceResult> = {}): PlaceResult {
  return { latitude: 39.9, longitude: 32.8, label, source: "search", ...metadata };
}

test("parses Open-Meteo admin1 through admin4 as search-only context metadata", () => {
  const results = parsePlaceResults({ results: [{
    name: "Belde", latitude: 39.9, longitude: 32.8,
    admin1: "Region 1", admin2: "Region 2", admin3: "Region 3", admin4: "Region 4", country: "Country",
  }] });
  assert.deepEqual(results[0], {
    label: "Belde", latitude: 39.9, longitude: 32.8, source: "search",
    admin1: "Region 1", admin2: "Region 2", admin3: "Region 3", admin4: "Region 4", country: "Country",
  });
});

test("standard comma order finds a Belde result whose administrative context is Batman", async () => {
  const beldeInBatman = place("Belde", { admin2: "Batman", country: "Türkiye" });
  const calls: string[] = [];
  const result = await searchPlaces("Belde, Batman", undefined, async (query) => {
    calls.push(query);
    return query === "Belde" ? [beldeInBatman] : [];
  });
  assert.deepEqual(calls, ["Belde, Batman", "Belde", "Batman"]);
  assert.deepEqual(result.results, [beldeInBatman]);
});

test("reversed comma order finds the same context-matched Belde result", async () => {
  const beldeInBatman = place("Belde", { admin2: "Batman", country: "Türkiye" });
  const calls: string[] = [];
  const result = await searchPlaces("Batman, Belde", undefined, async (query) => {
    calls.push(query);
    return query === "Belde" ? [beldeInBatman] : [];
  });
  assert.deepEqual(calls, ["Batman, Belde", "Batman", "Belde"]);
  assert.deepEqual(result.results, [beldeInBatman]);
});

test("context matching checks every administrative level, country, case and diacritics", async () => {
  for (const field of ["admin1", "admin2", "admin3", "admin4", "country"] as const) {
    const intended = place("Belde", { [field]: "München District" });
    const result = await searchPlaces("Belde, MUNCHEN", undefined, async (query) => query === "Belde" ? [intended] : []);
    assert.deepEqual(result.results, [intended], `${field} should be searchable context`);
  }
});

test("unrelated same-named places are not returned as an exact contextual match", async () => {
  const unrelated = place("Belde", { admin2: "Diyarbakır", country: "Türkiye" });
  const result = await searchPlaces("Batman, Belde", undefined, async (query) => query === "Belde" ? [unrelated] : []);
  assert.deepEqual(result.results, []);
  assert.match(result.fallbackMessage ?? "", /No exact combined match found/);
});

test("non-comma searches retain the full-query result behavior", async () => {
  const batman = place("Batman", { admin1: "Batman", country: "Türkiye" });
  const belde = place("Belde", { admin2: "Batman", country: "Türkiye" });
  for (const [query, expected] of [["Batman", batman], ["Belde", belde]] as const) {
    const calls: string[] = [];
    const result = await searchPlaces(query, undefined, async (value) => { calls.push(value); return [expected]; });
    assert.deepEqual(calls, [query]);
    assert.deepEqual(result.results, [expected]);
  }
});

test("repeated normalized comma tokens do not cause duplicate lookup requests", async () => {
  const calls: string[] = [];
  await searchPlaces("Belde, BÉLDE, Belde", undefined, async (query) => { calls.push(query); return []; });
  assert.deepEqual(calls, ["Belde, BÉLDE, Belde", "Belde"]);
});

test("aborted fallback stops before looking up the next comma term", async () => {
  const controller = new AbortController();
  const calls: string[] = [];
  await assert.rejects(searchPlaces("Batman, Belde", controller.signal, async (query) => {
    calls.push(query);
    if (query === "Batman, Belde") return [];
    controller.abort();
    return [];
  }), { name: "AbortError" });
  assert.deepEqual(calls, ["Batman, Belde", "Batman"]);
});

test("show more reveals already-fetched results without another lookup", () => {
  const results = Array.from({ length: 8 }, (_, index) => place(`Place ${index}`));
  assert.equal(visiblePlaceResults(results, false).length, 5);
  assert.deepEqual(visiblePlaceResults(results, true), results);
});
