import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fingerprintMessage } from "../lightning-publication-ledger/record.ts";
import { publishApproved, type PublishRow, type PublisherStore } from "./publisher.ts";
import { renderPublisherSummary } from "./summary.ts";
import type { XPostResult } from "./x-adapter.ts";

const id = "pub_" + "a".repeat(32);
const text = "#YILDIRIM\n8 Ekim 2026, 16:31 TSİ\nAşağı Ayrancı / Çankaya civarında yere ulaşan yıldırım kaydedildi.\n\n39.901, 32.859";
const attemptId = "12345678-1234-4123-8123-123456789abc";
function candidate(patch: Partial<PublishRow> = {}): PublishRow {
  return { publicationId: id, enrichmentStatus: "cg_verified", decision: "WOULD_PUBLISH", approvalStatus: "approved",
    platformPostId: null, messageText: text, messageFingerprint: fingerprintMessage(text),
    publishAttemptId: null, publishedAt: null, ...patch };
}
function harness(initial = candidate(), xResult: XPostResult = { outcome: "confirmed_success", postId: "987654321" }) {
  let row: PublishRow = initial;
  let xCalls = 0;
  let claims = 0;
  const store: PublisherStore = {
    async get() { return { ...row }; },
    async claim(expected, token) {
      claims++;
      if (row.decision !== "WOULD_PUBLISH" || row.approvalStatus !== "approved" ||
          row.platformPostId !== null || row.publishAttemptId !== null ||
          row.messageFingerprint !== expected.messageFingerprint) return null;
      row = { ...row, publishAttemptId: token };
      return { ...row };
    },
    async finalize(publicationId, token, postId, publishedAt) {
      if (publicationId !== id || row.decision !== "WOULD_PUBLISH" ||
          row.approvalStatus !== "approved" || row.platformPostId !== null ||
          row.publishAttemptId !== token) return null;
      row = { ...row, decision: "PUBLISHED", platformPostId: postId, publishedAt };
      return { ...row };
    },
  };
  const x = { async createPost(value: string) { xCalls++; assert.equal(value, initial.messageText); return xResult; } };
  const run = (options: Partial<{ enabled: boolean; credentialsPresent: boolean }> = {}) =>
    publishApproved(id, store, x, { enabled: true, credentialsPresent: true,
      attemptId: () => attemptId, now: () => "2026-10-08T18:00:00.000Z", ...options });
  return { store, x, run, get row() { return row; }, get xCalls() { return xCalls; }, get claims() { return claims; },
    setRow(value: PublishRow) { row = value; } };
}

test("approved persisted text posts once, stores ID and timestamp, and rerun is idempotent", async () => {
  const h = harness();
  const first = await h.run();
  assert.equal(first.outcome, "published");
  assert.equal(first.postId, "987654321");
  assert.equal(h.row.decision, "PUBLISHED");
  assert.equal(h.row.platformPostId, "987654321");
  assert.equal(h.row.publishedAt, "2026-10-08T18:00:00.000Z");
  assert.equal(h.xCalls, 1);
  const second = await h.run();
  assert.equal(second.outcome, "already_published");
  assert.equal(h.xCalls, 1);
  assert.equal(h.claims, 1);
});

test("pending, skipped, HOLD, legacy null approval, missing text, and fingerprint mismatch reject before X", async () => {
  for (const patch of [
    { approvalStatus: "pending" }, { approvalStatus: "skipped" }, { approvalStatus: null },
    { decision: "HOLD" }, { messageText: null }, { messageText: "" },
    { messageFingerprint: "sha256:" + "0".repeat(64) },
    { platformPostId: "123" },
    { publishedAt: "2026-10-08T18:00:00Z" },
  ] as Partial<PublishRow>[]) {
    const h = harness(candidate(patch));
    assert.equal((await h.run()).outcome, "not_eligible");
    assert.equal(h.claims, 0);
    assert.equal(h.xCalls, 0);
  }
});

test("legacy URL text and non-CG coordinate text are rejected despite matching fingerprints", async () => {
  const legacy = text + "\nhttps://www.google.com/maps?q=39.901,32.859";
  const nonCg = "#ŞİMŞEK\n8 Ekim 2026, 16:31 TSİ\nAşağı Ayrancı / Çankaya civarında şimşek kaydedildi.\n\n39.901, 32.859";
  for (const [value, enrichmentStatus] of [[legacy, "cg_verified"], [nonCg, "ic_only"]] as const) {
    const h = harness(candidate({ messageText: value, messageFingerprint: fingerprintMessage(value), enrichmentStatus }));
    assert.equal((await h.run()).outcome, "not_eligible");
    assert.equal(h.xCalls, 0);
  }
});

