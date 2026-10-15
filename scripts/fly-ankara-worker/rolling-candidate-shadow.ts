import type { ClusterObservation, LightningIncident } from "../lightning-incident-lifecycle/types.ts";

export type RollingCandidateShadowCounters = {
  rollingCandidateEvaluations: number;
  productionExpiredWhileRollingViable: number;
  rollingShadowPromotions: number;
  rollingShadowPromotionsAfterProductionExpiry: number;
  productionAndRollingBothPromoted: number;
};

export type RollingCandidateShadowEvent = {
  kind: "rolling_candidate_shadow_state" | "rolling_candidate_shadow_promotion";
  fields: Record<string, unknown>;
};

type RollingCandidateState = {
  incidentId: string;
  clusterIds: string[];
  eventTimesMs: number[];
  productionState: LightningIncident["status"] | "candidate_expired";
  productionCandidateExpiredAtMs: number | null;
  productionHadPromoted: boolean;
  expiryViabilityEmitted: boolean;
  thresholdOutcomeRecorded: boolean;
};

export class RollingCandidateWindowShadow {
  private readonly statesByIncident = new Map<string, RollingCandidateState>();
  private readonly promotionThreshold: number;
  private readonly rollingWindowMinutes: number;
  readonly counters: RollingCandidateShadowCounters = {
    rollingCandidateEvaluations: 0,
    productionExpiredWhileRollingViable: 0,
    rollingShadowPromotions: 0,
    rollingShadowPromotionsAfterProductionExpiry: 0,
    productionAndRollingBothPromoted: 0,
  };

  constructor(promotionThreshold: number, rollingWindowMinutes: number) {
    if (!Number.isSafeInteger(promotionThreshold) || promotionThreshold < 2) throw new Error("invalid promotion threshold");
    if (!Number.isFinite(rollingWindowMinutes) || rollingWindowMinutes <= 0) throw new Error("invalid rolling window");
    this.promotionThreshold = promotionThreshold;
    this.rollingWindowMinutes = rollingWindowMinutes;
  }

  observe(observation: ClusterObservation, incident: LightningIncident,
    productionRepresentedByRelatedIncident = false): RollingCandidateShadowEvent[] {
    const existing = this.statesByIncident.get(incident.id);
    if (existing?.thresholdOutcomeRecorded || incident.promotedAtMs !== undefined && !existing) return [];
    const state = this.stateFor(incident);
    this.counters.rollingCandidateEvaluations++;
    this.addEventTime(state, observation.eventTimeMs);
    state.clusterIds = [...incident.sourceClusterIds];
    state.productionState = incident.status === "closed" && incident.closeReason === "candidate_expired" ?
      "candidate_expired" : incident.status;
    state.productionHadPromoted ||= incident.promotedAtMs !== undefined || productionRepresentedByRelatedIncident;
    if (state.eventTimesMs.length < this.promotionThreshold || state.thresholdOutcomeRecorded) return [];
    state.thresholdOutcomeRecorded = true;
    if (state.productionHadPromoted) {
      this.counters.productionAndRollingBothPromoted++;
      return [];
    }
    this.counters.rollingShadowPromotions++;
    if (state.productionCandidateExpiredAtMs !== null) this.counters.rollingShadowPromotionsAfterProductionExpiry++;
    return [{ kind: "rolling_candidate_shadow_promotion", fields: this.telemetryFields(state, {
      productionCandidateExpiredAtMs: state.productionCandidateExpiredAtMs,
      secondsAfterProductionExpiry: state.productionCandidateExpiredAtMs === null ? null :
        (observation.receivedAtMs - state.productionCandidateExpiredAtMs) / 1000,
      productionHadPromoted: false,
      additionalToProduction: true,
    }) }];
  }

  productionExpired(incident: LightningIncident, expiredAtMs: number): RollingCandidateShadowEvent[] {
    const state = this.statesByIncident.get(incident.id);
    if (!state) return [];
    state.productionState = "candidate_expired";
    state.productionCandidateExpiredAtMs = expiredAtMs;
    state.clusterIds = [...incident.sourceClusterIds];
    if (state.expiryViabilityEmitted || state.eventTimesMs.length !== this.promotionThreshold - 1) return [];
    state.expiryViabilityEmitted = true;
    this.counters.productionExpiredWhileRollingViable++;
    return [{ kind: "rolling_candidate_shadow_state", fields: this.telemetryFields(state, {
      productionCandidateExpiredAtMs: expiredAtMs,
      productionHadPromoted: false,
    }) }];
  }

  forgetIncident(incidentId: string): void {
    const state = this.statesByIncident.get(incidentId);
    if (!state) return;
    this.statesByIncident.delete(incidentId);
  }

  private stateFor(incident: LightningIncident): RollingCandidateState {
    let state = this.statesByIncident.get(incident.id);
    if (!state) {
      state = { incidentId: incident.id, clusterIds: [...incident.sourceClusterIds], eventTimesMs: [],
        productionState: incident.status, productionCandidateExpiredAtMs: null,
        productionHadPromoted: incident.promotedAtMs !== undefined,
        expiryViabilityEmitted: false, thresholdOutcomeRecorded: false };
      this.statesByIncident.set(incident.id, state);
    }
    return state;
  }

  private addEventTime(state: RollingCandidateState, eventTimeMs: number): void {
    const windowMs = this.rollingWindowMinutes * 60_000;
    const newestTimeMs = Math.max(eventTimeMs, ...state.eventTimesMs);
    const cutoffMs = newestTimeMs - windowMs;
    const retained = state.eventTimesMs.filter(time => time >= cutoffMs);
    if (eventTimeMs >= cutoffMs) retained.push(eventTimeMs);
    retained.sort((left, right) => left - right);
    state.eventTimesMs = retained.slice(-this.promotionThreshold);
  }

  private telemetryFields(state: RollingCandidateState, extra: Record<string, unknown>): Record<string, unknown> {
    const oldestRollingEventTimeMs = state.eventTimesMs[0] ?? null;
    const newestRollingEventTimeMs = state.eventTimesMs.at(-1) ?? null;
    return {
      incidentId: state.incidentId,
      candidateId: state.incidentId,
      clusterIds: [...state.clusterIds],
      rollingEventCount: state.eventTimesMs.length,
      promotionThreshold: this.promotionThreshold,
      rollingWindowMinutes: this.rollingWindowMinutes,
      oldestRollingEventTimeMs,
      newestRollingEventTimeMs,
      rollingSpanSeconds: oldestRollingEventTimeMs === null || newestRollingEventTimeMs === null ? null :
        (newestRollingEventTimeMs - oldestRollingEventTimeMs) / 1000,
      productionState: state.productionState,
      ...extra,
      shadowOnly: true,
    };
  }
}
