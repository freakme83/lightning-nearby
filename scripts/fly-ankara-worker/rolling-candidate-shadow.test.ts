import assert from "node:assert/strict";
import { test } from "node:test";
import type { ClusterObservation, LightningIncident } from "../lightning-incident-lifecycle/types.ts";
import { RollingCandidateWindowShadow } from "./rolling-candidate-shadow.ts";

const start = Date.parse("2026-10-15T09:00:00.000Z");
const minute = 60_000;

function incident(status: LightningIncident["status"], totalEvents: number,
  overrides: Partial<LightningIncident> = {}): LightningIncident {
  return {
    id: "i-rolling", sourceClusterIds: ["c-rolling"], status,
    firstEventTimeMs: start, lastActivityTimeMs: start, totalEvents,
    representativeLatitude: 39.9, representativeLongitude: 32.6, publishCount: 0,
    ...overrides,
  };
}

function observation(atMinutes: number): ClusterObservation {
  return { sourceClusterId: "c-rolling", eventTimeMs: start + atMinutes * minute,
    receivedAtMs: start + atMinutes * minute, latitude: 39.9, longitude: 32.6 };
}

test("normal production three-in-ten agrees without a missed-promotion event", () => {
  const shadow = new RollingCandidateWindowShadow(3, 10);
  assert.deepEqual(shadow.observe(observation(0), incident("candidate", 1)), []);
  assert.deepEqual(shadow.observe(observation(4), incident("candidate", 2)), []);
  const promoted = incident("active", 3, { promotedAtMs: start + 8 * minute, lastActivityTimeMs: start + 8 * minute });
  assert.deepEqual(shadow.observe(observation(8), promoted), []);
  assert.deepEqual(shadow.counters, {
    rollingCandidateEvaluations: 3, productionExpiredWhileRollingViable: 0,
    rollingShadowPromotions: 0, rollingShadowPromotionsAfterProductionExpiry: 0,
    productionAndRollingBothPromoted: 1,
  });
});

test("a recovered candidate represented by an existing active incident is not a missed promotion", () => {
  const shadow = new RollingCandidateWindowShadow(3, 10);
  shadow.observe(observation(0), incident("candidate", 1));
  shadow.observe(observation(4), incident("candidate", 2));
  shadow.productionExpired(incident("closed", 2,
    { closedAtMs: start + 10 * minute, closeReason: "candidate_expired" }), start + 10 * minute);
  const represented = incident("closed", 3,
    { closedAtMs: start + 10 * minute, closeReason: "candidate_expired" });
  assert.deepEqual(shadow.observe({ ...observation(8), receivedAtMs: start + 11 * minute }, represented, true), []);
  assert.equal(shadow.counters.productionAndRollingBothPromoted, 1);
  assert.equal(shadow.counters.rollingShadowPromotions, 0);
});

test("expired candidate remains below rolling threshold when the oldest event falls out", () => {
  const shadow = new RollingCandidateWindowShadow(3, 10);
  shadow.observe(observation(0), incident("candidate", 1));
  shadow.observe(observation(4), incident("candidate", 2));
  const expired = incident("closed", 2, { closedAtMs: start + 10 * minute, closeReason: "candidate_expired" });
  const stateEvents = shadow.productionExpired(expired, start + 10 * minute);
  assert.equal(stateEvents.length, 1);
  assert.equal(stateEvents[0].kind, "rolling_candidate_shadow_state");
  assert.equal(stateEvents[0].fields.rollingEventCount, 2);
  assert.deepEqual(shadow.observe(observation(10 + 7 / 60),
    incident("closed", 3, { closedAtMs: start + 10 * minute, closeReason: "candidate_expired" })), []);
  assert.equal(shadow.counters.rollingShadowPromotions, 0);
});

test("rolling evidence can emit one shadow-only promotion after production expiry", () => {
  const shadow = new RollingCandidateWindowShadow(3, 10);
  shadow.observe(observation(0), incident("candidate", 1));
  shadow.observe(observation(4), incident("candidate", 2));
  const expired = incident("closed", 2, { closedAtMs: start + 10 * minute, closeReason: "candidate_expired" });
  shadow.productionExpired(expired, start + 10 * minute);
  shadow.observe(observation(10 + 7 / 60),
    incident("closed", 3, { closedAtMs: start + 10 * minute, closeReason: "candidate_expired" }));
  const events = shadow.observe(observation(11),
    incident("closed", 4, { closedAtMs: start + 10 * minute, closeReason: "candidate_expired" }));
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, "rolling_candidate_shadow_promotion");
  assert.deepEqual(events[0].fields, {
    incidentId: "i-rolling", candidateId: "i-rolling", clusterIds: ["c-rolling"],
    rollingEventCount: 3, promotionThreshold: 3, rollingWindowMinutes: 10,
    oldestRollingEventTimeMs: start + 4 * minute, newestRollingEventTimeMs: start + 11 * minute,
    rollingSpanSeconds: 420, productionState: "candidate_expired",
    productionCandidateExpiredAtMs: start + 10 * minute, secondsAfterProductionExpiry: 60,
    productionHadPromoted: false, additionalToProduction: true, shadowOnly: true,
  });
  assert.deepEqual(shadow.observe(observation(11.5),
    incident("closed", 5, { closedAtMs: start + 10 * minute, closeReason: "candidate_expired" })), []);
  assert.equal(shadow.counters.rollingShadowPromotions, 1);
  assert.equal(shadow.counters.rollingShadowPromotionsAfterProductionExpiry, 1);
});

test("lifetime count above threshold does not substitute for a rolling three-in-ten window", () => {
  const shadow = new RollingCandidateWindowShadow(3, 10);
  shadow.observe(observation(0), incident("candidate", 1));
  shadow.observe(observation(1), incident("candidate", 2));
  shadow.productionExpired(incident("closed", 2,
    { closedAtMs: start + 10 * minute, closeReason: "candidate_expired" }), start + 10 * minute);
  const result = shadow.observe(observation(11.1), incident("closed", 3,
    { closedAtMs: start + 10 * minute, closeReason: "candidate_expired" }));
  assert.deepEqual(result, []);
  assert.equal(shadow.counters.rollingShadowPromotions, 0);
});

test("incident state and deduplication remain isolated", () => {
  const shadow = new RollingCandidateWindowShadow(3, 10);
  shadow.observe(observation(0), incident("candidate", 1));
  shadow.observe(observation(2), incident("candidate", 2));
  const otherObservation = { ...observation(3), sourceClusterId: "c-other" };
  const otherIncident = { ...incident("candidate", 1), id: "i-other", sourceClusterIds: ["c-other"] };
  assert.deepEqual(shadow.observe(otherObservation, otherIncident), []);
  assert.equal(shadow.counters.rollingShadowPromotions, 0);
  shadow.forgetIncident("i-rolling");
  assert.deepEqual(shadow.observe(observation(4), incident("candidate", 1)), []);
});
