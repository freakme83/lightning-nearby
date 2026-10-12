import { greatCircleDistanceKm } from "../lightning-cg-enrichment/match.ts";
import type { EnrichmentResult } from "../lightning-cg-enrichment/types.ts";
import type { CgPublicationMetadata } from "../lightning-publication-ledger/cg-metadata.ts";
import type { PublicationRecord } from "../lightning-publication-ledger/types.ts";
import { CG_REPEAT_URBAN_MIN_DISTANCE_KM, CG_REPEAT_RURAL_MIN_DISTANCE_KM,
  CG_REPEAT_BURST_WINDOW_MINUTES, CG_REPEAT_MAX_ADMISSIONS_PER_WINDOW,
  CG_REPEAT_SELECTED_MAX_REFERENCE_DELTA_MS, CG_REPEAT_POLICY_VERSION } from "./constants.ts";
import { canonicalPlaceName } from "./location.ts";

export const CG_REPEAT_REASONS = ["already_published_active_incident", "nearby_cooldown",
  "already_active_suppressed_incident"] as const;
export type CgRepeatReason = typeof CG_REPEAT_REASONS[number];
export type CgAdmissionRequest = {
  scopeId: string;
  kind: "initial" | "repeat";
  predecessorScopeId?: string;
  suppressionReason?: CgRepeatReason;
  referenceTime?: string;
  repeatReadyAt?: string;
  policyVersion: typeof CG_REPEAT_POLICY_VERSION;
};
export type CgAdmissionResult = {
  outcome: "inserted" | "already_present" | "suppressed";
  reason: string;
  rollingCount?: number;
  distanceKm?: number;
  thresholdKm?: number;
};

export function selectedRepeatEventCheck(enrichment: EnrichmentResult, referenceTimeMs: number,
  nowMs: number, maxAgeMs: number): string | null {
  const match = enrichment.match;
  if (enrichment.status !== "cg_verified" || enrichment.provider !== "xweather" || match?.type !== "cg") return "not_verified_cg";
  if (!match.id?.trim()) return "missing_provider_identity";
  if (!Number.isSafeInteger(match.eventTimeMs) || !Number.isFinite(referenceTimeMs) ||
      !Number.isFinite(nowMs) || !Number.isFinite(match.latitude) || Math.abs(match.latitude) > 90 ||
      !Number.isFinite(match.longitude) || Math.abs(match.longitude) > 180) return "invalid_selected_event";
  const age = nowMs - match.eventTimeMs;
  if (age < 0 || age > maxAgeMs || nowMs - referenceTimeMs < 0 || nowMs - referenceTimeMs > maxAgeMs ||
      Math.abs(match.eventTimeMs - referenceTimeMs) > CG_REPEAT_SELECTED_MAX_REFERENCE_DELTA_MS) return "selected_event_not_current";
  return null;
}

// Measurement only: removing the empty-history rule is hypothetical. The actual
// atomic admission result, duplicate checks and every other gate stay authoritative.
export function evaluateFirstCgTransitionShadow(input: {
  enrichment: EnrichmentResult;
  metadata: CgPublicationMetadata | null | undefined;
  admission: CgAdmissionResult;
  referenceTimeMs: number;
  nowMs: number;
  maxAgeMs: number;
  providerDuplicatePassed: boolean | null;
  otherBlockers: string[];
}) {
  const currentnessFailure = selectedRepeatEventCheck(input.enrichment, input.referenceTimeMs, input.nowMs, input.maxAgeMs);
  const blockers = [...input.otherBlockers];
  if (input.admission.outcome !== "suppressed" || input.admission.reason !== "no_positive_cg_history") blockers.push("not_empty_cg_history_rejection");
  if (currentnessFailure) blockers.push(currentnessFailure);
  if (input.providerDuplicatePassed !== true) blockers.push(input.providerDuplicatePassed === false ? "provider_duplicate" : "duplicate_check_unavailable");
  if (!input.metadata?.semanticIdentity.available) blockers.push("semantic_identity_unavailable");
  return { policy: "first_cg_transition" as const, shadowOnly: true as const,
    eligible: blockers.length === 0, otherBlockers: [...new Set(blockers)],
    providerDuplicatePassed: input.providerDuplicatePassed, currentnessPassed: currentnessFailure === null,
    semanticIdentityAvailable: input.metadata?.semanticIdentity.available === true,
    classification: input.metadata?.classification ?? null };
}

// Mirrors the transaction's comparison. Positive rows reserve both place and quota,
// regardless of asynchronous approval/publication outcome. A predecessor contributes
// comparison places, never the new scope's burst count.
export function evaluateCgRepeat(candidate: CgPublicationMetadata, history: PublicationRecord[],
  scopeId: string, nowMs: number): Omit<CgAdmissionResult, "outcome"> & { eligible: boolean } {
  const positive = history.filter(row => row.decision === "WOULD_PUBLISH" || row.decision === "PUBLISHED");
  const own = positive.filter(row => row.cgScopeId === scopeId);
  const recent = own.filter(row => Date.parse(row.recordedAt) > nowMs - CG_REPEAT_BURST_WINDOW_MINUTES * 60_000);
  const rollingCount = recent.length;
  const deny = (reason: string, extra = {}) => ({ eligible: false, reason, rollingCount, ...extra });
  if (!candidate.semanticIdentity.available) return deny("semantic_identity_unavailable");
  if (!positive.length) return deny("no_positive_cg_history");
  if (positive.some(row => !row.cgMetadata?.semanticIdentity.available || !Number.isFinite(Date.parse(row.recordedAt)) ||
      Date.parse(row.recordedAt) > nowMs)) return deny("history_unavailable");
  if (rollingCount >= CG_REPEAT_MAX_ADMISSIONS_PER_WINDOW) return deny("burst_limit");
  for (const row of positive) {
    const prior = row.cgMetadata!;
    if (prior.semanticIdentity.available && prior.semanticIdentity.key === candidate.semanticIdentity.key) return deny("same_semantic_location");
    if (prior.semanticIdentity.available && candidate.semanticIdentity.available) {
      const a = candidate.semanticIdentity; const b = prior.semanticIdentity;
      const sameParent = a.components.country === b.components.country && a.components.province === b.components.province &&
        a.components.parent === b.components.parent;
      const district = a.level === "district" ? candidate : b.level === "district" ? prior : null;
      const center = district && district.classification.classification === "urban" &&
        ["city", "town", "municipality"].includes(district.location.rawType ?? "") &&
        district.semanticIdentity.available && canonicalPlaceName(district.location.locality) === district.semanticIdentity.components.parent;
      if (sameParent && district && !center) return deny("semantic_change_unproven");
    }
    const thresholdKm = candidate.classification.classification === "urban" && prior.classification.classification === "urban"
      ? CG_REPEAT_URBAN_MIN_DISTANCE_KM : CG_REPEAT_RURAL_MIN_DISTANCE_KM;
    const distanceKm = greatCircleDistanceKm(candidate, { ...prior, eventTimeMs: Date.parse(prior.eventTime) });
    if (distanceKm < thresholdKm) return deny("distance_below_threshold", { distanceKm, thresholdKm });
  }
  return { eligible: true, reason: "eligible", rollingCount };
}
