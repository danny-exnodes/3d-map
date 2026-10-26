import { LocalProjection } from '../geo/projection';
import { FACADE_COLORS, ROOF_COLORS } from './osm';
import { pick, rng } from './rand';
import type { BBox, Building, CityData, LngLat, Road, RoadClass } from './types';

/**
 * Procedurally generated neighbourhood used when no network is available
 * (offline demo, tests, screenshots). Layout: a river crossing diagonally,
 * a curved elevated metro line, two arterial roads with a flyover and a dense
 * grid of tube houses.
 */
export function generateDemoCity(bbox: BBox, seed = 7): CityData {
  const proj = new LocalProjection(bbox);
  const r = rng(seed);
  const [x0, z0] = proj.project([bbox.west, bbox.north]);
  const [x1, z1] = proj.project([bbox.east, bbox.south]);
  const ll = (x: number, z: number): LngLat => proj.unproject(x, z);
  const W = x1 - x0;
  const D = z1 - z0;

  const roads: Road[] = [];
  let rid = 0;
  const addRoad = (pts: [number, number][], cls: RoadClass, lanes: number, extra: Partial<Road> = {}) =>
    roads.push({
      id: `demo/road/${rid++}`, line: pts.map(([x, z]) => ll(x, z)), cls, lanes,
      width: lanes * 3.3 + 1, oneway: false, layer: 0, bridge: false, tunnel: false, ...extra,
    });

  // River: gentle S-curve from north-west to south-east.
  const river: [number, number][] = [];
  for (let i = 0; i <= 40; i++) {
    const t = i / 40;
    river.push([x0 + t * W, z0 + D * (0.15 + 0.7 * t) + Math.sin(t * Math.PI * 2) * 40]);
  }
  const riverWidth = 34;

  // Arterials crossing at the centre.
  addRoad([[x0, 0], [x1, 0]], 'primary', 6, { name: 'Đường Trường Chinh' });
  addRoad([[x0 + W * 0.1, z1], [x1 - W * 0.1, z0]], 'primary', 6, { name: 'Đường Láng' });
  // Flyover over the east arm.
  addRoad([[-W * 0.05, -6], [W * 0.42, -6]], 'motorway', 4, { layer: 1, bridge: true, oneway: true });

  // Residential grid.
  const step = 70;
  for (let x = x0 + 35; x < x1; x += step) addRoad([[x, z0], [x, z1]], 'residential', 2);
  for (let z = z0 + 35; z < z1; z += step) addRoad([[x0, z], [x1, z]], 'residential', 2);

  // Bridges across the river for the arterials happen naturally (roads drawn over water).

  const distToPolyline = (x: number, z: number, line: [number, number][]) => {
    let best = Infinity;
    for (let i = 1; i < line.length; i++) best = Math.min(best, segDist(x, z, line[i - 1], line[i]));
    return best;
  };
  const roadLines = roads.map((rd) => ({ pts: rd.line.map((p) => proj.project(p)), w: rd.width }));

  // Elevated metro: arc on the west side.
  const metro: [number, number][] = [];
  for (let i = 0; i <= 30; i++) {
    const a = -Math.PI / 2 + (i / 30) * Math.PI * 0.9;
    metro.push([x0 + W * 0.18 + Math.cos(a) * W * 0.25, Math.sin(a) * D * 0.55]);
  }

  const buildings: Building[] = [];
  const trees: LngLat[] = [];
  let bid = 0;
  let w = 0;
  for (let x = x0 + 4; x < x1 - 4; x += w + 0.6 + r() * 1.5) {
    w = 5 + r() * 7;
    let d = 0;
    for (let z = z0 + 4; z < z1 - 4; z += d + 0.6 + r() * 2) {
      d = 8 + r() * 12;
      const cx = x + w / 2;
      const cz = z + d / 2;
      const clearance = Math.max(w, d) / 2 + 3;
      if (distToPolyline(cx, cz, river) < riverWidth / 2 + 14) {
        if (r() < 0.35) trees.push(ll(cx, cz));
        continue;
      }
      if (distToPolyline(cx, cz, metro) < 10) continue;
      if (roadLines.some((l) => distToPolyline(cx, cz, l.pts) < l.w / 2 + clearance)) continue;
      if (r() < 0.12) {
        trees.push(ll(cx, cz));
        continue;
      }
      const tower = r() < 0.015;
      const levels = tower ? 18 + Math.floor(r() * 20) : 2 + Math.floor(r() * r() * 7);
      const ring: LngLat[] = [ll(x, z), ll(x + w, z), ll(x + w, z + d), ll(x, z + d)];
      const roof: Building['roof'] = !tower && levels <= 3 && r() < 0.5 ? (r() < 0.5 ? 'gabled' : 'hipped') : 'flat';
      buildings.push({
        id: `demo/b/${bid++}`,
        polygon: [ring],
        height: levels * 3.3,
        minHeight: 0,
        kind: tower ? 'office' : 'house',
        roof,
        color: tower ? pick(r, ['#5b7fa6', '#e8d98a', '#9fb6c9']) : pick(r, FACADE_COLORS),
        roofColor: roof === 'flat' ? '#d2cbbb' : pick(r, ROOF_COLORS),
      });
    }
  }

  // Row of trees along the river banks.
  for (let i = 0; i < river.length - 1; i++) {
    const [ax, az] = river[i];
    const [bx, bz] = river[i + 1];
    const len = Math.hypot(bx - ax, bz - az);
    const nx = -(bz - az) / len;
    const nz = (bx - ax) / len;
    for (let s = 0; s < len; s += 9) {
      const t = s / len;
      const px = ax + (bx - ax) * t;
      const pz = az + (bz - az) * t;
      for (const side of [-1, 1]) {
        const off = side * (riverWidth / 2 + 6);
        trees.push(ll(px + nx * off, pz + nz * off));
      }
    }
  }

  return {
    bbox,
    buildings,
    roads,
    rails: [{ id: 'demo/rail/0', line: metro.map(([x, z]) => ll(x, z)), kind: 'light_rail', layer: 2, bridge: true, tunnel: false }],
    areas: [],
    waterways: [{ id: 'demo/river', line: river.map(([x, z]) => ll(x, z)), width: riverWidth }],
    trees,
    pois: [{ id: 'demo/poi', pos: ll(W * 0.3, -D * 0.3), name: 'Chùa Phúc Khánh', kind: 'place_of_worship' }],
    source: 'Demo (offline)',
  };
}

function segDist(px: number, pz: number, a: [number, number], b: [number, number]): number {
  const dx = b[0] - a[0];
  const dz = b[1] - a[1];
  const l2 = dx * dx + dz * dz || 1;
  const t = Math.max(0, Math.min(1, ((px - a[0]) * dx + (pz - a[1]) * dz) / l2));
  return Math.hypot(px - (a[0] + t * dx), pz - (a[1] + t * dz));
}
