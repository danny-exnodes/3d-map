import type { BoatRoute } from './boats';
import { pointInRing } from './boats';
import type { XZ } from './geometry';

/**
 * Shapes the flood sheet (`floodScenario.ts`) by distance to real rivers/canals/lakes (`boatRoutes`
 * data, already loaded for `Boats`), the way Hydro3DJS (uihilab, MIT) drives its flood overlay from
 * GeoJSON water polygons instead of a uniform sheet. Here it is an added gradient, not a cutoff: the
 * model keeps "ngập khắp nơi" (`FLOOD_NOTE`), only more visibly near real water. Grid, not per-pixel
 * polygon math, so sampling one texture in the shader is cheap; the grid itself is built once per area.
 */

/** Coverage never drops below this (so dry-looking patches do not appear far from any mapped water). */
export const FLOOD_COVERAGE_FLOOR = 0.45;

/** Distances at or beyond this (m) are clamped the same when encoded into the mask texture. */
export const FLOOD_MASK_MAX_DIST = 600;

/** How far inland the full-strength look reaches from a water edge, m: grows with depth (illustrative). */
export function floodSpreadMetres(depthM: number): number {
  return 20 + Math.max(0, depthM) * 400;
}

/** 1 at the water's edge fading to `FLOOD_COVERAGE_FLOOR` by `floodSpreadMetres(depth)` metres inland. */
export function floodCoverage(distanceM: number, depthM: number): number {
  const spread = floodSpreadMetres(depthM);
  const t = Math.min(1, Math.max(0, distanceM / spread));
  const smooth = 1 - t * t * (3 - 2 * t);
  return FLOOD_COVERAGE_FLOOR + (1 - FLOOD_COVERAGE_FLOOR) * smooth;
}

function distToSegment(p: XZ, a: XZ, b: XZ): number {
  const abx = b[0] - a[0], abz = b[1] - a[1];
  const len2 = abx * abx + abz * abz;
  let t = len2 > 0 ? ((p[0] - a[0]) * abx + (p[1] - a[1]) * abz) / len2 : 0;
  t = Math.min(1, Math.max(0, t));
  const dx = p[0] - (a[0] + t * abx), dz = p[1] - (a[1] + t * abz);
  return Math.hypot(dx, dz);
}

function distToRingEdge(p: XZ, ring: XZ[]): number {
  let best = Infinity;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) best = Math.min(best, distToSegment(p, ring[j], ring[i]));
  return best;
}

/** 0 inside the water, else distance to its nearest edge/centreline (m). */
export function distanceToWater(p: XZ, route: BoatRoute): number {
  if (route.kind === 'line') {
    let best = Infinity;
    for (let i = 1; i < route.pts.length; i++) best = Math.min(best, distToSegment(p, route.pts[i - 1], route.pts[i]));
    return Math.max(0, best - route.width / 2);
  }
  const inside = pointInRing(p, route.ring) && !(route.holes ?? []).some((h) => pointInRing(p, h));
  return inside ? 0 : distToRingEdge(p, route.ring);
}

/**
 * Nearest-water distance on a `resolution` x `resolution` grid over [-hx,hx] x [-hz,hz] (row-major,
 * z outer then x), each cell `min(distance, FLOOD_MASK_MAX_DIST)` scaled to a 0..255 byte.
 */
export function floodMaskGrid(features: readonly BoatRoute[], hx: number, hz: number, resolution = 48): Uint8Array {
  const out = new Uint8Array(resolution * resolution);
  for (let j = 0; j < resolution; j++) {
    const z = -hz + ((j + 0.5) / resolution) * (2 * hz);
    for (let i = 0; i < resolution; i++) {
      const x = -hx + ((i + 0.5) / resolution) * (2 * hx);
      let best = Infinity;
      for (const f of features) {
        best = Math.min(best, distanceToWater([x, z], f));
        if (best === 0) break;
      }
      out[j * resolution + i] = Math.round((Math.min(best, FLOOD_MASK_MAX_DIST) / FLOOD_MASK_MAX_DIST) * 255);
    }
  }
  return out;
}
