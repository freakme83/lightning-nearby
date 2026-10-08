import type { PublicationRecord } from "../types.ts";

export type LedgerStore = {
  loadRelevantPublicationHistory(candidate: PublicationRecord): Promise<PublicationRecord[]>;
  insertPublicationRecord(record: PublicationRecord): Promise<"inserted" | "already_present">;
};

const columns = ["publication_id", "run_id", "incident_id", "incident_reference_time", "incident_latitude",
  "incident_longitude", "provider", "enrichment_status", "provider_event_id", "provider_event_type",
  "location_label", "message_fingerprint", "decision", "recorded_at", "platform_post_id"] as const;
const eligible = "in.(WOULD_PUBLISH,PUBLISHED)";
const PAGE_SIZE = 100;

type Row = Record<string, unknown>;
function fromRow(row: Row): PublicationRecord {
  for (const key of columns) if (!(key in row)) throw new Error(`Ledger row missing ${key}`);
  if (typeof row.publication_id !== "string" || typeof row.incident_reference_time !== "string" ||
      typeof row.incident_latitude !== "number" || typeof row.incident_longitude !== "number" ||
      typeof row.provider !== "string" || typeof row.enrichment_status !== "string" ||
      typeof row.message_fingerprint !== "string" ||
      !Number.isFinite(Date.parse(row.incident_reference_time)) ||
      !Number.isFinite(row.incident_latitude) || !Number.isFinite(row.incident_longitude) ||
      !["WOULD_PUBLISH", "PUBLISHED"].includes(String(row.decision))) {
    throw new Error("Invalid publication history row");
  }
  return {
    publicationId: row.publication_id, runId: row.run_id as string | null,
    incidentId: row.incident_id as string | null, incidentReferenceTime: row.incident_reference_time,
    incidentLatitude: row.incident_latitude, incidentLongitude: row.incident_longitude,
    provider: row.provider as PublicationRecord["provider"],
    enrichmentStatus: row.enrichment_status as PublicationRecord["enrichmentStatus"],
    providerEventId: row.provider_event_id as string | null,
    providerEventType: row.provider_event_type as PublicationRecord["providerEventType"],
    locationLabel: row.location_label as string | null, messageFingerprint: row.message_fingerprint,
    decision: row.decision as PublicationRecord["decision"], recordedAt: row.recorded_at as string,
    platformPostId: row.platform_post_id as string | null,
  };
}

function toRow(record: PublicationRecord): Row {
  return {
    publication_id: record.publicationId, run_id: record.runId, incident_id: record.incidentId,
    incident_reference_time: record.incidentReferenceTime, incident_latitude: record.incidentLatitude,
    incident_longitude: record.incidentLongitude, provider: record.provider,
    enrichment_status: record.enrichmentStatus, provider_event_id: record.providerEventId,
    provider_event_type: record.providerEventType, location_label: record.locationLabel,
    message_fingerprint: record.messageFingerprint, decision: record.decision,
    recorded_at: record.recordedAt, platform_post_id: record.platformPostId ?? null,
  };
}

export function createSupabaseLedger(config: { url?: string; serviceRoleKey?: string },
  fetcher: typeof fetch = fetch): LedgerStore {
  if (!config.url || !config.serviceRoleKey) throw new Error("Supabase ledger configuration is incomplete.");
  let endpoint: URL;
  try {
    endpoint = new URL("/rest/v1/publication_records", config.url);
    if (endpoint.protocol !== "https:" || !new URL(config.url).hostname.endsWith(".supabase.co")) throw new Error();
  } catch { throw new Error("Supabase ledger URL is invalid."); }
  const headers = { apikey: config.serviceRoleKey, Authorization: `Bearer ${config.serviceRoleKey}` };
  async function query(filters: Record<string, string>): Promise<PublicationRecord[]> {
    const url = new URL(endpoint);
    url.searchParams.set("select", columns.join(","));
    url.searchParams.set("decision", eligible);
    url.searchParams.set("limit", String(PAGE_SIZE + 1));
    for (const [key, value] of Object.entries(filters)) url.searchParams.set(key, value);
    const response = await fetcher(url, { headers: { ...headers, Accept: "application/json" }, signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(`Publication history read failed (HTTP ${response.status}).`);
    const rows: unknown = await response.json();
    if (!Array.isArray(rows) || rows.length > PAGE_SIZE) throw new Error("Publication history query was invalid or exceeded its bounded result size.");
    return rows.map(row => fromRow(row as Row));
  }
  return {
    async loadRelevantPublicationHistory(candidate) {
      const byId = new Map<string, PublicationRecord>();
      if (candidate.providerEventId) {
        for (const row of await query({ provider: `eq.${candidate.provider}`, provider_event_id: `eq.${candidate.providerEventId}` })) {
          byId.set(row.publicationId, row);
        }
      }
      const time = Date.parse(candidate.incidentReferenceTime);
      if (!Number.isFinite(time)) throw new Error("Invalid candidate reference time.");
      for (const row of await query({ message_fingerprint: `eq.${candidate.messageFingerprint}`,
        and: `(incident_reference_time.gte.${new Date(time - 2_000).toISOString()},incident_reference_time.lte.${new Date(time + 2_000).toISOString()})` })) {
        byId.set(row.publicationId, row);
      }
      return [...byId.values()];
    },
    async insertPublicationRecord(record) {
      const url = new URL(endpoint);
      url.searchParams.set("on_conflict", "publication_id");
      const response = await fetcher(url, { method: "POST", headers: {
        ...headers, "Content-Type": "application/json", Prefer: "resolution=ignore-duplicates,return=representation",
      }, body: JSON.stringify(toRow(record)), signal: AbortSignal.timeout(10_000) });
      if (!response.ok) throw new Error(`Publication record write failed (HTTP ${response.status}).`);
      const rows: unknown = await response.json();
      if (!Array.isArray(rows) || rows.length > 1) throw new Error("Invalid publication record write response.");
      return rows.length ? "inserted" : "already_present";
    },
  };
}
