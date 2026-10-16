import type { ObserverSource } from "./core.ts";

export class ObserverSocketOwnership<T> {
  private current: T | null = null;
  get active(): T | null { return this.current; }
  claim(socket: T): void { this.current = socket; }
  owns(socket: T): boolean { return this.current === socket; }
  release(socket: T): boolean {
    if (!this.owns(socket)) return false;
    this.current = null;
    return true;
  }
}

/** Returns false when shutdown cancels the wait. */
export function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise(resolve => {
    const timer = setTimeout(() => finish(true), milliseconds);
    const onAbort = () => finish(false);
    const finish = (completed: boolean) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve(completed);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export function observerReconnectDelayMs(attempt: number, random = Math.random()): number {
  const ceiling = Math.min(60_000, 1_000 * 2 ** Math.min(6, Math.max(0, attempt)));
  return Math.floor(ceiling * (0.5 + Math.max(0, Math.min(1, random)) * 0.5));
}

export type ResilientSourceLoopOptions = {
  source: ObserverSource;
  signal: AbortSignal;
  connectOnce: () => Promise<boolean>;
  onFailure: (error: unknown) => void;
  onReconnectWait: (waitMs: number, attempt: number) => void;
  random?: () => number;
};

/**
 * Supervises exactly one observer source. Each source owns a separate instance,
 * so rejection or backoff here cannot stop the opposite source loop.
 */
export async function runResilientSourceLoop(options: ResilientSourceLoopOptions): Promise<void> {
  let attempt = 0;
  while (!options.signal.aborted) {
    let opened = false;
    try {
      opened = await options.connectOnce();
    } catch (error) {
      options.onFailure(error);
    }
    if (options.signal.aborted) break;
    if (opened) attempt = 0;
    const waitMs = observerReconnectDelayMs(attempt, options.random?.() ?? Math.random());
    options.onReconnectWait(waitMs, attempt);
    attempt++;
    if (!await abortableDelay(waitMs, options.signal)) break;
  }
}
