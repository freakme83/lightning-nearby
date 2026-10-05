// Research-only gate: dedupe -> subscription box -> optional local acceptance geometry -> freshness -> clustering.
import { BoundedDedupe, eventKey, inBox, type Box, type LightningEvent } from "../live-lightning-listener/core.ts";
import { freshnessState, OnlineLightningClusterer, type ClusterParameters, type LightningCluster } from "./clusterer.ts";

type MonitoringAcceptance = { id: string; bounds: Box; contains: (event: LightningEvent) => boolean };

export type PipelineCounters = {
  decoded: number;
  unique: number;
  duplicates: number;
  malformed: number;
  insideSubscriptionBox: number;
  outsideSubscriptionBox: number;
  insideSubscriptionBoxFresh: number;
  insideSubscriptionBoxStale: number;
  insideSubscriptionBoxFuture: number;
  insideSubscriptionBoxOutsideMonitoringArea: number;
  insideMonitoringArea: number;
  insideMonitoringAreaFresh: number;
  insideMonitoringAreaStale: number;
  insideMonitoringAreaFuture: number;
  allUniqueFresh: number;
  allUniqueStale: number;
  allUniqueFuture: number;
  retainedComparisonEvents: number;
  comparisonEventsDropped: number;
};

export class LightningClusteringPipeline {
  readonly clusterer: OnlineLightningClusterer;
  readonly counters: PipelineCounters = { decoded: 0, unique: 0, duplicates: 0, malformed: 0,
    insideSubscriptionBox: 0, outsideSubscriptionBox: 0,
    insideSubscriptionBoxFresh: 0, insideSubscriptionBoxStale: 0, insideSubscriptionBoxFuture: 0,
    insideSubscriptionBoxOutsideMonitoringArea: 0,
    insideMonitoringArea: 0, insideMonitoringAreaFresh: 0, insideMonitoringAreaStale: 0, insideMonitoringAreaFuture: 0,
    allUniqueFresh: 0, allUniqueStale: 0, allUniqueFuture: 0,
    retainedComparisonEvents: 0, comparisonEventsDropped: 0 };
  private readonly dedupe: BoundedDedupe;
  private readonly box: Box;
  private readonly monitoringArea?: MonitoringAcceptance;
  private readonly comparisonCapacity: number;
  readonly comparisonEvents: LightningEvent[] = [];

  constructor(box: Box, parameters: ClusterParameters, options: { dedupeCapacity?: number; comparisonCapacity?: number; recentEventLimit?: number; monitoringArea?: MonitoringAcceptance } = {}) {
    this.box = box;
    this.monitoringArea = options.monitoringArea;
    if (this.monitoringArea && (this.monitoringArea.bounds.north > box.north || this.monitoringArea.bounds.east > box.east ||
        this.monitoringArea.bounds.south < box.south || this.monitoringArea.bounds.west < box.west)) {
      throw new Error("subscription box must contain the monitoring area bounds");
    }
    this.dedupe = new BoundedDedupe(options.dedupeCapacity ?? 20_000);
    this.comparisonCapacity = options.comparisonCapacity ?? 100_000;
    if (!Number.isSafeInteger(this.comparisonCapacity) || this.comparisonCapacity < 1) throw new Error("invalid comparisonCapacity");
    this.clusterer = new OnlineLightningClusterer(parameters, options.recentEventLimit ?? 256);
  }

  recordMalformed(count = 1): void {
    if (!Number.isSafeInteger(count) || count < 0) throw new Error("invalid malformed count");
    this.counters.malformed += count;
  }

  accept(event: LightningEvent, processingTimeMs: number): { unique: boolean; insideSubscriptionBox: boolean; insideMonitoringArea: boolean; freshness?: "fresh" | "stale" | "future"; clusterId?: string } {
    this.counters.decoded++;
    if (this.dedupe.seen(eventKey(event))) {
      this.counters.duplicates++;
      return { unique: false, insideSubscriptionBox: false, insideMonitoringArea: false };
    }
    this.counters.unique++;
    const state = freshnessState(event, processingTimeMs, this.clusterer.parameters.freshnessWindowMinutes);
    if (state === "fresh") this.counters.allUniqueFresh++;
    else if (state === "stale") this.counters.allUniqueStale++;
    else this.counters.allUniqueFuture++;
    const insideSubscriptionBox = inBox(event, this.box);
    if (!insideSubscriptionBox) {
      this.counters.outsideSubscriptionBox++;
      return { unique: true, insideSubscriptionBox: false, insideMonitoringArea: false, freshness: state };
    }
    this.counters.insideSubscriptionBox++;
    if (state === "fresh") this.counters.insideSubscriptionBoxFresh++;
    else if (state === "stale") this.counters.insideSubscriptionBoxStale++;
    else this.counters.insideSubscriptionBoxFuture++;

    const insideMonitoringArea = !this.monitoringArea || this.monitoringArea.contains(event);
    if (!insideMonitoringArea) {
      this.counters.insideSubscriptionBoxOutsideMonitoringArea++;
      return { unique: true, insideSubscriptionBox: true, insideMonitoringArea: false, freshness: state };
    }
    this.counters.insideMonitoringArea++;
    if (state === "fresh") this.counters.insideMonitoringAreaFresh++;
    else if (state === "stale") this.counters.insideMonitoringAreaStale++;
    else this.counters.insideMonitoringAreaFuture++;
    if (this.comparisonEvents.length < this.comparisonCapacity) {
      this.comparisonEvents.push(event);
      this.counters.retainedComparisonEvents++;
    } else this.counters.comparisonEventsDropped++;
    if (state === "stale") {
      return { unique: true, insideSubscriptionBox: true, insideMonitoringArea: true, freshness: state };
    }
    if (state === "future") {
      return { unique: true, insideSubscriptionBox: true, insideMonitoringArea: true, freshness: state };
    }
    return { unique: true, insideSubscriptionBox: true, insideMonitoringArea: true, freshness: state,
      clusterId: this.clusterer.ingest(event, processingTimeMs) };
  }

  summary(nowMs: number) {
    this.clusterer.advance(nowMs);
    const clusters = this.clusterer.clusters;
    return { ...this.counters, activeClusters: clusters.filter(cluster => cluster.status === "active").length,
      closedClusters: clusters.filter(cluster => cluster.status === "closed").length, clusters };
  }

  closeAll(nowMs: number): LightningCluster[] {
    // Cluster lifecycle remains time-based. This returns clusters that actually aged out.
    return this.clusterer.advance(nowMs);
  }
}
