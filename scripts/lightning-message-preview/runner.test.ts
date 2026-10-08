import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

test("manual workflow downloads a real same-repository artifact and delegates message generation to this CLI", async () => {
  const workflow = await readFile(new URL("../../.github/workflows/research-lightning-paired-message-preview.yml", import.meta.url), "utf8");
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /pairedRunId:[\s\S]*?required: true[\s\S]*?type: string/);
  assert.match(workflow, /locationLabel:[\s\S]*?required: true[\s\S]*?type: string/);
  assert.match(workflow, /actions: read/);
  assert.match(workflow, /actions\/download-artifact@v4/);
  assert.match(workflow, /github-token: \$\{\{ github\.token \}\}/);
  assert.match(workflow, /run-id: \$\{\{ inputs\.pairedRunId \}\}/);
  assert.match(workflow, /lightning-cg-paired-validation-\$\{runId\}/);
  assert.match(workflow, /name 'lightning-cg-paired-result\.json'/);
  assert.match(workflow, /scripts\/lightning-message-preview\/runner\.ts/);
  assert.match(workflow, /--artifact="\$PAIRED_ARTIFACT_PATH"/);
  assert.match(workflow, /--location="\$LOCATION_LABEL"/);
  assert.match(workflow, /retention-days: 3/);
  assert.doesNotMatch(workflow, /--fixture=/);
  assert.doesNotMatch(workflow, /nominatim|xweather|lightningmaps|open-meteo/i);
});
