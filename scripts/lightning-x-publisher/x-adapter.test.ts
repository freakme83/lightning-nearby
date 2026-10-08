import assert from "node:assert/strict";
import { test } from "node:test";
import { createXAdapter, oauthHeader, X_CREATE_POST_URL } from "./x-adapter.ts";

const credentials = { apiKey: "consumer", apiKeySecret: "consumer-secret",
  accessToken: "token", accessTokenSecret: "token-secret" };
const text = "#YILDIRIM\nAşağı Ayrancı / Çankaya\n39.901, 32.859 \n";

test("OAuth 1.0a signs a JSON create-post request with exact persisted text and no map URL", async () => {
  let calls = 0;
  const fake = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    calls++;
    assert.equal(url, X_CREATE_POST_URL);
    assert.equal(init?.method, "POST");
    assert.equal(init?.redirect, "error");
    assert.deepEqual(JSON.parse(String(init?.body)), { text });
    assert.equal(String(init?.body).includes("google.com/maps"), false);
    assert.equal(init?.headers && (init.headers as Record<string, string>)["Content-Type"], "application/json");
    const auth = (init?.headers as Record<string, string>).Authorization;
    assert.match(auth, /^OAuth /);
    assert.match(auth, /oauth_signature="/);
    assert.match(auth, /oauth_token="token"/);
    assert.ok(!auth.includes("consumer-secret") && !auth.includes("token-secret"));
    return new Response(JSON.stringify({ data: { id: "123456789", text } }), { status: 201 });
  };
  const result = await createXAdapter(credentials, fake as typeof fetch, () => 1_000_000, () => "nonce").createPost(text);
  assert.deepEqual(result, { outcome: "confirmed_success", postId: "123456789" });
  assert.equal(calls, 1);
  assert.equal(X_CREATE_POST_URL, "https://api.x.com/2/tweets");
  assert.equal(oauthHeader(credentials, "1000", "nonce"), oauthHeader(credentials, "1000", "nonce"));
});

test("confirmed 4xx is definite; 408 and 5xx are conservatively uncertain", async () => {
  for (const [status, expected] of [[400, "definite_failure"], [401, "definite_failure"],
    [403, "definite_failure"], [429, "definite_failure"], [408, "publication_uncertain"],
    [500, "publication_uncertain"], [503, "publication_uncertain"]] as const) {
    let calls = 0;
    const fake = async () => { calls++; return new Response("{}", { status }); };
    const result = await createXAdapter(credentials, fake as typeof fetch).createPost(text);
    assert.equal(result.outcome, expected);
    assert.equal(calls, 1);
  }
});

test("timeout, lost response, and malformed success never retry", async () => {
  for (const fake of [
    async () => { throw new Error("timeout"); },
    async () => new Response("{", { status: 201 }),
    async () => new Response(JSON.stringify({ data: {} }), { status: 201 }),
    async () => new Response(JSON.stringify({ data: { id: 23 } }), { status: 201 }),
  ]) {
    let calls = 0;
    const result = await createXAdapter(credentials, (async () => {
      calls++;
      return fake();
    }) as typeof fetch).createPost(text);
    assert.equal(result.outcome, "publication_uncertain");
    assert.equal(calls, 1);
  }
});
