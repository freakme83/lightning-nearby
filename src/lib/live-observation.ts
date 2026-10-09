import type { RiskLevel } from "./weather.ts";
import type { LiveLightningApiResult, LiveLightningSummary } from "./lightning/types.ts";
import { t, type Locale } from "./i18n.ts";

export type LiveSeverity = "none" | "nearby" | "elevated" | "high";
export type CurrentSeverity = RiskLevel | "nearby";

/** Human-readable label for the live observation alone. */
export function liveSeverityLabel(severity: LiveSeverity | null, locale: Locale = "en"): string | null {
  if (severity === "high") return t(locale, "liveVeryClose");
  if (severity === "elevated") return t(locale, "liveNearby");
  if (severity === "nearby") return t(locale, "liveInArea");
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

export type LiveCopySegment = { text: string; emphasize?: boolean };

/** Only a clear current window with positive broader-area evidence emphasizes detection. */
export function liveActivitySegments(summary: LiveLightningSummary, locale: Locale = "en"): LiveCopySegment[] {
  const hasRecentAreaActivity = summary.recentArea.totalDetections > 0;
  if (summary.current.status === "unavailable") {
    return [{ text: t(locale, hasRecentAreaActivity ? "recentUnavailable" : "noRecent") }];
  }
  if (summary.current.status === "clear" || summary.current.status === "not-requested") {
    return hasRecentAreaActivity ? [
      { text: t(locale, "recentClearBefore") },
      { text: t(locale, "recentClearDetected"), emphasize: true },
      { text: t(locale, "recentClearAfter") },
    ] : [{ text: t(locale, "noRecent") }];
  }
  return [{ text: t(locale, hasRecentAreaActivity ? "recentActive" : "activityNearby") }];
}

export function liveActivityCopy(summary: LiveLightningSummary, locale: Locale = "en"): string {
  return liveActivitySegments(summary, locale).map(segment => segment.text).join("");
}

export function liveEventCountCopy(count: number, radiusKm: number, locale: Locale = "en"): string {
  return t(locale, count === 1 ? "eventOne" : "eventMany", { count, radius: radiusKm });
}

/** Both requests start on the same manual action; neither awaits the other. */
export function requestLiveCheck(
  origin: "automatic" | "manual-check" | "manual-refresh",
  checkActivity: () => Promise<void>,
  refreshForecast?: () => void,
): Promise<void> {
  const liveRequest = checkActivity();
  if (origin === "manual-refresh") refreshForecast?.();
  return liveRequest;
}
