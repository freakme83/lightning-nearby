import { isThunderstormCode } from "./weather.ts";

export type EnsembleModel = "icon_eu_eps" | "icon_global_eps";

export interface EnsembleSampleDiagnostics {
  requestedLocations: number;
  returnedLocations: number;
  usableLocations: number;
  locationsWithEffectiveCoordinates: number;
  /** Only known when every usable response has valid returned coordinates. */
  uniqueEffectiveLocations?: number;
  effectiveCoordinateStatus: "complete" | "partial" | "unavailable";
  /** Returned coordinate equality is observable; native model cell IDs are not provided. */
  gridCellIdentity: "unconfirmed";
  samples: Array<{ responseIndex: number; effectiveCoordinates?: { latitude: number; longitude: number } }>;
}

export interface LocalEnsembleThunderstormSupport {
  time: number;
  supportingMembers: number;
  availableMembers: number;
  model: string;
  spatialWindowKm: number;
  temporalWindowHours: 1;
  sampledLocations: number;
  sampleDiagnostics?: EnsembleSampleDiagnostics;
}

export interface EnsembleForecast {
  timezone: string;
  hours: LocalEnsembleThunderstormSupport[];
  fetchedAt: number;
}

const MODEL_INFO: Record<EnsembleModel, { label: string; gridKm: number }> = {
  icon_eu_eps: { label: "ICON-EU EPS", gridKm: 13 },
  icon_global_eps: { label: "ICON global EPS", gridKm: 26 },
};
const HOUR = 3_600;
const FORECAST_HOURS = 26; // Current hour plus the next 24, with one hour of timing tolerance.

function usableCode(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 99;
}

/** Center and four cardinal samples, each approximately one model grid spacing away. */
export function localSamplePoints(latitude: number, longitude: number, model: EnsembleModel) {
  const km = MODEL_INFO[model].gridKm;
  const latOffset = km / 111.32;
  const lonOffset = km / (111.32 * Math.max(0.1, Math.cos(latitude * Math.PI / 180)));
  return [
    { latitude, longitude },
    { latitude: Math.min(90, latitude + latOffset), longitude },
    { latitude: Math.max(-90, latitude - latOffset), longitude },
    { latitude, longitude: ((longitude + lonOffset + 540) % 360) - 180 },
    { latitude, longitude: ((longitude - lonOffset + 540) % 360) - 180 },
  ];
}

function readEffectiveCoordinates(data: Record<string, unknown>): { latitude: number; longitude: number } | undefined {
  const { latitude, longitude } = data;
  if (typeof latitude !== "number" || !Number.isFinite(latitude) || latitude < -90 || latitude > 90
    || typeof longitude !== "number" || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) return undefined;
  return { latitude, longitude };
}

function readLocation(payload: unknown, responseIndex: number) {
  if (typeof payload !== "object" || payload === null) return null;
  const data = payload as Record<string, unknown>;
  if (typeof data.timezone !== "string" || !data.timezone || typeof data.hourly !== "object" || data.hourly === null) return null;
  const hourly = data.hourly as Record<string, unknown>;
  if (!Array.isArray(hourly.time)) return null;
  const members = new Map<string, Map<number, number>>();
  for (const [member, series] of Object.entries(hourly)) {
    // The unsuffixed weather_code is the control member, not a mean.
    if (!/^weather_code(?:_member\d+)?$/.test(member) || !Array.isArray(series)) continue;
    const times = new Map<number, number>();
    for (const [index, time] of hourly.time.entries()) {
      if (typeof time === "number" && Number.isInteger(time) && time % HOUR === 0 && usableCode(series[index])) {
        times.set(time, series[index]);
      }
    }
    if (times.size) members.set(member, times);
  }
  return members.size ? { timezone: data.timezone, members, responseIndex, effectiveCoordinates: readEffectiveCoordinates(data) } : null;
}

