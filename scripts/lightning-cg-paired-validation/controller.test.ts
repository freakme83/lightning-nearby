import assert from "node:assert/strict";
import test from "node:test";
import { readFile, readdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_THRESHOLDS } from "../lightning-cg-enrichment/match.ts";
import { enrichIncidentWithLightningType } from "../lightning-cg-enrichment/xweather.ts";
import type { EnrichmentReference, EnrichmentResult } from "../lightning-cg-enrichment/types.ts";
import type { LightningIncident, PublishDecision } from "../lightning-incident-lifecycle/types.ts";
import { MAX_PAIRING_INCIDENT_AGE_MS, PairedValidationController } from "./controller.ts";
import { IncidentLifecycleEngine } from "../lightning-incident-lifecycle/incident-engine.ts";
import { applyTransitions } from "../lightning-incident-lifecycle/experiment.ts";
import { DryRunPublishPolicy } from "../lightning-incident-lifecycle/publish-policy.ts";
import { INCIDENT_POLICY_PROFILES } from "../lightning-incident-lifecycle/types.ts";
import type { PairedValidationArtifact, PairedRunContext } from "./types.ts";

const time = Date.parse("2026-10-06T12:21:30Z");
const incident: LightningIncident = {
  id: "i-000123", sourceClusterIds: ["c-1", "c-2"], status: "active", firstEventTimeMs: time - 60_000,
  lastActivityTimeMs: time, totalEvents: 7, representativeLatitude: 39.095, representativeLongitude: 32.272,
  publishCount: 1,
};
const profile = { id: "B" as const, name: "moderate" };
const context: PairedRunContext = {
  profile, areaSelection: "custom", bounds: { north: 40, east: 33, south: 38, west: 31 },
  startedAtMs: time - 600_000, endedAtMs: time, sourceHealth: "live", wouldPublishCount: 0,
};
const wouldPublish: PublishDecision = { action: "WOULD_PUBLISH", incidentId: incident.id, reason: "incident_promoted" };
const suppressed: PublishDecision = { action: "SUPPRESS", incidentId: incident.id, reason: "already_published_active_incident" };
const reference: EnrichmentReference = { latitude: incident.representativeLatitude,
  longitude: incident.representativeLongitude, eventTimeMs: incident.lastActivityTimeMs };
function result(status: EnrichmentResult["status"], match?: EnrichmentResult["match"]): EnrichmentResult {
  return { status, provider: "xweather", reference, thresholds: { ...DEFAULT_THRESHOLDS },
    counts: { returned: 2, matched: match ? 1 : 0, matchedCg: match?.type === "cg" ? 1 : 0,
      matchedIc: match?.type === "ic" ? 1 : 0 }, match,
    ...(status === "provider_unavailable" ? { failure: "network_error" as const } : {}),
    cost: { tokens: 10, multipliers: "endpoint=10; spatial=1; temporal=1" } };
}
function harness(enrich: (reference: EnrichmentReference) => Promise<EnrichmentResult>, options: {
  nowMs?: () => number; onEnrichmentStarted?: () => void;
  onStaleTriggerSkipped?: (diagnostic: { incidentId: string; incidentAgeMs: number | null;
    maxIncidentAgeMs: number; skipReason: "incident_too_old" | "future_dated_incident" | "invalid_event_time" }) => void;
} = {}) {
  const artifacts: PairedValidationArtifact[] = [];
  const controller = new PairedValidationController({ enrich, writeArtifact: async artifact => { artifacts.push(artifact); },
    now: () => "captured", nowMs: options.nowMs ?? (() => time),
    onEnrichmentStarted: options.onEnrichmentStarted, onStaleTriggerSkipped: options.onStaleTriggerSkipped });
  return { controller, artifacts };
}

test("first WOULD_PUBLISH decision triggers exactly one enrichment", async () => {
  let calls = 0;
  const h = harness(async () => { calls++; return result("cg_verified", { id: "cg-1", type: "cg", latitude: 39.1,
    longitude: 32.3, eventTimeMs: time, distanceKm: 1.4, timeDifferenceMs: 3_000 }); });
  assert.equal(h.controller.observeDecision(wouldPublish, incident, profile), true);
  await h.controller.waitForCompletion();
  assert.equal(calls, 1);
  assert.equal(h.artifacts.length, 1);
});

