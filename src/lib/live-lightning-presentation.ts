import type { BlitzExperimentalResult } from "./lightning/blitz-experimental.ts";
import type { LiveLightningApiResult, CurrentLightningEvent, ProviderFailureStatus } from "./lightning/types.ts";
import type { CompassDirection } from "./lightning/bearing.ts";

export type LiveLightningSource = "xweather" | "blitz-experimental";
export type LivePresentationStatus = "active" | "clear" | "unknown" | "unavailable";
export const DEVELOPER_LIVE_SOURCE_STORAGE_KEY = "lightning-nearby:developer-live-source";

export interface LiveLightningPresentation {
  source: LiveLightningSource;
  status: LivePresentationStatus;
  events: CurrentLightningEvent[];
  latestEventAt: number | null;
  nearestKm: number | null;
  nearestDirection: CompassDirection | null;
  nearestAgeMinutes: number | null;
  counts: { within5Km: number; within10Km: number; within25Km: number; within40Km: number };
  currentWindowMinutes: number;
  currentRadiusKm: number;
  recentStatus: "active" | "clear" | "unknown";
  recentWindowMinutes: number;
  recentRadiusKm: number;
  recentDetections: number;
  failureStatus?: ProviderFailureStatus | "invalid-coordinates";
}

const emptyCounts = { within5Km: 0, within10Km: 0, within25Km: 0, within40Km: 0 };

export function unavailableLivePresentation(source: LiveLightningSource,
  failureStatus: LiveLightningPresentation["failureStatus"] = "provider-unavailable"): LiveLightningPresentation {
  return { source, status: "unavailable", events: [], latestEventAt: null, nearestKm: null,
    nearestDirection: null, nearestAgeMinutes: null, counts: emptyCounts,
    currentWindowMinutes: 5, currentRadiusKm: 40, recentStatus: "unknown",
    recentWindowMinutes: source === "xweather" ? 30 : 15, recentRadiusKm: 50,
    recentDetections: 0, failureStatus };
}

export function normalizeXweatherPresentation(result: LiveLightningApiResult): LiveLightningPresentation {
  if (!result.ok) return unavailableLivePresentation("xweather", result.status);
  const { current, recentArea } = result.summary;
  const common = { source: "xweather" as const,
    recentStatus: recentArea.status as "active" | "clear", recentWindowMinutes: recentArea.windowMinutes,
    recentRadiusKm: recentArea.radiusKm, recentDetections: recentArea.totalDetections,
    currentWindowMinutes: current.windowMinutes, currentRadiusKm: current.radiusKm };
  if (current.status === "unavailable") return { ...unavailableLivePresentation("xweather", current.failureStatus), ...common };
  if (current.status === "not-requested") return { ...common, status: "clear", events: [], latestEventAt: null,
    nearestKm: null, nearestDirection: null, nearestAgeMinutes: null, counts: emptyCounts };
  return { ...common, status: current.status, events: current.events, latestEventAt: current.latestEventAt,
    nearestKm: current.nearestKm, nearestDirection: current.nearestDirection,
    nearestAgeMinutes: current.nearestAgeMinutes, counts: current.counts };
}

export function normalizeBlitzPresentation(result: BlitzExperimentalResult): LiveLightningPresentation {
  if (!result.ok) return unavailableLivePresentation("blitz-experimental", result.status);
  const { recent, current } = result.summary;
  return { source: "blitz-experimental", status: current.status, events: current.events,
    latestEventAt: current.latestEventAt, nearestKm: current.nearestKm,
    nearestDirection: current.nearestDirection, nearestAgeMinutes: current.nearestAgeMinutes,
    counts: current.counts, currentWindowMinutes: current.windowMinutes, currentRadiusKm: current.radiusKm,
    recentStatus: recent.status, recentWindowMinutes: recent.windowMinutes,
    recentRadiusKm: recent.radiusKm, recentDetections: recent.totalDetections };
}

export function liveSourceEndpoint(source: LiveLightningSource): string {
  return source === "xweather" ? "/api/lightning/live" : "/api/lightning/blitz-experimental";
}

export function developerLiveMode(search: string, hostname: string): boolean {
  return new URLSearchParams(search).get("lightningDev") === "1" ||
    hostname.toLowerCase() === "merge-ready--lightning-nearby.netlify.app";
}

export function parseStoredLiveSource(value: string | null): LiveLightningSource | null {
  return value === "xweather" || value === "blitz-experimental" ? value : null;
}

export function initialLiveSourceForCheck(autoCheckEligible: boolean, developerModeReady: boolean,
  sourcePreferenceReady: boolean, developerMode: boolean, selectedSource: LiveLightningSource,
  sourceRef: LiveLightningSource, resolvedInitialSource: LiveLightningSource | null): LiveLightningSource | null {
  if (!autoCheckEligible || !developerModeReady || !sourcePreferenceReady ||
      selectedSource !== sourceRef || selectedSource !== resolvedInitialSource) return null;
  if (!developerMode) return selectedSource === "xweather" ? "xweather" : null;
  return selectedSource;
}

export function isCurrentSourceRequest(requestId: number, latestId: number, requestSource: LiveLightningSource,
  currentSource: LiveLightningSource, requestLocation: string, currentLocation: string, signal: AbortSignal): boolean {
  return requestSource === currentSource && !signal.aborted && requestId === latestId && requestLocation === currentLocation;
}

export function canStartLiveSourceRequest(explicitSource: LiveLightningSource | undefined,
  selectedSource: LiveLightningSource): boolean {
  return explicitSource === undefined || explicitSource === selectedSource;
}

export function ownsLiveRequestController(current: AbortController | null, request: AbortController): boolean {
  return current === request;
}

export function livePresentationSeverity(presentation: LiveLightningPresentation | null): "none" | "nearby" | "elevated" | "high" | null {
  if (!presentation) return null;
  if (presentation.status === "clear") return "none";
  if (presentation.status !== "active" || presentation.nearestKm === null ||
      !Number.isFinite(presentation.nearestKm) || presentation.nearestKm < 0 || presentation.nearestKm > presentation.currentRadiusKm) return null;
  if (presentation.nearestKm <= 10) return "high";
  if (presentation.nearestKm <= 25) return "elevated";
  return "nearby";
}
