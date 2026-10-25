export const LEDGER_HEALTH_INTERVAL_MS = 6 * 60 * 60_000;

type LedgerHealthOptions = {
  check: (signal: AbortSignal) => Promise<void>;
  emit: (kind: string, fields: Record<string, unknown>) => void;
  now?: () => number;
};

function failureCategory(error: unknown, signal: AbortSignal): string {
  if (signal.aborted || error instanceof Error && error.name === "TimeoutError") return "timeout";
  if (error instanceof Error && /^Supabase health query failed \(HTTP \d+\)\.$/.test(error.message)) return "http_error";
  return "connection_error";
}

export function createLedgerHealthMonitor(options: LedgerHealthOptions) {
  const now = options.now ?? Date.now;
  let timer: ReturnType<typeof setInterval> | null = null;
  let active = false;
  let stopped = false;
  let controller: AbortController | null = null;

  async function runOnce(): Promise<void> {
    if (active || stopped) return;
    active = true;
    const startedAt = now();
    const requestController = new AbortController();
    controller = requestController;
    try {
      await options.check(requestController.signal);
      if (!stopped) options.emit("supabase_health_check", { at: new Date(now()).toISOString(),
        status: "ok", latencyMs: Math.max(0, now() - startedAt) });
    } catch (error) {
      if (!stopped) options.emit("supabase_health_check", { at: new Date(now()).toISOString(),
        status: "error", latencyMs: Math.max(0, now() - startedAt), reason: failureCategory(error, requestController.signal) });
    } finally {
      if (controller === requestController) controller = null;
      active = false;
    }
  }

  function start(): void {
    if (timer || stopped) return;
    timer = setInterval(() => { void runOnce(); }, LEDGER_HEALTH_INTERVAL_MS);
    timer.unref?.();
  }

  function stop(): void {
    stopped = true;
    if (timer) clearInterval(timer);
    timer = null;
    controller?.abort();
  }

  return { start, stop, runOnce };
}
