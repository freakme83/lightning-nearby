import { greatCircleDistanceKm } from "../live-lightning-clustering/clusterer.ts";
import type { ClusterObservation, IncidentPolicyProfile, IncidentTransition, LightningIncident } from "./types.ts";
import type { SourceHealth } from "./source-health.ts";

type InternalIncident = LightningIncident & {
  candidateOpenedAtMs: number;
  lastActivityReceivedAtMs: number;
  eventTimesInPromotionWindow: number[];
  latitudeSum: number;
  longitudeSinSum: number;
  longitudeCosSum: number;
};

function validateProfile(profile: IncidentPolicyProfile): void {
  if (!Number.isSafeInteger(profile.promotionMinEvents) || profile.promotionMinEvents < 2) throw new Error("promotionMinEvents must be >= 2");
  for (const key of ["promotionWindowMinutes", "closeAfterMinutes", "activeAssociationDistanceKm", "nearbyCooldownDistanceKm"] as const) {
    if (!Number.isFinite(profile[key]) || profile[key] <= 0) throw new Error(`invalid ${key}`);
  }
  if (!Number.isFinite(profile.nearbyCooldownMinutes) || profile.nearbyCooldownMinutes < 0) throw new Error("invalid nearbyCooldownMinutes");
}

const DEG = Math.PI / 180;
function safeCoordinates(value: ClusterObservation): void {
  if (!Number.isFinite(value.eventTimeMs) || !Number.isFinite(value.receivedAtMs) ||
      !Number.isFinite(value.latitude) || value.latitude < -90 || value.latitude > 90 ||
      !Number.isFinite(value.longitude) || value.longitude < -180 || value.longitude > 180 || !value.sourceClusterId) {
    throw new Error("invalid cluster observation");
  }
}

function snapshot(incident: InternalIncident): LightningIncident {
  const { candidateOpenedAtMs: _candidate, lastActivityReceivedAtMs: _received,
    eventTimesInPromotionWindow: _times, latitudeSum: _lat, longitudeSinSum: _sin, longitudeCosSum: _cos, ...plain } = incident;
  return { ...plain, sourceClusterIds: [...incident.sourceClusterIds] };
}

export class IncidentLifecycleEngine {
  readonly profile: IncidentPolicyProfile;
  readonly incidents: InternalIncident[] = [];
  private readonly incidentByCluster = new Map<string, InternalIncident>();
  private readonly seenClusterIds = new Set<string>();
  private nextId = 1;
  private health: SourceHealth;
  readonly metrics = {
    clustersObserved: 0,
    incidentCandidatesCreated: 0,
    candidatesExpired: 0,
    incidentsPromoted: 0,
    incidentsClosed: 0,
    reopenedOrRecreated: 0,
    singletonClustersIgnored: 0,
    eventsAtPromotion: [] as number[],
    timeToPromotionMs: [] as number[],
    incidentDurationMs: [] as number[],
  };

  constructor(profile: IncidentPolicyProfile, startedAtMs: number) {
    validateProfile(profile);
    this.profile = { ...profile };
    this.health = { state: "disconnected", sinceMs: startedAtMs };
  }

  get sourceHealth(): SourceHealth { return { ...this.health }; }

  setSourceHealth(health: SourceHealth, atMs: number): void {
    const resumed = health.state === "live" && this.health.state !== "live";
    this.health = { ...health };
    if (resumed) {
      // Unknown coverage during stale/disconnected intervals cannot consume candidate or close time.
      for (const incident of this.incidents) {
        if (incident.status === "candidate") incident.candidateOpenedAtMs = atMs;
        if (incident.status === "active") incident.lastActivityReceivedAtMs = atMs;
      }
    }
  }

  observe(observation: ClusterObservation): IncidentTransition[] {
    safeCoordinates(observation);
    const transitions: IncidentTransition[] = [];
    const existing = this.incidentByCluster.get(observation.sourceClusterId);
    if (existing?.status === "closed") return transitions;
    let incident = existing;
    let clusterAttached = false;
    if (!incident) {
      incident = this.findActiveNearby(observation);
      if (incident) {
        incident.sourceClusterIds.push(observation.sourceClusterId);
        this.incidentByCluster.set(observation.sourceClusterId, incident);
        clusterAttached = true;
      } else {
        incident = this.createCandidate(observation);
        this.incidentByCluster.set(observation.sourceClusterId, incident);
        transitions.push({ type: "candidate_created", incident: snapshot(incident) });
      }
    }

    if (!this.seenClusterIds.has(observation.sourceClusterId)) {
      this.seenClusterIds.add(observation.sourceClusterId);
      this.metrics.clustersObserved++;
    }
    this.updateIncident(incident, observation);
    if (incident.status === "candidate") {
      const windowMs = this.profile.promotionWindowMinutes * 60_000;
      const newestTime = Math.max(observation.eventTimeMs, ...incident.eventTimesInPromotionWindow);
      incident.eventTimesInPromotionWindow = incident.eventTimesInPromotionWindow
        .filter(time => time >= newestTime - windowMs);
      if (observation.eventTimeMs >= newestTime - windowMs) incident.eventTimesInPromotionWindow.push(observation.eventTimeMs);
      if (incident.eventTimesInPromotionWindow.length >= this.profile.promotionMinEvents) {
        incident.status = "active";
        incident.promotedAtMs = observation.receivedAtMs;
        this.metrics.incidentsPromoted++;
        this.metrics.eventsAtPromotion.push(incident.totalEvents);
        this.metrics.timeToPromotionMs.push(Math.max(0, observation.receivedAtMs - incident.candidateOpenedAtMs));
        transitions.push({ type: "promoted", incident: snapshot(incident) });
      }
    } else {
      transitions.push({ type: "activity", incident: snapshot(incident), clusterAttached });
    }
    return transitions;
  }

