// Research-only spatial grouping; imports only the listener's research event type.
import type { LightningEvent } from "../live-lightning-listener/core.ts";
import { percentile } from "../live-lightning-listener/core.ts";

export type ClusterStatus = "active" | "closed";
export type ClusterParameters = {
  maxSpatialDistanceKm: number;
  maxTemporalGapMinutes: number;
  freshnessWindowMinutes: number;
  clusterCloseAfterMinutes: number;
};
export type LightningCluster = {
  id: string;
  firstEventTimeMs: number;
  lastEventTimeMs: number;
  eventCount: number;
  centerLatitude: number;
  centerLongitude: number;
  minLatitude: number;
  maxLatitude: number;
  minLongitude: number;
  maxLongitude: number;
  status: ClusterStatus;
  recentEvents: LightningEvent[];
};
type InternalCluster = LightningCluster & {
  latitudeSum: number;
  longitudeSinSum: number;
  longitudeCosSum: number;
};

export const DEFAULT_CLUSTER_PARAMETERS: ClusterParameters = {
  maxSpatialDistanceKm: 8,
  maxTemporalGapMinutes: 10,
  freshnessWindowMinutes: 10,
  clusterCloseAfterMinutes: 15,
};

const EARTH_RADIUS_KM = 6371.0088;
const DEG_TO_RAD = Math.PI / 180;

function validCoordinate(latitude: number, longitude: number): boolean {
  return Number.isFinite(latitude) && Number.isFinite(longitude) &&
    latitude >= -90 && latitude <= 90 && longitude >= -180 && longitude <= 180;
}

export function greatCircleDistanceKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  if (!validCoordinate(lat1, lon1) || !validCoordinate(lat2, lon2)) throw new Error("invalid latitude/longitude");
  const phi1 = lat1 * DEG_TO_RAD;
  const phi2 = lat2 * DEG_TO_RAD;
  const dPhi = (lat2 - lat1) * DEG_TO_RAD;
  const dLambda = (lon2 - lon1) * DEG_TO_RAD;
  const a = Math.sin(dPhi / 2) ** 2 + Math.cos(phi1) * Math.cos(phi2) * Math.sin(dLambda / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(Math.max(0, Math.min(1, a))));
}

export type FreshnessState = "fresh" | "stale" | "future";
export function freshnessState(event: LightningEvent, processingTimeMs: number, freshnessWindowMinutes: number): FreshnessState {
  const ageMs = processingTimeMs - event.eventTimeMs;
  if (ageMs < 0) return "future";
  return ageMs <= freshnessWindowMinutes * 60_000 ? "fresh" : "stale";
}

function validateParameters(parameters: ClusterParameters, recentEventLimit: number): void {
  for (const [name, value] of Object.entries(parameters)) {
    if (!Number.isFinite(value) || value <= 0) throw new Error(`invalid ${name}`);
  }
  if (!Number.isSafeInteger(recentEventLimit) || recentEventLimit < 1) throw new Error("invalid recentEventLimit");
}

function centroidLongitude(sinSum: number, cosSum: number): number {
  const longitude = Math.atan2(sinSum, cosSum) / DEG_TO_RAD;
  return longitude === -180 ? 180 : longitude;
}

function makeCluster(id: string, event: LightningEvent): InternalCluster {
  const longitudeRadians = event.longitude * DEG_TO_RAD;
  return {
    id, firstEventTimeMs: event.eventTimeMs, lastEventTimeMs: event.eventTimeMs, eventCount: 1,
    centerLatitude: event.latitude, centerLongitude: event.longitude,
    minLatitude: event.latitude, maxLatitude: event.latitude,
    minLongitude: event.longitude, maxLongitude: event.longitude,
    status: "active", recentEvents: [event], latitudeSum: event.latitude,
    longitudeSinSum: Math.sin(longitudeRadians), longitudeCosSum: Math.cos(longitudeRadians),
  };
}

type Match = { cluster: InternalCluster; distanceKm: number; matchedEventTimeMs: number };

