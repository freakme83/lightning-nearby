import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { composeLightningMessage } from "./compose.ts";
import { COMPOSER_FIXTURES, getComposerFixture } from "./fixtures.ts";
import type { ComposerInput } from "./types.ts";

export function parseCli(args: string[]): { fixture?: string; input?: string; maxCharacters?: number } {
  const values: Record<string, string> = {};
  for (const arg of args) {
    const match = /^--([a-z-]+)=(.+)$/.exec(arg);
    if (!match || !["fixture", "input", "max-characters"].includes(match[1]) || values[match[1]] !== undefined) {
      throw new Error("Expected one --fixture=<name> or --input=<json-path>, optionally --max-characters=<positive-integer>.");
    }
    values[match[1]] = match[2];
  }
  if (Boolean(values.fixture) === Boolean(values.input)) throw new Error("Specify exactly one of --fixture or --input.");
  if (values.fixture && !getComposerFixture(values.fixture)) {
    throw new Error(`Unknown fixture. Available: ${Object.keys(COMPOSER_FIXTURES).join(", ")}.`);
  }
  const maxCharacters = values["max-characters"] === undefined ? undefined : Number(values["max-characters"]);
  if (maxCharacters !== undefined && (!/^\d+$/.test(values["max-characters"]) || !Number.isSafeInteger(maxCharacters) || maxCharacters < 1)) {
    throw new Error("--max-characters must be a positive integer.");
  }
  return { fixture: values.fixture, input: values.input, maxCharacters };
}

export async function preview(args: string[]) {
  const flags = parseCli(args);
  const input: ComposerInput = flags.fixture
    ? getComposerFixture(flags.fixture)!
    : JSON.parse(await readFile(resolve(flags.input!), "utf8")) as ComposerInput;
  return composeLightningMessage(input, { maxCharacters: flags.maxCharacters });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void (async () => {
    try {
      const result = await preview(process.argv.slice(2));
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      if (result.ok) process.stderr.write(`Preview:\n${result.text}\n`);
      else process.exitCode = 2;
    } catch (cause) {
      const message = cause instanceof SyntaxError ? "Input file is not valid JSON." :
        cause && typeof cause === "object" && "code" in cause ? "Could not read input file." :
          cause instanceof Error ? cause.message : "Invalid composer input.";
      process.stdout.write(`${JSON.stringify({ ok: false, error: { code: "invalid_input", message } })}\n`);
      process.exitCode = 1;
    }
  })();
}
