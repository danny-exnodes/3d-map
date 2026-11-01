import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { rng } from '../data/rand';
import type { CityData } from '../data/types';
import { bboxSizeMeters, type LocalProjection } from '../geo/projection';
import type { XZ } from './geometry';
import { TOY_ROOFS, TOY_WALLS } from './toyPalette';
import { applyTint, box, fixed } from './traffic';

export type BoatKind = 'boat' | 'swan' | 'barge';
export type BoatRoute =
  | { kind: 'line'; pts: XZ[]; width: number }
  | { kind: 'area'; ring: XZ[]; areaM2: number; holes?: XZ[][]; /** Half-extent of the model (x, z): boats stay inside it. */ bounds?: XZ };

const MIN_RIVER_WIDTH = 6;
const MIN_LAKE_M2 = 5000;
/** Shorter lines give a degenerate heading and nowhere to sail. */
const MIN_LINE_M = 20;
const BARGE_RIVER_WIDTH = 30;
const M2_PER_BOAT = 5000;
const MAX_BOATS = 60;
/** Boats sit this high, so the hull bottom (-0.05) just touches the water and the +-0.15 bob never sinks it. */
const WATER_Y = 0.2;
const BOB = 0.15;
/** A leg across a lake only counts when it keeps this far from the shore (m). */
const SHORE_MARGIN = 2.5;
const LEG_STEP = 5;

const RING_BOX = new WeakMap<XZ[], [number, number, number, number]>();
function ringBox(ring: XZ[]) {
  let b = RING_BOX.get(ring);
  if (!b) {
    b = [Infinity, -Infinity, Infinity, -Infinity];
    for (const [x, z] of ring) { b[0] = Math.min(b[0], x); b[1] = Math.max(b[1], x); b[2] = Math.min(b[2], z); b[3] = Math.max(b[3], z); }
    RING_BOX.set(ring, b);
  }
  return b;
}

/** pointInRing with a bounding-box rejection first (legs are sampled thousands of times). */
function inRing(p: XZ, ring: XZ[]): boolean {
  const b = ringBox(ring);
  return p[0] >= b[0] && p[0] <= b[1] && p[1] >= b[2] && p[1] <= b[3] && pointInRing(p, ring);
}

export function pointInRing(p: XZ, ring: XZ[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, zi] = ring[i];
    const [xj, zj] = ring[j];
    if (zi > p[1] !== zj > p[1] && p[0] < ((xj - xi) * (p[1] - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

function ringArea(ring: XZ[]): number {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) a += (ring[j][0] + ring[i][0]) * (ring[j][1] - ring[i][1]);
  return Math.abs(a) / 2;
}

const lineLength = (pts: XZ[]) => pts.reduce((s, p, i) => (i ? s + Math.hypot(p[0] - pts[i - 1][0], p[1] - pts[i - 1][1]) : 0), 0);

/** Longest run of consecutive vertices inside the model; the map edge cuts rivers that run off it. */
function clipLine(pts: XZ[], hx: number, hz: number): XZ[] {
  let best: XZ[] = [], cur: XZ[] = [];
  for (const p of pts) {
    if (Math.abs(p[0]) <= hx && Math.abs(p[1]) <= hz) cur.push(p);
    else {
      if (cur.length > best.length) best = cur;
      cur = [];
    }
  }
  return cur.length > best.length ? cur : best;
}

/** Water area inside the model: exact when the polygon fits, else sampled on a grid (source polygons are not clipped to the map). */
function waterArea(ring: XZ[], holes: XZ[][], hx: number, hz: number): number {
  const exact = ringArea(ring) - holes.reduce((s, h) => s + ringArea(h), 0);
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const [x, z] of ring) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); }
  if (x0 >= -hx && x1 <= hx && z0 >= -hz && z1 <= hz) return exact;
  x0 = Math.max(x0, -hx); x1 = Math.min(x1, hx); z0 = Math.max(z0, -hz); z1 = Math.min(z1, hz);
  if (x1 <= x0 || z1 <= z0) return 0;
  const N = 40;
  let hit = 0;
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) {
      const p: XZ = [x0 + ((i + 0.5) / N) * (x1 - x0), z0 + ((j + 0.5) / N) * (z1 - z0)];
      if (pointInRing(p, ring) && !holes.some((h) => pointInRing(p, h))) hit++;
    }
  }
  return (hit / (N * N)) * (x1 - x0) * (z1 - z0);
}

