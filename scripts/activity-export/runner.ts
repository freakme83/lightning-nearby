// Operator-only export of one completed Ankara Activity Watch period.
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
//   node --experimental-strip-types scripts/activity-export/runner.ts --period-id=<uuid> --out=<file.json>
// Authorization is the server-side service-role credential already held by operators;
// there is no HTTP endpoint and nothing is exposed to a browser. Reads only.
import { writeFile } from "node:fs/promises";
import { loadAnkaraDistrictAttributor } from "./districts.ts";
import { ActivityExportError, assertPeriodId, buildActivityExport, serializeActivityExport } from "./export.ts";
import { createActivityExportStore, type ActivityExportStore } from "./store.ts";

export function parseArgs(argv: readonly string[]): { periodId: string; out: string } {
  const value = (name: string) => argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
  const periodId = value("period-id"), out = value("out");
  if (!out) throw new Error("Usage: runner.ts --period-id=<uuid> --out=<file.json>");
  return { periodId: assertPeriodId(periodId), out };
}

export async function exportPeriod(store: ActivityExportStore, periodId: string) {
  const period = await store.getPeriod(assertPeriodId(periodId));
  // Reject before reading events: nonexistent and active periods need no further reads.
  if (!period) throw new ActivityExportError("period_not_found", "Activity period does not exist");
  if (period.state === "active") {
    throw new ActivityExportError("period_active", "Activity period is still active; only completed periods can be exported");
  }
  const members = await store.listMembers(periodId);
  const captures = await store.getCaptures(members.map(member => member.event_key));
  return buildActivityExport({ periodId, period, members, captures, attributor: loadAnkaraDistrictAttributor() });
}

export async function runActivityExport(argv: readonly string[], environment: Record<string, string | undefined>,
  log: (value: unknown) => void = value => console.log(JSON.stringify(value)), fetcher: typeof fetch = fetch): Promise<void> {
  const { periodId, out } = parseArgs(argv);
  const store = createActivityExportStore({ url: environment.SUPABASE_URL,
    serviceRoleKey: environment.SUPABASE_SERVICE_ROLE_KEY }, fetcher);
  const result = await exportPeriod(store, periodId);
  // "wx": never overwrite an existing file.
  await writeFile(out, serializeActivityExport(result), { flag: "wx" });
  const { activityPeriod: period, archive } = result.meta;
  log({ kind: "activity_export_written", out, periodId, firstDetectionAt: period.firstDetectionAt,
    lastDetectionAt: period.lastDetectionAt, closedAt: period.closedAt, coverageUncertain: period.coverageUncertain,
    interruptionCount: period.interruptionCount, archiveComplete: archive.complete,
    districtSummary: result.meta.districtSummary });
}

if (process.argv[1]?.endsWith("/scripts/activity-export/runner.ts")) {
  runActivityExport(process.argv.slice(2), process.env).catch(error => {
    // Never print upstream bodies or credentials.
    console.error(JSON.stringify({ kind: "activity_export_error",
      code: error instanceof ActivityExportError ? error.code : "export_failed",
      reason: error instanceof Error ? error.message : "unknown" }));
    process.exitCode = 1;
  });
}
