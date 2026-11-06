// Reproducible, offline extraction of Ankara's 25 district polygons from a pinned
// geoBoundaries release file. It never downloads anything and never edits geometry.
//   node --experimental-strip-types scripts/activity-export/extract-districts.ts <geoBoundaries-TUR-ADM2.geojson> <output>
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

export const DISTRICT_SOURCE = {
  name: "geoBoundaries gbOpen TUR ADM2 (Districts)",
  boundaryId: "TUR-ADM2-54988432",
  boundaryYear: "2021",
  upstreamSource: "OpenStreetMap, OSM Boundaries (osm-boundaries.com)",
  sourceDataUpdateDate: "2023-01-19",
  buildDate: "2023-12-12",
  repository: "https://github.com/wmgeolab/geoBoundaries",
  commit: "8ce2700661a28ee944350e2b329bbabb58d2ff83",
  path: "releaseData/gbOpen/TUR/ADM2/geoBoundaries-TUR-ADM2.geojson",
  sha256: "8e7594ab12d916e3b93f920475a300c364dfb94a0e40bfa6d55f43aff0c7fd97",
  license: "Open Data Commons Open Database License 1.0 (ODbL-1.0)",
  licenseUrl: "https://opendatacommons.org/licenses/odbl/1-0/",
  attribution: "© OpenStreetMap contributors (openstreetmap.org/copyright); district boundaries via geoBoundaries (Runfola et al. 2020, doi:10.1371/journal.pone.0231866)",
} as const;

/** Pinned geoBoundaries shapeIDs. Names alone are ambiguous nationally (e.g. two Gölbaşı districts). */
export const ANKARA_DISTRICT_SHAPES: Readonly<Record<string, string>> = {
  "54988432B10964336547790": "Akyurt", "54988432B73322112171643": "Altındağ",
  "54988432B82014905265154": "Ayaş", "54988432B88316498186109": "Bala",
  "54988432B87892506897385": "Beypazarı", "54988432B25326258827765": "Çamlıdere",
  "54988432B72030220276956": "Çankaya", "54988432B84973807429467": "Çubuk",
  "54988432B18647546937138": "Elmadağ", "54988432B29207959806558": "Etimesgut",
  "54988432B65496848768167": "Evren", "54988432B35345810127315": "Gölbaşı",
  "54988432B82471311142852": "Güdül", "54988432B89555629027377": "Haymana",
  "54988432B59635057977952": "Kahramankazan", "54988432B64260003407372": "Kalecik",
  "54988432B21059504662364": "Keçiören", "54988432B2925959455693": "Kızılcahamam",
  "54988432B23708733321039": "Mamak", "54988432B12089273300588": "Nallıhan",
  "54988432B893295612098": "Polatlı", "54988432B870340746196": "Pursaklar",
  "54988432B81083365712780": "Sincan", "54988432B97717565208806": "Şereflikoçhisar",
  "54988432B58223508141681": "Yenimahalle",
};

type SourceFeature = { type: string; properties: Record<string, unknown>; geometry: { type: string; coordinates: unknown } };

export function extractAnkaraDistricts(sourceText: string): string {
  const digest = createHash("sha256").update(sourceText).digest("hex");
  if (digest !== DISTRICT_SOURCE.sha256) throw new Error(`Source SHA-256 mismatch: ${digest}`);
  const source = JSON.parse(sourceText) as { features: SourceFeature[] };
  const features = source.features.filter(feature => typeof feature.properties.shapeID === "string" &&
    Object.hasOwn(ANKARA_DISTRICT_SHAPES, feature.properties.shapeID as string));
  if (features.length !== Object.keys(ANKARA_DISTRICT_SHAPES).length) throw new Error("Pinned district shape missing");
  for (const feature of features) {
    if (feature.properties.shapeName !== ANKARA_DISTRICT_SHAPES[feature.properties.shapeID as string]) {
      throw new Error(`Unexpected district name for ${String(feature.properties.shapeID)}`);
    }
  }
  features.sort((a, b) => String(a.properties.shapeName).localeCompare(String(b.properties.shapeName), "tr-TR"));
  const output = {
    type: "FeatureCollection",
    // Foreign member (RFC 7946 §6.1): provenance and licence travel with the data.
    provenance: { ...DISTRICT_SOURCE, province: "Ankara (TR-06)", districtCount: features.length,
      extraction: "Features selected by pinned shapeID; geometry copied unchanged (no simplification, rounding or repair)." },
    features: features.map(feature => ({ type: "Feature",
      properties: { district: feature.properties.shapeName, shapeID: feature.properties.shapeID },
      geometry: feature.geometry })),
  };
  return `${JSON.stringify(output)}\n`;
}

if (process.argv[1]?.endsWith("/scripts/activity-export/extract-districts.ts")) {
  const [input, output] = process.argv.slice(2);
  if (!input || !output) throw new Error("Usage: extract-districts.ts <source.geojson> <output.geojson>");
  await writeFile(output, extractAnkaraDistricts(await readFile(input, "utf8")));
}
