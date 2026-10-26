import * as THREE from 'three';
import type { RoofShape } from '../data/types';
import type { MeshBuilder, XZ } from './geometry';

/** Minimum-area enclosing rectangle (rotating calipers over the convex hull). */
export function minAreaRect(points: XZ[]): { corners: XZ[]; long: number; short: number; area: number; centre: XZ; axis: XZ } {
  const hull = convexHull(points);
  let best = { area: Infinity, corners: [] as XZ[], long: 0, short: 0, axis: [1, 0] as XZ };
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i];
    const b = hull[(i + 1) % hull.length];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len < 1e-6) continue;
    const ux = (b[0] - a[0]) / len, uz = (b[1] - a[1]) / len;
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    for (const [x, z] of hull) {
      const u = x * ux + z * uz, v = -x * uz + z * ux;
      u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v);
    }
    const area = (u1 - u0) * (v1 - v0);
    if (area < best.area) {
      const P = (u: number, v: number): XZ => [u * ux - v * uz, u * uz + v * ux];
      const du = u1 - u0, dv = v1 - v0;
      best = {
        area,
        corners: [P(u0, v0), P(u1, v0), P(u1, v1), P(u0, v1)],
        long: Math.max(du, dv),
        short: Math.min(du, dv),
        axis: du >= dv ? [ux, uz] : [-uz, ux],
      };
    }
  }
  const c = best.corners;
  const centre: XZ = c.length ? [(c[0][0] + c[2][0]) / 2, (c[0][1] + c[2][1]) / 2] : [0, 0];
  return { ...best, centre };
}

export function convexHull(points: XZ[]): XZ[] {
  const p = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const cross = (o: XZ, a: XZ, b: XZ) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: XZ[] = [];
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop();
    lower.push(q);
  }
  const upper: XZ[] = [];
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop();
    upper.push(q);
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

export function polygonArea(r: XZ[]): number {
  let a = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += r[j][0] * r[i][1] - r[i][0] * r[j][1];
  return Math.abs(a / 2);
}

/** Rectangle corners grown (or shrunk) by `d` metres on every side. */
function grow(corners: XZ[], centre: XZ, axis: XZ, d: number): XZ[] {
  const [ux, uz] = axis;
  return corners.map(([x, z]) => {
    const dx = x - centre[0], dz = z - centre[1];
    const u = dx * ux + dz * uz, v = -dx * uz + dz * ux;
    const u2 = u + Math.sign(u) * d, v2 = v + Math.sign(v) * d;
    return [centre[0] + u2 * ux - v2 * uz, centre[1] + u2 * uz + v2 * ux];
  });
}

const V = (p: XZ, y: number) => new THREE.Vector3(p[0], y, p[1]);

/** Flat cap over rings (outer + holes) at height y, facing up. */
export function flatCap(mb: MeshBuilder, rings: XZ[][], y: number) {
  const contour = rings[0].map(([x, z]) => new THREE.Vector2(x, z));
  const holes = rings.slice(1).map((h) => h.map(([x, z]) => new THREE.Vector2(x, z)));
  const all = [...rings[0], ...rings.slice(1).flat()];
  let tris: number[][];
  try {
    tris = THREE.ShapeUtils.triangulateShape(contour, holes);
  } catch {
    return;
  }
  for (const [a, b, c] of tris) mb.triUp(V(all[a], y), V(all[b], y), V(all[c], y));
}

/** Gabled / hipped roof on a rectangle (p0→p1 is a long side). Returns the ridge height. */
export function pitched(mb: MeshBuilder, rect: XZ[], y: number, rise: number, hipped: boolean, roof: THREE.Color, gable: THREE.Color) {
  let [p0, p1, p2, p3] = rect;
  if (Math.hypot(p2[0] - p1[0], p2[1] - p1[1]) > Math.hypot(p1[0] - p0[0], p1[1] - p0[1])) [p0, p1, p2, p3] = [p1, p2, p3, p0];
  const long = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]);
  const short = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
  const mid = (a: XZ, b: XZ): XZ => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  let r1 = mid(p1, p2);
  let r3 = mid(p3, p0);
  if (hipped) {
    const k = Math.min(0.45, short / 2 / long);
    const a = r1, b = r3;
    r1 = [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k];
    r3 = [b[0] + (a[0] - b[0]) * k, b[1] + (a[1] - b[1]) * k];
  }
  const centre = new THREE.Vector3((p0[0] + p2[0]) / 2, y, (p0[1] + p2[1]) / 2);
  const R1 = V(r1, y + rise), R3 = V(r3, y + rise);
  mb.setColor(roof);
  mb.triOut(V(p0, y), V(p1, y), R1, centre);
  mb.triOut(V(p0, y), R1, R3, centre);
  mb.triOut(V(p2, y), V(p3, y), R3, centre);
  mb.triOut(V(p2, y), R3, R1, centre);
  mb.setColor(hipped ? roof : gable);
  mb.triOut(V(p1, y), V(p2, y), R1, centre);
  mb.triOut(V(p3, y), V(p0, y), R3, centre);
  // Underside of the eaves so the overhang isn't see-through from below.
  mb.setColor(roof);
  mb.triDown(V(p0, y), V(p2, y), V(p1, y));
  mb.triDown(V(p0, y), V(p3, y), V(p2, y));
  return y + rise;
}

