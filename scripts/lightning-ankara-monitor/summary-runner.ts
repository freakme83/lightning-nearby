import { readFile } from "node:fs/promises";
import { renderMonitorSummary } from "./summary.ts";
import type { MonitorResult } from "./runner.ts";

try {
  const result = JSON.parse(await readFile("artifacts/lightning-ankara-monitor-result.json", "utf8")) as MonitorResult;
  process.stdout.write(renderMonitorSummary(result));
} catch {
  process.stdout.write("## Ankara monitor result\n\nNo structured monitor result was produced. Inspect the workflow log.\n\nNo social post was sent.\n");
  process.exitCode = 1;
}
