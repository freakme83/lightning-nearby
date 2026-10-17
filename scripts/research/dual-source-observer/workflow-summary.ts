import { readFile, writeFile } from "node:fs/promises";

export const FRESH_EVENT_MAX_LATENCY_MS = 30_000;

type JsonRecord = Record<string, unknown>;

export type ActiveAreaWorkflowSummary = {
  comparisonAreaMode: string;
  comparisonCenterLat: number | null;
  comparisonCenterLon: number | null;
  comparisonRadiusKm: number | null;
  durationMinutes: number | null;
  live2EventsObserved: number;
  blitzEventsObserved: number;
  bothMatched: number;
  live2Only: number;
  blitzOnly: number;
  live2Healthy: boolean | null;
  blitzHealthy: boolean | null;
  live2HealthyBeforeShutdown: boolean | null;
  blitzHealthyBeforeShutdown: boolean | null;
  live2Reconnects: number | null;
  blitzReconnects: number | null;
  freshLive2Events: number;
  freshBlitzEvents: number;
  delayedLive2Events: number;
  delayedBlitzEvents: number;
  freshBothMatched: number;
  freshLive2Only: number;
  freshBlitzOnly: number;
};

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

export function summarizeActiveAreaRun(lines: readonly string[]): ActiveAreaWorkflowSummary {
  const records = lines.flatMap(line => {
    try {
      const value: unknown = JSON.parse(line);
      return isRecord(value) ? [value] : [];
    } catch { return []; }
  });
  const start = records.find(record => record.kind === "dual_source_observer_start") ?? {};
  const windows = records.filter(record => record.kind === "dual_source_window_summary");
  const eventRecords = records.filter(record => record.kind === "dual_source_event");
  const finalizations = records.filter(record => record.kind === "dual_source_match_finalized");
  const pairs = new Set<string>();
  const freshPairs = new Set<string>();
  const unmatched = new Set<string>();
  const freshUnmatched = new Set<string>();
  const eventsById = new Map<string, { source: string; fresh: boolean }>();
  const freshCounts = { live2: 0, blitzortung: 0 };
  const delayedCounts = { live2: 0, blitzortung: 0 };
  for (const record of eventRecords) {
    const id = typeof record.observerEventId === "string" ? record.observerEventId : null;
    const source = record.source === "live2" || record.source === "blitzortung" ? record.source : null;
    if (!id || !source) continue;
    const latencyMs = record.latencyMs;
    const fresh = typeof latencyMs === "number" && Number.isFinite(latencyMs) &&
      latencyMs >= 0 && latencyMs <= FRESH_EVENT_MAX_LATENCY_MS;
    eventsById.set(id, { source, fresh });
    if (fresh) freshCounts[source]++;
    else delayedCounts[source]++;
  }
  for (const record of finalizations) {
    const id = typeof record.observerEventId === "string" ? record.observerEventId : null;
    const nearest = typeof record.nearestObserverEventId === "string" ? record.nearestObserverEventId : null;
    if ((record.matchClass === "strict" || record.matchClass === "loose") && id && nearest) {
      const pairKey = [id, nearest].sort().join("\0");
      pairs.add(pairKey);
      if (eventsById.get(id)?.fresh === true && eventsById.get(nearest)?.fresh === true) freshPairs.add(pairKey);
    } else if (record.matchClass === "none" && id) {
      const source = record.source === "live2" || record.source === "blitzortung" ? record.source : null;
      if (source) {
        const key = `${source}\0${id}`;
        unmatched.add(key);
        if (eventsById.get(id)?.fresh === true) freshUnmatched.add(key);
      }
    }
  }
  const summaries = records.filter(record => record.kind === "dual_source_summary");
  const latest = summaries.at(-1) ?? {};
  const beforeShutdown = summaries.filter(record => record.reason === "periodic").at(-1) ?? {};
  const latestLive2 = isRecord(latest.live2) ? latest.live2 : {};
  const latestBlitz = isRecord(latest.blitzortung) ? latest.blitzortung : {};
  const operationalLive2 = isRecord(beforeShutdown.live2) ? beforeShutdown.live2 : {};
  const operationalBlitz = isRecord(beforeShutdown.blitzortung) ? beforeShutdown.blitzortung : {};
  const numberOrNull = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) ? value : null;
  const inputNumber = (name: string): number | null => {
    const value = process.env[name];
    if (value === undefined || value.trim() === "") return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  };
  const booleanOrNull = (value: unknown): boolean | null => typeof value === "boolean" ? value : null;
  return {
    comparisonAreaMode: typeof start.comparisonAreaMode === "string" ? start.comparisonAreaMode : "unknown",
    comparisonCenterLat: numberOrNull(start.comparisonCenterLat) ?? inputNumber("ACTIVE_AREA_CENTER_LAT"),
    comparisonCenterLon: numberOrNull(start.comparisonCenterLon) ?? inputNumber("ACTIVE_AREA_CENTER_LON"),
    comparisonRadiusKm: numberOrNull(start.comparisonRadiusKm) ?? inputNumber("ACTIVE_AREA_RADIUS_KM"),
    durationMinutes: numberOrNull(start.durationMinutes) ?? inputNumber("ACTIVE_AREA_DURATION_MINUTES"),
    live2EventsObserved: windows.reduce((sum, record) => sum + safeCount(record.live2EventsObserved), 0),
    blitzEventsObserved: windows.reduce((sum, record) => sum + safeCount(record.blitzEventsObserved), 0),
    bothMatched: pairs.size,
    live2Only: [...unmatched].filter(key => key.startsWith("live2\0")).length,
    blitzOnly: [...unmatched].filter(key => key.startsWith("blitzortung\0")).length,
    live2Healthy: booleanOrNull(operationalLive2.healthy),
    blitzHealthy: booleanOrNull(operationalBlitz.healthy),
    live2HealthyBeforeShutdown: booleanOrNull(operationalLive2.healthy),
    blitzHealthyBeforeShutdown: booleanOrNull(operationalBlitz.healthy),
    live2Reconnects: numberOrNull(latestLive2.reconnects) ?? numberOrNull(operationalLive2.reconnects),
    blitzReconnects: numberOrNull(latestBlitz.reconnects) ?? numberOrNull(operationalBlitz.reconnects),
    freshLive2Events: freshCounts.live2,
    freshBlitzEvents: freshCounts.blitzortung,
    delayedLive2Events: delayedCounts.live2,
    delayedBlitzEvents: delayedCounts.blitzortung,
    freshBothMatched: freshPairs.size,
    freshLive2Only: [...freshUnmatched].filter(key => key.startsWith("live2\0")).length,
    freshBlitzOnly: [...freshUnmatched].filter(key => key.startsWith("blitzortung\0")).length,
  };
}

