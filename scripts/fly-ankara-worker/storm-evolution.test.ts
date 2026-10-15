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


test("repeat-CG admission advances the shadow anchor and suppresses its already represented area", () => {
  const shadow = new StormEvolutionShadow();
  const a = place(39.94, 32.65, "Halitcevriaslangil", "Kalecik");
  const b = place(39.95, 32.74, "Uyarca", "Kalecik");
  shadow.setBaseline("kalecik", a.latitude, a.longitude, a);
  shadow.observe("kalecik", "a-1", a.latitude, a.longitude, now);
  shadow.observe("kalecik", "a-2", a.latitude + .0001, a.longitude, now + 1);
  shadow.observe("kalecik", "b-1", b.latitude, b.longitude, now + 2);
  shadow.observe("kalecik", "b-2", b.latitude + .0001, b.longitude, now + 3);

  // The repeat-CG admission is the reservation point; it precedes any async X confirmation.
  shadow.setLatestRepresentedPublication("kalecik", b.latitude, b.longitude, b);
  const result = shadow.evaluate("kalecik", ["a-1", "b-1"], now + 60_000)!;
  assert.equal(result.eligible, false);
  assert.equal(result.reason, "suppressed_already_published_area");
  assert.equal(result.originalPublishedLocation, a.displayLabel);
  assert.equal(result.latestRepresentedLocation, b.displayLabel);
});

test("a supported area beyond the latest repeat-CG anchor can still be shadow eligible", () => {
  const shadow = new StormEvolutionShadow();
  const a = place(39.94, 32.65, "Halitcevriaslangil", "Kalecik");
  const b = place(39.95, 32.74, "Uyarca", "Kalecik");
  const c = place(39.95, 32.81, "Aşağı", "Kalecik");
  shadow.setBaseline("kalecik", a.latitude, a.longitude, a);
  shadow.observe("kalecik", "a-1", a.latitude, a.longitude, now);
  shadow.observe("kalecik", "a-2", a.latitude + .0001, a.longitude, now + 1);
  shadow.observe("kalecik", "b-1", b.latitude, b.longitude, now + 2);
  shadow.observe("kalecik", "b-2", b.latitude + .0001, b.longitude, now + 3);
  shadow.setLatestRepresentedPublication("kalecik", b.latitude, b.longitude, b);
  shadow.observe("kalecik", "c-1", c.latitude, c.longitude, now + 4);
  shadow.observe("kalecik", "c-2", c.latitude + .0001, c.longitude, now + 5);

  const request = shadow.takeLookupRequests("kalecik", now + 60_000)
    .find(item => Math.abs(item.longitude - c.longitude) < .001);
  assert.ok(request, "new C area is reverse-geocoded using the normal shadow lookup");
  shadow.resolve("kalecik", request.cellId, c);
  const result = shadow.evaluate("kalecik", ["c-1", "c-2"], now + 60_000)!;
  assert.equal(result.eligible, true);
  assert.equal(result.reason, "meaningful_new_area_since_latest_publication");
  assert.equal(result.supportedLocations[0].distanceFromLatestPublicationKm >= 4, true);
});

test("latest represented publication anchors are isolated by incident", () => {
  const shadow = new StormEvolutionShadow();
  const a = place(39.94, 32.65, "Halitcevriaslangil", "Kalecik");
  const b = place(39.95, 32.74, "Uyarca", "Kalecik");
  shadow.setBaseline("incident-x", a.latitude, a.longitude, a);
  shadow.setBaseline("incident-y", a.latitude, a.longitude, a);
  shadow.setLatestRepresentedPublication("incident-x", b.latitude, b.longitude, b);
  const x = shadow.evaluate("incident-x", [], now)!;
  const y = shadow.evaluate("incident-y", [], now)!;
  assert.equal(x.latestRepresentedLocation, b.displayLabel);
  assert.equal(y.latestRepresentedLocation, a.displayLabel);
});
