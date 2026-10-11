import assert from "node:assert/strict";
import test from "node:test";
import { normalizeNominatimAddress, extractProviderAddressHierarchy } from "../lightning-location-naming/normalize.ts";
import { classifyCgPlace, semanticCgLocationIdentity, canonicalPlaceName, type PlaceInput } from "./location.ts";
import * as defaults from "./constants.ts";

function place(address: Record<string, string>, rawType?: string): PlaceInput {
  const payload = { address: { country: "Türkiye", province: "Ankara", ...address }, addresstype: rawType };
  return { ...normalizeNominatimAddress(payload), providerAddress: extractProviderAddressHierarchy(payload) };
}

for (const [name, input, expected] of [
  ["urban neighborhood", place({ neighbourhood: "Ayrancı", city: "Ankara", county: "Çankaya" }), "urban"],
  ["village", place({ village: "Beynam", county: "Balâ" }), "rural"],
  ["hamlet", place({ hamlet: "Aşağıörükbağ", county: "Balâ" }), "rural"],
  ["village with town parent", place({ village: "Yenipeçenek", town: "Sincan" }), "rural"],
  ["hamlet with municipality parent", place({ hamlet: "A", municipality: "B" }), "rural"],
  ["city_district-only", place({ city_district: "Beynam" }), "unknown"],
  ["ambiguous city_district with town parent", place({ city_district: "Beynam", town: "Balâ" }), "unknown"],
  ["missing localityKind", place({ neighbourhood: "Ayrancı", county: "Çankaya" }), "unknown"],
  ["missing evidence", place({}), "unknown"],
  ["town", place({ town: "Polatlı", county: "Polatlı" }), "urban"],
  ["city", place({ city: "Ankara" }), "urban"],
  ["municipality", place({ municipality: "Polatlı" }), "urban"],
] as const) {
  test(`${name} classification is ${expected}`, () => {
    const before = JSON.stringify(input);
    assert.equal(classifyCgPlace(input).classification, expected);
    assert.ok(classifyCgPlace(input).evidence.length);
    assert.equal(JSON.stringify(input), before);
  });
}

test("conflicting normalized/provider evidence is unknown; explicit rural evidence still wins", () => {
  const city = place({ city: "Ankara", county: "Çankaya" });
  const conflict = { ...city, locality: "Another city" };
  assert.deepEqual(classifyCgPlace(conflict), { classification: "unknown", evidence: ["hierarchy_conflict"] });
  assert.deepEqual(semanticCgLocationIdentity(conflict), { available: false, reason: "hierarchy_conflict" });
  const rural = place({ village: "Beynam", town: "Balâ" });
  assert.equal(classifyCgPlace({ ...rural, localityKind: "city" }).classification, "rural");
  assert.equal(classifyCgPlace({ localityKind: "other" }).classification, "unknown");
});

test("semantic identity uses neighborhood and reliable parent, never the display label", () => {
  const a = place({ neighbourhood: "Ayrancı", town: "Çankaya", county: "Çankaya" });
  const equal = place({ neighborhood: "  AYRANCI Mahallesi ", town: "Çankaya İlçesi", county: "Çankaya" });
  const b = place({ neighbourhood: "Balgat", town: "Çankaya", county: "Çankaya" });
  const otherDistrict = place({ neighbourhood: "Ayrancı", town: "Yenimahalle", county: "Yenimahalle" });
  assert.deepEqual(semanticCgLocationIdentity(a), semanticCgLocationIdentity(equal));
  assert.notDeepEqual(semanticCgLocationIdentity(a), semanticCgLocationIdentity(b));
  assert.notDeepEqual(semanticCgLocationIdentity(a), semanticCgLocationIdentity(otherDistrict));
  assert.equal(semanticCgLocationIdentity(a).available, true);
});

test("no neighborhood still identifies reliable districts; villages and centers differ", () => {
  const a = place({ town: "Çankaya", county: "Çankaya" });
  const b = place({ town: "Yenimahalle", county: "Yenimahalle" });
  const villageA = place({ village: "A", town: "Balâ" });
  const villageB = place({ village: "B", town: "Balâ" });
  const center = place({ town: "Balâ", county: "Balâ" });
  assert.equal(semanticCgLocationIdentity(a).available, true);
  assert.notDeepEqual(semanticCgLocationIdentity(a), semanticCgLocationIdentity(b));
  assert.equal(semanticCgLocationIdentity(villageA).available, true);
  assert.notDeepEqual(semanticCgLocationIdentity(villageA), semanticCgLocationIdentity(villageB));
  assert.notDeepEqual(semanticCgLocationIdentity(villageA), semanticCgLocationIdentity(center));
});

test("missing provenance, geography, parent and ambiguous hierarchy never fabricate identities", () => {
  for (const input of [{}, { neighborhood: "Ayrancı", district: "Çankaya" },
    place({ neighbourhood: "Ayrancı" }), place({ city_district: "Beynam", town: "Balâ" }),
    { ...place({ village: "Beynam", town: "Balâ" }), country: undefined }]) {
    assert.equal(semanticCgLocationIdentity(input).available, false);
  }
});

test("NFC, whitespace, suffix cleanup and Turkish casing preserve directional names", () => {
  assert.equal(canonicalPlaceName("  AŞAĞI   AYRANCI Mahallesi "), "aşağı ayrancı");
  assert.equal(canonicalPlaceName("İNCİ"), "inci");
  assert.equal(canonicalPlaceName("ANKARA İLİ"), "ankara");
  assert.equal(canonicalPlaceName("ÇANKAYA İLÇESİ"), "çankaya");
  assert.equal(canonicalPlaceName("AYRANCI MAHALLESİ"), "ayrancı");
  assert.equal(canonicalPlaceName("C\u0327ankaya"), "çankaya");
  const a = place({ quarter: "Aşağı Ayrancı", town: "Çankaya" });
  const b = place({ quarter: "Yukarı Ayrancı", town: "Çankaya" });
  assert.notDeepEqual(semanticCgLocationIdentity(a), semanticCgLocationIdentity(b));
});

test("future defaults are explicit and count the initial admission", () => {
  const { CG_REPEAT_URBAN_MIN_DISTANCE_KM, CG_REPEAT_RURAL_MIN_DISTANCE_KM,
    CG_REPEAT_BURST_WINDOW_MINUTES, CG_REPEAT_MAX_ADMISSIONS_PER_WINDOW } = defaults;
  assert.deepEqual({ CG_REPEAT_URBAN_MIN_DISTANCE_KM, CG_REPEAT_RURAL_MIN_DISTANCE_KM,
    CG_REPEAT_BURST_WINDOW_MINUTES, CG_REPEAT_MAX_ADMISSIONS_PER_WINDOW }, { CG_REPEAT_URBAN_MIN_DISTANCE_KM: 1, CG_REPEAT_RURAL_MIN_DISTANCE_KM: 5,
    CG_REPEAT_BURST_WINDOW_MINUTES: 20, CG_REPEAT_MAX_ADMISSIONS_PER_WINDOW: 3 });
});
