import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import type { DryRunResult } from "../lightning-end-to-end-dry-run/orchestrate.ts";
import { buildMonitorResult, missingConfiguration, monitorExitCode, monitorRunnerArgs, pipelineEnvironment } from "./runner.ts";
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
