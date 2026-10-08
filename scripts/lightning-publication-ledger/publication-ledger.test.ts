import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { continueFromPairedArtifact, withPublishDecision } from "../lightning-end-to-end-dry-run/orchestrate.ts";
import { PAIRED_ARTIFACT_FIXTURES } from "../lightning-message-preview/fixtures.ts";
import { decidePublish } from "../lightning-publish-decision/decision.ts";
import { duplicateDecisionContext, matchPublicationDuplicate } from "./duplicate.ts";
import { buildPublicationRecord, fingerprintMessage } from "./record.ts";
import type { PublicationRecord } from "./types.ts";

const fixtures = PAIRED_ARTIFACT_FIXTURES;
const location = {
  latitude: 41.5, longitude: 12.8, provider: "nominatim",
  locality: "Lenola", district: "Latina", province: "Lazio", country: "Italy",
  displayLabel: "Lenola, Latina",
};
const recordedAt = "2026-10-08T11:00:00.000Z";

async function shadow(artifact: unknown = fixtures.cg_verified) {
  const completed = await continueFromPairedArtifact(artifact, {
    reverse: async () => location, now: () => recordedAt,
  });
  return withPublishDecision(completed, { sourceHealthAtTrigger: "live", now: () => recordedAt });
}

async function built(artifact: unknown = fixtures.cg_verified, runId: string | null = "run-1") {
  const outcome = buildPublicationRecord(await shadow(artifact), { runId, recordedAt });
  if (!outcome.ok) assert.fail(outcome.message);
  return outcome.record;
}

test("builder takes exact composer text, selected provider event, and shadow decision", async () => {
  const result = await shadow();
  const before = JSON.stringify(result);
  const builtResult = buildPublicationRecord(result, { runId: "run-1", recordedAt });
  assert.equal(builtResult.ok, true);
  if (!builtResult.ok || !result.message?.ok) return;
  const record = builtResult.record;
  assert.equal(record.messageFingerprint, fingerprintMessage(result.message.text));
  assert.notEqual(fingerprintMessage(`${result.message.text}\n`), record.messageFingerprint);
  assert.equal(JSON.stringify(result), before);
  assert.equal(record.provider, "xweather");
  assert.equal(record.providerEventId, fixtures.cg_verified.enrichment.match.id);
  assert.equal(record.providerEventType, "cg");
  assert.equal(record.incidentReferenceTime, new Date(fixtures.cg_verified.incident.eventTimeMs).toISOString());
  assert.equal(record.incidentLatitude, fixtures.cg_verified.incident.latitude);
  assert.equal(record.incidentLongitude, fixtures.cg_verified.incident.longitude);
  assert.equal(record.locationLabel, location.displayLabel);
  assert.equal(record.decision, "WOULD_PUBLISH");
  assert.equal(record.runId, "run-1");
  assert.equal(record.recordedAt, recordedAt);
  assert.match(record.publicationId, /^pub_[0-9a-f]{32}$/);
  assert.notEqual(record.publicationId, record.incidentId);
  assert.equal(record.platformPostId, undefined);
  const same = buildPublicationRecord(result, { runId: "run-1", recordedAt: "2026-10-09T11:00:00.000Z" });
  assert.equal(same.ok, true);
  if (same.ok) assert.equal(same.record.publicationId, record.publicationId);
  const otherRun = buildPublicationRecord(result, { runId: "run-2", recordedAt });
  assert.equal(otherRun.ok, true);
  if (otherRun.ok) assert.notEqual(otherRun.record.publicationId, record.publicationId);
});

test("IC retains its existing selected ID; no-match and unavailable never invent an event ID", async () => {
  const ic = await built(fixtures.ic_only);
  const noMatch = await built(fixtures.no_match);
  const unavailable = await built(fixtures.provider_unavailable);
  assert.equal(ic.providerEventId, fixtures.ic_only.enrichment.match.id);
  assert.equal(ic.providerEventType, "ic");
  for (const item of [noMatch, unavailable]) {
    assert.equal(item.providerEventId, null);
    assert.equal(item.providerEventType, null);
  }
  assert.equal(unavailable.decision, "HOLD");
});

test("builder rejects incomplete data rather than guessing", async () => {
  const base = await shadow();
  const failures = [
    ["message_not_ready", { ...base, status: "no_usable_location_label" }],
    ["missing_decision", { ...base, publishDecision: undefined }],
    ["invalid_incident", { ...base, paired: { ...base.paired, incident: { incidentId: "i-1" } } }],
    ["invalid_enrichment", { ...base, paired: { ...base.paired, enrichment: { status: "unknown" } } }],
    ["invalid_location", { ...base, location: null }],
  ] as const;
  for (const [code, value] of failures) {
    const outcome = buildPublicationRecord(value);
    assert.equal(outcome.ok, false);
    if (!outcome.ok) assert.equal(outcome.code, code);
  }
  const timestamp = buildPublicationRecord(base, { recordedAt: "not a date" });
  assert.equal(timestamp.ok, false);
  if (!timestamp.ok) assert.equal(timestamp.code, "invalid_recorded_at");
});