test("suppressed and repeated later decisions do not trigger more provider calls", async () => {
  let calls = 0;
  const h = harness(async () => { calls++; return result("no_match"); });
  assert.equal(h.controller.observeDecision(suppressed, incident, profile), false);
  assert.equal(h.controller.observeDecision(wouldPublish, incident, profile), true);
  await h.controller.waitForCompletion();
  assert.equal(h.controller.observeDecision({ ...wouldPublish, incidentId: "i-000456" },
    { ...incident, id: "i-000456" }, profile), false);
  assert.equal(h.controller.observeDecision(suppressed, incident, profile), false);
  assert.equal(calls, 1);
});

test("multiple WOULD_PUBLISH decisions still call enrichment at most once", async () => {
  let calls = 0;
  const h = harness(async () => { calls++; return result("ic_only"); });
  h.controller.observeDecision(wouldPublish, incident, profile);
  h.controller.observeDecision({ ...wouldPublish, incidentId: "i-000456" }, { ...incident, id: "i-000456" }, profile);
  await h.controller.waitForCompletion();
  assert.equal(calls, 1);
  assert.equal(h.artifacts[0].status, "paired_result");
});

test("no publish candidate writes no_publish_candidate and makes zero enrichment calls", async () => {
  let calls = 0;
  const h = harness(async () => { calls++; return result("no_match"); });
  const artifact = await h.controller.writeNoCandidate(context);
  assert.equal(calls, 0);
  assert.equal(artifact?.status, "no_publish_candidate");
  if (artifact?.status === "no_publish_candidate") {
    assert.equal(artifact.guardrail.enrichmentCalls, 0);
    assert.equal(artifact.guardrail.providerRequestAttempted, false);
    assert.equal(artifact.durationSeconds, 600);
  }
});

test("missing credentials produce structured provider_unavailable and zero HTTP requests", async () => {
  let requests = 0;
  const enrichment = await enrichIncidentWithLightningType(reference, {}, { env: {}, fetch: async () => {
    requests++; return new Response("unexpected", { status: 200 });
  } });
  assert.equal(enrichment.status, "provider_unavailable");
  assert.equal(enrichment.failure, "missing_credentials");
  assert.equal(requests, 0);
  const h = harness(async () => enrichment);
  h.controller.observeDecision(wouldPublish, incident, profile);
  const artifact = await h.controller.waitForCompletion();
  assert.equal(artifact?.status, "paired_result");
  if (artifact?.status === "paired_result") assert.equal(artifact.guardrail.providerRequestAttempted, false);
});

test("paired artifact preserves CG match diagnostics and cost", async () => {
  const match = { id: "cg-1", type: "cg" as const, latitude: 39.1, longitude: 32.3,
    eventTimeMs: time, distanceKm: 1.4, timeDifferenceMs: 3_000, peakAmp: 106_000, numSensors: 17 };
  const h = harness(async () => result("cg_verified", match));
  h.controller.observeDecision(wouldPublish, incident, profile);
  const artifact = await h.controller.waitForCompletion();
  assert.equal(artifact?.status, "paired_result");
  if (artifact?.status === "paired_result") {
    assert.equal(artifact.enrichment.status, "cg_verified");
    assert.deepEqual(artifact.enrichment.match, match);
    assert.equal(artifact.enrichment.counts?.returned, 2);
    assert.equal(artifact.enrichment.cost?.tokens, 10);
  }
});

test("paired artifact preserves ic_only result", async () => {
  const match = { id: "ic-1", type: "ic" as const, latitude: 39.1, longitude: 32.3,
    eventTimeMs: time, distanceKm: 1.4, timeDifferenceMs: 3_000 };
  const h = harness(async () => result("ic_only", match));
  h.controller.observeDecision(wouldPublish, incident, profile);
  const artifact = await h.controller.waitForCompletion();
  assert.equal(artifact?.status === "paired_result" && artifact.enrichment.status, "ic_only");
});

test("paired artifact preserves no_match semantics", async () => {
  const h = harness(async () => result("no_match"));
  h.controller.observeDecision(wouldPublish, incident, profile);
  const artifact = await h.controller.waitForCompletion();
  assert.equal(artifact?.status === "paired_result" && artifact.enrichment.status, "no_match");
});

