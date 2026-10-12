// Research-only, in-memory information-novelty measurement. It never produces a publish decision.
import { greatCircleDistanceKm } from "../live-lightning-clustering/clusterer.ts";
import { classifyCgPlace, semanticCgLocationIdentity } from "../lightning-cg-repeat-policy/location.ts";
import type { ReverseGeocodeResult } from "../lightning-location-naming/types.ts";

export const STORM_EVOLUTION_WINDOW_MS = 20 * 60_000;
const LOCAL_RADIUS_KM = 3;
const NEW_AREA_DISTANCE_KM = 4;
const MAX_EVENTS_PER_INCIDENT = 96;
const MAX_LOOKUPS_PER_INCIDENT = 4;

type Point = { latitude: number; longitude: number; eventTimeMs: number; clusterId: string; cellId: number };
type Cell = { id: number; latitude: number; longitude: number; place?: ReverseGeocodeResult | null; lookupStarted: boolean };
type Baseline = { latitude: number; longitude: number; label: string; place: ReverseGeocodeResult };
type State = { points: Point[]; cells: Cell[]; nextCellId: number; lookupCount: number;
  baseline?: Baseline; reportedKeys: Set<string>; lastSignature?: string };

export type StormEvolutionEvaluation = {
  shadowOnly: true; incidentId: string; sourceClusterIds: string[]; windowStartMs: number; windowEndMs: number;
  recentEventCount: number; footprintKm: number; originalPublishedLocation: string;
  supportedLocations: Array<{ key: string; label: string; classification: string; evidenceCount: number; distanceFromOriginalKm: number }>;
  newlySupportedLocations: string[]; eligible: boolean; reason: string; alreadyShadowReported: boolean;
  locationLimitations: string[];
};

export class StormEvolutionShadow {
  private readonly states = new Map<string, State>();
  readonly counters = { stormEvolutionEvaluations: 0, stormEvolutionEligible: 0,
    stormEvolutionSuppressedSameArea: 0, stormEvolutionInsufficientSupport: 0,
    stormEvolutionLocationAmbiguous: 0, stormEvolutionCoalesced: 0 };

  observe(incidentId: string, clusterId: string, latitude: number, longitude: number, eventTimeMs: number): void {
    const state = this.state(incidentId);
    const nearest = state.cells.map(cell => ({ cell, distance: greatCircleDistanceKm(latitude, longitude, cell.latitude, cell.longitude) }))
      .sort((a, b) => a.distance - b.distance || a.cell.id - b.cell.id)[0];
    const cell = nearest && nearest.distance <= LOCAL_RADIUS_KM ? nearest.cell :
      { id: state.nextCellId++, latitude, longitude, lookupStarted: false };
    if (!nearest || nearest.distance > LOCAL_RADIUS_KM) state.cells.push(cell);
    state.points.push({ latitude, longitude, eventTimeMs, clusterId, cellId: cell.id });
    state.points = state.points.filter(point => point.eventTimeMs >= eventTimeMs - STORM_EVOLUTION_WINDOW_MS)
      .slice(-MAX_EVENTS_PER_INCIDENT);
    const retained = new Set(state.points.map(point => point.cellId));
    state.cells = state.cells.filter(item => retained.has(item.id));
  }

  setBaseline(incidentId: string, latitude: number, longitude: number, place: ReverseGeocodeResult): void {
    const label = place.displayLabel?.trim();
    if (!label) return;
    const state = this.state(incidentId);
    // Only the first actual pending publication defines the original message.
    state.baseline ??= { latitude, longitude, label, place };
  }

  /** Look up only local areas already supported by multiple unique detections. */
  takeLookupRequests(incidentId: string, nowMs: number): Array<{ cellId: number; latitude: number; longitude: number }> {
    const state = this.states.get(incidentId);
    if (!state?.baseline) return [];
    const recent = this.recent(state, nowMs);
    if (recent.length < 4) return [];
    const requests: Array<{ cellId: number; latitude: number; longitude: number }> = [];
    for (const cell of state.cells) {
      if (state.lookupCount >= MAX_LOOKUPS_PER_INCIDENT) break;
      if (cell.lookupStarted || recent.filter(point => point.cellId === cell.id).length < 2 ||
          greatCircleDistanceKm(cell.latitude, cell.longitude, state.baseline.latitude, state.baseline.longitude) < NEW_AREA_DISTANCE_KM) continue;
      cell.lookupStarted = true; state.lookupCount++;
      requests.push({ cellId: cell.id, latitude: cell.latitude, longitude: cell.longitude });
    }
    return requests;
  }

  resolve(incidentId: string, cellId: number, place: ReverseGeocodeResult | null): void {
    const cell = this.states.get(incidentId)?.cells.find(item => item.id === cellId);
    if (cell) cell.place = place;
  }

