export type RiskLevel = "low" | "elevated" | "high";

export interface ForecastHour {
  /** Unix seconds at the forecast provider's hourly timestamp. */
  time: number;
  weatherCode?: number;
  precipitationProbability?: number;
  cape?: number;
  convectiveInhibition?: number;
  thunderstormProbability?: number;
  risk: RiskLevel;
}

export interface Forecast {
  timezone: string;
  latitude: number;
  longitude: number;
  hours: ForecastHour[];
  fetchedAt: number;
}

export interface RiskInputs {
  weatherCode?: number | null;
  thunderstormProbability?: number | null;
  precipitationProbability?: number | null;
  cape?: number | null;
  convectiveInhibition?: number | null;
}

/**
 * All classification thresholds live here. These are deliberately broad,
 * qualitative heuristics, not a calibrated probability or official warning.
 */
export const RISK_THRESHOLDS = {
  directThunderstormProbabilityElevated: 20,
  directThunderstormProbabilityHigh: 50,
  elevatedCapeJPerKg: 700,
  elevatedPrecipitationProbabilityPercent: 40,
} as const;

const THUNDERSTORM_CODES = new Set([95, 96, 99]);

export function classifyRisk(input: RiskInputs): RiskLevel {
  // An upstream thunderstorm code is the clearest available signal in this
  // globally usable forecast. Hail codes are included in the same top class.
  if (input.weatherCode != null && THUNDERSTORM_CODES.has(input.weatherCode)) {
    return "high";
  }

  // When supplied, the upstream thunderstorm probability is authoritative
  // over the weaker CAPE + precipitation fallback, including values below
  // our Elevated cutoff. Open-Meteo's coverage for this field is model-limited.
  if (input.thunderstormProbability != null) {
    if (input.thunderstormProbability >= RISK_THRESHOLDS.directThunderstormProbabilityHigh) return "high";
    if (input.thunderstormProbability >= RISK_THRESHOLDS.directThunderstormProbabilityElevated) return "elevated";
    return "low";
  }

  // Rain by itself and instability by itself are not thunderstorm evidence.
  // Elevated requires both meaningful CAPE and a precipitation signal. CIN
  // remains informational: model availability varies and we do not apply an
  // unvalidated CIN threshold to this deliberately small qualitative rule.
  if (
    input.cape != null && input.cape >= RISK_THRESHOLDS.elevatedCapeJPerKg &&
    input.precipitationProbability != null &&
    input.precipitationProbability >= RISK_THRESHOLDS.elevatedPrecipitationProbabilityPercent
  ) {
    return "elevated";
  }

  return "low";
}

export function selectNext24Hours(hours: ForecastHour[], nowMs = Date.now()): ForecastHour[] {
  // Keep 24 chronological hourly buckets beginning with the current hour.
  // Epoch seconds make this work across midnight and daylight-saving changes.
  const firstHour = Math.floor(nowMs / 3_600_000) * 3_600;
  const end = firstHour + 24 * 3_600;
  return hours.filter((hour) => hour.time >= firstHour && hour.time < end).slice(0, 24);
}

export interface RiskWindow {
  start: number;
  end: number;
  level: Exclude<RiskLevel, "low">;
}

const SEVERITY: Record<RiskLevel, number> = { low: 0, elevated: 1, high: 2 };

export function calculateHighestRiskWindow(hours: ForecastHour[]): RiskWindow | null {
  const peak = Math.max(0, ...hours.map((hour) => SEVERITY[hour.risk]));
  if (peak === 0) return null;

  const candidates: RiskWindow[] = [];
  let run: ForecastHour[] = [];
  const saveRun = () => {
    if (!run.length) return;
    candidates.push({ start: run[0].time, end: run[run.length - 1].time + 3_600, level: run[0].risk as Exclude<RiskLevel, "low"> });
    run = [];
  };

  for (const hour of hours) {
    const isPeak = SEVERITY[hour.risk] === peak;
    const continues = run.length > 0 && hour.time === run[run.length - 1].time + 3_600;
    if (!isPeak) saveRun();
    else {
      if (!continues) saveRun();
      run.push(hour);
    }
  }
  saveRun();
  return candidates.sort((a, b) => (b.end - b.start) - (a.end - a.start) || a.start - b.start)[0] ?? null;
}

interface OpenMeteoResponse {
  timezone?: string;
  latitude?: number;
  longitude?: number;
  hourly?: {
    time?: number[];
    weather_code?: Array<number | null>;
    precipitation_probability?: Array<number | null>;
    cape?: Array<number | null>;
    convective_inhibition?: Array<number | null>;
    thunderstorm_probability?: Array<number | null>;
  };
  error?: boolean;
  reason?: string;
}

function optionalNumber(values: Array<number | null> | undefined, index: number): number | undefined {
  const value = values?.[index];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export async function fetchForecast(latitude: number, longitude: number, signal?: AbortSignal): Promise<Forecast> {
  const url = new URL("https://api.open-meteo.com/v1/forecast");
  url.searchParams.set("latitude", String(latitude));
  url.searchParams.set("longitude", String(longitude));
  url.searchParams.set("hourly", "weather_code,precipitation_probability,cape,convective_inhibition,thunderstorm_probability");
  url.searchParams.set("forecast_hours", "48");
  url.searchParams.set("timezone", "auto");
  url.searchParams.set("timeformat", "unixtime");

  const response = await fetch(url, { signal, cache: "no-store" });
  if (!response.ok) throw new Error("forecast-unavailable");
  const data = await response.json() as OpenMeteoResponse;
  const times = data.hourly?.time;
  if (data.error || !times?.length || !data.timezone) {
    throw new Error(data.reason ?? "forecast-unavailable");
  }

  const hourly = data.hourly!;
  const hours = times.map((time, index) => {
    const inputs: RiskInputs = {
      weatherCode: optionalNumber(hourly.weather_code, index),
      precipitationProbability: optionalNumber(hourly.precipitation_probability, index),
      cape: optionalNumber(hourly.cape, index),
      convectiveInhibition: optionalNumber(hourly.convective_inhibition, index),
      thunderstormProbability: optionalNumber(hourly.thunderstorm_probability, index),
    };
    return {
      time,
      weatherCode: inputs.weatherCode ?? undefined,
      precipitationProbability: inputs.precipitationProbability ?? undefined,
      cape: inputs.cape ?? undefined,
      convectiveInhibition: inputs.convectiveInhibition ?? undefined,
      thunderstormProbability: inputs.thunderstormProbability ?? undefined,
      risk: classifyRisk(inputs),
    } satisfies ForecastHour;
  });

  return {
    timezone: data.timezone,
    latitude: data.latitude ?? latitude,
    longitude: data.longitude ?? longitude,
    hours,
    fetchedAt: Date.now(),
  };
}

export function describeWeatherCode(code?: number): string {
  if (code == null) return "Weather code unavailable";
  if ([95, 96, 99].includes(code)) return "Thunderstorm signal";
  if ([80, 81, 82].includes(code)) return "Rain showers";
  if ([61, 63, 65].includes(code)) return "Rain";
  if ([51, 53, 55, 56, 57].includes(code)) return "Drizzle";
  if ([0, 1, 2, 3].includes(code)) return "No rain indicated";
  return `WMO weather code ${code}`;
}
