import assert from "node:assert/strict";
import test from "node:test";
import { evaluateOuterDistrictCooldown, OUTER_DISTRICT_NON_CG_COOLDOWN_MS, resolveOuterDistrict } from "./policy.ts";

test("only the explicit Ankara district allowlist resolves, with Balâ/Bala canonicalized", () => {
  for (const value of ["Balâ", "Bala"]) {
    assert.deepEqual(resolveOuterDistrict({ district: value, province: "Ankara" }),
      { outcome: "target", canonicalDistrict: "Balâ" });
  }
  for (const district of ["Şereflikoçhisar", "Haymana", "Polatlı", "Beypazarı", "Nallıhan",
    "Güdül", "Çamlıdere", "Kızılcahamam", "Çubuk", "Kalecik"]) {
    assert.equal(resolveOuterDistrict({ district, province: "Ankara" }).outcome, "target");
  }
  assert.equal(resolveOuterDistrict({ district: "Çankaya", province: "Ankara" }).outcome, "not_applicable_district");
  assert.equal(resolveOuterDistrict({ district: "Kulu", province: "Konya" }).outcome, "not_applicable_district");
  assert.equal(resolveOuterDistrict({ district: "Haymana" }).outcome, "location_unavailable");
  assert.equal(resolveOuterDistrict({ province: "Ankara" }).outcome, "location_unavailable");
});


test("town locality can identify only an allowlisted Ankara district, conservatively", () => {
  assert.deepEqual(resolveOuterDistrict({ locality: "Haymana", localityKind: "town", province: "Ankara" }),
    { outcome: "target", canonicalDistrict: "Haymana" });
  assert.deepEqual(resolveOuterDistrict({ neighborhood: "Güzelcekale", locality: "Haymana",
    localityKind: "town", province: "Ankara" }), { outcome: "target", canonicalDistrict: "Haymana" });
  assert.equal(resolveOuterDistrict({ locality: "Haymana", localityKind: "village", province: "Ankara" }).outcome,
    "location_unavailable");
  assert.equal(resolveOuterDistrict({ locality: "Çankaya", localityKind: "town", province: "Ankara" }).outcome,
    "not_applicable_district");
  assert.deepEqual(resolveOuterDistrict({ district: "Haymana", province: "Ankara" }),
    { outcome: "target", canonicalDistrict: "Haymana" });
  assert.deepEqual(resolveOuterDistrict({ district: "Bala", province: "Ankara" }),
    { outcome: "target", canonicalDistrict: "Balâ" });
  assert.deepEqual(resolveOuterDistrict({ district: "Haymana", locality: "Bala", localityKind: "town",
    province: "Ankara" }), { outcome: "location_unavailable" });
  assert.deepEqual(resolveOuterDistrict({ district: "Bala", locality: "Balâ", localityKind: "town",
    province: "Ankara" }), { outcome: "target", canonicalDistrict: "Balâ" });
});

test("cooldown holds strictly before 120 minutes and allows at the boundary", () => {
  const start = Date.parse("2026-10-12T14:00:00.000Z");
  assert.deepEqual(evaluateOuterDistrictCooldown(start, null), {
    outcome: "allowed_no_prior_publication", elapsedMs: null, remainingMs: null,
  });
  for (const elapsed of [60 * 60_000, OUTER_DISTRICT_NON_CG_COOLDOWN_MS - 1]) {
    const decision = evaluateOuterDistrictCooldown(start + elapsed, start);
    assert.equal(decision.outcome, "held_within_cooldown");
    assert.equal(decision.remainingMs, OUTER_DISTRICT_NON_CG_COOLDOWN_MS - elapsed);
  }
  for (const elapsed of [OUTER_DISTRICT_NON_CG_COOLDOWN_MS, OUTER_DISTRICT_NON_CG_COOLDOWN_MS + 60_000]) {
    assert.deepEqual(evaluateOuterDistrictCooldown(start + elapsed, start), {
      outcome: "allowed_cooldown_elapsed", elapsedMs: elapsed, remainingMs: null,
    });
  }
});
