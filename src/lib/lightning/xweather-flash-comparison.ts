import { isValidCoordinates } from "../location.ts";
import { compassDirection, initialBearingDegrees, type CompassDirection } from "./bearing.ts";
import { greatCircleDistanceKm } from "./distance.ts";
import {
  EMPTY_PROVIDER_DIAGNOSTICS,
  LIGHTNING_QUERY_LIMIT,
  LIGHTNING_WINDOW_MINUTES,
  type LiveStrike,
  type ProviderDiagnostics,
  type ProviderFailureStatus,
  type ProviderResult,
} from "./types.ts";
import { diagnosticsFromHeaders, parseXweatherLightningPayload } from "./xweather.ts";

const COMPARISON_RADIUS_KM = 40;
const RADIUS_EPSILON_KM = 1e-8;

type FetchLike = (input: URL | RequestInfo, init?: RequestInit) => Promise<Response>;
type Credentials = { clientId?: string; clientSecret?: string };
type ComparisonKind = "raw-pulses" | "consolidated-flashes";
type Endpoint = "/lightning/closest" | "/lightning/flash/closest";

export interface ComparableLightningSuccess {
  ok: true;
  kind: ComparisonKind;
  endpoint: Endpoint;
  radiusKm: 40;
  fetchedAt: number;
  returnedCount: number;
  activityPresent: boolean;
  nearestKm: number | null;
  nearestDirection: CompassDirection | null;
  nearestAgeMinutes: number | null;
  newestAgeMinutes: number | null;
  oldestAgeMinutes: number | null;
  counts: { within5Km: number; within10Km: number; within25Km: number; within40Km: number };
  rejectedEventCount: number;
  mayBeTruncated: boolean;
  diagnostics: ProviderDiagnostics;
}

export interface ComparableLightningFailure {
  ok: false;
  kind: ComparisonKind;
  endpoint: Endpoint;
  status: ProviderFailureStatus;
  message: string;
  diagnostics: ProviderDiagnostics;
}

export type ComparableLightningResult = ComparableLightningSuccess | ComparableLightningFailure;

export interface RawFlashComparison {
  latitude: number;
  longitude: number;
  comparisonRadiusKm: 40;
  observationWindowMinutes: 5;
  comparedAt: number;
  raw: ComparableLightningResult;
  flash: ComparableLightningResult;
  presenceMatch: boolean | null;
  directionMatch: boolean | null;
  nearestDistanceDifferenceKm: number | null;
  nearestAgeDifferenceMinutes: number | null;
  newestAgeDifferenceMinutes: number | null;
  summaryLines: string[];
}

export type RawFlashComparisonApiResult =
  | { ok: true; comparison: RawFlashComparison }
  | { ok: false; status: "invalid-request" | "provider-not-configured" | "provider-unavailable"; message: string };

export interface RawFlashComparisonResponse {
  httpStatus: number;
  body: RawFlashComparisonApiResult;
}

export interface RawFlashComparisonOptions {
  clientId?: string;
  clientSecret?: string;
  fetcher?: FetchLike;
  now?: () => number;
  signal?: AbortSignal;
}

interface ComparisonRequest { latitude: number; longitude: number }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseRawFlashComparisonRequest(body: unknown): ComparisonRequest | null {
  if (!isRecord(body)) return null;
  const { latitude, longitude } = body;
  if (typeof latitude !== "number" || typeof longitude !== "number" || !isValidCoordinates(latitude, longitude)) return null;
  return { latitude, longitude };
}

export function buildRawFlashComparisonUrls(request: ComparisonRequest, credentials: Required<Credentials>) {
  const baseParams = (url: URL) => {
    url.searchParams.set("p", `${request.latitude},${request.longitude}`);
    url.searchParams.set("radius", `${COMPARISON_RADIUS_KM}km`);
    url.searchParams.set("limit", String(LIGHTNING_QUERY_LIMIT));
    url.searchParams.set("client_id", credentials.clientId);
    url.searchParams.set("client_secret", credentials.clientSecret);
    return url;
  };
  const raw = baseParams(new URL("https://data.api.xweather.com/lightning/closest"));
  raw.searchParams.set("filter", "all");
  const flash = baseParams(new URL("https://data.api.xweather.com/lightning/flash/closest"));
  return { raw, flash };
}

