import assert from "node:assert/strict";
import test from "node:test";
import { claimInitialLiveCheck, firstLocationAutoCheckKey, INITIAL_LIVE_CHECK_SESSION_KEY, INITIAL_LIVE_CHECK_SUPPRESSED_SESSION_KEY, isInitialLiveCheckEligible, suppressInitialLiveCheckForSession, type SessionGuardStorage } from "./initial-live-check.ts";

function memorySessionStorage(initial?: { attempted?: string; suppressed?: string }): SessionGuardStorage {
  const values = new Map<string, string>();
  if (initial?.attempted !== undefined) values.set(INITIAL_LIVE_CHECK_SESSION_KEY, initial.attempted);
  if (initial?.suppressed !== undefined) values.set(INITIAL_LIVE_CHECK_SUPPRESSED_SESSION_KEY, initial.suppressed);
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
  };
}

const restoredLocation = { storageReady: true, hasLocation: true, isFirstLocationForSession: true };
const firstConfirmedLocation = { storageReady: true, hasLocation: true, isFirstLocationForSession: true };

test("restored saved location without a session guard is eligible for one initial automatic check", () => {
  const storage = memorySessionStorage();
  assert.equal(isInitialLiveCheckEligible(restoredLocation), true);
  assert.equal(claimInitialLiveCheck(() => storage), true);
  assert.equal(storage.getItem(INITIAL_LIVE_CHECK_SESSION_KEY), "true");
});

test("first confirmed location with no startup location is eligible for the one initial automatic check", () => {
  assert.equal(firstLocationAutoCheckKey({ storageReady: true, currentLocationKey: null, initialAutoCheckLocationKey: null, selectedLocationKey: "39.91,32.84" }), "39.91,32.84");
  const storage = memorySessionStorage();
  assert.equal(isInitialLiveCheckEligible(firstConfirmedLocation), true);
  assert.equal(claimInitialLiveCheck(() => storage), true);
  assert.equal(claimInitialLiveCheck(() => storage), false);
});

test("a later location change in the same session remains manual", () => {
  assert.equal(firstLocationAutoCheckKey({ storageReady: true, currentLocationKey: "39.91,32.84", initialAutoCheckLocationKey: "39.91,32.84", selectedLocationKey: "41.01,28.97" }), null);
  assert.equal(firstLocationAutoCheckKey({ storageReady: true, currentLocationKey: null, initialAutoCheckLocationKey: "39.91,32.84", selectedLocationKey: "41.01,28.97" }), null);
  const storage = memorySessionStorage({ attempted: "true" });
  assert.equal(isInitialLiveCheckEligible({ storageReady: true, hasLocation: true, isFirstLocationForSession: false }), false);
  assert.equal(claimInitialLiveCheck(() => storage), false);
});

test("saved location with an existing session guard does not auto-check again", () => {
  const storage = memorySessionStorage({ attempted: "true" });
  assert.equal(isInitialLiveCheckEligible(restoredLocation), true);
  assert.equal(claimInitialLiveCheck(() => storage), false);
});

test("missing saved location is not eligible for an initial automatic check", () => {
  assert.equal(isInitialLiveCheckEligible({ storageReady: true, hasLocation: false, isFirstLocationForSession: false }), false);
  assert.equal(isInitialLiveCheckEligible({ storageReady: false, hasLocation: true, isFirstLocationForSession: true }), false);
});

test("later location selections during this session are not eligible", () => {
  assert.equal(isInitialLiveCheckEligible({ storageReady: true, hasLocation: true, isFirstLocationForSession: false }), false);
});

test("a later manually selected location stays manual after a same-session reload", () => {
  const storage = memorySessionStorage();
  suppressInitialLiveCheckForSession(() => storage);
  assert.equal(storage.getItem(INITIAL_LIVE_CHECK_SESSION_KEY), null);
  assert.equal(isInitialLiveCheckEligible(restoredLocation), true);
  assert.equal(claimInitialLiveCheck(() => storage), false);
});

test("a failed automatic request remains marked as attempted", async () => {
  const storage = memorySessionStorage();
  assert.equal(claimInitialLiveCheck(() => storage), true);
  await assert.rejects(Promise.reject(new Error("network failure")), /network failure/);
  assert.equal(claimInitialLiveCheck(() => storage), false);
});

test("session storage failures fail closed while manual checks remain independent", () => {
  const brokenStorage = () => { throw new Error("session storage disabled"); };
  assert.equal(claimInitialLiveCheck(brokenStorage), false);
  assert.equal(claimInitialLiveCheck(() => ({ getItem: () => null, setItem: () => { throw new Error("storage write blocked"); } })), false);
  suppressInitialLiveCheckForSession(brokenStorage);
  let manualCheckCount = 0;
  const checkManually = () => { manualCheckCount += 1; };
  checkManually();
  assert.equal(manualCheckCount, 1);
});
