import type { CompassDirection } from "./lightning/bearing.ts";

const VECTOR: Record<CompassDirection, readonly [number, number]> = {
  N: [0, -1],
  NE: [Math.SQRT1_2, -Math.SQRT1_2],
  E: [1, 0],
  SE: [Math.SQRT1_2, Math.SQRT1_2],
  S: [0, 1],
  SW: [-Math.SQRT1_2, Math.SQRT1_2],
  W: [-1, 0],
  NW: [-Math.SQRT1_2, -Math.SQRT1_2],
};

const CENTER = 50;
const OUTER_RING_RADIUS = 42;
const MAX_DISTANCE_KM = 40;

/** Map a sanitized distance and eight-point direction onto the schematic's 100×100 view box. */
export function proximityPoint(distanceKm: number, direction: CompassDirection): { x: number; y: number } | null {
  if (!Number.isFinite(distanceKm) || distanceKm < 0) return null;
  const radius = Math.min(distanceKm, MAX_DISTANCE_KM) / MAX_DISTANCE_KM * OUTER_RING_RADIUS;
  const [dx, dy] = VECTOR[direction];
  return { x: CENTER + dx * radius, y: CENTER + dy * radius };
}
