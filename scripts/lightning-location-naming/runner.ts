import { NominatimReverseGeocoder } from "./nominatim.ts";
import { getLocationResearchPreset } from "./presets.ts";
import { validateCoordinates } from "./normalize.ts";
import type { ReverseGeocodeResult } from "./types.ts";

export type CliOptions = {
  latitude: number;
  longitude: number;
  format: "json" | "text";
  provider: "nominatim";
  sample: string;
  includeProviderHierarchy: boolean;
};

export function parseArgs(args: string[]): CliOptions {
  const values = new Map<string, string>();
  for (const arg of args) {
    const match = /^--([a-z-]+)=(.*)$/.exec(arg);
    if (!match) throw new Error(`Unknown argument: ${arg}`);
    values.set(match[1], match[2]);
  }
  for (const key of values.keys()) if (!["lat", "lon", "format", "provider", "preset", "sample", "include-provider-hierarchy"].includes(key)) throw new Error(`Unknown option: --${key}`);
  const presetId = values.get("preset");
  if (presetId && (values.has("lat") || values.has("lon"))) throw new Error("Use either --preset or --lat/--lon, not both");
  const preset = presetId ? getLocationResearchPreset(presetId) : undefined;
  const latitude = preset?.latitude ?? Number(values.get("lat"));
  const longitude = preset?.longitude ?? Number(values.get("lon"));
  if ((!preset && (!values.has("lat") || !values.has("lon"))) || !Number.isFinite(latitude) || !Number.isFinite(longitude)) throw new Error("Usage: npm run research:reverse-geocode -- --lat=39.92 --lon=32.85 [--provider=nominatim] [--format=json] [--include-provider-hierarchy=true] or --preset=ayranci");
  validateCoordinates(latitude, longitude);
  const provider = values.get("provider") ?? "nominatim";
  if (provider !== "nominatim") throw new Error("Only --provider=nominatim is implemented in this research CLI");
  const format = values.get("format") ?? "text";
  if (format !== "json" && format !== "text") throw new Error("--format must be json or text");
  const includeProviderHierarchyValue = values.get("include-provider-hierarchy") ?? "false";
  if (includeProviderHierarchyValue !== "true" && includeProviderHierarchyValue !== "false") throw new Error("--include-provider-hierarchy must be true or false");
  return {
    latitude, longitude, provider, format,
    sample: values.get("sample") ?? preset?.name ?? "Custom coordinate",
    includeProviderHierarchy: includeProviderHierarchyValue === "true",
  };
}

export function formatDiagnosticResult(sample: string, result: ReverseGeocodeResult) {
  const { providerAddress, provider, attribution, latitude, longitude, displayLabel, ...components } = result;
  return {
    status: displayLabel ? "lookup_succeeded" : "unresolved",
    sample,
    provider,
    requested: { latitude, longitude },
    providerAddress,
    normalized: { ...components, displayLabel },
    attribution,
  };
}

export function formatLookupFailure(sample: string, latitude: number, longitude: number, provider: string, error: unknown) {
  const code = error && typeof error === "object" && "code" in error ? String(error.code) : "unknown";
  const status = error && typeof error === "object" && "status" in error ? Number(error.status) : undefined;
  const errorType = code === "timeout" ? "timeout" : code === "network" ? "network_failure" : code === "malformed" ? "malformed_response" : status === 429 ? "rate_limit" : "provider_error";
  return {
    status: "lookup_failed",
    errorType,
    message: error instanceof Error ? error.message : String(error),
    ...(Number.isFinite(status) ? { httpStatus: status } : {}),
    sample,
    requested: { latitude, longitude },
    provider,
  };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  let result: ReverseGeocodeResult;
  try {
    result = await new NominatimReverseGeocoder().reverse(options.latitude, options.longitude, { includeProviderHierarchy: options.includeProviderHierarchy });
  } catch (error) {
    const failure = formatLookupFailure(options.sample, options.latitude, options.longitude, options.provider, error);
    if (options.format === "json") console.log(JSON.stringify(failure, null, 2));
    else console.error(`Reverse geocoding ${failure.errorType}: ${failure.message}`);
    process.exitCode = 1;
    return;
  }
  if (options.format === "json" && options.includeProviderHierarchy) {
    console.log(JSON.stringify(formatDiagnosticResult(options.sample, result), null, 2));
  } else if (options.format === "json") console.log(JSON.stringify({ status: result.displayLabel ? "lookup_succeeded" : "unresolved", sample: options.sample, ...result }, null, 2));
  else {
    console.log(`sample: ${options.sample}`);
    console.log(`coordinate: ${result.latitude}, ${result.longitude}`);
    console.log(`provider: ${result.provider}`);
    console.log(`neighborhood: ${result.neighborhood ?? "—"}`);
    console.log(`locality: ${result.locality ?? "—"}`);
    console.log(`district: ${result.district ?? "—"}`);
    console.log(`province: ${result.province ?? "—"}`);
    console.log(`displayLabel: ${result.displayLabel ?? "unresolved"}`);
    console.log(`attribution: ${result.attribution}`);
  }
  if (!result.displayLabel) process.exitCode = 2;
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Reverse geocoding failed: ${message}`);
    process.exitCode = 1;
  });
}
