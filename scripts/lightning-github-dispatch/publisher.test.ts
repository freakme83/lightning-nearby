import assert from "node:assert/strict";
import test from "node:test";
import { createPublisherDispatcher, PUBLISHER_DISPATCH_URL } from "./publisher.ts";

const token = `github_pat_${"fixture_only_".repeat(3)}`;
const id = `pub_${"a".repeat(32)}`;

test("dispatch sends exactly one request to the existing publisher, main, and exact publication ID", async () => {
  let calls = 0;
  const { dispatch, invalidSettings } = createPublisherDispatcher({ GITHUB_ACTIONS_DISPATCH_TOKEN: token },
    async (input, init) => {
      calls++;
      assert.equal(String(input), PUBLISHER_DISPATCH_URL);
      assert.equal(new URL(String(input)).pathname,
        "/repos/freakme83/lightning-nearby/actions/workflows/research-lightning-x-publisher.yml/dispatches");
      assert.equal(init?.method, "POST");
      assert.equal(init?.redirect, "error");
      assert.deepEqual(JSON.parse(String(init?.body)), { ref: "main", inputs: { publicationId: id } });
      assert.equal(new Headers(init?.headers).get("Authorization"), `Bearer ${token}`);
      assert.equal(new Headers(init?.headers).get("X-GitHub-Api-Version"), "2022-11-28");
      assert.equal(init?.signal?.aborted, false);
      return new Response(null, { status: 204 });
    });
  assert.deepEqual(invalidSettings, []);
  assert.deepEqual(await dispatch!(id), { ok: true, httpStatus: 204 });
  assert.equal(calls, 1);
});

test("missing/malformed token and invalid publication IDs cannot dispatch or expose configuration", async () => {
  let calls = 0;
  const fetcher: typeof fetch = async () => { calls++; throw new Error(token); };
  for (const value of [undefined, "", "bad", "ghp_classic_token", ` ${token}`, `${token}\n`]) {
    const configuration = createPublisherDispatcher({ GITHUB_ACTIONS_DISPATCH_TOKEN: value }, fetcher);
    assert.equal(configuration.dispatch, null);
    assert.deepEqual(configuration.invalidSettings, ["GITHUB_ACTIONS_DISPATCH_TOKEN"]);
    assert.doesNotMatch(JSON.stringify(configuration), new RegExp(token));
  }
  const valid = createPublisherDispatcher({ GITHUB_ACTIONS_DISPATCH_TOKEN: token }, fetcher);
  assert.deepEqual(await valid.dispatch!("bad/id"), { ok: false, reason: "invalid_publication_id" });
  assert.equal(calls, 0);
});

test("HTTP failures and unexpected success statuses are sanitized, unread, and never retried", async () => {
  for (const status of [200, 201, 202, 301, 400, 401, 403, 404, 408, 422, 429, 500, 503]) {
    let calls = 0;
    const { dispatch } = createPublisherDispatcher({ GITHUB_ACTIONS_DISPATCH_TOKEN: token }, async () => {
      calls++;
      // Throw on body access, to prove it never enters diagnostics.
      return { status, text: () => { throw new Error(token); }, json: () => { throw new Error(token); } } as unknown as Response;
    });
    const result = await dispatch!(id);
    assert.deepEqual(result, { ok: false, reason: "http_error", httpStatus: status });
    assert.doesNotMatch(JSON.stringify(result), /github_pat_|Authorization|Bearer/);
    assert.equal(calls, 1);
  }
});

test("network exception text is discarded and timeout aborts the single request", async () => {
  let calls = 0;
  const network = createPublisherDispatcher({ GITHUB_ACTIONS_DISPATCH_TOKEN: token }, async () => {
    calls++;
    throw new Error(`Authorization: Bearer ${token}`);
  });
  assert.deepEqual(await network.dispatch!(id), { ok: false, reason: "network_error" });
  const timeout = createPublisherDispatcher({ GITHUB_ACTIONS_DISPATCH_TOKEN: token }, async (_input, init) => {
    calls++;
    return new Promise<Response>((_resolve, reject) => {
      init!.signal!.addEventListener("abort", () => reject(new Error(token)), { once: true });
    });
  }, 5);
  assert.deepEqual(await timeout.dispatch!(id), { ok: false, reason: "timeout" });
  assert.equal(calls, 2);
});
