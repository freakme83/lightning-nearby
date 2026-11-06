import test from "node:test";
import assert from "node:assert/strict";
import { classifyTelegramResponse, createActivityTelegramClient } from "./telegram.ts";

const token = "123456:THIS_IS_A_FIXTURE_TOKEN_NOT_A_SECRET";
const env = { TELEGRAM_BOT_TOKEN: token, TELEGRAM_CHAT_ID: "-100123456789" };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

test("reuses the existing bot and group settings; invalid settings disable only this client", () => {
  assert.deepEqual(createActivityTelegramClient({}).invalidSettings, ["TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID"]);
  assert.equal(createActivityTelegramClient({ ...env, TELEGRAM_CHAT_ID: "@group" }).client, null);
  assert.ok(createActivityTelegramClient(env).client);
});

test("sendMessage and sendDocument go to the configured group without leaking the token", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const { client } = createActivityTelegramClient(env, async (input, init) => {
    calls.push({ url: String(input), init: init ?? {} });
    return json({ ok: true, result: { message_id: 42 } });
  });
  assert.deepEqual(await client!.sendMessage("metin"), { status: "sent", messageId: 42 });
  assert.equal(calls[0].url, `https://api.telegram.org/bot${token}/sendMessage`);
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), { chat_id: env.TELEGRAM_CHAT_ID, text: "metin",
    link_preview_options: { is_disabled: true } });
  assert.deepEqual(await client!.sendDocument("başlık", "ankara-activity-x.json", "{\"a\":1}\n"), { status: "sent", messageId: 42 });
  assert.equal(calls[1].url, `https://api.telegram.org/bot${token}/sendDocument`);
  const form = calls[1].init.body as FormData;
  assert.equal(form.get("chat_id"), env.TELEGRAM_CHAT_ID);
  assert.equal(form.get("caption"), "başlık");
  const file = form.get("document") as File;
  assert.equal(file.name, "ankara-activity-x.json");
  assert.equal(file.type, "application/json");
  assert.equal(await file.text(), "{\"a\":1}\n");
});

test("Telegram answers are classified by what is known about delivery", async () => {
  assert.deepEqual(await classifyTelegramResponse(json({ ok: true, result: { message_id: 7 } })),
    { status: "sent", messageId: 7 });
  // A consistent 429 is a confirmed refusal: retryable, honouring retry_after.
  assert.deepEqual(await classifyTelegramResponse(json({ ok: false, error_code: 429, parameters: { retry_after: 37 } }, 429)),
    { status: "retry", detail: "telegram_429", retryAfterSeconds: 37 });
  assert.deepEqual(await classifyTelegramResponse(json({ ok: false, error_code: 429 }, 429)),
    { status: "retry", detail: "telegram_429" });
  assert.deepEqual(await classifyTelegramResponse(json({ ok: false, error_code: 429 }, 200)),
    { status: "ambiguous", detail: "inconsistent_http_200" });
  assert.deepEqual(await classifyTelegramResponse(json({ ok: false, error_code: 400, description: "chat not found" }, 400)),
    { status: "failed", detail: "telegram_400" });
  assert.deepEqual(await classifyTelegramResponse(new Response("too large", { status: 413 })),
    { status: "failed", detail: "http_413" });
  assert.deepEqual(await classifyTelegramResponse(new Response("not json", { status: 200 })),
    { status: "ambiguous", detail: "unreadable_http_200" });
});

test("every 5xx is ambiguous, never retryable: the message may already have been accepted", async () => {
  const cases: [Response, string][] = [
    [json({ ok: false, error_code: 500, description: "Internal Server Error" }, 500), "telegram_500"],
    [json({ ok: false, error_code: 502, description: "Bad Gateway" }, 502), "telegram_502"],
    [json({ ok: false, error_code: 504, description: "Gateway Timeout" }, 504), "telegram_504"],
    [new Response("<html>502 Bad Gateway</html>", { status: 502 }), "http_502"],
    [new Response("", { status: 504 }), "http_504"],
    [new Response("<html>500</html>", { status: 500 }), "http_500"],
    // Even a readable client error is not trusted when the HTTP layer reports a server error.
    [json({ ok: false, error_code: 400 }, 503), "http_503"],
    [json({ ok: false, error_code: 500 }, 200), "telegram_500"],
  ];
  for (const [response, detail] of cases) {
    assert.deepEqual(await classifyTelegramResponse(response), { status: "ambiguous", detail });
  }
  const { client } = createActivityTelegramClient(env, async () => new Response("", { status: 504 }));
  assert.deepEqual(await client!.sendDocument("c", "f.json", "{}"), { status: "ambiguous", detail: "http_504" });
});

test("timeouts and dropped connections are ambiguous; failures before connecting are retryable", async () => {
  const hang: typeof fetch = (_input, init) => new Promise((_resolve, reject) =>
    init!.signal!.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
  const slow = createActivityTelegramClient(env, hang).client!;
  const realSetTimeout = globalThis.setTimeout;
  // Expire the client's own timeout immediately.
  globalThis.setTimeout = ((fn: () => void) => realSetTimeout(fn, 0)) as typeof setTimeout;
  try {
    assert.deepEqual(await slow.sendMessage("x"), { status: "ambiguous", detail: "timeout" });
  } finally { globalThis.setTimeout = realSetTimeout; }
  const failing = (code: string): typeof fetch => async () => {
    throw Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error(code), { code }) });
  };
  assert.deepEqual(await createActivityTelegramClient(env, failing("ECONNREFUSED")).client!.sendMessage("x"),
    { status: "retry", detail: "connect_error" });
  assert.deepEqual(await createActivityTelegramClient(env, failing("ECONNRESET")).client!.sendMessage("x"),
    { status: "ambiguous", detail: "network_error" });
});
