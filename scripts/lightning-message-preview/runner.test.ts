import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PAIRED_ARTIFACT_FIXTURES } from "./fixtures.ts";
import { parseCli, preview } from "./runner.ts";

test("fixture replay maps an existing paired artifact plus explicit label", async () => {
  const result = await preview(["--fixture=cg_verified", "--location=Aşağı Ayrancı, Çankaya"]);
  assert.equal(result.ok, true);
  if (result.ok) assert.ok(result.mapUrl?.endsWith("39.902742,32.851494"));
});

test("artifact JSON path replays the same output without calling providers", async () => {
  const directory = await mkdtemp(join(tmpdir(), "paired-message-preview-"));
  try {
    const path = join(directory, "paired-result.json");
    await writeFile(path, JSON.stringify(PAIRED_ARTIFACT_FIXTURES.reactivated_cg));
    assert.deepEqual(await preview([`--artifact=${path}`, "--location=Beynam, Balâ"]),
      await preview(["--fixture=reactivated_cg", "--location=Beynam, Balâ"]));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("CLI rejects missing, duplicate, and conflicting artifact arguments", () => {
  for (const args of [[], ["--fixture=cg_verified"], ["--artifact=a.json", "--fixture=ic_only", "--location=X"],
    ["--fixture=missing", "--location=X"], ["--artifact=a.json", "--location=X", "--location=Y"],
    ["--fixture=cg_verified", "--location=X", "--unknown=1"]]) {
    assert.throws(() => parseCli(args));
  }
  assert.equal(parseCli(["--fixture=cg_verified", "--location="]).location, "");
});
