import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

test("capture hooks the existing decoded stream before production admission without another socket", async () => {
  const worker = await readFile(new URL("../fly-ankara-worker/worker.ts", import.meta.url), "utf8");
  const manager = await readFile(new URL("./manager.ts", import.meta.url), "utf8");
  assert.ok(worker.indexOf("replayCapture?.observe(frame.event)") < worker.indexOf("blitzAdmission.admit(frame.event"));
  assert.equal((worker.match(/new WebSocket\(/g) ?? []).length, 1);
  assert.doesNotMatch(manager, /new WebSocket|Telegram|autoPublish|Xweather|runtime\.acceptEvent|publication_pending/);
  assert.match(worker, /try \{ replayCapture\?\.observe\(frame\.event\); \}/);
});