/** Waterways at least 6 m wide and water areas of at least 0.5 ha, within the model. */
export function boatRoutes(data: CityData, proj: LocalProjection): BoatRoute[] {
  const { width, depth } = bboxSizeMeters(data.bbox);
  const hx = width / 2, hz = depth / 2;
  const routes: BoatRoute[] = [];
  for (const w of data.waterways) {
    if (w.width < MIN_RIVER_WIDTH) continue;
    const pts = clipLine(w.line.map((p) => proj.project(p)), hx, hz);
    if (pts.length >= 2 && lineLength(pts) >= MIN_LINE_M) routes.push({ kind: 'line', pts, width: w.width });
  }
  for (const a of data.areas) {
    if (a.kind !== 'water' || !a.polygon[0]) continue;
    const rings = a.polygon.map((r) => r.map((p) => proj.project(p)));
    const holes = rings.slice(1);
    const areaM2 = waterArea(rings[0], holes, hx, hz);
    if (areaM2 >= MIN_LAKE_M2) routes.push({ kind: 'area', ring: rings[0], areaM2, holes, bounds: [hx, hz] });
  }
  return routes;
}

/** About one boat per 5,000 m² of water, at least one. */
export function boatCount(route: BoatRoute): number {
  const m2 = route.kind === 'area' ? route.areaM2 : lineLength(route.pts) * route.width;
  return Math.max(1, Math.round(m2 / M2_PER_BOAT));
}

/** Per-route boat counts, scaled down proportionally when the total passes the cap. */
function allocate(routes: BoatRoute[]): number[] {
  const want = routes.map(boatCount);
  const total = want.reduce((a, b) => a + b, 0);
  if (total <= MAX_BOATS) return want;
  const got = want.map((n) => Math.max(1, Math.floor((n * MAX_BOATS) / total)));
  const order = got.map((_, i) => i).sort((a, b) => want[b] - want[a]);
  let sum = got.reduce((a, b) => a + b, 0);
  // Trim from the smallest shares first if the minimum of one each overshoots; top up the biggest otherwise.
  for (let k = order.length - 1; sum > MAX_BOATS && k >= 0; k--) if (got[order[k]] > 0) { got[order[k]]--; sum--; }
  for (let k = 0; sum < MAX_BOATS && k < order.length; k = (k + 1) % order.length) { got[order[k]]++; sum++; }
  return got;
}

const HULLS_TOY = [...TOY_WALLS, ...TOY_ROOFS];
const HULLS_PLAIN = ['#f1f1ec', '#3f6fa3', '#b8443c', '#d9a93f', '#4a8f64'];
const BARGES_TOY = ['#b5651d', '#8a8f94', '#a0522d', '#7a8288'];
const BARGES_PLAIN = ['#8c4a1e', '#6f757a', '#5b3a22', '#555b60'];
const SWANS = ['#ffffff', '#fdf6ee'];

