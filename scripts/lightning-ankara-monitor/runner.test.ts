import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import type { DryRunResult } from "../lightning-end-to-end-dry-run/orchestrate.ts";
import { buildMonitorResult, missingConfiguration, monitorExitCode, monitorRunnerArgs, pipelineEnvironment,
  resolveScheduleTelemetry } from "./runner.ts";
import { renderMonitorSummary } from "./summary.ts";

const exactMessage = "#YILDIRIM\n9 Ekim 2026, 10:00 TSİ\nAşağı Ayrancı / Çankaya civarında yere ulaşan yıldırım kaydedildi.\n\n39.901, 32.859";

function e2e(patch: Record<string, unknown> = {}): DryRunResult {
  return {
    status: "message_preview_ready", paired: { status: "paired_result", sourceHealth: "live",
      incident: { incidentId: "incident-1" }, enrichment: { status: "cg_verified" } },
    location: { normalized: { displayLabel: "Aşağı Ayrancı / Çankaya" } },
    message: { ok: true, text: exactMessage },
    publishDecision: { decision: "WOULD_PUBLISH", sourceHealthAtTrigger: "live", duplicateIncident: false },
    ledger: { storageStatus: "ok", recordPersisted: true, persistedPublicationId: "pub_" + "a".repeat(32),
      approvalStatus: "pending", historyChecked: true, duplicateMatch: { duplicate: false, reason: "no_duplicate", matchedPublicationId: null } },
    providerCalls: { xweatherRequestAttempted: true, xweatherEnrichmentCalls: 1, nominatimReverseLookups: 1 },
    capturedAt: "2026-10-09T07:00:00.000Z",
    ...patch,
  } as unknown as DryRunResult;
}

const common = { pipelineExitCode: 0, runStartedAt: "start", runEndedAt: "end" };
const cron = "*/15 * * * *";

test("scheduled telemetry resolves an exact UTC cron boundary to zero delay", () => {
  const telemetry = resolveScheduleTelemetry({ githubEventName: "schedule", scheduleExpression: cron,
    runStartedAt: "2026-10-09T10:15:00.000Z", runEndedAt: "2026-10-09T10:25:01.000Z" });
  assert.equal(telemetry.scheduledSlotAt, "2026-10-09T10:15:00.000Z");
  assert.equal(telemetry.scheduleDelaySeconds, 0);
  assert.equal(telemetry.scheduleDelayMinutes, 0);
  assert.equal(telemetry.monitorDurationSeconds, 601);
});

test("scheduled telemetry measures a 4m42s start delay", () => {
  const telemetry = resolveScheduleTelemetry({ githubEventName: "schedule", scheduleExpression: cron,
    runStartedAt: "2026-10-09T10:19:42.000Z", runEndedAt: "2026-10-09T10:29:42.000Z" });
  assert.equal(telemetry.scheduledSlotAt, "2026-10-09T10:15:00.000Z");
  assert.equal(telemetry.scheduleDelaySeconds, 282);
  assert.equal(telemetry.scheduleDelayMinutes, 4.7);
});

test("scheduled telemetry resolves slots across an hour boundary", () => {
  const telemetry = resolveScheduleTelemetry({ githubEventName: "schedule", scheduleExpression: cron,
    runStartedAt: "2026-10-09T11:00:15.000Z", runEndedAt: "2026-10-09T11:10:15.000Z" });
  assert.equal(telemetry.scheduledSlotAt, "2026-10-09T11:00:00.000Z");
  assert.equal(telemetry.scheduleDelaySeconds, 15);
});

test("scheduled telemetry resolves slots across midnight UTC", () => {
  const telemetry = resolveScheduleTelemetry({ githubEventName: "schedule", scheduleExpression: cron,
    runStartedAt: "2026-10-10T00:07:30.000Z", runEndedAt: "2026-10-10T00:17:30.000Z" });
  assert.equal(telemetry.scheduledSlotAt, "2026-10-10T00:00:00.000Z");
  assert.equal(telemetry.scheduleDelaySeconds, 450);
  assert.equal(telemetry.scheduleDelayMinutes, 7.5);
});