test("same Xweather event wins across runs and different local incident IDs", async () => {
  const prior = await built();
  const candidate = { ...prior, publicationId: "pub_later", runId: "run-2", incidentId: "i-000001" };
  const match = matchPublicationDuplicate(candidate, [prior]);
  assert.deepEqual(match, { duplicate: true, reason: "same_provider_event", matchedPublicationId: prior.publicationId });
  const sameRun = matchPublicationDuplicate({ ...candidate, runId: prior.runId }, [prior]);
  assert.equal(sameRun.reason, "same_provider_event");
});

test("only WOULD_PUBLISH and PUBLISHED history can block the same provider event", async () => {
  const original = await built();
  const candidate: PublicationRecord = { ...original, publicationId: "pub_candidate", runId: "run-2",
    incidentId: "i-000001", decision: "WOULD_PUBLISH" };
  const hold: PublicationRecord = { ...original, publicationId: "pub_hold", decision: "HOLD" };
  const shadow: PublicationRecord = { ...original, publicationId: "pub_shadow", decision: "WOULD_PUBLISH" };
  const published: PublicationRecord = { ...original, publicationId: "pub_published", decision: "PUBLISHED" };
  const noDuplicate = { duplicate: false, reason: "no_duplicate", matchedPublicationId: null };
  assert.deepEqual(matchPublicationDuplicate(candidate, [hold]), noDuplicate);
  assert.deepEqual(matchPublicationDuplicate(candidate, [shadow]),
    { duplicate: true, reason: "same_provider_event", matchedPublicationId: shadow.publicationId });
  assert.deepEqual(matchPublicationDuplicate(candidate, [published]),
    { duplicate: true, reason: "same_provider_event", matchedPublicationId: published.publicationId });
  const unrelated = { ...shadow, publicationId: "pub_unrelated", providerEventId: "different-event" };
  assert.deepEqual(matchPublicationDuplicate(candidate, [hold, unrelated]), noDuplicate);
  assert.deepEqual(matchPublicationDuplicate(candidate, [hold, shadow]),
    { duplicate: true, reason: "same_provider_event", matchedPublicationId: shadow.publicationId });
});

test("same local incident ID in different runs with different provider event IDs is not enough", async () => {
  const prior = await built();
  const different: PublicationRecord = { ...prior, publicationId: "pub_different", runId: "run-2",
    providerEventId: "another-xweather-event" };
  // Even generic text, time and coordinate agreement cannot override two distinct IDs.
  assert.deepEqual(matchPublicationDuplicate(different, [prior]),
    { duplicate: false, reason: "no_duplicate", matchedPublicationId: null });
});

test("strict no-ID observation match requires text, at most two seconds, and at most 250 metres", async () => {
  const prior = await built(fixtures.no_match);
  const close: PublicationRecord = { ...prior, publicationId: "pub_close", runId: "run-2",
    incidentId: "i-000001", incidentReferenceTime: new Date(Date.parse(prior.incidentReferenceTime) + 2_000).toISOString(),
    incidentLatitude: prior.incidentLatitude + 0.001 };
  assert.deepEqual(matchPublicationDuplicate(close, [prior]),
    { duplicate: true, reason: "same_observation_fingerprint", matchedPublicationId: prior.publicationId });
  assert.equal(matchPublicationDuplicate({ ...close, messageFingerprint: fingerprintMessage("different") }, [prior]).duplicate, false);
  assert.equal(matchPublicationDuplicate({ ...close,
    incidentReferenceTime: new Date(Date.parse(prior.incidentReferenceTime) + 120_000).toISOString() }, [prior]).duplicate, false);
  assert.equal(matchPublicationDuplicate({ ...close,
    incidentReferenceTime: new Date(Date.parse(prior.incidentReferenceTime) + 2_001).toISOString() }, [prior]).duplicate, false);
  assert.equal(matchPublicationDuplicate({ ...close, incidentLatitude: prior.incidentLatitude + 0.00216 }, [prior]).duplicate, true);
  assert.equal(matchPublicationDuplicate({ ...close, incidentLatitude: prior.incidentLatitude + 0.00234 }, [prior]).duplicate, false);
  assert.equal(matchPublicationDuplicate({ ...close, incidentLatitude: prior.incidentLatitude + 0.018 }, [prior]).duplicate, false);
});

