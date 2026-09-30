import { isValidCoordinates } from "../location.ts";
import { EMPTY_PROVIDER_DIAGNOSTICS, type ProviderDiagnostics, type ProviderFailureStatus } from "./types.ts";
import { classifyProviderError, diagnosticsFromHeaders } from "./xweather.ts";

export const XWEATHER_RESEARCH_MODES = ["summary-default", "summary-15m", "summary-30m", "flash-5m"] as const;
export type XweatherResearchMode = typeof XWEATHER_RESEARCH_MODES[number];

type DataKind = "aggregate-summary" | "consolidated-flashes";
type FetchLike = (input: URL | RequestInfo, init?: RequestInit) => Promise<Response>;
type Credentials = { clientId?: string; clientSecret?: string };

export interface XweatherResearchSuccess {
  ok: true;
  mode: XweatherResearchMode;
  endpoint: "/lightning/summary/closest" | "/lightning/flash/closest";
  dataKind: DataKind;
  requestedWindowMinutes: number | null;
  fetchedAt: number;
  returnedCount: number;
  oldestEventAt: number | null;
  newestEventAt: number | null;
  actualRangeFrom: number | null;
  actualRangeTo: number | null;
  pulseCounts: { total: number; cloudToGround: number; intracloud: number } | null;
  diagnostics: ProviderDiagnostics;
}

export interface XweatherResearchFailure {
  ok: false;
  mode: XweatherResearchMode | null;
  status: ProviderFailureStatus | "invalid-request";
  message: string;
  providerCode: string | null;
  diagnostics: ProviderDiagnostics;
}

export type XweatherResearchResult = XweatherResearchSuccess | XweatherResearchFailure;

export interface XweatherResearchResponse {
  httpStatus: number;
  body: XweatherResearchResult;
}

export interface XweatherResearchOptions {
  clientId?: string;
  clientSecret?: string;
  fetcher?: FetchLike;
  now?: () => number;
  signal?: AbortSignal;
}

