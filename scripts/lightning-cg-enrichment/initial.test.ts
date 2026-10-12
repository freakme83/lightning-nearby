import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_THRESHOLDS, greatCircleDistanceKm } from "./match.ts";
import { enforceInitialCgAcceptance, matchInitialCgEvents } from "./initial.ts";
import { enrichInitialIncidentWithLightningType } from "./xweather.ts";
import type { EnrichmentReference, XweatherLightningEvent } from "./types.ts";

const now = 1_800_000_000_000;
const reference: EnrichmentReference = { latitude: 39.1, longitude: 32.9, eventTimeMs: now - 30_000 };
const cg = (id: string, patch: Partial<XweatherLightningEvent> = {}): XweatherLightningEvent =>
  ({ id, type: "cg", latitude: reference.latitude, longitude: reference.longitude,
    eventTimeMs: reference.eventTimeMs, ...patch });
const result = (events: XweatherLightningEvent[], ref = reference, at = now) => matchInitialCgEvents(ref, events, at);

test("initial association selects a current CG between the old 8 km cutoff and the queried 10 km", () => {
  const nearby = cg("elmadag-9km", { longitude: 33.004 });
  assert.ok(greatCircleDistanceKm(nearby, reference) > 8.5);
  assert.ok(greatCircleDistanceKm(nearby, reference) < 9.5);
  const selected = result([nearby]);
  assert.equal(selected.status, "cg_verified");
  assert.equal(selected.match?.id, "elmadag-9km");
  assert.equal(selected.initialCgDiagnostics?.outcome, "accepted");
  assert.equal(selected.initialCgDiagnostics?.selectedLatitude, nearby.latitude);
  assert.equal(selected.initialCgDiagnostics?.selectedLongitude, nearby.longitude);
  assert.equal(selected.initialCgDiagnostics?.selectedEventTimeMs, nearby.eventTimeMs);
  assert.equal(selected.initialCgDiagnostics?.selectedReferenceDeltaMs, 0);
  assert.equal(selected.initialCgDiagnostics?.selectedProviderAgeMs, 30_000);
});

test("initial association rejects spatial, reference-time and provider-age failures separately", () => {
  const far = result([cg("beyond-query", { longitude: 33.022 })]);
  assert.equal(far.status, "no_match");
  assert.equal(far.initialCgDiagnostics?.outcome, "rejected_spatial");
  assert.equal(far.initialCgDiagnostics?.rejectedSpatial, 1);
  assert.equal(far.initialCgDiagnostics?.selectedLatitude, null);
  assert.equal(far.initialCgDiagnostics?.selectedLongitude, null);
  assert.equal(far.initialCgDiagnostics?.selectedEventTimeMs, null);
  assert.equal(far.initialCgDiagnostics?.evaluatedProviderEventId, "beyond-query");

  const weak = result([cg("delta-175", { longitude: 32.97, eventTimeMs: reference.eventTimeMs - 175_000 })]);
  assert.equal(weak.status, "no_match");
  assert.equal(weak.initialCgDiagnostics?.outcome, "rejected_reference_time");
  assert.equal(weak.initialCgDiagnostics?.rejectedReferenceTime, 1);
  const within = result([cg("delta-130", { longitude: 32.97, eventTimeMs: reference.eventTimeMs - 130_000 })]);
  assert.equal(within.status, "cg_verified");

  const olderReference = { ...reference, eventTimeMs: now - 230_000 };
  const stale = result([cg("stale", { eventTimeMs: olderReference.eventTimeMs - 20_000 })], olderReference);
  assert.equal(stale.status, "no_match");
  assert.equal(stale.initialCgDiagnostics?.outcome, "rejected_provider_stale");
  assert.equal(stale.initialCgDiagnostics?.rejectedProviderStale, 1);
  const future = result([cg("future", { eventTimeMs: now + 1_000 })], { ...reference, eventTimeMs: now - 100_000 });
  assert.equal(future.initialCgDiagnostics?.outcome, "rejected_provider_stale");
});