test("non-CG persisted composer text is passed unchanged and remains URL-free", async () => {
  const value = "#ŞİMŞEK\n8 Ekim 2026, 16:31 TSİ\nAşağı Ayrancı / Çankaya civarında şimşek kaydedildi.";
  const h = harness(candidate({ messageText: value, messageFingerprint: fingerprintMessage(value), enrichmentStatus: "ic_only" }));
  assert.equal((await h.run()).outcome, "published");
  assert.equal(h.xCalls, 1);
});

test("kill switch and missing credentials perform zero claims or X calls", async () => {
  for (const options of [{ enabled: false }, { credentialsPresent: false }]) {
    const h = harness();
    assert.equal((await h.run(options)).outcome, options.enabled === false ? "disabled" : "missing_credentials");
    assert.equal(h.claims, 0);
    assert.equal(h.xCalls, 0);
  }
});

test("ambiguous X outcome keeps the claim and blocks a blind later retry", async () => {
  const h = harness(candidate(), { outcome: "publication_uncertain", reason: "transport" });
  assert.equal((await h.run()).outcome, "publication_uncertain");
  assert.equal(h.row.publishAttemptId, attemptId);
  assert.equal(h.row.decision, "WOULD_PUBLISH");
  assert.equal((await h.run()).outcome, "publication_uncertain");
  assert.equal(h.xCalls, 1);
});

test("definite 4xx remains distinct and reserved for deliberate operator action", async () => {
  const h = harness(candidate(), { outcome: "definite_failure", status: 403 });
  assert.equal((await h.run()).outcome, "definite_failure");
  assert.equal((await h.run()).outcome, "publication_uncertain");
  assert.equal(h.xCalls, 1);
});

test("confirmed X success and failed ledger finalization exposes post ID without resending", async () => {
  const h = harness();
  h.store.finalize = async () => { throw new Error("database down"); };
  const first = await h.run();
  assert.equal(first.outcome, "ledger_update_failed");
  assert.equal(first.reason, "X post created, ledger update failed — manual reconciliation required");
  assert.equal(first.postId, "987654321");
  assert.match(renderPublisherSummary(first), /X post ID: 987654321/);
  assert.match(renderPublisherSummary(first), /Manual reconciliation required/);
  assert.equal(h.row.publishAttemptId, attemptId);
  assert.equal((await h.run()).outcome, "publication_uncertain");
  assert.equal(h.xCalls, 1);
});

test("Postgres timestamp normalization still counts as a confirmed ledger update", async () => {
  const h = harness();
  h.store.finalize = async (publicationId, token, postId) => ({
    ...h.row, publicationId, publishAttemptId: token, decision: "PUBLISHED",
    platformPostId: postId, publishedAt: "2026-10-08T18:00:00+00:00",
  });
  assert.equal((await h.run()).outcome, "published");
  assert.equal(h.xCalls, 1);
});

test("changed final row is rejected by conditional transition, preserving returned X ID", async () => {
  const h = harness();
  h.store.finalize = async () => null;
  const result = await h.run();
  assert.equal(result.outcome, "ledger_update_failed");
  assert.equal(result.postId, "987654321");
  assert.equal(h.xCalls, 1);
});

test("racing claim and changed text after claim cannot send X", async () => {
  const h = harness();
  h.store.claim = async () => null;
  assert.equal((await h.run()).outcome, "transition_conflict");
  assert.equal(h.xCalls, 0);
  const altered = harness();
  altered.store.claim = async (row, token) => ({ ...row, publishAttemptId: token, messageText: "changed" });
  assert.equal((await altered.run()).outcome, "publication_uncertain");
  assert.equal(altered.xCalls, 0);
});

test("workflow is manual-only; existing E2E and approval workflows contain no X publisher", async () => {
  const workflow = await readFile(".github/workflows/research-lightning-x-publisher.yml", "utf8");
  assert.match(workflow, /name: Research Lightning X Publisher/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.doesNotMatch(workflow, /^\s*(schedule|push|workflow_run):/m);
  assert.match(workflow, /vars\.X_PUBLISHING_ENABLED/);
  for (const path of [".github/workflows/research-lightning-end-to-end-dry-run.yml",
    ".github/workflows/research-lightning-manual-approval.yml"]) {
    const existing = await readFile(path, "utf8");
    assert.doesNotMatch(existing, /lightning-x-publisher|X_API_KEY|api\.x\.com\/2\/tweets/);
  }
});
