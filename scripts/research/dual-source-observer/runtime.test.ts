import assert from "node:assert/strict";
import test from "node:test";
import {
  ObserverSocketOwnership,
  abortableDelay,
  observerReconnectDelayMs,
  runResilientSourceLoop,
} from "./runtime.ts";

test("stale socket callback cannot clobber a newer observer socket", () => {
  const oldSocket = { id: "old" };
  const newSocket = { id: "new" };
  const ownership = new ObserverSocketOwnership<typeof oldSocket>();
  ownership.claim(oldSocket);
  ownership.claim(newSocket);
  assert.equal(ownership.release(oldSocket), false);
  assert.equal(ownership.active, newSocket);
  assert.equal(ownership.release(newSocket), true);
  assert.equal(ownership.active, null);
});

test("reconnect wait is cancelable during shutdown", async () => {
  const controller = new AbortController();
  const wait = abortableDelay(60_000, controller.signal);
  controller.abort();
  assert.equal(await wait, false);
});

test("observer reconnect backoff is bounded exponential", () => {
  assert.equal(observerReconnectDelayMs(0, 0), 500);
  assert.equal(observerReconnectDelayMs(1, 0), 1_000);
  assert.equal(observerReconnectDelayMs(20, 1), 60_000);
});

async function verifyFailureIsolation(failingSource: "live2" | "blitzortung"): Promise<void> {
  const controller = new AbortController();
  let failureObserved = false;
  let oppositeRunning = false;
  const opposite = failingSource === "live2" ? "blitzortung" : "live2";

  const failing = runResilientSourceLoop({
    source: failingSource,
    signal: controller.signal,
    connectOnce: async () => { throw new Error("synthetic source failure"); },
    onFailure: () => { failureObserved = true; },
    onReconnectWait: () => undefined,
    random: () => 0,
  });
  const survivor = runResilientSourceLoop({
    source: opposite,
    signal: controller.signal,
    connectOnce: async () => {
      oppositeRunning = true;
      await abortableDelay(60_000, controller.signal);
      return true;
    },
    onFailure: () => assert.fail("opposite source must not fail"),
    onReconnectWait: () => undefined,
    random: () => 0,
  });

  await new Promise(resolve => setImmediate(resolve));
  assert.equal(failureObserved, true);
  assert.equal(oppositeRunning, true);
  controller.abort();
  await Promise.all([failing, survivor]);
}

test("Blitz connection-loop failure leaves observer live2 loop running", async () => {
  await verifyFailureIsolation("blitzortung");
});

test("observer live2 connection-loop failure leaves Blitz loop running", async () => {
  await verifyFailureIsolation("live2");
});