test("paired artifact preserves provider_unavailable semantics", async () => {
  const h = harness(async () => result("provider_unavailable"));
  h.controller.observeDecision(wouldPublish, incident, profile);
  const artifact = await h.controller.waitForCompletion();
  assert.equal(artifact?.status === "paired_result" && artifact.enrichment.status, "provider_unavailable");
});

test("reference uses actual incident representative coordinates and last activity time", async () => {
  let used: EnrichmentReference | undefined;
  const h = harness(async value => { used = value; return result("no_match"); });
  h.controller.observeDecision(wouldPublish, incident, profile);
  const artifact = await h.controller.waitForCompletion();
  assert.deepEqual(used, { latitude: incident.representativeLatitude, longitude: incident.representativeLongitude,
    eventTimeMs: incident.lastActivityTimeMs });
  if (artifact?.status === "paired_result") {
    assert.equal(artifact.incident.firstActivityTimeMs, incident.firstEventTimeMs);
    assert.equal(artifact.incident.eventCount, incident.totalEvents);
    assert.equal(artifact.incident.clusterCount, incident.sourceClusterIds.length);
  }
});

test("controller stops observing after the first enrichment attempt", async () => {
  let calls = 0;
  let stopCalls = 0;
  let writes = 0;
  const controller = new PairedValidationController({ enrich: async () => { calls++; return result("no_match"); },
    writeArtifact: async () => { writes++; }, nowMs: () => time, onEnrichmentStarted: () => { stopCalls++; } });
  controller.observeDecision(wouldPublish, incident, profile);
  await controller.waitForCompletion();
  await controller.writeNoCandidate(context);
  controller.observeDecision(wouldPublish, { ...incident, id: "i-another" }, profile);
  assert.equal(calls, 1);
  assert.equal(stopCalls, 1);
  assert.equal(writes, 1);
});

test("credential-bearing provider error text is omitted from paired artifact", async () => {
  const secret = "do-not-serialize-secret";
  const h = harness(async () => { throw new Error(`request failed with client_secret=${secret}`); });
  h.controller.observeDecision(wouldPublish, incident, profile);
  const artifact = await h.controller.waitForCompletion();
  assert.equal(artifact?.status, "paired_result");
  assert.equal(artifact?.status === "paired_result" && artifact.enrichment.status, "provider_unavailable");
  assert.equal(JSON.stringify(h.artifacts).includes(secret), false);
});

test("artifact and source do not contain credentials or reverse-geocoding calls", async () => {
  const secret = "never-write-this-secret";
  const h = harness(async () => result("provider_unavailable"));
  h.controller.observeDecision(wouldPublish, incident, profile);
  await h.controller.waitForCompletion();
  assert.equal(JSON.stringify(h.artifacts).includes(secret), false);
  const moduleSource = await readFile(resolve(dirname(fileURLToPath(import.meta.url)), "controller.ts"), "utf8");
  assert.equal(/nominatim|reverse-geocode|location-naming/i.test(moduleSource), false);
});

test("production source does not import or reference paired-validation harness", async () => {
  const srcRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../src");
  const pending = [srcRoot];
  while (pending.length) {
    const directory = pending.pop()!;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (/\.tsx?$/.test(entry.name)) {
        const source = await readFile(path, "utf8");
        assert.equal(/lightning-cg-paired-validation|PairedValidationController/.test(source), false, `${path} references research harness`);
      }
    }
  }
});

test("candidate enrichment is observational and reports the configured thresholds", async () => {
  const h = harness(async () => result("cg_verified"));
  h.controller.observeDecision(wouldPublish, incident, profile);
  const artifact = await h.controller.waitForCompletion();
  assert.equal(artifact?.status === "paired_result" && artifact.enrichment.thresholds.maxMatchDistanceKm, 8);
  assert.equal(artifact?.status === "paired_result" && artifact.triggerMode, "fresh_would_publish");
});


test("fresh WOULD_PUBLISH at the exact age threshold is eligible", async () => {
  let calls = 0;
  const now = time + MAX_PAIRING_INCIDENT_AGE_MS;
  const h = harness(async () => { calls++; return result("no_match"); }, { nowMs: () => now });
  assert.equal(h.controller.observeDecision(wouldPublish, incident, profile), true);
  assert.equal(h.controller.enrichmentClaimed, true);
  const artifact = await h.controller.waitForCompletion();
  assert.equal(calls, 1);
  assert.equal(artifact?.status, "paired_result");
  if (artifact?.status === "paired_result") {
    assert.equal(artifact.triggerFreshness.incidentAgeMs, MAX_PAIRING_INCIDENT_AGE_MS);
    assert.equal(artifact.triggerFreshness.maxIncidentAgeMs, MAX_PAIRING_INCIDENT_AGE_MS);
  }
});