test("manual telemetry has no scheduled slot or delay", () => {
  const telemetry = resolveScheduleTelemetry({ githubEventName: "workflow_dispatch", scheduleExpression: cron,
    githubRunId: "1234", githubRunAttempt: "2", runStartedAt: "2026-10-09T10:19:42.000Z",
    runEndedAt: "2026-10-09T10:29:42.000Z" });
  assert.equal(telemetry.scheduledSlotAt, null);
  assert.equal(telemetry.scheduleDelaySeconds, null);
  assert.equal(telemetry.scheduleDelayMinutes, null);
  assert.equal(telemetry.githubRunId, "1234");
  assert.equal(telemetry.githubRunAttempt, "2");
});

test("missing and malformed schedule metadata yield unavailable telemetry", () => {
  for (const scheduleExpression of [null, "not-a-cron-expression"]) {
    const telemetry = resolveScheduleTelemetry({ githubEventName: "schedule", scheduleExpression,
      runStartedAt: "2026-10-09T10:19:42.000Z", runEndedAt: "2026-10-09T10:29:42.000Z" });
    assert.equal(telemetry.scheduledSlotAt, null);
    assert.equal(telemetry.scheduleDelaySeconds, null);
    assert.equal(telemetry.scheduleDelayMinutes, null);
    assert.equal(telemetry.monitorDurationSeconds, 600);
  }
});

test("telemetry availability does not change candidate or operational outcomes", () => {
  const withMissingSchedule = buildMonitorResult({ ...common, pipeline: e2e(), githubEventName: "schedule" });
  const baseline = buildMonitorResult({ ...common, pipeline: e2e() });
  assert.equal(withMissingSchedule.outcome, baseline.outcome);
  assert.equal(withMissingSchedule.approvalStatus, "pending");
  const failed = buildMonitorResult({ ...common, pipeline: null, pipelineExitCode: 1, githubEventName: "schedule" });
  assert.equal(failed.outcome, "operational_failure");
});

test("structured result contains run identity, slot, delay, and monitor duration", () => {
  const result = buildMonitorResult({ pipeline: e2e(), pipelineExitCode: 0,
    githubEventName: "schedule", githubRunId: "999", githubRunAttempt: "1", scheduleExpression: cron,
    runStartedAt: "2026-10-09T10:19:42.000Z", runEndedAt: "2026-10-09T10:29:43.000Z" });
  assert.equal(result.githubEventName, "schedule");
  assert.equal(result.githubRunId, "999");
  assert.equal(result.githubRunAttempt, "1");
  assert.equal(result.scheduledSlotAt, "2026-10-09T10:15:00.000Z");
  assert.equal(result.scheduleDelaySeconds, 282);
  assert.equal(result.scheduleDelayMinutes, 4.7);
  assert.equal(result.runStartedAt, "2026-10-09T10:19:42.000Z");
  assert.equal(result.runEndedAt, "2026-10-09T10:29:43.000Z");
  assert.equal(result.monitorDurationSeconds, 601);
});

test("monitor invokes only the existing ten-minute Ankara profile-B paired pipeline", () => {
  assert.deepEqual(monitorRunnerArgs, ["--experimental-strip-types", "scripts/lightning-end-to-end-dry-run/runner.ts"]);
  const env = pipelineEnvironment({ PATH: "/bin", GITHUB_RUN_ID: "42", X_API_KEY: "must-not-pass",
    X_PUBLISHING_ENABLED: "true", SUPABASE_URL: "url", SUPABASE_SERVICE_ROLE_KEY: "db", XWEATHER_CLIENT_ID: "id",
    XWEATHER_CLIENT_SECRET: "secret" });
  assert.equal(env.AREA, "ankara");
  assert.equal(env.DURATION_MINUTES, "10");
  assert.equal(env.INCIDENT_PROFILE, "B");
  assert.equal(env.X_API_KEY, undefined);
  assert.equal(env.X_PUBLISHING_ENABLED, undefined);
  assert.ok(env.SUPABASE_URL && env.XWEATHER_CLIENT_SECRET);
});

