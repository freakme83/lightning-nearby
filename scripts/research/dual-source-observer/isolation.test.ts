import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const HERE = import.meta.dirname;
const ROOT = path.resolve(HERE, "../../..");
const OBSERVER_FILES = ["core.ts", "runtime.ts", "runner.ts"];

async function source(relativePath: string): Promise<string> {
  return readFile(path.resolve(ROOT, relativePath), "utf8");
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

test("observer import graph cannot reach production lifecycle or side-effect adapters", async () => {
  const allowedImports = new Set([
    "../../lightning-incident-lifecycle/monitoring-area.ts",
    "../../live-lightning-listener/core.ts",
    "../blitzortung-probe/protocol.ts",
    "./core.ts",
    "./runtime.ts",
  ]);
  for (const filename of OBSERVER_FILES) {
    const text = await readFile(path.join(HERE, filename), "utf8");
    const imports = [...text.matchAll(/from\s+["']([^"']+)["']/g)].map(match => match[1]);
    assert.deepEqual(imports.filter(specifier => !allowedImports.has(specifier)), [], `${filename} has an unexpected import`);
    assert.doesNotMatch(text, /\bfetch\s*\(/, `${filename} must not make provider, persistence, or publish calls`);
    assert.doesNotMatch(text, /incident-engine|live-lightning-clustering|xweather|supabase|telegram|publisher/i,
      `${filename} crossed the observer boundary`);
  }
});

test("production worker and its Fly command do not import or start the observer", async () => {
  const productionWorker = await source("scripts/fly-ankara-worker/worker.ts");
  const productionFly = await source("fly.ankara-worker.toml");
  const productionDocker = await source("Dockerfile.fly-ankara-worker");
  for (const text of [productionWorker, productionFly, productionDocker]) {
    assert.doesNotMatch(text, /dual-source-observer|dual_source_shadow|blitzortung/i);
  }

  const scripts = await TypeScriptFiles(path.resolve(ROOT, "scripts"));
  for (const file of scripts.filter(file => !file.startsWith(HERE))) {
    assert.doesNotMatch(await readFile(file, "utf8"), /from\s+["'][^"']*dual-source-observer\//,
      `${path.relative(ROOT, file)} imports observer code`);
  }
});

test("observer package command is explicit and absent from normal production startup", async () => {
  const packageJson = JSON.parse(await source("package.json"));
  assert.equal(packageJson.scripts["research:dual-source-observer"],
    "node --experimental-strip-types scripts/research/dual-source-observer/runner.ts");
  for (const name of ["dev", "build", "start", "research:lightning-incidents"]) {
    assert.doesNotMatch(packageJson.scripts[name], /dual-source-observer|blitzortung/i);
  }
});

test("separate observer image excludes production and external side-effect paths", async () => {
  const fly = await source("fly.dual-source-observer.toml");
  const docker = await source("Dockerfile.fly-dual-source-observer");
  assert.match(fly, /app = "lightning-nearby-dual-source-shadow"/);
  assert.match(fly, /observer = "node --experimental-strip-types scripts\/research\/dual-source-observer\/runner\.ts"/);
  assert.match(docker, /scripts\/research\/dual-source-observer/);
  assert.match(docker, /blitzortung-probe\/protocol\.ts/);
  for (const forbidden of [
    "fly-ankara-worker", "lightning-cg-enrichment", "lightning-telegram-notifier",
    "lightning-publication-ledger", "lightning-github-dispatch", "lightning-message-composer",
  ]) assert.doesNotMatch(docker, new RegExp(forbidden));
});

test("observer log kinds do not collide with production worker kinds", async () => {
  const kinds = (text: string) => new Set([...text.matchAll(/emit\(["']([^"']+)["']/g)].map(match => match[1]));
  const observerKinds = kinds(await source("scripts/research/dual-source-observer/runner.ts"));
  const productionKinds = kinds(await source("scripts/fly-ankara-worker/worker.ts"));
  assert.deepEqual([...observerKinds].filter(kind => productionKinds.has(kind)), []);
  assert.ok(observerKinds.size >= 7);
  assert.ok([...observerKinds].every(kind => kind.startsWith("dual_source_")));
});
