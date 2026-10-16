import assert from "node:assert/strict";
import test from "node:test";
import {
  decodeBlitzortungFrame,
  MAX_BLITZORTUNG_ENCODED_FRAME_CHARS,
  normalizeBlitzortungTimestamp,
  parseDecodedBlitzortungPayload,
  processBlitzortungFrame,
} from "./protocol.ts";

const SAMPLE_JSON = "{\"time\":1784284530066558000,\"lat\":39.9208,\"lon\":32.8541,\"pol\":-1,\"mds\":8874,\"mcg\":72,\"region\":1,\"sig\":[{\"sta\":751}]}";
const SAMPLE_COMPRESSED_CODES = [
  123, 34, 116, 105, 109, 101, 34, 58, 49, 55, 56, 52, 50, 266, 53, 51, 48, 48, 54, 54, 53, 53,
  56, 272, 48, 44, 34, 108, 97, 116, 262, 51, 57, 46, 57, 50, 48, 56, 281, 108, 111, 110, 286,
  50, 46, 56, 53, 52, 49, 281, 112, 111, 108, 262, 45, 304, 34, 109, 100, 115, 262, 56, 56, 55,
  52, 281, 109, 99, 103, 262, 55, 50, 281, 114, 101, 103, 105, 296, 262, 311, 115, 105, 324, 58,
  91, 256, 115, 116, 97, 325, 53, 49, 125, 93, 125,
];
const SAMPLE_COMPRESSED = String.fromCharCode(...SAMPLE_COMPRESSED_CODES);

test("current-format compressed sample decodes to JSON text", () => {
  assert.equal(decodeBlitzortungFrame(SAMPLE_COMPRESSED), SAMPLE_JSON);
  assert.deepEqual(JSON.parse(decodeBlitzortungFrame(SAMPLE_COMPRESSED)), JSON.parse(SAMPLE_JSON));
});

test("decoded current-format strike becomes a minimal source-specific event", () => {
  const receivedAtMs = 1_784_284_531_300;
  const result = processBlitzortungFrame(SAMPLE_COMPRESSED, receivedAtMs, "ws7");
  assert.equal(result.kind, "event");
  if (result.kind !== "event") return;
  assert.deepEqual(result.event, {
    source: "blitzortung",
    sourceServer: "ws7",
    receivedAtMs,
    eventTimeMs: 1_784_284_530_066,
    eventTimeRaw: "1784284530066558000",
    eventTimeUnit: "nanoseconds",
    latencyMs: 1_234,
    latencyEligible: true,
    latitude: 39.9208,
    longitude: 32.8541,
    polarityRaw: -1,
    stationCount: 1,
    mdsRaw: 8874,
    mcgRaw: 72,
    regionRaw: 1,
    insideMonitoringArea: true,
  });
});

test("unsafe nanosecond timestamp is preserved before millisecond normalization", () => {
  const timestamp = normalizeBlitzortungTimestamp("1784284530066558001");
  assert.equal(timestamp.eventTimeRaw, "1784284530066558001");
  assert.equal(timestamp.eventTimeMs, 1_784_284_530_066);
  assert.equal(timestamp.eventTimeUnit, "nanoseconds");

  const result = parseDecodedBlitzortungPayload(
    "{\"lat\":39.9,\"sig\":[],\"time\":1784284530066558001,\"lon\":32.8}",
    1_784_284_530_100,
    "ws1",
  );
  assert.equal(result.kind, "event");
  if (result.kind === "event") assert.equal(result.event.eventTimeRaw, "1784284530066558001");
});

test("existing Ankara geometry policy identifies inside and outside strikes", () => {
  const inside = parseDecodedBlitzortungPayload(SAMPLE_JSON, 1_784_284_531_300, "ws8");
  const outside = parseDecodedBlitzortungPayload(
    "{\"time\":1784284530066558000,\"lat\":49.986296,\"lon\":10.301035,\"sig\":[]}",
    1_784_284_531_300,
    "ws8",
  );
  assert.equal(inside.kind, "event");
  assert.equal(outside.kind, "event");
  if (inside.kind === "event") assert.equal(inside.event.insideMonitoringArea, true);
  if (outside.kind === "event") assert.equal(outside.event.insideMonitoringArea, false);
});

test("malformed and unexpected decoded payloads are rejected safely", () => {
  assert.equal(parseDecodedBlitzortungPayload("not json", Date.now(), "ws1").kind, "json_parse_error");
  assert.equal(parseDecodedBlitzortungPayload("[]", Date.now(), "ws1").kind, "unexpected_payload");
  assert.equal(parseDecodedBlitzortungPayload("{\"time\":1,\"lat\":999,\"lon\":0}", Date.now(), "ws1").kind,
    "unexpected_payload");
});

test("decoder failures are contained by the frame boundary", () => {
  const invalidDictionaryReference = String.fromCharCode(123, 400);
  assert.throws(() => decodeBlitzortungFrame(invalidDictionaryReference), /invalid LZW code/);
  assert.deepEqual(processBlitzortungFrame(invalidDictionaryReference, Date.now(), "ws1"), {
    kind: "decode_error",
    reason: "invalid LZW code 400 at symbol 1",
  });
});

test("encoded frame size is bounded before LZW allocation", () => {
  const atLimit = "{".repeat(MAX_BLITZORTUNG_ENCODED_FRAME_CHARS);
  assert.equal(processBlitzortungFrame(atLimit, Date.now(), "ws1").kind, "json_parse_error");

  const oversized = "{".repeat(MAX_BLITZORTUNG_ENCODED_FRAME_CHARS + 1);
  assert.throws(() => decodeBlitzortungFrame(oversized), /encoded frame exceeds 16384 character limit/);
  assert.deepEqual(processBlitzortungFrame(oversized, Date.now(), "ws1"), {
    kind: "decode_error",
    reason: "encoded frame exceeds 16384 character limit (16385)",
  });
});

test("future event keeps raw negative latency but marks it ineligible", () => {
  const result = parseDecodedBlitzortungPayload(
    "{\"time\":1784284530066558000,\"lat\":39.9,\"lon\":32.8}",
    1_784_284_530_000,
    "ws8",
  );
  assert.equal(result.kind, "event");
  if (result.kind !== "event") return;
  assert.equal(result.event.eventTimeRaw, "1784284530066558000");
  assert.equal(result.event.eventTimeMs, 1_784_284_530_066);
  assert.equal(result.event.latencyMs, -66);
  assert.equal(result.event.latencyEligible, false);
});
