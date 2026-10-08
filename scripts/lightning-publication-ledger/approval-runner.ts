import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { applyManualApproval, type ApprovalAction, type ApprovalResult } from "./approval.ts";
import { createSupabaseApprovalStore } from "./storage/supabase.ts";

const resultPath = "artifacts/lightning-manual-approval-result.json";
export function approvalExitCode(result: ApprovalResult): number {
  return ["updated", "already_approved", "already_skipped"].includes(result.outcome) ? 0 : 1;
}

export async function main(): Promise<void> {
  const publicationId = process.env.PUBLICATION_ID ?? "";
  const action = process.env.APPROVAL_ACTION ?? "";
  let result: ApprovalResult;
  try {
    const store = createSupabaseApprovalStore({ url: process.env.SUPABASE_URL,
      serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY });
    result = await applyManualApproval(publicationId, action as ApprovalAction, store,
      { actor: process.env.GITHUB_ACTOR });
  } catch {
    result = { publicationId, requestedAction: action as ApprovalAction, previousStatus: null,
      finalStatus: null, decision: null, messageText: null, mapUrl: null, outcome: "storage_error",
      reason: "Supabase approval configuration is unavailable or invalid." };
  }
  await mkdir("artifacts", { recursive: true });
  await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`);
  console.log(`Manual approval outcome: ${result.outcome}. Result: ${resultPath}`);
  if (approvalExitCode(result)) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch(() => { console.error("Could not write manual approval result artifact."); process.exitCode = 1; });
}
