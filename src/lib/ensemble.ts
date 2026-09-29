import { isThunderstormCode } from "./weather.ts";

export type EnsembleModel = "icon_eu_eps" | "icon_global_eps";

export interface EnsembleThunderstormSupport {
  time: number;
  supportingMembers: number;
  availableMembers: number;
  model: string;
}

export interface EnsembleForecast {
  timezone: string;
  hours: EnsembleThunderstormSupport[];
  fetchedAt: number;
}

const MODEL_LABEL: Record<EnsembleModel, string> = {
  icon_eu_eps: "ICON-EU EPS",
  icon_global_eps: "ICON global EPS",
};

function usableCode(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 99;
}

/** The unsuffixed weather_code is the control member; count only actual usable member values. */
export function parseEnsembleForecast(payload: unknown, model: EnsembleModel, fetchedAt = Date.now()): EnsembleForecast | null {
  if (typeof payload !== "object" || payload === null) return null;
  const data = payload as Record<string, unknown>;
  if (typeof data.timezone !== "string" || !data.timezone || typeof data.hourly !== "object" || data.hourly === null) return null;
  const hourly = data.hourly as Record<string, unknown>;
  if (!Array.isArray(hourly.time)) return null;
  const memberSeries = Object.entries(hourly)
    .filter(([key, value]) => /^weather_code(?:_member\d+)?$/.test(key) && Array.isArray(value))
    .map(([, value]) => value as unknown[]);
  if (!memberSeries.length) return null;

  const seen = new Set<number>();
  const hours: EnsembleThunderstormSupport[] = [];
  for (const [index, value] of hourly.time.entries()) {
    if (typeof value !== "number" || !Number.isInteger(value) || value % 3_600 !== 0 || seen.has(value)) continue;
    seen.add(value);
    const codes = memberSeries.map((series) => series[index]).filter(usableCode);
    if (!codes.length) continue; // No usable members is unavailable, not zero support.
    hours.push({
      time: value,
      supportingMembers: codes.filter(isThunderstormCode).length,
      availableMembers: codes.length,
      model: MODEL_LABEL[model],
    });
  }
  if (!hours.length) return null;
  return { timezone: data.timezone, hours: hours.sort((a, b) => a.time - b.time), fetchedAt };
}

function preferredModel(latitude: number, longitude: number): EnsembleModel {
  // Broad ICON-EU footprint; the API response decides whether this point actually has data.
  return latitude >= 29.5 && latitude <= 70.5 && longitude >= -23.5 && longitude <= 62.5
    ? "icon_eu_eps" : "icon_global_eps";
}

export async function fetchEnsembleForecast(
  latitude: number,
  longitude: number,
  signal?: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<EnsembleForecast> {
  const preferred = preferredModel(latitude, longitude);
  const models: EnsembleModel[] = preferred === "icon_eu_eps" ? [preferred, "icon_global_eps"] : [preferred];
  for (const model of models) {
    const url = new URL("https://ensemble-api.open-meteo.com/v1/ensemble");
    url.searchParams.set("latitude", String(latitude));
    url.searchParams.set("longitude", String(longitude));
    url.searchParams.set("hourly", "weather_code");
    url.searchParams.set("models", model);
    url.searchParams.set("forecast_hours", "48");
    url.searchParams.set("timezone", "auto");
    url.searchParams.set("timeformat", "unixtime");
    try {
      const response = await fetcher(url, { signal, cache: "no-store" });
      if (!response.ok) continue;
      const data: unknown = await response.json();
      if (signal?.aborted) throw signal.reason ?? new DOMException("Forecast cancelled", "AbortError");
      const forecast = parseEnsembleForecast(data, model);
      if (forecast) return forecast;
    } catch (error) {
      if (signal?.aborted) throw error;
      // A regional request may fail independently; try global where appropriate.
    }
  }
  throw new Error("ensemble-unavailable");
}
