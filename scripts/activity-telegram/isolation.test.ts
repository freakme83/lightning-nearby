import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createPendingPublicationNotifier, pendingPublicationText, autoPublishFailureText,
  type PendingPublicationNotification } from "../lightning-telegram-notifier/pending.ts";
import { createActivityTelegram } from "./dispatcher.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const token = "123456:THIS_IS_A_FIXTURE_TOKEN_NOT_A_SECRET";

/** Runtime import closure; `import type` is erased by type stripping and loads nothing. */
function importClosure(entry: string): Set<string> {
  const seen = new Set<string>();
  const visit = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(/(?:import|export)\s(?!type\s)[^;]*?from\s+"(\.{1,2}\/[^"]+)"/g)) {
      visit(resolve(dirname(file), match[1]));
    }
    for (const match of source.matchAll(/new URL\("(\.\/[^"]+)", import\.meta\.url\)/g)) {
      seen.add(resolve(dirname(file), match[1]));
    }
  };
  visit(join(root, entry));
  return new Set([...seen].map(file => relative(root, file)));
}

test("existing publication notifications are byte-identical with Activity Telegram enabled", async () => {
  const env = { TELEGRAM_BOT_TOKEN: token, TELEGRAM_CHAT_ID: "-100123456789", ACTIVITY_TELEGRAM_ENABLED: "true" };
  const calls: { url: string; body: string; headers: unknown }[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), body: String(init?.body), headers: init?.headers });
    return Response.json({ ok: true, result: { message_id: 1 } });
  };
  const candidate: PendingPublicationNotification = { publicationId: "pub_fixture", hashtag: "#YILDIRIM",
    locationLabel: "Çankaya, Ankara", enrichmentStatus: "cg_verified", messageText: "#YILDIRIM\nmetin" };
  const publication = createPendingPublicationNotifier(env, fetcher);
  assert.deepEqual(await publication.notify!(candidate), { ok: true });
  assert.deepEqual(await publication.notifyAutoPublishFailure!({ publicationId: "pub_fixture", httpStatus: 403 }), { ok: true });
  assert.deepEqual(calls.map(call => [call.url, JSON.parse(call.body)]), [
    [`https://api.telegram.org/bot${token}/sendMessage`, { chat_id: env.TELEGRAM_CHAT_ID, text: pendingPublicationText(candidate) }],
    [`https://api.telegram.org/bot${token}/sendMessage`, { chat_id: env.TELEGRAM_CHAT_ID,
      text: autoPublishFailureText({ publicationId: "pub_fixture", httpStatus: 403 }) }],
  ]);
  assert.deepEqual(calls[0].headers, { "Content-Type": "application/json" });
});

test("Activity Telegram code is isolated from the publication pipeline", () => {
  const closure = importClosure("scripts/activity-telegram/dispatcher.ts");
  for (const file of closure) {
    assert.doesNotMatch(file, /lightning-telegram-notifier|fly-ankara-worker\/(runtime|auto-publish|blitz-primary|worker)|x-publisher|github-dispatch|publish-decision|incident-lifecycle\/(incident|publish)/,
      file);
  }
  assert.ok(closure.has("scripts/activity-export/data/ankara-districts.geojson"));
});

test("the worker image packages every module the worker imports, including district data", () => {
  const dockerfile = readFileSync(join(root, "Dockerfile.fly-ankara-worker"), "utf8");
  const copied = [...dockerfile.matchAll(/^COPY\s+(\S+)\s+/gm)].map(match => match[1]);
  const closure = importClosure("scripts/fly-ankara-worker/worker.ts");
  assert.ok(closure.has("scripts/activity-telegram/dispatcher.ts"));
  assert.ok(closure.has("scripts/activity-export/data/ankara-districts.geojson"));
  for (const file of closure) {
    assert.ok(copied.some(source => source.endsWith("/") ? file.startsWith(source) : file === source), `${file} not copied`);
  }
});

test("the worker starts Activity Telegram independently and leaves publication wiring unchanged", () => {
  const worker = readFileSync(join(root, "scripts/fly-ankara-worker/worker.ts"), "utf8");
  assert.match(worker, /const telegram = createPendingPublicationNotifier\(process\.env\);/);
  assert.match(worker, /\.\.\.\(telegram\.notify \? \{ notifyPending: telegram\.notify \} : \{\}\)/);
  assert.match(worker, /const activityTelegram = createActivityTelegram\(process\.env, emit\);/);
  assert.match(worker, /activityTelegram\?\.stop\(\);/);
  // Not on the frame path: acceptFrame never references it.
  const acceptFrame = worker.slice(worker.indexOf("function acceptFrame"), worker.indexOf("function stop("));
  assert.doesNotMatch(acceptFrame, /activityTelegram/);
  assert.equal(createActivityTelegram({ TELEGRAM_BOT_TOKEN: token, TELEGRAM_CHAT_ID: "-1" }, () => {}), null);
});