test("only eligible CG candidates are ranked by reference delta, distance, then provider ID", () => {
  const a = cg("a-close-time", { longitude: 33.003, eventTimeMs: reference.eventTimeMs + 1_000 });
  const b = cg("b-close-space", { longitude: 32.91, eventTimeMs: reference.eventTimeMs + 2_000 });
  assert.equal(result([b, a]).match?.id, "a-close-time");
  const c = cg("c-near", { longitude: 32.91, eventTimeMs: reference.eventTimeMs + 1_000 });
  assert.equal(result([a, c]).match?.id, "c-near");
  const d = cg("a-id", { longitude: 32.91, eventTimeMs: reference.eventTimeMs + 1_000 });
  const ranked = result([c, d]);
  assert.equal(ranked.match?.id, "a-id");
  assert.equal(ranked.initialCgDiagnostics?.selectedProviderEventId, "a-id");
  assert.equal(ranked.initialCgDiagnostics?.selectedLatitude, d.latitude);
  assert.equal(ranked.initialCgDiagnostics?.selectedLongitude, d.longitude);
  assert.equal(ranked.initialCgDiagnostics?.selectedEventTimeMs, d.eventTimeMs);
  const differentlyTimed = result([b, a]);
  assert.equal(differentlyTimed.initialCgDiagnostics?.selectedLongitude, a.longitude);
  assert.equal(differentlyTimed.initialCgDiagnostics?.selectedEventTimeMs, a.eventTimeMs);
  const stale = cg("stale-best-delta", { eventTimeMs: now - 250_000 });
  const olderReference = { ...reference, eventTimeMs: now - 250_000 };
  const current = cg("current", { eventTimeMs: now - 130_000 });
  assert.equal(result([stale, current], olderReference).match?.id, "current");
});

test("very close CG wins, while IC-only and empty results retain the non-CG fallback", () => {
  assert.equal(result([cg("near-zero", { longitude: 32.90001 })]).match?.id, "near-zero");
  const ic = result([{ ...cg("ic"), type: "ic" }]);
  assert.equal(ic.status, "ic_only");
  assert.equal(ic.initialCgDiagnostics?.outcome, "no_cg_returned");
  const empty = result([]);
  assert.equal(empty.status, "no_match");
  assert.equal(empty.initialCgDiagnostics?.returnedCg, 0);
  assert.equal(empty.initialCgDiagnostics?.selectedLatitude, null);
  assert.equal(empty.initialCgDiagnostics?.selectedLongitude, null);
  assert.equal(empty.initialCgDiagnostics?.selectedEventTimeMs, null);
  const mixed = result([cg("far", { longitude: 33.022 }), { ...cg("ic"), type: "ic" }]);
  assert.equal(mixed.status, "ic_only");
});

test("a raw cg_verified match failing initial currentness cannot authorize CG composition", () => {
  const olderReference = { ...reference, eventTimeMs: now - 230_000 };
  const event = cg("raw-stale", { eventTimeMs: olderReference.eventTimeMs - 20_000 });
  const raw = { status: "cg_verified" as const, provider: "xweather" as const, reference: olderReference,
    thresholds: DEFAULT_THRESHOLDS, match: { ...event, distanceKm: 0, timeDifferenceMs: 20_000 } };
  const checked = enforceInitialCgAcceptance(raw, now);
  assert.equal(checked.status, "no_match");
  assert.equal(checked.match, undefined);
  assert.equal(checked.initialCgDiagnostics?.outcome, "rejected_provider_stale");
  assert.equal(checked.initialCgDiagnostics?.selectedLatitude, null);
  assert.equal(checked.initialCgDiagnostics?.selectedLongitude, null);
  assert.equal(checked.initialCgDiagnostics?.selectedEventTimeMs, null);
  assert.equal(checked.initialCgDiagnostics?.evaluatedProviderEventId, "raw-stale");
  assert.equal(enforceInitialCgAcceptance({ ...raw, status: "provider_unavailable", match: undefined }, now).status,
    "provider_unavailable");
});

test("initial provider adapter makes one 10 km query and selects from all returned CGs", async () => {
  let calls = 0;
  const selected = await enrichInitialIncidentWithLightningType(reference, {
    now: () => now,
    env: { XWEATHER_CLIENT_ID: "id", XWEATHER_CLIENT_SECRET: "secret" },
    fetch: async input => {
      calls++;
      assert.equal(new URL(String(input)).searchParams.get("radius"), "10km");
      const response = [cg("near-9", { longitude: 33.004 }), cg("too-old", { eventTimeMs: now - 280_000 })]
        .map(event => ({ id: event.id, loc: { lat: event.latitude, long: event.longitude },
          ob: { timestampMS: event.eventTimeMs, pulse: { type: event.type } } }));
      return new Response(JSON.stringify({ success: true, response }), { status: 200 });
    },
  });
  assert.equal(calls, 1);
  assert.equal(selected.status, "cg_verified");
  assert.equal(selected.match?.id, "near-9");
  assert.equal(selected.initialCgDiagnostics?.returnedCg, 2);
  assert.equal(selected.matchDiagnostics?.cgRejectedSpatial, 1, "general 8 km diagnostics remain distinct");
  assert.equal(enforceInitialCgAcceptance(selected, now).initialCgDiagnostics?.returnedCg, 2);
});
