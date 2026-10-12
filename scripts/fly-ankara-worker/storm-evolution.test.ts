import assert from "node:assert/strict";
import { test } from "node:test";
import { extractProviderAddressHierarchy, makeDisplayLabel, normalizeNominatimAddress } from "../lightning-location-naming/normalize.ts";
import type { ReverseGeocodeResult } from "../lightning-location-naming/types.ts";
import { StormEvolutionShadow } from "./storm-evolution.ts";

const now = Date.parse("2026-10-11T20:00:00Z");
function place(latitude: number, longitude: number, neighborhood: string, county = "Etimesgut",
  rural = false): ReverseGeocodeResult {
  const payload = { address: { [rural ? "village" : "neighbourhood"]: neighborhood,
    [rural ? "town" : "city"]: rural ? county : "Ankara", county, state: "Ankara", country: "Türkiye" } };
  const normalized = normalizeNominatimAddress(payload);
  return { ...normalized, latitude, longitude, displayLabel: makeDisplayLabel(normalized), provider: "fixture",
    providerAddress: extractProviderAddressHierarchy(payload) };
}
function observer() {
  const shadow = new StormEvolutionShadow();
  const base = place(39.94, 32.65, "Etiler");
  shadow.setBaseline("i-1", base.latitude, base.longitude, base);
  let id = 1;
  function events(lat: number, lon: number, count: number, at = now) {
    for (let n = 0; n < count; n++) shadow.observe("i-1", `c-${id++}`, lat + n * .0001, lon, at + n);
    return { lat, lon };
  }
  function resolve(cell: { lat: number; lon: number }, value: ReverseGeocodeResult) {
    const requests = shadow.takeLookupRequests("i-1", now + 60_000);
    const request = requests.find(item => Math.abs(item.longitude - cell.lon) < .001);
    assert.ok(request);
    shadow.resolve("i-1", request.cellId, value);
  }
  function evaluate(at = now + 60_000) { return shadow.evaluate("i-1", ["c-1"], at)!; }
  return { shadow, events, resolve, evaluate };
}

test("same area and an isolated distant detection cannot become an evolution candidate", () => {
  const s = observer(); s.events(39.94, 32.65, 4);
  assert.equal(s.evaluate().reason, "same_area");
  s.events(39.95, 32.74, 1);
  assert.equal(s.evaluate().eligible, false);
  assert.equal(s.shadow.takeLookupRequests("i-1", now + 60_000).length, 0);
});

test("supported urban branch is eligible once; semantic jitter and adjacent same-area cells collapse", () => {
  const s = observer(); s.events(39.94, 32.65, 2);
  const west = s.events(39.95, 32.74, 2);
  s.resolve(west, place(39.95, 32.74, "Törekent", "Sincan"));
  const first = s.evaluate();
  assert.equal(first.eligible, true);
  assert.equal(first.newlySupportedLocations.length, 1);
  assert.equal(first.supportedLocations[0].evidenceCount, 2);
  assert.equal(s.evaluate().reason, "already_shadow_reported");
  // A nearby cell resolves to the same canonical hierarchy despite label suffix variation.
  const jitter = s.events(39.95, 32.78, 2);
  s.resolve(jitter, place(39.95, 32.78, "Törekent Mahallesi", "Sincan İlçesi"));
  assert.equal(s.evaluate().eligible, false);
  assert.equal(s.evaluate().supportedLocations[0].evidenceCount, 4);
  const later = s.events(39.96, 32.84, 2);
  s.resolve(later, place(39.96, 32.84, "Fatih", "Sincan"));
  assert.equal(s.evaluate().newlySupportedLocations.length, 1);
});

test("multiple supported places aggregate into one candidate and rural weak evidence is conservative", () => {
  const s = observer(); s.events(39.94, 32.65, 2);
  const a = s.events(39.95, 32.74, 2);
  const b = s.events(39.96, 32.84, 2);
  const requests = s.shadow.takeLookupRequests("i-1", now + 60_000);
  assert.equal(requests.length, 2);
  s.shadow.resolve("i-1", requests.find(item => Math.abs(item.longitude - a.lon) < .001)!.cellId,
    place(39.95, 32.74, "Törekent", "Sincan"));
  s.shadow.resolve("i-1", requests.find(item => Math.abs(item.longitude - b.lon) < .001)!.cellId,
    place(39.96, 32.84, "Fatih", "Sincan"));
  assert.equal(s.evaluate().newlySupportedLocations.length, 2);
  assert.equal(s.evaluate().eligible, false);

  const rural = observer(); rural.events(39.94, 32.65, 2);
  const remote = rural.events(39.96, 32.84, 2);
  rural.resolve(remote, place(39.96, 32.84, "Köy", "Sincan", true));
  assert.equal(rural.evaluate().eligible, false);
  rural.events(39.96, 32.84, 2);
  assert.equal(rural.evaluate().eligible, true);
});

test("missing hierarchy and old detections cannot supply a new place", () => {
  const s = observer(); s.events(39.94, 32.65, 2);
  const distant = s.events(39.95, 32.74, 2);
  s.resolve(distant, { ...place(39.95, 32.74, "Törekent", "Sincan"), providerAddress: undefined });
  assert.equal(s.evaluate().reason, "location_ambiguous");
  assert.equal(s.evaluate(now + 21 * 60_000).eligible, false);
});
