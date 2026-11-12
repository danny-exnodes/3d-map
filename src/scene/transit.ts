import * as THREE from 'three';
import type { BBox } from '../data/types';
import type { TransitFile, TransitRoute, TransitStop } from '../data/transit';
import { bboxSizeMeters, type LocalProjection } from '../geo/projection';
import { MeshBuilder, merge, ribbon, type XZ } from './geometry';

/**
 * Real bus routes (#56): a thin ribbon per route (one merged mesh, vertex-colored by
 * `route.color`) and a shared marker for every stop (one `InstancedMesh`) — two draw calls total,
 * however many routes or stops the feed has, same approach as `landscape.ts:buildTrees`.
 */

const ROUTE_WIDTH = 2.2;
/** Just above the road surface so it reads as a painted line, like the 🚦 overlay (traffic.ts). */
const ROUTE_Y = 0.14;
const DEFAULT_ROUTE_COLOR = '#2f6fb3';

const STOP_POLE_COLOR = '#5d5a52';
const STOP_SIGN_COLOR = '#f2b705';
/** A city with a badly georeferenced or unbounded feed should not pay for thousands of markers. */
const MAX_STOPS = 500;

export interface TransitBuild {
  group: THREE.Group;
  routes: number;
  stops: number;
}

function colored(g: THREE.BufferGeometry, hex: string): THREE.BufferGeometry {
  g.deleteAttribute('uv');
  g.computeVertexNormals();
  const n = g.getAttribute('position').count;
  const c = new THREE.Color(hex);
  const col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) col.set([c.r, c.g, c.b], i * 3);
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return g;
}

/** Simple pole + sign marker, flat-colored (no vertex gradients needed for a tiny prop). */
function stopGeometry(): THREE.BufferGeometry {
  const pole = colored(new THREE.CylinderGeometry(0.07, 0.07, 2.1, 6).translate(0, 1.05, 0), STOP_POLE_COLOR);
  const sign = colored(new THREE.BoxGeometry(0.5, 0.34, 0.05).translate(0, 1.95, 0.03), STOP_SIGN_COLOR);
  return merge([pole, sign]) ?? pole;
}

/** Route color from GTFS `route_color` (no leading '#' in the feed) or the fallback. */
function routeColor(hex: string | undefined): string {
  if (!hex) return DEFAULT_ROUTE_COLOR;
  const h = hex.startsWith('#') ? hex : `#${hex}`;
  return /^#[0-9a-fA-F]{6}$/.test(h) ? h : DEFAULT_ROUTE_COLOR;
}

/** Liang–Barsky clip of one segment against the box [-hx,hx] x [-hz,hz] (the model's ground extent). */
function clipSegmentToBox(a: XZ, c: XZ, hx: number, hz: number): [XZ, XZ, boolean, boolean] | null {
  const dx = c[0] - a[0], dz = c[1] - a[1];
  let t0 = 0, t1 = 1;
  const edges: [number, number][] = [[-dx, a[0] + hx], [dx, hx - a[0]], [-dz, a[1] + hz], [dz, hz - a[1]]];
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
  const P = (t: number): XZ => [a[0] + dx * t, a[1] + dz * t];
  return [P(t0), P(t1), t0 === 0, t1 === 1];
}

/**
 * Clips a route shape against the model box, keeping every segment inside it. Unlike `clipLine`
 * (boats.ts), which keeps only the single longest run — fine for a boat that sails one continuous
 * leg — a bus route that crosses the box boundary more than once must keep every crossing (#56 QA).
 */
function clipPolylineToBox(pts: XZ[], hx: number, hz: number): XZ[][] {
  const out: XZ[][] = [];
  let cur: XZ[] = [];
  const flush = () => {
    if (cur.length >= 2) out.push(cur);
    cur = [];
  };
  for (let i = 1; i < pts.length; i++) {
    const seg = clipSegmentToBox(pts[i - 1], pts[i], hx, hz);
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

function buildRoutes(routes: TransitRoute[], proj: LocalProjection, hx: number, hz: number): { mesh: THREE.Mesh | null; count: number } {
  const mb = new MeshBuilder();
  let count = 0;
  for (const route of routes) {
    const segments = clipPolylineToBox(route.shape.map((p) => proj.project(p)), hx, hz);
    if (!segments.length) continue;
    count++;
    mb.setColor(routeColor(route.color));
    for (const pts of segments) ribbon(mb, pts, pts.map(() => ROUTE_Y), ROUTE_WIDTH);
  }
  if (mb.empty) return { mesh: null, count: 0 };
  const geo = mb.build();
  const mesh = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ vertexColors: true }));
  mesh.name = 'transit-routes';
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  return { mesh, count };
}

function buildStops(stops: TransitStop[], proj: LocalProjection, hx: number, hz: number): THREE.InstancedMesh | null {
  const placed = stops
    .map((s) => proj.project([s.lon, s.lat]))
    .filter(([x, z]) => Math.abs(x) <= hx && Math.abs(z) <= hz)
    .slice(0, MAX_STOPS);
  if (!placed.length) return null;
  const mesh = new THREE.InstancedMesh(stopGeometry(), new THREE.MeshLambertMaterial({ vertexColors: true }), placed.length);
  const m = new THREE.Matrix4();
  placed.forEach(([x, z], i) => {
    m.makeTranslation(x, 0, z);
    mesh.setMatrixAt(i, m);
  });
  mesh.name = 'transit-stops';
  mesh.castShadow = false;
  return mesh;
}

/** `bbox` is the built area's own bbox (data.bbox): routes/stops outside it are left out entirely. */
export function buildTransit(file: TransitFile, bbox: BBox, proj: LocalProjection): TransitBuild {
  const { width, depth } = bboxSizeMeters(bbox);
  const hx = width / 2, hz = depth / 2;
  const group = new THREE.Group();
  group.name = 'transit';
  const { mesh: routesMesh, count: routeCount } = buildRoutes(file.routes, proj, hx, hz);
  const stopsMesh = buildStops(file.stops, proj, hx, hz);
  if (routesMesh) group.add(routesMesh);
  if (stopsMesh) group.add(stopsMesh);
  return { group, routes: routeCount, stops: stopsMesh?.count ?? 0 };
}
