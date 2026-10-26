import { LocalProjection, pointInRing } from '../geo/projection';
import { buildingFromOverture, restyle } from './buildings';
import type { HeightGrid } from './heights';
import type { OvertureBuilding } from './overture';
import type { Building, CityData, CityStats, FootprintSource, HeightSource, LngLat } from './types';

type XZ = [number, number];

/** Uniform grid of footprints in local metres, for overlap tests between datasets. */
class FootprintIndex {
  private cells = new Map<string, { ring: XZ[]; bbox: [number, number, number, number] }[]>();
  constructor(private size = 30) {}

  add(ring: XZ[]) {
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
    for (const [x, z] of ring) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); }
    const e = { ring, bbox: [x0, z0, x1, z1] as [number, number, number, number] };
    for (let i = Math.floor(x0 / this.size); i <= Math.floor(x1 / this.size); i++)
      for (let j = Math.floor(z0 / this.size); j <= Math.floor(z1 / this.size); j++) {
        const k = `${i},${j}`;
        let l = this.cells.get(k);
        if (!l) this.cells.set(k, (l = []));
        l.push(e);
      }
  }

  /** True when the ring overlaps an indexed footprint (any vertex/centroid of one inside the other). */
  overlaps(ring: XZ[]): boolean {
    const c = centroidXZ(ring);
    const near = this.cells.get(`${Math.floor(c[0] / this.size)},${Math.floor(c[1] / this.size)}`) ?? [];
    for (const e of near) {
      const [x0, z0, x1, z1] = e.bbox;
      if (c[0] < x0 - 20 || c[0] > x1 + 20 || c[1] < z0 - 20 || c[1] > z1 + 20) continue;
      if (pointInRing(c[0], c[1], e.ring)) return true;
      const ec = centroidXZ(e.ring);
      if (pointInRing(ec[0], ec[1], ring)) return true;
      // Count vertices of the candidate inside the existing footprint (partial overlaps).
      let inside = 0;
      for (const [x, z] of ring) if (pointInRing(x, z, e.ring)) inside++;
      if (inside >= Math.max(2, ring.length / 2)) return true;
    }
    return false;
  }
}

function centroidXZ(r: XZ[]): XZ {
  let x = 0, z = 0;
  for (const p of r) { x += p[0]; z += p[1]; }
  return [x / r.length, z / r.length];
}

/**
 * Adds Overture footprints that OSM does not have. OSM wins on overlap (it carries tags).
 * Overture's own OSM-derived features are kept too when they don't overlap: they cover
 * buildings missing from our Overpass response (different snapshot, failed request).
 */
export function mergeOverture(data: CityData, overture: { buildings: OvertureBuilding[]; parts: OvertureBuilding[] }): number {
  const proj = new LocalProjection(data.bbox);
  const toXZ = (r: LngLat[]) => r.map((p) => proj.project(p));
  const index = new FootprintIndex();
  for (const b of data.buildings) index.add(toXZ(b.polygon[0]));
  let added = 0;
  // Building parts replace their outline (Simple 3D Buildings), so outlines with parts are skipped.
  const withParts = new Set(overture.parts.map((p) => p.buildingId).filter(Boolean));
  for (const o of overture.buildings) {
    if (withParts.has(o.id)) continue;
    const ring = toXZ(o.polygon[0]);
    if (index.overlaps(ring)) continue;
    index.add(ring);
    data.buildings.push(buildingFromOverture(o));
    added++;
  }
  // Parts are added only where nothing else (e.g. an Overpass building) already stands.
  const partRings = overture.parts.map((p) => ({ p, ring: toXZ(p.polygon[0]) }));
  const free = partRings.filter(({ p, ring }) => p.buildingId && withParts.has(p.buildingId) && !index.overlaps(ring));
  for (const { p } of free) {
    data.buildings.push(buildingFromOverture(p, true));
    added++;
  }
  return added;
}

/** Fills heights from the Google 2.5D grid for buildings whose height is not from OSM tags. */
export function applyHeightGrid(buildings: Building[], grid: HeightGrid): number {
  let n = 0;
  for (const b of buildings) {
    if (b.heightSource === 'osm' || b.isPart) continue;
    const h = grid.sampleFootprint(b.polygon[0]);
    if (h == null || h < 2) continue;
    b.height = Math.max(h, b.minHeight + 2);
    b.heightSource = 'gob';
    restyle(b);
    n++;
  }
  return n;
}

export function computeStats(data: CityData, extraAttributions: string[] = []): CityStats {
  const footprints: Record<FootprintSource, number> = { osm: 0, overture: 0, demo: 0 };
  const heights: Record<HeightSource, number> = { osm: 0, gob: 0, overture: 0, heuristic: 0 };
  for (const b of data.buildings) {
    footprints[b.footprintSource]++;
    heights[b.heightSource]++;
  }
  const attributions = ['© OpenStreetMap contributors (ODbL)'];
  if (footprints.overture || data.source.includes('Overture')) attributions.push('Overture Maps Foundation (ODbL)');
  if (heights.gob) attributions.push('Google Open Buildings 2.5D Temporal (CC BY 4.0)');
  return { footprints, heights, attributions: [...attributions, ...extraAttributions] };
}
