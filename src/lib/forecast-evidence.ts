import type { LocalEnsembleThunderstormSupport } from "./ensemble.ts";
import { isThunderstormCode, RISK_THRESHOLDS, type RiskInputs, type RiskLevel } from "./weather.ts";

export type DeterministicEvidenceSource =
  | "direct-thunderstorm-code" | "direct-provider-probability" | "cape-precip-fallback"
  | "weather-code-only" | "partial-deterministic" | "insufficient";
/** Describes input coverage, not calibrated confidence or a negative-event probability. */
export type DeterministicEvidenceQuality = "direct" | "ingredients" | "weak" | "partial" | "insufficient";
export type ForecastConflictFlag =
  | "low-direct-probability-vs-strong-fallback"
  | "thunderstorm-code-vs-low-direct-probability"
  | "low-deterministic-vs-positive-ensemble"
  | "high-elevated-deterministic-vs-zero-ensemble";
export type ExactPointVsEnsembleAgreement =
  | "broad-agreement" | "low-with-positive-ensemble" | "high-elevated-with-zero-ensemble"
  | "ensemble-unavailable" | "deterministic-unavailable";

export interface ForecastEvidenceSummary {
  deterministicEvidenceSource: DeterministicEvidenceSource;
  deterministicEvidenceQuality: DeterministicEvidenceQuality;
  conflictFlags: ForecastConflictFlag[];
  /** null means no usable ensemble count; missing is never a negative vote. */
  ensembleSupportPresent: boolean | null;
  ensembleSupportAbsent: boolean | null;
  exactPointVsEnsembleAgreement: ExactPointVsEnsembleAgreement;
}

function validProbability(value: number | null | undefined): value is number {
  return value != null && Number.isFinite(value) && value >= 0 && value <= 100;
}

function validCape(value: number | null | undefined): value is number {
  return value != null && Number.isFinite(value) && value >= 0;
}

/** Describe the strongest usable deterministic input source without classifying the hour. */
export function describeDeterministicEvidence(input: RiskInputs): Pick<ForecastEvidenceSummary,
  "deterministicEvidenceSource" | "deterministicEvidenceQuality"> {
  let source: DeterministicEvidenceSource;
  let quality: DeterministicEvidenceQuality;
  if (isThunderstormCode(input.weatherCode)) {
    source = "direct-thunderstorm-code"; quality = "direct";
  } else if (validProbability(input.thunderstormProbability)) {
    source = "direct-provider-probability"; quality = "direct";
  } else if (validCape(input.cape) && validProbability(input.precipitationProbability)) {
    // Complete ingredients below the thresholds also belong here, including Low hours.
    source = "cape-precip-fallback"; quality = "ingredients";
  } else if (validCape(input.cape) || validProbability(input.precipitationProbability)) {
    source = "partial-deterministic"; quality = "partial";
  } else if (input.weatherCode != null && Number.isInteger(input.weatherCode) && input.weatherCode >= 0 && input.weatherCode <= 99) {
    source = "weather-code-only"; quality = "weak";
  } else {
    // CIN alone cannot establish thunderstorm evidence.
    source = "insufficient"; quality = "insufficient";
  }
  return { deterministicEvidenceSource: source, deterministicEvidenceQuality: quality };
}

/** Research-only tensions. The supplied production risk is observed, never changed. */
export function summarizeForecastEvidence(
  input: RiskInputs,
  risk: RiskLevel | undefined,
  ensemble?: LocalEnsembleThunderstormSupport,
): ForecastEvidenceSummary {
  const conflictFlags: ForecastConflictFlag[] = [];
  const lowDirect = validProbability(input.thunderstormProbability)
    && input.thunderstormProbability < RISK_THRESHOLDS.directThunderstormProbabilityElevated;
  const strongFallback = validCape(input.cape) && input.cape >= RISK_THRESHOLDS.elevatedCapeJPerKg
    && validProbability(input.precipitationProbability)
    && input.precipitationProbability >= RISK_THRESHOLDS.elevatedPrecipitationProbabilityPercent;
  if (lowDirect && strongFallback) conflictFlags.push("low-direct-probability-vs-strong-fallback");
  if (lowDirect && isThunderstormCode(input.weatherCode)) conflictFlags.push("thunderstorm-code-vs-low-direct-probability");

  const usableEnsemble = ensemble != null && Number.isInteger(ensemble.availableMembers) && ensemble.availableMembers > 0
    && Number.isInteger(ensemble.supportingMembers) && ensemble.supportingMembers >= 0
    && ensemble.supportingMembers <= ensemble.availableMembers;
  const ensembleSupportPresent = usableEnsemble ? ensemble.supportingMembers > 0 : null;
  const ensembleSupportAbsent = usableEnsemble ? ensemble.supportingMembers === 0 : null;
  let agreement: ExactPointVsEnsembleAgreement;
  if (!usableEnsemble) agreement = "ensemble-unavailable";
  else if (!risk) agreement = "deterministic-unavailable";
  else if (risk === "low" && ensembleSupportPresent) {
    agreement = "low-with-positive-ensemble";
    conflictFlags.push("low-deterministic-vs-positive-ensemble");
  } else if (risk !== "low" && ensembleSupportAbsent) {
    agreement = "high-elevated-with-zero-ensemble";
    conflictFlags.push("high-elevated-deterministic-vs-zero-ensemble");
  } else agreement = "broad-agreement";
  return {
    ...describeDeterministicEvidence(input), conflictFlags, ensembleSupportPresent, ensembleSupportAbsent,
    exactPointVsEnsembleAgreement: agreement,
  };
}

export const ENSEMBLE_AGREEMENT_LABELS: Record<ExactPointVsEnsembleAgreement, string> = {
  "broad-agreement": "Deterministic and ensemble broadly agree",
  "low-with-positive-ensemble": "Deterministic Low with positive nearby ensemble support",
  "high-elevated-with-zero-ensemble": "Deterministic High/Elevated with zero nearby ensemble support",
  "ensemble-unavailable": "Ensemble unavailable for this hour",
  "deterministic-unavailable": "Deterministic qualitative result unavailable; ensemble remains secondary evidence",
};
