import type { BlitzortungProbeEvent, BlitzortungServer } from "./protocol.ts";

export type BlitzConnectionState = "disconnected" | "connecting" | "connected" | "receiving";

export class BlitzortungProbeState {
  readonly startedAtMs: number;
  blitzConnectionState: BlitzConnectionState = "disconnected";
  blitzFramesReceived = 0;
  blitzFramesDecoded = 0;
  blitzDecodeFailures = 0;
  blitzJsonParseFailures = 0;
  blitzUnexpectedPayloads = 0;
  blitzEventsParsed = 0;
  blitzEventsInsideMonitoringArea = 0;
  blitzEventsOutsideMonitoringArea = 0;
  blitzReconnects = 0;
  blitzLastFrameReceivedAtMs: number | null = null;
  blitzLastStrikeEventTimeMs: number | null = null;
  blitzSourceServer: BlitzortungServer | null = null;
  private readonly latenciesMs: number[] = [];

  constructor(startedAtMs: number) { this.startedAtMs = startedAtMs; }
  connecting(server: BlitzortungServer): void {
    this.blitzSourceServer = server;
    this.blitzConnectionState = "connecting";
  }
  connected(): void { this.blitzConnectionState = "connected"; }
  disconnected(): void { this.blitzConnectionState = "disconnected"; }
  frame(receivedAtMs: number): void {
    this.blitzConnectionState = "receiving";
    this.blitzFramesReceived++;
    this.blitzLastFrameReceivedAtMs = receivedAtMs;
  }
  decoded(): void { this.blitzFramesDecoded++; }
  decodeFailure(): void { this.blitzDecodeFailures++; }
  jsonParseFailure(): void { this.blitzJsonParseFailures++; }
  unexpectedPayload(): void { this.blitzUnexpectedPayloads++; }
  reconnect(): void { this.blitzReconnects++; }
  event(event: BlitzortungProbeEvent): void {
    this.blitzEventsParsed++;
    if (event.insideMonitoringArea) this.blitzEventsInsideMonitoringArea++;
    else this.blitzEventsOutsideMonitoringArea++;
    this.blitzLastStrikeEventTimeMs = event.eventTimeMs;
    if (this.latenciesMs.length < 10_000) this.latenciesMs.push(event.latencyMs);
  }
  summary(nowMs = Date.now()): Record<string, string | number | null> {
    const sorted = [...this.latenciesMs].sort((a, b) => a - b);
    const middle = sorted.length ? sorted[Math.floor((sorted.length - 1) / 2)] : null;
    return {
      blitzUptimeSeconds: Math.max(0, Math.round((nowMs - this.startedAtMs) / 1_000)),
      blitzConnectionState: this.blitzConnectionState,
      blitzFramesReceived: this.blitzFramesReceived,
      blitzFramesDecoded: this.blitzFramesDecoded,
      blitzDecodeFailures: this.blitzDecodeFailures,
      blitzJsonParseFailures: this.blitzJsonParseFailures,
      blitzUnexpectedPayloads: this.blitzUnexpectedPayloads,
      blitzEventsParsed: this.blitzEventsParsed,
      blitzEventsInsideMonitoringArea: this.blitzEventsInsideMonitoringArea,
      blitzEventsOutsideMonitoringArea: this.blitzEventsOutsideMonitoringArea,
      blitzReconnects: this.blitzReconnects,
      blitzLastFrameReceivedAt: this.blitzLastFrameReceivedAtMs === null ? null : new Date(this.blitzLastFrameReceivedAtMs).toISOString(),
      blitzLastStrikeEventTime: this.blitzLastStrikeEventTimeMs === null ? null : new Date(this.blitzLastStrikeEventTimeMs).toISOString(),
      blitzLatencyMinMs: sorted[0] ?? null,
      blitzLatencyMedianMs: middle,
      blitzLatencyMaxMs: sorted.at(-1) ?? null,
    };
  }
}
