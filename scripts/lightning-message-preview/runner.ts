import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { previewPairedMessage } from "./adapter.ts";
import { getPairedArtifactFixture, PAIRED_ARTIFACT_FIXTURES } from "./fixtures.ts";

export function parseCli(args: string[]): { artifact?: string; fixture?: string; location: string } {
  const values: Record<string, string> = {};
  for (const arg of args) {
    const match = /^--([a-z-]+)=(.*)$/.exec(arg);
    if (!match || !["artifact", "fixture", "location"].includes(match[1]) || values[match[1]] !== undefined) {
      throw new Error("Expected --artifact=<json-path> or --fixture=<name>, plus --location=<normalized-label>.");
    }
    values[match[1]] = match[2];
  }
  if (Boolean(values.artifact) === Boolean(values.fixture) || values.location === undefined) {
    throw new Error("Specify exactly one artifact source and an explicit --location label.");
  }
  if (values.fixture && !getPairedArtifactFixture(values.fixture)) {
    throw new Error(`Unknown fixture. Available: ${Object.keys(PAIRED_ARTIFACT_FIXTURES).join(", ")}.`);
  }
  return { artifact: values.artifact, fixture: values.fixture, location: values.location };
}

export async function preview(args: string[]) {
  const flags = parseCli(args);
  const artifact: unknown = flags.fixture
    ? getPairedArtifactFixture(flags.fixture)
    : JSON.parse(await readFile(resolve(flags.artifact!), "utf8"));
  return previewPairedMessage({ artifact, locationDisplayLabel: flags.location });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void (async () => {
    try {
      const result = await preview(process.argv.slice(2));
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      if (result.ok) process.stderr.write(`Dry-run post:\n${result.text}\n`);
      else process.exitCode = 2;
    } catch (cause) {
      const message = cause instanceof SyntaxError ? "Artifact file is not valid JSON." :
        cause && typeof cause === "object" && "code" in cause ? "Could not read artifact file." :
          cause instanceof Error ? cause.message : "Invalid preview input.";
      process.stdout.write(`${JSON.stringify({ ok: false, error: { code: "invalid_preview_input", message }, text: null })}\n`);
      process.exitCode = 1;
    }
  })();
}
