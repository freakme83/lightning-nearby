import assert from "node:assert/strict";
import test from "node:test";
import { extractProviderAddressHierarchy, isAnkaraProvince, makeDisplayLabel, normalizeAndLabel, normalizeNominatimAddress, validateCoordinates } from "./normalize.ts";

const payload = (address: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ address, display_name: "ignored raw full provider string", ...extra });

test("Ankara retains the most specific meaningful place and its town parent", () => {
  assert.equal(normalizeAndLabel(payload({ quarter: "Aşağı Ayrancı", suburb: "Ayrancı Mahallesi", town: "Çankaya", province: "Ankara" })).displayLabel, "Aşağı Ayrancı, Çankaya");
  assert.equal(normalizeAndLabel(payload({ city_district: "Beynam Mahallesi", town: "Balâ", province: "Ankara" })).displayLabel, "Beynam, Balâ");
  assert.equal(normalizeAndLabel(payload({ village: "Yenipeçenek Mahallesi", town: "Sincan", province: "Ankara" })).displayLabel, "Yenipeçenek, Sincan");
  assert.equal(normalizeAndLabel(payload({ suburb: "Alacaatlı Mahallesi", town: "Çankaya", province: "Ankara" })).displayLabel, "Alacaatlı, Çankaya");
});

test("quarter outranks a broader suburb and provider specificity is retained", () => {
  const result = normalizeAndLabel(payload({ quarter: "Aşağı Ayrancı", suburb: "Ayrancı Mahallesi", town: "Çankaya", province: "Ankara" }));
  assert.equal(result.neighborhood, "Aşağı Ayrancı");
  assert.equal(result.displayLabel, "Aşağı Ayrancı, Çankaya");
});

test("administrative suffix cleanup strips only Mahallesi, İlçesi, and İli", () => {
  assert.equal(normalizeAndLabel(payload({ suburb: "Alacaatlı Mahallesi", town: "Çankaya İlçesi", province: "Ankara İli" })).displayLabel, "Alacaatlı, Çankaya");
  assert.equal(normalizeAndLabel(payload({ city_district: "Beynam Mahallesi", town: "Balâ İlçesi", province: "Ankara İli" })).displayLabel, "Beynam, Balâ");
});

test("directional and historic parts of place names are preserved", () => {
  for (const name of ["Aşağı Ayrancı", "Yukarı Bahçelievler", "Eski Beynam", "Yeni Beynam"]) {
    assert.equal(makeDisplayLabel({ neighborhood: name, locality: "Çankaya", localityKind: "town", province: "Ankara" }), `${name}, Çankaya`);
  }
});

test("small place candidates are normalized from village, hamlet, and city_district fields", () => {
  assert.equal(normalizeNominatimAddress(payload({ village: "Yenipeçenek Mahallesi", town: "Sincan", province: "Ankara" })).neighborhood, "Yenipeçenek");
  assert.equal(normalizeNominatimAddress(payload({ hamlet: "Aşağıörükbağ Köyü", town: "Bala", province: "Ankara" })).neighborhood, "Aşağıörükbağ Köyü");
  assert.equal(normalizeNominatimAddress(payload({ city_district: "Beynam Mahallesi", town: "Balâ", province: "Ankara" })).neighborhood, "Beynam");
});

test("district-like town parents are kept distinct from small-place candidates", () => {
  const result = normalizeNominatimAddress(payload({ city_district: "Beynam Mahallesi", town: "Balâ", province: "Ankara" }));
  assert.equal(result.locality, "Balâ");
  assert.equal(result.localityKind, "town");
  assert.equal(result.district, "Beynam");
});

test("Ankara province detection is locale-aware and strips administrative suffixes", () => {
  assert.equal(isAnkaraProvince("Ankara"), true);
  assert.equal(isAnkaraProvince("ANKARA"), true);
  assert.equal(isAnkaraProvince("Ankara İli"), true);
  assert.equal(isAnkaraProvince("Kırıkkale"), false);
});

test("outside Ankara ignores hyper-local details and uses district-like parent plus province", () => {
  assert.equal(normalizeAndLabel(payload({ village: "Yenipeçenek Mahallesi", town: "Kulu", province: "Konya" })).displayLabel, "Kulu, Konya");
  assert.equal(normalizeAndLabel(payload({ suburb: "Ayrancı Mahallesi", town: "Keskin", province: "Kırıkkale" })).displayLabel, "Keskin, Kırıkkale");
});

