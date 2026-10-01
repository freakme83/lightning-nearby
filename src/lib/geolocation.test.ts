import assert from "node:assert/strict";
import test from "node:test";
import { isCurrentGeolocationRequest, resolveGeolocationSelection } from "./geolocation.ts";
import { formatLocationLabel, saveMonitoredLocation } from "./location.ts";

function memoryStorage() {
  let value = "";
  return {
    setItem: (_key: string, next: string) => { value = next; },
    get value() { return value; },
  };
}

test("device coordinates are reduced before reverse lookup and keep locality metadata", async () => {
  const lookupCoordinates: number[] = [];
  const selection = await resolveGeolocationSelection(39.904812, 32.851245, undefined, async (latitude, longitude) => {
    lookupCoordinates.push(latitude, longitude);
    return { label: "Ayrancı", admin1: "Ankara", country: "Türkiye" };
  });

  assert.deepEqual(lookupCoordinates, [39.9048, 32.8512]);
  assert.deepEqual(selection, {
    latitude: 39.9048, longitude: 32.8512,
    label: "Ayrancı", admin1: "Ankara", country: "Türkiye", source: "geolocation",
  });
  assert.equal(formatLocationLabel(selection), "Ayrancı, Ankara, Türkiye");
});

test("city-style reverse metadata remains a useful label when locality detail is absent", async () => {
  const selection = await resolveGeolocationSelection(39.904812, 32.851245, undefined, async () => ({
    label: "Ankara", country: "Türkiye",
  }));
  assert.equal(formatLocationLabel(selection), "Ankara, Türkiye");
});

test("null reverse metadata still yields a coordinate-only device location", async () => {
  const selection = await resolveGeolocationSelection(39.904812, 32.851245, undefined, async () => null);
  assert.deepEqual(selection, { latitude: 39.9048, longitude: 32.8512, source: "geolocation" });
});

test("reverse lookup errors and timeouts do not prevent saving device coordinates", async () => {
  const failed = await resolveGeolocationSelection(39.904812, 32.851245, undefined, async () => {
    throw new Error("network unavailable");
  });
  const timedOut = await resolveGeolocationSelection(39.904812, 32.851245, undefined, (_latitude, _longitude, signal) => new Promise((_resolve, reject) => {
    signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
  }), 1);
  const storage = memoryStorage();
  const failedSaved = saveMonitoredLocation(storage, failed, 99);
  const saved = saveMonitoredLocation(storage, timedOut, 100);

  assert.deepEqual(failed, { latitude: 39.9048, longitude: 32.8512, source: "geolocation" });
  assert.deepEqual(failedSaved, { latitude: 39.9048, longitude: 32.8512, savedAt: 99, source: "geolocation" });
  assert.deepEqual(saved, { latitude: 39.9048, longitude: 32.8512, savedAt: 100, source: "geolocation" });
  assert.equal(formatLocationLabel(saved!), "39.90° N, 32.85° E");
});

test("null reverse metadata still saves the coordinate-only selection", async () => {
  const selection = await resolveGeolocationSelection(39.904812, 32.851245, undefined, async () => null);
  const saved = saveMonitoredLocation(memoryStorage(), selection, 102);
  assert.deepEqual(saved, { latitude: 39.9048, longitude: 32.8512, savedAt: 102, source: "geolocation" });
});

test("reverse metadata persists only fields supported by the monitored-location schema", async () => {
  const selection = await resolveGeolocationSelection(39.904812, 32.851245, undefined, async () => ({
    label: "Ayrancı", admin1: "Ankara", country: "Türkiye", timezone: "Europe/Istanbul",
  }));
  const storage = memoryStorage();
  const selectionWithSearchOnlyMetadata = { ...selection, admin2: "Ankara District", admin3: "Çankaya" };
  const saved = saveMonitoredLocation(storage, selectionWithSearchOnlyMetadata, 101);

  assert.deepEqual(saved, {
    latitude: 39.9048, longitude: 32.8512, savedAt: 101,
    label: "Ayrancı", admin1: "Ankara", country: "Türkiye", timezone: "Europe/Istanbul", source: "geolocation",
  });
  assert.equal(storage.value.includes("admin2"), false);
  assert.equal(storage.value.includes("admin3"), false);
});

test("stale or aborted geolocation enrichment cannot remain the current request", () => {
  const controller = new AbortController();
  assert.equal(isCurrentGeolocationRequest(4, 4, controller.signal), true);
  assert.equal(isCurrentGeolocationRequest(3, 4, controller.signal), false);
  controller.abort();
  assert.equal(isCurrentGeolocationRequest(4, 4, controller.signal), false);
});

test("superseding the location request aborts reverse enrichment before it can resolve", async () => {
  const controller = new AbortController();
  let lookupStarted = false;
  const pending = resolveGeolocationSelection(39.904812, 32.851245, controller.signal, (_latitude, _longitude, signal) => {
    lookupStarted = true;
    return new Promise((_resolve, reject) => {
      signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  });
  await Promise.resolve();
  controller.abort(new DOMException("Location choice superseded", "AbortError"));
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(lookupStarted, true);
  assert.equal(isCurrentGeolocationRequest(3, 4, controller.signal), false);
});