/** Prism for a hull: stern at -l/2, straight sides to `shoulder`, then narrowing to a bow of width `bowW` at +l/2 (0 = point), bow top raised by `rise`. */
function hull(w: number, l: number, shoulder: number, bowW: number, y0: number, y1: number, rise: number, hex?: string): THREE.BufferGeometry {
  const hw = w / 2, bw = bowW / 2;
  const ring: XZ[] = [[-hw, -l / 2], [hw, -l / 2], [hw, shoulder]];
  if (bw > 0) ring.push([bw, l / 2], [-bw, l / 2]);
  else ring.push([0, l / 2]);
  ring.push([-hw, shoulder]);
  const n = ring.length;
  const topY = (i: number) => (ring[i][1] > shoulder ? y1 + rise : y1);
  const top = ring.map((q, i) => new THREE.Vector3(q[0], topY(i), q[1]));
  const bot = ring.map((q) => new THREE.Vector3(q[0], y0, q[1]));
  const centre = new THREE.Vector3(0, (y0 + y1) / 2, (ring[0][1] + l / 2) / 2);
  const pos: number[] = [];
  const tri = (p: THREE.Vector3, q: THREE.Vector3, r: THREE.Vector3) => {
    const nrm = q.clone().sub(p).cross(r.clone().sub(p));
    const mid = p.clone().add(q).add(r).divideScalar(3).sub(centre);
    // Keep every face wound outwards so Lambert lighting and culling are right.
    if (nrm.dot(mid) < 0) pos.push(p.x, p.y, p.z, r.x, r.y, r.z, q.x, q.y, q.z);
    else pos.push(p.x, p.y, p.z, q.x, q.y, q.z, r.x, r.y, r.z);
  };
  for (let i = 1; i < n - 1; i++) tri(top[0], top[i], top[i + 1]);
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    tri(top[i], bot[i], bot[j]);
    tri(top[i], bot[j], top[j]);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  const count = pos.length / 3;
  const c = new THREE.Color(hex ?? '#ffffff');
  const col = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) col.set([c.r, c.g, c.b], i * 3);
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setAttribute('tint', new THREE.BufferAttribute(new Float32Array(count).fill(hex ? 0 : 1), 1));
  return g;
}

/** A box tipped forward by `rx` radians around its base centre, then placed there. */
function tipped(w: number, h: number, l: number, rx: number, y: number, z: number, hex: string): THREE.BufferGeometry {
  return fixed(w, h, l, 0, 0, hex).rotateX(rx).translate(0, y, z);
}

/** Pointed hull, low cabin and canopy. +z is the bow. */
function boatGeometry(): THREE.BufferGeometry {
  return mergeGeometries([
    hull(1.7, 4.6, 0.9, 0, -0.05, 0.55, 0.2),
    fixed(1.15, 0.5, 1.3, 0.55, -0.7, '#f4f0e6'),
    box(1.4, 0.08, 1.7, 1.05, -0.7),
  ])!;
}

/** Long flat hull with a squared bow, cargo cover and a small wheelhouse at the stern. */
function bargeGeometry(): THREE.BufferGeometry {
  return mergeGeometries([
    hull(2.3, 9, 3.9, 1.5, -0.05, 0.6, 0.1),
    fixed(1.9, 0.3, 4.6, 0.6, 0.9, '#6b5a4a'),
    fixed(1.7, 0.95, 1.7, 0.6, -3.2, '#f1ede4'),
    box(1.9, 0.1, 2.0, 1.55, -3.2),
  ])!;
}

/** Pedal boat: two pointed floats, a deck, a pastel canopy on posts and a swan with an S neck, head and orange beak. */
function swanGeometry(): THREE.BufferGeometry {
  const post = (x: number, z: number) => fixed(0.08, 0.95, 0.08, 0.5, 0, '#ffffff').translate(x, 0, z);
  return mergeGeometries([
    hull(0.5, 2.9, 0.7, 0, -0.05, 0.4, 0.1).translate(0.6, 0, 0),
    hull(0.5, 2.9, 0.7, 0, -0.05, 0.4, 0.1).translate(-0.6, 0, 0),
    box(1.7, 0.12, 2.1, 0.4, -0.1),
    post(-0.65, -0.95), post(0.65, -0.95), post(-0.65, -0.2), post(0.65, -0.2),
    fixed(1.6, 0.08, 1.2, 1.45, -0.6, '#f7d9e3'),
    fixed(0.9, 0.6, 1.2, 0.52, 0.55, '#ffffff'),
    fixed(0.5, 0.3, 0.5, 0.75, 1.3, '#ffffff'),
    tipped(0.26, 0.6, 0.26, 0.6, 1.0, 1.0, '#ffffff'),
    tipped(0.24, 0.55, 0.24, -0.35, 1.45, 1.33, '#ffffff'),
    fixed(0.28, 0.28, 0.42, 1.85, 1.5, '#ffffff'),
    fixed(0.14, 0.1, 0.32, 1.95, 1.85, '#f08a3c'),
  ])!;
}