/** The API returns one object per requested point. Member names identify the same member at every point. */
export function parseEnsembleForecast(
  payload: unknown,
  model: EnsembleModel,
  fetchedAt = Date.now(),
  expectedLocations = 5,
): EnsembleForecast | null {
  const responses = Array.isArray(payload) ? payload : [payload];
  const locations = responses.slice(0, expectedLocations)
    .map(readLocation).filter((location): location is NonNullable<typeof location> => location !== null);
  if (!locations.length) return null;
  const coordinateCount = locations.filter((location) => location.effectiveCoordinates).length;
  const sampleDiagnostics: EnsembleSampleDiagnostics = {
    requestedLocations: expectedLocations,
    returnedLocations: responses.length,
    usableLocations: locations.length,
    locationsWithEffectiveCoordinates: coordinateCount,
    ...(coordinateCount === locations.length ? {
      uniqueEffectiveLocations: new Set(locations.map((location) => {
        const { latitude, longitude } = location.effectiveCoordinates!;
        return `${latitude},${longitude}`;
      })).size,
    } : {}),
    effectiveCoordinateStatus: coordinateCount === locations.length ? "complete" : coordinateCount ? "partial" : "unavailable",
    gridCellIdentity: "unconfirmed",
    samples: locations.map(({ responseIndex, effectiveCoordinates }) => ({
      responseIndex, ...(effectiveCoordinates ? { effectiveCoordinates } : {}),
    })),
  };
  const timezone = locations[0].timezone;
  const memberNames = new Set(locations.flatMap((location) => [...location.members.keys()]));
  const times = new Set(locations.flatMap((location) => [...location.members.values()].flatMap((series) => [...series.keys()])));
  const hours: LocalEnsembleThunderstormSupport[] = [];
  for (const time of [...times].sort((a, b) => a - b)) {
    let availableMembers = 0;
    let supportingMembers = 0;
    for (const name of memberNames) {
      let available = false;
      let supports = false;
      for (const location of locations) {
        const series = location.members.get(name);
        for (const offset of [-HOUR, 0, HOUR]) {
          const code = series?.get(time + offset);
          if (code == null) continue;
          available = true;
          if (isThunderstormCode(code)) supports = true;
        }
      }
      if (available) availableMembers++;
      if (supports) supportingMembers++;
    }
    if (availableMembers) hours.push({
      time, supportingMembers, availableMembers,
      model: MODEL_INFO[model].label,
      spatialWindowKm: locations.length > 1 ? MODEL_INFO[model].gridKm : 0,
      temporalWindowHours: 1,
      sampledLocations: locations.length,
      sampleDiagnostics,
    });
  }
  return hours.length ? { timezone, hours, fetchedAt } : null;
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
    const points = localSamplePoints(latitude, longitude, model);
    // If a border point invalidates the batch, retain the regional center before trying global.
    for (const samples of [points, ...(model === "icon_eu_eps" ? [[points[0]]] : [])]) {
      const url = new URL("https://ensemble-api.open-meteo.com/v1/ensemble");
      url.searchParams.set("latitude", samples.map((point) => point.latitude.toFixed(4)).join(","));
      url.searchParams.set("longitude", samples.map((point) => point.longitude.toFixed(4)).join(","));
      url.searchParams.set("hourly", "weather_code");
      url.searchParams.set("models", model);
      url.searchParams.set("forecast_hours", String(FORECAST_HOURS));
      url.searchParams.set("past_hours", "1");
      url.searchParams.set("timezone", "auto");
      url.searchParams.set("timeformat", "unixtime");
      url.searchParams.set("cell_selection", "nearest");
      try {
        const response = await fetcher(url, { signal, cache: "no-store" });
        if (!response.ok) continue;
        const data: unknown = await response.json();
        if (signal?.aborted) throw signal.reason ?? new DOMException("Forecast cancelled", "AbortError");
        // One-point responses are objects; multi-point responses are arrays. Partial arrays are usable.
        const forecast = parseEnsembleForecast(data, model, Date.now(), samples.length);
        if (forecast) return forecast;
      } catch (error) {
        if (signal?.aborted) throw error;
      }
    }
  }
  throw new Error("ensemble-unavailable");
}
