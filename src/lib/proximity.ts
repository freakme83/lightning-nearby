import type { CompassDirection } from "./lightning/bearing.ts";

const VECTOR: Record<CompassDirection, readonly [number, number]> = {
  N: [0, -1], NE: [Math.SQRT1_2, -Math.SQRT1_2], E: [1, 0], SE: [Math.SQRT1_2, Math.SQRT1_2],
  S: [0, 1], SW: [-Math.SQRT1_2, Math.SQRT1_2], W: [-1, 0], NW: [-Math.SQRT1_2, -Math.SQRT1_2],
};

export type ProximityScale = { outerKm: 10 | 15 | 25 | 40; ringsKm: readonly [number, number, number] };
export type ProximityColor = "red" | "amber" | "green";
export const DEFAULT_PROXIMITY_SCALE: ProximityScale = { outerKm: 40, ringsKm: [10, 25, 40] };
const CENTER = 50;
const OUTER_RING_RADIUS = 42;

export function proximityScale(distanceKm: number): ProximityScale {
  if (distanceKm <= 5) return { outerKm: 10, ringsKm: [2.5, 5, 10] };
  if (distanceKm <= 10) return { outerKm: 15, ringsKm: [5, 10, 15] };
  if (distanceKm <= 25) return { outerKm: 25, ringsKm: [10, 15, 25] };
  return DEFAULT_PROXIMITY_SCALE;
}

export function proximityColor(distanceKm: number): ProximityColor {
  if (distanceKm <= 10) return "red";
  if (distanceKm <= 25) return "amber";
  return "green";
}

/** Map a sanitized distance and eight-point direction onto the 100×100 schematic. */
export function proximityPoint(distanceKm: number, direction: CompassDirection, scaleKm = 40): { x: number; y: number } | null {
  if (!Number.isFinite(distanceKm) || distanceKm < 0 || !Number.isFinite(scaleKm) || scaleKm <= 0) return null;
  const radius = Math.min(distanceKm, scaleKm) / scaleKm * OUTER_RING_RADIUS;
  const [dx, dy] = VECTOR[direction];
  return { x: CENTER + dx * radius, y: CENTER + dy * radius };
}
