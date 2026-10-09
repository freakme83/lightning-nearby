import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createPendingPublicationNotifier, MANUAL_APPROVAL_WORKFLOW_URL, pendingPublicationText,
  type PendingPublicationNotification } from "./pending.ts";

const token = "123456:THIS_IS_A_FIXTURE_TOKEN_NOT_A_SECRET";
const config = { TELEGRAM_BOT_TOKEN: token, TELEGRAM_CHAT_ID: "-100123456789" };
const candidate: PendingPublicationNotification = {
  publicationId: "pub_fixture", hashtag: "#YILDIRIM", locationLabel: "Çankaya, Ankara",
  enrichmentStatus: "cg_verified", messageText: "#YILDIRIM\n  exact composer text  \n",
};

test("one outbound sendMessage request contains the exact composer text and approval link", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetcher: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), init: init ?? {} });
    return Response.json({ ok: true, result: { message_id: 1 } });
  };
  const { notify, invalidSettings } = createPendingPublicationNotifier(config, fetcher);
  assert.deepEqual(invalidSettings, []);
  assert.ok(notify);
  assert.deepEqual(await notify(candidate), { ok: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `https://api.telegram.org/bot${token}/sendMessage`);
  assert.equal(calls[0].init.method, "POST");
  const body = JSON.parse(String(calls[0].init.body)) as { chat_id: string; text: string };
  assert.equal(body.chat_id, config.TELEGRAM_CHAT_ID);
  assert.equal(body.text, pendingPublicationText(candidate));
  assert.ok(body.text.includes(candidate.messageText));
  assert.ok(body.text.includes(MANUAL_APPROVAL_WORKFLOW_URL));
  assert.match(body.text, /Onay gerekli/);
  assert.doesNotMatch(body.text, /google\.com\/maps|THIS_IS_A_FIXTURE_TOKEN/);
  assert.equal(calls[0].init.signal?.aborted, false);
});

test("missing or malformed Telegram settings disable notification without exposing values", () => {
  assert.deepEqual(createPendingPublicationNotifier({}).invalidSettings,
    ["TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID"]);
  const result = createPendingPublicationNotifier({ TELEGRAM_BOT_TOKEN: "malformed-secret", TELEGRAM_CHAT_ID: "not-a-chat" });
  assert.equal(result.notify, null);
  assert.deepEqual(result.invalidSettings, ["TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID"]);
  assert.doesNotMatch(JSON.stringify(result), /malformed-secret|not-a-chat/);
});

test("HTTP, Bot API, network, and timeout errors return sanitized one-attempt outcomes", async () => {
  for (const [fetcher, expected] of [
    [async () => new Response(token, { status: 401 }), { ok: false, reason: "http_error", httpStatus: 401 }],
    [async () => Response.json({ ok: false, description: token }), { ok: false, reason: "invalid_response" }],
    [async () => { throw new Error(`request failed: ${token}`); }, { ok: false, reason: "network_error" }],
  ] as const) {
    let calls = 0;
    const { notify } = createPendingPublicationNotifier(config, (async () => { calls++; return fetcher(); }) as typeof fetch);
    assert.ok(notify);
    const result = await notify(candidate);
    assert.deepEqual(result, expected);
    assert.equal(calls, 1);
    assert.doesNotMatch(JSON.stringify(result), /THIS_IS_A_FIXTURE_TOKEN/);
  }
  const { notify } = createPendingPublicationNotifier(config, (_input, init) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new Error(`aborted ${token}`)), { once: true });
  }), 5);
  assert.ok(notify);
  assert.deepEqual(await notify(candidate), { ok: false, reason: "timeout" });
});

test("adapter is outbound-only and contains no Telegram update consumption or X endpoint", async () => {
  const source = await readFile(new URL("./pending.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /getUpdates|webhook|deleteWebhook|api\.x\.com|X_API_KEY|X_ACCESS_TOKEN/);
});
