export type LocalityKind = "city" | "town" | "village" | "hamlet" | "municipality" | "other";

export type NormalizedPlace = {
  neighborhood?: string;
  locality?: string;
  localityKind?: LocalityKind;
  district?: string;
  province?: string;
  country?: string;
  rawType?: string;
};

export type ReverseGeocodeResult = NormalizedPlace & {
  latitude: number;
  longitude: number;
  displayLabel: string | null;
  provider: string;
  attribution?: string;
};

export interface ReverseGeocoder {
  reverse(latitude: number, longitude: number): Promise<ReverseGeocodeResult>;
}

export type NominatimPayload = {
  address?: Record<string, unknown>;
  type?: unknown;
  addresstype?: unknown;
};
