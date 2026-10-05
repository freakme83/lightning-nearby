export type LocationResearchPreset = {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
  coordinateSource: string;
};

/** Representative sample points, not official centroids or boundary definitions. */
export const LOCATION_RESEARCH_PRESETS = {
  "ankara-center": {
    id: "ankara-center", name: "Ankara center", latitude: 39.919874, longitude: 32.854271,
    coordinateSource: "https://www.geonames.org/search.html?q=Ankara",
  },
  ayranci: {
    id: "ayranci", name: "Ayrancı", latitude: 39.902861, longitude: 32.849819,
    coordinateSource: "https://www.wikidata.org/wiki/Q20471152",
  },
  bahcelievler: {
    id: "bahcelievler", name: "Bahçelievler (Çankaya)", latitude: 39.92781, longitude: 32.82649,
    coordinateSource: "https://mapcarta.com/12990336",
  },
  eryaman: {
    id: "eryaman", name: "Eryaman", latitude: 39.9723, longitude: 32.62128,
    coordinateSource: "https://mapcarta.com/25719398",
  },
  polatli: {
    id: "polatli", name: "Polatlı", latitude: 39.577155, longitude: 32.141317,
    coordinateSource: "https://www.geonames.org/search.html?q=Ankara",
  },
  haymana: {
    id: "haymana", name: "Haymana", latitude: 39.43414, longitude: 32.49879,
    coordinateSource: "https://mapcarta.com/12970256",
  },
  sereflikochisar: {
    id: "sereflikochisar", name: "Şereflikoçhisar", latitude: 38.93925, longitude: 33.538599,
    coordinateSource: "https://www.geonames.org/search.html?q=Ankara",
  },
  kirikkale: {
    id: "kirikkale", name: "Kırıkkale center", latitude: 39.845278, longitude: 33.506389,
    coordinateSource: "https://www.geonames.org/search.html?country=TR",
  },
  keskin: {
    id: "keskin", name: "Keskin", latitude: 39.673056, longitude: 33.613611,
    coordinateSource: "https://www.geonames.org/8631946/keskin-i-l-esi.html",
  },
  "rural-ankara": {
    id: "rural-ankara", name: "Aşıkoğlu, Bala (rural sample)", latitude: 39.583333, longitude: 33.15,
    coordinateSource: "https://www.geonames.org/search.html?q=Ankara",
  },
} as const satisfies Record<string, LocationResearchPreset>;

export type LocationResearchPresetId = keyof typeof LOCATION_RESEARCH_PRESETS;

export function getLocationResearchPreset(id: string): LocationResearchPreset {
  const preset = LOCATION_RESEARCH_PRESETS[id as LocationResearchPresetId];
  if (!preset) throw new Error(`Unknown location research preset: ${id}`);
  return preset;
}
