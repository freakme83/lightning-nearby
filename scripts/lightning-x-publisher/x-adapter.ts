import { createHmac, randomBytes } from "node:crypto";

export const X_CREATE_POST_URL = "https://api.x.com/2/tweets";
export type XCredentials = {
  apiKey?: string;
  apiKeySecret?: string;
  accessToken?: string;
  accessTokenSecret?: string;
};
export type XPostResult =
  | { outcome: "confirmed_success"; postId: string }
  | { outcome: "definite_failure"; status: number }
  | { outcome: "publication_uncertain"; reason: "transport" | "server_response" | "unreadable_success" };

export function hasXCredentials(value: XCredentials): boolean {
  return [value.apiKey, value.apiKeySecret, value.accessToken, value.accessTokenSecret]
    .every(part => typeof part === "string" && part.length > 0);
}

function encode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, char =>
    "%" + char.charCodeAt(0).toString(16).toUpperCase());
}

export function oauthHeader(credentials: XCredentials, timestamp: string, nonce: string): string {
  if (!hasXCredentials(credentials)) throw new Error("X credentials are incomplete.");
  const params: Record<string, string> = {
    oauth_consumer_key: credentials.apiKey!,
    oauth_nonce: nonce,
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: timestamp,
    oauth_token: credentials.accessToken!,
    oauth_version: "1.0",
  };
  // JSON bodies do not enter the OAuth 1.0a form parameter signature.
  const normalized = Object.entries(params).map(([key, value]) => [encode(key), encode(value)])
    .sort(([a, av], [b, bv]) => a.localeCompare(b) || av.localeCompare(bv))
    .map(([key, value]) => key + "=" + value).join("&");
  const base = ["POST", encode(X_CREATE_POST_URL), encode(normalized)].join("&");
  const key = encode(credentials.apiKeySecret!) + "&" + encode(credentials.accessTokenSecret!);
  params.oauth_signature = createHmac("sha1", key).update(base).digest("base64");
  return "OAuth " + Object.entries(params).sort(([a], [b]) => a.localeCompare(b))
    .map(([name, value]) => encode(name) + '="' + encode(value) + '"').join(", ");
}

export function createXAdapter(credentials: XCredentials, fetcher: typeof fetch = fetch,
  clock: () => number = () => Date.now(), nonce: () => string = () => randomBytes(16).toString("hex")) {
  if (!hasXCredentials(credentials)) throw new Error("X credentials are incomplete.");
  return {
    async createPost(text: string): Promise<XPostResult> {
      const authorization = oauthHeader(credentials, String(Math.floor(clock() / 1000)), nonce());
      let response: Response;
      try {
        response = await fetcher(X_CREATE_POST_URL, {
          method: "POST",
          headers: { Authorization: authorization, "Content-Type": "application/json" },
          body: JSON.stringify({ text }),
          signal: AbortSignal.timeout(15_000),
          redirect: "error",
        });
      } catch {
        return { outcome: "publication_uncertain", reason: "transport" };
      }
      // 408 and all server failures may be returned after the post was accepted.
      if (response.status === 408 || response.status >= 500 || response.status >= 200 && response.status < 300 && response.status !== 201) {
        return { outcome: "publication_uncertain", reason: "server_response" };
      }
      if (response.status >= 400 && response.status < 500) {
        return { outcome: "definite_failure", status: response.status };
      }
      if (response.status !== 201) return { outcome: "publication_uncertain", reason: "server_response" };
      try {
        const payload: unknown = await response.json();
        const data = payload && typeof payload === "object" ? (payload as { data?: unknown }).data : null;
        const id = data && typeof data === "object" ? (data as { id?: unknown }).id : null;
        if (typeof id === "string" && /^[0-9]+$/.test(id)) return { outcome: "confirmed_success", postId: id };
      } catch { /* The post may exist even if its response is unreadable. */ }
      return { outcome: "publication_uncertain", reason: "unreadable_success" };
    },
  };
}
