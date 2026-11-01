// Capture-only readiness; production Blitz health retains its existing semantics.
export class CaptureSourceReadiness {
  private lastDecodedAt: number | null = null;

  beginConnection(): void { this.lastDecodedAt = null; }
  validEvent(at: number): void { this.lastDecodedAt = at; }
  isReady(socketOpen: boolean, now: number, maxAgeMs: number): boolean {
    return socketOpen && this.lastDecodedAt !== null &&
      now >= this.lastDecodedAt && now - this.lastDecodedAt < maxAgeMs;
  }
}
