import * as THREE from 'three';
import { rng } from '../data/rand';
import type { AreaFeature, CityData } from '../data/types';
import { bboxSizeMeters, pointInRing, type LocalProjection } from '../geo/projection';
import { flatPolygon, merge, MeshBuilder, ribbon, sampleAlong, type XZ } from './geometry';
import type { RoadPath } from './roads';
import type { SpatialGrid } from './spatial';

const AREA_COLORS: Record<AreaFeature['kind'], string> = {
  water: '#5fa8d8',
  park: '#8cc66b',
  grass: '#9fd07a',
  forest: '#6aa752',
  plaza: '#e2d8c2',
  parking: '#b9b4aa',
};
export const GROUND_COLOR = '#e8dcc0';

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
  }
  const trees = buildTrees(spots, r);
  if (trees) group.add(trees);

  // Street lamps: thin posts plus emissive bulbs that only show at night.
  let lamps: THREE.InstancedMesh | null = null;
  let lampBulbs: THREE.InstancedMesh | null = null;
  const lampList = lampSpots.filter(([x, , z]) => Math.abs(x) < width / 2 && Math.abs(z) < depth / 2 && !footprints.contains(x, z, 0));
  if (lampList.length) {
    const post = new THREE.CylinderGeometry(0.08, 0.1, 6, 5).translate(0, 3, 0);
    const bulb = new THREE.SphereGeometry(0.35, 6, 4);
    lamps = new THREE.InstancedMesh(post, new THREE.MeshLambertMaterial({ color: '#55585f' }), lampList.length);
    lampBulbs = new THREE.InstancedMesh(bulb, new THREE.MeshBasicMaterial({ color: new THREE.Color(4, 2.8, 1.4), toneMapped: false }), lampList.length);
    const m = new THREE.Matrix4();
    // Spots store travel direction × side; (oz, -ox) points back towards the carriageway.
    lampList.forEach(([x, y, z, ox, oz], i) => {
      lamps!.setMatrixAt(i, m.makeTranslation(x, y, z));
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

function buildTrees(spots: [number, number, number][], r: () => number): THREE.Group | null {
  if (!spots.length) return null;
  const g = new THREE.Group();
  g.name = 'trees';
  const crown = new THREE.IcosahedronGeometry(1.9, 0).translate(0, 4.2, 0);
  const trunk = new THREE.CylinderGeometry(0.18, 0.25, 2.8, 5).translate(0, 1.4, 0);
  const crowns = new THREE.InstancedMesh(crown, new THREE.MeshLambertMaterial({ flatShading: true }), spots.length);
  const trunks = new THREE.InstancedMesh(trunk, new THREE.MeshLambertMaterial({ color: '#7a5a3c' }), spots.length);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const s = new THREE.Vector3();
  const p = new THREE.Vector3();
  const greens = ['#4f9d3a', '#5cae45', '#69b84d', '#3f8a35', '#78c25a'].map((c) => new THREE.Color(c));
  spots.forEach(([x, z, k], i) => {
    q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), r() * Math.PI * 2);
    s.set(k, k * (0.9 + r() * 0.3), k);
    p.set(x, 0, z);
    m.compose(p, q, s);
    crowns.setMatrixAt(i, m);
    trunks.setMatrixAt(i, m);
    crowns.setColorAt(i, greens[Math.floor(r() * greens.length)]);
  });
  crowns.castShadow = trunks.castShadow = true;
  crowns.receiveShadow = true;
  g.add(trunks, crowns);
  return g;
}