test("outside Ankara retains meaningful towns and villages with the closest useful broader parent", () => {
  assert.equal(normalizeAndLabel(payload({ town: "Rochefort", county: "Charente-Maritime", state: "Nouvelle-Aquitaine" })).displayLabel, "Rochefort, Charente-Maritime");
  assert.equal(normalizeAndLabel(payload({ village: "Bors-de-Montmoreau", county: "Charente", state: "Nouvelle-Aquitaine" })).displayLabel, "Bors-de-Montmoreau, Charente");
  assert.equal(normalizeAndLabel(payload({ town: "Cisterna di Latina", hamlet: "Olmobello", county: "Latina", state: "Lazio" })).displayLabel, "Cisterna di Latina, Latina");
});

test("real-style France hierarchy keeps village over hamlet and municipality", () => {
  const result = normalizeAndLabel(payload({
    village: "Bors-de-Montmoreau",
    hamlet: "Le Pignier",
    municipality: "Angoulême",
    county: "Charente",
    state: "Nouvelle-Aquitaine",
    country: "France",
  }));
  assert.equal(result.locality, "Bors-de-Montmoreau");
  assert.equal(result.localityKind, "village");
  assert.equal(result.district, "Charente");
  assert.equal(result.province, "Nouvelle-Aquitaine");
  assert.equal(result.displayLabel, "Bors-de-Montmoreau, Charente");
  assert.doesNotMatch(result.displayLabel!, /Le Pignier|Angoulême/);
});

test("outside Ankara suppresses a hamlet alone and falls back to available administration", () => {
  assert.equal(normalizeAndLabel(payload({ hamlet: "Le Pignier", county: "Charente", state: "Nouvelle-Aquitaine" })).displayLabel, "Charente, Nouvelle-Aquitaine");
  assert.equal(normalizeAndLabel(payload({ hamlet: "Le Pignier", state: "Nouvelle-Aquitaine" })).displayLabel, "Nouvelle-Aquitaine");
  assert.equal(normalizeAndLabel(payload({ hamlet: "Le Pignier" })).displayLabel, null);
});

test("outside Ankara falls back to province alone when no district-like parent exists", () => {
  assert.equal(normalizeAndLabel(payload({ suburb: "Remote Mahallesi", city: "Some City", province: "Kırıkkale" })).displayLabel, "Kırıkkale");
  assert.equal(normalizeAndLabel(payload({ province: "Konya" })).displayLabel, "Konya");
});

test("a district-like field is also an outside-Ankara parent fallback", () => {
  assert.equal(normalizeAndLabel(payload({ suburb: "Remote Mahallesi", city_district: "Keskin İlçesi", province: "Kırıkkale İli" })).displayLabel, "Keskin, Kırıkkale");
});

test("Ankara without a small place uses town plus province, or province alone", () => {
  assert.equal(normalizeAndLabel(payload({ town: "Polatlı", province: "Ankara" })).displayLabel, "Polatlı, Ankara");
  assert.equal(normalizeAndLabel(payload({ province: "Ankara" })).displayLabel, "Ankara");
});

test("Kırıkkale city and repeated hierarchy levels collapse", () => {
  assert.equal(normalizeAndLabel(payload({ city: "Kırıkkale", province: "Kırıkkale" })).displayLabel, "Kırıkkale");
  assert.equal(makeDisplayLabel({ locality: "Çankaya", localityKind: "town", district: "Çankaya", province: "Ankara" }), "Çankaya, Ankara");
  assert.equal(makeDisplayLabel({ neighborhood: "Keskin", locality: "Keskin", localityKind: "town", district: "Keskin", province: "Kırıkkale" }), "Keskin, Kırıkkale");
  assert.equal(makeDisplayLabel({ neighborhood: "Ankara", province: "Ankara" }), "Ankara");
});

