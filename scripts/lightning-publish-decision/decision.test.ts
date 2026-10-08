import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { continueFromPairedArtifact, withPublishDecision } from "../lightning-end-to-end-dry-run/orchestrate.ts";
import { renderEndToEndSummary } from "../lightning-end-to-end-dry-run/summary.ts";
import { sourceHealthAtPairedTrigger } from "../lightning-end-to-end-dry-run/trigger-health.ts";
import { PAIRED_ARTIFACT_FIXTURES } from "../lightning-message-preview/fixtures.ts";
import { previewPairedMessage } from "../lightning-message-preview/adapter.ts";
import type { ReverseGeocodeResult } from "../lightning-location-naming/types.ts";
import { decidePublish, hasUsableGeography } from "./decision.ts";

const fixture = PAIRED_ARTIFACT_FIXTURES;
const place = (parts: Partial<ReverseGeocodeResult> = {}): ReverseGeocodeResult => ({
  latitude: 41.5, longitude: 12.8, provider: "nominatim", country: "Italy",
  locality: "Lenola", district: "Latina", province: "Lazio",
  displayLabel: "Lenola, Latina", ...parts,
});

async function completed(artifact: unknown = fixture.no_match, location = place()) {
  return continueFromPairedArtifact(artifact, { reverse: async () => location,
    now: () => "2026-10-08T10:00:00.000Z" });
}

function decision(result: Awaited<ReturnType<typeof completed>>, context = {}) {
  return decidePublish(result, { sourceHealthAtTrigger: "live", now: () => "captured", ...context });
}

