import { readFile } from "node:fs/promises";
import type { DryRunResult } from "./orchestrate.ts";
import { renderEndToEndSummary } from "./summary.ts";

const path = process.argv[2] ?? "artifacts/lightning-end-to-end-dry-run-result.json";
try {
  const result = JSON.parse(await readFile(path, "utf8")) as DryRunResult;
  process.stdout.write(renderEndToEndSummary(result));
} catch {
  process.stdout.write("# Lightning end-to-end dry run\n\nNo structured result was produced. Inspect the workflow log and paired live-run artifact.\n\nDry run only. Nothing was published.\n");
  process.exitCode = 1;
}
