import { isValidCoordinates } from "../location.ts";
import { EMPTY_PROVIDER_DIAGNOSTICS, LIGHTNING_QUERY_LIMIT, LIGHTNING_QUERY_RADIUS_KM, type LiveStrike, type ProviderDiagnostics, type ProviderFailureStatus, type ProviderResult } from "./types.ts";
import type { LightningProvider } from "./provider.ts";

type FetchLike = (input: URL | RequestInfo, init?: RequestInit) => Promise<Response>;
type Credentials = { clientId?: string; clientSecret?: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function diagnosticsFromHeaders(headers: Headers, httpStatus: number): ProviderDiagnostics {
  return {
    httpStatus,
    costTokens: headers.get("x-cost-tokens"),
    costMultiplier: headers.get("x-cost-multiplier") ?? headers.get("x-cost-multipliers"),
    remainingMinute: headers.get("x-ratelimit-remaining-minute"),
    remainingPeriod: headers.get("x-ratelimit-remaining-period"),
  };
}

function failure(status: ProviderFailureStatus, message: string, diagnostics = EMPTY_PROVIDER_DIAGNOSTICS): ProviderResult {
  return { ok: false, status, message, diagnostics };
}

function classifyProviderError(code: unknown): ProviderFailureStatus {
  if (code === "invalid_client" || code === "unauthorized_namespace" || code === "insufficient_scope") return "provider-auth-error";
  if (code === "maxhits" || code === "maxhits_daily" || code === "maxhits_min") return "provider-quota-exceeded";
  return "provider-rejected-request";
}

function normalizeEvent(value: unknown): LiveStrike | null {
  if (!isRecord(value) || !isRecord(value.loc) || !isRecord(value.ob)) return null;
  const { lat, long } = value.loc;
  const timestamp = value.ob.timestamp;
  if (typeof lat !== "number" || typeof long !== "number" || !isValidCoordinates(lat, long)
    || typeof timestamp !== "number" || !Number.isFinite(timestamp) || timestamp <= 0) return null;
  const pulse = isRecord(value.ob.pulse) ? value.ob.pulse : null;
  const rawType = pulse?.type;
  const normalizedType = typeof rawType === "string" ? rawType.toUpperCase() : "";
  const type = normalizedType === "IC" || normalizedType === "CG" ? normalizedType : "unknown";
  return { observedAtMs: timestamp * 1000, latitude: lat, longitude: long, type };
}

/** Parse only the documented /lightning event fields that the app needs. */
export function parseXweatherLightningPayload(payload: unknown, diagnostics = EMPTY_PROVIDER_DIAGNOSTICS, requestedLimit = LIGHTNING_QUERY_LIMIT): ProviderResult {
  if (!isRecord(payload)) return failure("malformed-response", "Xweather returned an unexpected response shape.", diagnostics);
  const providerError = isRecord(payload.error) ? payload.error : null;
  if (payload.success !== true) {
    if (providerError && typeof providerError.code === "string") return failure(classifyProviderError(providerError.code), "Xweather did not return usable lightning data.", diagnostics);
    return failure("malformed-response", "Xweather returned an unexpected response shape.", diagnostics);
  }
  if (!Array.isArray(payload.response)) return failure("malformed-response", "Xweather returned an unexpected response shape.", diagnostics);
  if (providerError?.code === "warn_no_data" && payload.response.length === 0) {
    return { ok: true, events: [], rejectedEventCount: 0, mayBeTruncated: false, diagnostics };
  }
  if (providerError || payload.error !== null) {
    return failure(providerError && typeof providerError.code === "string" ? classifyProviderError(providerError.code) : "malformed-response", "Xweather returned a warning or error with the response.", diagnostics);
  }

  const events: LiveStrike[] = [];
  let rejectedEventCount = 0;
  for (const row of payload.response) {
    const event = normalizeEvent(row);
    if (event) events.push(event);
    else rejectedEventCount += 1;
  }
  if (rejectedEventCount > 0 && events.length === 0) {
    return failure("malformed-response", "Xweather returned lightning records with unusable fields.", diagnostics);
  }
  return { ok: true, events, rejectedEventCount, mayBeTruncated: payload.response.length >= requestedLimit, diagnostics };
}

function failureForHttpStatus(status: number, diagnostics: ProviderDiagnostics): ProviderResult {
  if (status === 401 || status === 403) return failure("provider-auth-error", "Xweather rejected the credentials or application namespace.", diagnostics);
  if (status === 429) return failure("provider-quota-exceeded", "Xweather rate or access quota was reached.", diagnostics);
  if (status >= 500) return failure("provider-unavailable", "Xweather is temporarily unavailable.", diagnostics);
  return failure("provider-rejected-request", "Xweather rejected the request.", diagnostics);
}

export function createXweatherProvider(credentials: Credentials, fetcher: FetchLike = fetch): LightningProvider {
  return {
    async fetchRecentActivity(latitude, longitude, signal): Promise<ProviderResult> {
      if (!credentials.clientId?.trim() || !credentials.clientSecret?.trim()) {
        return failure("provider-not-configured", "Server-side Xweather credentials are not configured.");
      }
      if (!isValidCoordinates(latitude, longitude)) {
        return failure("provider-rejected-request", "The monitored coordinates are invalid.");
      }

      const url = new URL("https://data.api.xweather.com/lightning/closest");
      url.searchParams.set("p", `${latitude},${longitude}`);
      url.searchParams.set("radius", `${LIGHTNING_QUERY_RADIUS_KM}km`);
      url.searchParams.set("limit", String(LIGHTNING_QUERY_LIMIT));
      url.searchParams.set("filter", "all");
      url.searchParams.set("client_id", credentials.clientId);
      url.searchParams.set("client_secret", credentials.clientSecret);

      let response: Response;
      try {
        const timeoutSignal = AbortSignal.timeout(10_000);
        const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
        response = await fetcher(url, { method: "GET", cache: "no-store", signal: combinedSignal });
      } catch {
        return failure("provider-unavailable", "The Xweather request could not be completed.");
      }

      const diagnostics = diagnosticsFromHeaders(response.headers, response.status);
      if (!response.ok) return failureForHttpStatus(response.status, diagnostics);

      let payload: unknown;
      try { payload = await response.json(); }
      catch { return failure("malformed-response", "Xweather returned invalid JSON.", diagnostics); }
      return parseXweatherLightningPayload(payload, diagnostics);
    },
  };
}
