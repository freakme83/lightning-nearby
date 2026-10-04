// Research-only gate: dedupe -> local box -> freshness -> clustering.
import { BoundedDedupe, eventKey, inBox, type Box, type LightningEvent } from "../live-lightning-listener/core.ts";
import { freshnessState, OnlineLightningClusterer, type ClusterParameters, type LightningCluster } from "./clusterer.ts";

export type PipelineCounters = {
  decoded: number;
  unique: number;
  duplicates: number;
  malformed: number;
  insideBox: number;
  outsideBox: number;
  fresh: number;
  stale: number;
  future: number;
  retainedComparisonEvents: number;
  comparisonEventsDropped: number;
};

export class LightningClusteringPipeline {
  readonly clusterer: OnlineLightningClusterer;
  readonly counters: PipelineCounters = { decoded: 0, unique: 0, duplicates: 0, malformed: 0,
    insideBox: 0, outsideBox: 0, fresh: 0, stale: 0, future: 0,
    retainedComparisonEvents: 0, comparisonEventsDropped: 0 };
  private readonly dedupe: BoundedDedupe;
  private readonly box: Box;
  private readonly comparisonCapacity: number;
  readonly comparisonEvents: LightningEvent[] = [];

  constructor(box: Box, parameters: ClusterParameters, options: { dedupeCapacity?: number; comparisonCapacity?: number; recentEventLimit?: number } = {}) {
    this.box = box;
    this.dedupe = new BoundedDedupe(options.dedupeCapacity ?? 20_000);
    this.comparisonCapacity = options.comparisonCapacity ?? 100_000;
    if (!Number.isSafeInteger(this.comparisonCapacity) || this.comparisonCapacity < 1) throw new Error("invalid comparisonCapacity");
    this.clusterer = new OnlineLightningClusterer(parameters, options.recentEventLimit ?? 256);
  }

  recordMalformed(count = 1): void {
    if (!Number.isSafeInteger(count) || count < 0) throw new Error("invalid malformed count");
    this.counters.malformed += count;
  }

  accept(event: LightningEvent, processingTimeMs: number): { unique: boolean; insideBox: boolean; freshness?: "fresh" | "stale" | "future"; clusterId?: string } {
    this.counters.decoded++;
    if (this.dedupe.seen(eventKey(event))) { this.counters.duplicates++; return { unique: false, insideBox: false }; }
    this.counters.unique++;
    const insideBox = inBox(event, this.box);
    if (insideBox) {
      this.counters.insideBox++;
      if (this.comparisonEvents.length < this.comparisonCapacity) {
        this.comparisonEvents.push(event);
        this.counters.retainedComparisonEvents++;
      }
      else this.counters.comparisonEventsDropped++;
    } else this.counters.outsideBox++;
    const state = freshnessState(event, processingTimeMs, this.clusterer.parameters.freshnessWindowMinutes);
    if (state === "stale") { this.counters.stale++; return { unique: true, insideBox, freshness: state }; }
    if (state === "future") { this.counters.future++; return { unique: true, insideBox, freshness: state }; }
    if (!insideBox) return { unique: true, insideBox, freshness: state };
    this.counters.fresh++;
    return { unique: true, insideBox: true, freshness: state, clusterId: this.clusterer.ingest(event, processingTimeMs) };
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
