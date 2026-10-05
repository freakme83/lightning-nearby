import assert from "node:assert/strict";
import test from "node:test";
import { parseArgs } from "./runner.ts";

test("CLI parses coordinates and optional output/provider flags", () => {
  assert.deepEqual(parseArgs(["--lat=39.92", "--lon=32.85", "--format=json"]), {
    latitude: 39.92, longitude: 32.85, provider: "nominatim", format: "json",
  });
});

test("CLI rejects missing coordinates and unsupported provider names", () => {
  assert.throws(() => parseArgs(["--lat=39.92"]), /Usage/);
  assert.throws(() => parseArgs(["--lat=39", "--lon=32", "--provider=other"]), /Only --provider=nominatim/);
});

