import { DEFAULT_THRESHOLDS, greatCircleDistanceKm, matchLightningEvents, rankLightningMatches,
  validateReference } from "./match.ts";
import type { CostDiagnostics, EnrichmentReference, EnrichmentResult, InitialCgDiagnostics,
  LightningMatch, XweatherLightningEvent } from "./types.ts";

export const INITIAL_CG_MAX_DISTANCE_KM = 10;
export const INITIAL_CG_MAX_REFERENCE_DELTA_MS = 150_000;
export const INITIAL_CG_MAX_PROVIDER_AGE_MS = 240_000;

type Candidate = LightningMatch & { providerAgeMs: number; spatial: boolean; temporal: boolean; current: boolean };

function candidate(reference: EnrichmentReference, event: XweatherLightningEvent, nowMs: number): Candidate {
  const valid = Number.isFinite(event.latitude) && Math.abs(event.latitude) <= 90 &&
    Number.isFinite(event.longitude) && Math.abs(event.longitude) <= 180 &&
    Number.isSafeInteger(event.eventTimeMs) && event.eventTimeMs >= 0 && Boolean(event.id?.trim());
  const distanceKm = valid ? greatCircleDistanceKm(event, reference) : Infinity;
  const timeDifferenceMs = valid ? Math.abs(event.eventTimeMs - reference.eventTimeMs) : Infinity;
  const providerAgeMs = valid && Number.isFinite(nowMs) ? nowMs - event.eventTimeMs : Infinity;
  return { ...event, distanceKm, timeDifferenceMs, providerAgeMs,
    spatial: distanceKm <= INITIAL_CG_MAX_DISTANCE_KM,
    temporal: timeDifferenceMs <= INITIAL_CG_MAX_REFERENCE_DELTA_MS,
    current: providerAgeMs >= 0 && providerAgeMs <= INITIAL_CG_MAX_PROVIDER_AGE_MS };
}

function diagnostics(candidates: Candidate[], selected: Candidate | undefined): InitialCgDiagnostics {
  const evaluated = selected ?? [...candidates].sort(rankLightningMatches)[0];
  const outcome: InitialCgDiagnostics["outcome"] = selected ? "accepted" : candidates.length === 0 ? "no_cg_returned" :
    candidates.some(item => item.spatial && item.temporal) ? "rejected_provider_stale" :
    candidates.some(item => item.spatial) ? "rejected_reference_time" : "rejected_spatial";
  return { outcome, returnedCg: candidates.length,
    rejectedSpatial: candidates.filter(item => !item.spatial).length,
    rejectedReferenceTime: candidates.filter(item => !item.temporal).length,
    rejectedProviderStale: candidates.filter(item => !item.current).length,
    selectedProviderEventId: selected?.id ?? null, selectedDistanceKm: selected?.distanceKm ?? null,
    selectedReferenceDeltaMs: selected?.timeDifferenceMs ?? null, selectedProviderAgeMs: selected?.providerAgeMs ?? null,
    evaluatedProviderEventId: evaluated?.id ?? null, evaluatedDistanceKm: evaluated?.distanceKm ?? null,
    evaluatedReferenceDeltaMs: evaluated?.timeDifferenceMs ?? null, evaluatedProviderAgeMs: evaluated?.providerAgeMs ?? null };
}

/** Association with an independently qualified incident, not proof of the same LightningMaps flash. */
export function matchInitialCgEvents(reference: EnrichmentReference, events: XweatherLightningEvent[],
  nowMs: number, cost?: CostDiagnostics): EnrichmentResult {
  validateReference(reference);
  const cg = events.filter(event => event.type === "cg").map(event => candidate(reference, event, nowMs));
  const selected = cg.filter(item => item.spatial && item.temporal && item.current)
    .sort(rankLightningMatches)[0];
  // Keep the older IC matching and raw returned/matched diagnostics for the non-CG fallback.
  const raw = matchLightningEvents(reference, events, DEFAULT_THRESHOLDS, cost);
  const ic = matchLightningEvents(reference, events.filter(event => event.type === "ic"), DEFAULT_THRESHOLDS, cost);
  const base = { ...raw };
  delete base.match;
  const initialCgDiagnostics = diagnostics(cg, selected);
  if (selected) {
    const match: LightningMatch = { id: selected.id, type: selected.type,
      latitude: selected.latitude, longitude: selected.longitude, eventTimeMs: selected.eventTimeMs,
      distanceKm: selected.distanceKm, timeDifferenceMs: selected.timeDifferenceMs,
      ...(selected.peakAmp === undefined ? {} : { peakAmp: selected.peakAmp }),
      ...(selected.numSensors === undefined ? {} : { numSensors: selected.numSensors }) };
    return { ...base, status: "cg_verified", match, initialCgDiagnostics };
  }
  return { ...base, status: ic.status, ...(ic.match ? { match: ic.match } : {}), initialCgDiagnostics };
}

