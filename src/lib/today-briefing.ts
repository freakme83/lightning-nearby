/** Optional ordinary-weather aggregates for a provider-local calendar date. */
export interface DailyWeather {
  date: string;
  weatherCode?: number;
  highC?: number;
  lowC?: number;
  precipitationProbability?: number;
  precipitationMm?: number;
}

export function localCalendarDate(nowMs: number, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(nowMs);
  return ["year", "month", "day"].map((type) => parts.find((part) => part.type === type)!.value).join("-");
}

/** A one-shot date-boundary timer, including DST days. Never fetches data. */
export function nextLocalMidnight(nowMs: number, timezone: string): number {
  const date = localCalendarDate(nowMs, timezone);
  let low = nowMs, high = nowMs + 27 * 3_600_000;
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2);
    if (localCalendarDate(middle, timezone) === date) low = middle;
    else high = middle;
  }
  return high;
}

export function parseDailyWeather(raw: unknown, utcOffsetSeconds: unknown): DailyWeather[] {
  if (!raw || typeof raw !== "object" || typeof utcOffsetSeconds !== "number" || !Number.isFinite(utcOffsetSeconds)) return [];
  const daily = raw as Record<string, unknown>;
  if (!Array.isArray(daily.time)) return [];
  const number = (key: string, index: number) => {
    const values = daily[key];
    const value = Array.isArray(values) ? values[index] : undefined;
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
  };
  return daily.time.flatMap((time, index) => {
    if (typeof time !== "number" || !Number.isFinite(time)) return [];
    const timestamp = new Date((time + utcOffsetSeconds) * 1000);
    if (!Number.isFinite(timestamp.getTime())) return [];
    const code = number("weather_code", index);
    const probability = number("precipitation_probability_max", index);
    const sum = number("precipitation_sum", index);
    return [{ date: timestamp.toISOString().slice(0, 10),
      weatherCode: code != null && Number.isInteger(code) && code >= 0 && code <= 99 ? code : undefined,
      highC: number("temperature_2m_max", index), lowC: number("temperature_2m_min", index),
      precipitationProbability: probability != null && probability >= 0 && probability <= 100 ? probability : undefined,
      precipitationMm: sum != null && sum >= 0 ? sum : undefined }];
  });
}

const WET_CODES = new Set([51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 71, 73, 75, 77, 80, 81, 82, 85, 86, 95, 96, 97, 99]);
export const BRIEFING_PRECIPITATION = { possiblePercent: 20, likelyPercent: 60, measurableMm: 0.1 } as const;
function condition(code?: number): string | undefined {
  if (code === 0) return "Clear skies";
  if (code === 1) return "Mostly clear skies";
  if (code === 2) return "Partly cloudy skies";
  if (code === 3) return "Overcast skies";
  if (code === 45 || code === 48) return "Fog";
  if ([51, 53, 55, 56, 57].includes(code ?? -1)) return "Drizzle";
  if ([61, 63, 65, 66, 67].includes(code ?? -1)) return "Rain";
  if ([80, 81, 82].includes(code ?? -1)) return "Rain showers";
  if ([71, 73, 75, 77, 85, 86].includes(code ?? -1)) return "Snow";
  if ([95, 96, 97, 99].includes(code ?? -1)) return "Thunderstorms";
}

/** Whole local day, never the rolling hourly window; no lightning-risk inputs. */
export function buildTodayBriefing(days: DailyWeather[] | undefined, timezone: string, nowMs = Date.now(), currentTemperatureC?: number): string | null {
  const day = days?.find((entry) => entry.date === localCalendarDate(nowMs, timezone));
  if (!day) return null;
  const conditions = condition(day.weatherCode);
  const temperatures = [day.highC != null && Number.isFinite(day.highC) ? `high ${Math.round(day.highC)}°C` : "", day.lowC != null && Number.isFinite(day.lowC) ? `low ${Math.round(day.lowC)}°C` : ""].filter(Boolean).join(", ");
  const current = currentTemperatureC != null && Number.isFinite(currentTemperatureC)
    ? `Now ${Math.round(currentTemperatureC)}°C` : "";
  const first = [conditions, temperatures].filter(Boolean).join(" · ");
  const probability = day.precipitationProbability;
  const sum = day.precipitationMm;
  let precipitation = "";
  if (probability != null && probability >= BRIEFING_PRECIPITATION.likelyPercent) precipitation = "Precipitation is likely today.";
  else if ((probability != null && probability >= BRIEFING_PRECIPITATION.possiblePercent) || (sum != null && sum >= BRIEFING_PRECIPITATION.measurableMm)) precipitation = "Precipitation is possible today.";
  else if (!WET_CODES.has(day.weatherCode ?? -1) && probability != null && sum != null) precipitation = "Little or no precipitation is expected today.";
  const temperatureLine = current
    ? [current, temperatures].filter(Boolean).join(" · ")
    : first;
  const conditionsLine = current && conditions ? `${conditions}.` : "";
  const text = [temperatureLine ? `${temperatureLine}.` : "", conditionsLine, precipitation].filter(Boolean).join(" ");
  return text || null;
}
