import { CG_REPEAT_MAX_TRACKED_SCOPES, CG_REPEAT_PROBE_MIN_INTERVAL_MS } from "./constants.ts";

// One running probe globally, one latest observation queued per scope. No timers or
// replay: live intake/housekeeping pumps the queue and rechecks eligibility at start.
type CoordinatorDependencies<T> = { now: () => number; eligible: (scope: string, value: T) => boolean;
  execute: (scope: string, value: T) => Promise<void>; onError?: (scope: string) => void };
export class CgProbeCoordinator<T> {
  private readonly scopes = new Map<string, { queued?: T; running: boolean; lastStarted: number; retired?: boolean }>();
  private task: Promise<void> | null = null;
  coalesced = 0;
  dropped = 0;
  private readonly dependencies: CoordinatorDependencies<T>;
  constructor(dependencies: CoordinatorDependencies<T>) { this.dependencies = dependencies; }
  offer(scope: string, value: T): void {
    let state = this.scopes.get(scope);
    if (!state) {
      if (this.scopes.size >= CG_REPEAT_MAX_TRACKED_SCOPES) { this.dropped++; return; }
      state = { running: false, lastStarted: -Infinity };
      this.scopes.set(scope, state);
    }
    if (state.queued !== undefined) this.coalesced++;
    state.queued = value;
    this.pump();
  }
  pump(): void {
    if (this.task) return;
    for (const [scope, state] of this.scopes) {
      if (state.queued === undefined) continue;
      const value = state.queued;
      if (!this.dependencies.eligible(scope, value)) { state.queued = undefined; this.dropped++; continue; }
      const now = this.dependencies.now();
      if (now - state.lastStarted < CG_REPEAT_PROBE_MIN_INTERVAL_MS) continue;
      state.queued = undefined; state.running = true; state.lastStarted = now;
      this.task = Promise.resolve().then(() => this.dependencies.execute(scope, value))
        .catch(() => this.dependencies.onError?.(scope)).finally(() => {
          state.running = false; if (state.retired) this.scopes.delete(scope);
          this.task = null; this.pump();
        });
      return;
    }
  }
  forget(scope: string): void {
    const state = this.scopes.get(scope);
    if (state?.running) { state.queued = undefined; state.retired = true; }
    else this.scopes.delete(scope);
  }
  async drain(): Promise<void> { while (this.task) await this.task; }
  get running(): boolean { return this.task !== null; }
}
