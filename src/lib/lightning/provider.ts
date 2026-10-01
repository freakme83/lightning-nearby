import type { LiveStrike, ProviderResult, RecentAreaProviderResult } from "./types.ts";

export interface LightningProvider {
  fetchRecentActivity(latitude: number, longitude: number, signal?: AbortSignal): Promise<ProviderResult>;
}

export interface LiveLightningProvider {
  fetchRecentArea(latitude: number, longitude: number, signal?: AbortSignal): Promise<RecentAreaProviderResult>;
  fetchCurrentFlashes(latitude: number, longitude: number, signal?: AbortSignal): Promise<ProviderResult>;
}

export type { LiveStrike };