test("stale WOULD_PUBLISH is skipped, leaves the latch available, and keeps listening", async () => {
  let calls = 0;
  let stopCalls = 0;
  const diagnostics: unknown[] = [];
  const h = harness(async () => { calls++; return result("no_match"); }, {
    nowMs: () => time + MAX_PAIRING_INCIDENT_AGE_MS + 1,
    onEnrichmentStarted: () => { stopCalls++; },
    onStaleTriggerSkipped: diagnostic => diagnostics.push(diagnostic),
  });
  assert.equal(h.controller.observeDecision(wouldPublish, incident, profile), false);
  assert.equal(h.controller.enrichmentClaimed, false);
  assert.equal(calls, 0);
  assert.equal(stopCalls, 0);
  assert.deepEqual(diagnostics, [{ incidentId: incident.id, incidentAgeMs: MAX_PAIRING_INCIDENT_AGE_MS + 1,
    maxIncidentAgeMs: MAX_PAIRING_INCIDENT_AGE_MS, skipReason: "incident_too_old" }]);
});

test("stale followed by fresh WOULD_PUBLISH triggers only the fresh incident once", async () => {
  let calls = 0;
  const h = harness(async reference => { calls++; assert.equal(reference.eventTimeMs, time - 30_000); return result("cg_verified"); },
    { nowMs: () => time });
  const stale = { ...incident, id: "i-stale", lastActivityTimeMs: time - MAX_PAIRING_INCIDENT_AGE_MS - 1 };
  assert.equal(h.controller.observeDecision({ ...wouldPublish, incidentId: stale.id }, stale, profile), false);
  assert.equal(h.controller.enrichmentClaimed, false);
  const fresh = { ...incident, id: "i-fresh", lastActivityTimeMs: time - 30_000 };
  assert.equal(h.controller.observeDecision({ ...wouldPublish, incidentId: fresh.id }, fresh, profile), true);
  const artifact = await h.controller.waitForCompletion();
  assert.equal(calls, 1);
  assert.equal(artifact?.status, "paired_result");
  if (artifact?.status === "paired_result") {
    assert.equal(artifact.incident.incidentId, "i-fresh");
    assert.equal(artifact.triggerFreshness.stalePublishCount, 1);
    assert.equal(artifact.triggerFreshness.incidentAgeMs, 30_000);
  }
});

test("multiple stale publish candidates use no Xweather calls and write no_fresh_publish_candidate", async () => {
  let calls = 0;
  const h = harness(async () => { calls++; return result("no_match"); }, { nowMs: () => time });
  for (const [id, age] of [["i-old-1", 5 * 60_000], ["i-old-2", 10 * 60_000]] as const) {
    const old = { ...incident, id, lastActivityTimeMs: time - age };
    assert.equal(h.controller.observeDecision({ ...wouldPublish, incidentId: id }, old, profile), false);
    assert.equal(h.controller.enrichmentClaimed, false);
  }
  const artifact = await h.controller.writeNoCandidate({ ...context, wouldPublishCount: 2 });
  assert.equal(calls, 0);
  assert.equal(artifact?.status, "no_fresh_publish_candidate");
  if (artifact?.status === "no_fresh_publish_candidate") {
    assert.equal(artifact.triggerFreshness.stalePublishCount, 2);
    assert.equal(artifact.triggerFreshness.freshestSkippedIncidentAgeMs, 5 * 60_000);
    assert.equal(artifact.triggerFreshness.maxIncidentAgeMs, MAX_PAIRING_INCIDENT_AGE_MS);
    assert.equal(artifact.guardrail.enrichmentCalls, 0);
    assert.equal(artifact.guardrail.providerRequestAttempted, false);
  }
});

test("an incident older than the freshness threshold by one millisecond is skipped", () => {
  const h = harness(async () => result("no_match"), { nowMs: () => time + MAX_PAIRING_INCIDENT_AGE_MS + 1 });
  assert.equal(h.controller.observeDecision(wouldPublish, incident, profile), false);
  assert.equal(h.controller.enrichmentClaimed, false);
});

