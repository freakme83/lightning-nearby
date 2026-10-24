import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { BLITZORTUNG_SERVERS } from "../research/blitzortung-probe/protocol.ts";

test("production worker reports and rotates only ws1/ws8 while research list stays unchanged", async () => {
  const worker = await readFile(new URL("./worker.ts", import.meta.url), "utf8");
  assert.match(worker, /WORKER_BLITZORTUNG_SERVERS\s*=\s*\["ws1",\s*"ws8"\]/);
  assert.match(worker, /endpoints:\s*WORKER_BLITZORTUNG_SERVERS\.map/);
  assert.match(worker, /WORKER_BLITZORTUNG_SERVERS\[serverIndex\+\+\s*%\s*WORKER_BLITZORTUNG_SERVERS\.length\]/);
  assert.deepEqual(BLITZORTUNG_SERVERS, ["ws1", "ws7", "ws8"]);
  const endpoints = ["ws1", "ws8"].map(server => `wss://${server}.blitzortung.org/`);
  assert.deepEqual(endpoints, ["wss://ws1.blitzortung.org/", "wss://ws8.blitzortung.org/"]);
  assert.equal(endpoints.some(endpoint => endpoint.includes("ws7")), false);
});
