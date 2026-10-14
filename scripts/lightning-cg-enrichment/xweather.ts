import { matchLightningEvents, resolveThresholds, validateReference } from "./match.ts";
import { matchInitialCgEvents } from "./initial.ts";
import type {
  CostDiagnostics, EnrichmentOptions, EnrichmentReference, EnrichmentResult, MatchThresholds, ParsedXweatherPayload,
  XweatherLightningEvent,
} from "./types.ts";

const API_URL = "https://data.api.xweather.com/lightning/closest";
const XWEATHER_REQUEST_TIMEOUT_MS = 8_000;

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validCoordinates(latitude: unknown, longitude: unknown): boolean {
  return typeof latitude === "number" && Number.isFinite(latitude) && latitude >= -90 && latitude <= 90 &&
    typeof longitude === "number" && Number.isFinite(longitude) && longitude >= -180 && longitude <= 180;
}

export function parseCostDiagnostics(headers: Headers): CostDiagnostics {
  const cost: CostDiagnostics = {};
  const tokens = headers.get("X-Cost-Tokens");
  if (tokens !== null && /^\d+$/.test(tokens)) cost.tokens = Number(tokens);
  const multipliers = headers.get("X-Cost-Multipliers");
  if (multipliers !== null) cost.multipliers = multipliers;
  const endpoint = headers.get("X-Cost-Endpoint");
  if (endpoint !== null) cost.endpoint = endpoint;
  const rateLimit: Record<string, string> = {};
  for (const name of ["X-Ratelimit-Limit", "X-Ratelimit-Remaining", "X-Ratelimit-Reset",
    "X-Ratelimit-Limit-Minute", "X-Ratelimit-Remaining-Minute", "X-Ratelimit-Reset-Minute",
    "X-Ratelimit-Limit-Period", "X-Ratelimit-Remaining-Period", "X-Ratelimit-Reset-Period"]) {
    const value = headers.get(name);
    if (value !== null) rateLimit[name.toLowerCase()] = value;
  }
  if (Object.keys(rateLimit).length) cost.rateLimit = rateLimit;
  return cost;
}

export function parseXweatherPayload(payload: unknown, headers = new Headers()): ParsedXweatherPayload {
  if (!record(payload) || payload.success !== true || !Array.isArray(payload.response)) throw new Error("malformed Xweather response");
  const events: XweatherLightningEvent[] = payload.response.map((item: unknown) => {
    if (!record(item) || typeof item.id !== "string" || !item.id.trim() || !record(item.loc) || !record(item.ob) || !record(item.ob.pulse)) {
      throw new Error("malformed Xweather event");
    }
    const latitude = item.loc.lat;
    const longitude = item.loc.long;
    if (!validCoordinates(latitude, longitude)) throw new Error("malformed Xweather coordinates");
    let eventTimeMs: number;
    if (typeof item.ob.timestampMS === "number" && Number.isSafeInteger(item.ob.timestampMS)) eventTimeMs = item.ob.timestampMS;
    else if (typeof item.ob.timestamp === "number" && Number.isSafeInteger(item.ob.timestamp)) eventTimeMs = item.ob.timestamp * 1000;
    else throw new Error("malformed Xweather timestamp");
    if (!Number.isSafeInteger(eventTimeMs) || eventTimeMs < 0 || eventTimeMs > 8.64e15) throw new Error("malformed Xweather timestamp");
    const type = typeof item.ob.pulse.type === "string" ? item.ob.pulse.type.toLowerCase() : "";
    if (type !== "cg" && type !== "ic") throw new Error("malformed Xweather pulse type");
    const peakAmp = item.ob.pulse.peakamp;
    const numSensors = item.ob.pulse.numSensors;
    return { id: item.id, type, latitude: latitude as number, longitude: longitude as number, eventTimeMs,
      ...(typeof peakAmp === "number" && Number.isFinite(peakAmp) ? { peakAmp } : {}),
      ...(typeof numSensors === "number" && Number.isFinite(numSensors) ? { numSensors } : {}) };
  });
  const cost = parseCostDiagnostics(headers);
  return { events, counts: { returned: events.length, matched: 0, matchedCg: 0, matchedIc: 0 }, cost };
}

