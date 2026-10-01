import { isValidCoordinates } from "../location.ts";
import { summarizeCurrentFlashes } from "./summary.ts";
import {
  EMPTY_PROVIDER_DIAGNOSTICS,
  LIVE_AREA_RADIUS_KM,
  LIVE_AREA_WINDOW_MINUTES,
  LIVE_CURRENT_RADIUS_KM,
  LIVE_CURRENT_WINDOW_MINUTES,
  type LiveLightningApiResult,
  type CurrentLightning,
  type RecentAreaActive,
  type RecentAreaClear,
  type ProviderDiagnostics,
  type ProviderFailureStatus,
} from "./types.ts";
import { createXweatherLiveProvider } from "./xweather-live.ts";

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

function responseStatus(status: ProviderFailureStatus): number {
  return status === "provider-not-configured" || status === "provider-quota-exceeded" || status === "provider-unavailable" ? 503 : 502;
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

  const provider = createXweatherLiveProvider({ clientId: options.clientId, clientSecret: options.clientSecret }, options.fetcher);
  const recentAreaResult = await provider.fetchRecentArea(latitude, longitude, options.signal);
  if (!recentAreaResult.ok) {
    return {
      httpStatus: responseStatus(recentAreaResult.status),
      body: { ok: false, status: recentAreaResult.status, message: recentAreaResult.message, diagnostics: recentAreaResult.diagnostics },
    };
  }

  if (recentAreaResult.totalDetections === 0) {
    const fetchedAt = (options.now ?? Date.now)();
    const recentArea: RecentAreaClear = {
      status: "clear",
      windowMinutes: LIVE_AREA_WINDOW_MINUTES,
      radiusKm: LIVE_AREA_RADIUS_KM,
      totalDetections: 0,
      oldestEventAt: recentAreaResult.oldestEventAt,
      newestEventAt: recentAreaResult.newestEventAt,
      diagnostics: recentAreaResult.diagnostics,
    };
    return {
      httpStatus: 200,
      body: {
        ok: true,
        summary: {
          status: "live",
          provider: "xweather",
          fetchedAt,
          recentArea,
          current: { status: "not-requested", windowMinutes: LIVE_CURRENT_WINDOW_MINUTES, radiusKm: LIVE_CURRENT_RADIUS_KM },
        },
      },
    };
  }

  const recentArea: RecentAreaActive = {
    status: "active",
    windowMinutes: LIVE_AREA_WINDOW_MINUTES,
    radiusKm: LIVE_AREA_RADIUS_KM,
    totalDetections: recentAreaResult.totalDetections,
    oldestEventAt: recentAreaResult.oldestEventAt,
    newestEventAt: recentAreaResult.newestEventAt,
    diagnostics: recentAreaResult.diagnostics,
  };
  const fetchedAt = (options.now ?? Date.now)();
  const currentResult = await provider.fetchCurrentFlashes(latitude, longitude, options.signal);
  const current: CurrentLightning = currentResult.ok
    ? summarizeCurrentFlashes(currentResult.events, latitude, longitude, fetchedAt, currentResult.rejectedEventCount, currentResult.diagnostics, currentResult.mayBeTruncated)
    : {
      status: "unavailable" as const,
      windowMinutes: LIVE_CURRENT_WINDOW_MINUTES,
      radiusKm: LIVE_CURRENT_RADIUS_KM,
      failureStatus: currentResult.status,
      message: currentResult.message,
      diagnostics: currentResult.diagnostics,
    };
  return {
    httpStatus: 200,
    body: {
      ok: true,
      summary: { status: "live", provider: "xweather", fetchedAt, recentArea, current },
    },
  };
}
