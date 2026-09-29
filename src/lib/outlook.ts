import { fetchEnsembleForecast, type EnsembleForecast, type LocalEnsembleThunderstormSupport } from "./ensemble.ts";
import { explainRiskDecision, fetchForecast, hasRiskEvidence, type Forecast, type ForecastHour, type RiskInputs, type RiskLevel } from "./weather.ts";

export interface ThunderstormEvidence {
  providerProbability?: number;
  deterministic?: {
    weatherCode?: number;
    precipitationProbability?: number;
    cape?: number;
    convectiveInhibition?: number;
    risk?: RiskLevel;
  };
  ensemble?: LocalEnsembleThunderstormSupport;
}

export type HourSignal = { kind: "qualitative"; risk: RiskLevel } | { kind: "unavailable" };

export interface SignalDecisionExplanation {
  qualitative: string;
  ensemble: string;
}

function evidenceRiskInputs(evidence: ThunderstormEvidence): RiskInputs {
  return {
    weatherCode: evidence.deterministic?.weatherCode,
    thunderstormProbability: evidence.providerProbability,
    precipitationProbability: evidence.deterministic?.precipitationProbability,
    cape: evidence.deterministic?.cape,
    convectiveInhibition: evidence.deterministic?.convectiveInhibition,
  };
}

function decisionFromEvidence(evidence: ThunderstormEvidence) {
  const inputs = evidenceRiskInputs(evidence);
  if (hasRiskEvidence(inputs)) return explainRiskDecision(inputs);
  const normalizedRisk = evidence.deterministic?.risk;
  if (normalizedRisk) {
    return {
      risk: normalizedRisk,
      explanation: `${normalizedRisk[0].toUpperCase()}${normalizedRisk.slice(1)} because the normalized deterministic forecast already carries this qualitative result; raw inputs are unavailable.`,
    };
  }
  return null;
}

export interface OutlookHour extends ForecastHour {
  evidence: ThunderstormEvidence;
  signal: HourSignal;
}

export interface Outlook {
  timezone: string;
  hours: OutlookHour[];
  fetchedAt: number;
  ensembleFetchedAt?: number;
}

/** Only provider and deterministic inputs determine the qualitative level. */
export function deriveSignal(evidence: ThunderstormEvidence): HourSignal {
  const decision = decisionFromEvidence(evidence);
  return decision ? { kind: "qualitative", risk: decision.risk } : { kind: "unavailable" };
}

/** Explain the exact shared classifier result; ensemble support is narrated separately and never promotes it. */
export function explainSignalDecision(evidence: ThunderstormEvidence): SignalDecisionExplanation {
  const decision = decisionFromEvidence(evidence);
  const qualitative = decision
    ? decision.explanation
    : "Qualitative signal unavailable because required deterministic/provider inputs are missing.";
  const support = evidence.ensemble;
  let ensemble: string;
  if (!support) {
    ensemble = "Ensemble support unavailable for this hour; no usable member count is available.";
  } else if (support.supportingMembers === 0) {
    ensemble = `Ensemble support: 0 / ${support.availableMembers} model members. Zero support does not override deterministic evidence and does not mean zero thunderstorm probability.`;
  } else {
    ensemble = `Ensemble support: ${support.supportingMembers} / ${support.availableMembers} model members. This is secondary evidence and does not change the qualitative level.`;
  }
  return { qualitative, ensemble };
}

/** Keep independent evidence sources together at exact Unix-hour timestamps. */
export function combineForecasts(deterministic: Forecast | null, ensemble: EnsembleForecast | null): Outlook | null {
  if (!deterministic && !ensemble) return null;
  const byTime = new Map<number, OutlookHour>();
  for (const hour of deterministic?.hours ?? []) {
    if (!Number.isInteger(hour.time) || hour.time % 3_600 !== 0) continue;
    const evidence: ThunderstormEvidence = {
      ...(hour.thunderstormProbability != null ? { providerProbability: hour.thunderstormProbability } : {}),
      deterministic: {
        weatherCode: hour.weatherCode,
        precipitationProbability: hour.precipitationProbability,
        cape: hour.cape,
        convectiveInhibition: hour.convectiveInhibition,
        risk: hour.risk,
      },
    };
    byTime.set(hour.time, { ...hour, evidence, signal: deriveSignal(evidence) });
  }
  for (const support of ensemble?.hours ?? []) {
    if (!Number.isInteger(support.time) || support.time % 3_600 !== 0 || support.availableMembers < 1) continue;
    const hour = byTime.get(support.time) ?? { time: support.time, evidence: {}, signal: { kind: "unavailable" } as HourSignal };
    hour.evidence.ensemble = support;
    hour.signal = deriveSignal(hour.evidence);
    byTime.set(support.time, hour);
  }
  const hours = [...byTime.values()].sort((a, b) => a.time - b.time);
  if (!hours.length) return null;
  return {
    timezone: deterministic?.timezone ?? ensemble!.timezone,
    hours,
    fetchedAt: Math.max(deterministic?.fetchedAt ?? 0, ensemble?.fetchedAt ?? 0),
    ...(ensemble ? { ensembleFetchedAt: ensemble.fetchedAt } : {}),
  };
}