  tick(nowMs: number): IncidentTransition[] {
    if (this.health.state !== "live") return [];
    const transitions: IncidentTransition[] = [];
    for (const incident of this.incidents) {
      if (incident.status === "candidate" && nowMs - incident.candidateOpenedAtMs >= this.profile.promotionWindowMinutes * 60_000) {
        this.expireCandidate(incident, nowMs);
        transitions.push({ type: "candidate_expired", incident: snapshot(incident) });
      } else if (incident.status === "active" && nowMs - incident.lastActivityReceivedAtMs >= this.profile.closeAfterMinutes * 60_000) {
        incident.status = "closed";
        incident.closedAtMs = nowMs;
        incident.closeReason = "quiet_period";
        this.metrics.incidentsClosed++;
        this.metrics.incidentDurationMs.push(Math.max(0, nowMs - (incident.promotedAtMs ?? nowMs)));
        transitions.push({ type: "closed", incident: snapshot(incident) });
      }
    }
    return transitions;
  }

  clusterClosed(sourceClusterId: string, atMs: number): IncidentTransition[] {
    if (this.health.state !== "live") return [];
    const incident = this.incidentByCluster.get(sourceClusterId);
    if (!incident || incident.status !== "candidate") return [];
    this.expireCandidate(incident, atMs);
    return [{ type: "candidate_expired", incident: snapshot(incident) }];
  }

  recordWouldPublish(incidentId: string): void {
    const incident = this.incidents.find(item => item.id === incidentId);
    if (!incident) throw new Error("unknown incident");
    incident.publishCount++;
  }

  snapshot() {
    const incidents = this.incidents.map(snapshot);
    return { incidents, metrics: { ...this.metrics,
      eventsAtPromotion: [...this.metrics.eventsAtPromotion], timeToPromotionMs: [...this.metrics.timeToPromotionMs],
      incidentDurationMs: [...this.metrics.incidentDurationMs] },
      activeIncidents: incidents.filter(item => item.status === "active").length,
      candidates: incidents.filter(item => item.status === "candidate").length,
      closedIncidents: incidents.filter(item => item.status === "closed" && item.closeReason === "quiet_period").length };
  }

  private findActiveNearby(observation: ClusterObservation): InternalIncident | undefined {
    return this.incidents.filter(item => item.status === "active" &&
      observation.receivedAtMs - item.lastActivityReceivedAtMs < this.profile.closeAfterMinutes * 60_000)
      .map(incident => ({ incident, distance: greatCircleDistanceKm(observation.latitude, observation.longitude,
        incident.representativeLatitude, incident.representativeLongitude) }))
      .filter(item => item.distance <= this.profile.activeAssociationDistanceKm)
      .sort((a, b) => a.distance - b.distance || b.incident.lastActivityTimeMs - a.incident.lastActivityTimeMs || a.incident.id.localeCompare(b.incident.id))[0]?.incident;
  }

  private createCandidate(observation: ClusterObservation): InternalIncident {
    const nearbyClosed = this.incidents.some(item => item.status === "closed" && item.closeReason === "quiet_period" &&
      observation.receivedAtMs >= (item.closedAtMs ?? 0) && observation.receivedAtMs - (item.closedAtMs ?? 0) <= 30 * 60_000 &&
      greatCircleDistanceKm(observation.latitude, observation.longitude, item.representativeLatitude, item.representativeLongitude)
        <= this.profile.nearbyCooldownDistanceKm);
    if (nearbyClosed) this.metrics.reopenedOrRecreated++;
    const incident: InternalIncident = {
      id: `i-${String(this.nextId++).padStart(6, "0")}`,
      sourceClusterIds: [observation.sourceClusterId], status: "candidate",
      firstEventTimeMs: observation.eventTimeMs, lastActivityTimeMs: observation.eventTimeMs,
      totalEvents: 0, representativeLatitude: observation.latitude, representativeLongitude: observation.longitude,
      publishCount: 0, candidateOpenedAtMs: observation.receivedAtMs, lastActivityReceivedAtMs: observation.receivedAtMs,
      eventTimesInPromotionWindow: [], latitudeSum: 0, longitudeSinSum: 0, longitudeCosSum: 0,
    };
    this.metrics.incidentCandidatesCreated++;
    this.incidents.push(incident);
    return incident;
  }

  private updateIncident(incident: InternalIncident, observation: ClusterObservation): void {
    if (incident.totalEvents === 0) {
      incident.latitudeSum = observation.latitude;
    } else incident.latitudeSum += observation.latitude;
    const lon = observation.longitude * DEG;
    incident.longitudeSinSum += Math.sin(lon);
    incident.longitudeCosSum += Math.cos(lon);
    incident.totalEvents++;
    incident.firstEventTimeMs = Math.min(incident.firstEventTimeMs, observation.eventTimeMs);
    incident.lastActivityTimeMs = Math.max(incident.lastActivityTimeMs, observation.eventTimeMs);
    incident.lastActivityReceivedAtMs = Math.max(incident.lastActivityReceivedAtMs, observation.receivedAtMs);
    incident.representativeLatitude = incident.latitudeSum / incident.totalEvents;
    incident.representativeLongitude = Math.atan2(incident.longitudeSinSum, incident.longitudeCosSum) / DEG;
  }

  private expireCandidate(incident: InternalIncident, atMs: number): void {
    incident.status = "closed";
    incident.closedAtMs = atMs;
    incident.closeReason = "candidate_expired";
    this.metrics.candidatesExpired++;
    if (incident.totalEvents === 1) this.metrics.singletonClustersIgnored++;
  }
}
