import assert from "node:assert/strict";
import test from "node:test";
import { autoPublishNewPending, createFlyAutoPublish, type FlyAutoPublish } from "./auto-publish.ts";
import type { ApprovalCandidate, ApprovalStore } from "../lightning-publication-ledger/approval.ts";
import { fingerprintMessage } from "../lightning-publication-ledger/record.ts";

const id = `pub_${"a".repeat(32)}`;
const text = "#ŞİMŞEK\nFixture only";
const row: ApprovalCandidate = { publicationId: id, decision: "WOULD_PUBLISH", platformPostId: null,
  approvalStatus: "pending", messageText: text, messageFingerprint: fingerprintMessage(text) };
const token = `github_pat_${"fixture_only_".repeat(3)}`;
const environment = { LIGHTNING_AUTO_PUBLISH_ENABLED: "true", GITHUB_ACTIONS_DISPATCH_TOKEN: token,
  SUPABASE_URL: "https://fixture.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "fixture-service-key" };

function fixture(initial: ApprovalCandidate | null = row) {
  let state = initial && { ...initial };
  const events: Array<{ kind: string; fields?: Record<string, unknown> }> = [];
  let transitions = 0;
  let dispatches = 0;
  const store: ApprovalStore = {
    async getPublicationForApproval() { return state && { ...state }; },
    async transitionPendingApproval(publicationId, status, actor, updatedAt) {
      assert.equal(publicationId, id);
      assert.equal(actor, "fly:guarded-auto-publish");
      assert.equal(updatedAt, "2026-10-10T10:00:00.000Z");
      if (state?.approvalStatus !== "pending") return null;
      transitions++;
      state = { ...state, approvalStatus: status };
      return { ...state };
    },
  };
  const configuration: FlyAutoPublish = { approvalStore: store, dispatchPublisher: async publicationId => {
    assert.equal(publicationId, id);
    assert.equal(state?.approvalStatus, "approved");
    dispatches++;
    return { ok: true, httpStatus: 204 };
  } };
  const emit = (kind: string, fields?: Record<string, unknown>) => events.push({ kind, fields });
  const run = (config: FlyAutoPublish | undefined = configuration) =>
    autoPublishNewPending(id, "incident-1", config, emit, () => Date.parse("2026-10-10T10:00:00Z"));
  return { configuration, events, emit, run, get state() { return state; },
    get transitions() { return transitions; }, get dispatches() { return dispatches; } };
}

test("disabled orchestration leaves pending unchanged, with no approval or dispatch", async () => {
  const f = fixture();
  await autoPublishNewPending(id, "incident-1", undefined, f.emit, Date.now);
  assert.equal(f.state?.approvalStatus, "pending");
  assert.equal(f.transitions, 0);
  assert.equal(f.dispatches, 0);
  assert.deepEqual(f.events, [{ kind: "auto_publish_disabled", fields: {
    publicationId: id, incidentId: "incident-1", reason: "disabled_or_unconfigured" } }]);
});

test("automatic approval reuses pending transition and reruns never dispatch again", async () => {
  const f = fixture();
  await f.run();
  await f.run();
  assert.equal(f.state?.approvalStatus, "approved");
  assert.equal(f.transitions, 1);
  assert.equal(f.dispatches, 1);
  assert.deepEqual(f.events.map(event => event.kind), ["auto_approval_succeeded",
    "auto_publish_dispatch_sent", "auto_approval_failed"]);
  assert.equal(f.events.at(-1)?.fields?.reason, "already_approved");
});

test("non-pending, published, HOLD, corrupt, missing records never dispatch", async () => {
  for (const initial of [null, { ...row, approvalStatus: "skipped" }, { ...row, approvalStatus: "approved" },
    { ...row, decision: "PUBLISHED", platformPostId: "123" }, { ...row, decision: "HOLD" },
    { ...row, messageFingerprint: "bad" }] as Array<ApprovalCandidate | null>) {
    const f = fixture(initial);
    await f.run();
    assert.equal(f.transitions, 0);
    assert.equal(f.dispatches, 0);
    assert.equal(f.events[0].kind, "auto_approval_failed");
    assert.deepEqual(f.state, initial);
  }
});

test("a concurrent human decision winning the conditional update never authorizes auto dispatch", async () => {
  for (const status of ["approved", "skipped"] as const) {
    const f = fixture();
    let reads = 0;
    f.configuration.approvalStore = {
      async getPublicationForApproval() { return { ...row, approvalStatus: ++reads === 1 ? "pending" : status }; },
      async transitionPendingApproval() { return null; },
    };
    await f.run();
    assert.equal(f.dispatches, 0);
    assert.equal(f.events[0].kind, "auto_approval_failed");
    assert.equal(f.events[0].fields?.reason, status === "approved" ? "already_approved" : "transition_conflict");
  }
});

test("approval storage exceptions are sanitized and prevent dispatch", async () => {
  for (const stage of ["read", "transition"] as const) {
    const f = fixture();
    if (stage === "read") f.configuration.approvalStore.getPublicationForApproval = async () => { throw new Error(token); };
    else f.configuration.approvalStore.transitionPendingApproval = async () => { throw new Error(token); };
    await f.run();
    assert.equal(f.dispatches, 0);
    assert.equal(f.state?.approvalStatus, "pending");
    assert.equal(f.events[0].kind, "auto_approval_failed");
    assert.equal(f.events[0].fields?.reason, "storage_error");
    assert.doesNotMatch(JSON.stringify(f.events), /github_pat_|Authorization/);
  }
});

test("failed or throwing dispatch retains approved state and does not retry", async () => {
  for (const throws of [false, true]) {
    const f = fixture();
    let calls = 0;
    f.configuration.dispatchPublisher = async () => {
      calls++;
      if (throws) throw new Error(token);
      return { ok: false, reason: "http_error", httpStatus: 403 };
    };
    await f.run();
    assert.equal(f.state?.approvalStatus, "approved");
    assert.equal(f.transitions, 1);
    assert.equal(calls, 1);
    assert.deepEqual(f.events.map(event => event.kind), ["auto_approval_succeeded", "auto_publish_dispatch_failed"]);
    assert.doesNotMatch(JSON.stringify(f.events), /github_pat_|Authorization/);
  }
});

test("only exact true enables auto mode; an optional invalid token warns once and disables approval", () => {
  const f = fixture();
  const neverFetch: typeof fetch = async () => { throw new Error("unexpected live request"); };
  for (const value of [undefined, "", "false", "TRUE", "1", " true", "true "]) {
    assert.equal(createFlyAutoPublish({ ...environment, LIGHTNING_AUTO_PUBLISH_ENABLED: value,
      GITHUB_ACTIONS_DISPATCH_TOKEN: undefined }, f.emit, neverFetch), undefined);
  }
  assert.equal(f.events.length, 0);
  for (const value of [undefined, "malformed", `${token}\n`]) {
    const before: number = f.events.length;
    assert.equal(createFlyAutoPublish({ ...environment, GITHUB_ACTIONS_DISPATCH_TOKEN: value }, f.emit, neverFetch), undefined);
    assert.equal(f.events.length, before + 1);
    assert.deepEqual(f.events.at(-1), { kind: "configuration_warning", fields: {
      capability: "autoPublish", disabled: true, invalidSettings: ["GITHUB_ACTIONS_DISPATCH_TOKEN"] } });
  }
  assert.ok(createFlyAutoPublish(environment, f.emit, neverFetch));
  assert.doesNotMatch(JSON.stringify(f.events), /github_pat_|fixture-service-key|Bearer/);
});
