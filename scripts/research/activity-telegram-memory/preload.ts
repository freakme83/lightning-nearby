// Local-only memory check for the Fly worker with Activity Telegram. Loaded with --import before
// the unmodified worker.ts. Every fetch and WebSocket is intercepted in-process: nothing reaches
// Supabase, Telegram, Xweather, Nominatim or Blitzortung. Never run this against production.
//   MEMORY_CHECK_DETECTIONS=10000 node --experimental-strip-types \
//     --import ./scripts/research/activity-telegram-memory/preload.ts scripts/fly-ankara-worker/worker.ts
const N = Number(process.env.MEMORY_CHECK_DETECTIONS ?? "10000");
const WARMUP_MS = Number(process.env.MEMORY_CHECK_WARMUP_MS ?? "60000");
const AFTER_MS = 25_000;
const FRAMES_PER_SECOND = 60, ANKARA_SHARE = 0.05; // heavy global stream, active storm over Ankara
Object.assign(process.env, { XWEATHER_CLIENT_ID: "local", XWEATHER_CLIENT_SECRET: "local",
  SUPABASE_URL: "https://memory-check.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "local-not-a-key",
  TELEGRAM_BOT_TOKEN: "123456:LOCAL_MEMORY_CHECK_NOT_A_TOKEN", TELEGRAM_CHAT_ID: "-1",
  CONTINUOUS_CAPTURE_ENABLED: "true", ACTIVITY_WATCH_ENABLED: "true", ACTIVITY_TELEGRAM_ENABLED: "true" });

const PID = "11111111-1111-4111-8111-111111111111";
const T = Date.now() - 4 * 3600_000;
const pg = (ms: number) => new Date(ms).toISOString().replace("Z", "+00:00");
const key = (n: number) => n.toString(16).padStart(64, "0");
const at = (n: number) => T + Math.floor(n * (3 * 3600_000) / Math.max(1, N));
const period = { period_id: PID, state: "closed", started_at: pg(at(0)), last_detection_at: pg(at(N - 1)),
  detection_count: N, closed_at: pg(at(N - 1) + 1_800_000), coverage_uncertain: true, interruption_count: 4,
  source_health: "healthy", healthy_since: pg(T) };
const member = (n: number) => ({ event_key: key(n), period_id: PID, event_time: pg(at(n)), received_at: pg(at(n) + 900) });
const capture = (n: number) => ({ event_key: key(n), event_time: pg(at(n)), event_time_raw: `${at(n)}000000`,
  event_time_unit: "nanoseconds", received_at: pg(at(n) + 900), latitude: 39.4 + (n % 97) / 120,
  longitude: 32.2 + (n % 89) / 70, provider: "blitzortung", source_server: "ws1", station_count: 7 + (n % 9),
  polygon_id: "ankara-sha256:x" });

