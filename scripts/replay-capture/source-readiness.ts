// Capture-only readiness; production Blitz health retains its existing semantics.
export class CaptureSourceReadiness {
  private lastDecodedAt: number | null = null;
  private connectionGeneration = 0;

  beginConnection(): void { this.connectionGeneration++; this.lastDecodedAt = null; }
  generation(): number { return this.connectionGeneration; }
  validEvent(at: number): void { this.lastDecodedAt = at; }
  isReady(socketOpen: boolean, now: number, maxAgeMs: number): boolean {
    return socketOpen && this.lastDecodedAt !== null &&
      now >= this.lastDecodedAt && now - this.lastDecodedAt < maxAgeMs;
  }
}
