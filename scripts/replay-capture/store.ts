import { supabaseConnection } from "../lightning-publication-ledger/storage/supabase.ts";
import { validateCaptureSettings, type CaptureArea } from "./geometry.ts";

export type CaptureSession = CaptureArea & {
  sessionId: string; status: "requested" | "active" | "completed" | "stopped";
  durationMinutes: number; requestedAt: string; activatedAt: string | null;
  expiresAt: string | null; completedAt: string | null; eventCount: number;
  captureHealth: "unknown" | "observing" | "complete" | "incomplete";
  sourceHealth: "unknown" | "healthy" | "unhealthy"; gapCount: number;
  geometryVersion: string; errorDetails: string | null;
};
export type CapturedStrike = {
  event_key: string; event_time: string; received_at: string;
  latitude: number; longitude: number; source_server: string;
  event_time_raw: string; station_count: number | null;
};
export type SyncResult = { outcome: "idle" | "waiting_for_source" | "not_owner" } |
  { outcome: "active" | "completed"; session: CaptureSession };
export type CaptureStore = {
  request(sessionId: string, area: CaptureArea, durationMinutes: number): Promise<{
    outcome: "requested" | "conflict" | "already_present"; sessionId?: string }>;
  status(): Promise<CaptureSession | null>;
  stop(): Promise<{ outcome: "idle" | "stopped"; sessionId?: string }>;
  sync(workerId: string, sourceHealthy: boolean, hadGap: boolean): Promise<SyncResult>;
  storeBatch(sessionId: string, workerId: string, events: CapturedStrike[]): Promise<{
    outcome: "stored" | "not_active"; inserted?: number }>;
};

function sessionFromRow(value: unknown): CaptureSession {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid capture session response");
  const row = value as Record<string, unknown>;
  const area = validateCaptureSettings(row.center_lat as number, row.center_lon as number,
    row.side_km as number, row.duration_minutes as number);
  if (typeof row.session_id !== "string" || !["requested","active","completed","stopped"].includes(String(row.status)) ||
      typeof row.requested_at !== "string" || !Number.isFinite(Date.parse(row.requested_at)) ||
      !Number.isSafeInteger(row.event_count) || (row.event_count as number) < 0 ||
      !Number.isSafeInteger(row.gap_count) || (row.gap_count as number) < 0 ||
      !["unknown","observing","complete","incomplete"].includes(String(row.capture_health)) ||
      !["unknown","healthy","unhealthy"].includes(String(row.source_health)) ||
      row.geometry_version !== "azimuthal-equidistant-v1") throw new Error("Invalid capture session response");
  for (const key of ["activated_at","expires_at","completed_at"]) {
    if (row[key] !== null && (typeof row[key] !== "string" || !Number.isFinite(Date.parse(row[key])))) {
      throw new Error("Invalid capture session timestamp");
    }
  }
  return { ...area, sessionId: row.session_id, status: row.status as CaptureSession["status"],
    requestedAt: row.requested_at, activatedAt: row.activated_at as string | null,
    expiresAt: row.expires_at as string | null, completedAt: row.completed_at as string | null,
    eventCount: row.event_count as number, gapCount: row.gap_count as number,
    captureHealth: row.capture_health as CaptureSession["captureHealth"],
    sourceHealth: row.source_health as CaptureSession["sourceHealth"],
    geometryVersion: row.geometry_version, errorDetails: typeof row.error_details === "string" ? row.error_details : null };
}

export function createCaptureStore(config: { url?: string; serviceRoleKey?: string },
  fetcher: typeof fetch = fetch): CaptureStore {
  const { endpoint, headers } = supabaseConnection(config);
  async function rpc(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const url = new URL(`/rest/v1/rpc/${name}`, endpoint);
    const response = await fetcher(url, { method: "POST", headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify(args), cache: "no-store", signal: AbortSignal.timeout(8_000) });
    if (!response.ok) throw new Error(`Capture RPC failed (HTTP ${response.status})`);
    const value: unknown = await response.json();
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid capture RPC response");
    return value as Record<string, unknown>;
  }
  return {
    async request(sessionId, area, durationMinutes) {
      validateCaptureSettings(area.centerLat, area.centerLon, area.sideKm, durationMinutes);
      const row = await rpc("request_replay_capture", { p_session_id: sessionId, p_center_lat: area.centerLat,
        p_center_lon: area.centerLon, p_side_km: area.sideKm, p_duration_minutes: durationMinutes });
      if (!["requested","conflict","already_present"].includes(String(row.outcome))) throw new Error("Invalid request response");
      return { outcome: row.outcome as "requested" | "conflict" | "already_present",
        ...(typeof row.sessionId === "string" ? { sessionId: row.sessionId } : {}) };
    },
    async status() {
      const url = new URL("/rest/v1/replay_capture_sessions", endpoint);
      url.searchParams.set("select", "session_id,status,center_lat,center_lon,side_km,duration_minutes,geometry_version,requested_at,activated_at,expires_at,completed_at,event_count,capture_health,source_health,gap_count,error_details");
      url.searchParams.set("order", "requested_at.desc");
      url.searchParams.set("limit", "1");
      const response = await fetcher(url, { headers, cache: "no-store", signal: AbortSignal.timeout(8_000) });
      if (!response.ok) throw new Error(`Capture status failed (HTTP ${response.status})`);
      const rows: unknown = await response.json();
      if (!Array.isArray(rows) || rows.length > 1) throw new Error("Invalid capture status response");
      return rows.length ? sessionFromRow(rows[0]) : null;
    },
    async stop() {
      const row = await rpc("stop_replay_capture", {});
      if (row.outcome !== "idle" && row.outcome !== "stopped") throw new Error("Invalid stop response");
      return { outcome: row.outcome, ...(typeof row.sessionId === "string" ? { sessionId: row.sessionId } : {}) };
    },
    async sync(workerId, sourceHealthy, hadGap) {
      const row = await rpc("sync_replay_capture", { p_worker_id: workerId,
        p_source_healthy: sourceHealthy, p_had_gap: hadGap });
      if (row.outcome === "active" || row.outcome === "completed") {
        return { outcome: row.outcome, session: sessionFromRow(row.session) };
      }
      if (row.outcome === "idle" || row.outcome === "waiting_for_source" || row.outcome === "not_owner") {
        return { outcome: row.outcome };
      }
      throw new Error("Invalid sync response");
    },
    async storeBatch(sessionId, workerId, events) {
      const row = await rpc("store_replay_capture_batch", { p_session_id: sessionId,
        p_worker_id: workerId, p_events: events });
      if (row.outcome === "not_active") return { outcome: "not_active" };
      if (row.outcome !== "stored" || !Number.isSafeInteger(row.inserted) ||
          (row.inserted as number) < 0 || (row.inserted as number) > events.length) {
        throw new Error("Invalid capture storage response");
      }
      return { outcome: "stored", inserted: row.inserted as number };
    },
  };
}
