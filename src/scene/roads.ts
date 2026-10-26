import * as THREE from 'three';
import type { Rail, Road, RoadClass } from '../data/types';
import type { LocalProjection } from '../geo/projection';
import { MeshBuilder, ribbon, sampleAlong, type XZ } from './geometry';

export interface RoadPath {
  road: Road;
  pts: XZ[];
  heights: number[];
  /** Cumulative distance at each vertex. */
  dist: number[];
  length: number;
}

export interface RailPath {
  rail: Rail;
  pts: XZ[];
  heights: number[];
  dist: number[];
  length: number;
}

export interface RoadsResult {
  group: THREE.Group;
  paths: RoadPath[];
  railPaths: RailPath[];
  /** Points suitable for street lamps: [x, y, z, dirX, dirZ]. */
  lampSpots: number[][];
}

const ORDER: RoadClass[] = ['path', 'service', 'residential', 'tertiary', 'secondary', 'primary', 'motorway'];
export const ROAD_COLORS: Record<RoadClass, string> = {
  motorway: '#3b3f48',
  primary: '#40444d',
  secondary: '#454953',
  tertiary: '#4a4e57',
  residential: '#50545c',
  service: '#5d6068',
  path: '#cbbf9f',
};
const SIDEWALK = '#d9cfb8';
const PARAPET = '#cfc9be';
/** Depth of covered tunnels below the street (m). */
export const TUNNEL_DEPTH = 6.5;
/** Shallower than this, a tunnel ramp is an open cut; deeper, it is covered. */
export const TUNNEL_COVERED = -4.8;
const DECK = '#8f8a82';

