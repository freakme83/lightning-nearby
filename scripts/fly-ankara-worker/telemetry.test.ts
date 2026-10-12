import assert from "node:assert/strict";
import { test } from "node:test";
import { cgProviderTelemetry } from "./telemetry.ts";
import { DEFAULT_THRESHOLDS, matchLightningEvents } from "../lightning-cg-enrichment/match.ts";
import type { XweatherLightningEvent, EnrichmentResult } from "../lightning-cg-enrichment/types.ts";

const now = 1_000_000;
const reference = { latitude: 40, longitude: 33, eventTimeMs: now };
const event = (id: string, overrides: Partial<XweatherLightningEvent> = {}): XweatherLightningEvent =>
  ({ ...reference, id, type: "cg", ...overrides });
const telemetry = (result: EnrichmentResult) => cgProviderTelemetry(result, now, now, 240_000);

test("provider result categories distinguish no-match, IC, current CG and unavailable reasons", () => {
  assert.equal(telemetry(matchLightningEvents(reference, [], DEFAULT_THRESHOLDS)).category, "no_match");
  const ic = telemetry(matchLightningEvents(reference, [event("ic", { type: "ic" })], DEFAULT_THRESHOLDS));
  assert.equal(ic.category, "ic_only"); assert.equal(ic.selectedCg, false);
  assert.equal(telemetry(matchLightningEvents(reference, [event("cg")], DEFAULT_THRESHOLDS)).category, "current_cg_verified");
  for (const failure of ["missing_credentials", "network_error", "http_error", "malformed_response"] as const) {
    const result = telemetry({ status: "provider_unavailable", provider: "xweather", reference, thresholds: DEFAULT_THRESHOLDS, failure });
    assert.equal(result.category, "provider_unavailable"); assert.equal(result.failure, failure);
    assert.equal(result.ambiguity, "provider_result_unavailable");
  }
});

test("returned CG spatial/temporal rejection counts retain overlapping reasons without changing matching", () => {
  const result = matchLightningEvents(reference, [event("far", { latitude: 40.09 }),
    event("old", { eventTimeMs: now - 300_001 }), event("both", { latitude: 40.09, eventTimeMs: now - 300_001 })], DEFAULT_THRESHOLDS);
  assert.equal(result.status, "no_match");
  assert.deepEqual(result.matchDiagnostics, { returnedCg: 3, returnedIc: 0, cgRejectedSpatial: 2, cgRejectedTemporal: 2, cgRejectedBoth: 1 });
  assert.equal(telemetry(result).selectedCg, false);
  assert.equal(telemetry(result).ambiguity, "limited_to_returned_provider_events");
});

test("currentness reports selected/reference age and delta; absent adapter diagnostics stay explicitly ambiguous", () => {
  const old = telemetry(matchLightningEvents(reference, [event("old", { eventTimeMs: now - 61_000 })], DEFAULT_THRESHOLDS));
  assert.equal(old.category, "selected_event_not_current");
  assert.deepEqual(old.currentnessDetails, ["selected_reference_delta_exceeded"]);
  assert.equal(old.referenceTimeDeltaMs, 61_000);
  const result = matchLightningEvents(reference, [event("cg")], DEFAULT_THRESHOLDS);
  delete result.matchDiagnostics;
  assert.equal(telemetry(result).ambiguity, "returned_event_rejections_not_available");
  const stale = cgProviderTelemetry(result, now, now + 240_001, 240_000);
  assert.deepEqual(stale.currentnessDetails, ["selected_event_too_old", "reference_too_old"]);
});