function failureForHttpStatus(status: number, diagnostics: ProviderDiagnostics): ProviderResult {
  if (status === 401 || status === 403) return { ok: false, status: "provider-auth-error", message: "Xweather rejected the credentials or application namespace.", diagnostics };
  if (status === 429) return { ok: false, status: "provider-quota-exceeded", message: "Xweather rate or access quota was reached.", diagnostics };
  if (status >= 500) return { ok: false, status: "provider-unavailable", message: "Xweather is temporarily unavailable.", diagnostics };
  return { ok: false, status: "provider-rejected-request", message: "Xweather rejected the comparison request.", diagnostics };
}

async function fetchComparablePayload(url: URL, fetcher: FetchLike, signal: AbortSignal): Promise<ProviderResult> {
  let response: Response;
  try { response = await fetcher(url, { method: "GET", cache: "no-store", signal }); }
  catch { return { ok: false, status: "provider-unavailable", message: "The Xweather comparison request could not be completed.", diagnostics: EMPTY_PROVIDER_DIAGNOSTICS }; }
  const diagnostics = diagnosticsFromHeaders(response.headers, response.status);
  if (!response.ok) return failureForHttpStatus(response.status, diagnostics);
  let payload: unknown;
  try { payload = await response.json(); }
  catch { return { ok: false, status: "malformed-response", message: "Xweather returned invalid JSON.", diagnostics }; }
  return parseXweatherLightningPayload(payload, diagnostics, LIGHTNING_QUERY_LIMIT);
}

function endpointFor(kind: ComparisonKind): Endpoint {
  return kind === "raw-pulses" ? "/lightning/closest" : "/lightning/flash/closest";
}

export function normalizeComparableLightning(
  kind: ComparisonKind,
  result: ProviderResult,
  latitude: number,
  longitude: number,
  fetchedAt: number,
): ComparableLightningResult {
  const endpoint = endpointFor(kind);
  if (!result.ok) return { ok: false, kind, endpoint, status: result.status, message: result.message, diagnostics: result.diagnostics };
  const windowStart = fetchedAt - LIGHTNING_WINDOW_MINUTES * 60_000;
  const recent = result.events.flatMap((event) => {
    if (!Number.isFinite(event.observedAtMs) || event.observedAtMs < windowStart || event.observedAtMs > fetchedAt + 60_000) return [];
    const distanceKm = greatCircleDistanceKm(latitude, longitude, event.latitude, event.longitude);
    if (distanceKm > COMPARISON_RADIUS_KM + RADIUS_EPSILON_KM) return [];
    return [{ event, distanceKm }];
  });
  const nearest = recent.reduce<(typeof recent)[number] | null>((best, item) => !best || item.distanceKm < best.distanceKm ? item : best, null);
  const newest = recent.reduce<LiveStrike | null>((best, item) => !best || item.event.observedAtMs > best.observedAtMs ? item.event : best, null);
  const oldest = recent.reduce<LiveStrike | null>((best, item) => !best || item.event.observedAtMs < best.observedAtMs ? item.event : best, null);
  const within = (radiusKm: number) => recent.filter((item) => item.distanceKm <= radiusKm + RADIUS_EPSILON_KM).length;
  const ageMinutes = (event: LiveStrike | null) => event ? Math.max(0, (fetchedAt - event.observedAtMs) / 60_000) : null;
  return {
    ok: true,
    kind,
    endpoint,
    radiusKm: COMPARISON_RADIUS_KM,
    fetchedAt,
    returnedCount: recent.length,
    activityPresent: recent.length > 0,
    nearestKm: nearest?.distanceKm ?? null,
    nearestDirection: nearest ? compassDirection(initialBearingDegrees(latitude, longitude, nearest.event.latitude, nearest.event.longitude)) : null,
    nearestAgeMinutes: ageMinutes(nearest?.event ?? null),
    newestAgeMinutes: ageMinutes(newest),
    oldestAgeMinutes: ageMinutes(oldest),
    counts: { within5Km: within(5), within10Km: within(10), within25Km: within(25), within40Km: within(40) },
    rejectedEventCount: result.rejectedEventCount,
    mayBeTruncated: result.mayBeTruncated,
    diagnostics: result.diagnostics,
  };
}