export function formatActiveAreaSummary(summary: ActiveAreaWorkflowSummary): string {
  const center = summary.comparisonCenterLat === null || summary.comparisonCenterLon === null
    ? "not reported"
    : `${summary.comparisonCenterLat}, ${summary.comparisonCenterLon}`;
  return [
    "## Dual-source active-area research run",
    "",
    `- Area mode: ${summary.comparisonAreaMode}`,
    `- Center: ${center}`,
    `- Radius: ${summary.comparisonRadiusKm ?? "not reported"} km`,
    `- Duration: ${summary.durationMinutes ?? "not reported"} minutes`,
    "",
    "### Raw observed",
    `- live2: ${summary.live2EventsObserved}`,
    `- Blitz: ${summary.blitzEventsObserved}`,
    `- Both matched: ${summary.bothMatched}`,
    `- live2-only: ${summary.live2Only}`,
    `- Blitz-only: ${summary.blitzOnly}`,
    "",
    `### Fresh (latency 0–${FRESH_EVENT_MAX_LATENCY_MS} ms)`,
    `- live2: ${summary.freshLive2Events}`,
    `- Blitz: ${summary.freshBlitzEvents}`,
    `- Both matched: ${summary.freshBothMatched}`,
    `- live2-only: ${summary.freshLive2Only}`,
    `- Blitz-only: ${summary.freshBlitzOnly}`,
    "",
    "### Delayed/backfill (not fresh)",
    `- live2: ${summary.delayedLive2Events}`,
    `- Blitz: ${summary.delayedBlitzEvents}`,
    "",
    "### Operational health before shutdown",
    `- live2: ${summary.live2HealthyBeforeShutdown ?? "unknown"}`,
    `- Blitz: ${summary.blitzHealthyBeforeShutdown ?? "unknown"}`,
    "",
    `- Reconnects: live2=${summary.live2Reconnects ?? "unknown"}, Blitz=${summary.blitzReconnects ?? "unknown"}`,
  ].join("\n");
}

if (process.argv[1]?.endsWith("workflow-summary.ts")) {
  const [logPath, jsonPath, markdownPath] = process.argv.slice(2);
  if (!logPath || !jsonPath || !markdownPath) throw new Error("usage: workflow-summary.ts <jsonl> <summary-json> <step-summary>");
  const content = await readFile(logPath, "utf8");
  const summary = summarizeActiveAreaRun(content.split(/\r?\n/).filter(Boolean));
  await writeFile(jsonPath, `${JSON.stringify(summary, null, 2)}\n`);
  const markdown = formatActiveAreaSummary(summary);
  await writeFile(markdownPath, `${markdown}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) await writeFile(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`, { flag: "a" });
  console.log(JSON.stringify(summary));
}