export function buildXweatherUrl(reference: EnrichmentReference, radiusKm: number, limit: number,
  credentials: { clientId: string; clientSecret: string }): URL {
  const url = new URL(API_URL);
  url.searchParams.set("p", `${reference.latitude},${reference.longitude}`);
  url.searchParams.set("radius", `${radiusKm}km`);
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("filter", "all");
  url.searchParams.set("client_id", credentials.clientId);
  url.searchParams.set("client_secret", credentials.clientSecret);
  return url;
}

function unavailable(reference: EnrichmentReference, thresholds: ReturnType<typeof resolveThresholds>,
  failure: NonNullable<EnrichmentResult["failure"]>, httpStatus?: number): EnrichmentResult {
  return { status: "provider_unavailable", provider: "xweather", reference, thresholds, failure,
    ...(httpStatus === undefined ? {} : { httpStatus }) };
}

type Dependencies = { fetch?: FetchLike; env?: Record<string, string | undefined> };

async function queryXweather(reference: EnrichmentReference, options: EnrichmentOptions, dependencies: Dependencies,
  classify: (payload: ParsedXweatherPayload, thresholds: MatchThresholds) => EnrichmentResult): Promise<EnrichmentResult> {
  validateReference(reference);
  const thresholds = resolveThresholds(options);
  const env = dependencies.env ?? process.env;
  const clientId = env.XWEATHER_CLIENT_ID;
  const clientSecret = env.XWEATHER_CLIENT_SECRET;
  if (!clientId || !clientSecret) return unavailable(reference, thresholds, "missing_credentials");
  const url = buildXweatherUrl(reference, thresholds.radiusKm, thresholds.limit, { clientId, clientSecret });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), XWEATHER_REQUEST_TIMEOUT_MS);
  try {
    let response: Response;
    try {
      response = await (dependencies.fetch ?? fetch)(url, {
        method: "GET", cache: "no-store", headers: { Accept: "application/json" }, signal: controller.signal,
      });
    } catch {
      return unavailable(reference, thresholds, "network_error");
    }
    if (controller.signal.aborted) return unavailable(reference, thresholds, "network_error");
    const cost = parseCostDiagnostics(response.headers);
    if (!response.ok) return { ...unavailable(reference, thresholds, "http_error", response.status), cost };
    let payload: unknown;
    try { payload = await response.json(); }
    catch (error) {
      const failure = controller.signal.aborted || (error instanceof Error && error.name === "AbortError")
        ? "network_error" : "malformed_response";
      return { ...unavailable(reference, thresholds, failure, response.status), cost };
    }
    if (controller.signal.aborted) return { ...unavailable(reference, thresholds, "network_error", response.status), cost };
    try {
      const parsed = parseXweatherPayload(payload, response.headers);
      return classify(parsed, thresholds);
    } catch {
      return { ...unavailable(reference, thresholds, "malformed_response", response.status), cost };
    }
  } finally {
    clearTimeout(timeout);
  }
}

export function enrichIncidentWithLightningType(reference: EnrichmentReference, options: EnrichmentOptions = {},
  dependencies: Dependencies = {}): Promise<EnrichmentResult> {
  return queryXweather(reference, options, dependencies,
    (parsed, thresholds) => matchLightningEvents(reference, parsed.events, thresholds, parsed.cost));
}

/** One existing-radius provider request; initial CG acceptance is separate from repeat matching. */
export function enrichInitialIncidentWithLightningType(reference: EnrichmentReference,
  dependencies: Dependencies & { now?: () => number } = {}): Promise<EnrichmentResult> {
  return queryXweather(reference, {}, dependencies,
    parsed => matchInitialCgEvents(reference, parsed.events, (dependencies.now ?? Date.now)(), parsed.cost));
}