interface ResearchRequest {
  latitude: number;
  longitude: number;
  mode: XweatherResearchMode;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

export function parseXweatherResearchRequest(body: unknown): ResearchRequest | null {
  if (!isRecord(body)) return null;
  const { latitude, longitude, mode } = body;
  if (typeof latitude !== "number" || typeof longitude !== "number" || !isValidCoordinates(latitude, longitude)) return null;
  if (typeof mode !== "string" || !XWEATHER_RESEARCH_MODES.includes(mode as XweatherResearchMode)) return null;
  return { latitude, longitude, mode: mode as XweatherResearchMode };
}

export function buildXweatherResearchUrl(request: ResearchRequest, credentials: Required<Credentials>): URL {
  const summary = request.mode.startsWith("summary-");
  const url = new URL(summary
    ? "https://data.api.xweather.com/lightning/summary/closest"
    : "https://data.api.xweather.com/lightning/flash/closest");
  url.searchParams.set("p", `${request.latitude},${request.longitude}`);
  url.searchParams.set("radius", summary ? "50km" : "40km");
  if (!summary) url.searchParams.set("limit", "1000");
  if (request.mode === "summary-15m" || request.mode === "summary-30m") {
    const minutes = request.mode === "summary-15m" ? 15 : 30;
    url.searchParams.set("from", `-${minutes}minutes`);
    url.searchParams.set("to", "now");
  }
  url.searchParams.set("client_id", credentials.clientId);
  url.searchParams.set("client_secret", credentials.clientSecret);
  return url;
}

function modeMetadata(mode: XweatherResearchMode) {
  const summary = mode.startsWith("summary-");
  return {
    endpoint: summary ? "/lightning/summary/closest" as const : "/lightning/flash/closest" as const,
    dataKind: summary ? "aggregate-summary" as const : "consolidated-flashes" as const,
    requestedWindowMinutes: mode === "summary-15m" ? 15 : mode === "summary-30m" ? 30 : mode === "flash-5m" ? 5 : null,
  };
}

function providerError(payload: unknown): { code: string | null; status: ProviderFailureStatus } | null {
  if (!isRecord(payload) || payload.success === true) return null;
  const error = isRecord(payload.error) ? payload.error : null;
  const code = typeof error?.code === "string" ? error.code : null;
  return { code, status: code ? classifyProviderError(code) : "malformed-response" };
}

function successfulNoData(payload: unknown): boolean {
  if (!isRecord(payload) || payload.success !== true || !isRecord(payload.error)) return false;
  return payload.error.code === "warn_no_data";
}

export function parseXweatherSummaryResearch(
  payload: unknown,
  mode: Extract<XweatherResearchMode, `summary-${string}`>,
  fetchedAt: number,
  diagnostics: ProviderDiagnostics,
): XweatherResearchResult {
  const metadata = modeMetadata(mode);
  const upstreamError = providerError(payload);
  if (upstreamError) return { ok: false, mode, status: upstreamError.status, message: "Xweather rejected the summary request.", providerCode: upstreamError.code, diagnostics };
  if (successfulNoData(payload)) return { ok: true, mode, ...metadata, fetchedAt, returnedCount: 0, oldestEventAt: null, newestEventAt: null, actualRangeFrom: null, actualRangeTo: null, pulseCounts: { total: 0, cloudToGround: 0, intracloud: 0 }, diagnostics };
  if (!isRecord(payload) || payload.success !== true || payload.error !== null) {
    return { ok: false, mode, status: "malformed-response", message: "Xweather returned an unexpected summary response.", providerCode: null, diagnostics };
  }
  const response = isRecord(payload.response)
    ? payload.response
    : Array.isArray(payload.response) && payload.response.length === 1 && isRecord(payload.response[0])
      ? payload.response[0]
      : null;
  if (!response || !isRecord(response.summary)) {
    return { ok: false, mode, status: "malformed-response", message: "Xweather returned an unexpected summary response.", providerCode: null, diagnostics };
  }
  const summary = response.summary;
  const range = isRecord(summary.range) ? summary.range : null;
  const pulse = isRecord(summary.pulse) ? summary.pulse : null;
  const total = nonNegativeInteger(pulse?.count) ?? nonNegativeInteger(range?.count);
  const cg = nonNegativeInteger(pulse?.cg);
  const ic = nonNegativeInteger(pulse?.ic);
  if (total === null || cg === null || ic === null) {
    return { ok: false, mode, status: "malformed-response", message: "Xweather returned incomplete summary counts.", providerCode: null, diagnostics };
  }
  const minTimestamp = finiteNumber(range?.minTimestamp);
  const maxTimestamp = finiteNumber(range?.maxTimestamp);
  const fromTimestamp = finiteNumber(range?.fromTimestamp);
  const toTimestamp = finiteNumber(range?.toTimestamp);
  return {
    ok: true, mode, ...metadata, fetchedAt, returnedCount: total,
    oldestEventAt: minTimestamp === null ? null : minTimestamp * 1000,
    newestEventAt: maxTimestamp === null ? null : maxTimestamp * 1000,
    actualRangeFrom: fromTimestamp === null ? null : fromTimestamp * 1000,
    actualRangeTo: toTimestamp === null ? null : toTimestamp * 1000,
    pulseCounts: { total, cloudToGround: cg, intracloud: ic }, diagnostics,
  };
}

export function parseXweatherFlashResearch(payload: unknown, fetchedAt: number, diagnostics: ProviderDiagnostics): XweatherResearchResult {
  const mode = "flash-5m" as const;
  const metadata = modeMetadata(mode);
  const upstreamError = providerError(payload);
  if (upstreamError) return { ok: false, mode, status: upstreamError.status, message: "Xweather rejected the flash request.", providerCode: upstreamError.code, diagnostics };
  if (successfulNoData(payload)) return { ok: true, mode, ...metadata, fetchedAt, returnedCount: 0, oldestEventAt: null, newestEventAt: null, actualRangeFrom: null, actualRangeTo: null, pulseCounts: null, diagnostics };
  if (!isRecord(payload) || payload.success !== true || payload.error !== null || !Array.isArray(payload.response)) {
    return { ok: false, mode, status: "malformed-response", message: "Xweather returned an unexpected flash response.", providerCode: null, diagnostics };
  }
  const timestamps = payload.response.flatMap((row) => {
    if (!isRecord(row) || !isRecord(row.ob)) return [];
    const timestamp = finiteNumber(row.ob.timestamp);
    return timestamp !== null && timestamp > 0 ? [timestamp * 1000] : [];
  });
  if (timestamps.length !== payload.response.length) {
    return { ok: false, mode, status: "malformed-response", message: "Xweather returned flash records with unusable timestamps.", providerCode: null, diagnostics };
  }
  return {
    ok: true, mode, ...metadata, fetchedAt, returnedCount: timestamps.length,
    oldestEventAt: timestamps.length ? Math.min(...timestamps) : null,
    newestEventAt: timestamps.length ? Math.max(...timestamps) : null,
    actualRangeFrom: null, actualRangeTo: null, pulseCounts: null, diagnostics,
  };
}

function failureStatus(httpStatus: number): ProviderFailureStatus {
  if (httpStatus === 401 || httpStatus === 403) return "provider-auth-error";
  if (httpStatus === 429) return "provider-quota-exceeded";
  if (httpStatus >= 500) return "provider-unavailable";
  return "provider-rejected-request";
}

export async function handleXweatherResearchRequest(body: unknown, options: XweatherResearchOptions = {}): Promise<XweatherResearchResponse> {
  const request = parseXweatherResearchRequest(body);
  if (!request) return { httpStatus: 400, body: { ok: false, mode: null, status: "invalid-request", message: "Send valid coordinates and a supported research mode.", providerCode: null, diagnostics: EMPTY_PROVIDER_DIAGNOSTICS } };
  const clientId = options.clientId?.trim();
  const clientSecret = options.clientSecret?.trim();
  if (!clientId || !clientSecret) return { httpStatus: 503, body: { ok: false, mode: request.mode, status: "provider-not-configured", message: "Server-side Xweather credentials are not configured.", providerCode: null, diagnostics: EMPTY_PROVIDER_DIAGNOSTICS } };

  const url = buildXweatherResearchUrl(request, { clientId, clientSecret });
  let response: Response;
  try {
    const timeoutSignal = AbortSignal.timeout(10_000);
    const signal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;
    response = await (options.fetcher ?? fetch)(url, { method: "GET", cache: "no-store", signal });
  } catch {
    return { httpStatus: 503, body: { ok: false, mode: request.mode, status: "provider-unavailable", message: "The Xweather research request could not be completed.", providerCode: null, diagnostics: EMPTY_PROVIDER_DIAGNOSTICS } };
  }
  const diagnostics = diagnosticsFromHeaders(response.headers, response.status);
  let payload: unknown;
  try { payload = await response.json(); }
  catch { return { httpStatus: 502, body: { ok: false, mode: request.mode, status: "malformed-response", message: "Xweather returned invalid JSON.", providerCode: null, diagnostics } }; }
  if (!response.ok) {
    const error = isRecord(payload) && isRecord(payload.error) && typeof payload.error.code === "string" ? payload.error.code : null;
    return { httpStatus: response.status >= 500 ? 503 : 502, body: { ok: false, mode: request.mode, status: failureStatus(response.status), message: "Xweather rejected the research request.", providerCode: error, diagnostics } };
  }
  const fetchedAt = (options.now ?? Date.now)();
  const result = request.mode === "flash-5m"
    ? parseXweatherFlashResearch(payload, fetchedAt, diagnostics)
    : parseXweatherSummaryResearch(payload, request.mode, fetchedAt, diagnostics);
  return { httpStatus: result.ok ? 200 : 502, body: result };
}
