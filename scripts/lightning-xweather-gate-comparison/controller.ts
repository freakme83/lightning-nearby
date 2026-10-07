// Research-only multi-incident gate. The paired-validation one-call controller remains independent.
import { enrichIncidentWithLightningType } from "../lightning-cg-enrichment/xweather.ts";
import { DEFAULT_THRESHOLDS } from "../lightning-cg-enrichment/match.ts";
import type { EnrichmentReference, EnrichmentResult } from "../lightning-cg-enrichment/types.ts";
import { MAX_PAIRING_INCIDENT_AGE_MS } from "../lightning-cg-paired-validation/controller.ts";
import type { DecisionForPairing, IncidentForPairing, PairedEnrichmentFunction } from "../lightning-cg-paired-validation/types.ts";

export type GateTriggerMode = "fresh_would_publish" | "reactivated_after_stale_publish";
export type GateSkipReason = "incident_too_old" | "future_dated_incident" | "invalid_event_time" |
  "already_enriched" | "budget_exhausted" | "missing_credentials";
type GateEvent = (kind: "incident_eligibility" | "xweather_request_started" | "xweather_request_result" |
  "xweather_request_skipped", data: Record<string, unknown>) => void;

// These are planning inputs from the production Summary → Flash observations, not measured counterfactual costs.
export function hypotheticalSummaryFlashRange(checks: number | undefined) {
  if (checks === undefined) return null;
  if (!Number.isSafeInteger(checks) || checks < 0 || checks > 100_000) {
    throw new Error("hypothetical checks must be an integer from 0 through 100000");
  }
  return { hypotheticalUserChecks: checks, observedPlanningTokenFloor: checks,
    observedPlanningTokenCeiling: checks * 2, measuredCounterfactual: false };
}

const MAX_TRACKED_STALE = 10_000;

export class GateComparisonController {
  private readonly maxCalls: number;
  private readonly nowMs: () => number;
  private readonly enrich?: PairedEnrichmentFunction;
  private readonly hasCredentials: boolean;
  private readonly emit?: GateEvent;
  private readonly planning: ReturnType<typeof hypotheticalSummaryFlashRange>;
  private readonly attemptedIds = new Set<string>(); // bounded by maxCalls (at most 10)
  private readonly staleSkipped = new Map<string, number>();
  private readonly pending = new Set<Promise<void>>();
  private readonly counts = {
    freshEligibleIncidents: 0, stalePublishTriggers: 0, futureDatedTriggers: 0,
    invalidTimeTriggers: 0, reactivatedStaleIncidents: 0, alreadyEnrichedSuppressions: 0,
    eligibleButBudgetExhausted: 0, missingCredentialSkips: 0, staleTrackingOverflow: 0,
    actualXweatherRequests: 0,
  };
  private readonly statuses: Record<EnrichmentResult["status"], number> = {
    cg_verified: 0, ic_only: 0, no_match: 0, provider_unavailable: 0,
  };
  private knownTokenSum = 0;
  private requestsWithoutCostHeader = 0;

  constructor(options: {
    maxXweatherCalls?: number;
    hypotheticalUserChecks?: number;
    nowMs?: () => number;
    enrich?: PairedEnrichmentFunction;
    hasCredentials?: boolean;
    emit?: GateEvent;
  } = {}) {
    this.maxCalls = options.maxXweatherCalls ?? 3;
    if (!Number.isInteger(this.maxCalls) || this.maxCalls < 0 || this.maxCalls > 10) {
      throw new Error("max Xweather calls must be an integer from 0 through 10");
    }
    this.planning = hypotheticalSummaryFlashRange(options.hypotheticalUserChecks);
    this.nowMs = options.nowMs ?? Date.now;
    this.enrich = options.enrich;
    this.hasCredentials = options.hasCredentials ?? Boolean(process.env.XWEATHER_CLIENT_ID && process.env.XWEATHER_CLIENT_SECRET);
    this.emit = options.emit;
  }

  observeDecision(decision: DecisionForPairing, incident: IncidentForPairing): boolean {
    if (decision.action !== "WOULD_PUBLISH" || decision.incidentId !== incident.id) return false;
    return this.evaluate(incident, "fresh_would_publish");
  }

  observeActivity(incident: IncidentForPairing): boolean {
    if (this.attemptedIds.has(incident.id)) {
      this.counts.alreadyEnrichedSuppressions++;
      return false;
    }
    if (incident.status !== "active" || !this.staleSkipped.has(incident.id)) return false;
    return this.evaluate(incident, "reactivated_after_stale_publish");
  }