export class OnlineLightningClusterer {
  readonly parameters: ClusterParameters;
  readonly recentEventLimit: number;
  private readonly clustersInternal: InternalCluster[] = [];
  private nextClusterNumber = 1;
  constructor(parameters: ClusterParameters = DEFAULT_CLUSTER_PARAMETERS, recentEventLimit = 256) {
    validateParameters(parameters, recentEventLimit);
    this.parameters = { ...parameters };
    this.recentEventLimit = recentEventLimit;
  }
  get clusters(): LightningCluster[] {
    return this.clustersInternal.map(({ latitudeSum: _lat, longitudeSinSum: _sin, longitudeCosSum: _cos, ...cluster }) => cluster);
  }
  advance(referenceTimeMs: number): LightningCluster[] {
    const newlyClosed: InternalCluster[] = [];
    const closeAfterMs = this.parameters.clusterCloseAfterMinutes * 60_000;
    for (const cluster of this.clustersInternal) {
      if (cluster.status === "active" && referenceTimeMs - cluster.lastEventTimeMs >= closeAfterMs) {
        cluster.status = "closed";
        newlyClosed.push(cluster);
      }
    }
    return newlyClosed.map(({ latitudeSum: _lat, longitudeSinSum: _sin, longitudeCosSum: _cos, ...cluster }) => cluster);
  }
  ingest(event: LightningEvent, referenceTimeMs = event.receivedAtMs): string {
    if (!validCoordinate(event.latitude, event.longitude)) throw new Error("invalid event coordinates");
    this.advance(referenceTimeMs);
    const maxDistanceKm = this.parameters.maxSpatialDistanceKm;
    const maxGapMs = this.parameters.maxTemporalGapMinutes * 60_000;
    const matches: Match[] = [];
    for (const cluster of this.clustersInternal) {
      if (cluster.status !== "active") continue;
      let best: Match | null = null;
      for (const recent of cluster.recentEvents) {
        if (Math.abs(event.eventTimeMs - recent.eventTimeMs) > maxGapMs) continue;
        const distanceKm = greatCircleDistanceKm(event.latitude, event.longitude, recent.latitude, recent.longitude);
        if (distanceKm > maxDistanceKm) continue;
        if (!best || distanceKm < best.distanceKm ||
            (distanceKm === best.distanceKm && recent.eventTimeMs > best.matchedEventTimeMs)) {
          best = { cluster, distanceKm, matchedEventTimeMs: recent.eventTimeMs };
        }
      }
      if (best) matches.push(best);
    }
    matches.sort((a, b) => a.distanceKm - b.distanceKm ||
      b.cluster.lastEventTimeMs - a.cluster.lastEventTimeMs || a.cluster.id.localeCompare(b.cluster.id));
    const cluster = matches[0]?.cluster ?? makeCluster(`c-${String(this.nextClusterNumber++).padStart(6, "0")}`, event);
    if (!matches.length) this.clustersInternal.push(cluster);
    else this.addToCluster(cluster, event);
    return cluster.id;
  }
  private addToCluster(cluster: InternalCluster, event: LightningEvent): void {
    cluster.eventCount++;
    cluster.firstEventTimeMs = Math.min(cluster.firstEventTimeMs, event.eventTimeMs);
    cluster.lastEventTimeMs = Math.max(cluster.lastEventTimeMs, event.eventTimeMs);
    cluster.minLatitude = Math.min(cluster.minLatitude, event.latitude);
    cluster.maxLatitude = Math.max(cluster.maxLatitude, event.latitude);
    cluster.minLongitude = Math.min(cluster.minLongitude, event.longitude);
    cluster.maxLongitude = Math.max(cluster.maxLongitude, event.longitude);
    cluster.latitudeSum += event.latitude;
    const longitudeRadians = event.longitude * DEG_TO_RAD;
    cluster.longitudeSinSum += Math.sin(longitudeRadians);
    cluster.longitudeCosSum += Math.cos(longitudeRadians);
    cluster.centerLatitude = cluster.latitudeSum / cluster.eventCount;
    cluster.centerLongitude = centroidLongitude(cluster.longitudeSinSum, cluster.longitudeCosSum);
    cluster.recentEvents.push(event);
    cluster.recentEvents.sort((a, b) => b.eventTimeMs - a.eventTimeMs ||
      (a.sourceEventKey ?? "").localeCompare(b.sourceEventKey ?? ""));
    if (cluster.recentEvents.length > this.recentEventLimit) cluster.recentEvents.length = this.recentEventLimit;
  }
}

