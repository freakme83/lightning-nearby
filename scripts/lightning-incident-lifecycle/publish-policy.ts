import { greatCircleDistanceKm } from "../live-lightning-clustering/clusterer.ts";
import type { IncidentPolicyProfile, LightningIncident, PublishDecision } from "./types.ts";

type PublishedRecord = { incidentId: string; latitude: number; longitude: number; closedAtMs: number };

export class DryRunPublishPolicy {
  readonly profile: IncidentPolicyProfile;
  readonly metrics = {
    publishCandidatesGenerated: 0,
    suppressions: 0,
    suppressionsByReason: {} as Record<string, number>,
    nearbyRepeatSuppressions: 0,
  };
  private readonly wouldPublish = new Set<string>();
  private readonly cooldownSuppressed = new Set<string>();
  private readonly publishedClosed: PublishedRecord[] = [];
  constructor(profile: IncidentPolicyProfile) { this.profile = { ...profile }; }

  onPromotion(incident: LightningIncident, nowMs: number): PublishDecision {
    this.pruneClosed(nowMs);
    const cutoffMs = this.profile.nearbyCooldownMinutes * 60_000;
    const related = cutoffMs <= 0 ? undefined : this.publishedClosed
      .map(item => ({ item, elapsed: nowMs - item.closedAtMs,
        distance: greatCircleDistanceKm(incident.representativeLatitude, incident.representativeLongitude, item.latitude, item.longitude) }))
      .filter(match => match.elapsed >= 0 && match.elapsed <= cutoffMs && match.distance <= this.profile.nearbyCooldownDistanceKm)
      .sort((a, b) => a.distance - b.distance || b.item.closedAtMs - a.item.closedAtMs || a.item.incidentId.localeCompare(b.item.incidentId))[0]?.item;
    if (related) {
      this.cooldownSuppressed.add(incident.id);
      this.metrics.nearbyRepeatSuppressions++;
      return this.suppress({ action: "SUPPRESS", incidentId: incident.id, reason: "nearby_cooldown", relatedIncidentId: related.incidentId });
    }
    this.wouldPublish.add(incident.id);
    this.metrics.publishCandidatesGenerated++;
    return { action: "WOULD_PUBLISH", incidentId: incident.id, reason: "incident_promoted" };
  }

  onActivity(incident: LightningIncident): PublishDecision | null {
    if (this.wouldPublish.has(incident.id)) {
      return this.suppress({ action: "SUPPRESS", incidentId: incident.id, reason: "already_published_active_incident" });
    }
    if (this.cooldownSuppressed.has(incident.id)) {
      return this.suppress({ action: "SUPPRESS", incidentId: incident.id, reason: "already_active_suppressed_incident" });
    }
    return null;
  }

  onClosed(incident: LightningIncident): void {
    if (this.wouldPublish.has(incident.id) && incident.closedAtMs !== undefined) {
      this.publishedClosed.push({ incidentId: incident.id, latitude: incident.representativeLatitude,
        longitude: incident.representativeLongitude, closedAtMs: incident.closedAtMs });
    }
    this.wouldPublish.delete(incident.id);
    this.cooldownSuppressed.delete(incident.id);
  }

  /** Profile B's exact nearby cooldown is the full relevance window for these closed records. */
  pruneClosed(referenceTimeMs: number): number {
    if (!Number.isFinite(referenceTimeMs)) throw new Error("invalid publish-policy pruning time");
    const cutoffMs = this.profile.nearbyCooldownMinutes * 60_000;
    let removed = 0;
    for (let index = this.publishedClosed.length - 1; index >= 0; index--) {
      const ageMs = referenceTimeMs - this.publishedClosed[index].closedAtMs;
      if (ageMs > cutoffMs) {
        this.publishedClosed.splice(index, 1);
        removed++;
      }
    }
    return removed;
  }

  summary() {
    return { ...this.metrics, suppressionsByReason: { ...this.metrics.suppressionsByReason } };
  }

  private suppress(decision: PublishDecision): PublishDecision {
    this.metrics.suppressions++;
    this.metrics.suppressionsByReason[decision.reason] = (this.metrics.suppressionsByReason[decision.reason] ?? 0) + 1;
    return decision;
  }
}
