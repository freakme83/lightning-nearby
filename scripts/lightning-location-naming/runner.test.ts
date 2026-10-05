import assert from "node:assert/strict";
import test from "node:test";
import { formatDiagnosticResult, formatLookupFailure, parseArgs } from "./runner.ts";
import { ReverseGeocodeError } from "./nominatim.ts";

test("CLI parses coordinates and optional output/provider flags", () => {
  assert.deepEqual(parseArgs(["--lat=39.92", "--lon=32.85", "--format=json"]), {
    latitude: 39.92, longitude: 32.85, provider: "nominatim", format: "json", sample: "Custom coordinate", includeProviderHierarchy: false,
  });
});

test("CLI supports named presets, custom coordinates, and optional provider diagnostics", () => {
  assert.deepEqual(parseArgs(["--preset=ayranci", "--include-provider-hierarchy=true"]), {
    latitude: 39.902861, longitude: 32.849819, provider: "nominatim", format: "text", sample: "Ayrancı", includeProviderHierarchy: true,
  });
  assert.throws(() => parseArgs(["--lat=91", "--lon=32"]), /latitude must be finite/);
  assert.throws(() => parseArgs(["--preset=ayranci", "--lat=39", "--lon=32"]), /either --preset or/);
});

test("CLI rejects missing coordinates and unsupported provider names", () => {
  assert.throws(() => parseArgs(["--lat=39.92"]), /Usage/);
  assert.throws(() => parseArgs(["--lat=39", "--lon=32", "--provider=other"]), /Only --provider=nominatim/);
});

test("diagnostic result keeps provider hierarchy separate without changing displayLabel", () => {
  const result = formatDiagnosticResult("Ayrancı", {
    latitude: 39.9, longitude: 32.8, neighborhood: "Ayrancı", district: "Çankaya", province: "Ankara",
    displayLabel: "Ayrancı, Çankaya", provider: "nominatim", attribution: "© OpenStreetMap contributors",
    providerAddress: { neighbourhood: "Ayrancı", quarter: null, suburb: null, city: null, town: null, village: null, hamlet: null, municipality: null, city_district: null, district: null, county: "Çankaya", state_district: null, province: null, state: "Ankara", region: null, country: "Türkiye" },
  });
  assert.equal(result.normalized.displayLabel, "Ayrancı, Çankaya");
  assert.equal(result.providerAddress?.county, "Çankaya");
  assert.equal("road" in (result.providerAddress ?? {}), false);
});

test("unresolved and provider failure JSON stay explicit", () => {
  const unresolved = formatDiagnosticResult("rural", { latitude: 39, longitude: 33, displayLabel: null, provider: "nominatim" });
  assert.equal(unresolved.status, "unresolved");
  assert.equal(unresolved.normalized.displayLabel, null);
  assert.equal(formatLookupFailure("sample", 39, 32, "nominatim", new ReverseGeocodeError("timeout", "timeout")).errorType, "timeout");
  assert.equal(formatLookupFailure("sample", 39, 32, "nominatim", new ReverseGeocodeError("network", "offline")).errorType, "network_failure");
  assert.equal(formatLookupFailure("sample", 39, 32, "nominatim", new ReverseGeocodeError("malformed", "invalid JSON")).errorType, "malformed_response");
  assert.equal(formatLookupFailure("sample", 39, 32, "nominatim", new ReverseGeocodeError("http", "429", 429)).errorType, "rate_limit");
});
