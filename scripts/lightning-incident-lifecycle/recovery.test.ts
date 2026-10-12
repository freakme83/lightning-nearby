import assert from "node:assert/strict";
import { test } from "node:test";
import { IncidentLifecycleEngine } from "./incident-engine.ts";
import { DryRunPublishPolicy } from "./publish-policy.ts";
import { applyTransitions } from "./experiment.ts";
import { INCIDENT_POLICY_PROFILES } from "./types.ts";

const start = 1_000_000;
const minute = 60_000;
function setup() {
  const profile = INCIDENT_POLICY_PROFILES[1];
  const engine = new IncidentLifecycleEngine(profile, start);
  engine.setSourceHealth({ state: "live", lastFrameAtMs: start }, start);
  const policy = new DryRunPublishPolicy(profile);
  const feed = (at: number, cluster = "failed") => engine.observe({ sourceClusterId: cluster,
    eventTimeMs: start + at * minute, receivedAtMs: start + at * minute, latitude: 40, longitude: 33 });
  const apply = (transitions: ReturnType<typeof feed>) => applyTransitions(transitions, policy, engine);
  return { engine, policy, feed, apply };
}

test("expired doubleton recovers once on a later rolling three-in-ten window, retaining its ID", () => {
  const f = setup(); f.apply(f.feed(0)); f.apply(f.feed(9));
  const id = f.engine.incidents[0].id;
  assert.equal(f.engine.tick(start + 10 * minute)[0].type, "candidate_expired");
  assert.equal(f.engine.incidents[0].totalEvents, 2);
  assert.deepEqual(f.feed(12), []);
  const recovered = f.feed(14);
  assert.deepEqual(recovered.map(t => t.type), ["candidate_recovered", "promoted"]);
  assert.equal(recovered[1].incident.id, id);
  assert.equal(recovered[1].incident.totalEvents, 4, "recovery observation is counted once");
  assert.equal(recovered[1].incident.closedAtMs, undefined);
  assert.equal(f.apply(recovered)[0].action, "WOULD_PUBLISH");
  for (const at of [15, 16, 17]) assert.equal(f.apply(f.feed(at))[0].reason, "already_published_active_incident");
  assert.equal(f.engine.metrics.incidentCandidatesCreated, 1);
  assert.equal(f.engine.metrics.candidatesExpired, 1);
  assert.equal(f.engine.metrics.candidatesRecovered, 1);
  assert.equal(f.engine.metrics.promotionsAfterRecovery, 1);
  assert.equal(f.engine.metrics.eventsAfterCandidateExpiry, 2);
  assert.equal(f.policy.metrics.publishCandidatesGenerated, 1);
});

test("continuing doubletons never promote and do not churn expired candidates", () => {
  const f = setup(); f.feed(0); f.feed(9); f.engine.tick(start + 10 * minute);
  for (const at of [18, 27, 36, 45]) { assert.deepEqual(f.feed(at), []); assert.deepEqual(f.engine.tick(start + at * minute), []); }
  assert.equal(f.engine.incidents[0].status, "closed");
  assert.equal(f.engine.metrics.incidentCandidatesCreated, 1);
  assert.equal(f.engine.metrics.candidatesExpired, 1);
  assert.equal(f.engine.metrics.candidatesRecovered, 0);
  assert.equal(f.engine.metrics.incidentsPromoted, 0);
});

test("recovered cluster joins an equivalent active published incident without a second promotion", () => {
  const f = setup(); f.feed(0); f.feed(9); f.engine.tick(start + 10 * minute);
  for (const at of [11, 11.01, 11.02]) f.apply(f.feed(at, "published"));
  assert.equal(f.policy.metrics.publishCandidatesGenerated, 1);
  f.feed(12);
  const recovery = f.feed(14);
  assert.deepEqual(recovery.map(t => t.type), ["candidate_recovered", "activity"]);
  assert.equal(f.apply(recovery)[0].reason, "already_published_active_incident");
  assert.equal(f.apply(f.feed(15))[0].reason, "already_published_active_incident");
  assert.equal(f.engine.metrics.incidentsPromoted, 1);
  assert.equal(f.engine.metrics.recoveredCandidatesAssociated, 1);
  assert.equal(f.engine.metrics.candidatesRecovered, 1);
  assert.equal(f.policy.metrics.publishCandidatesGenerated, 1);
});

test("recovered promotion still respects nearby cooldown and subsequent suppressed activity", () => {
  const f = setup(); for (const at of [0, 0.01, 0.02]) f.apply(f.feed(at, "published"));
  f.apply(f.engine.tick(start + 21 * minute));
  f.feed(22); f.feed(31); f.engine.tick(start + 32 * minute);
  f.feed(34);
  assert.equal(f.apply(f.feed(36))[0].reason, "nearby_cooldown");
  assert.equal(f.apply(f.feed(37))[0].reason, "already_active_suppressed_incident");
  assert.equal(f.engine.metrics.promotionsAfterRecovery, 1);
  assert.equal(f.policy.metrics.publishCandidatesGenerated, 1);
});

test("quiet-closed previously promoted identity remains closed and reports ignored events", () => {
  const f = setup(); for (const at of [0, 1, 2]) f.apply(f.feed(at));
  f.apply(f.engine.tick(start + 22 * minute));
  assert.deepEqual(f.feed(23), []);
  assert.equal(f.engine.metrics.eventsIgnoredClosed, 1);
  assert.equal(f.engine.metrics.candidatesRecovered, 0);
});

test("out-of-order recovery observations cannot recreate an old qualifying window", () => {
  const f = setup(); f.feed(0); f.feed(9); f.engine.tick(start + 10 * minute); f.feed(20);
  assert.deepEqual(f.feed(1), []);
  assert.deepEqual(f.feed(2), []);
  assert.equal(f.engine.metrics.candidatesRecovered, 0);
});