test("future-dated incident timestamps are conservatively skipped without crashing", async () => {
  let calls = 0;
  const h = harness(async () => { calls++; return result("no_match"); }, { nowMs: () => time });
  const future = { ...incident, lastActivityTimeMs: time + 1 };
  assert.equal(h.controller.observeDecision(wouldPublish, future, profile), false);
  assert.equal(h.controller.enrichmentClaimed, false);
  const artifact = await h.controller.writeNoCandidate({ ...context, wouldPublishCount: 1 });
  assert.equal(calls, 0);
  assert.equal(artifact?.status, "no_fresh_publish_candidate");
  if (artifact?.status === "no_fresh_publish_candidate") {
    assert.equal(artifact.triggerFreshness.futureDatedPublishCount, 1);
    assert.equal(artifact.guardrail.providerRequestAttempted, false);
  }
});

test("fresh candidate claims the one-call latch synchronously before enrichment settles", async () => {
  let resolveEnrichment!: (value: EnrichmentResult) => void;
  let calls = 0;
  const h = harness(() => {
    calls++;
    return new Promise(resolve => { resolveEnrichment = resolve; });
  }, { nowMs: () => time });
  assert.equal(h.controller.observeDecision(wouldPublish, incident, profile), true);
  assert.equal(h.controller.enrichmentClaimed, true);
  assert.equal(calls, 1);
  assert.equal(h.controller.observeDecision(wouldPublish, incident, profile), false);
  resolveEnrichment(result("no_match"));
  await h.controller.waitForCompletion();
  assert.equal(calls, 1);
});


test("stale-skipped incident reactivates after its own later activity without another WOULD_PUBLISH", async () => {
  let calls = 0;
  const h = harness(async () => { calls++; return result("cg_verified"); }, { nowMs: () => time });
  const stale = { ...incident, lastActivityTimeMs: time - 9 * 60_000 };
  assert.equal(h.controller.observeDecision({ ...wouldPublish, incidentId: stale.id }, stale, profile), false);
  assert.equal(h.controller.enrichmentClaimed, false);

  const current = { ...stale, lastActivityTimeMs: time - 20_000, representativeLatitude: 39.2, representativeLongitude: 32.4 };
  assert.equal(h.controller.observeActivity(current, profile), true);
  const artifact = await h.controller.waitForCompletion();
  assert.equal(calls, 1);
  assert.equal(artifact?.status, "paired_result");
  if (artifact?.status === "paired_result" && artifact.triggerMode === "reactivated_after_stale_publish") {
    assert.equal(artifact.reactivation.incidentId, stale.id);
    assert.equal(artifact.reactivation.originalStaleAgeMs, 9 * 60_000);
    assert.equal(artifact.reactivation.reactivationAgeMs, 20_000);
    assert.equal(artifact.reactivation.triggeredByLaterFreshActivity, true);
    assert.equal(artifact.incident.latitude, current.representativeLatitude);
    assert.equal(artifact.incident.longitude, current.representativeLongitude);
    assert.equal(artifact.incident.eventTimeMs, current.lastActivityTimeMs);
  } else assert.fail("expected reactivated paired result");
});

test("fresh activity on an unrelated incident cannot reactivate a stale-skipped candidate", async () => {
  let calls = 0;
  const h = harness(async () => { calls++; return result("no_match"); }, { nowMs: () => time });
  const stale = { ...incident, lastActivityTimeMs: time - 8 * 60_000 };
  h.controller.observeDecision({ ...wouldPublish, incidentId: stale.id }, stale, profile);
  const unrelated = { ...incident, id: "i-unrelated", status: "active" as const, lastActivityTimeMs: time - 10_000 };
  assert.equal(h.controller.observeActivity(unrelated, profile), false);
  assert.equal(calls, 0);
  assert.equal(h.controller.enrichmentClaimed, false);
});