export interface RoofInput {
  shape: RoofShape;
  rings: XZ[][];
  y: number;
  roof: THREE.Color;
  facade: THREE.Color;
  /** Explicit roof height (roof:height). */
  height?: number;
  /** Low-pitch metal sheet roofs (mái tôn) on workshops. */
  lowPitch?: boolean;
}

/**
 * Emits the roof for a footprint. Pitched shapes are fitted to the minimum-area rectangle
 * when the footprint is close to rectangular (≥ 80 % fill), otherwise they degrade to flat.
 */
export function buildRoof(mb: MeshBuilder, r: RoofInput) {
  const outer = r.rings[0];
  const shape = r.shape;
  if (shape === 'flat' || r.rings.length > 1) {
    mb.setColor(r.roof);
    flatCap(mb, r.rings, r.y);
    return;
  }
  const rect = minAreaRect(outer);
  const fill = polygonArea(outer) / Math.max(rect.area, 1e-6);
  const rectangular = fill > 0.8 && rect.short > 2;

  if ((shape === 'gabled' || shape === 'hipped') && rectangular) {
    const rise = r.height ?? Math.min(rect.short * (r.lowPitch ? 0.16 : 0.4), r.lowPitch ? 3 : 5);
    const eaves = grow(rect.corners, rect.centre, rect.axis, r.lowPitch ? 0.4 : 0.35);
    pitched(mb, eaves, r.y, rise, shape === 'hipped', r.roof, r.facade);
    return;
  }
  if (shape === 'pagoda' && rectangular) {
    // Two-tier temple roof with generous eaves (chùa).
    const s = rect.short;
    const y1 = pitched(mb, grow(rect.corners, rect.centre, rect.axis, Math.min(1.4, s * 0.15)), r.y, s * 0.22, true, r.roof, r.roof);
    const inner = grow(rect.corners, rect.centre, rect.axis, -s * 0.22);
    const wallTop = y1 + 1.8;
    mb.setColor(r.facade);
    for (let i = 0; i < 4; i++) {
      const a = inner[i], b = inner[(i + 1) % 4];
      mb.triOut(V(a, y1 - 0.4), V(b, y1 - 0.4), V(b, wallTop), new THREE.Vector3(rect.centre[0], y1, rect.centre[1]));
      mb.triOut(V(a, y1 - 0.4), V(b, wallTop), V(a, wallTop), new THREE.Vector3(rect.centre[0], y1, rect.centre[1]));
    }
    pitched(mb, grow(inner, rect.centre, rect.axis, Math.min(1.1, s * 0.12)), wallTop, s * 0.25, true, r.roof, r.roof);
    return;
  }
  // Pitched roofs on convex, non-rectangular footprints become pyramids; concave ones stay flat (#5 scope).
  const convex = convexHull(outer).length === outer.length;
  if ((shape === 'pyramidal' && convex) || ((shape === 'gabled' || shape === 'hipped' || shape === 'pagoda') && !rectangular && convex && outer.length <= 12)) {
    const c = centroid(outer);
    const rise = r.height ?? Math.min(Math.sqrt(polygonArea(outer)) * 0.45, 8);
    const apex = V(c, r.y + rise);
    const centre = V(c, r.y);
    mb.setColor(r.roof);
    for (let i = 0; i < outer.length; i++) mb.triOut(V(outer[i], r.y), V(outer[(i + 1) % outer.length], r.y), apex, centre);
    return;
  }
  if (shape === 'dome') {
    mb.setColor(r.roof);
    flatCap(mb, [outer], r.y);
    const c = centroid(outer);
    const rad = Math.sqrt(polygonArea(outer) / Math.PI) * 0.92;
    const h = r.height ?? rad;
    const seg = 16, rows = 5;
    const centre = V(c, r.y);
    const pt = (i: number, j: number) => {
      const a = (i / seg) * Math.PI * 2, t = (j / rows) * (Math.PI / 2);
      return new THREE.Vector3(c[0] + Math.cos(a) * rad * Math.cos(t), r.y + h * Math.sin(t), c[1] + Math.sin(a) * rad * Math.cos(t));
    };
    for (let j = 0; j < rows; j++)
      for (let i = 0; i < seg; i++) {
        mb.triOut(pt(i, j), pt(i + 1, j), pt(i + 1, j + 1), centre);
        if (j < rows - 1) mb.triOut(pt(i, j), pt(i + 1, j + 1), pt(i, j + 1), centre);
      }
    return;
  }
  mb.setColor(r.roof);
  flatCap(mb, r.rings, r.y);
}

export function centroid(r: XZ[]): XZ {
  let x = 0, z = 0;
  for (const p of r) { x += p[0]; z += p[1]; }
  return [x / r.length, z / r.length];
}