/** The three shapes in one geometry; each vertex records its shape and the material hides the others. */
function boatsGeometry(): { geo: THREE.BufferGeometry; tris: Record<BoatKind, number> } {
  const kinds: BoatKind[] = ['boat', 'barge', 'swan'];
  const parts = [boatGeometry(), bargeGeometry(), swanGeometry()];
  const tris = {} as Record<BoatKind, number>;
  parts.forEach((g, i) => {
    const n = g.getAttribute('position').count;
    g.setAttribute('shape', new THREE.BufferAttribute(new Float32Array(n).fill(i), 1));
    tris[kinds[i]] = n / 3;
  });
  return { geo: mergeGeometries(parts)!, tris };
}

/** Collapses every vertex whose `shape` differs from the instance's `pick`, so one draw call shows three kinds. */
function pickShape(mat: THREE.Material) {
  const prev = mat.onBeforeCompile.bind(mat);
  mat.onBeforeCompile = (shader, r) => {
    prev(shader, r);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float shape;\nattribute float pick;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nif (abs(shape - pick) > 0.5) transformed = vec3(0.0);');
  };
  mat.customProgramCacheKey = () => 'boats-' + mat.type;
  return mat;
}

/** Triangles each kind adds per boat (all three are submitted, two collapsed). */
export const BOAT_TRIANGLES = boatsGeometry().tris;

interface Boat {
  kind: BoatKind;
  route: number;
  x: number;
  z: number;
  yaw: number;
  speed: number;
  phase: number;
  scale: number;
  /** Which instanced mesh (always 0) and slot it draws in. */
  mesh: 0;
  slot: number;
  /** Area boats: current target and a wait timer. */
  tx: number;
  tz: number;
  wait: number;
  /** Line boats: distance along the line, direction, side offset (eased). */
  d: number;
  dir: 1 | -1;
  side: number;
  lat: number;
}

export interface BoatInfo {
  kind: BoatKind;
  route: number;
  x: number;
  z: number;
}

export class Boats {
  readonly group = new THREE.Group();
  private readonly boats: Boat[] = [];
  private readonly meshes: THREE.InstancedMesh[] = [];
  private readonly cum: number[][];
  private readonly rand: () => number;
  private readonly dummy = new THREE.Object3D();

  constructor(private readonly routes: BoatRoute[], seed: number, toy: boolean) {
    this.group.name = 'boats';
    this.rand = rng(seed);
    const r = this.rand;
    this.cum = routes.map((rt) => {
      if (rt.kind !== 'line') return [];
      const c = [0];
      for (let i = 1; i < rt.pts.length; i++) c.push(c[i - 1] + Math.hypot(rt.pts[i][0] - rt.pts[i - 1][0], rt.pts[i][1] - rt.pts[i - 1][1]));
      return c;
    });

    const counts = allocate(routes);
    const slots = [0, 0];
    routes.forEach((rt, ri) => {
      for (let i = 0; i < counts[ri]; i++) {
        const kind: BoatKind = rt.kind === 'line' ? (rt.width >= BARGE_RIVER_WIDTH && i % 3 === 0 ? 'barge' : 'boat') : i % 3 === 1 ? 'swan' : 'boat';
        const mesh = 0;
        const b: Boat = {
          kind, route: ri, x: 0, z: 0, yaw: 0, mesh, slot: 0,
          speed: kind === 'barge' ? 1.2 + r() * 0.6 : kind === 'swan' ? 0.8 + r() * 0.5 : 1.8 + r() * 1.4,
          phase: r() * Math.PI * 2, scale: kind === 'swan' ? 1.5 : kind === 'barge' ? 1.3 : 1.4,
          tx: 0, tz: 0, wait: 0, d: 0, dir: r() < 0.5 ? 1 : -1, side: 0, lat: 0,
        };
        if (rt.kind === 'line') {
          const total = this.cum[ri][this.cum[ri].length - 1];
          // Spread along the line rather than clumped by chance.
          b.d = ((i + r() * 0.7) / counts[ri]) * total;
          b.side = (0.12 + r() * 0.18) * rt.width;
          b.lat = b.side;
          this.placeOnLine(b);
        } else if (!this.spawnInArea(b, rt)) {
          continue;
        }
        b.slot = slots[mesh]++;
        this.boats.push(b);
      }
    });

    const palette = (b: Boat) => (b.kind === 'swan' ? SWANS : b.kind === 'barge' ? (toy ? BARGES_TOY : BARGES_PLAIN) : toy ? HULLS_TOY : HULLS_PLAIN);
    const { geo } = boatsGeometry();
    const picks = new Float32Array(Math.max(1, slots[0]));
    for (const b of this.boats) picks[b.slot] = b.kind === 'boat' ? 0 : b.kind === 'barge' ? 1 : 2;
    geo.setAttribute('pick', new THREE.InstancedBufferAttribute(picks, 1));
    const mesh = new THREE.InstancedMesh(geo, pickShape(applyTint(new THREE.MeshLambertMaterial({ vertexColors: true }))), Math.max(1, slots[0]));
    mesh.count = slots[0];
    mesh.castShadow = false;
    mesh.frustumCulled = false;
    mesh.name = 'boats';
    this.meshes.push(mesh);
    if (slots[0]) this.group.add(mesh);
    const col = new THREE.Color();
    for (const b of this.boats) {
      const pal = palette(b);
      this.meshes[b.mesh].setColorAt(b.slot, col.set(pal[Math.floor(r() * pal.length)]));
    }
    this.write(0);
  }

