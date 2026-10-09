import assert from "node:assert/strict";
import test from "node:test";
import { readFile, readdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { composeLightningMessage, DEFAULT_MAX_CHARACTERS, verbForIncident } from "./compose.ts";
import { COMPOSER_FIXTURES } from "./fixtures.ts";
import type { ComposerInput } from "./types.ts";

const urban = COMPOSER_FIXTURES.cg_verified_urban;
const generic = COMPOSER_FIXTURES.ic_only_urban;
const compose = (input: ComposerInput) => composeLightningMessage(input);

test("CG produces URL-free public coordinates and a full-precision internal map", () => {
  const input = {
    ...urban,
    incident: { ...urban.incident, representativeLatitude: 40.1, representativeLongitude: 33.1 },
  };
  const result = compose(input);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.hashtag, "#YILDIRIM");
  assert.equal(result.eventKind, "cg_verified");
  assert.equal(result.dateTimeText, "6 Ekim 2026, 16:48 TSİ");
  assert.equal(result.locationText, "Aşağı Ayrancı / Çankaya");
  assert.equal(result.eventText, `Aşağı Ayrancı / Çankaya civarında yere ulaşan yıldırım ${verbForIncident(input.incident.id)}.`);
  assert.equal(result.mapUrl, "https://www.google.com/maps?q=39.902742,32.851494");
  assert.deepEqual(result.text.split("\n"), [result.hashtag, result.dateTimeText, result.eventText, "", "39.903, 32.851"]);
  assert.equal(result.text.includes("40.1,33.1"), false);
  assert.equal(result.coordinateText, "39.903, 32.851");
  assert.doesNotMatch(result.text, /https?:\/\//);
  assert.equal(result.characterCount, [...result.text].length);
  assert.ok(result.characterCount <= DEFAULT_MAX_CHARACTERS);
});

for (const [name, input] of Object.entries({
  ic_only: generic,
  no_match: COMPOSER_FIXTURES.no_match_urban,
  provider_unavailable: COMPOSER_FIXTURES.provider_unavailable_urban,
})) {
  test(`${name} uses the generic three-line message without CG claim or map URL`, () => {
    const result = compose(input);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.eventKind, name);
    assert.equal(result.hashtag, "#ŞİMŞEK");
    assert.equal(result.mapUrl, null);
    assert.equal(result.coordinateText, null);
    assert.doesNotMatch(result.text, /https?:\/\/|^-?\d+\.\d+, -?\d+\.\d+$/m);
    assert.deepEqual(result.text.split("\n"), [result.hashtag, result.dateTimeText, result.eventText]);
    assert.match(result.eventText, / civarında şimşek (tespit edildi|kaydedildi)\.$/);
    assert.doesNotMatch(result.text, /CG|Xweather|provider|unavailable|no_match|doğrulanamadı|yere ulaşan|google\.com\/maps/i);
  });
}

test("stable incident IDs always choose an allowed verb and fixture IDs exercise both", () => {
  const first = compose(generic);
  assert.deepEqual(first, compose(generic));
  assert.equal(first.ok, true);
  const verbs = new Set(Object.values(COMPOSER_FIXTURES).map(item => verbForIncident(item.incident.id)));
  assert.deepEqual(verbs, new Set(["tespit edildi", "kaydedildi"]));
});

test("selected CG coordinates round deterministically to three decimals, preserving zeros and signs", () => {
  for (const [latitude, longitude, expected] of [
    [40.5118, 16.3612, "40.512, 16.361"],
    [39.9, 32, "39.900, 32.000"],
    [-39.902742, -73.98765, "-39.903, -73.988"],
    [0, 180, "0.000, 180.000"],
  ] as const) {
    const result = compose({ ...urban, enrichment: {
      status: "cg_verified", match: { type: "cg", latitude, longitude },
    } });
    assert.equal(result.ok, true);
    if (!result.ok) continue;
    assert.equal(result.coordinateText, expected);
    assert.ok(result.text.endsWith(`\n\n${expected}`));
    assert.equal(result.mapUrl, `https://www.google.com/maps?q=${latitude},${longitude}`);
    assert.doesNotMatch(result.text, /https?:\/\//);
    assert.equal(result.characterCount, [...result.text].length);
  }
});

test("CG public character budget excludes internal URL and still enforces exactly 280", () => {
  const short = compose(urban);
  assert.ok(short.ok);
  const prefix = "A".repeat(280 - short.characterCount);
  const boundary = compose({ ...urban, locationDisplayLabel: prefix + urban.locationDisplayLabel });
  assert.ok(boundary.ok);
  assert.equal(boundary.characterCount, 280);
  assert.ok(boundary.mapUrl);
  const tooLong = compose({ ...urban, locationDisplayLabel: prefix + "A" + urban.locationDisplayLabel });
  assert.equal(tooLong.ok, false);
  if (!tooLong.ok) {
    assert.equal(tooLong.error.code, "message_too_long");
    assert.equal(tooLong.characterCount, 281);
  }
});

test("Istanbul time, Turkish month, year, minutes, and TSİ suffix are explicit", () => {
  const input = { ...generic, incident: { id: "september", lastActivityTimeMs: Date.parse("2026-09-21T17:51:42Z") } };
  const result = compose(input);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.dateTimeText, "21 Eylül 2026, 20:51 TSİ");
  assert.doesNotMatch(result.dateTimeText, /:42|UTC/);
});

