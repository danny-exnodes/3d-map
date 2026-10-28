import * as THREE from 'three';
import { rng } from '../data/rand';
import type { AreaFeature, CityData } from '../data/types';
import { bboxSizeMeters, pointInRing, type LocalProjection } from '../geo/projection';
import { mergeGeometries, mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { flatPolygon, merge, MeshBuilder, ribbon, sampleAlong, type XZ } from './geometry';
import type { RoadPath } from './roads';
import type { SpatialGrid } from './spatial';
import { TOY_GRASS, TOY_GROUND, TOY_TREES, TOY_WATER } from './toyPalette';

const AREA_COLORS: Record<AreaFeature['kind'], string> = {
  water: TOY_WATER,
  park: TOY_GRASS,
  grass: TOY_GRASS,
  forest: TOY_TREES[2],
  plaza: '#e2d8c2',
  parking: '#b9b4aa',
};
export const GROUND_COLOR = TOY_GROUND;

export interface LandscapeResult {
  group: THREE.Group;
  water: THREE.Mesh | null;
  treeCount: number;
  lamps: THREE.InstancedMesh | null;
  lampBulbs: THREE.InstancedMesh | null;
}

export function buildLandscape(
  data: CityData,
  proj: LocalProjection,
  roads: RoadPath[],
  footprints: SpatialGrid<XZ[]>,
  lampSpots: number[][],
): LandscapeResult {
  const group = new THREE.Group();
  group.name = 'landscape';
  const { width, depth } = bboxSizeMeters(data.bbox);

  // Ground slab with a little thickness so the model reads as a "tiny" diorama.
  const slab = new THREE.Mesh(
    new THREE.BoxGeometry(width, 6, depth).translate(0, -3.01, 0),
    [
      ...Array(2).fill(new THREE.MeshLambertMaterial({ color: '#b9a98a' })),
      new THREE.MeshLambertMaterial({ color: GROUND_COLOR, depthWrite: false }),
      ...Array(3).fill(new THREE.MeshLambertMaterial({ color: '#b9a98a' })),
    ],
  );
  slab.renderOrder = -10;
  slab.receiveShadow = true;
  slab.name = 'ground';
  group.add(slab);

  // Areas: green first, water on top.
  const greens: THREE.BufferGeometry[] = [];
  const waters: THREE.BufferGeometry[] = [];
  const parkRings: XZ[][] = [];
  for (const a of data.areas) {
    const rings = a.polygon.map((r) => r.map((p) => proj.project(p)));
    const g = flatPolygon(rings, 0, AREA_COLORS[a.kind]);
    if (!g) continue;
    (a.kind === 'water' ? waters : greens).push(g);
    if (a.kind === 'park' || a.kind === 'forest') parkRings.push(rings[0]);
  }
  const wb = new MeshBuilder().setColor(AREA_COLORS.water);
  for (const w of data.waterways) {
    const pts = w.line.map((p) => proj.project(p));
    ribbon(wb, pts, pts.map(() => 0), w.width);
  }
  if (!wb.empty) waters.push(wb.build());

  const greenGeo = merge(greens);
  if (greenGeo) {
    const m = new THREE.Mesh(greenGeo, new THREE.MeshLambertMaterial({ vertexColors: true, depthWrite: false }));
    m.renderOrder = -9;
    m.receiveShadow = true;
    m.name = 'greens';
    group.add(m);
  }
  let water: THREE.Mesh | null = null;
  const waterGeo = merge(waters);
  if (waterGeo) {
    water = new THREE.Mesh(
      waterGeo,
      new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.15, metalness: 0.1, depthWrite: false }),
    );
    water.renderOrder = -8;
    water.receiveShadow = true;
    water.name = 'water';
    group.add(water);
  }

  // Trees: OSM trees + rows along roads + scatter in parks.
  const r = rng(1234);
  const spots: [number, number, number][] = [];
  const free = (x: number, z: number, margin = 1.5) =>
    Math.abs(x) < width / 2 - 2 && Math.abs(z) < depth / 2 - 2 && !footprints.contains(x, z, margin);
  const onRoad = roadMask(roads);
  for (const t of data.trees) {
    const [x, z] = proj.project(t);
    if (free(x, z, 0)) spots.push([x, z, 0.8 + r() * 0.6]);
  }
  for (const p of roads) {
    const c = p.road.cls;
    if (c === 'path' || c === 'service' || p.heights.some((h) => h > 0.5)) continue;
    const step = c === 'residential' ? 16 : 12;
    sampleAlong(p.pts, step, (x, z, dx, dz) => {
      for (const side of [-1, 1]) {
        if (r() < 0.25) continue;
        const off = side * (p.road.width / 2 + 1.6);
        const tx = x - dz * off;
        const tz = z + dx * off;
        if (free(tx, tz) && !onRoad(tx, tz)) spots.push([tx, tz, 0.7 + r() * 0.5]);
      }
    });
  }
  const bushSpots: [number, number, number][] = [];
  for (const ring of parkRings) {
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const [x, z] of ring) {
      minX = Math.min(minX, x); maxX = Math.max(maxX, x); minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
    }
    const n = Math.min(400, ((maxX - minX) * (maxZ - minZ)) / 120);
    for (let i = 0; i < n; i++) {
      const x = minX + r() * (maxX - minX);
      const z = minZ + r() * (maxZ - minZ);
      if (pointInRing(x, z, ring) && free(x, z) && !onRoad(x, z)) spots.push([x, z, 0.8 + r() * 0.7]);
    }
    // One bush per 60 m² of park, 300 at most in all.
    const nb = Math.min(BUSH_CAP - bushSpots.length, Math.floor(ringArea(ring) / 60));
    for (let i = 0, tries = 0; i < nb && tries < nb * 4; tries++) {
      const x = minX + r() * (maxX - minX);
      const z = minZ + r() * (maxZ - minZ);
      if (pointInRing(x, z, ring) && free(x, z) && !onRoad(x, z)) {
        bushSpots.push([x, z, 0.35 + r() * 0.15]);
        i++;
      }
    }
  }
  const trees = buildTrees(spots, bushSpots, r);
  if (trees) group.add(trees);

  // Street lamps: thin posts plus emissive bulbs that only show at night.
  let lamps: THREE.InstancedMesh | null = null;
  let lampBulbs: THREE.InstancedMesh | null = null;
  const lampList = lampSpots.filter(([x, , z]) => Math.abs(x) < width / 2 && Math.abs(z) < depth / 2 && !footprints.contains(x, z, 0));
  if (lampList.length) {
    // Post, arm and head in one geometry; the arm points along +x and each lamp is turned towards the carriageway.
    const post = mergeGeometries([
      new THREE.CylinderGeometry(0.2, 0.26, 6, 6, 1, true).translate(0, 3, 0),
      new THREE.CylinderGeometry(0.1, 0.1, 1.2, 4, 1, true).rotateZ(Math.PI / 2).translate(0.6, 6, 0),
      new THREE.SphereGeometry(0.45, 6, 4).translate(1.2, 6, 0),
    ])!;
    const bulb = new THREE.SphereGeometry(0.5, 8, 6);
    lamps = new THREE.InstancedMesh(post, new THREE.MeshLambertMaterial({ color: '#55585f' }), lampList.length);
    lampBulbs = new THREE.InstancedMesh(bulb, new THREE.MeshBasicMaterial({ color: new THREE.Color(4, 2.8, 1.4), toneMapped: false }), lampList.length);
    const m = new THREE.Matrix4();
    // Spots store travel direction × side; (oz, -ox) points back towards the carriageway.
    lampList.forEach(([x, y, z, ox, oz], i) => {
      lamps!.setMatrixAt(i, m.makeRotationY(Math.atan2(ox, oz)).setPosition(x, y, z));
      lampBulbs!.setMatrixAt(i, m.makeTranslation(x + oz * 1.2, y + 6, z - ox * 1.2));
    });
    lamps.name = 'lamps';
    lampBulbs.name = 'lampBulbs';
    lampBulbs.visible = false;
    group.add(lamps, lampBulbs);
  }

  return { group, water, treeCount: spots.length, lamps, lampBulbs };
}