test("CG, IC, and no-match messages can pass with healthy source and structured place", async () => {
  for (const artifact of [fixture.cg_verified, fixture.ic_only, fixture.no_match]) {
    const result = await completed(artifact);
    const shadow = decision(result);
    assert.equal(result.status, "message_preview_ready");
    assert.equal(shadow.decision, "WOULD_PUBLISH");
    assert.equal(shadow.incidentId, artifact.incident.incidentId);
    assert.equal(shadow.duplicateIncident, null);
    assert.equal(shadow.persistentHistoryEnabled, false);
    assert.equal(shadow.capturedAt, "captured");
    assert.equal(result.message?.text, previewPairedMessage({ artifact, locationDisplayLabel: "Lenola, Latina" }).text);
  }
  assert.equal((await completed(fixture.no_match)).message?.mapUrl, null);
  assert.equal((await completed(fixture.ic_only)).message?.mapUrl, null);
  assert.match((await completed(fixture.cg_verified)).message?.mapUrl ?? "", /google\.com\/maps/);
  const mondragone = await completed(fixture.ic_only, place({ locality: "Mondragone", district: "Caserta",
    displayLabel: "Mondragone, Caserta" }));
  assert.equal(decision(mondragone).decision, "WOULD_PUBLISH");
  assert.match(mondragone.message?.text ?? "", /^#ŞİMŞEK/);
});

test("provider unavailable is held even though generic composer produced a message", async () => {
  const result = await completed(fixture.provider_unavailable);
  assert.equal(result.status, "message_preview_ready");
  assert.equal(result.message?.ok, true);
  assert.equal(decision(result).decision, "HOLD");
  assert.ok(decision(result).reasonCodes.includes("provider_unavailable"));
});

test("locality plus parent and district plus province are useful; broad and incomplete labels are held", async () => {
  const cases = [
    [place({ neighborhood: "Aşağı Ayrancı", locality: undefined, district: "Çankaya", province: "Ankara", displayLabel: "Aşağı Ayrancı, Çankaya" }), true],
    [place({ locality: "Polatlı", district: undefined, province: "Ankara", displayLabel: "Polatlı, Ankara" }), true],
    [place({ locality: undefined, district: "Latina", province: "Lazio", displayLabel: "Latina, Lazio" }), true],
    [place({ locality: undefined, district: undefined, province: "Lazio", displayLabel: "Lazio" }), false],
    [place({ locality: undefined, district: undefined, province: undefined, displayLabel: "Italy" }), false],
    [place({ displayLabel: "Lazio" }), false],
    [place({ displayLabel: null }), false],
    [place({ displayLabel: "  " }), false],
  ] as const;
  for (const [location, expected] of cases) {
    const result = await completed(fixture.no_match, location);
    assert.equal(hasUsableGeography(result.location), expected, String(location.displayLabel));
    const shadow = decision(result);
    assert.equal(shadow.locationUsable, expected);
    assert.equal(shadow.decision, expected ? "WOULD_PUBLISH" : "HOLD");
    if (!expected) assert.ok(shadow.reasonCodes.includes("location_insufficient"));
  }
});

test("upstream no-result and null-label states hold without another lookup or composer call", async () => {
  const noResult = await continueFromPairedArtifact({ status: "no_publish_candidate" }, {
    reverse: async () => { throw new Error("unexpected lookup"); },
    preview: () => { throw new Error("unexpected composer"); },
  });
  const noLabel = await continueFromPairedArtifact(fixture.no_match, {
    reverse: async () => place({ locality: undefined, district: undefined, province: undefined, displayLabel: null }),
    preview: () => { throw new Error("unexpected composer"); },
  });
  for (const result of [noResult, noLabel]) {
    assert.equal(decision(result).decision, "HOLD");
    assert.ok(decision(result).reasonCodes.includes("message_not_ready"));
    assert.equal(result.message, null);
  }
  assert.equal(noLabel.status, "no_usable_location_label");
  assert.equal(noLabel.providerCalls.nominatimReverseLookups, 1);
});

test("only live trigger state is healthy; missing, stale, connecting, and disconnected hold", async () => {
  const result = await completed();
  for (const state of [null, "stale", "connecting", "disconnected"] as const) {
    const shadow = decidePublish(result, { sourceHealthAtTrigger: state });
    assert.equal(shadow.decision, "HOLD");
    assert.ok(shadow.reasonCodes.includes("source_unhealthy"));
  }
});

test("explicit same-incident history blocks; nearby new and reactivated incidents are not automatic duplicates", async () => {
  const result = await completed(fixture.no_match);
  const id = fixture.no_match.incident.incidentId;
  const previous = new Set([id]);
  assert.equal(decision(result, { previouslyPublishedIncidentIds: previous }).decision, "HOLD");
  assert.ok(decision(result, { previouslyPublishedIncidentIds: previous }).reasonCodes.includes("duplicate_incident"));
  const newIncident = decision(result, { previouslyPublishedIncidentIds: new Set(["nearby-other-incident"]) });
  assert.equal(newIncident.decision, "WOULD_PUBLISH");
  assert.equal(newIncident.duplicateIncident, false);
  const reactivated = decision(await completed(fixture.reactivated_cg));
  assert.equal(reactivated.decision, "WOULD_PUBLISH");
  assert.equal(reactivated.duplicateIncident, null);
});

test("malformed ready input holds; result integration leaves status, message, and public text intact", async () => {
  const result = await completed(fixture.cg_verified);
  const final = withPublishDecision(result, { sourceHealthAtTrigger: "live", now: () => "captured" });
  assert.equal(final.status, result.status);
  assert.deepEqual(final.message, result.message);
  assert.equal(final.publishDecision?.decision, "WOULD_PUBLISH");
  const summary = renderEndToEndSummary(final);
  assert.ok(summary.includes(`\`\`\`text\n${result.message?.text}\n\`\`\``));
  assert.match(summary, /## Publish decision \(shadow only\)[\s\S]*\*\*WOULD_PUBLISH\*\*/);
  assert.match(summary, /Persistent duplicate history: not enabled in v1A/);
  assert.match(summary, /Dry run only\. Nothing was published\./);
  const malformed = decidePublish({ ...result, paired: { status: "paired_result", incident: { incidentId: "other" } } },
    { sourceHealthAtTrigger: "live" });
  assert.equal(malformed.decision, "HOLD");
  assert.ok(malformed.reasonCodes.includes("invalid_decision_input"));
});

test("trigger health uses the matched incident's event before intentional disconnect", () => {
  const log = [
    { kind: "source_health", to: "live" },
    { kind: "WOULD_PUBLISH", incidentId: "unrelated" },
    { kind: "WOULD_PUBLISH", incidentId: fixture.no_match.incident.incidentId },
    { kind: "source_health", to: "disconnected" },
  ].map(row => JSON.stringify(row)).join("\n");
  const paired = { incident: { incidentId: fixture.no_match.incident.incidentId }, triggerMode: "fresh_would_publish" };
  assert.equal(sourceHealthAtPairedTrigger(log, paired), "live");
  const reactivationLog = [
    { kind: "source_health", to: "live" },
    { kind: "WOULD_PUBLISH", incidentId: fixture.reactivated_cg.incident.incidentId },
    { kind: "source_health", to: "stale" },
    { kind: "source_health", to: "live" },
    { kind: "paired_validation_reactivated", incidentId: fixture.reactivated_cg.incident.incidentId },
    { kind: "source_health", to: "disconnected" },
  ].map(row => JSON.stringify(row)).join("\n");
  assert.equal(sourceHealthAtPairedTrigger(reactivationLog,
    { incident: { incidentId: fixture.reactivated_cg.incident.incidentId }, triggerMode: "reactivated_after_stale_publish" }), "live");
  assert.equal(sourceHealthAtPairedTrigger("", paired), null);
  const staleLog = [
    { kind: "source_health", to: "live" },
    { kind: "source_health", to: "stale" },
    { kind: "WOULD_PUBLISH", incidentId: fixture.no_match.incident.incidentId },
  ].map(row => JSON.stringify(row)).join("\n");
  assert.equal(sourceHealthAtPairedTrigger(staleLog, paired), "stale");
});

test("decision module contains no network or publication integration", async () => {
  const source = await readFile(new URL("./decision.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /\bfetch\s*\(|node:(?:http|https|net)|twitter|webhook|publishMessage|writeFile|https?:\/\//i);
});
