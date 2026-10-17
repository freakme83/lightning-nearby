import { isValidCoordinates } from "../location.ts";
import { compassDirection, initialBearingDegrees, type CompassDirection } from "./bearing.ts";
import { greatCircleDistanceKm } from "./distance.ts";
import { LIVE_CURRENT_EVENT_LIMIT } from "./types.ts";

export const BLITZ_OBSERVER_REQUEST_TIMEOUT_MS = 5_000;
const RECENT = { radiusKm: 50, windowMinutes: 15 } as const;
const CURRENT = { radiusKm: 40, windowMinutes: 5 } as const;
const RADIUS_EPSILON_KM = 1e-8;

type Coverage = { complete: boolean; usable: boolean; requestedWindowMinutes: number; coverageStartMs: number; toleratedGapMs: number };
type ActivityStatus = "active" | "clear" | "unknown";
type MapEvent = { observedAtMs: number; latitude: number; longitude: number; type: "unknown" };
export type BlitzExperimentalResult =
  | { ok: false; status: "invalid-coordinates" | "provider-not-configured" | "provider-auth-error" | "provider-unavailable" | "malformed-response"; message: string }
  | { ok: true; summary: {
      status: "live"; provider: "blitzortung-experimental"; fetchedAt: number;
      recent: { status: ActivityStatus; windowMinutes: 15; radiusKm: 50; totalDetections: number; oldestEventAt: number | null; newestEventAt: number | null; coverage: Coverage };
      current: { status: ActivityStatus; windowMinutes: 5; radiusKm: 40; events: MapEvent[]; latestEventAt: number | null;
        nearestKm: number | null; nearestDirection: CompassDirection | null; nearestAgeMinutes: number | null;
        counts: { within5Km: number; within10Km: number; within25Km: number; within40Km: number }; totalDetections: number; coverage: Coverage };
    } };

export type BlitzExperimentalResponse = { httpStatus: number; body: BlitzExperimentalResult };
type Failure = Extract<BlitzExperimentalResult, { ok: false }>;
type ObserverEvent = { eventTimeMs: number; receivedAtMs: number; latitude: number; longitude: number; distanceKm: number; latencyMs: number; transportComparisonEligible: boolean };
type ObserverReply = { fetchedAt: number; coverage: Coverage; events: ObserverEvent[] };
type ObserverQuery = { latitude: number; longitude: number; radiusKm: number; windowMinutes: number };

export interface BlitzExperimentalOptions {
  baseUrl?: string;
  token?: string;
  fetcher?: typeof fetch;
}

function failure(status: Failure["status"]): BlitzExperimentalResponse {
  const messages: Record<Failure["status"], string> = {
    "invalid-coordinates": "Send valid latitude and longitude as JSON numbers.",
    "provider-not-configured": "Experimental lightning provider is not configured.",
    "provider-auth-error": "Experimental lightning provider authentication failed.",
    "provider-unavailable": "Experimental lightning provider is unavailable.",
    "malformed-response": "Experimental lightning provider returned an invalid response.",
  };
  return { httpStatus: status === "invalid-coordinates" ? 400 : status === "malformed-response" ? 502 : 503,
    body: { ok: false, status, message: messages[status] } };
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function parseReply(value: unknown, expected: ObserverQuery): ObserverReply | null {
  if (!record(value) || value.ok !== true || value.source !== "blitzortung" || !finite(value.fetchedAt) ||
      !record(value.query) || value.query.latitude !== expected.latitude || value.query.longitude !== expected.longitude ||
      value.query.radiusKm !== expected.radiusKm || value.query.windowMinutes !== expected.windowMinutes ||
      !record(value.coverage) || !Array.isArray(value.events)) return null;
  const coverage = value.coverage;
  if (typeof coverage.complete !== "boolean" || typeof coverage.usable !== "boolean" ||
      !finite(coverage.requestedWindowMinutes) || coverage.requestedWindowMinutes !== expected.windowMinutes ||
      !finite(coverage.coverageStartMs) || !finite(coverage.toleratedGapMs) || coverage.toleratedGapMs < 0 ||
      (coverage.complete && !coverage.usable)) return null;
  const events: ObserverEvent[] = [];
  const earliestEventTimeMs = value.fetchedAt - expected.windowMinutes * 60_000;
  for (const item of value.events) {
    if (!record(item) || !finite(item.eventTimeMs) || !finite(item.receivedAtMs) ||
        !isValidCoordinates(item.latitude, item.longitude) || !finite(item.distanceKm) || item.distanceKm < 0 ||
        !finite(item.latencyMs) || typeof item.transportComparisonEligible !== "boolean") return null;
    if (item.eventTimeMs < earliestEventTimeMs || item.eventTimeMs > value.fetchedAt) return null;
    const computedDistanceKm = greatCircleDistanceKm(expected.latitude, expected.longitude,
      item.latitude as number, item.longitude as number);
    if (computedDistanceKm > expected.radiusKm + RADIUS_EPSILON_KM) return null;
    events.push({ eventTimeMs: item.eventTimeMs, receivedAtMs: item.receivedAtMs,
      latitude: item.latitude as number, longitude: item.longitude as number,
      // Validate the observer field above, but retain only our locally derived distance internally.
      distanceKm: computedDistanceKm, latencyMs: item.latencyMs,
      transportComparisonEligible: item.transportComparisonEligible });
  }
  return { fetchedAt: value.fetchedAt, coverage: {
    complete: coverage.complete, usable: coverage.usable, requestedWindowMinutes: coverage.requestedWindowMinutes,
    coverageStartMs: coverage.coverageStartMs, toleratedGapMs: coverage.toleratedGapMs,
  }, events };
}

function activity(events: ObserverEvent[], coverage: Coverage): ActivityStatus {
  return events.length ? "active" : coverage.complete ? "clear" : "unknown";
}

async function readObserver(url: URL, token: string, query: ObserverQuery, fetcher: typeof fetch): Promise<ObserverReply | Failure["status"]> {
  const requestUrl = new URL("/recent", url);
  requestUrl.search = new URLSearchParams({ lat: String(query.latitude), lon: String(query.longitude),
    radiusKm: String(query.radiusKm), windowMinutes: String(query.windowMinutes) }).toString();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), BLITZ_OBSERVER_REQUEST_TIMEOUT_MS);
  try {
    const response = await fetcher(requestUrl, { method: "GET", headers: { "X-Observer-Token": token },
      cache: "no-store", signal: controller.signal });
    if (response.status === 401) return "provider-auth-error";
    if (!response.ok) return "provider-unavailable";
    let payload: unknown;
    try { payload = await response.json(); } catch { return "malformed-response"; }
    return parseReply(payload, query) ?? "malformed-response";
  } catch {
    return "provider-unavailable";
  } finally {
    clearTimeout(timer);
  }
}

