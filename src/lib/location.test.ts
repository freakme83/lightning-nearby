import assert from "node:assert/strict";
import test from "node:test";
import { LOCATION_STORAGE_KEY, formatLocationLabel, parseMonitoredLocation, reduceLocationPrecision, saveMonitoredLocation } from "./location.ts";
import { parsePlaceResults } from "./geocoding.ts";

function memoryStorage(initial?: string) {
  let value = initial ?? null;
  return {
    setItem: (_key: string, next: string) => { value = next; },
    get value() { return value; },
  };
}

test("searched locations save coordinates with optional place metadata and source", () => {
  const storage = memoryStorage();
  const saved = saveMonitoredLocation(storage, {
    latitude: 39.93342, longitude: 32.85971, label: "Ankara", country: "Türkiye", admin1: "Ankara", source: "search",
  }, 123);
  assert.deepEqual(saved, { latitude: 39.9334, longitude: 32.8597, savedAt: 123, label: "Ankara", country: "Türkiye", admin1: "Ankara", source: "search" });
  assert.equal(JSON.parse(storage.value ?? "null").source, "search");
  assert.equal(formatLocationLabel(saved!), "Ankara, Türkiye");
});

test("map-selected location saves without fabricated place metadata", () => {
  const storage = memoryStorage();
  const saved = saveMonitoredLocation(storage, { latitude: 52.52004, longitude: 13.40495, source: "map" }, 456);
  assert.deepEqual(saved, { latitude: 52.52, longitude: 13.405, savedAt: 456, source: "map" });
  assert.equal(formatLocationLabel(saved!), "52.52° N, 13.40° E");
});

test("legacy coordinate-only stored locations reload unchanged", () => {
  const legacy = { latitude: 41.0082, longitude: 28.9784, savedAt: 789 };
  assert.deepEqual(parseMonitoredLocation(legacy), legacy);
  const extended = { ...legacy, label: "Istanbul", country: "Türkiye", source: "search" };
  assert.deepEqual(parseMonitoredLocation(JSON.parse(JSON.stringify(extended))), extended);
});

test("cancelled candidate does not overwrite the persisted monitored location", () => {
  const original = { latitude: 52.52, longitude: 13.405, savedAt: 100, label: "Berlin", source: "search" };
  const storage = memoryStorage(JSON.stringify(original));
  assert.equal(saveMonitoredLocation(storage, null, 200), null);
  assert.equal(storage.value, JSON.stringify(original));
});

test("precision retains four decimals and rejects invalid coordinates", () => {
  assert.deepEqual(reduceLocationPrecision(-33.868812, 151.209291), { latitude: -33.8688, longitude: 151.2093 });
  assert.equal(parseMonitoredLocation({ latitude: 91, longitude: 0, savedAt: 1 }), null);
  assert.equal(parseMonitoredLocation({ latitude: 0, longitude: 181, savedAt: 1 }), null);
});

test("malformed and partial geocoding rows are ignored safely", () => {
  const results = parsePlaceResults({ results: [
    { name: "Ankara", latitude: 39.9334, longitude: 32.8597, country: "Türkiye", admin1: "Ankara" },
    { name: "Berlin", latitude: 52.52, longitude: 13.405 },
    { name: "Bad latitude", latitude: 91, longitude: 10 },
    { name: "No longitude", latitude: 40 },
    { name: "   ", latitude: 40, longitude: 20 },
    null,
  ] });
  assert.deepEqual(results.map(({ label, country, admin1 }) => ({ label, country, admin1 })), [
    { label: "Ankara", country: "Türkiye", admin1: "Ankara" },
    { label: "Berlin", country: undefined, admin1: undefined },
  ]);
  assert.equal(LOCATION_STORAGE_KEY, "lightning-nearby.location.v1");
  assert.deepEqual(parsePlaceResults({ results: "not-an-array" }), []);
});
