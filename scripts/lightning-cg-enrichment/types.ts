export type EnrichmentReference = {
  latitude: number;
  longitude: number;
  eventTimeMs: number;
};

export type EnrichmentOptions = {
  radiusKm?: number;
  maxMatchDistanceKm?: number;
  maxTimeDifferenceMs?: number;
  limit?: number;
};

export type MatchThresholds = {
  radiusKm: number;
  maxMatchDistanceKm: number;
  maxTimeDifferenceMs: number;
  limit: number;
};

export type LightningType = "cg" | "ic";

export type XweatherLightningEvent = {
  id: string;
  type: LightningType;
  latitude: number;
  longitude: number;
  eventTimeMs: number;
  peakAmp?: number;
  numSensors?: number;
};

export type LightningMatch = XweatherLightningEvent & {
  distanceKm: number;
  timeDifferenceMs: number;
};

export type MatchCounts = {
  returned: number;
  matched: number;
  matchedCg: number;
  matchedIc: number;
};

export type CostDiagnostics = {
  tokens?: number;
  multipliers?: string;
  endpoint?: string;
  rateLimit?: Record<string, string>;
};

export type EnrichmentResult = {
  status: "cg_verified" | "ic_only" | "no_match" | "provider_unavailable";
  provider: "xweather";
  reference: EnrichmentReference;
  thresholds: MatchThresholds;
  counts?: MatchCounts;
  match?: LightningMatch;
  cost?: CostDiagnostics;
  failure?: "missing_credentials" | "network_error" | "http_error" | "malformed_response";
  httpStatus?: number;
};

export type ParsedXweatherPayload = {
  events: XweatherLightningEvent[];
  counts: MatchCounts;
  cost: CostDiagnostics;
};
