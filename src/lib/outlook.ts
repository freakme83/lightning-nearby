import { fetchEnsembleForecast, type EnsembleForecast, type EnsembleThunderstormSupport } from "./ensemble.ts";
import { fetchForecast, type Forecast, type ForecastHour, type RiskLevel } from "./weather.ts";

export type HourSignal =
  | { kind: "provider-probability"; percent: number }
  | { kind: "ensemble-support"; support: EnsembleThunderstormSupport }
  | { kind: "derived"; risk: RiskLevel }
  | { kind: "unavailable" };

export interface OutlookHour extends ForecastHour {
  ensembleSupport?: EnsembleThunderstormSupport;
  signal: HourSignal;
}

export interface Outlook {
  timezone: string;
  hours: OutlookHour[];
  fetchedAt: number;
  ensembleFetchedAt?: number;
}

/** Choose an independent source for each exact Unix-hour timestamp. */
export function combineForecasts(deterministic: Forecast | null, ensemble: EnsembleForecast | null): Outlook | null {
  if (!deterministic && !ensemble) return null;
  const byTime = new Map<number, OutlookHour>();
  for (const hour of deterministic?.hours ?? []) {
    if (!Number.isInteger(hour.time) || hour.time % 3_600 !== 0) continue;
    const signal: HourSignal = hour.thunderstormProbability != null
      ? { kind: "provider-probability", percent: hour.thunderstormProbability }
      : hour.risk != null ? { kind: "derived", risk: hour.risk } : { kind: "unavailable" };
    byTime.set(hour.time, { ...hour, signal });
  }
  for (const support of ensemble?.hours ?? []) {
    if (!Number.isInteger(support.time) || support.time % 3_600 !== 0) continue;
    const hour = byTime.get(support.time) ?? { time: support.time, signal: { kind: "unavailable" } as HourSignal };
    hour.ensembleSupport = support;
    if (hour.signal.kind !== "provider-probability") hour.signal = { kind: "ensemble-support", support };
    byTime.set(support.time, hour);
  }
  const hours = [...byTime.values()].sort((a, b) => a.time - b.time);
  if (!hours.some((hour) => hour.signal.kind !== "unavailable")) return null;
  return {
    timezone: deterministic?.timezone ?? ensemble!.timezone,
    hours,
    fetchedAt: Math.max(deterministic?.fetchedAt ?? 0, ensemble?.fetchedAt ?? 0),
    ...(ensemble ? { ensembleFetchedAt: ensemble.fetchedAt } : {}),
  };
}

type ForecastLoader = (latitude: number, longitude: number, signal?: AbortSignal) => Promise<Forecast>;
type EnsembleLoader = (latitude: number, longitude: number, signal?: AbortSignal) => Promise<EnsembleForecast>;

/** Both sources can fail independently; a usable one still produces an outlook. */
export async function fetchOutlook(
  latitude: number,
  longitude: number,
  signal?: AbortSignal,
  loadForecast: ForecastLoader = fetchForecast,
  loadEnsemble: EnsembleLoader = fetchEnsembleForecast,
): Promise<Outlook> {
  const [deterministic, ensemble] = await Promise.allSettled([
    loadForecast(latitude, longitude, signal),
    loadEnsemble(latitude, longitude, signal),
  ]);
  if (signal?.aborted) throw signal.reason ?? new DOMException("Forecast cancelled", "AbortError");
  const result = combineForecasts(
    deterministic.status === "fulfilled" ? deterministic.value : null,
    ensemble.status === "fulfilled" ? ensemble.value : null,
  );
  if (!result) throw new Error("forecast-insufficient");
  return result;
}

export interface SignalWindow {
  start: number;
  end: number;
  signal: Exclude<HourSignal, { kind: "unavailable" }>;
}

const DERIVED_SEVERITY: Record<RiskLevel, number> = { low: 0, elevated: 1, high: 2 };
const PRIORITY: Record<HourSignal["kind"], number> = {
  "provider-probability": 3, "ensemble-support": 2, derived: 1, unavailable: 0,
};

function positive(signal: HourSignal): boolean {
  switch (signal.kind) {
    case "provider-probability": return signal.percent > 0;
    case "ensemble-support": return signal.support.supportingMembers > 0;
    case "derived": return signal.risk !== "low";
    case "unavailable": return false;
  }
}

function compareSignals(a: HourSignal, b: HourSignal): number {
  if (a.kind !== b.kind) return PRIORITY[a.kind] - PRIORITY[b.kind];
  if (a.kind === "provider-probability" && b.kind === "provider-probability") return a.percent - b.percent;
  if (a.kind === "ensemble-support" && b.kind === "ensemble-support") {
    return a.support.supportingMembers * b.support.availableMembers
      - b.support.supportingMembers * a.support.availableMembers;
  }
  if (a.kind === "derived" && b.kind === "derived") return DERIVED_SEVERITY[a.risk] - DERIVED_SEVERITY[b.risk];
  return 0;
}

function samePeak(a: HourSignal, b: HourSignal): boolean {
  if (a.kind !== b.kind || compareSignals(a, b) !== 0) return false;
  if (a.kind === "ensemble-support" && b.kind === "ensemble-support") {
    return a.support.supportingMembers === b.support.supportingMembers
      && a.support.availableMembers === b.support.availableMembers && a.support.model === b.support.model;
  }
  return true;
}

/** Rank positive signals by source, then by provider percent, member share, or derived severity. */
export function calculateStrongestSignalWindow(hours: OutlookHour[]): SignalWindow | null {
  const candidates = hours.filter((hour) => positive(hour.signal));
  if (!candidates.length) return null;
  const best = candidates.reduce((current, hour) => compareSignals(hour.signal, current.signal) > 0 ? hour : current);
  const windows: SignalWindow[] = [];
  let run: OutlookHour[] = [];
  const save = () => {
    if (run.length) windows.push({ start: run[0].time, end: run[run.length - 1].time + 3_600,
      signal: run[0].signal as SignalWindow["signal"] });
    run = [];
  };
  for (const hour of hours) {
    if (!positive(hour.signal) || !samePeak(hour.signal, best.signal)) { save(); continue; }
    if (run.length && hour.time !== run[run.length - 1].time + 3_600) save();
    run.push(hour);
  }
  save();
  return windows.sort((a, b) => (b.end - b.start) - (a.end - a.start) || a.start - b.start)[0] ?? null;
}
