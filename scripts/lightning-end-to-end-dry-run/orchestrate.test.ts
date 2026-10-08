import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { previewPairedMessage } from "../lightning-message-preview/adapter.ts";
import { PAIRED_ARTIFACT_FIXTURES } from "../lightning-message-preview/fixtures.ts";
import { ReverseGeocodeError } from "../lightning-location-naming/nominatim.ts";
import type { ReverseGeocodeResult } from "../lightning-location-naming/types.ts";
import { continueFromPairedArtifact, pairedValidationFailure } from "./orchestrate.ts";
import { pairedRunnerArgs } from "./runner.ts";
import { renderEndToEndSummary } from "./summary.ts";

const label = "Cisterna di Latina, Latina";
function place(displayLabel: string | null = label): ReverseGeocodeResult {
  return {
    latitude: PAIRED_ARTIFACT_FIXTURES.cg_verified.incident.latitude,
    longitude: PAIRED_ARTIFACT_FIXTURES.cg_verified.incident.longitude,
    locality: displayLabel ? "Cisterna di Latina" : undefined,
    district: displayLabel ? "Latina" : undefined,
    country: "Italy",
    displayLabel,
    provider: "nominatim",
    attribution: "© OpenStreetMap contributors",
    providerAddress: displayLabel ? { town: "Cisterna di Latina", hamlet: "Olmobello", county: "Latina", state: "Lazio" } as ReverseGeocodeResult["providerAddress"] : undefined,
  };
}

