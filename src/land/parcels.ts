import type { LngLat } from '../data/types';
import { LocalProjection } from '../geo/projection';
import type { Parcel, ParcelEdge, ParcelMetrics, ParcelShape, ParcelSource, Street } from './types';

/** A street farther than this from every edge midpoint does not give the parcel a frontage (#37). */
export const FRONTAGE_MAX_DIST = 40;
/** Back width vs. frontage beyond ±10% reads as nở hậu / tóp hậu, the way brokers describe a lot. */
const SHAPE_TOLERANCE = 0.1;
/** Below this area / minimum-bounding-rectangle ratio a non-quadrilateral lot is "méo". */
const RECTANGULARITY_MIN = 0.85;

type XY = [number, number];

/**
 * Drops the closing vertex, repeated vertices and (near-)collinear middle vertices (#37).
 * Sổ đỏ tables often repeat the first corner at the end, and OSM outlines carry extra vertices on
 * straight sides; both would add zero-length or split edges to the edge list.
 * `tolerance` is the max offset in metres of a vertex from the line of its neighbours.
 */
export function simplifyRing(ring: LngLat[], tolerance = 0.01): LngLat[] {
  if (ring.length < 3) return ring.slice();
  const proj = projectionFor(ring);
  let pts = ring.map((p) => ({ p, xy: proj.project(p) }));
  const same = (a: XY, b: XY) => Math.hypot(a[0] - b[0], a[1] - b[1]) <= 1e-4;
  pts = pts.filter((q, i) => i === 0 || !same(q.xy, pts[i - 1].xy));
  while (pts.length > 1 && same(pts[0].xy, pts[pts.length - 1].xy)) pts.pop();
  // Remove collinear points until stable; each pass may expose a new collinear triple.
  let changed = true;
  while (changed && pts.length > 3) {
    changed = false;
    for (let i = 0; i < pts.length && pts.length > 3; i++) {
      const prev = pts[(i - 1 + pts.length) % pts.length].xy;
      const next = pts[(i + 1) % pts.length].xy;
      if (lineDistance(pts[i].xy, prev, next) <= tolerance) {
        pts.splice(i, 1);
        changed = true;
        i--;
      }
    }
  }
  return pts.map((q) => q.p);
}

/**
 * Area, perimeter, edge lengths, frontage, depth and shape of a parcel outline (#37).
 * Works in a local metric projection centred on the parcel, which is accurate to well under
 * 0.1% at lot scale. Frontage is the edge whose midpoint is nearest to a street centreline.
 */
export function parcelMetrics(ring: LngLat[], streets: Street[]): ParcelMetrics {
  const pts = simplifyRing(ring);
  const proj = projectionFor(pts.length ? pts : ring);
  const xy = pts.map((p) => proj.project(p));
  const m = xy.length;

  const area = Math.abs(shoelace(xy));
  const lengths = xy.map((p, i) => dist(p, xy[(i + 1) % m]));
  const perimeter = lengths.reduce((s, l) => s + l, 0);

  // Frontage: nearest street to each edge midpoint.
  const segs: { a: XY; b: XY; name?: string }[] = [];
  for (const s of streets)
    for (let i = 1; i < s.line.length; i++) segs.push({ a: proj.project(s.line[i - 1]), b: proj.project(s.line[i]), name: s.name });
  let front = -1;
  let frontDist = Infinity;
  let frontName: string | undefined;
  for (let i = 0; i < m && segs.length; i++) {
    const mid: XY = midpoint(xy[i], xy[(i + 1) % m]);
    for (const s of segs) {
      const d = segmentDistance(mid, s.a, s.b);
      if (d < frontDist) {
        frontDist = d;
        front = i;
        frontName = s.name;
      }
    }
  }
  if (frontDist > FRONTAGE_MAX_DIST) front = -1;

  // Reference edge for depth and shape: the frontage, or the longest edge when no street is near.
  let ref = front;
  if (ref < 0) ref = lengths.indexOf(Math.max(...lengths));
  const p0 = xy[ref], p1 = xy[(ref + 1) % m];
  const len = dist(p0, p1) || 1;
  const u: XY = [(p1[0] - p0[0]) / len, (p1[1] - p0[1]) / len];
  const across = xy.map((p) => Math.abs((p[0] - p0[0]) * u[1] - (p[1] - p0[1]) * u[0]));
  const along = xy.map((p) => (p[0] - p0[0]) * u[0] + (p[1] - p0[1]) * u[1]);
  const depth = Math.max(0, ...across);

  // Back width: extent along the front direction of the vertices in the far half of the lot.
  const far = along.filter((_, i) => across[i] > depth / 2);
  const back = far.length ? Math.max(...far) - Math.min(...far) : 0;
  let shape: ParcelShape = 'vuong';
  if (back >= len * (1 + SHAPE_TOLERANCE)) shape = 'no-hau';
  else if (back <= len * (1 - SHAPE_TOLERANCE)) shape = 'top-hau';
  else if (m !== 4 && area / minRectArea(xy) < RECTANGULARITY_MIN) shape = 'meo';

  const edges: ParcelEdge[] = pts.map((a, i) => ({ a, b: pts[(i + 1) % m], length: lengths[i], front: i === front }));
  return {
    area,
    perimeter,
    edges,
    frontage: front >= 0 ? lengths[front] : null,
    depth,
    shape,
    streetDistance: front >= 0 ? frontDist : null,
    ...(front >= 0 && frontName ? { streetName: frontName } : {}),
  };
}