export type ClusterParameterProfile = ClusterParameters;
export type ClusterSensitivityResult = {
  parameters: ClusterParameterProfile;
  freshEvents: number;
  staleRejected: number;
  futureRejected: number;
  metrics: ClusterShapeMetrics;
};
export type ClusterShapeMetrics = {
  totalClusters: number;
  activeClusters: number;
  closedClusters: number;
  largestClusterSize: number;
  medianClusterSize: number | null;
  singletonClusters: number;
  medianDurationMinutes: number | null;
  maxDurationMinutes: number;
  maxApproximateExtentKm: number;
  approximateExtentNote: string;
};

export function clusterShapeMetrics(clusters: LightningCluster[]): ClusterShapeMetrics {
  const sizes = clusters.map(cluster => cluster.eventCount);
  const durations = clusters.map(cluster => (cluster.lastEventTimeMs - cluster.firstEventTimeMs) / 60_000);
  const extents = clusters.map(cluster => greatCircleDistanceKm(cluster.minLatitude, cluster.minLongitude,
    cluster.maxLatitude, cluster.maxLongitude));
  return {
    totalClusters: clusters.length,
    activeClusters: clusters.filter(cluster => cluster.status === "active").length,
    closedClusters: clusters.filter(cluster => cluster.status === "closed").length,
    largestClusterSize: Math.max(0, ...sizes), medianClusterSize: percentile(sizes, .5),
    singletonClusters: sizes.filter(size => size === 1).length,
    medianDurationMinutes: percentile(durations, .5), maxDurationMinutes: Math.max(0, ...durations),
    maxApproximateExtentKm: Math.max(0, ...extents),
    approximateExtentNote: "Largest corner-to-corner diagonal of each cluster's latitude/longitude bounding box; approximate, not storm-cell size.",
  };
}

export function evaluateParameterProfiles(events: LightningEvent[], profiles: ClusterParameterProfile[], referenceTimeMs: number,
  recentEventLimit = 256): ClusterSensitivityResult[] {
  return profiles.map(parameters => {
    const clusterer = new OnlineLightningClusterer(parameters, recentEventLimit);
    let freshEvents = 0, staleRejected = 0, futureRejected = 0;
    for (const event of events) {
      const state = freshnessState(event, event.receivedAtMs, parameters.freshnessWindowMinutes);
      if (state === "stale") { staleRejected++; continue; }
      if (state === "future") { futureRejected++; continue; }
      freshEvents++;
      clusterer.ingest(event, event.receivedAtMs);
    }
    clusterer.advance(referenceTimeMs);
    return { parameters: { ...parameters }, freshEvents, staleRejected, futureRejected,
      metrics: clusterShapeMetrics(clusterer.clusters) };
  });
}

export const DEFAULT_PARAMETER_PROFILES: ClusterParameterProfile[] = [
  { maxSpatialDistanceKm: 5, maxTemporalGapMinutes: 5, freshnessWindowMinutes: 10, clusterCloseAfterMinutes: 15 },
  { maxSpatialDistanceKm: 8, maxTemporalGapMinutes: 10, freshnessWindowMinutes: 10, clusterCloseAfterMinutes: 15 },
  { maxSpatialDistanceKm: 12, maxTemporalGapMinutes: 10, freshnessWindowMinutes: 10, clusterCloseAfterMinutes: 15 },
  { maxSpatialDistanceKm: 8, maxTemporalGapMinutes: 5, freshnessWindowMinutes: 10, clusterCloseAfterMinutes: 15 },
  { maxSpatialDistanceKm: 8, maxTemporalGapMinutes: 10, freshnessWindowMinutes: 5, clusterCloseAfterMinutes: 15 },
  { maxSpatialDistanceKm: 8, maxTemporalGapMinutes: 10, freshnessWindowMinutes: 20, clusterCloseAfterMinutes: 15 },
];
