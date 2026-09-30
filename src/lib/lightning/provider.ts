import type { LiveStrike, ProviderResult } from "./types.ts";

export interface LightningProvider {
  fetchRecentActivity(latitude: number, longitude: number, signal?: AbortSignal): Promise<ProviderResult>;
}

export type { LiveStrike };
