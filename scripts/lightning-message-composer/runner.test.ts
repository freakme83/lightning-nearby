import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { COMPOSER_FIXTURES } from "./fixtures.ts";
import { parseCli, preview } from "./runner.ts";

test("fixture preview returns the composed structured result without a provider", async () => {
  const result = await preview(["--fixture=cg_verified_urban"]);
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.mapUrl, "https://www.google.com/maps?q=39.902742,32.851494");
});

test("manual normalized JSON input produces the same result as the fixture", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lightning-composer-"));
  try {
    const path = join(directory, "input.json");
    await writeFile(path, JSON.stringify(COMPOSER_FIXTURES.ic_only_urban));
    assert.deepEqual(await preview([`--input=${path}`]), await preview(["--fixture=ic_only_urban"]));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("CLI requires one source and a valid optional budget", () => {
  for (const args of [[], ["--fixture=missing"], ["--fixture=ic_only_urban", "--input=input.json"],
    ["--fixture=ic_only_urban", "--max-characters=0"], ["--fixture=ic_only_urban", "--unknown=x"]]) {
    assert.throws(() => parseCli(args));
  }
  assert.equal(parseCli(["--fixture=ic_only_urban", "--max-characters=200"]).maxCharacters, 200);
});
