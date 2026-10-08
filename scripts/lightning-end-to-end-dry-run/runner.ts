// Research-only orchestration. The live runner owns pairing, the Nominatim adapter owns naming,
// and the paired-message-preview adapter owns composer input and public wording.
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readIncidentRunnerOptions } from "../lightning-incident-lifecycle/options.ts";
import { continueFromPairedArtifact, pairedValidationFailure, type DryRunResult, type DryRunStatus } from "./orchestrate.ts";

const artifactDirectory = "artifacts";
const pairedPath = `${artifactDirectory}/lightning-cg-paired-result.json`;
const logPath = `${artifactDirectory}/lightning-cg-paired-live-run.jsonl`;
const resultPath = `${artifactDirectory}/lightning-end-to-end-dry-run-result.json`;

export function runnerExitCode(status: DryRunStatus): number {
  return ["paired_validation_failed", "location_lookup_failed", "message_composition_failed"].includes(status) ? 1 : 0;
}

export function pairedRunnerArgs(env: Record<string, string | undefined>): string[] {
  const duration = env.DURATION_MINUTES ?? "";
  if (!/^\d+$/.test(duration) || Number(duration) < 5 || Number(duration) > 20) {
    throw new Error("DURATION_MINUTES must be an integer from 5 through 20");
  }
  const area = env.AREA;
  if (area !== "custom" && area !== "ankara") throw new Error("AREA must be custom or ankara");
  const profile = env.INCIDENT_PROFILE;
  if (profile !== "A" && profile !== "B" && profile !== "C") throw new Error("INCIDENT_PROFILE must be A, B, or C");
  const args = [`--duration=${duration}`, "--summary-every=60", "--format=jsonl"];
  if (area === "ankara") {
    args.push("--area=ankara");
  } else {
    const coordinates = ["NORTH", "EAST", "SOUTH", "WEST"].map(name => {
      const raw = env[name] ?? "";
      if (!/^-?\d+(?:\.\d+)?$/.test(raw)) throw new Error(`${name} must be a decimal coordinate`);
      return String(Number(raw));
    });
    args.push(`--box=${coordinates.join(",")}`);
  }
  args.push(`--incident-profile=${profile}`, `--paired-validation-output=${pairedPath}`);
  readIncidentRunnerOptions(args); // Reuse the runner's box and profile validation.
  return args;
}

async function runLive(args: string[]): Promise<number> {
  const log = createWriteStream(logPath, { flags: "w" });
  const child = spawn("npm", ["run", "research:lightning-incidents", "--", ...args], {
    env: process.env, stdio: ["ignore", "pipe", "pipe"],
  });
  for (const [stream, destination] of [[child.stdout, process.stdout], [child.stderr, process.stderr]] as const) {
    stream.on("data", (chunk: Buffer) => {
      log.write(chunk);
      destination.write(chunk);
    });
  }
  const forwardTermination = () => child.kill("SIGTERM");
  process.once("SIGTERM", forwardTermination);
  let exitCode: number;
  try {
    exitCode = await new Promise<number>((done) => {
      child.once("error", (error) => { console.error(`Could not start the live runner: ${error.message}`); done(1); });
      child.once("close", (code) => done(code ?? 1));
    });
  } finally {
    process.off("SIGTERM", forwardTermination);
    await new Promise<void>(done => log.end(done));
  }
  return exitCode;
}

export async function main(): Promise<void> {
  await mkdir(artifactDirectory, { recursive: true });
  let result: DryRunResult | null = null;
  try {
    const args = pairedRunnerArgs(process.env);
    const exitCode = await runLive(args);
    let artifact: unknown = null;
    try {
      artifact = JSON.parse(await readFile(pairedPath, "utf8"));
    } catch (error) {
      result = pairedValidationFailure(`No valid structured paired artifact was produced (runner exit ${exitCode}): ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!result) {
      result = exitCode === 0
        ? await continueFromPairedArtifact(artifact)
        : pairedValidationFailure(`The live paired-validation runner exited with code ${exitCode}.`, artifact);
    }
  } catch (error) {
    result = pairedValidationFailure(error instanceof Error ? error.message : String(error));
  }
  if (!result) result = pairedValidationFailure("No end-to-end result was produced.");
  await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`);
  console.log(`End-to-end dry-run status: ${result.status}. Result: ${resultPath}`);
  const exitCode = runnerExitCode(result.status);
  if (exitCode !== 0) process.exitCode = exitCode;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch((error: unknown) => {
    console.error("Could not write the end-to-end result artifact:", error);
    process.exitCode = 1;
  });
}