test("location separators and meaningful qualifiers are preserved", () => {
  for (const [label, expected] of [
    ["Aşağı Ayrancı, Çankaya", "Aşağı Ayrancı / Çankaya"],
    ["Yukarı Bahçelievler, Çankaya", "Yukarı Bahçelievler / Çankaya"],
    ["Eski Mahalle, Çankaya", "Eski Mahalle / Çankaya"],
    ["Yeni Mahalle, Çankaya", "Yeni Mahalle / Çankaya"],
    ["Beynam, Balâ", "Beynam / Balâ"],
    ["Keskin, Kırıkkale", "Keskin / Kırıkkale"],
    ["Ankara", "Ankara"],
  ]) {
    const result = compose({ ...generic, locationDisplayLabel: label });
    assert.equal(result.ok && result.locationText, expected);
  }
});

test("rural CG fixture uses its own selected CG match", () => {
  const result = compose(COMPOSER_FIXTURES.cg_verified_rural);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.locationText, "Beynam / Balâ");
  assert.equal(result.mapUrl, "https://www.google.com/maps?q=39.682564,32.859372");
});

test("a CG match in any non-CG status never adds coordinates, a map, or CG wording", () => {
  for (const status of ["ic_only", "no_match", "provider_unavailable"] as const) {
    const result = compose({ ...generic, enrichment: { status, match: urban.enrichment.match } });
    assert.equal(result.ok, true);
    if (!result.ok) continue;
    assert.equal(result.mapUrl, null);
    assert.equal(result.coordinateText, null);
    assert.doesNotMatch(result.text, /https?:\/\/|^-?\d+\.\d+, -?\d+\.\d+$/m);
    assert.doesNotMatch(result.text, /yere ulaşan|google\.com/);
  }
});

test("missing or unsafe location returns a structured error and no public post", () => {
  for (const label of [null, "", "   "]) {
    const result = compose({ ...generic, locationDisplayLabel: label });
    assert.deepEqual(result, { ok: false, error: { code: "missing_location", message: "A normalized location display label is required." } });
    assert.equal("text" in result, false);
  }
  for (const label of ["Ayrancı,", ", Çankaya", "Ayrancı\n#FAKE"]) {
    const result = compose({ ...generic, locationDisplayLabel: label });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, "invalid_location");
  }
});

test("CG without a selected valid CG coordinate fails instead of inventing a map URL", () => {
  for (const match of [undefined, { type: "ic", latitude: 39, longitude: 32 },
    { type: "cg", latitude: 91, longitude: 32 }, { type: "cg", latitude: 39 },
    { type: "cg", latitude: 39, longitude: Infinity }]) {
    const result = compose({ ...urban, enrichment: { status: "cg_verified", match } });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, "missing_cg_match");
    assert.equal("text" in result, false);
  }
});

test("invalid timestamp, incident ID, status, and character budget yield structured errors", () => {
  const cases = [
    [compose({ ...generic, incident: { id: " ", lastActivityTimeMs: generic.incident.lastActivityTimeMs } }), "invalid_incident_id"],
    [compose({ ...generic, incident: { id: "valid", lastActivityTimeMs: NaN } }), "invalid_event_time"],
    [compose({ ...generic, enrichment: { status: "invalid" as "ic_only" } }), "invalid_enrichment"],
    [composeLightningMessage(generic, { maxCharacters: 0 }), "invalid_character_budget"],
  ] as const;
  for (const [result, code] of cases) {
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, code);
  }
});

test("representative fixture messages fit 280; over-budget messages return count without truncation", () => {
  for (const input of Object.values(COMPOSER_FIXTURES)) {
    const result = compose(input);
    assert.equal(result.ok, true);
    if (result.ok) assert.ok(result.characterCount <= 280);
  }
  const long = composeLightningMessage(urban, { maxCharacters: 20 });
  assert.equal(long.ok, false);
  if (!long.ok) {
    assert.equal(long.error.code, "message_too_long");
    assert.ok((long.characterCount ?? 0) > 20);
    assert.equal("text" in long, false);
  }
});

test("composer has no network, provider, reverse-geocoding, publishing, or production imports", async () => {
  const root = dirname(fileURLToPath(import.meta.url));
  for (const file of ["compose.ts", "runner.ts", "fixtures.ts"]) {
    const source = await readFile(resolve(root, file), "utf8");
    assert.doesNotMatch(source, /from ["'][^"']*(xweather|nominatim|reverse-geocode|twitter|publisher|src\/)/i);
    assert.doesNotMatch(source, /\bfetch\s*\(|\bWebSocket\s*\(/);
  }
  const pending = [resolve(root, "../../src")];
  while (pending.length) {
    const directory = pending.pop()!;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (/\.tsx?$/.test(entry.name)) {
        const source = await readFile(path, "utf8");
        assert.doesNotMatch(source, /lightning-message-composer|composeLightningMessage/);
      }
    }
  }
});