  evaluate(incidentId: string, sourceClusterIds: string[], nowMs: number): StormEvolutionEvaluation | null {
    const state = this.states.get(incidentId);
    if (!state?.baseline) return null;
    this.counters.stormEvolutionEvaluations++;
    const recent = this.recent(state, nowMs);
    const baseline = state.baseline;
    const footprintKm = recent.reduce((max, a) => Math.max(max, ...recent.map(b =>
      greatCircleDistanceKm(a.latitude, a.longitude, b.latitude, b.longitude))), 0);
    const grouped = new Map<string, { key: string; label: string; classification: string; count: number; distance: number }>();
    const limitations = new Set<string>();
    for (const cell of state.cells) {
      const points = recent.filter(point => point.cellId === cell.id);
      if (points.length < 2) continue;
      if (!cell.place) {
        if (cell.lookupStarted) limitations.add("lookup_pending_or_failed");
        continue;
      }
      const identity = semanticCgLocationIdentity(cell.place);
      const classification = classifyCgPlace(cell.place).classification;
      if (!identity.available || identity.level === "district" || !cell.place.displayLabel) {
        limitations.add(identity.available ? "place_only_at_district_level" : identity.reason);
        continue;
      }
      const distance = greatCircleDistanceKm(cell.latitude, cell.longitude, baseline.latitude, baseline.longitude);
      const existing = grouped.get(identity.key);
      if (existing) { existing.count += points.length; existing.distance = Math.max(existing.distance, distance); }
      else grouped.set(identity.key, { key: identity.key, label: cell.place.displayLabel,
        classification, count: points.length, distance });
    }
    const originalIdentity = semanticCgLocationIdentity(baseline.place);
    const supported = [...grouped.values()].filter(item => item.distance >= NEW_AREA_DISTANCE_KM &&
      (!originalIdentity.available || item.key !== originalIdentity.key))
      .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
    const novel = supported.filter(item => item.classification === "urban" && item.count >= 2 ||
      item.classification === "rural" && item.count >= 4 && item.distance >= 7);
    const newKeys = novel.filter(item => !state.reportedKeys.has(item.key));
    const eligible = recent.length >= 4 && footprintKm >= NEW_AREA_DISTANCE_KM && newKeys.length > 0;
    const reason = recent.length < 4 ? "insufficient_recent_events" :
      footprintKm < NEW_AREA_DISTANCE_KM ? "same_area" :
      eligible ? "meaningful_new_area" :
      novel.length ? "already_shadow_reported" :
      limitations.size ? "location_ambiguous" : supported.length ? "insufficient_local_support" : "same_area";
    if (eligible) {
      this.counters.stormEvolutionEligible++;
      for (const item of newKeys) state.reportedKeys.add(item.key);
    } else if (reason === "same_area") this.counters.stormEvolutionSuppressedSameArea++;
    else if (reason === "location_ambiguous") this.counters.stormEvolutionLocationAmbiguous++;
    else if (reason === "already_shadow_reported") this.counters.stormEvolutionCoalesced++;
    else this.counters.stormEvolutionInsufficientSupport++;
    return { shadowOnly: true, incidentId, sourceClusterIds: [...sourceClusterIds],
      windowStartMs: nowMs - STORM_EVOLUTION_WINDOW_MS, windowEndMs: nowMs, recentEventCount: recent.length,
      footprintKm: Math.round(footprintKm * 10) / 10, originalPublishedLocation: baseline.label,
      supportedLocations: supported.slice(0, 4).map(item => ({ key: item.key, label: item.label,
        classification: item.classification, evidenceCount: item.count,
        distanceFromOriginalKm: Math.round(item.distance * 10) / 10 })),
      newlySupportedLocations: newKeys.map(item => item.label).slice(0, 4),
      eligible, reason, alreadyShadowReported: reason === "already_shadow_reported", locationLimitations: [...limitations] };
  }

  /** Report a changed diagnostic state once; eligible evaluations are always new information. */
  shouldEmit(incidentId: string, result: StormEvolutionEvaluation): boolean {
    const state = this.states.get(incidentId)!;
    const signature = JSON.stringify([result.reason, result.supportedLocations.map(item => item.key), result.locationLimitations]);
    if (!result.eligible && state.lastSignature === signature) return false;
    state.lastSignature = signature;
    return true;
  }

  forget(incidentId: string): void { this.states.delete(incidentId); }
  private recent(state: State, nowMs: number): Point[] {
    return state.points.filter(point => point.eventTimeMs <= nowMs && point.eventTimeMs >= nowMs - STORM_EVOLUTION_WINDOW_MS);
  }
  private state(id: string): State {
    let state = this.states.get(id);
    if (!state) { state = { points: [], cells: [], nextCellId: 1, lookupCount: 0, reportedKeys: new Set() }; this.states.set(id, state); }
    return state;
  }
}