test("previously good naming mappings remain stable", () => {
  assert.equal(normalizeAndLabel(payload({ city: "Ankara", province: "Ankara", country: "Türkiye" })).displayLabel, "Ankara");
  assert.equal(normalizeAndLabel(payload({ neighbourhood: "Bahçelievler Mahallesi", county: "Çankaya İlçesi", state: "Ankara" })).displayLabel, "Bahçelievler, Çankaya");
  assert.equal(normalizeAndLabel(payload({ suburb: "Eryaman", county: "Etimesgut", state: "Ankara" })).displayLabel, "Eryaman, Etimesgut");
  assert.equal(normalizeAndLabel(payload({ neighbourhood: "Batıkent Mahallesi", county: "Yenimahalle", state: "Ankara" })).displayLabel, "Batıkent, Yenimahalle");
  assert.equal(normalizeAndLabel(payload({ town: "Polatlı", county: "Polatlı", province: "Ankara" })).displayLabel, "Polatlı, Ankara");
  assert.equal(normalizeAndLabel(payload({ city: "Kırıkkale", province: "Kırıkkale" })).displayLabel, "Kırıkkale");
  assert.equal(normalizeAndLabel(payload({ town: "Keskin", county: "Keskin", province: "Kırıkkale" })).displayLabel, "Keskin, Kırıkkale");
  assert.equal(normalizeAndLabel(payload({ suburb: "Alacaatlı Mahallesi", town: "Çankaya", province: "Ankara" })).displayLabel, "Alacaatlı, Çankaya");
  assert.equal(normalizeAndLabel(payload({ quarter: "Aşağı Ayrancı", suburb: "Ayrancı Mahallesi", town: "Çankaya", province: "Ankara" })).displayLabel, "Aşağı Ayrancı, Çankaya");
});

test("district-like fields provide an Ankara parent when town is absent", () => {
  assert.equal(normalizeAndLabel(payload({ suburb: "Ayrancı Mahallesi", county: "Çankaya İlçesi", province: "Ankara İli" })).displayLabel, "Ayrancı, Çankaya");
  assert.equal(normalizeAndLabel(payload({ county: "Polatlı", province: "Ankara" })).displayLabel, "Polatlı, Ankara");
});

test("duplicate names are collapsed with Turkish locale comparison", () => {
  assert.equal(makeDisplayLabel({ neighborhood: "Ayrancı", locality: "ayrancı", localityKind: "town", district: "Çankaya", province: "Ankara" }), "Ayrancı, Çankaya");
  assert.equal(makeDisplayLabel({ locality: "Kırıkkale", localityKind: "town", district: "Kırıkkale", province: "KIRIKKALE" }), "KIRIKKALE");
  assert.equal(makeDisplayLabel({ neighborhood: "Beynam", locality: "Balâ", localityKind: "town", province: "Ankara" }), "Beynam, Balâ");
});

test("empty or malformed hierarchy never fabricates a place label", () => {
  assert.equal(normalizeAndLabel(payload({ country: "Türkiye", postcode: "06000" })).displayLabel, null);
  assert.equal(makeDisplayLabel({}), null);
  assert.throws(() => normalizeNominatimAddress(null), /must be an object/);
  assert.throws(() => normalizeNominatimAddress({ address: "Ankara" }), /structured address/);
});

test("provider hierarchy remains whitelisted and does not affect labels", () => {
  const response = payload({ suburb: "Alacaatlı Mahallesi", town: "Çankaya İlçesi", province: "Ankara İli", country: "Türkiye", road: "Hoşdere Caddesi", house_number: "12", postcode: "06540" });
  const withoutDiagnostics = normalizeAndLabel(response);
  const hierarchy = extractProviderAddressHierarchy(response);
  assert.equal(withoutDiagnostics.displayLabel, "Alacaatlı, Çankaya");
  assert.equal(hierarchy.suburb, "Alacaatlı Mahallesi");
  assert.equal(hierarchy.town, "Çankaya İlçesi");
  assert.equal(hierarchy.province, "Ankara İli");
  assert.equal(hierarchy.country, "Türkiye");
  assert.equal("road" in hierarchy, false);
  assert.equal("house_number" in hierarchy, false);
  assert.equal("postcode" in hierarchy, false);
});

test("coordinate validation remains unchanged", () => {
  for (const [lat, lon] of [[91, 32], [39, 181], [Number.NaN, 32], [39, Number.POSITIVE_INFINITY]]) {
    assert.throws(() => validateCoordinates(lat, lon), RangeError);
  }
  assert.doesNotThrow(() => validateCoordinates(39.92, 32.85));
});
