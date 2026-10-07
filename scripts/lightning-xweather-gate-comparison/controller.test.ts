import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";
import { DEFAULT_THRESHOLDS } from "../lightning-cg-enrichment/match.ts";
import type { EnrichmentReference, EnrichmentResult } from "../lightning-cg-enrichment/types.ts";
import { MAX_PAIRING_INCIDENT_AGE_MS } from "../lightning-cg-paired-validation/controller.ts";
import type { IncidentForPairing } from "../lightning-cg-paired-validation/types.ts";
import { readIncidentRunnerOptions } from "../lightning-incident-lifecycle/options.ts";
import { DryRunPublishPolicy } from "../lightning-incident-lifecycle/publish-policy.ts";
import { INCIDENT_POLICY_PROFILES } from "../lightning-incident-lifecycle/types.ts";
import { GateComparisonController, hypotheticalSummaryFlashRange } from "./controller.ts";

const NOW = 1_791_310_000_000;
const publish = (incidentId: string) => ({ action: "WOULD_PUBLISH" as const, incidentId });
function incident(id: string, ageMs = 1_000, status: IncidentForPairing["status"] = "active"): IncidentForPairing {
  return { id, status, representativeLatitude: 45.3, representativeLongitude: 0.12,
    firstEventTimeMs: NOW - 600_000, lastActivityTimeMs: NOW - ageMs,
    totalEvents: 3, sourceClusterIds: ["c-1"] };
}
function result(reference: EnrichmentReference, status: EnrichmentResult["status"], tokens?: number): EnrichmentResult {
  return { status, reference, provider: "xweather", thresholds: { ...DEFAULT_THRESHOLDS },
    ...(tokens === undefined ? {} : { cost: { tokens, multipliers: "endpoint=10; spatial=1; temporal=1" } }) };
}
function harness(maxXweatherCalls = 3, hasCredentials = true) {
  let calls = 0;
  let status: EnrichmentResult["status"] = "cg_verified";
  let tokens: number | undefined = 10;
  const events: { kind: string; data: Record<string, unknown> }[] = [];
  const controller = new GateComparisonController({ maxXweatherCalls, hasCredentials, nowMs: () => NOW,
    emit: (kind, data) => events.push({ kind, data }),
    enrich: async reference => { calls++; return result(reference, status, tokens); } });
  return { controller, events, get calls() { return calls; }, setStatus(value: EnrichmentResult["status"]) { status = value; },
    setTokens(value: number | undefined) { tokens = value; } };
}

test("no incident and stale/future/invalid publish triggers spend zero; stale activity does not stop observing", async () => {
  const h = harness();
  assert.equal(h.controller.snapshot().actualXweatherRequests, 0);
  assert.equal(h.controller.observeDecision(publish("stale"), incident("stale", MAX_PAIRING_INCIDENT_AGE_MS + 1)), false);
  assert.equal(h.controller.observeActivity(incident("stale", MAX_PAIRING_INCIDENT_AGE_MS + 1)), false);
  assert.equal(h.controller.observeDecision(publish("future"), incident("future", -1)), false);
  assert.equal(h.controller.observeDecision(publish("invalid"), incident("invalid", Number.NaN)), false);
  await h.controller.waitForCompletion();
  assert.equal(h.calls, 0);
  assert.equal(h.controller.snapshot().stalePublishTriggers, 1);
  assert.equal(h.controller.snapshot().futureDatedTriggers, 1);
  assert.equal(h.controller.snapshot().invalidTimeTriggers, 1);
});

test("fresh publish reserves one request; repeated same-incident decisions and activity never request twice", async () => {
  let resolve!: (value: EnrichmentResult) => void;
  let calls = 0;
  const h = new GateComparisonController({ nowMs: () => NOW, hasCredentials: true,
    enrich: reference => { calls++; return new Promise(done => { resolve = value => done({ ...value, reference }); }); } });
  assert.equal(h.observeDecision(publish("one"), incident("one")), true);
  assert.equal(h.observeDecision(publish("one"), incident("one")), false);
  assert.equal(h.observeActivity(incident("one", 0)), false);
  assert.equal(calls, 1);
  resolve(result({ latitude: 45.3, longitude: 0.12, eventTimeMs: NOW - 1_000 }, "cg_verified", 10));
  await h.waitForCompletion();
  assert.equal(h.snapshot().actualXweatherRequests, 1);
  assert.equal(h.snapshot().alreadyEnrichedSuppressions, 2);
});

test("distinct fresh incidents request independently until the hard cap, while observation continues", async () => {
  const h = harness(2);
  assert.equal(h.controller.observeDecision(publish("one"), incident("one")), true);
  assert.equal(h.controller.observeDecision(publish("two"), incident("two")), true);
  assert.equal(h.controller.observeDecision(publish("three"), incident("three")), false);
  await h.controller.waitForCompletion();
  assert.equal(h.calls, 2);
  assert.equal(h.controller.snapshot().freshEligibleIncidents, 3);
  assert.equal(h.controller.snapshot().eligibleButBudgetExhausted, 1);
  assert.equal(h.controller.snapshot().observedXweatherCost.totalTokensWhenFullyKnown, 20);
  assert.ok(h.events.some(row => row.kind === "xweather_request_skipped" && row.data.reason === "budget_exhausted"));
});