test("real paired path uses incident coordinates for one lookup and selected CG coordinates for Maps", async () => {
  let calls = 0;
  const artifact = { ...PAIRED_ARTIFACT_FIXTURES.cg_verified,
    incident: { ...PAIRED_ARTIFACT_FIXTURES.cg_verified.incident,
      latitude: 41.535948999999995, longitude: 12.797077000223082 },
    enrichment: { ...PAIRED_ARTIFACT_FIXTURES.cg_verified.enrichment,
      match: { ...PAIRED_ARTIFACT_FIXTURES.cg_verified.enrichment.match,
        latitude: 41.4784, longitude: 12.8168 } } };
  const result = await continueFromPairedArtifact(artifact, {
    reverse: async (lat, lon) => {
      calls++;
      assert.deepEqual([lat, lon], [41.535948999999995, 12.797077000223082]);
      return { ...place(), latitude: lat, longitude: lon };
    },
    now: () => "captured",
  });
  assert.equal(calls, 1);
  assert.equal(result.status, "message_preview_ready");
  assert.equal(result.providerCalls.xweatherEnrichmentCalls, 1);
  assert.equal(result.providerCalls.nominatimReverseLookups, 1);
  assert.equal(result.message?.ok, true);
  if (result.message?.ok) {
    assert.equal(result.message.text, previewPairedMessage({ artifact, locationDisplayLabel: label }).text);
    assert.equal(result.message.mapUrl, "https://www.google.com/maps?q=41.4784,12.8168");
    assert.ok(result.message.text.includes("Cisterna di Latina / Latina"));
    const summary = renderEndToEndSummary(result);
    assert.ok(summary.includes(`\`\`\`text\n${result.message.text}\n\`\`\``));
    assert.match(summary, /\`\`\`text\nCisterna di Latina, Latina\n\`\`\`/);
    assert.match(summary, /Incident coordinate used for lookup: 41\.535948999999995, 12\.797077000223082/);
    assert.match(summary, /Selected map coordinate: 41\.4784,12\.8168/);
  }
  assert.equal(result.capturedAt, "captured");
});

test("non-CG paired result uses the existing generic composer path without a map", async () => {
  const artifact = PAIRED_ARTIFACT_FIXTURES.ic_only;
  const result = await continueFromPairedArtifact(artifact, { reverse: async () => place() });
  assert.equal(result.status, "message_preview_ready");
  assert.equal(result.message?.ok, true);
  if (result.message?.ok) {
    assert.equal(result.message.text, previewPairedMessage({ artifact, locationDisplayLabel: label }).text);
    assert.match(result.message.text, /^#ŞİMŞEK/);
    assert.equal(result.message.mapUrl, null);
  }
});

test("null label stops before composer without inventing an offshore place", async () => {
  let previews = 0;
  const result = await continueFromPairedArtifact(PAIRED_ARTIFACT_FIXTURES.cg_verified, {
    reverse: async () => place(null),
    preview: input => { previews++; return previewPairedMessage(input); },
  });
  assert.equal(result.status, "no_usable_location_label");
  assert.equal(result.providerCalls.nominatimReverseLookups, 1);
  assert.equal(previews, 0);
  assert.equal(result.message, null);
  const summary = renderEndToEndSummary(result);
  assert.match(summary, /No usable display label was produced\./);
  assert.doesNotMatch(summary, /\`\`\`text/);
});

test("both no-result states and malformed pairs stop before lookup and composer", async () => {
  let lookups = 0;
  let previews = 0;
  for (const artifact of [
    { status: "no_publish_candidate", guardrail: { enrichmentCalls: 0, providerRequestAttempted: false } },
    { status: "no_fresh_publish_candidate", guardrail: { enrichmentCalls: 0, providerRequestAttempted: false } },
    PAIRED_ARTIFACT_FIXTURES.malformed,
  ]) {
    const result = await continueFromPairedArtifact(artifact, {
      reverse: async () => { lookups++; return place(); },
      preview: input => { previews++; return previewPairedMessage(input); },
    });
    assert.equal(result.status, artifact.status === "paired_result" ? "paired_validation_failed" : artifact.status);
    assert.equal(result.providerCalls.nominatimReverseLookups, 0);
    assert.equal(result.message, null);
  }
  assert.equal(lookups, 0);
  assert.equal(previews, 0);
});

test("location provider failure is explicit, makes one lookup, and skips composer", async () => {
  let previews = 0;
  const result = await continueFromPairedArtifact(PAIRED_ARTIFACT_FIXTURES.cg_verified, {
    reverse: async () => { throw new ReverseGeocodeError("http", "rate limit", 429); },
    preview: input => { previews++; return previewPairedMessage(input); },
  });
  assert.equal(result.status, "location_lookup_failed");
  assert.equal(result.location?.status, "lookup_failed");
  assert.equal(result.providerCalls.nominatimReverseLookups, 1);
  assert.equal(previews, 0);
});

test("adapter/composer error is a distinct terminal state", async () => {
  const artifact = { ...PAIRED_ARTIFACT_FIXTURES.cg_verified,
    enrichment: { ...PAIRED_ARTIFACT_FIXTURES.cg_verified.enrichment, match: undefined } };
  const result = await continueFromPairedArtifact(artifact, { reverse: async () => place() });
  assert.equal(result.status, "message_composition_failed");
  assert.equal(result.message?.ok, false);
  if (result.message?.ok === false) assert.equal(result.message.composer?.error.code, "missing_cg_match");
});

test("failed live runner has a structured terminal result and no final message", () => {
  const result = pairedValidationFailure("The live paired-validation runner exited with code 1.");
  assert.equal(result.status, "paired_validation_failed");
  assert.equal(result.providerCalls.nominatimReverseLookups, 0);
  assert.equal(result.providerCalls.xweatherEnrichmentCalls, null);
  assert.equal(result.message, null);
  assert.match(renderEndToEndSummary(result), /No final message: \*\*paired_validation_failed\*\*/);
});

test("runner uses paired-validation options and accepts only the current manual input range", () => {
  const inputs = { AREA: "custom", NORTH: "40.05", EAST: "-2.05", SOUTH: "38.55", WEST: "-3.85",
    DURATION_MINUTES: "10", INCIDENT_PROFILE: "B" };
  assert.deepEqual(pairedRunnerArgs(inputs), [
    "--duration=10", "--summary-every=60", "--format=jsonl", "--box=40.05,-2.05,38.55,-3.85",
    "--incident-profile=B", "--paired-validation-output=artifacts/lightning-cg-paired-result.json",
  ]);
  assert.ok(pairedRunnerArgs({ ...inputs, AREA: "ankara" }).includes("--area=ankara"));
  for (const duration of ["4", "21", "1.5", "abc"]) {
    assert.throws(() => pairedRunnerArgs({ ...inputs, DURATION_MINUTES: duration }));
  }
});

test("manual workflow is orchestration-only and contains no publishing integration", async () => {
  const workflow = await readFile(new URL("../../.github/workflows/research-lightning-end-to-end-dry-run.yml", import.meta.url), "utf8");
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /scripts\/lightning-end-to-end-dry-run\/runner\.ts/);
  assert.match(workflow, /scripts\/lightning-end-to-end-dry-run\/summary-runner\.ts/);
  assert.match(workflow, /retention-days: 3/);
  assert.doesNotMatch(workflow, /^  (push|pull_request|schedule|workflow_run):/m);
  assert.doesNotMatch(workflow, /twitter|social|webhook|publisher|forecast-provider/i);
  const source = await readFile(new URL("./runner.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /twitter|webhook|publisher|https?:\/\//i);
});