/** Add late ensemble evidence without changing primary forecast times or update time. */
export function mergeEnsembleEvidence(outlook: Outlook, ensemble: EnsembleForecast): Outlook {
  const supportByTime = new Map(ensemble.hours
    .filter((support) => Number.isInteger(support.time) && support.time % 3_600 === 0 && support.availableMembers > 0)
    .map((support) => [support.time, support] as const));
  const hours = outlook.hours.map((hour) => {
    const support = supportByTime.get(hour.time);
    if (!support) return hour;
    const evidence: ThunderstormEvidence = { ...hour.evidence, ensemble: support };
    return { ...hour, evidence, signal: deriveSignal(evidence) };
  });
  return { ...outlook, hours, ensembleFetchedAt: ensemble.fetchedAt };
}

export function retainSelectedHour(selected: number | null, hours: ForecastHour[]): number | null {
  return selected != null && hours.some((hour) => hour.time === selected) ? selected : hours[0]?.time ?? null;
}

export function isCurrentForecastRequest(requestId: number, currentRequestId: number, signal?: AbortSignal): boolean {
  return !signal?.aborted && requestId === currentRequestId;
}

type ForecastLoader = (latitude: number, longitude: number, signal?: AbortSignal) => Promise<Forecast>;
type EnsembleLoader = (latitude: number, longitude: number, signal?: AbortSignal) => Promise<EnsembleForecast>;

export interface OutlookRequests {
  primary: Promise<Outlook>;
  ensemble: Promise<EnsembleForecast | null>;
}

/** Start both sources immediately; resolve the primary outlook without waiting for ensemble data. */
export function fetchOutlook(
  latitude: number,
  longitude: number,
  signal?: AbortSignal,
  loadForecast: ForecastLoader = fetchForecast,
  loadEnsemble: EnsembleLoader = fetchEnsembleForecast,
): OutlookRequests {
  const deterministic = Promise.resolve().then(() => loadForecast(latitude, longitude, signal));
  const ensemble = Promise.resolve().then(() => loadEnsemble(latitude, longitude, signal))
    .then((result) => signal?.aborted ? null : result, () => null);
  const primary = deterministic.then((result) => {
    if (signal?.aborted) throw signal.reason ?? new DOMException("Forecast cancelled", "AbortError");
    const outlook = combineForecasts(result, null);
    if (!outlook) throw new Error("forecast-insufficient");
    return outlook;
  });
  return { primary, ensemble };
}

export interface SignalWindow { start: number; end: number; risk: Exclude<RiskLevel, "low"> }

export function summarizeSignal(window: SignalWindow | null, periodText = ""): string {
  if (!window) return "No elevated thunderstorm signal in the available forecast hours. Local storms remain possible.";
  return window.risk === "high"
    ? `Thunderstorm conditions are indicated in the forecast. Strongest period: ${periodText}.`
    : `Thunderstorm activity is plausible near this location around ${periodText}.`;
}

const SEVERITY: Record<RiskLevel, number> = { low: 0, elevated: 1, high: 2 };

/** Highest qualitative level, then longest contiguous period, then earliest. No member-share scoring. */
export function calculateStrongestSignalWindow(hours: OutlookHour[]): SignalWindow | null {
  const peak = Math.max(0, ...hours.map((hour) => hour.signal.kind === "qualitative" ? SEVERITY[hour.signal.risk] : 0));
  if (peak === 0) return null;
  const windows: SignalWindow[] = [];
  let run: OutlookHour[] = [];
  const save = () => {
    if (run.length) windows.push({ start: run[0].time, end: run[run.length - 1].time + 3_600,
      risk: (run[0].signal as Extract<HourSignal, { kind: "qualitative" }>).risk as Exclude<RiskLevel, "low"> });
    run = [];
  };
  for (const hour of hours) {
    const isPeak = hour.signal.kind === "qualitative" && SEVERITY[hour.signal.risk] === peak;
    if (!isPeak) { save(); continue; }
    if (run.length && hour.time !== run[run.length - 1].time + 3_600) save();
    run.push(hour);
  }
  save();
  return windows.sort((a, b) => (b.end - b.start) - (a.end - a.start) || a.start - b.start)[0] ?? null;
}
