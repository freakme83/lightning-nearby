import type { SourceHealth } from "./source-health.ts";

export type IncidentPolicyProfile = {
  id: "A" | "B" | "C";
  name: string;
  promotionMinEvents: number;
  promotionWindowMinutes: number;
  closeAfterMinutes: number;
  activeAssociationDistanceKm: number;
  nearbyCooldownDistanceKm: number;
  nearbyCooldownMinutes: number;
};

export const INCIDENT_POLICY_PROFILES: IncidentPolicyProfile[] = [
  { id: "A", name: "permissive", promotionMinEvents: 2, promotionWindowMinutes: 5,
    closeAfterMinutes: 20, activeAssociationDistanceKm: 10, nearbyCooldownDistanceKm: 10, nearbyCooldownMinutes: 0 },
  { id: "B", name: "moderate", promotionMinEvents: 3, promotionWindowMinutes: 10,
    closeAfterMinutes: 20, activeAssociationDistanceKm: 10, nearbyCooldownDistanceKm: 10, nearbyCooldownMinutes: 20 },
  { id: "C", name: "conservative", promotionMinEvents: 3, promotionWindowMinutes: 10,
    closeAfterMinutes: 30, activeAssociationDistanceKm: 10, nearbyCooldownDistanceKm: 10, nearbyCooldownMinutes: 30 },
];

export type ClusterObservation = {
  sourceClusterId: string;
  eventTimeMs: number;
  receivedAtMs: number;
  latitude: number;
  longitude: number;
};

export type LightningIncidentStatus = "candidate" | "active" | "closed";
export type LightningIncident = {
  id: string;
  sourceClusterIds: string[];
  status: LightningIncidentStatus;
  firstEventTimeMs: number;
  lastActivityTimeMs: number;
  promotedAtMs?: number;
  closedAtMs?: number;
  closeReason?: "candidate_expired" | "quiet_period";
  totalEvents: number;
  representativeLatitude: number;
  representativeLongitude: number;
  publishCount: number;
};

export type IncidentTransition =
  | { type: "candidate_created"; incident: LightningIncident }
  | { type: "candidate_expired"; incident: LightningIncident }
  | { type: "promoted"; incident: LightningIncident }
  | { type: "activity"; incident: LightningIncident; clusterAttached: boolean }
  | { type: "closed"; incident: LightningIncident };

export type PublishDecision = {
  action: "WOULD_PUBLISH" | "SUPPRESS";
  incidentId: string;
  reason: "incident_promoted" | "already_published_active_incident" | "already_active_suppressed_incident" | "nearby_cooldown";
  relatedIncidentId?: string;
};

export type IncidentReplaySignal =
  | { kind: "activity"; atMs: number; observation: ClusterObservation }
  | { kind: "cluster_closed"; atMs: number; sourceClusterId: string }
  | { kind: "source_health"; atMs: number; health: SourceHealth; intentional?: boolean };
