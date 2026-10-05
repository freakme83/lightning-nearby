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
  const allowed = new Set(["duration", "box", "area", "incident-profile", "summary-every", "format"]);
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
  const parameters: ClusterParameters = { ...DEFAULT_CLUSTER_PARAMETERS };
  return {
    box, monitoringArea, areaSelection: monitoringArea ? "ankara" as const : "custom" as const,
    profileId: selected, format,
    durationMs: positive(args.get("duration") ?? "15", "duration") * 60_000,
    summaryMs: positive(args.get("summary-every") ?? "60", "summary-every") * 1000,
    parameters,
  };
}