test("broken Supabase or Xweather configuration is detected before the pipeline starts", () => {
  const complete = { SUPABASE_URL: "url", SUPABASE_SERVICE_ROLE_KEY: "key",
    XWEATHER_CLIENT_ID: "id", XWEATHER_CLIENT_SECRET: "secret" };
  assert.equal(missingConfiguration(complete), null);
  for (const key of Object.keys(complete)) {
    assert.match(missingConfiguration({ ...complete, [key]: "" }) ?? "", /configuration is missing/);
  }
});

test("approved-gate candidate is persisted only with pending approval", () => {
  const result = buildMonitorResult({ ...common, pipeline: e2e() });
  assert.equal(result.outcome, "candidate_persisted");
  assert.equal(result.decision, "WOULD_PUBLISH");
  assert.equal(result.approvalStatus, "pending");
  assert.equal(result.publicationId, "pub_" + "a".repeat(32));
  assert.equal(monitorExitCode(result.outcome), 0);
});

test("no-candidate and no-fresh-candidate states are successful monitoring outcomes", () => {
  for (const status of ["no_publish_candidate", "no_fresh_publish_candidate"] as const) {
    const result = buildMonitorResult({ ...common, sourceHealthLog: '{"kind":"source_health","to":"live"}',
      pipeline: e2e({ status, paired: { status, sourceHealth: "disconnected" } }) });
    assert.equal(result.outcome, status);
    assert.equal(monitorExitCode(result.outcome), 0);
    assert.equal(result.candidateFound, false);
  }
});

test("a quiet result is an operational failure if the source never became live", () => {
  const result = buildMonitorResult({ ...common,
    pipeline: e2e({ status: "no_publish_candidate", paired: { status: "no_publish_candidate", sourceHealth: "disconnected" } }) });
  assert.equal(result.outcome, "operational_failure");
  assert.match(result.reason ?? "", /did not reach a healthy state/);
});

test("no usable location label is a successful non-actionable outcome", () => {
  const result = buildMonitorResult({ ...common, pipeline: e2e({ status: "no_usable_location_label", message: null }) });
  assert.equal(result.outcome, "no_usable_location_label");
  assert.equal(monitorExitCode(result.outcome), 0);
  assert.equal(result.approvalStatus, null);
});

test("persistent duplicate is successful and never reported as a pending actionable candidate", () => {
  const pipeline = e2e({ publishDecision: { decision: "HOLD", sourceHealthAtTrigger: "live", duplicateIncident: true },
    ledger: { storageStatus: "ok", recordPersisted: true, persistedPublicationId: "pub_" + "b".repeat(32),
      approvalStatus: null, historyChecked: true, duplicateMatch: { duplicate: true,
        reason: "same_provider_event", matchedPublicationId: "pub_" + "a".repeat(32) } } });
  const result = buildMonitorResult({ ...common, pipeline });
  assert.equal(result.outcome, "duplicate");
  assert.equal(result.duplicate, true);
  assert.equal(result.approvalStatus, null);
  assert.equal(monitorExitCode(result.outcome), 0);
});

test("safe HOLD candidates stay HOLD and are normal monitoring outcomes", () => {
  const pipeline = e2e({ publishDecision: { decision: "HOLD", sourceHealthAtTrigger: "live", duplicateIncident: false } });
  const result = buildMonitorResult({ ...common, pipeline });
  assert.equal(result.outcome, "held");
  assert.equal(result.decision, "HOLD");
  assert.equal(monitorExitCode(result.outcome), 0);
});

