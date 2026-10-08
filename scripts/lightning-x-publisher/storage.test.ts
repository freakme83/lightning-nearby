import assert from "node:assert/strict";
import { test } from "node:test";
import { createSupabasePublisherStore } from "./storage.ts";

const id = "pub_" + "b".repeat(32);
const token = "12345678-1234-4123-8123-123456789abc";
const row = { publication_id: id, enrichment_status: "ic_only", decision: "WOULD_PUBLISH", approval_status: "approved",
  platform_post_id: null, message_text: "  #ŞİMŞEK\nAşağı Ayrancı / Çankaya\n",
  map_url: "https://www.google.com/maps?q=39.901,32.859",
  message_fingerprint: "sha256:" + "a".repeat(64), publish_attempt_id: null, published_at: null };

test("Supabase claim and finalize use conditional, atomic updates", async () => {
  const calls: Array<{ method: string; url: URL; body: Record<string, unknown> | null }> = [];
  const fake = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null;
    calls.push({ method: init?.method ?? "GET", url, body });
    assert.equal(url.pathname, "/rest/v1/publication_records");
    assert.equal((init?.headers as Record<string, string>).apikey, "service-key");
    if (calls.length === 1) return Response.json([row]);
    if (calls.length === 2) return Response.json([{ ...row, publish_attempt_id: token }]);
    return Response.json([{ ...row, publish_attempt_id: token, decision: "PUBLISHED",
      platform_post_id: "989898", published_at: "2026-10-08T18:00:00.000Z" }]);
  };
  const store = createSupabasePublisherStore({ url: "https://test.supabase.co", serviceRoleKey: "service-key" }, fake as typeof fetch);
  const loaded = await store.get(id);
  assert.equal(loaded?.messageText, row.message_text);
  assert.equal(loaded?.mapUrl, row.map_url);
  const claimed = await store.claim(loaded!, token);
  assert.equal(claimed?.publishAttemptId, token);
  const final = await store.finalize(id, token, "989898", "2026-10-08T18:00:00.000Z");
  assert.equal(final?.platformPostId, "989898");
  assert.equal(final?.publishedAt, "2026-10-08T18:00:00.000Z");
  assert.equal(calls[1].method, "PATCH");
  assert.equal(calls[1].url.searchParams.get("decision"), "eq.WOULD_PUBLISH");
  assert.equal(calls[1].url.searchParams.get("approval_status"), "eq.approved");
  assert.equal(calls[1].url.searchParams.get("platform_post_id"), "is.null");
  assert.equal(calls[1].url.searchParams.get("publish_attempt_id"), "is.null");
  assert.equal(calls[1].url.searchParams.get("published_at"), "is.null");
  assert.equal(calls[1].url.searchParams.get("message_fingerprint"), "eq." + row.message_fingerprint);
  assert.deepEqual(calls[1].body, { publish_attempt_id: token });
  assert.equal(calls[2].url.searchParams.get("publication_id"), "eq." + id);
  assert.equal(calls[2].url.searchParams.get("decision"), "eq.WOULD_PUBLISH");
  assert.equal(calls[2].url.searchParams.get("approval_status"), "eq.approved");
  assert.equal(calls[2].url.searchParams.get("platform_post_id"), "is.null");
  assert.equal(calls[2].url.searchParams.get("publish_attempt_id"), "eq." + token);
  assert.deepEqual(calls[2].body, { decision: "PUBLISHED", platform_post_id: "989898",
    published_at: "2026-10-08T18:00:00.000Z" });
});

test("claim release uses exact attempt ID and all safe-state predicates in one PATCH", async () => {
  const calls: Array<{ url: URL; body: unknown }> = [];
  const fake = async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: new URL(String(input)), body: JSON.parse(String(init?.body)) });
    return Response.json([{ ...row, publish_attempt_id: null }]);
  };
  const store = createSupabasePublisherStore({ url: "https://test.supabase.co", serviceRoleKey: "service-key" }, fake as typeof fetch);
  assert.equal((await store.releaseClaim(id, token))?.publishAttemptId, null);
  assert.equal(calls.length, 1);
  for (const [key, value] of Object.entries({ publication_id: "eq." + id,
    decision: "eq.WOULD_PUBLISH", approval_status: "eq.approved", platform_post_id: "is.null",
    published_at: "is.null", publish_attempt_id: "eq." + token })) {
    assert.equal(calls[0].url.searchParams.get(key), value);
  }
  assert.deepEqual(calls[0].body, { publish_attempt_id: null });
});

test("zero-row final update reports conflict and does not manufacture a success", async () => {
  const store = createSupabasePublisherStore({ url: "https://test.supabase.co", serviceRoleKey: "service-key" },
    (async () => Response.json([])) as typeof fetch);
  assert.equal(await store.finalize(id, token, "989898", "2026-10-08T18:00:00.000Z"), null);
});