const key = (p: XZ) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`;

function cumulative(pts: XZ[]): number[] {
  const d = [0];
  for (let i = 1; i < pts.length; i++) d.push(d[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  return d;
}

/** Height profile that ramps from the ground to `h` unless an end joins another elevated way. */
function profile(dist: number[], h: number, joinedStart: boolean, joinedEnd: boolean): number[] {
  const L = dist[dist.length - 1];
  const ramp = Math.min(L * 0.45, 25 + h * 9);
  const smooth = (t: number) => t * t * (3 - 2 * t);
  return dist.map((d) => {
    const a = joinedStart ? 1 : smooth(Math.min(1, d / ramp));
    const b = joinedEnd ? 1 : smooth(Math.min(1, (L - d) / ramp));
    return h * Math.min(a, b);
  });
}

export function elevationOf(r: { bridge: boolean; layer: number }, length: number, base = 6.5): number {
  if (!r.bridge) return 0;
  const h = base * Math.max(1, r.layer);
  // Short bridges (over canals, rivers) only hump a little.
  return length < 90 ? Math.min(h, 1 + length * 0.04) : h;
}

export function buildRoads(roads: Road[], rails: Rail[], proj: LocalProjection): RoadsResult {
  const group = new THREE.Group();
  group.name = 'roads';
  const paths: RoadPath[] = [];

  const sorted = roads
    .filter((r) => r.line.length >= 2)
    .sort((a, b) => ORDER.indexOf(a.cls) - ORDER.indexOf(b.cls));

  // Endpoint index of elevated ways, so connected flyover segments stay up.
  const elevatedEnds = new Map<string, number>();
  const tunnelEnds = new Map<string, number>();
  const pre = sorted.map((road) => {
    let pts = road.line.map((p) => proj.project(p));
    // Tunnels change depth along their ramps, so they need vertices every few metres (#25).
    if (road.tunnel) pts = densify(pts, 4);
    const dist = cumulative(pts);
    const h = elevationOf(road, dist[dist.length - 1]);
    const ends = road.tunnel ? tunnelEnds : h > 3 ? elevatedEnds : null;
    if (ends) for (const p of [pts[0], pts[pts.length - 1]]) ends.set(key(p), (ends.get(key(p)) ?? 0) + 1);
    return { road, pts, dist, h };
  });

  const sidewalks = new MeshBuilder().setColor(SIDEWALK);
  const ground = new MeshBuilder();
  const elevated = new MeshBuilder();
  const marks = new MeshBuilder().setColor('#f3f1e8');
  const elevMarks = new MeshBuilder().setColor('#f3f1e8');
  const pillars: [number, number, number, number][] = [];
  /** Cross beams on top of flyover pillars: x, z, top y, length, heading. */
  const caps: [number, number, number, number, number][] = [];
  const tunnelCover = new MeshBuilder().setColor('#1d2027');
  const lampSpots: number[][] = [];

  for (const { road, pts, dist, h } of pre) {
    if (road.tunnel) {
      const joined = (p: XZ) => (tunnelEnds.get(key(p)) ?? 0) > 1;
      const heights = profile(dist, TUNNEL_DEPTH, joined(pts[0]), joined(pts[pts.length - 1])).map((y) => -y);
      paths.push({ road, pts, heights, dist, length: dist[dist.length - 1] });
      buildTunnel(road, pts, heights, ground, elevated, tunnelCover);
      continue;
    }
    const elevatedWay = h > 3;
    const heights = elevatedWay
      ? profile(dist, h, (elevatedEnds.get(key(pts[0])) ?? 0) > 1, (elevatedEnds.get(key(pts[pts.length - 1])) ?? 0) > 1)
      : dist.map(() => 0);
    if (h > 0 && !elevatedWay) {
      // Small hump bridge.
      const L = dist[dist.length - 1];
      for (let i = 0; i < heights.length; i++) heights[i] = h * Math.sin((Math.PI * dist[i]) / L);
    }
    const length = dist[dist.length - 1];
    paths.push({ road, pts, heights, dist, length });

    const isElevated = heights.some((y) => y > 0.8);
    const lift = isElevated ? heights.map((y) => y + 0.02) : heights.map(() => 0);

    if (!isElevated && road.cls !== 'path' && road.cls !== 'service') {
      ribbon(sidewalks, pts, lift, road.width + 4);
    }
    if (isElevated) {
      ribbon(elevated.setColor(DECK), pts, lift.map((y) => y - 0.01), road.width + 1.2, { skirt: 1.3 });
      ribbon(elevated.setColor(ROAD_COLORS[road.cls]), pts, lift, road.width);
      // Concrete parapets along both edges make the deck read clearly against the street below (#25).
      for (const side of [-1, 1]) {
        ribbon(elevated.setColor(PARAPET), pts, lift.map((y) => y + 1.05), 0.4, { offset: side * (road.width / 2 + 0.4), skirt: 1.1 });
      }
      sampleAlong(pts, 28, (x, z, dx, dz, i, d) => {
        const y = interp(dist, heights, i, d);
        if (y > 3) {
          pillars.push([x, z, y - 2.3, Math.max(1.4, road.width * 0.18)]);
          caps.push([x, z, y - 1.3, road.width + 1.2, Math.atan2(dx, dz)]);
        }
      });
    } else {
      ribbon(ground.setColor(ROAD_COLORS[road.cls]), pts, lift, road.width);
      if (road.bridge && h > 0) {
        // Small bridges over canals: low railings.
        for (const side of [-1, 1]) {
          ribbon(elevated.setColor(PARAPET), pts, heights.map((y) => y + 0.9), 0.3, { offset: side * (road.width / 2 + 0.3), skirt: 0.9 });
        }
      }
    }

    if (road.lanes >= 2 && road.cls !== 'path' && road.cls !== 'service') {
      const mm = isElevated ? elevMarks : marks;
      const dash = road.cls === 'residential' ? 2 : 3;
      sampleAlong(pts, dash * 2.5, (x, z, dx, dz, i, d) => {
        const y = (isElevated ? interp(dist, heights, i, d) : 0) + 0.04;
        const hx = dx * dash * 0.5;
        const hz = dz * dash * 0.5;
        const nx = -dz * 0.09;
        const nz = dx * 0.09;
        mm.quad(
          { x: x - hx - nx, y, z: z - hz - nz },
          { x: x - hx + nx, y, z: z - hz + nz },
          { x: x + hx + nx, y, z: z + hz + nz },
          { x: x + hx - nx, y, z: z + hz - nz },
        );
      });
    }

    if (road.cls === 'residential' && !isElevated) {
      // Alleys and small streets: one lamp every ~30 m, alternating sides (#25).
      let k = 0;
      sampleAlong(pts, 30, (x, z, dx, dz) => {
        const side = k++ % 2 ? 1 : -1;
        const off = side * (road.width / 2 + 0.4);
        lampSpots.push([x - dz * off, 0, z + dx * off, dx * side, dz * side]);
      });
    }
    if (['motorway', 'primary', 'secondary', 'tertiary'].includes(road.cls)) {
      sampleAlong(pts, 32, (x, z, dx, dz, i, d) => {
        const y = isElevated ? interp(dist, heights, i, d) : 0;
        for (const side of [-1, 1]) {
          const off = side * (road.width / 2 + (isElevated ? 0.3 : 1.2));
          lampSpots.push([x - dz * off, y, z + dx * off, dx * side, dz * side]);
        }
      });
    }
  }

  const flat = (mb: MeshBuilder, order: number, name: string, glow = 0) => {
    if (mb.empty) return;
    const mat = new THREE.MeshLambertMaterial({ vertexColors: true, depthWrite: false });
    mat.userData.streetGlow = glow;
    const m = new THREE.Mesh(mb.build(), mat);
    m.renderOrder = order;
    m.receiveShadow = true;
    m.name = name;
    group.add(m);
  };
  flat(sidewalks, -7, 'sidewalks', 0.3);
  flat(ground, -6, 'roads', 0.45);
  flat(marks, -5, 'markings');

  const rail = buildRails(rails, proj, elevated, pillars);
  if (rail.ballast) group.add(rail.ballast);

  if (!elevated.empty) {
    const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
    mat.userData.streetGlow = 0.35;
    const m = new THREE.Mesh(elevated.build(), mat);
    m.castShadow = true;
    m.receiveShadow = true;
    m.name = 'elevated';
    group.add(m);
  }
  if (!elevMarks.empty) {
    const m = new THREE.Mesh(
      elevMarks.build(),
      new THREE.MeshLambertMaterial({ vertexColors: true, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }),
    );
    group.add(m);
  }
  if (!tunnelCover.empty) {
    // Covered tunnel sections: a dark band on the surface marks where the road runs underground.
    const m = new THREE.Mesh(tunnelCover.build(), new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.55, depthWrite: false }));
    m.renderOrder = -4;
    m.name = 'tunnelCover';
    group.add(m);
  }
  if (caps.length) {
    const geo = new THREE.BoxGeometry(1, 1, 1.6).translate(0, -0.5, 0);
    const inst = new THREE.InstancedMesh(geo, new THREE.MeshLambertMaterial({ color: '#9b958b' }), caps.length);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    caps.forEach(([x, z, y, len, a], i) => inst.setMatrixAt(i, m.compose(new THREE.Vector3(x, y, z), q.setFromAxisAngle(up, a + Math.PI / 2), new THREE.Vector3(len, 1, 1))));
    inst.castShadow = true;
    inst.receiveShadow = true;
    inst.name = 'pillarCaps';
    group.add(inst);
  }
  if (pillars.length) {
    const geo = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
    const inst = new THREE.InstancedMesh(geo, new THREE.MeshLambertMaterial({ color: '#a39d93' }), pillars.length);
    const m = new THREE.Matrix4();
    pillars.forEach(([x, z, h, w], i) => inst.setMatrixAt(i, m.makeScale(w, h, w).setPosition(x, 0, z)));
    inst.castShadow = true;
    inst.receiveShadow = true;
    inst.name = 'pillars';
    group.add(inst);
  }

  return { group, paths, railPaths: rail.paths, lampSpots };
}

function buildRails(
  rails: Rail[],
  proj: LocalProjection,
  elevated: MeshBuilder,
  pillars: [number, number, number, number][],
): { paths: RailPath[]; ballast?: THREE.Mesh } {
  const out: RailPath[] = [];
  const ballast = new MeshBuilder();
  for (const rail of rails) {
    if (rail.tunnel || rail.line.length < 2) continue;
    const pts = rail.line.map((p) => proj.project(p));
    const dist = cumulative(pts);
    const L = dist[dist.length - 1];
    const up = rail.bridge || rail.layer > 0;
    const h = up ? 9 * Math.max(1, rail.layer > 0 ? Math.min(rail.layer, 2) * 0.75 : 1) : 0;
    const heights = up && L > 120 ? dist.map(() => h) : dist.map(() => (up ? Math.min(h, 2) : 0));
    out.push({ rail, pts, heights, dist, length: L });

    const tram = rail.kind === 'tram';
    if (heights[0] > 3) {
      ribbon(elevated.setColor('#b7b1a6'), pts, heights, 9, { skirt: 1.6 });
      // Parapets.
      for (const side of [-1, 1]) {
        ribbon(elevated.setColor('#c9c3b8'), pts, heights.map((y) => y + 0.9), 0.35, { offset: side * 4.3, skirt: 0.9 });
      }
      sampleAlong(pts, 30, (x, z) => pillars.push([x, z, h - 1.6, 2.2]));
    } else if (!tram) {
      ribbon(ballast.setColor('#9c948a'), pts, heights.map((y) => y + 0.03), 4.2);
    }
    const target = heights[0] > 3 ? elevated : ballast;
    for (const side of [-1, 1]) {
      for (const gauge of heights[0] > 3 ? [-1.9, 1.9] : [0]) {
        ribbon(target.setColor('#5d5a57'), pts, heights.map((y) => y + 0.12), 0.18, { offset: gauge + side * 0.72 });
      }
    }
  }
  if (ballast.empty) return { paths: out };
  // Ground-level tracks are drawn as a flat layer like roads.
  const m = new THREE.Mesh(ballast.build(), new THREE.MeshLambertMaterial({ vertexColors: true, depthWrite: false }));
  m.renderOrder = -6;
  m.receiveShadow = true;
  m.name = 'rails';
  return { paths: out, ballast: m };
}

/** Inserts vertices so that no segment is longer than `step` metres. */
export function densify(pts: XZ[], step: number): XZ[] {
  const out: XZ[] = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const [ax, az] = pts[i - 1];
    const [bx, bz] = pts[i];
    const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / step));
    for (let k = 1; k <= n; k++) out.push([ax + ((bx - ax) * k) / n, az + ((bz - az) * k) / n]);
  }
  return out;
}

/**
 * Underpass (hầm chui): open-cut ramps are drawn with their road surface going down between
 * retaining walls; where the tunnel is covered, only a dark band on the surface shows its course,
 * and a portal face closes each ramp.
 */
function buildTunnel(road: Road, pts: XZ[], heights: number[], ground: MeshBuilder, walls: MeshBuilder, cover: MeshBuilder) {
  const runs: { open: boolean; from: number; to: number }[] = [];
  for (let i = 0; i < pts.length; i++) {
    const open = heights[i] > TUNNEL_COVERED;
    const last = runs[runs.length - 1];
    if (last && last.open === open) last.to = i;
    else runs.push({ open, from: Math.max(0, i - 1), to: i });
  }
  for (const run of runs) {
    const p = pts.slice(run.from, run.to + 1);
    const h = heights.slice(run.from, run.to + 1);
    if (p.length < 2) continue;
    if (run.open) {
      ribbon(ground.setColor(ROAD_COLORS[road.cls]), p, h, road.width);
      for (const side of [-1, 1]) {
        // Dark cut walls going down to the road, a light coping on top.
        ribbon(walls.setColor('#6f6c66'), p, p.map(() => 0.65), 0.45, { offset: side * (road.width / 2 + 0.25), skirt: TUNNEL_DEPTH + 0.65 });
        ribbon(walls.setColor(PARAPET), p, p.map(() => 0.72), 0.55, { offset: side * (road.width / 2 + 0.25) });
      }
    } else {
      ribbon(cover, p, p.map(() => 0.06), road.width + 0.8);
    }
  }
  // Portal faces where an open ramp meets the covered section.
  for (let k = 1; k < runs.length; k++) {
    const i = runs[k].from;
    const j = Math.min(i + 1, pts.length - 1);
    const [x, z] = pts[i];
    const dx = pts[j][0] - x, dz = pts[j][1] - z;
    const len = Math.hypot(dx, dz) || 1;
    const nx = -dz / len * (road.width / 2 + 0.5), nz = dx / len * (road.width / 2 + 0.5);
    const y0 = heights[i];
    const face = (yb: number, yt: number) => walls.quad({ x: x - nx, y: yb, z: z - nz }, { x: x + nx, y: yb, z: z + nz }, { x: x + nx, y: yt, z: z + nz }, { x: x - nx, y: yt, z: z - nz });
    walls.setColor('#16181d');
    face(y0, -0.6);
    walls.setColor(PARAPET);
    face(-0.6, 0.8);
  }
}

export function interp(dist: number[], values: number[], i: number, d: number): number {
  const a = dist[i];
  const b = dist[i + 1] ?? a;
  const t = b > a ? (d - a) / (b - a) : 0;
  return values[i] + ((values[i + 1] ?? values[i]) - values[i]) * Math.min(1, Math.max(0, t));
}

/** Position on a path at distance d (with optional lateral offset to the right). */
export function pointAt(path: { pts: XZ[]; heights: number[]; dist: number[] }, d: number, offset: number, out: THREE.Vector3, dir: THREE.Vector3) {
  const { pts, dist, heights } = path;
  let lo = 0;
  let hi = dist.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (dist[mid] <= d) lo = mid;
    else hi = mid;
  }
  const a = pts[lo];
  const b = pts[hi];
  const seg = dist[hi] - dist[lo] || 1;
  const t = Math.min(1, Math.max(0, (d - dist[lo]) / seg));
  const dx = (b[0] - a[0]) / seg;
  const dz = (b[1] - a[1]) / seg;
  const y = heights[lo] + (heights[hi] - heights[lo]) * t;
  out.set(a[0] + (b[0] - a[0]) * t - dz * offset, y, a[1] + (b[1] - a[1]) * t + dx * offset);
  dir.set(dx, (heights[hi] - heights[lo]) / seg, dz).normalize();
}
