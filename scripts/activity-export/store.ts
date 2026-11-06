// Read-only, bounded Supabase REST reads for one Activity Watch period. Only GET
// requests are issued; nothing is inserted, updated, deleted or called via RPC.
import { supabaseConnection } from "../lightning-publication-ledger/storage/supabase.ts";
import { ActivityExportError, assertPeriodId, type CaptureRow, type MembershipRow, type PeriodRow } from "./export.ts";

export const MEMBERSHIP_PAGE_SIZE = 1_000;
export const CAPTURE_KEYS_PER_REQUEST = 50;
/** Hard ceiling; an oversized period fails clearly instead of being truncated. */
export const MAX_EXPORT_DETECTIONS = 50_000;
const REQUEST_TIMEOUT_MS = 10_000;

const PERIOD_COLUMNS = "period_id,state,started_at,last_detection_at,detection_count,closed_at," +
  "coverage_uncertain,interruption_count,source_health,healthy_since";
const MEMBER_COLUMNS = "event_key,period_id,event_time,received_at";
const CAPTURE_COLUMNS = "event_key,event_time,event_time_raw,event_time_unit,received_at,latitude,longitude," +
  "provider,source_server,station_count,polygon_id";

export type ActivityExportStore = {
  getPeriod(periodId: string): Promise<PeriodRow | null>;
  listMembers(periodId: string): Promise<MembershipRow[]>;
  getCaptures(eventKeys: readonly string[]): Promise<CaptureRow[]>;
};

export function createActivityExportStore(config: { url?: string; serviceRoleKey?: string },
  fetcher: typeof fetch = fetch): ActivityExportStore {
  const { endpoint, headers } = supabaseConnection(config);
  async function select<T>(table: string, params: Record<string, string>, maxRows: number): Promise<T[]> {
    const url = new URL(`/rest/v1/${table}`, endpoint);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    const response = await fetcher(url, { method: "GET", headers: { ...headers, Accept: "application/json" },
      cache: "no-store", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    // Never surface upstream bodies: they can echo request details.
    if (!response.ok) throw new Error(`Activity export read failed (HTTP ${response.status})`);
    const rows: unknown = await response.json();
    if (!Array.isArray(rows) || rows.length > maxRows) throw new Error("Activity export read returned an invalid or oversized result");
    return rows as T[];
  }
  return {
    async getPeriod(periodId) {
      const rows = await select<PeriodRow>("ankara_activity_periods",
        { select: PERIOD_COLUMNS, period_id: `eq.${assertPeriodId(periodId)}`, limit: "2" }, 2);
      if (rows.length > 1) throw new Error("Activity period lookup returned more than one row");
      return rows[0] ?? null;
    },
    async listMembers(periodId) {
      assertPeriodId(periodId);
      const members: MembershipRow[] = [];
      // event_key is the primary key, so offset pages over this order are stable; a
      // closed period receives no further membership rows.
      for (let offset = 0; ; offset += MEMBERSHIP_PAGE_SIZE) {
        const page = await select<MembershipRow>("ankara_activity_period_events", { select: MEMBER_COLUMNS,
          period_id: `eq.${periodId}`, order: "event_key.asc", limit: String(MEMBERSHIP_PAGE_SIZE),
          offset: String(offset) }, MEMBERSHIP_PAGE_SIZE);
        members.push(...page);
        if (members.length > MAX_EXPORT_DETECTIONS) {
          throw new ActivityExportError("export_too_large", `Period exceeds ${MAX_EXPORT_DETECTIONS} detections`);
        }
        if (page.length < MEMBERSHIP_PAGE_SIZE) return members;
      }
    },
    async getCaptures(eventKeys) {
      if (eventKeys.length > MAX_EXPORT_DETECTIONS) {
        throw new ActivityExportError("export_too_large", `Period exceeds ${MAX_EXPORT_DETECTIONS} detections`);
      }
      const rows: CaptureRow[] = [];
      for (let start = 0; start < eventKeys.length; start += CAPTURE_KEYS_PER_REQUEST) {
        const chunk = eventKeys.slice(start, start + CAPTURE_KEYS_PER_REQUEST);
        if (chunk.some(key => !/^[0-9a-f]{64}$/.test(key))) throw new Error("Invalid event key");
        rows.push(...await select<CaptureRow>("continuous_capture_strikes",
          { select: CAPTURE_COLUMNS, event_key: `in.(${chunk.join(",")})` }, chunk.length));
      }
      return rows;
    },
  };
}