/** Coarse raster of road surfaces so trees are not planted on the carriageway. */
function roadMask(roads: RoadPath[]): (x: number, z: number) => boolean {
  const cell = 2;
  const set = new Set<string>();
  for (const p of roads) {
    if (p.heights.some((h) => h > 0.5)) continue;
    const half = p.road.width / 2;
    sampleAlong(p.pts, cell, (x, z, dx, dz) => {
      for (let o = -half; o <= half; o += cell) {
        set.add(`${Math.round((x - dz * o) / cell)},${Math.round((z + dx * o) / cell)}`);
      }
    }, 0);
  }
  return (x, z) => set.has(`${Math.round(x / cell)},${Math.round(z / cell)}`);
}

const BUSH_CAP = 300;

function ringArea(ring: XZ[]): number {
  let a = 0;
  for (let i = 0; i < ring.length; i++) {
    const [x1, z1] = ring[i];
    const [x2, z2] = ring[(i + 1) % ring.length];
    a += x1 * z2 - x2 * z1;
  }
  return Math.abs(a) / 2;
}

/** Smooth-shaded 20-triangle blob: merged vertices let vertex normals round the icosahedron. */
function toyCrown(): THREE.BufferGeometry {
  const ico = new THREE.IcosahedronGeometry(2.2, 0);
  ico.deleteAttribute('normal');
  ico.deleteAttribute('uv');
  const g = mergeVertices(ico);
  g.computeVertexNormals();
  return g.translate(0, 3.4, 0);
}