export interface ParcelInput {
  id: string;
  source: ParcelSource;
  ring: LngLat[];
  landCode: string;
  landCodeGuessed?: boolean;
  osmClass?: string;
  soTo?: string;
  soThua?: string;
  name?: string;
}

/** Builds a Parcel with its metrics; the stored ring is the simplified one so edges match it. */
export function makeParcel(input: ParcelInput, streets: Street[] = []): Parcel {
  const ring = simplifyRing(input.ring);
  const p: Parcel = {
    id: input.id,
    source: input.source,
    ring,
    landCode: input.landCode,
    landCodeGuessed: input.landCodeGuessed ?? false,
    metrics: parcelMetrics(ring, streets),
  };
  if (input.osmClass) p.osmClass = input.osmClass;
  if (input.soTo) p.soTo = input.soTo;
  if (input.soThua) p.soThua = input.soThua;
  if (input.name) p.name = input.name;
  return p;
}

/** Planar area in m² of a lon/lat ring (absolute), for filtering and sorting. */
export function ringAreaM2(ring: LngLat[]): number {
  if (ring.length < 3) return 0;
  const proj = projectionFor(ring);
  return Math.abs(shoelace(ring.map((p) => proj.project(p))));
}

// ---- geometry helpers ----

function projectionFor(ring: LngLat[]): LocalProjection {
  let west = Infinity, east = -Infinity, south = Infinity, north = -Infinity;
  for (const [lon, lat] of ring) {
    west = Math.min(west, lon);
    east = Math.max(east, lon);
    south = Math.min(south, lat);
    north = Math.max(north, lat);
  }
  return new LocalProjection({ west, east, south, north });
}

function shoelace(xy: XY[]): number {
  let s = 0;
  for (let i = 0, j = xy.length - 1; i < xy.length; j = i++) s += xy[j][0] * xy[i][1] - xy[i][0] * xy[j][1];
  return s / 2;
}

const dist = (a: XY, b: XY) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const midpoint = (a: XY, b: XY): XY => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];

/** Distance from p to the infinite line through a and b. */
function lineDistance(p: XY, a: XY, b: XY): number {
  const l = dist(a, b);
  if (l === 0) return dist(p, a);
  return Math.abs((b[0] - a[0]) * (a[1] - p[1]) - (a[0] - p[0]) * (b[1] - a[1])) / l;
}

function segmentDistance(p: XY, a: XY, b: XY): number {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2)) : 0;
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}

/** Minimum-area bounding rectangle by rotating calipers over the convex hull's edge directions. */
function minRectArea(xy: XY[]): number {
  const hull = convexHull(xy);
  let best = Infinity;
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i], b = hull[(i + 1) % hull.length];
    const l = dist(a, b);
    if (!l) continue;
    const ux = (b[0] - a[0]) / l, uy = (b[1] - a[1]) / l;
    let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
    for (const p of hull) {
      const pu = p[0] * ux + p[1] * uy, pv = -p[0] * uy + p[1] * ux;
      minU = Math.min(minU, pu);
      maxU = Math.max(maxU, pu);
      minV = Math.min(minV, pv);
      maxV = Math.max(maxV, pv);
    }
    best = Math.min(best, (maxU - minU) * (maxV - minV));
  }
  return best === Infinity || best === 0 ? 1 : best;
}

function convexHull(xy: XY[]): XY[] {
  const pts = xy.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (pts.length < 3) return pts;
  const cross = (o: XY, a: XY, b: XY) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: XY[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: XY[] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}
