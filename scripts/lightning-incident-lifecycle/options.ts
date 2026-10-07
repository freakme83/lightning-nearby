import { EXTREMADURA_ACTIVE_BOX, type Box } from "../live-lightning-listener/core.ts";
import { DEFAULT_CLUSTER_PARAMETERS, type ClusterParameters } from "../live-lightning-clustering/clusterer.ts";
import { ANKARA_MONITORING_AREA, type MonitoringArea } from "./monitoring-area.ts";

function positive(value: string | undefined, name: string): number {
  const result = Number(value);
  if (!Number.isFinite(result) || result <= 0) throw new Error(`Invalid ${name}`);
  return result;
}

export function readIncidentRunnerOptions(argv: string[]) {
  const args = new Map<string, string>();
  const allowed = new Set(["duration", "box", "area", "incident-profile", "summary-every", "format", "paired-validation-output",
    "gate-comparison", "max-xweather-calls", "hypothetical-user-checks"]);
  for (const arg of argv) {
    if (!arg.startsWith("--") || !arg.includes("=")) throw new Error(`Expected --name=value: ${arg}`);
    const [name, ...rest] = arg.slice(2).split("=");
    if (!allowed.has(name)) throw new Error(`Unknown flag: ${name}`);
    if (args.has(name)) throw new Error(`Duplicate flag: ${name}`);
    args.set(name, rest.join("="));
  }

  const areaValue = args.get("area");
  if (areaValue !== undefined && areaValue !== "ankara") throw new Error("--area=ankara is the only named monitoring area");
  if (areaValue && args.has("box")) throw new Error("--area=ankara and --box cannot be supplied together");

  const coordinates = args.get("box")?.split(",").map(Number);
  if (coordinates && (coordinates.length !== 4 || coordinates.some(value => !Number.isFinite(value)))) {
    throw new Error("--box=north,east,south,west");
  }
  const monitoringArea = areaValue === "ankara" ? ANKARA_MONITORING_AREA : undefined;
  const box: Box = monitoringArea?.bounds ?? (coordinates ? {
    north: coordinates[0], east: coordinates[1], south: coordinates[2], west: coordinates[3],
  } : EXTREMADURA_ACTIVE_BOX);
  if (box.north > 90 || box.south < -90 || box.north <= box.south ||
      box.east > 180 || box.west < -180 || box.east <= box.west) throw new Error("Invalid box bounds");

  const selected = (args.get("incident-profile") ?? "B").toUpperCase();
  if (selected !== "A" && selected !== "B" && selected !== "C") throw new Error("--incident-profile=A|B|C");
  const format = args.get("format") ?? "human";
  if (format !== "human" && format !== "jsonl") throw new Error("--format=human|jsonl");
  const pairedValidationOutput = args.get("paired-validation-output");
  if (args.has("paired-validation-output") && !pairedValidationOutput) throw new Error("--paired-validation-output must be a non-empty path");
  const gateComparison = args.get("gate-comparison") === "true";
  if (args.has("gate-comparison") && !gateComparison) throw new Error("--gate-comparison=true");
  if (gateComparison && pairedValidationOutput) throw new Error("Gate comparison and paired validation are separate modes");
  if (!gateComparison && (args.has("max-xweather-calls") || args.has("hypothetical-user-checks"))) {
    throw new Error("Gate comparison options require --gate-comparison=true");
  }
  const maxXweatherCalls = Number(args.get("max-xweather-calls") ?? "3");
  if (!Number.isInteger(maxXweatherCalls) || maxXweatherCalls < 0 || maxXweatherCalls > 10) {
    throw new Error("--max-xweather-calls must be an integer from 0 through 10");
  }
  const hypotheticalRaw = args.get("hypothetical-user-checks");
  const hypotheticalUserChecks = hypotheticalRaw === undefined ? undefined : Number(hypotheticalRaw);
  if (hypotheticalUserChecks !== undefined && (!/^\d+$/.test(hypotheticalRaw!) ||
      !Number.isSafeInteger(hypotheticalUserChecks) || hypotheticalUserChecks > 100_000)) {
    throw new Error("--hypothetical-user-checks must be an integer from 0 through 100000");
  }
  const durationMinutes = positive(args.get("duration") ?? "15", "duration");
  if (gateComparison && (!Number.isInteger(durationMinutes) || durationMinutes < 1 || durationMinutes > 20)) {
    throw new Error("Gate comparison duration must be 1 through 20 whole minutes");
  }
  const parameters: ClusterParameters = { ...DEFAULT_CLUSTER_PARAMETERS };
  return {
    box, monitoringArea, areaSelection: monitoringArea ? "ankara" as const : "custom" as const,
    profileId: selected, format, pairedValidationOutput, gateComparison, maxXweatherCalls, hypotheticalUserChecks,
    durationMs: durationMinutes * 60_000,
    summaryMs: positive(args.get("summary-every") ?? "60", "summary-every") * 1000,
    parameters,
  };
}
