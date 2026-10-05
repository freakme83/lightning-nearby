import { NominatimReverseGeocoder } from "./nominatim.ts";

export type CliOptions = { latitude: number; longitude: number; format: "json" | "text"; provider: "nominatim" };

export function parseArgs(args: string[]): CliOptions {
  const values = new Map<string, string>();
  for (const arg of args) {
    const match = /^--([a-z-]+)=(.*)$/.exec(arg);
    if (!match) throw new Error(`Unknown argument: ${arg}`);
    values.set(match[1], match[2]);
  }
  const latitude = Number(values.get("lat"));
  const longitude = Number(values.get("lon"));
  if (!values.has("lat") || !values.has("lon") || !Number.isFinite(latitude) || !Number.isFinite(longitude)) throw new Error("Usage: npm run research:reverse-geocode -- --lat=39.92 --lon=32.85 [--provider=nominatim] [--format=json]");
  const provider = values.get("provider") ?? "nominatim";
  if (provider !== "nominatim") throw new Error("Only --provider=nominatim is implemented in this research CLI");
  const format = values.get("format") ?? "text";
  if (format !== "json" && format !== "text") throw new Error("--format must be json or text");
  return { latitude, longitude, provider, format };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const result = await new NominatimReverseGeocoder().reverse(options.latitude, options.longitude);
  if (options.format === "json") console.log(JSON.stringify(result, null, 2));
  else {
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

