import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluateFirstCgTransitionShadow } from "./admission.ts";
import { cgMetadata } from "./test-fixtures.ts";
import { DEFAULT_THRESHOLDS } from "../lightning-cg-enrichment/match.ts";
import type { EnrichmentResult } from "../lightning-cg-enrichment/types.ts";

const now = Date.parse("2026-10-11T14:00:00Z");
function input() {
  const metadata = cgMetadata();
  const enrichment: EnrichmentResult = { status: "cg_verified", provider: "xweather", thresholds: DEFAULT_THRESHOLDS,
    reference: { latitude: metadata.latitude, longitude: metadata.longitude, eventTimeMs: now },
    match: { id: "selected", type: "cg", latitude: metadata.latitude, longitude: metadata.longitude,
      eventTimeMs: now, distanceKm: 0, timeDifferenceMs: 0 } };
  return { enrichment, metadata, admission: { outcome: "suppressed" as const, reason: "no_positive_cg_history", rollingCount: 0 },
    referenceTimeMs: now, nowMs: now, maxAgeMs: 240_000, providerDuplicatePassed: true as boolean | null, otherBlockers: [] as string[] };
}

test("first-CG shadow qualifies only the empty-history rejection and leaves inputs unchanged", () => {
  const request = input(); const before = structuredClone(request);
  const shadow = evaluateFirstCgTransitionShadow(request);
  assert.equal(shadow.eligible, true); assert.equal(shadow.shadowOnly, true);
  assert.equal(shadow.policy, "first_cg_transition");
  assert.deepEqual(shadow.otherBlockers, []); assert.deepEqual(request, before);
});

test("duplicates, unverified/invalid/currentness failures and other gates cannot become shadow eligible", () => {
  const cases = [
    (x: ReturnType<typeof input>) => { x.providerDuplicatePassed = false; },
    (x: ReturnType<typeof input>) => { x.providerDuplicatePassed = null; },
    (x: ReturnType<typeof input>) => { x.otherBlockers = ["source_unhealthy"]; },
    (x: ReturnType<typeof input>) => { x.admission.reason = "burst_limit"; },
    (x: ReturnType<typeof input>) => { x.metadata.semanticIdentity = { available: false, reason: "missing_provenance" }; },
    (x: ReturnType<typeof input>) => { x.enrichment.status = "no_match"; },
    (x: ReturnType<typeof input>) => { x.enrichment.match!.id = ""; },
    (x: ReturnType<typeof input>) => { x.enrichment.match!.eventTimeMs = now - 60_001; },
    (x: ReturnType<typeof input>) => { x.enrichment.match!.eventTimeMs = now + 1; },
    (x: ReturnType<typeof input>) => { x.nowMs = now + 240_001; },
  ];
  for (const modify of cases) { const request = input(); modify(request);
    const shadow = evaluateFirstCgTransitionShadow(request); assert.equal(shadow.eligible, false);
    assert.ok(shadow.otherBlockers.length > 0); }
});
