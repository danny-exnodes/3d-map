import type { LngLat } from './types';

const key = (p: LngLat) => `${p[0].toFixed(7)},${p[1].toFixed(7)}`;

/**
 * Join open way segments (as found in multipolygon relations) into closed rings.
 * Segments that cannot be closed are dropped.
 */
export function joinRings(segments: LngLat[][]): LngLat[][] {
  const pool = segments.filter((s) => s.length >= 2).map((s) => s.slice());
  const rings: LngLat[][] = [];

  while (pool.length) {
    let ring = pool.shift()!;
    let guard = 0;
    while (key(ring[0]) !== key(ring[ring.length - 1]) && guard++ < 10_000) {
      const tail = key(ring[ring.length - 1]);
      const idx = pool.findIndex((s) => key(s[0]) === tail || key(s[s.length - 1]) === tail);
      if (idx < 0) break;
      const seg = pool.splice(idx, 1)[0];
      if (key(seg[0]) !== tail) seg.reverse();
      ring = ring.concat(seg.slice(1));
    }
    if (key(ring[0]) === key(ring[ring.length - 1]) && ring.length >= 4) {
      rings.push(openRing(ring));
    }
  }
  return rings;
}

/** Drop the duplicated closing vertex if present. */
export function openRing(ring: LngLat[]): LngLat[] {
  if (ring.length > 1 && key(ring[0]) === key(ring[ring.length - 1])) return ring.slice(0, -1);
  return ring;
}
