import assert from "node:assert/strict";
import test from "node:test";
import { continueFromPairedArtifact, withPublishDecision } from "../lightning-end-to-end-dry-run/orchestrate.ts";
import { applyPersistentLedger } from "../lightning-end-to-end-dry-run/ledger.ts";
import { PAIRED_ARTIFACT_FIXTURES } from "../lightning-message-preview/fixtures.ts";
import { createSupabaseLedger, createSupabaseApprovalStore } from "./storage/supabase.ts";
import { applyManualApproval } from "./approval.ts";
import { renderApprovalSummary } from "./approval-summary.ts";
import { fingerprintMessage, buildPublicationRecord } from "./record.ts";

const config = { url: "https://example.supabase.co", serviceRoleKey: "test-key" };
const context = { sourceHealthAtTrigger: "live" as const, now: () => "2026-10-08T11:00:00Z" };
const location = { latitude: 41.5, longitude: 12.8, provider: "nominatim",
  country: "Italy", locality: "Cisterna di Latina", district: "Latina", displayLabel: "Cisterna di Latina, Latina" };

for (const status of ["cg_verified", "ic_only", "no_match", "provider_unavailable"] as const) {
  test(`${status}: public text persists exactly, internal map survives storage, approval never recomposes`, async () => {
    let row: Record<string, unknown> | null = null;
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (init?.method === "POST") {
        row = JSON.parse(String(init.body));
        return Response.json([row]);
      }
      if (init?.method === "PATCH") {
        const patch = JSON.parse(String(init.body));
        assert.deepEqual(Object.keys(patch).sort(), ["approval_actor", "approval_status", "approval_updated_at"]);
        row = { ...row, ...patch };
        return Response.json([row]);
      }
      assert.ok(url.searchParams.has("select"));
      return Response.json(row ? [row] : []);
    }) as typeof fetch;
    const artifact = status === "cg_verified" ? {
      ...PAIRED_ARTIFACT_FIXTURES.cg_verified,
      incident: { ...PAIRED_ARTIFACT_FIXTURES.cg_verified.incident, latitude: 41.535949, longitude: 12.797077 },
      enrichment: { ...PAIRED_ARTIFACT_FIXTURES.cg_verified.enrichment,
        match: { ...PAIRED_ARTIFACT_FIXTURES.cg_verified.enrichment.match, latitude: 41.4784, longitude: 12.8168 } },
    } : PAIRED_ARTIFACT_FIXTURES[status];
    const completed = withPublishDecision(await continueFromPairedArtifact(artifact, {
      reverse: async () => location,
    }), context);
    assert.ok(completed.message?.ok);
    const message = completed.message;
    const final = await applyPersistentLedger(completed, context, createSupabaseLedger(config, fetcher), { runId: "v1.1-test" });
    assert.equal(final.ledger?.recordPersisted, true);
    assert.equal(final.publishDecision?.decision, status === "provider_unavailable" ? "HOLD" : "WOULD_PUBLISH");
    const persisted = row as Record<string, unknown> | null;
    assert.ok(persisted);
    assert.equal(persisted.message_text, message.text);
    assert.equal(persisted.message_fingerprint, fingerprintMessage(message.text));
    assert.doesNotMatch(String(persisted.message_text), /https?:\/\//);
    assert.equal(persisted.incident_latitude, artifact.incident.latitude);
    assert.equal(persisted.incident_longitude, artifact.incident.longitude);
    assert.equal(persisted.map_url, status === "cg_verified" ? "https://www.google.com/maps?q=41.4784,12.8168" : null);
    if (status === "cg_verified") {
      assert.ok(message.text.endsWith("\n\n41.478, 12.817"));
      const oldPublicText = [message.composer.hashtag, message.composer.dateTimeText, message.composer.eventText, message.mapUrl].join("\n");
      assert.notEqual(persisted.message_fingerprint, fingerprintMessage(oldPublicText));
      assert.notEqual(persisted.message_fingerprint, fingerprintMessage(message.text + message.mapUrl));
    } else {
      assert.equal(message.text.split("\n").length, 3);
      assert.equal(message.composer.coordinateText, null);
    }
    const result = await applyManualApproval(String(persisted.publication_id), "approve", createSupabaseApprovalStore(config, fetcher));
    assert.equal(result.outcome, status === "provider_unavailable" ? "not_eligible" : "updated");
    assert.equal(result.messageText, message.text);
    assert.equal(result.mapUrl, persisted.map_url);
    const summary = renderApprovalSummary(result);
    assert.ok(summary.includes(`\`\`\`text\n${message.text}\n\`\`\``));
    if (status === "cg_verified") assert.ok(summary.includes(`### Internal map\n\n${message.mapUrl}`));
    else assert.doesNotMatch(summary, /### Internal map/);
    const afterApproval = row as Record<string, unknown> | null;
    assert.equal(afterApproval?.message_text, message.text);
    assert.equal(afterApproval?.message_fingerprint, fingerprintMessage(message.text));
  });
}

test("internal full-precision map metadata cannot change the exact public-text fingerprint", async () => {
  const completed = withPublishDecision(await continueFromPairedArtifact(PAIRED_ARTIFACT_FIXTURES.cg_verified, {
    reverse: async () => location,
  }), context);
  assert.ok(completed.message?.ok);
  const first = buildPublicationRecord(completed);
  const second = buildPublicationRecord({ ...completed,
    message: { ...completed.message, mapUrl: "https://www.google.com/maps?q=39.902743,32.851495" },
  });
  assert.ok(first.ok && second.ok);
  assert.notEqual(first.record.mapUrl, second.record.mapUrl);
  assert.equal(first.record.messageFingerprint, second.record.messageFingerprint);
  assert.equal(first.record.publicationId, second.record.publicationId);
});
