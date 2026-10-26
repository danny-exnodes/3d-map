import { pointInRing } from '../geo/projection';
import type { XZ } from './geometry';

/** Uniform grid over item bounding boxes for fast "is this point occupied" tests. */
export class SpatialGrid<T> {
  private cells = new Map<string, { bbox: [number, number, number, number]; ring: XZ[]; item: T }[]>();

  constructor(private readonly size: number) {}

  insert(ring: XZ[], item: T) {
    let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
    for (const [x, z] of ring) {
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
    }
    const entry = { bbox: [minX, minZ, maxX, maxZ] as [number, number, number, number], ring, item };
    for (let cx = Math.floor(minX / this.size); cx <= Math.floor(maxX / this.size); cx++) {
      for (let cz = Math.floor(minZ / this.size); cz <= Math.floor(maxZ / this.size); cz++) {
        const k = `${cx},${cz}`;
        let list = this.cells.get(k);
        if (!list) this.cells.set(k, (list = []));
        list.push(entry);
      }
    }
  }

  /** True if (x,z) lies inside any ring, optionally expanded by `margin` (bbox test only for the margin). */
  contains(x: number, z: number, margin = 0): boolean {
    const list = this.cells.get(`${Math.floor(x / this.size)},${Math.floor(z / this.size)}`);
    if (!list) return false;
    for (const e of list) {
      const [a, b, c, d] = e.bbox;
      if (x < a - margin || x > c + margin || z < b - margin || z > d + margin) continue;
      if (margin > 0 || pointInRing(x, z, e.ring)) return true;
    }
    return false;
  }
}
