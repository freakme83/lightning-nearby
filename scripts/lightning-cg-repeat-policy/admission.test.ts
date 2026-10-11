import { cgMetadata, cgRecord } from "./test-fixtures.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluateCgRepeat, selectedRepeatEventCheck } from "./admission.ts";
import { CG_REPEAT_BURST_WINDOW_MINUTES, CG_REPEAT_MAX_ADMISSIONS_PER_WINDOW,
  CG_REPEAT_URBAN_MIN_DISTANCE_KM, CG_REPEAT_RURAL_MIN_DISTANCE_KM } from "./constants.ts";
import type { EnrichmentResult } from "../lightning-cg-enrichment/types.ts";
import { DEFAULT_THRESHOLDS } from "../lightning-cg-enrichment/match.ts";

const now = Date.parse("2026-10-11T14:00:00Z");

for (const [name, place, distance, kind, expected, reason] of [
  ["same Ayrancı after five minutes", "Ayrancı", 1.4, "urban", false, "same_semantic_location"],
  ["Balgat 800 m", "Balgat", 0.8, "urban", false, "distance_below_threshold"],
  ["Balgat 1.4 km", "Balgat", 1.4, "urban", true, "eligible"],
  ["village B 2 km", "Village B", 2, "rural", false, "distance_below_threshold"],
  ["village B 7 km", "Village B", 7, "rural", true, "eligible"],
  ["unknown 1.4 km", "Unknown B", 1.4, "unknown", false, "distance_below_threshold"],
  ["unknown 7 km", "Unknown B", 7, "unknown", true, "eligible"],
] as const) test(name, () => {
  const prior = cgRecord("one", kind === "rural" ? "Village A" : "Ayrancı", 0, "scope-a", now - 300_000, kind);
  const outcome = evaluateCgRepeat(cgMetadata(place, distance, kind), [prior], "scope-a", now);
  assert.equal(outcome.eligible, expected); assert.equal(outcome.reason, reason);
  if (outcome.reason === "distance_below_threshold") assert.equal(outcome.thresholdKm, kind === "urban" ? 1 : 5);
});

test("district fallback, distinct reliable parent and mixed classification", () => {
  const previous = cgRecord("one", "", 0);
  previous.cgMetadata = cgMetadata("", 0, "urban", "Çankaya");
  assert.equal(evaluateCgRepeat(cgMetadata("", 1.4, "urban", "Yenimahalle"), [previous], "scope-a", now).eligible, true);
  assert.equal(evaluateCgRepeat(cgMetadata("Ayrancı", 1.4, "urban", "Yenimahalle"), [cgRecord("one", "Ayrancı")], "scope-a", now).eligible, true);
  assert.equal(evaluateCgRepeat(cgMetadata("Balgat", 1.4), [cgRecord("one", "Village A", 0, "scope-a", now, "rural")], "scope-a", now).eligible, false);
});

test("missing neighborhood within the same parent is not proof of semantic change", () => {
  const prior = cgRecord("one", "Ayrancı");
  assert.equal(evaluateCgRepeat(cgMetadata("", 7), [prior], "scope-a", now).reason, "semantic_change_unproven");
  const village = cgRecord("village", "Beynam", 0, "scope-a", now, "rural");
  const center = cgMetadata("", 7); center.location.rawType = "town";
  assert.equal(evaluateCgRepeat(center, [village], "scope-a", now).eligible, true);
  center.location.rawType = "road";
  assert.equal(evaluateCgRepeat(center, [village], "scope-a", now).reason, "semantic_change_unproven");
});

test("all places, pending/approved reservations and missing identity fail conservatively", () => {
  const history = [cgRecord("one", "Ayrancı"), cgRecord("two", "Balgat", 1.4)];
  assert.equal(evaluateCgRepeat(cgMetadata("Ayrancı", 5), history, "scope-a", now).reason, "same_semantic_location");
  const unknown = cgMetadata("Balgat", 7); unknown.semanticIdentity = { available: false, reason: "ambiguous_hierarchy" };
  assert.equal(evaluateCgRepeat(unknown, history, "scope-a", now).reason, "semantic_identity_unavailable");
  history[0].cgMetadata = null;
  assert.equal(evaluateCgRepeat(cgMetadata("B", 7), history, "scope-a", now).reason, "history_unavailable");
});

test("three total, exact rolling expiry, and separate scope", () => {
  const history = [cgRecord("one", "A", 0, "scope-a", now - 1_200_000),
    cgRecord("two", "B", 1.4), cgRecord("three", "C", 2.8)];
  assert.equal(evaluateCgRepeat(cgMetadata("D", 4.2), history, "scope-a", now).eligible, true);
  history[0].recordedAt = new Date(now - 1_199_999).toISOString();
  assert.equal(evaluateCgRepeat(cgMetadata("D", 4.2), history, "scope-a", now).reason, "burst_limit");
  assert.equal(evaluateCgRepeat(cgMetadata("D", 4.2), history, "scope-b", now).rollingCount, 0);
  assert.equal(evaluateCgRepeat(cgMetadata("D", 4.2), [], "scope-b", now).reason, "no_positive_cg_history");
});

test("centroid and public rounding cannot influence full-precision selected distance", () => {
  const prior = cgRecord("one", "A"); prior.incidentLatitude = 80; prior.incidentLongitude = -90;
  assert.equal(evaluateCgRepeat(cgMetadata("B", 0.9999), [prior], "scope-a", now).eligible, false);
  assert.equal(evaluateCgRepeat(cgMetadata("B", 1.0001), [prior], "scope-a", now).eligible, true);
});

test("selected event identity, outcome and explicit novelty window", () => {
  const result: EnrichmentResult = { status: "cg_verified", provider: "xweather", reference: { latitude: 39.9, longitude: 32.85, eventTimeMs: now },
    thresholds: DEFAULT_THRESHOLDS, match: { id: "new", type: "cg", latitude: 39.9, longitude: 32.85,
      eventTimeMs: now, distanceKm: 0, timeDifferenceMs: 0 } };
  assert.equal(selectedRepeatEventCheck(result, now, now, 240_000), null);
  for (const status of ["ic_only", "no_match", "provider_unavailable"] as const)
    assert.equal(selectedRepeatEventCheck({ ...result, status }, now, now, 240_000), "not_verified_cg");
  assert.equal(selectedRepeatEventCheck({ ...result, match: { ...result.match!, id: " " } }, now, now, 240_000), "missing_provider_identity");
  for (const eventTimeMs of [now - 60_001, now + 1, now - 300_000])
    assert.equal(selectedRepeatEventCheck({ ...result, match: { ...result.match!, eventTimeMs } }, now, now, 240_000), "selected_event_not_current");
});

test("named database policy defaults", () => assert.deepEqual([CG_REPEAT_URBAN_MIN_DISTANCE_KM,
  CG_REPEAT_RURAL_MIN_DISTANCE_KM, CG_REPEAT_BURST_WINDOW_MINUTES, CG_REPEAT_MAX_ADMISSIONS_PER_WINDOW], [1, 5, 20, 3]));
