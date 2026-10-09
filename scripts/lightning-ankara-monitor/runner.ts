import { spawn } from "node:child_process";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { DryRunResult } from "../lightning-end-to-end-dry-run/orchestrate.ts";

export const MONITOR_DURATION_MINUTES = 10;
export const monitorRunnerArgs = ["--experimental-strip-types", "scripts/lightning-end-to-end-dry-run/runner.ts"];

export type MonitorOutcome = "candidate_persisted" | "duplicate" | "held" | "no_publish_candidate" |
  "no_fresh_publish_candidate" | "no_usable_location_label" | "implementation_unavailable" | "operational_failure";

export type MonitorResult = {
  mode: "ankara";
  outcome: MonitorOutcome;
  githubEventName: string | null;
  githubRunId: string | null;
  githubRunAttempt: string | null;
  scheduledSlotAt: string | null;
  scheduleDelaySeconds: number | null;
  scheduleDelayMinutes: number | null;
  monitorDurationSeconds: number | null;
  // Wrapper entry time; it is also the actual start and monitor-window start.
  runStartedAt: string;
  runEndedAt: string;
  sourceHealth: string | null;
  candidateFound: boolean;
  publicationId: string | null;
  decision: "WOULD_PUBLISH" | "HOLD" | null;
  approvalStatus: "pending" | null;
  locationLabel: string | null;
  enrichmentStatus: string | null;
  messageText: string | null;
  duplicate: boolean | null;
  historyOutcome: string;
  xweatherRequestAttempted: boolean | null;
  xweatherRequestCount: number | null;
  reason: string | null;
};

type MonitorEnv = Record<string, string | undefined>;
type Clock = () => string;

export function resolveScheduleTelemetry(input: {
  githubEventName?: string;
  githubRunId?: string;
  githubRunAttempt?: string;
  scheduleExpression?: string | null;
  runStartedAt: string;
  runEndedAt: string;
}): Pick<MonitorResult, "githubEventName" | "githubRunId" | "githubRunAttempt" | "scheduledSlotAt" |
  "scheduleDelaySeconds" | "scheduleDelayMinutes" | "monitorDurationSeconds"> {
  const startedMs = Date.parse(input.runStartedAt);
  const endedMs = Date.parse(input.runEndedAt);
  const monitorDurationSeconds = Number.isFinite(startedMs) && Number.isFinite(endedMs) && endedMs >= startedMs
    ? Math.round((endedMs - startedMs) / 1000) : null;
  let scheduledSlotAt: string | null = null;
  let scheduleDelaySeconds: number | null = null;
  let scheduleDelayMinutes: number | null = null;

  if (input.githubEventName === "schedule" && input.scheduleExpression === "*/15 * * * *" && Number.isFinite(startedMs)) {
    const slotMs = Math.floor(startedMs / (15 * 60 * 1000)) * (15 * 60 * 1000);
    const delaySeconds = Math.floor((startedMs - slotMs) / 1000);
    if (delaySeconds >= 0) {
      scheduledSlotAt = new Date(slotMs).toISOString();
      scheduleDelaySeconds = delaySeconds;
      scheduleDelayMinutes = Math.round((delaySeconds / 60) * 100) / 100;
    }
  }

  return {
    githubEventName: input.githubEventName || null,
    githubRunId: input.githubRunId || null,
    githubRunAttempt: input.githubRunAttempt || null,
    scheduledSlotAt,
    scheduleDelaySeconds,
    scheduleDelayMinutes,
    monitorDurationSeconds,
  };
}

async function readScheduleExpression(env: MonitorEnv): Promise<string | null> {
  if (env.GITHUB_EVENT_SCHEDULE) return env.GITHUB_EVENT_SCHEDULE;
  if (!env.GITHUB_EVENT_PATH) return null;
  try {
    const event = asRecord(JSON.parse(await readFile(env.GITHUB_EVENT_PATH, "utf8")));
    return typeof event.schedule === "string" ? event.schedule : null;
  } catch {
    return null;
  }
}

