import assert from "node:assert/strict";
import { test } from "node:test";
import { CgProbeCoordinator } from "./coordinator.ts";
import { CG_REPEAT_MAX_TRACKED_SCOPES } from "./constants.ts";

test("one in flight, latest-only coalescing and bounded request cadence", async () => {
  let now = 0; let release!: () => void; const starts: number[] = [];
  const coordinator = new CgProbeCoordinator<number>({ now: () => now, eligible: () => true,
    execute: async (_scope, value) => { starts.push(value); if (value === 1) await new Promise<void>(resolve => { release = resolve; }); } });
  coordinator.offer("scope", 1); await Promise.resolve();
  for (let i = 2; i <= 100; i++) coordinator.offer("scope", i);
  assert.deepEqual(starts, [1]); assert.equal(coordinator.coalesced, 98);
  release(); await coordinator.drain(); assert.deepEqual(starts, [1]);
  now = 120_000; coordinator.pump(); await coordinator.drain();
  assert.deepEqual(starts, [1, 100]);
});

test("queue rechecks freshness/health at start and separate scopes do not share cadence", async () => {
  let now = 0; let healthy = true; const starts: string[] = []; let release!: () => void;
  const coordinator = new CgProbeCoordinator<number>({ now: () => now, eligible: (_scope, value) => healthy && now - value <= 240_000,
    execute: async (scope) => { starts.push(scope); if (scope === "a") await new Promise<void>(resolve => { release = resolve; }); } });
  coordinator.offer("a", 0); await Promise.resolve(); coordinator.offer("b", 0);
  now = 240_001; release(); await coordinator.drain(); assert.deepEqual(starts, ["a"]);
  healthy = false; coordinator.offer("c", now); await coordinator.drain(); assert.deepEqual(starts, ["a"]);
  healthy = true; coordinator.offer("c", now); await coordinator.drain(); assert.deepEqual(starts, ["a", "c"]);
});

test("bounded scopes, forget and sanitized failure isolation", async () => {
  const errors: string[] = [];
  const coordinator = new CgProbeCoordinator<number>({ now: () => 0, eligible: () => true,
    execute: async () => { throw new Error("secret"); }, onError: scope => errors.push(scope) });
  for (let i = 0; i < CG_REPEAT_MAX_TRACKED_SCOPES + 1; i++) coordinator.offer(String(i), i);
  await coordinator.drain(); assert.equal(coordinator.dropped, 1);
  coordinator.forget("0"); coordinator.offer("new", 0); await coordinator.drain();
  assert.ok(errors.includes("new")); assert.doesNotMatch(JSON.stringify(errors), /secret/);
});
