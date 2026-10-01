import { explainSignalDecision, type OutlookHour } from "./outlook.ts";
import { formatForecastLocalTime } from "./timezone.ts";
import { describeWeatherCode } from "./weather.ts";

export type DebugEnsembleStatus = "not-loaded" | "loading" | "available" | "unavailable";

export interface ForecastDebugSnapshotInput {
  latitude: number;
  longitude: number;
  hour?: OutlookHour;
  providerTimezone?: string;
  displayTimezone?: string;
  ensembleStatus: DebugEnsembleStatus;
  ensembleFetchedAt?: number;
}

function available<T>(value: T | null | undefined): T | "unavailable" {
  return value == null ? "unavailable" : value;
}

function localTime(hour: OutlookHour | undefined, timezone: string | undefined): string | "unavailable" {
  if (!hour || !timezone) return "unavailable";
  try {
    return formatForecastLocalTime(hour.time, timezone);
  } catch {
    return "unavailable";
  }
}

/** Compact, shareable snapshot of the normalized production outlook and its shared decision explanation. */
export function createForecastDebugSnapshot(input: ForecastDebugSnapshotInput): string {
  const hour = input.hour;
  const ensemble = hour?.evidence.ensemble;
  const decision = hour ? explainSignalDecision(hour.evidence) : null;
  const signal = hour?.signal;
  const displayTimezone = input.displayTimezone;

  return JSON.stringify({
    coordinates: { latitude: input.latitude, longitude: input.longitude },
    selectedTime: {
      unixTimestamp: available(hour?.time),
      utcIso: hour ? new Date(hour.time * 1_000).toISOString() : "unavailable",
      localTime: localTime(hour, displayTimezone),
    },
    timezones: {
      provider: available(input.providerTimezone),
      resolvedDisplay: available(displayTimezone),
    },
    deterministic: {
      weatherCode: available(hour?.weatherCode),
      weatherDescription: hour ? describeWeatherCode(hour.weatherCode) : "unavailable",
      thunderstormProbabilityPercent: available(hour?.evidence.providerProbability),
      precipitationProbabilityPercent: available(hour?.precipitationProbability),
      capeJPerKg: available(hour?.cape),
      convectiveInhibitionJPerKg: available(hour?.convectiveInhibition),
      qualitativeRisk: hour?.signal.kind === "qualitative" ? hour.signal.risk : "unavailable",
    },
    ensemble: {
      fetchStatus: input.ensembleStatus,
      interpretation: "model member support; not probability",
      model: available(ensemble?.model),
      supportingMembers: available(ensemble?.supportingMembers),
      availableMembers: available(ensemble?.availableMembers),
      sampledLocations: available(ensemble?.sampledLocations),
      spatialWindowKm: available(ensemble?.spatialWindowKm),
      temporalWindowPlusMinusHours: available(ensemble?.temporalWindowHours),
      fetchedAtUnixMs: available(input.ensembleFetchedAt),
    },
    finalOutlook: {
      signalKind: available(signal?.kind),
      qualitativeLevel: signal?.kind === "qualitative" ? signal.risk : "unavailable",
      providerProbabilityPercent: available(hour?.evidence.providerProbability),
      ensembleEvidencePresent: Boolean(ensemble),
    },
    decision: {
      qualitativeExplanation: decision?.qualitative ?? "Qualitative signal unavailable because no hour is selected.",
      ensembleExplanation: decision?.ensemble ?? "Ensemble evidence unavailable because no hour is selected.",
    },
  }, null, 2);
}
