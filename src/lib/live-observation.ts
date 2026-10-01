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
  if (summary.recentArea.totalDetections === 0) {
    return "No recent lightning detections reported within 50 km in the last 30 minutes.";
  }
  if (summary.current.status === "unavailable") {
    return "Lightning activity was detected within 50 km in the last 30 minutes, but current nearby activity is unavailable.";
  }
  if (summary.current.status === "clear" || summary.current.status === "not-requested") {
    return "Lightning activity was detected nearby during the last 30 minutes, but no current flashes were detected within 40 km in the last 5 minutes.";
  }
  return "Lightning activity detected nearby.";
}
