import assert from "node:assert/strict";
import test from "node:test";
import { createSupabaseApprovalStore, createSupabaseLedger } from "./supabase.ts";
import { fingerprintMessage } from "../record.ts";
import type { PublicationRecord } from "../types.ts";

const id = `pub_${"a".repeat(32)}`;
const text = "#ŞİMŞEK\nExact message\n";
const config = { url: "https://example.supabase.co", serviceRoleKey: "SECRET_DO_NOT_LEAK" };
const row = { publication_id: id, decision: "WOULD_PUBLISH", platform_post_id: null,
  approval_status: "pending", message_fingerprint: fingerprintMessage(text), message_text: text, map_url: null };
const record: PublicationRecord = { publicationId: id, runId: "1", incidentId: "i-000001",
  incidentReferenceTime: "2026-10-08T10:00:00Z", incidentLatitude: 41.5, incidentLongitude: 12.8,
  provider: "xweather", enrichmentStatus: "no_match", providerEventId: null, providerEventType: null,
  locationLabel: "Lenola, Latina", messageFingerprint: fingerprintMessage(text),
  decision: "WOULD_PUBLISH", recordedAt: "2026-10-08T10:01:00Z" };

test("insert persists exact composer text and pending in the same request; HOLD stays null", async () => {
  const payloads: Record<string, unknown>[] = [];
  const store = createSupabaseLedger(config, (async (_url, init?: RequestInit) => {
    payloads.push(JSON.parse(String(init?.body)));
    return Response.json([{}]);
  }) as typeof fetch);
  assert.equal(await store.insertPublicationRecord(record, text), "inserted");
  assert.equal(await store.insertPublicationRecord({ ...record, decision: "HOLD" }, text), "inserted");
  assert.equal(payloads[0].message_text, text);
  assert.equal(payloads[0].approval_status, "pending");
  assert.equal(payloads[1].approval_status, null);
  assert.equal(payloads[1].message_text, text);
  await assert.rejects(store.insertPublicationRecord(record, "different text"), /fingerprint/);
});

test("manual update is one conditional PATCH changing approval fields only", async () => {
  const calls: { url: URL; init?: RequestInit }[] = [];
  const store = createSupabaseApprovalStore(config, (async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: new URL(String(url)), init });
    return Response.json([{ ...row, approval_status: calls.length === 2 ? "approved" : "pending" }]);
  }) as typeof fetch);
  assert.equal((await store.getPublicationForApproval(id))?.messageText, text);
  assert.equal((await store.transitionPendingApproval(id, "approved", "operator", "2026-10-08T10:02:00Z"))?.approvalStatus, "approved");
  const patch = calls[1];
  assert.equal(patch.init?.method, "PATCH");
  assert.equal(patch.url.searchParams.get("publication_id"), `eq.${id}`);
  assert.equal(patch.url.searchParams.get("approval_status"), "eq.pending");
  assert.equal(patch.url.searchParams.get("decision"), "eq.WOULD_PUBLISH");
  assert.equal(patch.url.searchParams.get("platform_post_id"), "is.null");
  assert.deepEqual(Object.keys(JSON.parse(String(patch.init?.body))).sort(),
    ["approval_actor", "approval_status", "approval_updated_at"]);
});

test("empty conditional response is a race signal; provider errors reveal no key", async () => {
  const empty = createSupabaseApprovalStore(config, (async () => Response.json([])) as typeof fetch);
  assert.equal(await empty.getPublicationForApproval(id), null);
  assert.equal(await empty.transitionPendingApproval(id, "skipped", null, "2026-10-08T10:02:00Z"), null);
  const failure = createSupabaseApprovalStore(config, (async () => new Response("SECRET_DO_NOT_LEAK", { status: 503 })) as typeof fetch);
  await assert.rejects(failure.getPublicationForApproval(id), error => {
    assert.doesNotMatch(String(error), /SECRET_DO_NOT_LEAK/); return true;
  });
});
