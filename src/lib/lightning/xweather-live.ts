import { isValidCoordinates } from "../location.ts";
import type { LiveLightningProvider } from "./provider.ts";
import {
  EMPTY_PROVIDER_DIAGNOSTICS,
  LIGHTNING_QUERY_LIMIT,
  LIVE_AREA_RADIUS_KM,
  LIVE_AREA_WINDOW_MINUTES,
  LIVE_CURRENT_RADIUS_KM,
  type ProviderDiagnostics,
  type ProviderFailureStatus,
  type ProviderResult,
  type RecentAreaProviderResult,
} from "./types.ts";
import { classifyProviderError, diagnosticsFromHeaders, parseXweatherLightningPayload } from "./xweather.ts";

type FetchLike = (input: URL | RequestInfo, init?: RequestInit) => Promise<Response>;
type Credentials = { clientId?: string; clientSecret?: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

function positiveTimestamp(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value * 1000 : null;
}

function failureStatus(httpStatus: number): ProviderFailureStatus {
  if (httpStatus === 401 || httpStatus === 403) return "provider-auth-error";
  if (httpStatus === 429) return "provider-quota-exceeded";
  if (httpStatus >= 500) return "provider-unavailable";
  return "provider-rejected-request";
}

function providerFailure(status: ProviderFailureStatus, message: string, diagnostics = EMPTY_PROVIDER_DIAGNOSTICS): ProviderResult {
  return { ok: false, status, message, diagnostics };
}

function areaFailure(status: ProviderFailureStatus, message: string, diagnostics = EMPTY_PROVIDER_DIAGNOSTICS): RecentAreaProviderResult {
  return { ok: false, status, message, diagnostics };
}

function providerErrorCode(payload: unknown): string | null {
  if (!isRecord(payload) || !isRecord(payload.error)) return null;
  return typeof payload.error.code === "string" ? payload.error.code : null;
}

export function parseXweatherSummaryPayload(payload: unknown, diagnostics = EMPTY_PROVIDER_DIAGNOSTICS): RecentAreaProviderResult {
  if (!isRecord(payload)) return areaFailure("malformed-response", "Xweather returned an unexpected summary response.", diagnostics);
  const code = providerErrorCode(payload);
  if (payload.success !== true) {
    return areaFailure(code ? classifyProviderError(code) : "malformed-response", "Xweather did not return usable summary data.", diagnostics);
  }
  if (code === "warn_no_data") {
    return { ok: true, totalDetections: 0, oldestEventAt: null, newestEventAt: null, diagnostics };
  }
  if (payload.error !== null) return areaFailure(code ? classifyProviderError(code) : "malformed-response", "Xweather returned a warning or error with the summary.", diagnostics);

  const response = isRecord(payload.response)
    ? payload.response
    : Array.isArray(payload.response) && payload.response.length === 1 && isRecord(payload.response[0])
      ? payload.response[0]
      : null;
  if (!response || !isRecord(response.summary)) return areaFailure("malformed-response", "Xweather returned an unexpected summary response.", diagnostics);
  const range = isRecord(response.summary.range) ? response.summary.range : null;
  const pulse = isRecord(response.summary.pulse) ? response.summary.pulse : null;
  const totalDetections = nonNegativeInteger(pulse?.count) ?? nonNegativeInteger(range?.count);
  if (totalDetections === null) return areaFailure("malformed-response", "Xweather returned incomplete summary counts.", diagnostics);

  return {
    ok: true,
    totalDetections,
    oldestEventAt: positiveTimestamp(range?.minTimestamp),
    newestEventAt: positiveTimestamp(range?.maxTimestamp),
    diagnostics,
  };
}

export function buildXweatherLiveUrls(latitude: number, longitude: number, credentials: Required<Credentials>) {
  const authorize = (url: URL) => {
    url.searchParams.set("p", `${latitude},${longitude}`);
    url.searchParams.set("client_id", credentials.clientId);
    url.searchParams.set("client_secret", credentials.clientSecret);
    return url;
  };
  const summary = authorize(new URL("https://data.api.xweather.com/lightning/summary/closest"));
  summary.searchParams.set("radius", `${LIVE_AREA_RADIUS_KM}km`);
  summary.searchParams.set("from", `-${LIVE_AREA_WINDOW_MINUTES}minutes`);
  summary.searchParams.set("to", "now");

  const flash = authorize(new URL("https://data.api.xweather.com/lightning/flash/closest"));
  flash.searchParams.set("radius", `${LIVE_CURRENT_RADIUS_KM}km`);
  flash.searchParams.set("limit", String(LIGHTNING_QUERY_LIMIT));
  return { summary, flash };
}

async function fetchPayload(url: URL, fetcher: FetchLike, signal?: AbortSignal): Promise<{ ok: true; payload: unknown; diagnostics: ProviderDiagnostics } | { ok: false; status: ProviderFailureStatus; diagnostics: ProviderDiagnostics }> {
  let response: Response;
  try {
    const timeoutSignal = AbortSignal.timeout(10_000);
    const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
    response = await fetcher(url, { method: "GET", cache: "no-store", signal: combinedSignal });
  } catch {
    return { ok: false, status: "provider-unavailable", diagnostics: EMPTY_PROVIDER_DIAGNOSTICS };
  }
  const diagnostics = diagnosticsFromHeaders(response.headers, response.status);
  let payload: unknown;
  try { payload = await response.json(); }
  catch { return { ok: false, status: "malformed-response", diagnostics }; }
  if (!response.ok) return { ok: false, status: failureStatus(response.status), diagnostics };
  return { ok: true, payload, diagnostics };
}

export function createXweatherLiveProvider(credentials: Credentials, fetcher: FetchLike = fetch): LiveLightningProvider {
  const clientId = credentials.clientId?.trim();
  const clientSecret = credentials.clientSecret?.trim();
  const configured = Boolean(clientId && clientSecret);

  return {
    async fetchRecentArea(latitude, longitude, signal) {
      if (!configured) return areaFailure("provider-not-configured", "Server-side Xweather credentials are not configured.");
      if (!isValidCoordinates(latitude, longitude)) return areaFailure("provider-rejected-request", "The monitored coordinates are invalid.");
      const { summary } = buildXweatherLiveUrls(latitude, longitude, { clientId: clientId!, clientSecret: clientSecret! });
      const result = await fetchPayload(summary, fetcher, signal);
      if (!result.ok) return areaFailure(result.status, "The Xweather summary request could not be completed.", result.diagnostics);
      return parseXweatherSummaryPayload(result.payload, result.diagnostics);
    },

    async fetchCurrentFlashes(latitude, longitude, signal) {
      if (!configured) return providerFailure("provider-not-configured", "Server-side Xweather credentials are not configured.");
      if (!isValidCoordinates(latitude, longitude)) return providerFailure("provider-rejected-request", "The monitored coordinates are invalid.");
      const { flash } = buildXweatherLiveUrls(latitude, longitude, { clientId: clientId!, clientSecret: clientSecret! });
      const result = await fetchPayload(flash, fetcher, signal);
      if (!result.ok) return providerFailure(result.status, "The Xweather Flash request could not be completed.", result.diagnostics);
      return parseXweatherLightningPayload(result.payload, result.diagnostics, LIGHTNING_QUERY_LIMIT);
    },
  };
}