export function missingConfiguration(env: MonitorEnv): string | null {
  const required = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "XWEATHER_CLIENT_ID", "XWEATHER_CLIENT_SECRET"];
  return required.some(key => !env[key]) ? "Required Supabase or Xweather configuration is missing." : null;
}

export function pipelineEnvironment(env: MonitorEnv): NodeJS.ProcessEnv {
  const keys = ["PATH", "HOME", "CI", "GITHUB_RUN_ID", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY",
    "XWEATHER_CLIENT_ID", "XWEATHER_CLIENT_SECRET"];
  const child = {} as NodeJS.ProcessEnv;
  for (const key of keys) if (env[key] !== undefined) child[key] = env[key];
  child.AREA = "ankara";
  child.DURATION_MINUTES = String(MONITOR_DURATION_MINUTES);
  child.INCIDENT_PROFILE = "B";
  return child;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function buildMonitorResult(input: {
  pipeline: DryRunResult | null;
  pipelineExitCode: number;
  runStartedAt: string;
  runEndedAt: string;
  githubEventName?: string;
  githubRunId?: string;
  githubRunAttempt?: string;
  scheduleExpression?: string | null;
  sourceHealthLog?: string;
  reason?: string | null;
}): MonitorResult {
  const result = input.pipeline;
  const paired = asRecord(result?.paired);
  const incident = asRecord(paired.incident);
  const enrichment = asRecord(paired.enrichment);
  const location = asRecord(result?.location);
  const normalized = asRecord(location.normalized);
  const decision = result?.publishDecision;
  const ledger = result?.ledger;
  const duplicate = ledger?.duplicateMatch?.duplicate ?? decision?.duplicateIncident ?? null;
  const sawLiveSource = input.sourceHealthLog?.split("\n").some(line => {
    try { return asRecord(JSON.parse(line)).kind === "source_health" && asRecord(JSON.parse(line)).to === "live"; }
    catch { return false; }
  }) ?? false;
  const sourceHealth = decision?.sourceHealthAtTrigger ??
    (sawLiveSource ? "live during window" : typeof paired.sourceHealth === "string" ? paired.sourceHealth : null);
  const candidateFound = Boolean(incident.incidentId) || result?.status === "message_preview_ready";
  const publicationId = ledger?.persistedPublicationId ?? null;
  const scheduleTelemetry = resolveScheduleTelemetry({
    githubEventName: input.githubEventName,
    githubRunId: input.githubRunId,
    githubRunAttempt: input.githubRunAttempt,
    scheduleExpression: input.scheduleExpression,
    runStartedAt: input.runStartedAt,
    runEndedAt: input.runEndedAt,
  });
  let outcome: MonitorOutcome = "operational_failure";
  let reason = input.reason ?? null;

  if (input.pipelineExitCode !== 0) {
    reason ??= "The existing live end-to-end pipeline failed.";
  } else if (!result) {
    reason ??= "The existing pipeline produced no structured result.";
  } else if (result.status === "no_publish_candidate") {
    if (sawLiveSource) outcome = "no_publish_candidate";
    else reason ??= "The live source did not reach a healthy state during the monitoring window.";
  } else if (result.status === "no_fresh_publish_candidate") {
    if (sawLiveSource) outcome = "no_fresh_publish_candidate";
    else reason ??= "The live source did not reach a healthy state during the monitoring window.";
  } else if (result.status === "no_usable_location_label") {
    outcome = "no_usable_location_label";
  } else if (result.status === "paired_validation_failed") {
    reason ??= "The live source or paired-validation step failed.";
  } else if (result.status === "location_lookup_failed") {
    reason ??= "The existing location lookup failed.";
  } else if (result.status === "message_composition_failed") {
    reason ??= "The existing message composition step failed.";
  } else if (result.status !== "message_preview_ready") {
    reason ??= "The pipeline returned an unrecognized result.";
  } else if (sourceHealth !== "live") {
    reason ??= "The live source was not healthy at the candidate trigger.";
  } else if (!ledger || ledger.storageStatus !== "ok") {
    reason ??= ledger?.reason ?? "Persistent publication storage did not complete successfully.";
  } else if (duplicate === true) {
    outcome = "duplicate";
  } else if (decision?.decision === "WOULD_PUBLISH" && ledger.recordPersisted && ledger.approvalStatus === "pending") {
    outcome = "candidate_persisted";
  } else if (decision?.decision === "HOLD" && ledger.recordPersisted) {
    outcome = "held";
  } else {
    reason ??= "The existing pipeline did not persist a safe pending candidate or a blocking HOLD record.";
  }

  return {
    mode: "ankara", outcome, runStartedAt: input.runStartedAt, runEndedAt: input.runEndedAt,
    ...scheduleTelemetry,
    sourceHealth: sourceHealth ?? null, candidateFound,
    publicationId,
    decision: decision?.decision ?? null,
    approvalStatus: result?.status === "message_preview_ready" && ledger?.approvalStatus === "pending" ? "pending" : null,
    locationLabel: typeof normalized.displayLabel === "string" ? normalized.displayLabel : null,
    enrichmentStatus: typeof enrichment.status === "string" ? enrichment.status : null,
    messageText: result?.message?.ok ? result.message.text : null,
    duplicate,
    historyOutcome: ledger?.duplicateMatch?.duplicate ? "duplicate_match" :
      ledger?.historyChecked ? "checked_no_duplicate" : ledger ? ledger.storageStatus : "not_checked",
    xweatherRequestAttempted: result?.providerCalls.xweatherRequestAttempted ?? null,
    xweatherRequestCount: result?.providerCalls.xweatherEnrichmentCalls ?? null,
    reason,
  };
}

function runPipeline(env: NodeJS.ProcessEnv): Promise<number> {
  return new Promise(resolveCode => {
    const child = spawn(process.execPath, monitorRunnerArgs, { env, stdio: "inherit" });
    child.once("error", () => resolveCode(1));
    child.once("close", code => resolveCode(code ?? 1));
  });
}

const artifacts = [
  "artifacts/lightning-end-to-end-dry-run-result.json",
  "artifacts/lightning-cg-paired-result.json",
  "artifacts/lightning-cg-paired-live-run.jsonl",
];
const resultPath = "artifacts/lightning-ankara-monitor-result.json";

export async function runMonitor(options: {
  env?: MonitorEnv;
  now?: Clock;
  execute?: (env: NodeJS.ProcessEnv) => Promise<number>;
} = {}): Promise<MonitorResult> {
  const env = options.env ?? process.env;
  const now = options.now ?? (() => new Date().toISOString());
  const runStartedAt = now();
  const scheduleExpression = await readScheduleExpression(env);
  await mkdir("artifacts", { recursive: true });
  let pipeline: DryRunResult | null = null;
  let pipelineExitCode = 1;
  let reason: string | null = missingConfiguration(env);

  if (!reason) {
    await Promise.all(artifacts.map(path => unlink(path).catch(() => undefined)));
    try {
      pipelineExitCode = await (options.execute ?? runPipeline)(pipelineEnvironment(env));
      pipeline = JSON.parse(await readFile(artifacts[0], "utf8")) as DryRunResult;
    } catch {
      reason = "The existing end-to-end runner failed or produced no readable result.";
    }
  }
  const sourceHealthLog = await readFile(artifacts[2], "utf8").catch(() => "");
  const result = buildMonitorResult({ pipeline, pipelineExitCode, runStartedAt, runEndedAt: now(),
    githubEventName: env.GITHUB_EVENT_NAME, githubRunId: env.GITHUB_RUN_ID,
    githubRunAttempt: env.GITHUB_RUN_ATTEMPT, scheduleExpression, sourceHealthLog, reason });
  await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
  return result;
}

export function monitorExitCode(outcome: MonitorOutcome): number {
  return outcome === "operational_failure" ? 1 : 0;
}

export async function main(): Promise<void> {
  const result = await runMonitor();
  console.log(`Ankara monitor outcome: ${result.outcome}. Result: ${resultPath}`);
  if (monitorExitCode(result.outcome)) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch(() => { console.error("Could not write Ankara monitor result."); process.exitCode = 1; });
}
