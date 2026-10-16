import { pointInMonitoringArea } from "../../lightning-incident-lifecycle/monitoring-area.ts";

export const BLITZORTUNG_SOURCE = "blitzortung" as const;
export const BLITZORTUNG_SERVERS = ["ws1", "ws7", "ws8"] as const;

export type BlitzortungServer = (typeof BLITZORTUNG_SERVERS)[number];
export type BlitzTimestampUnit = "seconds" | "milliseconds" | "microseconds" | "nanoseconds";

type JsonPrimitive = string | number | boolean | null;

export type BlitzortungProbeEvent = {
  source: typeof BLITZORTUNG_SOURCE;
  sourceServer: BlitzortungServer;
  receivedAtMs: number;
  eventTimeMs: number;
  eventTimeRaw: string;
  eventTimeUnit: BlitzTimestampUnit;
  latencyMs: number;
  latitude: number;
  longitude: number;
  polarityRaw: JsonPrimitive;
  stationCount: number | null;
  mdsRaw: JsonPrimitive;
  mcgRaw: JsonPrimitive;
  regionRaw: JsonPrimitive;
  insideMonitoringArea: boolean;
};

export type ProcessedBlitzortungFrame =
  | { kind: "event"; decodedChars: number; event: BlitzortungProbeEvent }
  | { kind: "decode_error"; reason: string }
  | { kind: "json_parse_error"; decodedChars: number; reason: string }
  | { kind: "unexpected_payload"; decodedChars: number; reason: string };

/**
 * The raw feed uses the compact LZW variant present in the current community
 * client. Codes below 256 are literal UTF-16 code units; later codes refer to
 * dictionary entries built while decoding.
 */
export function decodeBlitzortungFrame(input: string): string {
  if (input.length === 0) throw new Error("empty compressed frame");
  const symbols = input.split("");
  const dictionary = new Map<number, string>();
  let previous = symbols[0];
  const output = [previous];
  let nextCode = 256;

  for (let index = 1; index < symbols.length; index++) {
    const code = symbols[index].charCodeAt(0);
    let current: string;
    if (code < 256) current = symbols[index];
    else if (dictionary.has(code)) current = dictionary.get(code)!;
    else if (code === nextCode) current = previous + previous.charAt(0);
    else throw new Error(`invalid LZW code ${code} at symbol ${index}`);

    output.push(current);
    dictionary.set(nextCode++, previous + current.charAt(0));
    previous = current;
  }
  return output.join("");
}

function quoteTopLevelIntegerProperty(json: string, property: string): string {
  let depth = 0;
  let index = 0;
  while (index < json.length) {
    const character = json[index];
    if (character === "{") { depth++; index++; continue; }
    if (character === "}") { depth--; index++; continue; }
    if (character !== "\"") { index++; continue; }

    const stringStart = index;
    index++;
    let escaped = false;
    while (index < json.length) {
      const value = json[index++];
      if (escaped) { escaped = false; continue; }
      if (value === "\\") { escaped = true; continue; }
      if (value === "\"") break;
    }
    if (depth !== 1) continue;

    let key: unknown;
    try { key = JSON.parse(json.slice(stringStart, index)); } catch { continue; }
    if (key !== property) continue;
    let cursor = index;
    while (/\s/.test(json[cursor] ?? "")) cursor++;
    if (json[cursor] !== ":") continue;
    cursor++;
    while (/\s/.test(json[cursor] ?? "")) cursor++;
    const numberStart = cursor;
    if (json[cursor] === "-") cursor++;
    const digitsStart = cursor;
    while (/\d/.test(json[cursor] ?? "")) cursor++;
    if (cursor === digitsStart || /[.eE]/.test(json[cursor] ?? "")) continue;
    return `${json.slice(0, numberStart)}"${json.slice(numberStart, cursor)}"${json.slice(cursor)}`;
  }
  return json;
}

function rawPrimitive(value: unknown): JsonPrimitive {
  return value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean"
    ? value : null;
}

