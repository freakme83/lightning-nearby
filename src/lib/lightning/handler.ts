import { isValidCoordinates } from "../location.ts";
import { createXweatherProvider } from "./xweather.ts";
import { summarizeRecentActivity } from "./summary.ts";
import { EMPTY_PROVIDER_DIAGNOSTICS, type LiveLightningApiResult, type ProviderDiagnostics } from "./types.ts";

export interface LightningHandlerOptions {
  clientId?: string;
  clientSecret?: string;
  fetcher?: typeof fetch;
  now?: () => number;
  signal?: AbortSignal;
}

export interface LightningHandlerResponse {
  httpStatus: number;
  body: LiveLightningApiResult;
}

export async function handleLiveLightningRequest(body: unknown, options: LightningHandlerOptions = {}): Promise<LightningHandlerResponse> {
  const noDiagnostics: ProviderDiagnostics = EMPTY_PROVIDER_DIAGNOSTICS;
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { httpStatus: 400, body: { ok: false, status: "invalid-coordinates", message: "Send latitude and longitude as JSON numbers.", diagnostics: noDiagnostics } };
  }
  const { latitude, longitude } = body as Record<string, unknown>;
  if (typeof latitude !== "number" || typeof longitude !== "number" || !isValidCoordinates(latitude, longitude)) {
    return { httpStatus: 400, body: { ok: false, status: "invalid-coordinates", message: "Latitude must be between -90 and 90 and longitude between -180 and 180.", diagnostics: noDiagnostics } };
  }

  const provider = createXweatherProvider({ clientId: options.clientId, clientSecret: options.clientSecret }, options.fetcher);
  const result = await provider.fetchRecentActivity(latitude, longitude, options.signal);
  if (!result.ok) {
    const httpStatus = result.status === "provider-not-configured" ? 503
      : result.status === "provider-quota-exceeded" ? 503
        : result.status === "provider-unavailable" ? 503 : 502;
    return { httpStatus, body: { ok: false, status: result.status, message: result.message, diagnostics: result.diagnostics } };
  }

  const fetchedAt = (options.now ?? Date.now)();
  return {
    httpStatus: 200,
    body: {
      ok: true,
      summary: summarizeRecentActivity(result.events, latitude, longitude, fetchedAt, result.rejectedEventCount, result.diagnostics, result.mayBeTruncated),
    },
  };
}
