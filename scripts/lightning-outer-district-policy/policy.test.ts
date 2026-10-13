import assert from "node:assert/strict";
import test from "node:test";
import { resolveOuterDistrict } from "./policy.ts";

test("only the explicit Ankara district allowlist resolves, with Bala canonicalized", () => {
  for (const value of ["Balâ", "Bala"]) {
    assert.deepEqual(resolveOuterDistrict({ district: value, province: "Ankara" }),
      { outcome: "target", canonicalDistrict: "Balâ" });
  }
  for (const district of ["Şereflikoçhisar", "Haymana", "Polatlı", "Beypazarı", "Nallıhan",
    "Güdül", "Çamlıdere", "Kızılcahamam", "Çubuk", "Kalecik", "Evren"]) {
    assert.equal(resolveOuterDistrict({ district, province: "Ankara" }).outcome, "target");
  }
  assert.equal(resolveOuterDistrict({ district: "Çankaya", province: "Ankara" }).outcome, "not_applicable_district");
  assert.equal(resolveOuterDistrict({ district: "Kulu", province: "Konya" }).outcome, "not_applicable_district");
  assert.equal(resolveOuterDistrict({ district: "Haymana" }).outcome, "location_unavailable");
  assert.equal(resolveOuterDistrict({ province: "Ankara" }).outcome, "location_unavailable");
});

test("town locality identifies a selected district, but village locality does not", () => {
  assert.deepEqual(resolveOuterDistrict({ locality: "Haymana", localityKind: "town", province: "Ankara" }),
    { outcome: "target", canonicalDistrict: "Haymana" });
  assert.deepEqual(resolveOuterDistrict({ neighborhood: "Güzelcekale", locality: "Haymana",
    localityKind: "town", province: "Ankara" }), { outcome: "target", canonicalDistrict: "Haymana" });
  assert.equal(resolveOuterDistrict({ locality: "Haymana", localityKind: "village", province: "Ankara" }).outcome,
    "location_unavailable");
  assert.equal(resolveOuterDistrict({ locality: "Çankaya", localityKind: "town", province: "Ankara" }).outcome,
    "not_applicable_district");
});

test("town-level Evren locality resolves as the selected district", () => {
  assert.deepEqual(resolveOuterDistrict({ locality: "Evren", localityKind: "town", province: "Ankara" }),
    { outcome: "target", canonicalDistrict: "Evren" });
});

test("conflicting selected district and town identities remain unavailable", () => {
  assert.deepEqual(resolveOuterDistrict({ district: "Haymana", locality: "Bala", localityKind: "town",
    province: "Ankara" }), { outcome: "location_unavailable" });
  assert.deepEqual(resolveOuterDistrict({ district: "Bala", locality: "Balâ", localityKind: "town",
    province: "Ankara" }), { outcome: "target", canonicalDistrict: "Balâ" });
});
