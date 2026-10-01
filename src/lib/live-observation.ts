import type { RiskLevel } from "./weather.ts";
import type { LiveLightningApiResult, LiveLightningSummary } from "./lightning/types.ts";

export type LiveSeverity = "none" | "nearby" | "elevated" | "high";
export type CurrentSeverity = RiskLevel | "nearby";

/** Human-readable label for the live observation alone. */
export function liveSeverityLabel(severity: LiveSeverity | null): string | null {
  if (severity === "high") return "High";
  if (severity === "elevated") return "Elevated";
  if (severity === "nearby") return "Nearby activity";
  return null;
}

/** A successful empty window is zero; a failed or unobserved request is unknown. */
export function liveSeverity(result: LiveLightningApiResult | null): LiveSeverity | null {
  if (!result?.ok) return null;
  const current = result.summary.current;
  if (current.status === "not-requested" || current.status === "clear") return "none";
  if (current.status === "unavailable") return null;
  const { nearestKm } = current;
  if (nearestKm === null || !Number.isFinite(nearestKm) || nearestKm < 0 || nearestKm > 40) return null;
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
  const hasRecentAreaActivity = summary.recentArea.totalDetections > 0;
  if (summary.current.status === "unavailable") {
    return hasRecentAreaActivity
      ? "Activity was also detected within 50 km during the last 30 minutes, but current nearby activity is unavailable."
      : "No recent lightning activity was reported within 50 km in the last 30 minutes.";
  }
  if (summary.current.status === "clear" || summary.current.status === "not-requested") {
    return hasRecentAreaActivity
      ? "Activity was also detected within 50 km during the last 30 minutes."
      : "No recent lightning activity was reported within 50 km in the last 30 minutes.";
  }
  return hasRecentAreaActivity
    ? "Activity also detected within 50 km during the last 30 minutes."
    : "Lightning activity detected nearby.";
}

export function liveEventCountCopy(count: number, radiusKm: number): string {
  return `${count} recent lightning ${count === 1 ? "event" : "events"} within ${radiusKm} km · last 5 min`;
}
