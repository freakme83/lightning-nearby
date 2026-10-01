import { isValidCoordinates, type LocationSelection } from "./location.ts";

export interface PlaceResult extends LocationSelection {
  label: string;
  source: "search";
  /** Additional Open-Meteo administrative levels used only while matching search context. */
  admin2?: string;
  admin3?: string;
  admin4?: string;
}

export interface PlaceSearchResults {
  results: PlaceResult[];
  fallbackMessage?: string;
}

export type PlaceLookup = (query: string, signal?: AbortSignal) => Promise<PlaceResult[]>;
export type ResolvedPlaceLabel = Pick<LocationSelection, "label" | "admin1" | "country">;
export type CoordinateQuery =
  | { kind: "coordinates"; latitude: number; longitude: number }
  | { kind: "invalid" }
  | { kind: "not-coordinate" };
export const MIN_PLACE_QUERY_LENGTH = 3;
export const PLACE_SEARCH_DEBOUNCE_MS = 400;
export const INITIAL_VISIBLE_PLACE_RESULTS = 5;
const COORDINATE_VALUE = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/;
const NUMERIC_LIKE_VALUE = /^[+\-.\deE]+$/;

/** Recognize only a complete comma-separated latitude/longitude pair. */
export function parseCoordinateQuery(query: string): CoordinateQuery {
  const parts = query.trim().split(",");
  if (parts.length !== 2) return { kind: "not-coordinate" };
  const [latitudeText, longitudeText] = parts.map((part) => part.trim());
  if (!NUMERIC_LIKE_VALUE.test(latitudeText) || !NUMERIC_LIKE_VALUE.test(longitudeText)) return { kind: "not-coordinate" };
  if (!COORDINATE_VALUE.test(latitudeText) || !COORDINATE_VALUE.test(longitudeText)) return { kind: "invalid" };
  const latitude = Number(latitudeText);
  const longitude = Number(longitudeText);
  if (!isValidCoordinates(latitude, longitude)) return { kind: "invalid" };
  return { kind: "coordinates", latitude, longitude };
}

export function visiblePlaceResults(results: PlaceResult[], expanded: boolean): PlaceResult[] {
  return expanded ? results : results.slice(0, INITIAL_VISIBLE_PLACE_RESULTS);
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
      ...(typeof row.timezone === "string" && row.timezone.trim() ? { timezone: row.timezone.trim() } : {}),
      ...(typeof row.country === "string" && row.country.trim() ? { country: row.country.trim() } : {}),
      ...(typeof row.admin1 === "string" && row.admin1.trim() ? { admin1: row.admin1.trim() } : {}),
      ...(typeof row.admin2 === "string" && row.admin2.trim() ? { admin2: row.admin2.trim() } : {}),
      ...(typeof row.admin3 === "string" && row.admin3.trim() ? { admin3: row.admin3.trim() } : {}),
      ...(typeof row.admin4 === "string" && row.admin4.trim() ? { admin4: row.admin4.trim() } : {}),
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
  const metadataWords = new Set(normalized([
    place.label, place.admin1, place.admin2, place.admin3, place.admin4, place.country,
  ].filter(Boolean).join(" ")).split(/[^\p{Letter}\p{Number}]+/u).filter(Boolean));
  const contextWords = normalized(context).split(/[^\p{Letter}\p{Number}]+/u).filter(Boolean);
  return contextWords.length > 0 && contextWords.every((word) => metadataWords.has(word));
}

function uniquePlaces(places: PlaceResult[]): PlaceResult[] {
  const seen = new Set<string>();
  return places.filter((place) => {
    const key = `${place.latitude},${place.longitude}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
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
  if (exact.length || !fullQuery.includes(",")) return { results: exact };

  const parts = fullQuery.split(",").map((part) => part.trim()).filter(Boolean);
  if (parts.length < 2) return { results: exact };

  const lookupCache = new Map<string, Promise<PlaceResult[]>>();
  const contextualMatches: PlaceResult[] = [];
  for (const [candidateIndex, candidateTerm] of parts.entries()) {
    throwIfAborted(signal);
    const key = normalized(candidateTerm);
    let candidateResults = lookupCache.get(key);
    if (!candidateResults) {
      candidateResults = lookup(candidateTerm, signal);
      lookupCache.set(key, candidateResults);
    }
    const results = await candidateResults;
    throwIfAborted(signal);
    const context = parts.filter((_, index) => index !== candidateIndex).join(" ");
    contextualMatches.push(...results.filter((place) => matchesContext(place, context)));
  }

  const matchedPlaces = uniquePlaces(contextualMatches);
  if (matchedPlaces.length) {
    return { results: matchedPlaces, fallbackMessage: "No exact combined match; showing places that match the supplied location context." };
  }

  return {
    results: [],
    fallbackMessage: "No exact combined match found. Try a broader search or choose a point on the map.",
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
