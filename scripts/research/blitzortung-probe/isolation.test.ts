import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { SourceHealthTracker } from "../../lightning-incident-lifecycle/source-health.ts";
import type { BlitzortungProbeEvent } from "./protocol.ts";
import { BlitzortungProbeState } from "./state.ts";

const HERE = import.meta.dirname;
const PROBE_FILES = ["protocol.ts", "state.ts", "runner.ts"];

async function source(filename: string): Promise<string> {
  return readFile(path.join(HERE, filename), "utf8");
}

async function TypeScriptFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await TypeScriptFiles(target));
    else if (entry.name.endsWith(".ts")) files.push(target);
  }
  return files;
}

test("probe counters and health are independent from live2 production health", () => {
  const productionHealth = new SourceHealthTracker(1_000);
  productionHealth.frame(2_000);
  const before = structuredClone(productionHealth.state);
  const probe = new BlitzortungProbeState(1_000);
  probe.connecting("ws7");
  probe.connected();
  probe.frame(3_000);
  probe.decodeFailure();
  probe.disconnected();
  assert.deepEqual(productionHealth.state, before);
  assert.equal(productionHealth.interruptions, 0);
  assert.ok(Object.keys(probe.summary(4_000)).every(key => key.startsWith("blitz")));
});

test("probe events update only probe-local counters", () => {
  const probe = new BlitzortungProbeState(1_000);
  const event: BlitzortungProbeEvent = {
    source: "blitzortung", sourceServer: "ws1", receivedAtMs: 2_000, eventTimeMs: 1_900,
    eventTimeRaw: "1900000000", eventTimeUnit: "seconds", latencyMs: 100,
    latitude: 39.92, longitude: 32.85, polarityRaw: null, stationCount: null,
    mdsRaw: null, mcgRaw: null, regionRaw: null, insideMonitoringArea: true,
  };
  probe.event(event);
  assert.equal(probe.blitzEventsParsed, 1);
  assert.equal(probe.blitzEventsInsideMonitoringArea, 1);
  assert.equal(probe.blitzEventsOutsideMonitoringArea, 0);
});

test("runtime dependency boundary cannot reach lifecycle or external side effects", async () => {
  const allowedImports = new Set([
    "../../lightning-incident-lifecycle/monitoring-area.ts",
    "./protocol.ts",
    "./state.ts",
  ]);
  for (const filename of PROBE_FILES) {
    const text = await source(filename);
    const imports = [...text.matchAll(/from\s+["']([^"']+)["']/g)].map(match => match[1]);
    assert.deepEqual(imports.filter(specifier => !allowedImports.has(specifier)), [], `${filename} has an unexpected import`);
    assert.doesNotMatch(text, /\bfetch\s*\(/, `${filename} must not make provider or persistence calls`);
  }

  const scriptsRoot = path.resolve(HERE, "../..");
  const outsideProbe = (await TypeScriptFiles(scriptsRoot)).filter(file => !file.startsWith(HERE));
  for (const file of outsideProbe) {
    assert.doesNotMatch(await readFile(file, "utf8"), /from\s+["'][^"']*blitzortung-probe\/runner\.ts["']/,
      `${path.relative(scriptsRoot, file)} imports the manual probe runner`);
  }
});

test("probe package command is manual and absent from production commands", async () => {
  const packageJson = JSON.parse(await readFile(path.resolve(HERE, "../../../package.json"), "utf8"));
  assert.equal(packageJson.scripts["research:blitzortung-probe"],
    "node --experimental-strip-types scripts/research/blitzortung-probe/runner.ts");
  for (const name of ["dev", "build", "start", "research:lightning-incidents"]) {
    assert.doesNotMatch(packageJson.scripts[name], /blitzortung/i);
  }
});
