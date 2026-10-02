import type { RiskLevel } from "./weather.ts";
import type { LiveLightningApiResult, LiveLightningSummary } from "./lightning/types.ts";
import { t, type Locale } from "./i18n.ts";

export type LiveSeverity = "none" | "nearby" | "elevated" | "high";
export type CurrentSeverity = RiskLevel | "nearby";

/** Human-readable label for the live observation alone. */
export function liveSeverityLabel(severity: LiveSeverity | null, locale: Locale = "en"): string | null {
  if (severity === "high") return t(locale, "high");
  if (severity === "elevated") return t(locale, "elevated");
  if (severity === "nearby") return t(locale, "nearbyActivity");
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

export function liveActivityCopy(summary: LiveLightningSummary, locale: Locale = "en"): string {
  const hasRecentAreaActivity = summary.recentArea.totalDetections > 0;
  if (summary.current.status === "unavailable") {
    return hasRecentAreaActivity
      ? t(locale, "recentUnavailable")
      : t(locale, "noRecent");
  }
  if (summary.current.status === "clear" || summary.current.status === "not-requested") {
    return hasRecentAreaActivity
      ? t(locale, "recentClear")
      : t(locale, "noRecent");
  }
  return hasRecentAreaActivity
    ? t(locale, "recentActive")
    : t(locale, "activityNearby");
}

export function liveEventCountCopy(count: number, radiusKm: number, locale: Locale = "en"): string {
  return t(locale, count === 1 ? "eventOne" : "eventMany", { count, radius: radiusKm });
}