test("only an incident with a stale-skipped WOULD_PUBLISH decision may reactivate", async () => {
  let calls = 0;
  const h = harness(async () => { calls++; return result("no_match"); }, { nowMs: () => time });
  const eligible = { ...incident, id: "i-stale", lastActivityTimeMs: time - 7 * 60_000 };
  h.controller.observeDecision({ ...wouldPublish, incidentId: eligible.id }, eligible, profile);
  const otherStale = { ...eligible, id: "i-second-stale", lastActivityTimeMs: time - 8 * 60_000 };
  h.controller.observeDecision({ ...wouldPublish, incidentId: otherStale.id }, otherStale, profile);
  const current = { ...otherStale, lastActivityTimeMs: time - 30_000 };
  assert.equal(h.controller.observeActivity(current, profile), true);
  const artifact = await h.controller.waitForCompletion();
  assert.equal(calls, 1);
  assert.equal(artifact?.status === "paired_result" && artifact.incident.incidentId, otherStale.id);
  assert.equal(artifact?.status === "paired_result" && artifact.triggerFreshness.trackedStaleIncidentCount, 2);
});

test("a stale candidate receiving activity that remains old is not enriched until a later fresh update", async () => {
  let calls = 0;
  const h = harness(async () => { calls++; return result("no_match"); }, { nowMs: () => time });
  const stale = { ...incident, lastActivityTimeMs: time - 10 * 60_000 };
  h.controller.observeDecision({ ...wouldPublish, incidentId: stale.id }, stale, profile);
  const stillOld = { ...stale, lastActivityTimeMs: time - MAX_PAIRING_INCIDENT_AGE_MS - 1 };
  assert.equal(h.controller.observeActivity(stillOld, profile), false);
  assert.equal(calls, 0);
  assert.equal(h.controller.enrichmentClaimed, false);
  const fresh = { ...stillOld, lastActivityTimeMs: time - MAX_PAIRING_INCIDENT_AGE_MS };
  assert.equal(h.controller.observeActivity(fresh, profile), true);
  await h.controller.waitForCompletion();
  assert.equal(calls, 1);
});

test("reactivated stale incident exactly at the age threshold is eligible", async () => {
  let calls = 0;
  const h = harness(async () => { calls++; return result("no_match"); }, { nowMs: () => time });
  const stale = { ...incident, lastActivityTimeMs: time - 5 * 60_000 };
  h.controller.observeDecision({ ...wouldPublish, incidentId: stale.id }, stale, profile);
  const threshold = { ...stale, lastActivityTimeMs: time - MAX_PAIRING_INCIDENT_AGE_MS };
  assert.equal(h.controller.observeActivity(threshold, profile), true);
  const artifact = await h.controller.waitForCompletion();
  assert.equal(calls, 1);
  assert.equal(artifact?.status === "paired_result" && artifact.triggerMode, "reactivated_after_stale_publish");
  assert.equal(artifact?.status === "paired_result" && artifact.triggerFreshness.incidentAgeMs, MAX_PAIRING_INCIDENT_AGE_MS);
});

test("reactivation claims the only Xweather call before any later fresh publish decision", async () => {
  let calls = 0;
  const h = harness(async () => { calls++; return result("no_match"); }, { nowMs: () => time });
  const stale = { ...incident, lastActivityTimeMs: time - 6 * 60_000 };
  h.controller.observeDecision({ ...wouldPublish, incidentId: stale.id }, stale, profile);
  assert.equal(h.controller.observeActivity({ ...stale, lastActivityTimeMs: time - 10_000 }, profile), true);
  const other = { ...incident, id: "i-other", lastActivityTimeMs: time - 5_000 };
  assert.equal(h.controller.observeDecision({ ...wouldPublish, incidentId: other.id }, other, profile), false);
  await h.controller.waitForCompletion();
  assert.equal(calls, 1);
});

