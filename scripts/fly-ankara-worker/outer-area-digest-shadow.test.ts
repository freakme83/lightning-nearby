import assert from "node:assert/strict";
import test from "node:test";
import {
  OuterAreaDigestShadow,
  OUTER_AREA_DIGEST_MIN_INCIDENTS,
  OUTER_AREA_DIGEST_MIN_LOCALITIES,
  OUTER_AREA_DIGEST_WINDOW_MS,
} from "./outer-area-digest-shadow.ts";

const shimsek = (locality: string, district: string) =>
  `#ŞİMŞEK\nAnkara’da, 12 Ekim 2026, 16:00 TSİ\n${locality} / ${district} civarında şimşek kaydedildi.`;
const yildirim = (locality: string, district: string) =>
  `#YILDIRIM\nAnkara’da, 12 Ekim 2026, 16:00 TSİ\n${locality} / ${district} civarında yere ulaşan yıldırım kaydedildi.\n\n40.000, 33.000`;

test("outer-area shadow becomes eligible at 3 incidents across 2 localities", () => {
  const shadow = new OuterAreaDigestShadow();
  const t0 = 1_000_000;
  assert.equal(OUTER_AREA_DIGEST_MIN_INCIDENTS, 3);
  assert.equal(OUTER_AREA_DIGEST_MIN_LOCALITIES, 2);
  assert.equal(shadow.observePublication({ incidentId: "i-1", atMs: t0, messageText: shimsek("Kızılca", "Çubuk") })?.eligible, false);
  assert.equal(shadow.observePublication({ incidentId: "i-2", atMs: t0 + 10_000, messageText: shimsek("Kızılca", "Çubuk") })?.eligible, false);
  const result = shadow.observePublication({ incidentId: "i-3", atMs: t0 + 20_000, messageText: shimsek("Yukarı Örenler", "Çubuk") });
  assert.equal(result?.eligible, true);
  assert.equal(result?.newlyEligible, true);
  assert.deepEqual(result?.localities, ["Kızılca", "Yukarı Örenler"]);
  assert.equal(result?.wouldSuppressIndividualShimsekCount, 3);
  assert.equal(shadow.summary().outerAreaEligibleDigests, 1);
});

test("same-locality incidents do not qualify as a regional digest", () => {
  const shadow = new OuterAreaDigestShadow();
  for (let i = 0; i < 3; i++) {
    const result = shadow.observePublication({ incidentId: `i-${i}`, atMs: 2_000_000 + i * 1000, messageText: shimsek("Kızılca", "Çubuk") });
    if (i === 2) {
      assert.equal(result?.eligible, false);
      assert.equal(result?.reason, "insufficient_localities");
    }
  }
});

test("central/non-Ankara districts and every YILDIRIM bypass the digest shadow", () => {
  const shadow = new OuterAreaDigestShadow();
  assert.equal(shadow.observePublication({ incidentId: "central", atMs: 3_000_000, messageText: shimsek("Ayrancı", "Çankaya") }), null);
  assert.equal(shadow.observePublication({ incidentId: "outside", atMs: 3_000_500, messageText: shimsek("Kömüşini", "Kulu") }), null);
  assert.equal(shadow.observePublication({ incidentId: "cg", atMs: 3_001_000, messageText: yildirim("Kızılca", "Çubuk") }), null);
  assert.equal(shadow.summary().outerAreaIgnoredNonOuterDistrict, 2);
  assert.equal(shadow.summary().outerAreaIgnoredCg, 1);
});

test("candidates expire outside the rolling 90-minute window", () => {
  const shadow = new OuterAreaDigestShadow();
  const t0 = 4_000_000;
  shadow.observePublication({ incidentId: "old-1", atMs: t0, messageText: shimsek("Kızılca", "Çubuk") });
  shadow.observePublication({ incidentId: "old-2", atMs: t0 + 1000, messageText: shimsek("Yukarı Örenler", "Çubuk") });
  const result = shadow.observePublication({ incidentId: "fresh", atMs: t0 + OUTER_AREA_DIGEST_WINDOW_MS + 2000, messageText: shimsek("Kızılbey", "Çubuk") });
  assert.equal(result?.incidentCount, 1);
  assert.equal(result?.eligible, false);
});

test("eligible digest starts a district cooldown and CG still bypasses it", () => {
  const shadow = new OuterAreaDigestShadow();
  const t0 = 5_000_000;
  shadow.observePublication({ incidentId: "i-1", atMs: t0, messageText: shimsek("Kızılca", "Çubuk") });
  shadow.observePublication({ incidentId: "i-2", atMs: t0 + 1000, messageText: shimsek("Yukarı Örenler", "Çubuk") });
  const eligible = shadow.observePublication({ incidentId: "i-3", atMs: t0 + 2000, messageText: shimsek("Kızılbey", "Çubuk") });
  assert.equal(eligible?.eligible, true);
  const held = shadow.observePublication({ incidentId: "i-4", atMs: t0 + 3000, messageText: shimsek("Mutlu", "Çubuk") });
  assert.equal(held?.eligible, false);
  assert.equal(held?.reason, "digest_cooldown");
  assert.equal(shadow.observePublication({ incidentId: "cg", atMs: t0 + 4000, messageText: yildirim("Mutlu", "Çubuk") }), null);
});

test("duplicate observation of the same incident does not increase the threshold", () => {
  const shadow = new OuterAreaDigestShadow();
  const text = shimsek("Kızılca", "Çubuk");
  shadow.observePublication({ incidentId: "i-1", atMs: 6_000_000, messageText: text });
  const result = shadow.observePublication({ incidentId: "i-1", atMs: 6_001_000, messageText: text });
  assert.equal(result?.incidentCount, 1);
});