  private inArea(p: XZ, rt: Extract<BoatRoute, { kind: 'area' }>): boolean {
    if (rt.bounds && (Math.abs(p[0]) > rt.bounds[0] || Math.abs(p[1]) > rt.bounds[1])) return false;
    return inRing(p, rt.ring) && !(rt.holes?.some((h) => inRing(p, h)) ?? false);
  }

  /** Centre and the four points `m` metres around it, all on the water. */
  private clear(x: number, z: number, rt: Extract<BoatRoute, { kind: 'area' }>, m: number): boolean {
    return this.inArea([x, z], rt) && this.inArea([x + m, z], rt) && this.inArea([x - m, z], rt) && this.inArea([x, z + m], rt) && this.inArea([x, z - m], rt);
  }

  private bounds(rt: Extract<BoatRoute, { kind: 'area' }>) {
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const [x, z] of rt.ring) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); }
    if (rt.bounds) {
      x0 = Math.max(x0, -rt.bounds[0]); x1 = Math.min(x1, rt.bounds[0]);
      z0 = Math.max(z0, -rt.bounds[1]); z1 = Math.min(z1, rt.bounds[1]);
    }
    return { x0, x1, z0, z1 };
  }

  private sample(rt: Extract<BoatRoute, { kind: 'area' }>, m: number, tries: number): XZ | null {
    const { x0, x1, z0, z1 } = this.bounds(rt);
    for (let i = 0; i < tries; i++) {
      const x = x0 + this.rand() * (x1 - x0);
      const z = z0 + this.rand() * (z1 - z0);
      if (this.clear(x, z, rt, m)) return [x, z];
    }
    return null;
  }

  /** False when no spot on the water can be found (the boat is then left out). */
  private spawnInArea(b: Boat, rt: Extract<BoatRoute, { kind: 'area' }>): boolean {
    const p = this.sample(rt, SHORE_MARGIN, 80) ?? this.sample(rt, 0, 400);
    if (!p) return false;
    b.x = b.tx = p[0];
    b.z = b.tz = p[1];
    b.yaw = this.rand() * Math.PI * 2;
    b.wait = this.rand() * 3;
    return true;
  }

  private legClear(b: Boat, rt: Extract<BoatRoute, { kind: 'area' }>, tx: number, tz: number): boolean {
    const len = Math.hypot(tx - b.x, tz - b.z);
    const n = Math.max(1, Math.ceil(len / LEG_STEP));
    for (let i = 1; i <= n; i++) {
      const t = i / n;
      if (!this.clear(b.x + (tx - b.x) * t, b.z + (tz - b.z) * t, rt, SHORE_MARGIN)) return false;
    }
    return true;
  }

  private pickTarget(b: Boat, rt: Extract<BoatRoute, { kind: 'area' }>): boolean {
    for (let i = 0; i < 25; i++) {
      const p = this.sample(rt, SHORE_MARGIN, 8);
      if (!p || Math.hypot(p[0] - b.x, p[1] - b.z) < 12) continue;
      if (this.legClear(b, rt, p[0], p[1])) {
        b.tx = p[0];
        b.tz = p[1];
        return true;
      }
    }
    return false;
  }

  private placeOnLine(b: Boat) {
    const rt = this.routes[b.route] as Extract<BoatRoute, { kind: 'line' }>;
    const cum = this.cum[b.route];
    let lo = 0, hi = cum.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (cum[mid] <= b.d) lo = mid;
      else hi = mid;
    }
    const a = rt.pts[lo], c = rt.pts[hi];
    const seg = cum[hi] - cum[lo] || 1;
    const t = Math.min(1, Math.max(0, (b.d - cum[lo]) / seg));
    const dx = ((c[0] - a[0]) / seg) * b.dir;
    const dz = ((c[1] - a[1]) / seg) * b.dir;
    // Right of travel (x east, z south): (-dz, dx).
    b.x = a[0] + (c[0] - a[0]) * t - dz * b.lat;
    b.z = a[1] + (c[1] - a[1]) * t + dx * b.lat;
    const target = Math.atan2(dx, dz);
    b.yaw = turnTo(b.yaw, target, 1);
  }

  update(dt: number, time: number) {
    for (const b of this.boats) {
      const rt = this.routes[b.route];
      if (rt.kind === 'line') {
        const total = this.cum[b.route][this.cum[b.route].length - 1];
        b.d += b.dir * b.speed * dt;
        if (b.d > total) { b.d = total; b.dir = -1; } else if (b.d < 0) { b.d = 0; b.dir = 1; }
        // Keep to the right of travel after a U-turn; the side eases over so the turn is a sweep, not a jump.
        b.lat += (b.side - b.lat) * Math.min(1, dt * 0.8);
        const prev = b.yaw;
        this.placeOnLine(b);
        b.yaw = turnTo(prev, b.yaw, Math.min(1, dt * 1.5));
      } else {
        if (b.wait > 0) {
          b.wait -= dt;
          if (b.wait <= 0 && !this.pickTarget(b, rt)) b.wait = 1 + this.rand() * 2;
          continue;
        }
        const dx = b.tx - b.x, dz = b.tz - b.z;
        const dist = Math.hypot(dx, dz);
        const step = b.speed * dt;
        if (dist <= step) {
          b.x = b.tx;
          b.z = b.tz;
          b.wait = 0.5 + this.rand() * 3;
        } else {
          b.x += (dx / dist) * step;
          b.z += (dz / dist) * step;
          b.yaw = turnTo(b.yaw, Math.atan2(dx, dz), Math.min(1, dt * 2));
        }
      }
    }
    this.write(time);
  }

  private write(time: number) {
    const d = this.dummy;
    for (const b of this.boats) {
      d.position.set(b.x, WATER_Y + Math.sin(time * 1.4 + b.phase) * BOB, b.z);
      d.rotation.set(Math.sin(time * 0.9 + b.phase * 1.7) * 0.03, b.yaw, Math.sin(time * 1.1 + b.phase) * 0.04, 'YXZ');
      d.scale.set(b.scale, b.scale, b.scale);
      d.updateMatrix();
      this.meshes[b.mesh].setMatrixAt(b.slot, d.matrix);
    }
    for (const m of this.meshes) m.instanceMatrix.needsUpdate = true;
  }

  list(): BoatInfo[] {
    return this.boats.map((b) => ({ kind: b.kind, route: b.route, x: b.x, z: b.z }));
  }

  positions(): XZ[] {
    return this.boats.map((b) => [b.x, b.z]);
  }

  dispose() {
    for (const m of this.meshes) {
      m.geometry.dispose();
      (m.material as THREE.Material).dispose();
      m.dispose();
    }
    this.group.clear();
  }
}

/** Turn `from` towards `to` (radians) by the fraction `k` along the short way. */
function turnTo(from: number, to: number, k: number): number {
  let diff = (to - from) % (Math.PI * 2);
  if (diff > Math.PI) diff -= Math.PI * 2;
  else if (diff < -Math.PI) diff += Math.PI * 2;
  return from + diff * k;
}
