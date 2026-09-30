import type { RiskLevel } from "./weather.ts";
import type { LiveLightningApiResult, LiveLightningSummary } from "./lightning/types.ts";

export type LiveSeverity = "none" | "nearby" | "elevated" | "high";
export type CurrentSeverity = RiskLevel | "nearby";

/** A successful empty window is zero; a failed or unobserved request is unknown. */
export function liveSeverity(result: LiveLightningApiResult | null): LiveSeverity | null {
  if (!result?.ok) return null;
  const { totalEvents, nearestKm } = result.summary;
  if (totalEvents === 0) return "none";
  if (nearestKm === null || !Number.isFinite(nearestKm) || nearestKm < 0 || nearestKm > 50) return null;
  if (nearestKm <= 10) return "high";
  if (nearestKm <= 25) return "elevated";
  return "nearby";
}

const WEIGHT: Record<CurrentSeverity | "none", number> = { none: 0, low: 1, nearby: 2, elevated: 3, high: 4 };

/** Display only: neither evidence source nor its classifier is changed. */
export function currentSeverity(forecast: RiskLevel | null, live: LiveSeverity | null): CurrentSeverity | null {
  if (!forecast) return live === null || live === "none" ? null : live;
  return live && live !== "none" && WEIGHT[live] > WEIGHT[forecast] ? live : forecast;
}

export function isCurrentLiveRequest(requestId: number, latestId: number, requestLocation: string, currentLocation: string, signal: AbortSignal): boolean {
  return !signal.aborted && requestId === latestId && requestLocation === currentLocation;
}

export function liveActivityCopy(summary: LiveLightningSummary): string {
  return summary.totalEvents === 0
    ? "No recent lightning activity detected within 50 km."
    : "Lightning activity detected nearby.";
}