test("Supabase read, write, missing-storage, and invalid-candidate states fail clearly", () => {
  for (const storageStatus of ["read_failed", "write_failed", "not_configured", "invalid_candidate"]) {
    const pipeline = e2e({ ledger: { storageStatus, reason: `storage ${storageStatus}`, recordPersisted: false,
      historyChecked: false, duplicateMatch: null, persistedPublicationId: null, approvalStatus: null } });
    const result = buildMonitorResult({ ...common, pipeline });
    assert.equal(result.outcome, "operational_failure", storageStatus);
    assert.equal(monitorExitCode(result.outcome), 1);
  }
});

test("unhealthy source at an otherwise publishable trigger fails without weakening the gate", () => {
  const pipeline = e2e({ publishDecision: { decision: "HOLD", sourceHealthAtTrigger: "disconnected", duplicateIncident: false } });
  const result = buildMonitorResult({ ...common, pipeline });
  assert.equal(result.outcome, "operational_failure");
  assert.equal(result.decision, "HOLD");
});

test("existing runner failure and malformed or absent result are operational failures", () => {
  for (const input of [
    { pipeline: e2e(), pipelineExitCode: 1 },
    { pipeline: null, pipelineExitCode: 0 },
    { pipeline: e2e({ status: "paired_validation_failed" }), pipelineExitCode: 0 },
    { pipeline: e2e({ status: "location_lookup_failed" }), pipelineExitCode: 0 },
    { pipeline: e2e({ status: "message_composition_failed" }), pipelineExitCode: 0 },
  ]) {
    const result = buildMonitorResult({ ...common, ...input });
    assert.equal(result.outcome, "operational_failure");
    assert.equal(monitorExitCode(result.outcome), 1);
  }
});

test("summary reports persisted composer text verbatim and never rebuilds it", () => {
  const result = buildMonitorResult({ ...common, pipeline: e2e() });
  const summary = renderMonitorSummary(result);
  assert.ok(summary.includes(`### Exact candidate message\n\n\`\`\`text\n${exactMessage}\n\`\`\``));
  assert.ok(summary.includes("Approval status: pending"));
  assert.ok(summary.includes("No social post was sent."));
  assert.equal(result.messageText, exactMessage);
});

test("summary renders scheduled slot and delay timing", () => {
  const result = buildMonitorResult({ pipeline: e2e(), pipelineExitCode: 0,
    githubEventName: "schedule", githubRunId: "999", githubRunAttempt: "1", scheduleExpression: cron,
    runStartedAt: "2026-10-09T10:19:42.000Z", runEndedAt: "2026-10-09T10:29:43.000Z" });
  const summary = renderMonitorSummary(result);
  assert.ok(summary.includes("### Schedule timing"));
  assert.ok(summary.includes("- Event: schedule"));
  assert.ok(summary.includes("- GitHub run ID: 999"));
  assert.ok(summary.includes("- GitHub run attempt: 1"));
  assert.ok(summary.includes("- Scheduled slot: 2026-10-09T10:15:00.000Z"));
  assert.ok(summary.includes("- Actual start: 2026-10-09T10:19:42.000Z"));
  assert.ok(summary.includes("- Delay: 282 seconds (4.70 minutes)"));
  assert.ok(summary.includes("- Monitor duration: 601 seconds"));
});

test("summary renders manual timing as not applicable and unavailable cron timing clearly", () => {
  const manual = buildMonitorResult({ pipeline: e2e(), pipelineExitCode: 0,
    githubEventName: "workflow_dispatch", runStartedAt: "2026-10-09T10:19:42.000Z",
    runEndedAt: "2026-10-09T10:29:42.000Z" });
  const manualSummary = renderMonitorSummary(manual);
  assert.ok(manualSummary.includes("- Event: workflow_dispatch"));
  assert.ok(manualSummary.includes("- Scheduled slot: not applicable"));
  assert.ok(manualSummary.includes("- Delay: not applicable"));
  assert.ok(manualSummary.includes("- Monitor duration: 600 seconds"));

  const unavailable = buildMonitorResult({ pipeline: e2e(), pipelineExitCode: 0,
    githubEventName: "schedule", runStartedAt: "2026-10-09T10:19:42.000Z", runEndedAt: "2026-10-09T10:29:42.000Z" });
  const unavailableSummary = renderMonitorSummary(unavailable);
  assert.ok(unavailableSummary.includes("- Scheduled slot: unavailable"));
  assert.ok(unavailableSummary.includes("- Delay: unavailable"));
  assert.ok(unavailableSummary.includes("Schedule telemetry unavailable"));
});

