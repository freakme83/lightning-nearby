import { supabaseConnection } from "../lightning-publication-ledger/storage/supabase.ts";
import type { PublisherStore, PublishRow } from "./publisher.ts";

const select = "publication_id,enrichment_status,decision,approval_status,platform_post_id,message_text,message_fingerprint,publish_attempt_id,published_at";

function parseRow(value: unknown): PublishRow {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid publisher row.");
  const row = value as Record<string, unknown>;
  if (typeof row.publication_id !== "string" ||
      !["cg_verified", "ic_only", "no_match", "provider_unavailable"].includes(String(row.enrichment_status)) ||
      !["WOULD_PUBLISH", "HOLD", "PUBLISHED"].includes(String(row.decision)) ||
      (row.approval_status !== null && !["pending", "approved", "skipped"].includes(String(row.approval_status))) ||
      (row.platform_post_id !== null && typeof row.platform_post_id !== "string") ||
      (row.message_text !== null && typeof row.message_text !== "string") ||
      typeof row.message_fingerprint !== "string" ||
      (row.publish_attempt_id !== null && typeof row.publish_attempt_id !== "string") ||
      (row.published_at !== null && typeof row.published_at !== "string")) {
    throw new Error("Invalid publisher row.");
  }
  return {
    publicationId: row.publication_id, enrichmentStatus: row.enrichment_status as PublishRow["enrichmentStatus"],
    decision: row.decision as PublishRow["decision"],
    approvalStatus: row.approval_status as PublishRow["approvalStatus"],
    platformPostId: row.platform_post_id as string | null,
    messageText: row.message_text as string | null,
    messageFingerprint: row.message_fingerprint as string,
    publishAttemptId: row.publish_attempt_id as string | null,
    publishedAt: row.published_at as string | null,
  };
}

export function createSupabasePublisherStore(config: { url?: string; serviceRoleKey?: string },
  fetcher: typeof fetch = fetch): PublisherStore {
  const { endpoint, headers } = supabaseConnection(config);
  async function request(url: URL, init: RequestInit): Promise<PublishRow | null> {
    url.searchParams.set("select", select);
    const response = await fetcher(url, { ...init, headers: { ...headers, ...init.headers }, signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error("Publisher storage request failed (HTTP " + response.status + ").");
    const rows: unknown = await response.json();
    if (!Array.isArray(rows) || rows.length > 1) throw new Error("Invalid publisher storage response.");
    return rows.length ? parseRow(rows[0]) : null;
  }
  function urlFor(publicationId: string): URL {
    const url = new URL(endpoint);
    url.searchParams.set("publication_id", "eq." + publicationId);
    return url;
  }
  return {
    get(publicationId) {
      const url = urlFor(publicationId);
      url.searchParams.set("limit", "1");
      return request(url, { method: "GET" });
    },
    claim(row, attemptId) {
      const url = urlFor(row.publicationId);
      url.searchParams.set("decision", "eq.WOULD_PUBLISH");
      url.searchParams.set("approval_status", "eq.approved");
      url.searchParams.set("platform_post_id", "is.null");
      url.searchParams.set("publish_attempt_id", "is.null");
      url.searchParams.set("published_at", "is.null");
      url.searchParams.set("message_fingerprint", "eq." + row.messageFingerprint);
      return request(url, { method: "PATCH", headers: {
        "Content-Type": "application/json", Prefer: "return=representation",
      }, body: JSON.stringify({ publish_attempt_id: attemptId }) });
    },
    finalize(publicationId, attemptId, postId, publishedAt) {
      const url = urlFor(publicationId);
      url.searchParams.set("decision", "eq.WOULD_PUBLISH");
      url.searchParams.set("approval_status", "eq.approved");
      url.searchParams.set("platform_post_id", "is.null");
      url.searchParams.set("publish_attempt_id", "eq." + attemptId);
      return request(url, { method: "PATCH", headers: {
        "Content-Type": "application/json", Prefer: "return=representation",
      }, body: JSON.stringify({ decision: "PUBLISHED", platform_post_id: postId, published_at: publishedAt }) });
    },
  };
}
