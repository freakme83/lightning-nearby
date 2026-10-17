import assert from "node:assert/strict";
import test from "node:test";
import {
  FRESH_EVENT_MAX_LATENCY_MS,
  formatActiveAreaSummary,
  summarizeActiveAreaRun,
} from "./workflow-summary.ts";

function line(record: Record<string, unknown>): string { return JSON.stringify(record); }
function event(source: "live2" | "blitzortung", id: string, latencyMs: number): string {
  return line({ kind: "dual_source_event", source, observerEventId: id, latencyMs });
}
function finalization(
  source: "live2" | "blitzortung", id: string, nearest: string | null, matchClass: "strict" | "loose" | "none",
): string {
  return line({ kind: "dual_source_match_finalized", source, observerEventId: id,
    nearestObserverEventId: nearest, matchClass });
}

test("freshness classifies event records using the inclusive 30-second non-negative latency window", () => {
  const summary = summarizeActiveAreaRun([
    event("live2", "live-fresh", 5_000),
    event("live2", "live-boundary", FRESH_EVENT_MAX_LATENCY_MS),
    event("live2", "live-delayed", FRESH_EVENT_MAX_LATENCY_MS + 1),
    event("live2", "live-future", -1),
    event("blitzortung", "blitz-fresh", 1_000),
    event("blitzortung", "blitz-delayed", 323_000),
    event("blitzortung", "blitz-future", -5),
  ]);

  assert.equal(summary.freshLive2Events, 2);
  assert.equal(summary.freshBlitzEvents, 1);
  assert.equal(summary.delayedLive2Events, 2);
  assert.equal(summary.delayedBlitzEvents, 2);
});

test("fresh matched pairs require both event records to be fresh; fresh unmatched events are counted by source", () => {
  const summary = summarizeActiveAreaRun([
    event("live2", "l-fresh-pair", 1_000), event("blitzortung", "b-fresh-pair", 2_000),
    event("live2", "l-mixed-pair", 1_000), event("blitzortung", "b-delayed-pair", 30_001),
    event("live2", "l-fresh-only", 2_000), event("blitzortung", "b-fresh-only", 3_000),
    finalization("live2", "l-fresh-pair", "b-fresh-pair", "strict"),
    finalization("blitzortung", "b-fresh-pair", "l-fresh-pair", "strict"),
    finalization("live2", "l-mixed-pair", "b-delayed-pair", "loose"),
    finalization("blitzortung", "b-delayed-pair", "l-mixed-pair", "loose"),
    finalization("live2", "l-fresh-only", null, "none"),
    finalization("blitzortung", "b-fresh-only", null, "none"),
  ]);

  assert.equal(summary.freshBothMatched, 1);
  assert.equal(summary.freshLive2Only, 1);
  assert.equal(summary.freshBlitzOnly, 1);
});

test("raw counts retain their existing names and full-run values", () => {
  const summary = summarizeActiveAreaRun([
    line({ kind: "dual_source_window_summary", live2EventsObserved: 232, blitzEventsObserved: 42 }),
    finalization("live2", "l-pair", "b-pair", "strict"),
    finalization("blitzortung", "b-pair", "l-pair", "strict"),
    finalization("live2", "l-only", null, "none"),
    finalization("blitzortung", "b-only-1", null, "none"),
    finalization("blitzortung", "b-only-2", null, "none"),
  ]);
  assert.equal(summary.live2EventsObserved, 232);
  assert.equal(summary.blitzEventsObserved, 42);
  assert.equal(summary.bothMatched, 1);
  assert.equal(summary.live2Only, 1);
  assert.equal(summary.blitzOnly, 2);
});

test("health uses latest periodic state before shutdown while reconnects use the latest available state", () => {
  const summary = summarizeActiveAreaRun([
    line({ kind: "dual_source_summary", reason: "periodic",
      live2: { healthy: true, reconnects: 1 }, blitzortung: { healthy: true, reconnects: 2 } }),
    line({ kind: "dual_source_summary", reason: "shutdown",
      live2: { healthy: false, reconnects: 3 }, blitzortung: { healthy: false, reconnects: 4 } }),
  ]);
  assert.equal(summary.live2HealthyBeforeShutdown, true);
  assert.equal(summary.blitzHealthyBeforeShutdown, true);
  assert.equal(summary.live2Healthy, true);
  assert.equal(summary.blitzHealthy, true);
  assert.equal(summary.live2Reconnects, 3);
  assert.equal(summary.blitzReconnects, 4);
});

test("health is null when no periodic operational summary exists", () => {
  const summary = summarizeActiveAreaRun([
    line({ kind: "dual_source_summary", reason: "shutdown",
      live2: { healthy: false, reconnects: 2 }, blitzortung: { healthy: false, reconnects: 1 } }),
  ]);
  assert.equal(summary.live2HealthyBeforeShutdown, null);
  assert.equal(summary.blitzHealthyBeforeShutdown, null);
  assert.equal(summary.live2Reconnects, 2);
  assert.equal(summary.blitzReconnects, 1);
});

test("malformed or empty run logs produce bounded defaults and Markdown separates raw and fresh views", () => {
  const summary = summarizeActiveAreaRun(["bad json", "null"]);
  assert.equal(summary.comparisonAreaMode, "unknown");
  assert.equal(summary.live2EventsObserved, 0);
  assert.equal(summary.bothMatched, 0);
  assert.equal(summary.freshBothMatched, 0);
  assert.match(formatActiveAreaSummary(summary), /### Raw observed[\s\S]*### Fresh \(0–30s latency; max 30000 ms\)[\s\S]*### Operational health before shutdown/);
  assert.match(formatActiveAreaSummary(summary), /Delayed\/backfill \(not fresh; includes future timestamps\)/);
});
