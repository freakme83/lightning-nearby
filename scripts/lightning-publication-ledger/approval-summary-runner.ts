import { readFile } from "node:fs/promises";
import { renderApprovalSummary } from "./approval-summary.ts";
import type { ApprovalResult } from "./approval.ts";

try {
  const result = JSON.parse(await readFile("artifacts/lightning-manual-approval-result.json", "utf8")) as ApprovalResult;
  console.log(renderApprovalSummary(result));
} catch {
  console.log("## Manual approval result\n\nNo structured result was produced.\n\nNo social post was sent.");
}
