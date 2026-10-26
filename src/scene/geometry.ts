import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

export type XZ = [number, number];

/** Accumulates triangles with position / normal / color into one buffer. */
export class MeshBuilder {
  positions: number[] = [];
  normals: number[] = [];
  colors: number[] = [];
  seeds: number[] = [];
  private seed = 0;
  private color = new THREE.Color();

  setColor(c: THREE.ColorRepresentation) {
    this.color.set(c);
    return this;
  }

  setSeed(s: number) {
    this.seed = s;
    return this;
  }

  tri(a: THREE.Vector3Like, b: THREE.Vector3Like, c: THREE.Vector3Like) {
    const ux = b.x - a.x, uy = b.y - a.y, uz = b.z - a.z;
    const vx = c.x - a.x, vy = c.y - a.y, vz = c.z - a.z;
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l; ny /= l; nz /= l;
    for (const p of [a, b, c]) {
      this.positions.push(p.x, p.y, p.z);
      this.normals.push(nx, ny, nz);
      this.colors.push(this.color.r, this.color.g, this.color.b);
      this.seeds.push(this.seed);
    }
  }

  /** Quad a-b-c-d, counter-clockwise when seen from the front. */
  quad(a: THREE.Vector3Like, b: THREE.Vector3Like, c: THREE.Vector3Like, d: THREE.Vector3Like) {
    this.tri(a, b, c);
    this.tri(a, c, d);
  }

  get empty() {
    return this.positions.length === 0;
  }

  build(withSeed = false): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.positions, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.normals, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.colors, 3));
    if (withSeed) g.setAttribute('aSeed', new THREE.Float32BufferAttribute(this.seeds, 1));
    g.computeBoundingSphere();
    return g;
  }
}

const v = (x: number, y: number, z: number) => ({ x, y, z });

/**
 * Flat ribbon along a polyline (x/z), with per-vertex heights.
 * Emits upward-facing triangles; optionally side skirts down to `bottom` offsets.
 */
export function ribbon(
  mb: MeshBuilder,
  pts: XZ[],
  heights: number[],
  width: number,
  opts: { offset?: number; skirt?: number } = {},
) {
  if (pts.length < 2) return;
  const half = width / 2;
  const off = opts.offset ?? 0;
  const left: THREE.Vector3Like[] = [];
  const right: THREE.Vector3Like[] = [];
  for (let i = 0; i < pts.length; i++) {
    const [nx, nz, scale] = miterNormal(pts, i);
    const [x, z] = pts[i];
    const y = heights[i];
    const l = (off - half) * scale;
    const r = (off + half) * scale;
    left.push(v(x + nx * l, y, z + nz * l));
    right.push(v(x + nx * r, y, z + nz * r));
  }
  for (let i = 0; i < pts.length - 1; i++) {
    // The miter normal points to the right of travel, so left→right→right'→left' faces up.
    mb.quad(left[i], right[i], right[i + 1], left[i + 1]);
    if (opts.skirt) {
      const s = opts.skirt;
      const lb = (p: THREE.Vector3Like) => v(p.x, p.y - s, p.z);
      mb.quad(left[i], left[i + 1], lb(left[i + 1]), lb(left[i]));
      mb.quad(right[i], lb(right[i]), lb(right[i + 1]), right[i + 1]);
      mb.quad(lb(left[i]), lb(left[i + 1]), lb(right[i + 1]), lb(right[i]));
    }
  }
}

/** Unit normal pointing to the right of travel direction, plus miter scale (clamped). */
export function miterNormal(pts: XZ[], i: number): [number, number, number] {
  const prev = pts[Math.max(0, i - 1)];
  const next = pts[Math.min(pts.length - 1, i + 1)];
  const cur = pts[i];
  const d1 = norm2(cur[0] - prev[0], cur[1] - prev[1]);
  const d2 = norm2(next[0] - cur[0], next[1] - cur[1]);
  let tx = d1[0] + d2[0];
  let tz = d1[1] + d2[1];
  if (i === 0) [tx, tz] = d2;
  else if (i === pts.length - 1) [tx, tz] = d1;
  const t = norm2(tx, tz);
  // Right-hand normal in x/z (z points south): rotate tangent by -90° around y.
  const n: [number, number] = [-t[1], t[0]];
  const dot = i === 0 || i === pts.length - 1 ? 1 : n[0] * -d2[1] + n[1] * d2[0];
  return [n[0], n[1], 1 / Math.max(0.35, Math.abs(dot))];
}

function norm2(x: number, z: number): [number, number] {
  const l = Math.hypot(x, z) || 1;
  return [x / l, z / l];
}

export function polylineLength(pts: XZ[]): number {
  let s = 0;
  for (let i = 1; i < pts.length; i++) s += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  return s;
}

/** Walks a polyline and calls `fn` every `step` meters with position and unit direction. */
export function sampleAlong(pts: XZ[], step: number, fn: (x: number, z: number, dx: number, dz: number, i: number, dist: number) => void, start = step / 2) {
  let carry = start;
  let dist = 0;
  for (let i = 1; i < pts.length; i++) {
    const [ax, az] = pts[i - 1];
    const [bx, bz] = pts[i];
    const len = Math.hypot(bx - ax, bz - az);
    if (len === 0) continue;
    const dx = (bx - ax) / len;
    const dz = (bz - az) / len;
    let s = carry;
    while (s <= len) {
      fn(ax + dx * s, az + dz * s, dx, dz, i - 1, dist + s);
      s += step;
    }
    carry = s - len;
    dist += len;
  }
}

/** Builds a THREE.Shape from projected rings (outer + holes). Shape space: (x, -z). */
export function shapeFromRings(rings: XZ[][]): THREE.Shape | null {
  if (!rings.length || rings[0].length < 3) return null;
  const toV2 = (r: XZ[]) => r.map(([x, z]) => new THREE.Vector2(x, -z));
  let outer = toV2(rings[0]);
  if (THREE.ShapeUtils.isClockWise(outer)) outer = outer.reverse();
  const shape = new THREE.Shape(outer);
  for (const h of rings.slice(1)) {
    if (h.length < 3) continue;
    let hole = toV2(h);
    if (!THREE.ShapeUtils.isClockWise(hole)) hole = hole.reverse();
    shape.holes.push(new THREE.Path(hole));
  }
  return shape;
}

/** Flat horizontal polygon at height y, facing up. */
export function flatPolygon(rings: XZ[][], y: number, color: THREE.ColorRepresentation): THREE.BufferGeometry | null {
  const shape = shapeFromRings(rings);
  if (!shape) return null;
  const g = new THREE.ShapeGeometry(shape);
  g.rotateX(-Math.PI / 2);
  g.translate(0, y, 0);
  g.deleteAttribute('uv');
  const n = g.attributes.position.count;
  const c = new THREE.Color(color);
  const col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) col.set([c.r, c.g, c.b], i * 3);
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return g.index ? g.toNonIndexed() : g;
}

export function merge(geoms: THREE.BufferGeometry[]): THREE.BufferGeometry | null {
  const list = geoms.filter((g) => g.attributes.position.count > 0);
  if (!list.length) return null;
  const m = mergeGeometries(list, false);
  for (const g of list) g.dispose();
  return m;
}
