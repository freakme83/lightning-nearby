import { enrichIncidentWithLightningType } from "./xweather.ts";
import type { EnrichmentOptions, EnrichmentReference } from "./types.ts";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveThresholds, validateReference } from "./match.ts";

function parseFlags(args: string[]): Record<string, string> {
  const values: Record<string, string> = {};
  for (const arg of args) {
    const match = /^--([a-z-]+)=(.*)$/.exec(arg);
    if (!match || match[2] === "") throw new Error(`invalid argument: ${arg.split("=")[0]}`);
    if (values[match[1]] !== undefined) throw new Error(`duplicate argument: --${match[1]}`);
    values[match[1]] = match[2];
  }
  return values;
}

function parseTime(value: string): number {
  const numeric = /^\d+$/.test(value) ? Number(value) : Date.parse(value);
  if (!Number.isSafeInteger(numeric) || numeric < 0 || numeric > 8.64e15) throw new Error("--time must be Unix milliseconds or an ISO date-time");
  return numeric;
}

function positiveNumber(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`invalid --${name}`);
  return parsed;
}

export function parseCli(args: string[]): { reference: EnrichmentReference; options: EnrichmentOptions } {
  const values = parseFlags(args);
  const allowed = new Set(["lat", "lon", "time", "radius-km", "max-distance-km", "max-age-minutes", "limit"]);
  for (const key of Object.keys(values)) if (!allowed.has(key)) throw new Error(`unknown argument: --${key}`);
  for (const required of ["lat", "lon", "time"]) if (values[required] === undefined) throw new Error(`missing required --${required}`);
  const latitude = Number(values.lat);
  const longitude = Number(values.lon);
  const reference = { latitude, longitude, eventTimeMs: parseTime(values.time!) };
  const options: EnrichmentOptions = {
    ...(positiveNumber(values["radius-km"], "radius-km") === undefined ? {} : { radiusKm: Number(values["radius-km"]) }),
    ...(positiveNumber(values["max-distance-km"], "max-distance-km") === undefined ? {} : { maxMatchDistanceKm: Number(values["max-distance-km"]) }),
    ...(positiveNumber(values["max-age-minutes"], "max-age-minutes") === undefined ? {} : { maxTimeDifferenceMs: Number(values["max-age-minutes"]) * 60_000 }),
    ...(positiveNumber(values.limit, "limit") === undefined ? {} : { limit: Number(values.limit) }),
  };
  validateReference(reference);
  resolveThresholds(options);
  return { reference, options };
}

function usage(): string {
  return "Usage: npm run research:cg-enrichment -- --lat=39.9 --lon=32.8 --time=1791289200000 [--radius-km=10] [--max-distance-km=8] [--max-age-minutes=5] [--limit=10]";
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void (async () => {
    try {
      const { reference, options } = parseCli(process.argv.slice(2));
      const result = await enrichIncidentWithLightningType(reference, options);
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      if (result.status === "provider_unavailable") process.exitCode = 2;
    } catch (error) {
      process.stderr.write(`${(error as Error).message}\n${usage()}\n`);
      process.exitCode = 1;
    }
  })();
}