  private evaluate(incident: IncidentForPairing, triggerMode: GateTriggerMode): boolean {
    const incidentAgeMs = this.nowMs() - incident.lastActivityTimeMs;
    const detail = { incidentId: incident.id, triggerMode,
      incidentAgeMs: Number.isFinite(incidentAgeMs) ? incidentAgeMs : null,
      maxIncidentAgeMs: MAX_PAIRING_INCIDENT_AGE_MS };
    const skip = (reason: GateSkipReason) => {
      this.emit?.("incident_eligibility", { ...detail, eligible: false, reason });
      this.emit?.("xweather_request_skipped", { ...detail, reason });
      return false;
    };
    if (this.attemptedIds.has(incident.id)) {
      this.counts.alreadyEnrichedSuppressions++;
      return skip("already_enriched");
    }
    if (!Number.isFinite(incidentAgeMs)) {
      if (triggerMode === "fresh_would_publish") this.counts.invalidTimeTriggers++;
      return skip("invalid_event_time");
    }
    if (incidentAgeMs < 0) {
      if (triggerMode === "fresh_would_publish") this.counts.futureDatedTriggers++;
      return skip("future_dated_incident");
    }
    if (incidentAgeMs > MAX_PAIRING_INCIDENT_AGE_MS) {
      if (triggerMode === "fresh_would_publish") {
        this.counts.stalePublishTriggers++;
        if (this.staleSkipped.size < MAX_TRACKED_STALE && !this.staleSkipped.has(incident.id)) {
          this.staleSkipped.set(incident.id, incidentAgeMs);
        } else if (!this.staleSkipped.has(incident.id)) this.counts.staleTrackingOverflow++;
      }
      // Repeated older activity stays tracked without flooding JSONL with every cluster update.
      return triggerMode === "fresh_would_publish" ? skip("incident_too_old") : false;
    }

    this.staleSkipped.delete(incident.id);
    this.counts.freshEligibleIncidents++;
    if (triggerMode === "reactivated_after_stale_publish") this.counts.reactivatedStaleIncidents++;
    this.emit?.("incident_eligibility", { ...detail, eligible: true });
    if (this.attemptedIds.size >= this.maxCalls) {
      this.counts.eligibleButBudgetExhausted++;
      this.emit?.("xweather_request_skipped", { ...detail, reason: "budget_exhausted" });
      return false;
    }
    if (!this.hasCredentials) {
      this.counts.missingCredentialSkips++;
      this.emit?.("xweather_request_skipped", { ...detail, reason: "missing_credentials" });
      return false;
    }

    // Reserve synchronously before any await; the set cannot exceed the configured request budget.
    this.attemptedIds.add(incident.id);
    const reference: EnrichmentReference = { latitude: incident.representativeLatitude,
      longitude: incident.representativeLongitude, eventTimeMs: incident.lastActivityTimeMs };
    this.emit?.("xweather_request_started", { ...detail, reference, requestNumber: this.attemptedIds.size });
    const request = this.runRequest(reference, detail);
    this.pending.add(request);
    void request.finally(() => this.pending.delete(request));
    return true;
  }

  private async runRequest(reference: EnrichmentReference, detail: Record<string, unknown>): Promise<void> {
    let result: EnrichmentResult;
    let httpAttempted = false;
    try {
      if (this.enrich) {
        // Injected fixture implementations model one provider request for deterministic tests.
        httpAttempted = true;
        this.counts.actualXweatherRequests++;
        result = await this.enrich(reference);
      } else {
        result = await enrichIncidentWithLightningType(reference, {}, { fetch: (input, init) => {
          httpAttempted = true;
          this.counts.actualXweatherRequests++;
          return fetch(input, init);
        } });
      }
    } catch {
      // Arbitrary provider errors, including credential-bearing URLs, are never copied into diagnostics.
      result = { status: "provider_unavailable", provider: "xweather", reference,
        thresholds: { ...DEFAULT_THRESHOLDS }, failure: "network_error" };
    }
    this.statuses[result.status]++;
    const tokens = result.cost?.tokens;
    if (httpAttempted) {
      if (typeof tokens === "number" && Number.isFinite(tokens)) this.knownTokenSum += tokens;
      else this.requestsWithoutCostHeader++;
    }
    this.emit?.("xweather_request_result", { ...detail, status: result.status, failure: result.failure ?? null,
      httpAttempted,
      counts: result.counts ?? null,
      match: result.match ? { id: result.match.id, type: result.match.type,
        distanceKm: result.match.distanceKm, timeDifferenceMs: result.match.timeDifferenceMs } : null,
      cost: { tokens: tokens ?? null, multipliers: result.cost?.multipliers ?? null } });
  }

  async waitForCompletion(): Promise<void> { await Promise.all(this.pending); }

  snapshot() {
    return {
      maxXweatherCalls: this.maxCalls, maxIncidentAgeMs: MAX_PAIRING_INCIDENT_AGE_MS,
      queryThresholds: { ...DEFAULT_THRESHOLDS },
      ...this.counts,
      trackedStaleIncidentCount: this.staleSkipped.size,
      enrichmentStates: { ...this.statuses },
      observedXweatherCost: { knownHeaderTokenSum: this.knownTokenSum,
        requestsWithoutCostHeader: this.requestsWithoutCostHeader,
        totalTokensWhenFullyKnown: this.requestsWithoutCostHeader === 0 ? this.knownTokenSum : null,
        requestsWithoutQualifyingIncident: 0, tokensWithoutQualifyingIncident: 0 },
      hypotheticalProductionSummaryFlash: this.planning,
    };
  }
}