const startedAt = Date.now();
let phase: "warmup" | "export" | "after" = "warmup";
const peaks = { warmup: 0, export: 0, after: 0 };
let warmupSamples: number[] = [], claims = 0, documents = 0, documentBytes = 0, telegramMessages = 0;
const sampler = setInterval(() => {
  const rss = process.memoryUsage().rss;
  peaks[phase] = Math.max(peaks[phase], rss);
  if (phase === "warmup" && Date.now() - startedAt > WARMUP_MS / 2) warmupSamples.push(rss);
}, 50);
sampler.unref();

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status,
  headers: { "Content-Type": "application/json" } });
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  if (url.hostname === "api.telegram.org") {
    if (url.pathname.endsWith("/sendDocument")) {
      const form = init?.body as FormData;
      const file = form.get("document") as Blob;
      documents++; documentBytes = file.size;
    } else telegramMessages++;
    return json({ ok: true, result: { message_id: 1 } });
  }
  if (url.hostname !== "memory-check.supabase.co") return json({ error: "offline" }, 503);
  const path = url.pathname;
  if (path === "/rest/v1/rpc/claim_ankara_activity_notification") {
    claims++;
    if (phase === "warmup" && Date.now() - startedAt >= WARMUP_MS) {
      phase = "export";
      return json({ outcome: "claimed", notification: { period_id: PID, kind: "end",
        idempotency_key: `ankara-activity:v1:${PID}:end`, attempts: 0, prepare_failures: 0 }, period });
    }
    return json({ outcome: "idle" });
  }
  if (path === "/rest/v1/rpc/begin_ankara_activity_notification_send") return json({ outcome: "proceed" });
  if (path === "/rest/v1/rpc/complete_ankara_activity_notification") {
    if (phase === "export") { phase = "after"; setTimeout(finish, AFTER_MS).unref(); }
    return json({ outcome: "recorded" });
  }
  if (path === "/rest/v1/rpc/sync_ankara_activity_watch") {
    const events = JSON.parse(String(init?.body)).p_events as unknown[];
    return json({ state: "active", periodId: "22222222-2222-4222-8222-222222222222", processed: events.length });
  }
  if (path === "/rest/v1/ankara_activity_periods") return json([period]);
  if (path === "/rest/v1/ankara_activity_period_events") {
    const offset = Number(url.searchParams.get("offset") ?? 0), limit = Number(url.searchParams.get("limit") ?? 1);
    return json(Array.from({ length: Math.max(0, Math.min(limit, N - offset)) }, (_, i) => member(offset + i)));
  }
  if (path === "/rest/v1/continuous_capture_strikes" && (init?.method ?? "GET") === "GET") {
    const keys = /^in\.\((.*)\)$/.exec(url.searchParams.get("event_key") ?? "")?.[1].split(",") ?? [];
    return json(keys.map(k => capture(parseInt(k, 16))));
  }
  if ((init?.method ?? "GET") === "GET") return json([]);
  return json({}, 201);
}) as typeof fetch;

class LocalWebSocket extends EventTarget {
  static readonly OPEN = 1;
  readyState = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  constructor() {
    super();
    setTimeout(() => { this.readyState = 1; this.dispatchEvent(new Event("open")); }, 50);
  }
  send() {
    let sequence = 0;
    this.timer = setInterval(() => {
      for (let i = 0; i < FRAMES_PER_SECOND / 10; i++) {
        const ankara = Math.random() < ANKARA_SHARE;
        const now = Date.now();
        // ASCII-only payloads are valid literal frames for the feed's LZW decoder.
        const payload = JSON.stringify({ time: `${now - 800}${String(++sequence % 1_000_000).padStart(6, "0")}`,
          lat: ankara ? 39.5 + Math.random() * 0.8 : -60 + Math.random() * 120,
          lon: ankara ? 32.2 + Math.random() * 1.2 : -180 + Math.random() * 360, alt: 0, pol: 0, mds: 9000, mcg: 200,
          status: 0, region: 1, sig: [] });
        const event = new Event("message") as Event & { data: string };
        Object.defineProperty(event, "data", { value: payload });
        this.dispatchEvent(event);
      }
    }, 100);
  }
  close() {
    if (this.timer) clearInterval(this.timer);
    this.readyState = 3;
    const event = new Event("close") as Event & { code: number; reason: string; wasClean: boolean };
    Object.assign(event, { code: 1000, reason: "", wasClean: true });
    this.dispatchEvent(event);
  }
}
(globalThis as unknown as { WebSocket: unknown }).WebSocket = LocalWebSocket;

const mb = (bytes: number) => Math.round(bytes / 1048576);
function finish() {
  warmupSamples = warmupSamples.sort((a, b) => a - b);
  console.error(JSON.stringify({ kind: "memory_check_result", detections: N, node: process.version,
    baselineMedianRssMB: mb(warmupSamples[Math.floor(warmupSamples.length / 2)] ?? 0),
    warmupPeakRssMB: mb(peaks.warmup), postExportSampledRssMB: mb(Math.max(peaks.export, peaks.after)),
    // Kernel-tracked true peak, including the synchronous export build the sampler cannot observe.
    processPeakRssMB: Math.round(process.resourceUsage().maxRSS / 1024),
    claims, documents, documentMB: +(documentBytes / 1048576).toFixed(1), telegramMessages }));
  process.exit(0);
}