function absoluteDifference(left: number | null, right: number | null): number | null {
  return left === null || right === null ? null : Math.abs(left - right);
}

function presentLabel(result: ComparableLightningResult): string {
  return result.ok ? (result.activityPresent ? "yes" : "no") : "unavailable";
}

function nearestLabel(result: ComparableLightningResult): string {
  if (!result.ok || result.nearestKm === null) return result.ok ? "none" : "unavailable";
  const direction = result.nearestDirection ? ` ${result.nearestDirection}` : "";
  const age = result.nearestAgeMinutes === null ? "" : ` · ${result.nearestAgeMinutes.toFixed(2)} min`;
  return `${result.nearestKm.toFixed(1)} km${direction}${age}`;
}

export function compareRawAndFlash(
  request: ComparisonRequest,
  raw: ComparableLightningResult,
  flash: ComparableLightningResult,
  comparedAt: number,
): RawFlashComparison {
  const bothUsable = raw.ok && flash.ok;
  const presenceMatch = bothUsable ? raw.activityPresent === flash.activityPresent : null;
  const bothActive = bothUsable && raw.activityPresent && flash.activityPresent;
  const directionMatch = bothActive && raw.nearestDirection !== null && flash.nearestDirection !== null
    ? raw.nearestDirection === flash.nearestDirection
    : null;
  const nearestDistanceDifferenceKm = bothActive ? absoluteDifference(raw.nearestKm, flash.nearestKm) : null;
  const nearestAgeDifferenceMinutes = bothActive ? absoluteDifference(raw.nearestAgeMinutes, flash.nearestAgeMinutes) : null;
  const newestAgeDifferenceMinutes = bothActive ? absoluteDifference(raw.newestAgeMinutes, flash.newestAgeMinutes) : null;
  const summaryLines = [
    `Raw activity: ${presentLabel(raw)}`,
    `Flash activity: ${presentLabel(flash)}`,
    `Raw nearest: ${nearestLabel(raw)}`,
    `Flash nearest: ${nearestLabel(flash)}`,
    `Presence match: ${presenceMatch === null ? "unavailable" : presenceMatch ? "yes" : "no"}`,
    `Direction match: ${directionMatch === null ? "unavailable" : directionMatch ? "yes" : "no"}`,
    `Nearest distance difference: ${nearestDistanceDifferenceKm === null ? "unavailable" : `${nearestDistanceDifferenceKm.toFixed(2)} km`}`,
  ];
  return {
    ...request,
    comparisonRadiusKm: COMPARISON_RADIUS_KM,
    observationWindowMinutes: LIGHTNING_WINDOW_MINUTES,
    comparedAt,
    raw,
    flash,
    presenceMatch,
    directionMatch,
    nearestDistanceDifferenceKm,
    nearestAgeDifferenceMinutes,
    newestAgeDifferenceMinutes,
    summaryLines,
  };
}

export async function handleRawFlashComparisonRequest(body: unknown, options: RawFlashComparisonOptions = {}): Promise<RawFlashComparisonResponse> {
  const request = parseRawFlashComparisonRequest(body);
  if (!request) return { httpStatus: 400, body: { ok: false, status: "invalid-request", message: "Send valid latitude and longitude values." } };
  const clientId = options.clientId?.trim();
  const clientSecret = options.clientSecret?.trim();
  if (!clientId || !clientSecret) return { httpStatus: 503, body: { ok: false, status: "provider-not-configured", message: "Server-side Xweather credentials are not configured." } };
  const urls = buildRawFlashComparisonUrls(request, { clientId, clientSecret });
  const timeoutSignal = AbortSignal.timeout(10_000);
  const signal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;
  const fetcher = options.fetcher ?? fetch;
  const [rawResult, flashResult] = await Promise.all([
    fetchComparablePayload(urls.raw, fetcher, signal),
    fetchComparablePayload(urls.flash, fetcher, signal),
  ]);
  const comparedAt = (options.now ?? Date.now)();
  const raw = normalizeComparableLightning("raw-pulses", rawResult, request.latitude, request.longitude, comparedAt);
  const flash = normalizeComparableLightning("consolidated-flashes", flashResult, request.latitude, request.longitude, comparedAt);
  return { httpStatus: 200, body: { ok: true, comparison: compareRawAndFlash(request, raw, flash, comparedAt) } };
}
