import assert from "node:assert/strict";
import test from "node:test";
import { LOCATION_STORAGE_KEY, formatLocationLabel, parseMonitoredLocation, reduceLocationPrecision, saveMonitoredLocation } from "./location.ts";
import { MIN_PLACE_QUERY_LENGTH, PLACE_SEARCH_DEBOUNCE_MS, parsePlaceResults, parseReversePlace, reverseGeocodeLocation, searchPlaces, type PlaceResult } from "./geocoding.ts";

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

const place = (label: string, admin1?: string, country?: string): PlaceResult => ({
  latitude: 39.9, longitude: 32.8, label, admin1, country, source: "search",
});

test("search waits for a useful query length and uses a bounded type-ahead delay", () => {
  assert.equal(MIN_PLACE_QUERY_LENGTH, 3);
  assert.equal(PLACE_SEARCH_DEBOUNCE_MS, 400);
});

test("multipart search falls back to the broader context instead of unrelated same-name places", async () => {
  const calls: string[] = [];
  const lookup = async (query: string) => {
    calls.push(query);
    if (query === "Ayrancı") return [place("Ayrancı", "İzmir", "Türkiye"), place("Ayrancı", "Konya", "Türkiye")];
    if (query === "Ankara") return [place("Ankara", "Ankara", "Türkiye")];
    return [];
  };
  const result = await searchPlaces("Ayrancı, Ankara", undefined, lookup);
  assert.deepEqual(calls, ["Ayrancı, Ankara", "Ayrancı", "Ankara"]);
  assert.deepEqual(result.results.map(({ label }) => label), ["Ankara"]);
  assert.match(result.fallbackMessage ?? "", /broader place “Ankara”/);
});

test("multipart search keeps a first-component result when its context matches", async () => {
  const lookup = async (query: string) => query === "Ayrancı"
    ? [place("Ayrancı", "Ankara", "Türkiye"), place("Ayrancı", "İzmir", "Türkiye")]
    : [];
  const result = await searchPlaces("Ayrancı, Ankara", undefined, lookup);
  assert.deepEqual(result.results.map(({ admin1 }) => admin1), ["Ankara"]);
});

test("superseded search results are rejected even if a lookup ignores abort", async () => {
  const controller = new AbortController();
  const pending = searchPlaces("Berlin", controller.signal, async () => {
    await Promise.resolve();
    return [place("Berlin", "Berlin", "Germany")];
  });
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
});

test("reverse-geocoding metadata is compact and handles varying address fields", () => {
  assert.deepEqual(parseReversePlace({ address: {
    suburb: "Atakum", city: "Samsun", state: "Samsun Province", country: "Türkiye",
  } }), { label: "Atakum", admin1: "Samsun Province", country: "Türkiye" });
  assert.deepEqual(parseReversePlace({ address: { town: "Kefalos", country: "Greece" } }), { label: "Kefalos", country: "Greece" });
});

test("malformed reverse-geocoding responses safely produce no label", () => {
  assert.equal(parseReversePlace(null), null);
  assert.equal(parseReversePlace({ address: "not-an-object" }), null);
  assert.equal(parseReversePlace({ address: { road: "Unnamed Road" } }), null);
});

test("reverse geocoding failure is optional and requests retain the authoritative coordinates", async () => {
  let requestedUrl = "";
  const unavailable = await reverseGeocodeLocation(41.27, 36.36, undefined, async (input) => {
    requestedUrl = String(input);
    return new Response("unavailable", { status: 503 });
  });
  assert.equal(unavailable, null);
  const parsedUrl = new URL(requestedUrl);
  assert.equal(parsedUrl.searchParams.get("lat"), "41.27");
  assert.equal(parsedUrl.searchParams.get("lon"), "36.36");

  const storage = memoryStorage();
  const saved = saveMonitoredLocation(storage, { latitude: 41.27004, longitude: 36.35996, source: "map" }, 99);
  assert.deepEqual(saved, { latitude: 41.27, longitude: 36.36, savedAt: 99, source: "map" });
});

test("successfully resolved map metadata persists while selected coordinates remain authoritative", async () => {
  const metadata = await reverseGeocodeLocation(41.27004, 36.35996, undefined, async () => new Response(JSON.stringify({
    address: { suburb: "Atakum", state: "Samsun", country: "Türkiye" },
  }), { status: 200, headers: { "content-type": "application/json" } }));
  assert.deepEqual(metadata, { label: "Atakum", admin1: "Samsun", country: "Türkiye" });

  const storage = memoryStorage();
  const saved = saveMonitoredLocation(storage, {
    latitude: 41.27004, longitude: 36.35996, source: "map", ...metadata,
  }, 100);
  assert.equal(saved?.latitude, 41.27);
  assert.equal(saved?.longitude, 36.36);
  assert.equal(formatLocationLabel(saved!), "Atakum, Samsun, Türkiye");
  assert.deepEqual(parseMonitoredLocation(JSON.parse(storage.value ?? "null")), saved);
});
