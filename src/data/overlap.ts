import { LocalProjection } from '../geo/projection';
import type { Building, CityData } from './types';

type XZ = [number, number];

/**
 * Removes footprints that overlap better ones (v0.0.5). OSM, Overture, tube-house lots and the
 * buildings inferred from the height raster each come with their own outline, and the inferred
 * ones are rotated rectangles that can spill over a neighbour, so two houses ended up drawn
 * inside each other.
 *
 * Footprints are rasterised in priority order (OSM, then Overture, then inferred; larger
 * first). A footprint whose area is already taken by more than `maxShare` is shrunk towards its
 * centre, and dropped when even the shrunk outline still overlaps. Building parts may stack on
 * their own outline, so they only mark the mask.
 */
export function removeOverlaps(data: CityData, maxShare = 0.03): { dropped: number; shrunk: number } {
  const proj = new LocalProjection(data.bbox);
  const rings = data.buildings.map((b) => b.polygon[0].map((p) => proj.project(p)) as XZ[]);
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (const r of rings) for (const [x, z] of r) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); }
  if (!isFinite(x0)) return { dropped: 0, shrunk: 0 };
  // ≤ ~8 M cells whatever the area size.
  const cell = Math.max(0.5, Math.sqrt(((x1 - x0) * (z1 - z0)) / 8e6));
  const w = Math.ceil((x1 - x0) / cell) + 1, d = Math.ceil((z1 - z0) / cell) + 1;
  const mask = new Uint8Array(w * d);

  /** Visits the cells whose centre lies inside the ring; stops early when `f` returns false. */
  const scan = (ring: XZ[], f: (k: number) => boolean | void) => {
    let r0 = Infinity, r1 = -Infinity;
    for (const [, z] of ring) { r0 = Math.min(r0, z); r1 = Math.max(r1, z); }
    for (let j = Math.max(0, Math.floor((r0 - z0) / cell)); j <= Math.min(d - 1, Math.ceil((r1 - z0) / cell)); j++) {
      const zc = z0 + (j + 0.5) * cell;
      const xs: number[] = [];
      for (let a = 0, b = ring.length - 1; a < ring.length; b = a++) {
        const [xa, za] = ring[a], [xb, zb] = ring[b];
        if ((za > zc) !== (zb > zc)) xs.push(xa + ((zc - za) / (zb - za)) * (xb - xa));
      }
      xs.sort((p, q) => p - q);
      for (let k = 0; k + 1 < xs.length; k += 2)
        for (let i = Math.max(0, Math.ceil((xs[k] - x0) / cell - 0.5)); i <= Math.min(w - 1, Math.floor((xs[k + 1] - x0) / cell - 0.5)); i++)
          if (f(j * w + i) === false) return;
    }
  };
  const share = (ring: XZ[]) => {
    let n = 0, hit = 0;
    scan(ring, (k) => {
      n++;
      if (mask[k]) hit++;
    });
    return n ? hit / n : 0;
  };
  const mark = (ring: XZ[]) => scan(ring, (k) => void (mask[k] = 1));
  const shrink = (ring: XZ[], s: number): XZ[] => {
    let cx = 0, cz = 0;
    for (const [x, z] of ring) { cx += x; cz += z; }
    cx /= ring.length; cz /= ring.length;
    return ring.map(([x, z]) => [cx + (x - cx) * s, cz + (z - cz) * s]);
  };

  const rank = (b: Building) => (b.footprintSource === 'osm' ? 0 : b.footprintSource === 'gob' ? 2 : 1) + (b.lot && b.footprintSource !== 'gob' ? 0.5 : 0);
  const area = (r: XZ[]) => Math.abs(r.reduce((a, p, i) => a + p[0] * r[(i + 1) % r.length][1] - r[(i + 1) % r.length][0] * p[1], 0) / 2);
  const order = data.buildings.map((_, i) => i).sort((a, b) => rank(data.buildings[a]) - rank(data.buildings[b]) || area(rings[b]) - area(rings[a]));

  const keep = new Uint8Array(data.buildings.length);
  let dropped = 0, shrunk = 0;
  for (const i of order) {
    const b = data.buildings[i];
    let ring = rings[i];
    if (b.isPart) {
      keep[i] = 1;
      mark(ring);
      continue;
    }
    if (share(ring) > maxShare) {
      let ok = false;
      // Only the drawn-by-us shapes (inferred, lots) are worth shrinking; mapped outlines are dropped.
      if (b.footprintSource === 'gob' || b.lot)
        for (const s of [0.9, 0.8, 0.7, 0.6]) {
          const r = shrink(ring, s);
          if (share(r) <= maxShare) {
            ring = r;
            b.polygon = [r.map(([x, z]) => proj.unproject(x, z))];
            ok = true;
            shrunk++;
            break;
          }
        }
      if (!ok) {
        dropped++;
        continue;
      }
    }
    keep[i] = 1;
    mark(ring);
  }
  data.buildings = data.buildings.filter((_, i) => keep[i]);
  return { dropped, shrunk };
}
