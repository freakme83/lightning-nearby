import assert from "node:assert/strict";
import test from "node:test";
import { readFile, readdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_THRESHOLDS } from "../lightning-cg-enrichment/match.ts";
import { enrichIncidentWithLightningType } from "../lightning-cg-enrichment/xweather.ts";
import type { EnrichmentReference, EnrichmentResult } from "../lightning-cg-enrichment/types.ts";
import type { LightningIncident, PublishDecision } from "../lightning-incident-lifecycle/types.ts";
import { PairedValidationController } from "./controller.ts";
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
function harness(enrich: (reference: EnrichmentReference) => Promise<EnrichmentResult>) {
  const artifacts: PairedValidationArtifact[] = [];
  const controller = new PairedValidationController({ enrich, writeArtifact: async artifact => { artifacts.push(artifact); }, now: () => "captured" });
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
    writeArtifact: async () => { writes++; }, onEnrichmentStarted: () => { stopCalls++; } });
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
  assert.equal(artifact?.status === "paired_result" && artifact.trigger, "first_would_publish");
});
