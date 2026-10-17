import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import {
  BlitzRecentEventCache,
  MAX_RECENT_RADIUS_KM,
  MAX_RECENT_WINDOW_MINUTES,
  type RecentQuery,
} from "./recent-cache.ts";

export const OBSERVER_API_DEFAULT_PORT = 8080;

function parseQuery(params: URLSearchParams): RecentQuery | null {
  const names = ["lat", "lon", "radiusKm", "windowMinutes"];
  if ([...params.keys()].length !== names.length || [...params.keys()].some(name => !names.includes(name))) return null;
  const numbers = names.map(name => {
    const raw = params.get(name);
    if (raw === null || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(raw)) return NaN;
    return Number(raw);
  });
  const [latitude, longitude, radiusKm, windowMinutes] = numbers;
  if (!numbers.every(Number.isFinite) || latitude < -90 || latitude > 90 ||
      longitude < -180 || longitude > 180 || radiusKm <= 0 || radiusKm > MAX_RECENT_RADIUS_KM ||
      windowMinutes <= 0 || windowMinutes > MAX_RECENT_WINDOW_MINUTES) return null;
  return { latitude, longitude, radiusKm, windowMinutes };
}

function json(response: ServerResponse, status: number, body: object): void {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  response.end(JSON.stringify(body));
}

function authorized(request: IncomingMessage, token: string | undefined): boolean {
  if (!token) return false;
  const supplied = request.headers["x-observer-token"];
  if (typeof supplied !== "string") return false;
  const expectedBytes = Buffer.from(token);
  const suppliedBytes = Buffer.from(supplied);
  return expectedBytes.length === suppliedBytes.length && timingSafeEqual(expectedBytes, suppliedBytes);
}

// Pure request handler: HTTP reads memory only and cannot start a provider connection.
export function createObserverHttpServer(cache: BlitzRecentEventCache, token: string | undefined): Server {
  return createServer((request, response) => {
    try {
      if (request.method !== "GET") {
        response.setHeader("Allow", "GET");
        json(response, 405, { ok: false, error: "method_not_allowed" });
        return;
      }
      const url = new URL(request.url ?? "/", "http://observer.local");
      if (url.pathname === "/health") {
        json(response, 200, { ok: true, observer: "dual_source_shadow" });
        return;
      }
      if (url.pathname !== "/recent") {
        json(response, 404, { ok: false, error: "not_found" });
        return;
      }
      if (!token) {
        json(response, 503, { ok: false, error: "observer_token_not_configured" });
        return;
      }
      if (!authorized(request, token)) {
        json(response, 401, { ok: false, error: "unauthorized" });
        return;
      }
      const query = parseQuery(url.searchParams);
      if (!query) {
        json(response, 400, { ok: false, error: "invalid_query" });
        return;
      }
      const fetchedAt = Date.now();
      json(response, 200, {
        ok: true,
        source: "blitzortung",
        fetchedAt,
        query,
        coverage: cache.coverage(query.windowMinutes, fetchedAt),
        events: cache.query(query, fetchedAt),
      });
    } catch {
      if (!response.headersSent) json(response, 500, { ok: false, error: "request_failed" });
      else response.end();
    }
  });
}