/** Last gate before an initial artifact reaches reverse geocoding and the composer. */
export function enforceInitialCgAcceptance(enrichment: EnrichmentResult, nowMs: number): EnrichmentResult {
  if (enrichment.status !== "cg_verified") {
    if (enrichment.initialCgDiagnostics) return enrichment;
    const returnedCg = enrichment.matchDiagnostics?.returnedCg ??
      (enrichment.counts?.returned === 0 ? 0 : null);
    return { ...enrichment, initialCgDiagnostics: {
      outcome: enrichment.status === "provider_unavailable" ? "provider_unavailable" :
        returnedCg === 0 ? "no_cg_returned" : "no_eligible_cg",
      returnedCg, rejectedSpatial: 0, rejectedReferenceTime: 0, rejectedProviderStale: 0,
      selectedProviderEventId: null, selectedDistanceKm: null, selectedReferenceDeltaMs: null,
      selectedProviderAgeMs: null, evaluatedProviderEventId: null, evaluatedDistanceKm: null,
      evaluatedReferenceDeltaMs: null, evaluatedProviderAgeMs: null,
    } };
  }
  const match = enrichment.match;
  const checked = match?.type === "cg" ? candidate(enrichment.reference, match, nowMs) : undefined;
  if (checked?.spatial && checked.temporal && checked.current) {
    const selected = diagnostics([checked], checked);
    return { ...enrichment, initialCgDiagnostics: { ...selected, ...enrichment.initialCgDiagnostics,
      outcome: "accepted", selectedProviderEventId: checked.id,
      selectedDistanceKm: checked.distanceKm, selectedReferenceDeltaMs: checked.timeDifferenceMs,
      selectedProviderAgeMs: checked.providerAgeMs,
      evaluatedProviderEventId: checked.id, evaluatedDistanceKm: checked.distanceKm,
      evaluatedReferenceDeltaMs: checked.timeDifferenceMs, evaluatedProviderAgeMs: checked.providerAgeMs } };
  }
  const rejected = checked ? diagnostics([checked], undefined) : {
    outcome: "no_eligible_cg", returnedCg: enrichment.matchDiagnostics?.returnedCg ?? 1,
    rejectedSpatial: 0, rejectedReferenceTime: 0, rejectedProviderStale: 0,
    selectedProviderEventId: null, selectedDistanceKm: null, selectedReferenceDeltaMs: null, selectedProviderAgeMs: null,
    evaluatedProviderEventId: null, evaluatedDistanceKm: null, evaluatedReferenceDeltaMs: null, evaluatedProviderAgeMs: null,
  } satisfies InitialCgDiagnostics;
  const prior = enrichment.initialCgDiagnostics;
  const initialCgDiagnostics: InitialCgDiagnostics = { ...rejected,
    returnedCg: prior?.returnedCg ?? rejected.returnedCg,
    rejectedSpatial: Math.max(prior?.rejectedSpatial ?? 0, rejected.rejectedSpatial),
    rejectedReferenceTime: Math.max(prior?.rejectedReferenceTime ?? 0, rejected.rejectedReferenceTime),
    rejectedProviderStale: Math.max(prior?.rejectedProviderStale ?? 0, rejected.rejectedProviderStale) };
  const base = { ...enrichment };
  delete base.match;
  return { ...base, status: "no_match", initialCgDiagnostics };
}
