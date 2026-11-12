import * as THREE from 'three';
import type { BBox } from '../data/types';
import type { TransitFile, TransitRoute, TransitStop } from '../data/transit';
import { bboxSizeMeters, type LocalProjection } from '../geo/projection';
import { clipLine } from './boats';
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

function buildRoutes(routes: TransitRoute[], proj: LocalProjection, hx: number, hz: number): { mesh: THREE.Mesh | null; count: number } {
  const mb = new MeshBuilder();
  let count = 0;
  for (const route of routes) {
    const pts: XZ[] = clipLine(route.shape.map((p) => proj.project(p)), hx, hz);
    if (pts.length < 2) continue;
    count++;
    mb.setColor(routeColor(route.color));
    ribbon(mb, pts, pts.map(() => ROUTE_Y), ROUTE_WIDTH);
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