export async function handleBlitzExperimentalRequest(body: unknown, options: BlitzExperimentalOptions = {}): Promise<BlitzExperimentalResponse> {
  if (!record(body) || !isValidCoordinates(body.latitude, body.longitude)) return failure("invalid-coordinates");
  if (!options.baseUrl || !options.token) return failure("provider-not-configured");
  let baseUrl: URL;
  try {
    baseUrl = new URL(options.baseUrl);
    if (!["https:", "http:"].includes(baseUrl.protocol) || baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash) return failure("provider-not-configured");
  } catch { return failure("provider-not-configured"); }
  const latitude = body.latitude as number;
  const longitude = body.longitude as number;
  const fetcher = options.fetcher ?? fetch;
  const recent = await readObserver(baseUrl, options.token, { latitude, longitude, ...RECENT }, fetcher);
  if (typeof recent === "string") return failure(recent);
  const current = await readObserver(baseUrl, options.token, { latitude, longitude, ...CURRENT }, fetcher);
  if (typeof current === "string") return failure(current);

  const nearest = current.events.reduce<{ event: ObserverEvent; distanceKm: number } | null>((best, event) => {
    const distanceKm = greatCircleDistanceKm(latitude, longitude, event.latitude, event.longitude);
    return !best || distanceKm < best.distanceKm ? { event, distanceKm } : best;
  }, null);
  const within = (radiusKm: number) => current.events.filter(event =>
    greatCircleDistanceKm(latitude, longitude, event.latitude, event.longitude) <= radiusKm + 1e-8).length;
  const sorted = [...current.events].sort((a, b) =>
    greatCircleDistanceKm(latitude, longitude, a.latitude, a.longitude) -
    greatCircleDistanceKm(latitude, longitude, b.latitude, b.longitude) ||
    b.eventTimeMs - a.eventTimeMs || a.latitude - b.latitude || a.longitude - b.longitude);
  const recentTimes = recent.events.map(event => event.eventTimeMs);
  const currentTimes = current.events.map(event => event.eventTimeMs);
  return { httpStatus: 200, body: { ok: true, summary: {
    status: "live", provider: "blitzortung-experimental", fetchedAt: Math.max(recent.fetchedAt, current.fetchedAt),
    recent: { status: activity(recent.events, recent.coverage), ...RECENT, totalDetections: recent.events.length,
      oldestEventAt: recentTimes.length ? Math.min(...recentTimes) : null,
      newestEventAt: recentTimes.length ? Math.max(...recentTimes) : null, coverage: recent.coverage },
    current: { status: activity(current.events, current.coverage), ...CURRENT,
      events: sorted.slice(0, LIVE_CURRENT_EVENT_LIMIT).map(event => ({ observedAtMs: event.eventTimeMs,
        latitude: event.latitude, longitude: event.longitude, type: "unknown" as const })),
      latestEventAt: currentTimes.length ? Math.max(...currentTimes) : null,
      nearestKm: nearest?.distanceKm ?? null,
      nearestDirection: nearest ? compassDirection(initialBearingDegrees(latitude, longitude, nearest.event.latitude, nearest.event.longitude)) : null,
      nearestAgeMinutes: nearest ? Math.max(0, (current.fetchedAt - nearest.event.eventTimeMs) / 60_000) : null,
      counts: { within5Km: within(5), within10Km: within(10), within25Km: within(25), within40Km: within(40) },
      totalDetections: current.events.length, coverage: current.coverage },
  } } };
}