test("real lifecycle suppresses a duplicate publish while paired validation reactivates the same incident", async () => {
  const lifecycleProfile = INCIDENT_POLICY_PROFILES.find(item => item.id === "B")!;
  const staleEventTime = time - 9 * 60_000;
  const engine = new IncidentLifecycleEngine(lifecycleProfile, staleEventTime);
  engine.setSourceHealth({ state: "live", lastFrameAtMs: staleEventTime }, staleEventTime);
  const policy = new DryRunPublishPolicy(lifecycleProfile);
  const decisions: PublishDecision[] = [];
  const observations = [
    { sourceClusterId: "cluster-1", eventTimeMs: staleEventTime, receivedAtMs: staleEventTime, latitude: 39.1, longitude: 32.3 },
    { sourceClusterId: "cluster-1", eventTimeMs: staleEventTime + 1_000, receivedAtMs: staleEventTime + 1_000, latitude: 39.101, longitude: 32.301 },
    { sourceClusterId: "cluster-1", eventTimeMs: staleEventTime + 2_000, receivedAtMs: staleEventTime + 2_000, latitude: 39.102, longitude: 32.302 },
  ];
  let promotedIncident!: LightningIncident;
  for (const observation of observations) {
    const transitions = engine.observe(observation);
    decisions.push(...applyTransitions(transitions, policy, engine));
    const promoted = transitions.find(transition => transition.type === "promoted");
    if (promoted?.type === "promoted") promotedIncident = promoted.incident;
  }
  const publishDecision = decisions.find(decision => decision.action === "WOULD_PUBLISH")!;
  assert.equal(publishDecision.reason, "incident_promoted");
  let enrichmentReference: EnrichmentReference | undefined;
  let calls = 0;
  const h = harness(async referenceValue => { calls++; enrichmentReference = referenceValue; return result("cg_verified"); },
    { nowMs: () => time });
  assert.equal(h.controller.observeDecision(publishDecision, promotedIncident, profile), false);
  assert.equal(h.controller.enrichmentClaimed, false);

  const laterTransitions = engine.observe({
    sourceClusterId: "cluster-1", eventTimeMs: time - 30_000, receivedAtMs: time - 30_000,
    latitude: 39.3, longitude: 32.5,
  });
  const laterDecisions = applyTransitions(laterTransitions, policy, engine);
  assert.deepEqual(laterDecisions.map(decision => decision.reason), ["already_published_active_incident"]);
  assert.equal(laterDecisions.some(decision => decision.action === "WOULD_PUBLISH"), false);
  const updatedIncident = laterTransitions.find(transition => transition.type === "activity");
  assert.equal(updatedIncident?.type, "activity");
  if (updatedIncident?.type === "activity") {
    assert.equal(h.controller.observeActivity(updatedIncident.incident, profile), true);
  }
  const artifact = await h.controller.waitForCompletion();
  assert.equal(calls, 1);
  assert.equal(policy.summary().publishCandidatesGenerated, 1);
  assert.equal(policy.summary().suppressionsByReason.already_published_active_incident, 1);
  assert.deepEqual(enrichmentReference, {
    latitude: updatedIncident?.type === "activity" ? updatedIncident.incident.representativeLatitude : NaN,
    longitude: updatedIncident?.type === "activity" ? updatedIncident.incident.representativeLongitude : NaN,
    eventTimeMs: time - 30_000,
  });
  assert.equal(artifact?.status === "paired_result" && artifact.triggerMode, "reactivated_after_stale_publish");
  assert.equal(artifact?.status === "paired_result" && artifact.reactivation.originalStaleAgeMs,
    time - promotedIncident.lastActivityTimeMs);
  assert.equal(artifact?.status === "paired_result" && artifact.reactivation.reactivationAgeMs, 30_000);
  assert.equal(artifact?.status === "paired_result" && artifact.incident.latitude,
    updatedIncident?.type === "activity" ? updatedIncident.incident.representativeLatitude : NaN);
  assert.equal(artifact?.status === "paired_result" && artifact.incident.longitude,
    updatedIncident?.type === "activity" ? updatedIncident.incident.representativeLongitude : NaN);
});

test("stale-only timeout still records no_fresh_publish_candidate and later activity diagnostics", async () => {
  const h = harness(async () => result("no_match"), { nowMs: () => time });
  const stale = { ...incident, lastActivityTimeMs: time - 9 * 60_000 };
  h.controller.observeDecision({ ...wouldPublish, incidentId: stale.id }, stale, profile);
  h.controller.observeActivity({ ...stale, lastActivityTimeMs: time - 5 * 60_000 }, profile);
  const artifact = await h.controller.writeNoCandidate({ ...context, wouldPublishCount: 1 });
  assert.equal(artifact?.status, "no_fresh_publish_candidate");
  if (artifact?.status === "no_fresh_publish_candidate") {
    assert.equal(artifact.triggerFreshness.trackedStaleIncidentCount, 1);
    assert.equal(artifact.triggerFreshness.staleIncidentsWithLaterActivityCount, 1);
    assert.equal(artifact.triggerFreshness.reactivatedIncidentCount, 0);
    assert.equal(artifact.guardrail.enrichmentCalls, 0);
    assert.equal(artifact.guardrail.providerRequestAttempted, false);
  }
});
