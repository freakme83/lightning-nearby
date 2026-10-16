import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const HERE = import.meta.dirname;

test("reader runtime imports only its isolated client and Node HTTP server", async () => {
  const allowed = new Set(["node:http", "node:crypto", "./client.ts", "./service.ts"]);
  for (const filename of ["client.ts", "service.ts", "runner.ts"]) {
    const source = await readFile(path.join(HERE, filename), "utf8");
    const imports = [...source.matchAll(/from\s+["']([^"']+)["']/g)].map(match => match[1]);
    assert.deepEqual(imports.filter(specifier => !allowed.has(specifier)), [], `${filename} imports outside the narrow reader boundary`);
    assert.doesNotMatch(source, /supabase|telegram|xweather|publisher|lightning-incident-lifecycle/i);
  }
});

test("normal production scripts do not start the log reader", async () => {
  const packageJson = JSON.parse(await readFile(path.resolve(HERE, "../../../package.json"), "utf8"));
  assert.equal(packageJson.scripts["research:datadog-log-reader"],
    "node --experimental-strip-types scripts/research/datadog-log-reader/runner.ts");
  assert.equal(packageJson.scripts["test:research:datadog-log-reader"],
    "node --experimental-strip-types --test scripts/research/datadog-log-reader/*.test.ts");
  for (const name of ["dev", "build", "start", "research:lightning-incidents", "research:dual-source-observer"]) {
    assert.doesNotMatch(packageJson.scripts[name], /datadog-log-reader/i);
  }
});