test("zero budget and missing credentials make no enrichment invocation or HTTP request", async () => {
  const dry = harness(0);
  dry.controller.observeDecision(publish("dry"), incident("dry"));
  const missing = harness(3, false);
  missing.controller.observeDecision(publish("missing"), incident("missing"));
  await Promise.all([dry.controller.waitForCompletion(), missing.controller.waitForCompletion()]);
  assert.equal(dry.calls, 0);
  assert.equal(missing.calls, 0);
  assert.equal(dry.controller.snapshot().actualXweatherRequests, 0);
  assert.equal(missing.controller.snapshot().actualXweatherRequests, 0);
  assert.equal(missing.controller.snapshot().missingCredentialSkips, 1);
});

test("only the previously stale published active incident can reactivate using current location and time", async () => {
  const references: EnrichmentReference[] = [];
  const h = new GateComparisonController({ nowMs: () => NOW, hasCredentials: true,
    enrich: async reference => { references.push(reference); return result(reference, "ic_only", 10); } });
  h.observeDecision(publish("stale"), incident("stale", 400_000));
  assert.equal(h.observeActivity(incident("other", 10)), false);
  assert.equal(h.observeActivity(incident("stale", MAX_PAIRING_INCIDENT_AGE_MS + 1)), false);
  const current = { ...incident("stale", MAX_PAIRING_INCIDENT_AGE_MS), representativeLatitude: 45.4,
    representativeLongitude: 0.2 };
  assert.equal(h.observeActivity(current), true);
  assert.equal(h.observeActivity(incident("stale", 0)), false);
  await h.waitForCompletion();
  assert.deepEqual(references, [{ latitude: 45.4, longitude: 0.2, eventTimeMs: NOW - MAX_PAIRING_INCIDENT_AGE_MS }]);
  assert.equal(h.snapshot().reactivatedStaleIncidents, 1);
  assert.equal(h.snapshot().enrichmentStates.ic_only, 1);
});

test("reactivation follows actual already-published suppression without a second WOULD_PUBLISH", async () => {
  const policy = new DryRunPublishPolicy(INCIDENT_POLICY_PROFILES[1]);
  const h = harness();
  const old = { ...incident("published", 400_000), publishCount: 0 };
  const decision = policy.onPromotion(old, NOW);
  assert.equal(decision.action, "WOULD_PUBLISH");
  h.controller.observeDecision(decision, old);
  const current = { ...old, lastActivityTimeMs: NOW - 2_000, totalEvents: 4 };
  assert.equal(policy.onActivity(current)?.reason, "already_published_active_incident");
  assert.equal(h.controller.observeActivity(current), true);
  await h.controller.waitForCompletion();
  assert.equal(policy.summary().publishCandidatesGenerated, 1);
  assert.equal(h.calls, 1);
  assert.equal(h.controller.snapshot().reactivatedStaleIncidents, 1);
});

test("provider unavailability remains distinct from no_match and absent cost headers stay unknown", async () => {
  const h = harness();
  h.setStatus("provider_unavailable");
  h.setTokens(undefined);
  h.controller.observeDecision(publish("failure"), incident("failure"));
  await h.controller.waitForCompletion();
  assert.equal(h.controller.snapshot().enrichmentStates.provider_unavailable, 1);
  assert.equal(h.controller.snapshot().enrichmentStates.no_match, 0);
  assert.equal(h.controller.snapshot().observedXweatherCost.totalTokensWhenFullyKnown, null);
  assert.equal(h.controller.snapshot().observedXweatherCost.requestsWithoutCostHeader, 1);
});

test("thrown provider error is sanitized and still counts as an attempted request", async () => {
  const events: Record<string, unknown>[] = [];
  const controller = new GateComparisonController({ nowMs: () => NOW, hasCredentials: true,
    emit: (_, data) => events.push(data),
    enrich: async () => { throw new Error("client_secret=example-secret"); } });
  controller.observeDecision(publish("error"), incident("error"));
  await controller.waitForCompletion();
  assert.equal(controller.snapshot().actualXweatherRequests, 1);
  assert.equal(controller.snapshot().enrichmentStates.provider_unavailable, 1);
  assert.equal(JSON.stringify(events).includes("example-secret"), false);
});

test("hypothetical Summary/Flash bounds are explicitly planning comparisons", () => {
  assert.deepEqual(hypotheticalSummaryFlashRange(12), { hypotheticalUserChecks: 12,
    observedPlanningTokenFloor: 12, observedPlanningTokenCeiling: 24, measuredCounterfactual: false });
  assert.equal(hypotheticalSummaryFlashRange(undefined), null);
});

test("comparison flags are bounded and cannot coexist with one-shot paired mode", () => {
  const args = ["--gate-comparison=true", "--duration=15", "--max-xweather-calls=0", "--hypothetical-user-checks=12"];
  assert.equal(readIncidentRunnerOptions(args).maxXweatherCalls, 0);
  assert.throws(() => readIncidentRunnerOptions([...args, "--paired-validation-output=result.json"]));
  assert.throws(() => readIncidentRunnerOptions(["--gate-comparison=true", "--max-xweather-calls=11"]));
  assert.throws(() => readIncidentRunnerOptions(["--gate-comparison=true", "--duration=21"]));
});

test("production source does not import the comparison harness", () => {
  const inspect = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory()) inspect(path);
      else assert.equal(readFileSync(path, "utf8").includes("lightning-xweather-gate-comparison"), false, path);
    }
  };
  inspect("src");
});
