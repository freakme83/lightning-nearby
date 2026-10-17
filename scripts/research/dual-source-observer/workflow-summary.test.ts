import assert from "node:assert/strict";
import test from "node:test";
import { formatActiveAreaSummary, summarizeActiveAreaRun } from "./workflow-summary.ts";

test("workflow summary reuses observer windows and finalizations", () => {
  const records = [
    { kind: "dual_source_observer_start", comparisonAreaMode: "custom-radius", comparisonCenterLat: 12, comparisonCenterLon: 34, comparisonRadiusKm: 75, durationMinutes: 30 },
    { kind: "dual_source_window_summary", live2EventsObserved: 4, blitzEventsObserved: 3 },
    { kind: "dual_source_match_finalized", source: "live2", observerEventId: "l1", nearestObserverEventId: "b1", matchClass: "strict" },
    { kind: "dual_source_match_finalized", source: "blitzortung", observerEventId: "b1", nearestObserverEventId: "l1", matchClass: "strict" },
    { kind: "dual_source_match_finalized", source: "live2", observerEventId: "l2", nearestObserverEventId: null, matchClass: "none" },
    { kind: "dual_source_summary", live2: { healthy: false, reconnects: 1 }, blitzortung: { healthy: true, reconnects: 0 } },
  ].map(record => JSON.stringify(record));
  const summary = summarizeActiveAreaRun(records);
  assert.deepEqual(summary, {
    comparisonAreaMode: "custom-radius", comparisonCenterLat: 12, comparisonCenterLon: 34,
    comparisonRadiusKm: 75, durationMinutes: 30, live2EventsObserved: 4, blitzEventsObserved: 3,
    bothMatched: 1, live2Only: 1, blitzOnly: 0, live2Healthy: false, blitzHealthy: true,
    live2Reconnects: 1, blitzReconnects: 0,
  });
  assert.match(formatActiveAreaSummary(summary), /Both matched: 1/);
});

test("malformed or empty run logs produce a bounded no-data summary", () => {
  const summary = summarizeActiveAreaRun(["bad json", "null"]);
  assert.equal(summary.comparisonAreaMode, "unknown");
  assert.equal(summary.live2EventsObserved, 0);
  assert.equal(summary.bothMatched, 0);
});
