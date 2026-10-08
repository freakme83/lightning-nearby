import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { publishApproved, type PublisherResult } from "./publisher.ts";
import { createSupabasePublisherStore } from "./storage.ts";
import { createXAdapter, hasXCredentials, type XCredentials } from "./x-adapter.ts";

const resultPath = "artifacts/lightning-x-publisher-result.json";
export function publisherExitCode(result: PublisherResult): number {
  return ["published", "already_published"].includes(result.outcome) ? 0 : 1;
}

export async function main(): Promise<void> {
  const publicationId = process.env.PUBLICATION_ID ?? "";
  const credentials: XCredentials = {
    apiKey: process.env.X_API_KEY,
    apiKeySecret: process.env.X_API_KEY_SECRET,
    accessToken: process.env.X_ACCESS_TOKEN,
    accessTokenSecret: process.env.X_ACCESS_TOKEN_SECRET,
  };
  const credentialsPresent = hasXCredentials(credentials);
  let result: PublisherResult;
  try {
    const store = createSupabasePublisherStore({ url: process.env.SUPABASE_URL,
      serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY });
    const x = credentialsPresent ? createXAdapter(credentials) : {
      createPost: async (): Promise<never> => { throw new Error("X credentials are incomplete."); },
    };
    result = await publishApproved(publicationId, store, x, {
      enabled: process.env.X_PUBLISHING_ENABLED === "true", credentialsPresent,
    });
  } catch {
    result = { publicationId, outcome: "storage_error", reason: "Publisher configuration is unavailable or invalid.",
      postId: null, attemptId: null };
  }
  await mkdir("artifacts", { recursive: true });
  await writeFile(resultPath, JSON.stringify(result, null, 2) + "\n", { mode: 0o600 });
  console.log("X publisher outcome: " + result.outcome + ". Result: " + resultPath);
  if (publisherExitCode(result)) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch(() => { console.error("Could not write X publisher result artifact."); process.exitCode = 1; });
}
