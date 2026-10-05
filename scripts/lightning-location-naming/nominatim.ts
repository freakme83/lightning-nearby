import { normalizeNominatimAddress, makeDisplayLabel, validateCoordinates } from "./normalize.ts";
import type { ReverseGeocodeResult, ReverseGeocoder } from "./types.ts";

export class ReverseGeocodeError extends Error {
  readonly code: "timeout" | "network" | "http" | "malformed";
  readonly status?: number;

  constructor(code: "timeout" | "network" | "http" | "malformed", message: string, status?: number) {
    super(message);
    this.name = "ReverseGeocodeError";
    this.code = code;
    this.status = status;
  }
}

export type NominatimOptions = {
  fetcher?: typeof fetch;
  timeoutMs?: number;
  baseUrl?: string;
  userAgent?: string;
};

// Public Nominatim policy caps use at one request/second. Serialize this process's calls.
let nextAllowedRequestAt = 0;
let rateLimitQueue: Promise<void> = Promise.resolve();

async function waitForPublicRateLimit(): Promise<void> {
  const scheduled = rateLimitQueue.then(async () => {
    const waitMs = nextAllowedRequestAt - Date.now();
    if (waitMs > 0) await new Promise<void>((resolve) => setTimeout(resolve, waitMs));
    nextAllowedRequestAt = Date.now() + 1100;
  });
  rateLimitQueue = scheduled.catch(() => undefined);
  await scheduled;
}

export class NominatimReverseGeocoder implements ReverseGeocoder {
  readonly #fetcher: typeof fetch;
  readonly #timeoutMs: number;
  readonly #baseUrl: string;
  readonly #userAgent: string;

  constructor(options: NominatimOptions = {}) {
    this.#fetcher = options.fetcher ?? fetch;
    this.#timeoutMs = options.timeoutMs ?? 8000;
    this.#baseUrl = options.baseUrl ?? "https://nominatim.openstreetmap.org/reverse";
    this.#userAgent = options.userAgent ?? "LightningNearbyLocationNamingResearch/1.0 (https://github.com/freakme83/lightning-nearby)";
  }

  async reverse(latitude: number, longitude: number): Promise<ReverseGeocodeResult> {
    validateCoordinates(latitude, longitude);
    await waitForPublicRateLimit();
    const url = new URL(this.#baseUrl);
    url.searchParams.set("lat", String(latitude));
    url.searchParams.set("lon", String(longitude));
    url.searchParams.set("format", "jsonv2");
    url.searchParams.set("addressdetails", "1");
    url.searchParams.set("accept-language", "tr");

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new DOMException("Reverse geocode timed out", "TimeoutError")), this.#timeoutMs);
    let response: Response;
    try {
      response = await this.#fetcher(url, {
        signal: controller.signal,
        headers: { "User-Agent": this.#userAgent, Accept: "application/json" },
      });
    } catch (error) {
      clearTimeout(timer);
      const timeout = controller.signal.aborted;
      throw new ReverseGeocodeError(timeout ? "timeout" : "network", timeout ? "Nominatim request timed out" : "Nominatim network request failed");
    }
    if (!response.ok) {
      clearTimeout(timer);
      throw new ReverseGeocodeError("http", `Nominatim returned HTTP ${response.status}`, response.status);
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      clearTimeout(timer);
      if (controller.signal.aborted) throw new ReverseGeocodeError("timeout", "Nominatim request timed out");
      throw new ReverseGeocodeError("malformed", "Nominatim response was not valid JSON");
    }
    clearTimeout(timer);
    let place;
    try {
      place = normalizeNominatimAddress(payload);
    } catch (error) {
      throw new ReverseGeocodeError("malformed", error instanceof Error ? error.message : "Nominatim response shape was invalid");
    }
    return {
      latitude,
      longitude,
      ...place,
      displayLabel: makeDisplayLabel(place),
      provider: "nominatim",
      attribution: "© OpenStreetMap contributors",
    };
  }
}
