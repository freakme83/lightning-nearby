import assert from "node:assert/strict";
import test from "node:test";
import { makeDisplayLabel, normalizeAndLabel, normalizeNominatimAddress, validateCoordinates } from "./normalize.ts";

const payload = (address: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ address, display_name: "ignored raw full provider string", ...extra });

test("normalizes Ankara city and province to a single label", () => {
  assert.equal(normalizeAndLabel(payload({ city: "Ankara", province: "Ankara", country: "Türkiye" })).displayLabel, "Ankara");
});

test("prefers meaningful Ankara neighborhoods over district-only output", () => {
  for (const [name, district] of [["Ayrancı", "Çankaya"], ["Bahçelievler", "Çankaya"], ["Eryaman", "Etimesgut"], ["Batıkent", "Yenimahalle"]]) {
    assert.equal(normalizeAndLabel(payload({ neighbourhood: `${name} Mahallesi`, county: `${district} İlçesi`, state: "Ankara", country: "Türkiye" })).displayLabel, `${name}, ${district}`);
  }
});

test("towns and rural localities retain useful parents", () => {
  assert.equal(normalizeAndLabel(payload({ town: "Polatlı", county: "Polatlı", state: "Ankara" })).displayLabel, "Polatlı, Ankara");
  assert.equal(normalizeAndLabel(payload({ town: "Haymana", state: "Ankara" })).displayLabel, "Haymana, Ankara");
  assert.equal(normalizeAndLabel(payload({ city: "Kırıkkale", province: "Kırıkkale" })).displayLabel, "Kırıkkale");
  assert.equal(normalizeAndLabel(payload({ town: "Keskin", county: "Keskin", province: "Kırıkkale" })).displayLabel, "Keskin, Kırıkkale");
  assert.equal(normalizeAndLabel(payload({ village: "Aşağıörükbağ Köyü", county: "Bala", state: "Ankara" })).displayLabel, "Aşağıörükbağ Köyü, Bala");
  assert.equal(normalizeAndLabel(payload({ hamlet: "Yukarı Mahalle", county: "Haymana", state: "Ankara" })).displayLabel, "Yukarı Mahalle, Haymana");
});

test("district and province provide a fallback when neighborhood is missing", () => {
  assert.equal(normalizeAndLabel(payload({ county: "Çankaya", state: "Ankara" })).displayLabel, "Çankaya, Ankara");
});

test("collapses duplicate locality, province, neighborhood, and district names", () => {
  assert.equal(makeDisplayLabel({ locality: "Kırıkkale", province: "Kırıkkale" }), "Kırıkkale");
  assert.equal(makeDisplayLabel({ neighborhood: "Ayrancı", district: "Ayrancı", province: "Ankara" }), "Ayrancı");
  assert.equal(makeDisplayLabel({ neighborhood: "Ayrancı", locality: "Ayrancı", district: "Çankaya", province: "Ankara" }), "Ayrancı, Çankaya");
});

test("country, street, postcode, road, and raw display name are excluded", () => {
  const result = normalizeAndLabel(payload({ neighbourhood: "Ayrancı Mahallesi", county: "Çankaya", state: "Ankara", country: "Türkiye", road: "Hoşdere Caddesi", house_number: "12", postcode: "06540" }));
  assert.equal(result.displayLabel, "Ayrancı, Çankaya");
  assert.equal(result.country, "Türkiye");
  assert.equal("road" in result, false);
});

test("empty or unsupported address data does not fabricate a place", () => {
  assert.equal(normalizeAndLabel(payload({ country: "Türkiye", postcode: "06000" })).displayLabel, null);
  assert.equal(makeDisplayLabel({}), null);
});

test("malformed response structures fail clearly", () => {
  assert.throws(() => normalizeNominatimAddress(null), /must be an object/);
  assert.throws(() => normalizeNominatimAddress({ address: "Ankara" }), /structured address/);
});

test("coordinate validation rejects out-of-range and non-finite inputs", () => {
  for (const [lat, lon] of [[91, 32], [39, 181], [Number.NaN, 32], [39, Number.POSITIVE_INFINITY]]) {
    assert.throws(() => validateCoordinates(lat, lon), RangeError);
  }
  assert.doesNotThrow(() => validateCoordinates(39.92, 32.85));
});

test("fixture normalization is deterministic for identical input", () => {
  const sample = payload({ suburb: "Eryaman", county: "Etimesgut", state: "Ankara" }, { addresstype: "suburb" });
  assert.deepEqual(normalizeAndLabel(sample), normalizeAndLabel(sample));
});

test("meaningful neighborhood wins over raw granular street and building fields", () => {
  const result = normalizeAndLabel(payload({ neighbourhood: "Bahçelievler", county: "Çankaya", state: "Ankara", road: "7. Cadde", house_number: "4", building: "Site 3", hamlet: "Obscure parcel" }));
  assert.equal(result.displayLabel, "Bahçelievler, Çankaya");
});