export function normalizeBlitzortungTimestamp(raw: unknown): {
  eventTimeMs: number;
  eventTimeRaw: string;
  eventTimeUnit: BlitzTimestampUnit;
} {
  if (typeof raw !== "string" && !(typeof raw === "number" && Number.isSafeInteger(raw))) {
    throw new Error("time must be an integer string or safe integer");
  }
  const eventTimeRaw = String(raw);
  if (!/^[0-9]+$/.test(eventTimeRaw)) throw new Error("time must be a non-negative integer");
  const value = BigInt(eventTimeRaw);
  let eventTimeUnit: BlitzTimestampUnit;
  let milliseconds: bigint;
  if (value >= BigInt("100000000000000000")) {
    eventTimeUnit = "nanoseconds";
    milliseconds = value / BigInt(1_000_000);
  } else if (value >= BigInt("100000000000000")) {
    eventTimeUnit = "microseconds";
    milliseconds = value / BigInt(1_000);
  } else if (value >= BigInt("100000000000")) {
    eventTimeUnit = "milliseconds";
    milliseconds = value;
  } else {
    eventTimeUnit = "seconds";
    milliseconds = value * BigInt(1_000);
  }
  if (milliseconds > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("normalized time exceeds safe integer range");
  const eventTimeMs = Number(milliseconds);
  if (!Number.isSafeInteger(eventTimeMs) || !Number.isFinite(new Date(eventTimeMs).getTime())) {
    throw new Error("normalized time is not a valid JavaScript timestamp");
  }
  return { eventTimeMs, eventTimeRaw, eventTimeUnit };
}

export function parseDecodedBlitzortungPayload(
  decoded: string,
  receivedAtMs: number,
  sourceServer: BlitzortungServer,
): Exclude<ProcessedBlitzortungFrame, { kind: "decode_error" }> {
  let payload: unknown;
  try {
    // Preserve the top-level nanosecond integer as text before JSON.parse can
    // round it through Number. Nested detector timing fields remain opaque.
    payload = JSON.parse(quoteTopLevelIntegerProperty(decoded, "time"));
  } catch {
    return { kind: "json_parse_error", decodedChars: decoded.length, reason: "invalid JSON" };
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { kind: "unexpected_payload", decodedChars: decoded.length, reason: "payload is not an object" };
  }
  const strike = payload as Record<string, unknown>;
  if (typeof strike.lat !== "number" || !Number.isFinite(strike.lat) || strike.lat < -90 || strike.lat > 90 ||
      typeof strike.lon !== "number" || !Number.isFinite(strike.lon) || strike.lon < -180 || strike.lon > 180) {
    return { kind: "unexpected_payload", decodedChars: decoded.length, reason: "invalid latitude/longitude" };
  }

  let timestamp: ReturnType<typeof normalizeBlitzortungTimestamp>;
  try { timestamp = normalizeBlitzortungTimestamp(strike.time); }
  catch (error) {
    return { kind: "unexpected_payload", decodedChars: decoded.length,
      reason: error instanceof Error ? error.message : "invalid time" };
  }
  const stationCount = Array.isArray(strike.sig) ? strike.sig.length : null;
  const event: BlitzortungProbeEvent = {
    source: BLITZORTUNG_SOURCE,
    sourceServer,
    receivedAtMs,
    ...timestamp,
    latencyMs: receivedAtMs - timestamp.eventTimeMs,
    latitude: strike.lat,
    longitude: strike.lon,
    polarityRaw: rawPrimitive(strike.pol),
    stationCount,
    mdsRaw: rawPrimitive(strike.mds),
    mcgRaw: rawPrimitive(strike.mcg),
    regionRaw: rawPrimitive(strike.region),
    insideMonitoringArea: pointInMonitoringArea([strike.lon, strike.lat]),
  };
  return { kind: "event", decodedChars: decoded.length, event };
}

export function processBlitzortungFrame(
  compressed: string,
  receivedAtMs: number,
  sourceServer: BlitzortungServer,
): ProcessedBlitzortungFrame {
  let decoded: string;
  try { decoded = decodeBlitzortungFrame(compressed); }
  catch (error) {
    return { kind: "decode_error", reason: error instanceof Error ? error.message : "decoder failure" };
  }
  return parseDecodedBlitzortungPayload(decoded, receivedAtMs, sourceServer);
}
