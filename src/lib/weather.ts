export type RiskLevel = "low" | "elevated" | "high";

export interface ForecastHour {
  /** Unix seconds at the forecast provider's hourly timestamp. */
  time: number;
  weatherCode?: number;
  precipitationProbability?: number;
  cape?: number;
  convectiveInhibition?: number;
  thunderstormProbability?: number;
  /** Absent when the deterministic fields cannot support a qualitative level. */
  risk?: RiskLevel;
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

const THUNDERSTORM_CODES = new Set([95, 96, 97, 99]);

export function isThunderstormCode(code: unknown): boolean {
  return typeof code === "number" && THUNDERSTORM_CODES.has(code);
}

export function hasRiskEvidence(input: RiskInputs): boolean {
  return (input.weatherCode != null && Number.isInteger(input.weatherCode) && input.weatherCode >= 0 && input.weatherCode <= 99)
    || (input.thunderstormProbability != null && Number.isFinite(input.thunderstormProbability) && input.thunderstormProbability >= 0 && input.thunderstormProbability <= 100)
    || (input.cape != null && Number.isFinite(input.cape) && input.cape >= 0
      && input.precipitationProbability != null && Number.isFinite(input.precipitationProbability)
      && input.precipitationProbability >= 0 && input.precipitationProbability <= 100);
}

export interface RiskDecision {
  risk: RiskLevel;
  explanation: string;
}

/** Classification and its explanation share this single threshold decision path. */
export function explainRiskDecision(input: RiskInputs): RiskDecision {
  // An upstream thunderstorm code is the clearest available signal in this
  // globally usable forecast. Hail codes are included in the same top class.
  if (isThunderstormCode(input.weatherCode)) {
    return {
      risk: "high",
      explanation: `High because deterministic WMO thunderstorm code ${input.weatherCode} is present.`,
    };
  }

  // When supplied, the upstream thunderstorm probability is authoritative
  // over the weaker CAPE + precipitation fallback, including values below
  // our Elevated cutoff. Open-Meteo's coverage for this field is model-limited.
  const probability = input.thunderstormProbability;
  if (probability != null && Number.isFinite(probability) && probability >= 0 && probability <= 100) {
    if (probability >= RISK_THRESHOLDS.directThunderstormProbabilityHigh) {
      return {
        risk: "high",
        explanation: `High because provider thunderstorm probability is ${probability}%, at or above the ${RISK_THRESHOLDS.directThunderstormProbabilityHigh}% High threshold.`,
      };
    }
    if (probability >= RISK_THRESHOLDS.directThunderstormProbabilityElevated) {
      return {
        risk: "elevated",
        explanation: `Elevated because provider thunderstorm probability is ${probability}%, within the ${RISK_THRESHOLDS.directThunderstormProbabilityElevated}–${RISK_THRESHOLDS.directThunderstormProbabilityHigh - 1}% Elevated range.`,
      };
    }
    return {
      risk: "low",
      explanation: `Low because provider thunderstorm probability is ${probability}%, below the ${RISK_THRESHOLDS.directThunderstormProbabilityElevated}% Elevated threshold. Provider probability takes precedence over the CAPE + precipitation fallback.`,
    };
  }

  // Rain by itself and instability by itself are not thunderstorm evidence.
  // Elevated requires both meaningful CAPE and a precipitation signal. CIN
  // remains informational: model availability varies and we do not apply an
  // unvalidated CIN threshold to this deliberately small qualitative rule.
  const fallbackMet =
    input.cape != null && input.cape >= RISK_THRESHOLDS.elevatedCapeJPerKg &&
    input.precipitationProbability != null &&
    input.precipitationProbability >= RISK_THRESHOLDS.elevatedPrecipitationProbabilityPercent;
  if (fallbackMet) {
    return {
      risk: "elevated",
      explanation: `Elevated because direct thunderstorm probability is unavailable, CAPE is ${input.cape} J/kg (threshold ${RISK_THRESHOLDS.elevatedCapeJPerKg} J/kg), and precipitation probability is ${input.precipitationProbability}% (threshold ${RISK_THRESHOLDS.elevatedPrecipitationProbabilityPercent}%), meeting the deterministic qualitative fallback.`,
    };
  }

  if (input.cape != null || input.precipitationProbability != null) {
    return {
      risk: "low",
      explanation: `Low because no direct thunderstorm code/probability triggered a higher level and the CAPE + precipitation fallback thresholds (${RISK_THRESHOLDS.elevatedCapeJPerKg} J/kg and ${RISK_THRESHOLDS.elevatedPrecipitationProbabilityPercent}%) were not both met.`,
    };
  }

  return {
    risk: "low",
    explanation: "Low because the available deterministic weather code does not indicate a thunderstorm and no higher direct signal is present.",
  };
}

export function classifyRisk(input: RiskInputs): RiskLevel {
  return explainRiskDecision(input).risk;
}

export function selectNext24Hours<T extends ForecastHour>(hours: T[], nowMs = Date.now()): T[] {
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
  const peak = Math.max(0, ...hours.map((hour) => SEVERITY[hour.risk ?? "low"]));
  if (peak === 0) return null;

  const candidates: RiskWindow[] = [];
  let run: ForecastHour[] = [];
  const saveRun = () => {
    if (!run.length) return;
    candidates.push({ start: run[0].time, end: run[run.length - 1].time + 3_600, level: run[0].risk as Exclude<RiskLevel, "low"> });
    run = [];
  };

  for (const hour of hours) {
    const isPeak = SEVERITY[hour.risk ?? "low"] === peak;
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
    if (inputs.thunderstormProbability != null && (inputs.thunderstormProbability < 0 || inputs.thunderstormProbability > 100)) inputs.thunderstormProbability = undefined;
    return {
      time,
      weatherCode: inputs.weatherCode ?? undefined,
      precipitationProbability: inputs.precipitationProbability ?? undefined,
      cape: inputs.cape ?? undefined,
      convectiveInhibition: inputs.convectiveInhibition ?? undefined,
      thunderstormProbability: inputs.thunderstormProbability ?? undefined,
      ...(hasRiskEvidence(inputs) ? { risk: classifyRisk(inputs) } : {}),
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
  if (isThunderstormCode(code)) return "Thunderstorm signal";
  if ([80, 81, 82].includes(code)) return "Rain showers";
  if ([61, 63, 65].includes(code)) return "Rain";
  if ([51, 53, 55, 56, 57].includes(code)) return "Drizzle";
  if ([0, 1, 2, 3].includes(code)) return "No rain indicated";
  return `WMO weather code ${code}`;
}
