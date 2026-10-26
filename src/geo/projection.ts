import type { BBox, LngLat } from '../data/types';

const M_PER_DEG_LAT = 110_574;
const M_PER_DEG_LON_EQ = 111_320;

/**
 * Local equirectangular projection centred on the bbox. Good enough for the
 * few-km² areas this app builds. Three.js convention: x = east, z = south, y = up.
 */
export class LocalProjection {
  readonly lon0: number;
  readonly lat0: number;
  private readonly kx: number;

  constructor(bbox: BBox) {
    this.lon0 = (bbox.west + bbox.east) / 2;
    this.lat0 = (bbox.south + bbox.north) / 2;
    this.kx = M_PER_DEG_LON_EQ * Math.cos((this.lat0 * Math.PI) / 180);
  }

  /** Returns [x, z] in meters. */
  project([lon, lat]: LngLat): [number, number] {
    return [(lon - this.lon0) * this.kx, -(lat - this.lat0) * M_PER_DEG_LAT];
  }

  unproject(x: number, z: number): LngLat {
    return [x / this.kx + this.lon0, -z / M_PER_DEG_LAT + this.lat0];
  }
}

export function bboxSizeMeters(b: BBox): { width: number; depth: number } {
  const lat0 = (b.south + b.north) / 2;
  return {
    width: (b.east - b.west) * M_PER_DEG_LON_EQ * Math.cos((lat0 * Math.PI) / 180),
    depth: (b.north - b.south) * M_PER_DEG_LAT,
  };
}

export function bboxAreaKm2(b: BBox): number {
  const { width, depth } = bboxSizeMeters(b);
  return (width * depth) / 1e6;
}

/** Signed area of a ring in projected (x, z) space. */
export function ringArea(ring: [number, number][]): number {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    a += (ring[j][0] - ring[i][0]) * (ring[j][1] + ring[i][1]);
  }
  return a / 2;
}

export function pointInRing(x: number, z: number, ring: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, zi] = ring[i];
    const [xj, zj] = ring[j];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}
