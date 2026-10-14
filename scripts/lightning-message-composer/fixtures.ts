import type { ComposerInput } from "./types.ts";

const eventTimeMs = Date.parse("2026-10-06T13:48:00Z");

// Synthetic inputs for deterministic preview; these are not live provider observations.
export const COMPOSER_FIXTURES = {
  cg_verified_urban: {
    incident: { id: "fixture-urban-1", lastActivityTimeMs: eventTimeMs, latitude: 39.9012, longitude: 32.8421 },
    locationDisplayLabel: "Aşağı Ayrancı, Çankaya",
    enrichment: { status: "cg_verified", match: { type: "cg", latitude: 39.902742, longitude: 32.851494 } },
  },
  ic_only_urban: {
    incident: { id: "fixture-urban-2", lastActivityTimeMs: eventTimeMs, latitude: 39.917, longitude: 32.824 },
    locationDisplayLabel: "Bahçelievler, Çankaya",
    enrichment: { status: "ic_only", match: { type: "ic", latitude: 39.917, longitude: 32.824 } },
  },
  no_match_urban: {
    incident: { id: "fixture-urban-3", lastActivityTimeMs: eventTimeMs, latitude: 39.91, longitude: 32.82 },
    locationDisplayLabel: "Yukarı Bahçelievler, Çankaya",
    enrichment: { status: "no_match" },
  },
  provider_unavailable_urban: {
    incident: { id: "fixture-urban-4", lastActivityTimeMs: eventTimeMs, latitude: 39.92, longitude: 32.83 },
    locationDisplayLabel: "Eski Bahçelievler, Çankaya",
    enrichment: { status: "provider_unavailable" },
  },
  cg_verified_rural: {
    incident: { id: "fixture-rural-1", lastActivityTimeMs: eventTimeMs, latitude: 39.682, longitude: 32.859 },
    locationDisplayLabel: "Beynam, Balâ",
    enrichment: { status: "cg_verified", match: { type: "cg", latitude: 39.682564, longitude: 32.859372 } },
  },
  outside_ankara_generic: {
    incident: { id: "fixture-outside-1", lastActivityTimeMs: eventTimeMs, latitude: 39.70, longitude: 33.90 },
    locationDisplayLabel: "Keskin, Kırıkkale",
    enrichment: { status: "no_match" },
  },
} as const satisfies Record<string, ComposerInput>;

export type ComposerFixtureName = keyof typeof COMPOSER_FIXTURES;

export function getComposerFixture(name: string): ComposerInput | null {
  return Object.hasOwn(COMPOSER_FIXTURES, name) ? COMPOSER_FIXTURES[name as ComposerFixtureName] : null;
}
