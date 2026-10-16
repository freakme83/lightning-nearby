export const DATADOG_LOGS_SEARCH_URL = "https://api.datadoghq.eu/api/v2/logs/events/search";
export const DATADOG_QUERY = "@fly.app.name:lightning-nearby-ankara-shadow";
export const MAX_LOG_RESULTS = 5_000;
export const PAGE_SIZE = 1_000;
export const REQUEST_TIMEOUT_MS = 10_000;

export type DatadogLog = Record<string, unknown>;

export class DatadogClientError extends Error {
  readonly code: "timeout" | "upstream" | "malformed";

  constructor(code: "timeout" | "upstream" | "malformed") {
    super(code);
    this.name = "DatadogClientError";
    this.code = code;
  }
}

type SearchOptions = {
  apiKey: string;
  appKey: string;
  from: string;
  to: string;
  fetcher?: typeof fetch;
  timeoutMs?: number;
  resultCap?: number;
};

type SearchResult = { logs: DatadogLog[]; truncated: boolean };

function safeResultCap(value: number | undefined): number {
  if (value === undefined) return MAX_LOG_RESULTS;
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError("resultCap must be a positive safe integer");
  return Math.min(value, MAX_LOG_RESULTS);
}

export async function searchDatadogLogs(options: SearchOptions): Promise<SearchResult> {
  const fetcher = options.fetcher ?? fetch;
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const resultCap = safeResultCap(options.resultCap);
  const logs: DatadogLog[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;

  while (logs.length < resultCap) {
    const pageLimit = Math.min(PAGE_SIZE, resultCap - logs.length);
    const body: Record<string, unknown> = {
      filter: { query: DATADOG_QUERY, from: options.from, to: options.to },
      sort: "-timestamp",
      page: { limit: pageLimit, ...(cursor ? { cursor } : {}) },
    };
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await fetcher(DATADOG_LOGS_SEARCH_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "DD-API-KEY": options.apiKey,
          "DD-APPLICATION-KEY": options.appKey,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch {
      clearTimeout(timeout);
      throw new DatadogClientError(controller.signal.aborted ? "timeout" : "upstream");
    }
    if (!response.ok) {
      clearTimeout(timeout);
      throw new DatadogClientError("upstream");
    }

    let payload: unknown;
    try { payload = await response.json(); }
    catch {
      clearTimeout(timeout);
      throw new DatadogClientError(controller.signal.aborted ? "timeout" : "malformed");
    }
    clearTimeout(timeout);
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new DatadogClientError("malformed");
    }
    const record = payload as Record<string, unknown>;
    if (!Array.isArray(record.data) || record.data.some(item => !item || typeof item !== "object" || Array.isArray(item))) {
      throw new DatadogClientError("malformed");
    }
    const meta = record.meta;
    let nextCursor: string | undefined;
    if (meta !== undefined && meta !== null) {
      if (typeof meta !== "object" || Array.isArray(meta)) throw new DatadogClientError("malformed");
      const page = (meta as Record<string, unknown>).page;
      if (page !== undefined && page !== null) {
        if (typeof page !== "object" || Array.isArray(page)) throw new DatadogClientError("malformed");
        const after = (page as Record<string, unknown>).after;
        if (after !== undefined && after !== null) {
          if (typeof after !== "string" || after.length === 0) throw new DatadogClientError("malformed");
          nextCursor = after;
        }
      }
    }

    const remaining = resultCap - logs.length;
    logs.push(...(record.data as DatadogLog[]).slice(0, remaining));
    if (record.data.length > remaining) return { logs, truncated: true };
    if (!nextCursor) return { logs, truncated: false };
    if (logs.length >= resultCap) return { logs, truncated: true };
    if (seenCursors.has(nextCursor)) throw new DatadogClientError("malformed");
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }

  return { logs, truncated: false };
}