function buildTrees(spots: [number, number, number][], bushes: [number, number, number][], r: () => number): THREE.Group | null {
  if (!spots.length) return null;
  const g = new THREE.Group();
  g.name = 'trees';
  const crown = toyCrown();
  const trunk = new THREE.CylinderGeometry(0.4, 0.5, 1.6, 6, 1, true).translate(0, 0.8, 0);
  const crowns = new THREE.InstancedMesh(crown, new THREE.MeshLambertMaterial(), spots.length + bushes.length);
  const trunks = new THREE.InstancedMesh(trunk, new THREE.MeshLambertMaterial({ color: '#7a5a3c' }), spots.length);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const s = new THREE.Vector3();
  const p = new THREE.Vector3();
  const greens = TOY_TREES.map((c) => new THREE.Color(c));
  spots.forEach(([x, z, k], i) => {
    q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), r() * Math.PI * 2);
    s.set(k, k * (0.9 + r() * 0.3), k);
    p.set(x, 0, z);
    m.compose(p, q, s);
    crowns.setMatrixAt(i, m);
    trunks.setMatrixAt(i, m);
    crowns.setColorAt(i, greens[Math.floor(r() * greens.length)]);
  });
  // Bushes: small crowns sitting on the ground, no trunk.
  bushes.forEach(([x, z, k], j) => {
    q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), r() * Math.PI * 2);
    s.set(k, k, k);
    p.set(x, 0.4 - 1.53 * k, z);
    m.compose(p, q, s);
    crowns.setMatrixAt(spots.length + j, m);
    crowns.setColorAt(spots.length + j, greens[Math.floor(r() * greens.length)]);
  });
  crowns.name = 'crowns';
  trunks.name = 'trunks';
  crowns.castShadow = trunks.castShadow = true;
  crowns.receiveShadow = true;
  g.add(trunks, crowns);
  return g;
}
