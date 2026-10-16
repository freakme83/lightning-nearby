import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type Server, type ServerResponse } from "node:http";
import { DatadogClientError, MAX_LOG_RESULTS, searchDatadogLogs, type DatadogLog } from "./client.ts";

const DEFAULT_HOURS = 12;
const MAX_HOURS = 48;
const DEFAULT_PORT = 3030;
const DEFAULT_HOST = "127.0.0.1";

type SearchLogs = (input: { from: string; to: string; resultCap: number }) => Promise<{ logs: DatadogLog[]; truncated: boolean }>;

export type LogReaderConfig = { apiKey: string; appKey: string; token: string; host: string; port: number };
export type LogReaderEnvironment = {
  [key: string]: string | undefined;
  DATADOG_API_KEY?: string;
  DATADOG_APP_KEY?: string;
  LOG_READER_TOKEN?: string;
  HOST?: string;
  PORT?: string;
};

export class LogReaderConfigError extends Error {
  constructor(message = "DATADOG_API_KEY, DATADOG_APP_KEY, and LOG_READER_TOKEN are required") { super(message); }
}

export function readLogReaderConfig(env: LogReaderEnvironment): LogReaderConfig {
  const apiKey = env.DATADOG_API_KEY?.trim();
  const appKey = env.DATADOG_APP_KEY?.trim();
  const token = env.LOG_READER_TOKEN?.trim();
  if (!apiKey || !appKey || !token) throw new LogReaderConfigError();
  const host = env.HOST === undefined ? DEFAULT_HOST : env.HOST;
  if (host !== "127.0.0.1" && host !== "0.0.0.0") {
    throw new LogReaderConfigError("HOST must be 127.0.0.1 or 0.0.0.0");
  }
  const rawPort = env.PORT ?? String(DEFAULT_PORT);
  if (!/^[0-9]+$/.test(rawPort)) throw new Error("PORT must be an integer from 1 to 65535");
  const port = Number(rawPort);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new Error("PORT must be an integer from 1 to 65535");
  return { apiKey, appKey, token, host, port };
}

function isAuthorized(headerValues: string[] | undefined, expectedToken: string | undefined): boolean {
  if (!expectedToken || !headerValues || headerValues.length !== 1) return false;
  const match = /^Bearer ([^\s,]+)$/i.exec(headerValues[0]);
  if (!match) return false;
  const suppliedDigest = createHash("sha256").update(match[1], "utf8").digest();
  const expectedDigest = createHash("sha256").update(expectedToken, "utf8").digest();
  return timingSafeEqual(suppliedDigest, expectedDigest);
}

function rawAuthorizationValues(rawHeaders: string[]): string[] {
  const values: string[] = [];
  for (let index = 0; index < rawHeaders.length; index += 2) {
    if (rawHeaders[index].toLowerCase() === "authorization") values.push(rawHeaders[index + 1]);
  }
  return values;
}

function send(response: ServerResponse, status: number, body: Record<string, unknown>): void {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store, max-age=0",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(JSON.stringify(body));
}

function hoursFromUrl(url: URL): number | null {
  const keys = [...url.searchParams.keys()];
  if (keys.some(key => key !== "hours") || url.searchParams.getAll("hours").length > 1) return null;
  const values = url.searchParams.getAll("hours");
  if (values.length === 0) return DEFAULT_HOURS;
  if (!/^[0-9]+$/.test(values[0])) return null;
  const hours = Number(values[0]);
  return Number.isSafeInteger(hours) && hours >= 1 && hours <= MAX_HOURS ? hours : null;
}

function createSearch(config: LogReaderConfig): SearchLogs {
  return ({ from, to, resultCap }) => searchDatadogLogs({
    apiKey: config.apiKey,
    appKey: config.appKey,
    from,
    to,
    resultCap,
  });
}

export function createLogReaderServer(options: {
  searchLogs?: SearchLogs;
  now?: () => number;
  config?: LogReaderConfig;
} = {}): Server {
  const searchLogs = options.searchLogs ?? (options.config ? createSearch(options.config) : undefined);
  const now = options.now ?? Date.now;
  return createServer((request, response) => {
    void handleLogReaderRequest(request.method ?? "", request.url ?? "/", {
      searchLogs,
      now,
      logReaderToken: options.config?.token,
      authorizationHeaderValues: rawAuthorizationValues(request.rawHeaders),
    }).then(result => {
      send(response, result.status, result.body);
    });
  });
}

export async function handleLogReaderRequest(method: string, requestUrl: string, options: {
  searchLogs?: SearchLogs;
  now?: () => number;
  logReaderToken?: string;
  authorizationHeaderValues?: string[];
} = {}): Promise<{ status: number; body: Record<string, unknown> }> {
  if (method !== "GET") return { status: 405, body: { error: "method_not_allowed" } };
  const url = new URL(requestUrl, "http://127.0.0.1");
  if (url.pathname === "/health") return { status: 200, body: { status: "healthy" } };
  if (url.pathname !== "/logs") return { status: 404, body: { error: "not_found" } };
  if (!isAuthorized(options.authorizationHeaderValues, options.logReaderToken)) {
    return { status: 401, body: { error: "unauthorized" } };
  }
  if (!options.searchLogs) return { status: 500, body: { error: "service_not_configured" } };
  const hours = hoursFromUrl(url);
  if (hours === null) return { status: 400, body: { error: "hours_must_be_an_integer_between_1_and_48" } };

  const toMs = (options.now ?? Date.now)();
  const to = new Date(toMs).toISOString();
  const from = new Date(toMs - hours * 60 * 60 * 1_000).toISOString();
  try {
    const result = await options.searchLogs({ from, to, resultCap: MAX_LOG_RESULTS });
    return { status: 200, body: {
      requestedHours: hours,
      returnedCount: result.logs.length,
      truncated: result.truncated,
      logs: result.logs,
    } };
  } catch (error) {
    const status = error instanceof DatadogClientError && error.code === "timeout" ? 504 : 502;
    return { status, body: { error: status === 504 ? "datadog_timeout" : "datadog_request_failed" } };
  }
}

export function startLogReader(config: LogReaderConfig): Server {
  const server = createLogReaderServer({ config });
  server.listen(config.port, config.host);
  return server;
}