test("HOLD history cannot block the strict observation fingerprint fallback", async () => {
  const original = await built(fixtures.no_match);
  const candidate: PublicationRecord = { ...original, publicationId: "pub_later", runId: "run-2",
    incidentId: "i-000001", decision: "WOULD_PUBLISH" };
  const hold: PublicationRecord = { ...original, publicationId: "pub_hold", decision: "HOLD" };
  const shadow: PublicationRecord = { ...original, publicationId: "pub_shadow", decision: "WOULD_PUBLISH" };
  const unrelated: PublicationRecord = { ...shadow, publicationId: "pub_unrelated",
    incidentReferenceTime: new Date(Date.parse(original.incidentReferenceTime) + 120_000).toISOString() };
  assert.deepEqual(matchPublicationDuplicate(candidate, [hold]),
    { duplicate: false, reason: "no_duplicate", matchedPublicationId: null });
  assert.deepEqual(matchPublicationDuplicate(candidate, [hold, unrelated]),
    { duplicate: false, reason: "no_duplicate", matchedPublicationId: null });
  assert.deepEqual(matchPublicationDuplicate(candidate, [shadow]),
    { duplicate: true, reason: "same_observation_fingerprint", matchedPublicationId: shadow.publicationId });
  assert.deepEqual(matchPublicationDuplicate(candidate, [hold, shadow]),
    { duplicate: true, reason: "same_observation_fingerprint", matchedPublicationId: shadow.publicationId });
});

test("nearby storm activity, shared label, district, status and hashtag are not duplicate identity", async () => {
  const prior = await built(fixtures.no_match);
  for (const [km, minutes] of [[2, 2], [5, 5], [8, 1], [3, 4]]) {
    const candidate: PublicationRecord = { ...prior, publicationId: `pub_${km}_${minutes}`, runId: "run-2",
      incidentId: "i-000001", incidentLatitude: prior.incidentLatitude + km / 111,
      incidentReferenceTime: new Date(Date.parse(prior.incidentReferenceTime) + minutes * 60_000).toISOString() };
    assert.deepEqual(matchPublicationDuplicate(candidate, [prior]),
      { duplicate: false, reason: "no_duplicate", matchedPublicationId: null });
  }
  const onlyLabel: PublicationRecord = { ...prior, publicationId: "pub_label", runId: "run-2",
    incidentId: "i-000001", messageFingerprint: fingerprintMessage("#ŞİMŞEK with another time"),
    incidentReferenceTime: new Date(Date.parse(prior.incidentReferenceTime) + 60_000).toISOString() };
  assert.equal(matchPublicationDuplicate(onlyLabel, [prior]).duplicate, false);
});

test("reactivation alone is not duplicate, but a repeated selected provider event is", async () => {
  const reactivated = await built(fixtures.reactivated_cg, "run-2");
  assert.equal(matchPublicationDuplicate(reactivated, []).duplicate, false);
  const sameEvent: PublicationRecord = { ...reactivated, publicationId: "pub_original", runId: "run-1",
    incidentId: "i-000002" };
  assert.equal(matchPublicationDuplicate(reactivated, [sameEvent]).reason, "same_provider_event");
});

test("ledger match integrates with v1A without changing no-context policy", async () => {
  const result = await shadow();
  const prior = await built();
  const candidate = { ...prior, publicationId: "pub_candidate", incidentId: "i-000001", runId: "run-2" };
  assert.equal(decidePublish(result, { sourceHealthAtTrigger: "live" }).decision, "WOULD_PUBLISH");
  const duplicate = matchPublicationDuplicate(candidate, [prior]);
  const held = decidePublish(result, { sourceHealthAtTrigger: "live", ...duplicateDecisionContext(duplicate) });
  assert.equal(held.decision, "HOLD");
  assert.equal(held.duplicateIncident, true);
  assert.ok(held.reasonCodes.includes("duplicate_incident"));
  const newObservation = matchPublicationDuplicate({ ...candidate, providerEventId: "new-event",
    incidentReferenceTime: new Date(Date.parse(candidate.incidentReferenceTime) + 120_000).toISOString() }, [prior]);
  assert.equal(decidePublish(result, { sourceHealthAtTrigger: "live",
    ...duplicateDecisionContext(newObservation) }).decision, "WOULD_PUBLISH");
});

test("ledger is pure: no network, storage, or publishing integration", async () => {
  for (const name of ["record.ts", "duplicate.ts", "types.ts"]) {
    const source = await readFile(new URL(name, import.meta.url), "utf8");
    assert.doesNotMatch(source, /\bfetch\s*\(|node:(?:fs|http|https|net)|\b(?:sqlite|turso|redis|d1|webhook|twitter|axios|writeFile|publishMessage)\b|https?:\/\//i, name);
  }
});
