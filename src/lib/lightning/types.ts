import type { CompassDirection } from "./bearing.ts";

export const LIGHTNING_WINDOW_MINUTES = 5;
export const LIGHTNING_QUERY_RADIUS_KM = 50;
export const LIGHTNING_QUERY_LIMIT = 1000;

export type PulseType = "IC" | "CG" | "unknown";

/** One provider event normalized for distance and recent-window calculations. */
export interface LiveStrike {
  observedAtMs: number;
  latitude: number;
  longitude: number;
  type: PulseType;
}

export interface ProviderDiagnostics {
  httpStatus: number | null;
  costTokens: string | null;
  costMultiplier: string | null;
  remainingMinute: string | null;
  remainingPeriod: string | null;
}

export const EMPTY_PROVIDER_DIAGNOSTICS: ProviderDiagnostics = {
  httpStatus: null,
  costTokens: null,
  costMultiplier: null,
  remainingMinute: null,
  remainingPeriod: null,
};

export type ProviderFailureStatus =
  | "provider-not-configured"
  | "provider-auth-error"
  | "provider-quota-exceeded"
  | "provider-rejected-request"
  | "provider-unavailable"
  | "malformed-response";

export type ProviderResult =
  | { ok: true; events: LiveStrike[]; rejectedEventCount: number; mayBeTruncated: boolean; diagnostics: ProviderDiagnostics }
  | { ok: false; status: ProviderFailureStatus; message: string; diagnostics: ProviderDiagnostics };

export interface LiveLightningSummary {
  status: "live";
  provider: "xweather";
  observationWindowMinutes: number;
  fetchedAt: number;
  latestEventAt: number | null;
  nearestKm: number | null;
  nearestDirection?: CompassDirection | null;
  nearestAgeMinutes: number | null;
  counts: { within5Km: number; within10Km: number; within25Km: number; within50Km: number };
  totalEvents: number;
  rejectedEventCount: number;
  mayBeTruncated: boolean;
  diagnostics: ProviderDiagnostics;
}

export type LiveLightningApiResult =
  | { ok: true; summary: LiveLightningSummary }
  | { ok: false; status: ProviderFailureStatus | "invalid-coordinates"; message: string; diagnostics: ProviderDiagnostics };
