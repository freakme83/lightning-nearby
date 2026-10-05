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
  providerAddress?: ProviderAddressHierarchy;
};

export const PROVIDER_ADDRESS_FIELDS = [
  "neighbourhood", "quarter", "suburb", "city", "town", "village", "hamlet", "municipality",
  "city_district", "district", "county", "state_district", "province", "state", "region", "country",
] as const;

export type ProviderAddressHierarchy = Record<typeof PROVIDER_ADDRESS_FIELDS[number], string | null>;

export interface ReverseGeocoder {
  reverse(latitude: number, longitude: number): Promise<ReverseGeocodeResult>;
}

export type NominatimPayload = {
  address?: Record<string, unknown>;
  type?: unknown;
  addresstype?: unknown;
};
