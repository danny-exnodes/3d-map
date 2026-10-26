import type { BBox, CityData, LngLat, Polygon } from './types';

/**
 * Clips line and area features to the bbox so nothing is drawn outside the ground slab.
 * Overpass and Overture both return whole features that merely intersect the area.
 */
export function clipCityToBBox(data: CityData): CityData {
  const b = data.bbox;
  const clipLines = <T extends { id: string; line: LngLat[] }>(list: T[]): T[] =>
    list.flatMap((f) => clipPolyline(f.line, b).map((line, i) => ({ ...f, id: i ? `${f.id}#${i}` : f.id, line })));
  return {
    ...data,
    roads: clipLines(data.roads),
    rails: clipLines(data.rails),
    waterways: clipLines(data.waterways),
    areas: data.areas.flatMap((a) => {
      const polygon = clipPolygon(a.polygon, b);
      return polygon ? [{ ...a, polygon }] : [];
    }),
  };
}

/** Liang–Barsky clipping of each segment; returns the pieces inside the box. */
export function clipPolyline(line: LngLat[], b: BBox): LngLat[][] {
  const out: LngLat[][] = [];
  let cur: LngLat[] = [];
  const flush = () => {
    if (cur.length >= 2) out.push(cur);
    cur = [];
  };
  for (let i = 1; i < line.length; i++) {
    const seg = clipSegment(line[i - 1], line[i], b);
    if (!seg) {
      flush();
      continue;
    }
    const [p, q, enteredInside, leftInside] = seg;
    if (!cur.length || !enteredInside) {
      flush();
      cur = [p];
    }
    cur.push(q);
    if (!leftInside) flush();
  }
  flush();
  return out;
}

function clipSegment(a: LngLat, c: LngLat, b: BBox): [LngLat, LngLat, boolean, boolean] | null {
  const dx = c[0] - a[0], dy = c[1] - a[1];
  let t0 = 0, t1 = 1;
  const edges: [number, number][] = [[-dx, a[0] - b.west], [dx, b.east - a[0]], [-dy, a[1] - b.south], [dy, b.north - a[1]]];
  for (const [p, q] of edges) {
    if (p === 0) {
      if (q < 0) return null;
    } else {
      const r = q / p;
      if (p < 0) {
        if (r > t1) return null;
        if (r > t0) t0 = r;
      } else {
        if (r < t0) return null;
        if (r < t1) t1 = r;
      }
    }
  }
  const P = (t: number): LngLat => [a[0] + dx * t, a[1] + dy * t];
  return [P(t0), P(t1), t0 === 0, t1 === 1];
}

/** Sutherland–Hodgman clip of every ring; returns null when the outer ring vanishes. */
export function clipPolygon(poly: Polygon, b: BBox): Polygon | null {
  const rings = poly.map((r) => clipRing(r, b)).filter((r, i) => i === 0 || r.length >= 3);
  return rings[0]?.length >= 3 ? rings : null;
}

function clipRing(ring: LngLat[], b: BBox): LngLat[] {
  const planes: [(p: LngLat) => boolean, (p: LngLat, q: LngLat) => LngLat][] = [
    [(p) => p[0] >= b.west, (p, q) => at(p, q, (b.west - p[0]) / (q[0] - p[0]))],
    [(p) => p[0] <= b.east, (p, q) => at(p, q, (b.east - p[0]) / (q[0] - p[0]))],
    [(p) => p[1] >= b.south, (p, q) => at(p, q, (b.south - p[1]) / (q[1] - p[1]))],
    [(p) => p[1] <= b.north, (p, q) => at(p, q, (b.north - p[1]) / (q[1] - p[1]))],
  ];
  let pts = ring;
  for (const [inside, cut] of planes) {
    if (!pts.length) break;
    const next: LngLat[] = [];
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i], q = pts[(i + 1) % pts.length];
      const pin = inside(p), qin = inside(q);
      if (pin) next.push(p);
      if (pin !== qin) next.push(cut(p, q));
    }
    pts = next;
  }
  return pts;
}

const at = (p: LngLat, q: LngLat, t: number): LngLat => [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t];