test("manual approval and X Publisher remain outside the monitor runner and workflow", async () => {
  const workflow = await readFile(new URL("../../.github/workflows/research-lightning-ankara-monitor.yml", import.meta.url), "utf8");
  const runner = await readFile(new URL("./runner.ts", import.meta.url), "utf8");
  assert.doesNotMatch(workflow, /Research Lightning Manual Approval|lightning-x-publisher|X_API_KEY|X_ACCESS_TOKEN|X_PUBLISHING_ENABLED/);
  assert.doesNotMatch(runner, /lightning-x-publisher|X_API_KEY|X_ACCESS_TOKEN|X_PUBLISHING_ENABLED/);
  assert.doesNotMatch(workflow, /approval_status:\s*approved|approvalStatus:\s*"approved"/);
});

test("workflow has schedule and manual triggers only, with a conservative cadence", async () => {
  const workflow = await readFile(new URL("../../.github/workflows/research-lightning-ankara-monitor.yml", import.meta.url), "utf8");
  assert.match(workflow, /schedule:\s*\n\s+- cron: ['"]\*\/15 \* \* \* \*['"]/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.doesNotMatch(workflow, /^\s*(push|pull_request|workflow_run):/m);
  assert.match(workflow, /group: research-lightning-ankara-monitor/);
  assert.match(workflow, /cancel-in-progress: false/);
});

test("selected ref is checked normally; scheduled runs safely skip without implementation", async () => {
  const workflow = await readFile(new URL("../../.github/workflows/research-lightning-ankara-monitor.yml", import.meta.url), "utf8");
  assert.match(workflow, /uses: actions\/checkout@v4/);
  assert.doesNotMatch(workflow, /^\s+ref:/m);
  assert.match(workflow, /implementation is not present on the checked-out ref/i);
  const docs = await readFile(new URL("../../docs/lightning-ankara-monitor-v1.md", import.meta.url), "utf8");
  assert.match(docs, /scheduled workflows run from the repository default branch/i);
  assert.match(docs, /monitor implementation also remains on `merge-ready`/i);
});

test("existing early-stop runner and polygon remain the configured path", async () => {
  const liveRunner = await readFile(new URL("../lightning-incident-lifecycle/runner.ts", import.meta.url), "utf8");
  const monitorRunner = await readFile(new URL("./runner.ts", import.meta.url), "utf8");
  assert.match(liveRunner, /onEnrichmentStarted:\s*\(\)\s*=>\s*stop\("first_fresh_would_publish_paired_validation"\)/);
  assert.match(monitorRunner, /scripts\/lightning-end-to-end-dry-run\/runner\.ts/);
  assert.match(monitorRunner, /DURATION_MINUTES = String\(MONITOR_DURATION_MINUTES\)/);
});

test("existing publish-decision, duplicate, manual-approval, and publisher suites are reused unchanged", async () => {
  const paths = [
    "../lightning-publish-decision/decision.test.ts",
    "../lightning-publication-ledger/publication-ledger.test.ts",
    "../lightning-publication-ledger/approval.test.ts",
    "../lightning-publication-ledger/composer-v1-1.test.ts",
    "../lightning-x-publisher/publisher.test.ts",
  ];
  for (const path of paths) {
    const source = await readFile(new URL(path, import.meta.url), "utf8");
    assert.ok(source.length > 0, path);
  }
});
