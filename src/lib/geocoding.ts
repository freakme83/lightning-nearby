import { isValidCoordinates, type LocationSelection } from "./location.ts";

export interface PlaceResult extends LocationSelection {
  label: string;
  source: "search";
}

/** Drop malformed or unusable API rows rather than exposing unsafe coordinates to the picker. */
export function parsePlaceResults(payload: unknown): PlaceResult[] {
  if (typeof payload !== "object" || payload === null || !Array.isArray((payload as { results?: unknown }).results)) return [];

  return (payload as { results: unknown[] }).results.flatMap((item): PlaceResult[] => {
    if (typeof item !== "object" || item === null) return [];
    const row = item as Record<string, unknown>;
    if (!isValidCoordinates(row.latitude, row.longitude) || typeof row.name !== "string" || !row.name.trim()) return [];
    return [{
      latitude: row.latitude as number,
      longitude: row.longitude as number,
      label: row.name.trim(),
      ...(typeof row.country === "string" && row.country.trim() ? { country: row.country.trim() } : {}),
      ...(typeof row.admin1 === "string" && row.admin1.trim() ? { admin1: row.admin1.trim() } : {}),
      source: "search",
    }];
  });
}

export async function searchPlaces(query: string, signal?: AbortSignal): Promise<PlaceResult[]> {
  const url = new URL("https://geocoding-api.open-meteo.com/v1/search");
  url.searchParams.set("name", query.trim());
  url.searchParams.set("count", "5");
  url.searchParams.set("language", "en");
  url.searchParams.set("format", "json");
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error("place-search-failed");
  return parsePlaceResults(await response.json());
}
