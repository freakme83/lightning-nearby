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
  baseline?: Baseline; latestPublication?: Baseline; latestPublicationAdvanced: boolean;
  representedPublicationKeys: Set<string>; reportedKeys: Set<string>; lastSignature?: string };

export type StormEvolutionEvaluation = {
  shadowOnly: true; incidentId: string; sourceClusterIds: string[]; windowStartMs: number; windowEndMs: number;
  recentEventCount: number; footprintKm: number; originalPublishedLocation: string; latestRepresentedLocation: string;
  supportedLocations: Array<{ key: string; label: string; classification: string; evidenceCount: number;
    distanceFromOriginalKm: number; distanceFromLatestPublicationKm: number }>;
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
    if (state.latestPublication &&
        greatCircleDistanceKm(latitude, longitude, state.latestPublication.latitude, state.latestPublication.longitude) <= LOCAL_RADIUS_KM &&
        !cell.place) {
      cell.place = state.latestPublication.place;
      cell.lookupStarted = true;
    }
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
    // Preserve the original message anchor while also tracking the latest represented area.
    state.baseline ??= { latitude, longitude, label, place };
    if (!state.latestPublication) {
      state.latestPublication = { latitude, longitude, label, place };
      const identity = semanticCgLocationIdentity(place);
      if (identity.available) state.representedPublicationKeys.add(identity.key);
      this.seedRepresentedArea(state, state.latestPublication);
    }
  }

  /** Advance the shadow anchor when a repeat CG has been admitted to the publication ledger. */
  setLatestRepresentedPublication(incidentId: string, latitude: number, longitude: number,
    place: ReverseGeocodeResult): void {
    const label = place.displayLabel?.trim();
    if (!label) return;
    const state = this.state(incidentId);
    state.latestPublication = { latitude, longitude, label, place };
    state.latestPublicationAdvanced = true;
    const identity = semanticCgLocationIdentity(place);
    if (identity.available) state.representedPublicationKeys.add(identity.key);
    this.seedRepresentedArea(state, state.latestPublication);
  }

  private seedRepresentedArea(state: State, publication: Baseline): void {
    for (const cell of state.cells) {
      if (!cell.place &&
          greatCircleDistanceKm(cell.latitude, cell.longitude, publication.latitude, publication.longitude) <= LOCAL_RADIUS_KM) {
        cell.place = publication.place;
        cell.lookupStarted = true;
      }
    }
  }

  /** Look up only local areas already supported by multiple unique detections. */
  takeLookupRequests(incidentId: string, nowMs: number): Array<{ cellId: number; latitude: number; longitude: number }> {
    const state = this.states.get(incidentId);
    if (!state?.baseline || !state.latestPublication) return [];
    const recent = this.recent(state, nowMs);
    if (recent.length < 4) return [];
    const requests: Array<{ cellId: number; latitude: number; longitude: number }> = [];
    for (const cell of state.cells) {
      if (state.lookupCount >= MAX_LOOKUPS_PER_INCIDENT) break;
      if (cell.lookupStarted || recent.filter(point => point.cellId === cell.id).length < 2 ||
          greatCircleDistanceKm(cell.latitude, cell.longitude, state.latestPublication.latitude, state.latestPublication.longitude) < NEW_AREA_DISTANCE_KM) continue;
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
    const latestPublication = state.latestPublication ?? baseline;
    const footprintKm = recent.reduce((max, a) => Math.max(max, ...recent.map(b =>
      greatCircleDistanceKm(a.latitude, a.longitude, b.latitude, b.longitude))), 0);
    const grouped = new Map<string, { key: string; label: string; classification: string; count: number;
      distanceFromOriginal: number; distanceFromLatest: number }>();
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
      const distanceFromOriginal = greatCircleDistanceKm(cell.latitude, cell.longitude, baseline.latitude, baseline.longitude);
      const distanceFromLatest = greatCircleDistanceKm(cell.latitude, cell.longitude, latestPublication.latitude, latestPublication.longitude);
      const existing = grouped.get(identity.key);
      if (existing) {
        existing.count += points.length;
        existing.distanceFromOriginal = Math.max(existing.distanceFromOriginal, distanceFromOriginal);
        existing.distanceFromLatest = Math.max(existing.distanceFromLatest, distanceFromLatest);
      } else grouped.set(identity.key, { key: identity.key, label: cell.place.displayLabel,
        classification, count: points.length, distanceFromOriginal, distanceFromLatest });
    }
    const representedAreaObserved = [...grouped.values()].some(item => state.representedPublicationKeys.has(item.key));
    const supported = [...grouped.values()].filter(item => item.distanceFromLatest >= NEW_AREA_DISTANCE_KM &&
      !state.representedPublicationKeys.has(item.key))
      .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
    const novel = supported.filter(item => item.classification === "urban" && item.count >= 2 ||
      item.classification === "rural" && item.count >= 4 && item.distanceFromLatest >= 7);
    const newKeys = novel.filter(item => !state.reportedKeys.has(item.key));
    const eligible = recent.length >= 4 && footprintKm >= NEW_AREA_DISTANCE_KM && newKeys.length > 0;
    const reason = recent.length < 4 ? "insufficient_recent_events" :
      footprintKm < NEW_AREA_DISTANCE_KM ? "same_area" :
      eligible ? "meaningful_new_area_since_latest_publication" :
      novel.length ? "already_shadow_reported" :
      representedAreaObserved && !supported.length && state.latestPublicationAdvanced ? "suppressed_already_published_area" :
      limitations.size ? "location_ambiguous" : supported.length ? "insufficient_local_support" : "same_area";
    if (eligible) {
      this.counters.stormEvolutionEligible++;
      for (const item of newKeys) state.reportedKeys.add(item.key);
    } else if (reason === "same_area" || reason === "suppressed_already_published_area") this.counters.stormEvolutionSuppressedSameArea++;
    else if (reason === "location_ambiguous") this.counters.stormEvolutionLocationAmbiguous++;
    else if (reason === "already_shadow_reported") this.counters.stormEvolutionCoalesced++;
    else this.counters.stormEvolutionInsufficientSupport++;
    return { shadowOnly: true, incidentId, sourceClusterIds: [...sourceClusterIds],
      windowStartMs: nowMs - STORM_EVOLUTION_WINDOW_MS, windowEndMs: nowMs, recentEventCount: recent.length,
      footprintKm: Math.round(footprintKm * 10) / 10, originalPublishedLocation: baseline.label,
      latestRepresentedLocation: latestPublication.label,
      supportedLocations: supported.slice(0, 4).map(item => ({ key: item.key, label: item.label,
        classification: item.classification, evidenceCount: item.count,
        distanceFromOriginalKm: Math.round(item.distanceFromOriginal * 10) / 10,
        distanceFromLatestPublicationKm: Math.round(item.distanceFromLatest * 10) / 10 })),
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
    if (!state) { state = { points: [], cells: [], nextCellId: 1, lookupCount: 0, latestPublicationAdvanced: false,
      representedPublicationKeys: new Set(), reportedKeys: new Set() }; this.states.set(id, state); }
    return state;
  }
}
