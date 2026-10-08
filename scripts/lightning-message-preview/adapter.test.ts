import assert from "node:assert/strict";
import test from "node:test";
import { readFile, readdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { composeLightningMessage } from "../lightning-message-composer/compose.ts";
import { previewPairedMessage } from "./adapter.ts";
import { PAIRED_ARTIFACT_FIXTURES } from "./fixtures.ts";

const fixtures = PAIRED_ARTIFACT_FIXTURES;
const location = "Aşağı Ayrancı, Çankaya";
const preview = (artifact: unknown, locationDisplayLabel: string | null = location) =>
  previewPairedMessage({ artifact, locationDisplayLabel });

test("CG artifact maps current incident fields and selected match through the existing composer", () => {
  const result = preview(fixtures.cg_verified);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.sourceStatus, "paired_result");
  assert.equal(result.triggerMode, "fresh_would_publish");
  assert.equal(result.incidentId, fixtures.cg_verified.incident.incidentId);
  assert.equal(result.locationDisplayLabel, location);
  assert.equal(result.enrichmentStatus, "cg_verified");
  assert.equal(result.composer.hashtag, "#YILDIRIM");
  assert.equal(result.composer.dateTimeText, "6 Ekim 2026, 16:48 TSİ");
  assert.equal(result.mapUrl, "https://www.google.com/maps?q=39.902742,32.851494");
  assert.equal(result.text, result.composer.text);
  assert.equal(result.characterCount, result.composer.characterCount);
  assert.deepEqual(result.composer, composeLightningMessage({
    incident: { id: fixtures.cg_verified.incident.incidentId,
      lastActivityTimeMs: fixtures.cg_verified.incident.lastActivityTimeMs },
    locationDisplayLabel: location,
    enrichment: { status: "cg_verified", match: { type: "cg", latitude: 39.902742, longitude: 32.851494 } },
  }));
});

for (const [name, artifact] of Object.entries({
  ic_only: fixtures.ic_only,
  no_match: fixtures.no_match,
  provider_unavailable: fixtures.provider_unavailable,
})) {
  test(`${name} maps to generic text without a map, CG claim, or provider diagnostics`, () => {
    const result = preview(artifact, "Bahçelievler, Çankaya");
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.enrichmentStatus, name);
    assert.equal(result.composer.hashtag, "#ŞİMŞEK");
    assert.equal(result.mapUrl, null);
    assert.match(result.text, /Bahçelievler \/ Çankaya civarında şimşek (tespit edildi|kaydedildi)\./);
    assert.doesNotMatch(result.text, /CG|Xweather|provider|unavailable|no_match|doğrulanamadı|yere ulaşan|google\.com/i);
  });
}

test("CG map uses selected match coordinates, never incident representative coordinates", () => {
  const result = preview(fixtures.cg_verified);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.notEqual(result.mapUrl, "https://www.google.com/maps?q=39.9,32.8");
  assert.ok(result.mapUrl?.endsWith("39.902742,32.851494"));
  assert.equal(result.composer.coordinateText, "39.903, 32.851");
  assert.ok(result.text.endsWith("\n\n39.903, 32.851"));
  assert.doesNotMatch(result.text, /39\.900, 32\.800|https?:\/\//);
});

test("the current lastActivityTimeMs wins over any older eventTimeMs", () => {
  const artifact = { ...fixtures.reactivated_cg,
    incident: { ...fixtures.reactivated_cg.incident, eventTimeMs: Date.parse("2026-10-06T13:38:00Z") } };
  const result = preview(artifact, "Beynam, Balâ");
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.composer.dateTimeText, "6 Ekim 2026, 16:48 TSİ");
});

test("reactivation, freshness, and cost diagnostics remain out of public wording", () => {
  const result = preview(fixtures.reactivated_cg, "Beynam, Balâ");
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.triggerMode, "reactivated_after_stale_publish");
  assert.equal(result.mapUrl, "https://www.google.com/maps?q=39.682564,32.859372");
  assert.equal(result.composer.dateTimeText, "6 Ekim 2026, 16:48 TSİ");
  assert.doesNotMatch(result.text, /reactivat|stale|fresh|240000|540000|token|cost|Xweather|endpoint|provider/i);
  assert.match(result.text, /yere ulaşan yıldırım/);
  const fresh = preview({ ...fixtures.reactivated_cg, triggerMode: "fresh_would_publish" }, "Beynam, Balâ");
  assert.equal(fresh.ok, true);
  if (fresh.ok) assert.equal(result.text, fresh.text);
});

test("missing location preserves the composer structured error", () => {
  const result = preview(fixtures.cg_verified, null);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, "composer_error");
  assert.equal(result.composer?.error.code, "missing_location");
  assert.equal(result.text, null);
  assert.equal(result.mapUrl, null);
});

test("missing selected CG coordinates preserves the composer structured error", () => {
  const artifact = { ...fixtures.cg_verified, enrichment: { ...fixtures.cg_verified.enrichment, match: undefined } };
  const result = preview(artifact);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.composer?.error.code, "missing_cg_match");
  assert.equal(result.text, null);
});

test("no-pair and malformed artifacts produce adapter errors without fabricated posts", () => {
  for (const status of ["no_publish_candidate", "no_fresh_publish_candidate"] as const) {
    const result = preview({ status });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.sourceStatus, status);
      assert.equal(result.error.code, "not_paired_result");
      assert.equal(result.text, null);
    }
  }
  for (const artifact of [fixtures.malformed, null, { status: "paired_result", incident: { incidentId: "bad" } },
    { ...fixtures.cg_verified, enrichment: { status: "unsupported" } }]) {
    const result = preview(artifact);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, "malformed_paired_artifact");
  }
});

test("same paired artifact and label always produce identical preview text", () => {
  const a = preview(fixtures.reactivated_cg, "Beynam, Balâ");
  const b = preview(fixtures.reactivated_cg, "Beynam, Balâ");
  assert.deepEqual(a, b);
});

test("adapter has no provider/network/reverse-geocoding/publisher or production imports", async () => {
  const root = dirname(fileURLToPath(import.meta.url));
  for (const file of ["adapter.ts", "runner.ts", "fixtures.ts"]) {
    const source = await readFile(resolve(root, file), "utf8");
    assert.doesNotMatch(source, /from ["'][^"']*(xweather|nominatim|reverse-geocode|normalize|publisher|twitter|src\/)/i);
    assert.doesNotMatch(source, /\bfetch\s*\(|\bWebSocket\s*\(/);
  }
  const pending = [resolve(root, "../../src")];
  while (pending.length) {
    const directory = pending.pop()!;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (/\.tsx?$/.test(entry.name)) {
        assert.doesNotMatch(await readFile(path, "utf8"), /lightning-message-preview|previewPairedMessage/);
      }
    }
  }
});
