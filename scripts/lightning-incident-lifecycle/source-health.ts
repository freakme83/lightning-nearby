export type SourceHealth =
  | { state: "connecting"; sinceMs: number }
  | { state: "live"; lastFrameAtMs: number }
  | { state: "stale"; lastFrameAtMs: number }
  | { state: "disconnected"; sinceMs: number };

export type SourceHealthTransition = { from: SourceHealth["state"]; to: SourceHealth["state"]; atMs: number };

export class SourceHealthTracker {
  readonly staleAfterMs: number;
  state: SourceHealth;
  interruptions = 0;
  constructor(startedAtMs: number, staleAfterMs = 90_000) {
    if (!Number.isFinite(staleAfterMs) || staleAfterMs <= 0) throw new Error("invalid staleAfterMs");
    this.staleAfterMs = staleAfterMs;
    this.state = { state: "disconnected", sinceMs: startedAtMs };
  }
  connecting(atMs: number): SourceHealthTransition | null { return this.move({ state: "connecting", sinceMs: atMs }, atMs); }
  frame(atMs: number): SourceHealthTransition | null { return this.move({ state: "live", lastFrameAtMs: atMs }, atMs); }
  disconnected(atMs: number, countAsInterruption = true): SourceHealthTransition | null {
    return this.move({ state: "disconnected", sinceMs: atMs }, atMs, countAsInterruption);
  }
  poll(atMs: number): SourceHealthTransition | null {
    if (this.state.state !== "live" || atMs - this.state.lastFrameAtMs < this.staleAfterMs) return null;
    return this.move({ state: "stale", lastFrameAtMs: this.state.lastFrameAtMs }, atMs);
  }
  private move(next: SourceHealth, atMs: number, countAsInterruption = true): SourceHealthTransition | null {
    const from = this.state.state;
    if (from === next.state) {
      this.state = next;
      return null;
    }
    if (countAsInterruption && from === "live" && next.state !== "live") this.interruptions++;
    this.state = next;
    return { from, to: next.state, atMs };
  }
}
