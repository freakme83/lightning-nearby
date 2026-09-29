import { isValidCoordinates, type LocationSelection } from "./location.ts";

export interface PlaceResult extends LocationSelection {
  label: string;
  source: "search";
}

export interface PlaceSearchResults {
  results: PlaceResult[];
  fallbackMessage?: string;
}

export type PlaceLookup = (query: string, signal?: AbortSignal) => Promise<PlaceResult[]>;
export type ResolvedPlaceLabel = Pick<LocationSelection, "label" | "admin1" | "country">;
export const MIN_PLACE_QUERY_LENGTH = 3;
export const PLACE_SEARCH_DEBOUNCE_MS = 400;
const MAX_VISIBLE_PLACE_RESULTS = 5;

function limitedResults(results: PlaceResult[]): PlaceResult[] {
  return results.slice(0, MAX_VISIBLE_PLACE_RESULTS);
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

async function searchPlaceQuery(query: string, signal?: AbortSignal): Promise<PlaceResult[]> {
  const url = new URL("https://geocoding-api.open-meteo.com/v1/search");
  url.searchParams.set("name", query.trim());
  // A few extra rows help find context-matching localities without showing a long list.
  url.searchParams.set("count", "10");
  url.searchParams.set("language", "en");
  url.searchParams.set("format", "json");
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error("place-search-failed");
  const payload: unknown = await response.json();
  if (signal?.aborted) throw signal.reason ?? new DOMException("Search superseded", "AbortError");
  return parsePlaceResults(payload);
}

function normalized(value: string): string {
  return value.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLocaleLowerCase("en");
}

function matchesContext(place: PlaceResult, context: string): boolean {
  const haystack = normalized([place.label, place.admin1, place.country].filter(Boolean).join(" "));
  return normalized(context).split(/\s+/).filter(Boolean).every((word) => haystack.includes(word));
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new DOMException("Search superseded", "AbortError");
}

/** Search the full phrase first, then use comma-separated components as a small fallback. */
export async function searchPlaces(query: string, signal?: AbortSignal, lookup: PlaceLookup = searchPlaceQuery): Promise<PlaceSearchResults> {
  const fullQuery = query.trim();
  if (Array.from(fullQuery).length < MIN_PLACE_QUERY_LENGTH) return { results: [] };
  const exact = await lookup(fullQuery, signal);
  throwIfAborted(signal);
  if (exact.length || !fullQuery.includes(",")) return { results: limitedResults(exact) };

  const parts = fullQuery.split(",").map((part) => part.trim()).filter(Boolean);
  if (parts.length < 2) return { results: exact };

  const primaryResults = await lookup(parts[0], signal);
  throwIfAborted(signal);
  const matching = primaryResults.filter((place) => parts.slice(1).some((context) => matchesContext(place, context)));
  if (matching.length) {
    return { results: limitedResults(matching), fallbackMessage: `No exact combined match; showing “${parts[0]}” results matching the remaining location context.` };
  }

  // A small place may not exist in the gazetteer. Offer its broader context as a map starting point
  // instead of presenting same-named places from unrelated regions as if they matched.
  for (const context of parts.slice(1).reverse()) {
    throwIfAborted(signal);
    const broaderResults = await lookup(context, signal);
    throwIfAborted(signal);
    if (broaderResults.length) {
      return { results: limitedResults(broaderResults), fallbackMessage: `No exact match found; showing the broader place “${context}”. Refine the point on the map.` };
    }
  }

  return {
    results: limitedResults(primaryResults),
    ...(primaryResults.length ? { fallbackMessage: `No exact combined match; showing results for “${parts[0]}” only. Check the region before selecting.` } : {}),
  };
}

/** Pick concise place fields from Nominatim's variable address object; never replace coordinates. */
export function parseReversePlace(payload: unknown): ResolvedPlaceLabel | null {
  if (typeof payload !== "object" || payload === null) return null;
  const row = payload as Record<string, unknown>;
  if (typeof row.address !== "object" || row.address === null) return null;
  const address = row.address as Record<string, unknown>;
  const firstString = (...values: unknown[]) => values.find((value): value is string => typeof value === "string" && Boolean(value.trim()))?.trim();
  const label = firstString(address.neighbourhood, address.suburb, address.city_district, address.quarter,
    address.town, address.village, address.city, address.municipality, address.county, address.hamlet, row.name);
  const admin1 = firstString(address.state, address.province, address.region);
  const country = firstString(address.country);
  if (!label && !admin1 && !country) return null;
  return {
    ...(label ? { label } : {}),
    ...(admin1 ? { admin1 } : {}),
    ...(country ? { country } : {}),
  };
}

export async function reverseGeocodeLocation(
  latitude: number,
  longitude: number,
  signal?: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<ResolvedPlaceLabel | null> {
  const url = new URL("https://nominatim.openstreetmap.org/reverse");
  url.searchParams.set("lat", String(latitude));
  url.searchParams.set("lon", String(longitude));
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("addressdetails", "1");
  url.searchParams.set("zoom", "14");
  url.searchParams.set("accept-language", "en");
  try {
    const response = await fetcher(url, { signal, referrerPolicy: "strict-origin" });
    if (!response.ok) return null;
    const payload: unknown = await response.json();
    if (signal?.aborted) throw signal.reason ?? new DOMException("Lookup cancelled", "AbortError");
    return parseReversePlace(payload);
  } catch (error) {
    if (signal?.aborted) throw error;
    return null;
  }
}
