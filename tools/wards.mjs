#!/usr/bin/env node
// Ward (phường/xã) boundaries for the offline download picker (#18), from Overture divisions
// (OSM-derived, after the 2025 administrative reform). Writes public/wards/<city>.json.
//
//   node tools/wards.mjs            # TP.HCM + Hà Nội
//
// division_area features are clipped per tile, so pieces of one ward are unioned again here.
import { VectorTile } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';
import { PMTiles } from 'pmtiles';
import polygonClipping from 'polygon-clipping';
import { mkdirSync, writeFileSync } from 'node:fs';

const RELEASE = '2026-10-21.0';
const Z = 10; // localities appear from z10
const CITIES = [
  { id: 'hcm', name: 'TP. Hồ Chí Minh', region: 'VN-SG', bbox: { west: 106.3, east: 107.65, south: 10.25, north: 11.6 } },
  { id: 'hn', name: 'Hà Nội', region: 'VN-HN', bbox: { west: 105.25, east: 106.05, south: 20.5, north: 21.42 } },
];

const pm = new PMTiles(`https://tiles.overturemaps.org/${RELEASE}/divisions.pmtiles`);
const tx = (lon) => Math.floor(((lon + 180) / 360) * 2 ** Z);
const ty = (lat) => {
  const r = (lat * Math.PI) / 180;
  return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** Z);
};

/** Douglas–Peucker on one ring (degrees; tolerance ≈ 6 m). */
function simplify(ring, tol = 0.00006) {
  if (ring.length < 5) return ring;
  const keep = new Uint8Array(ring.length);
  // Closed ring: first = last, so split at the point farthest from the start.
  let far = 1;
  for (let i = 1; i < ring.length - 1; i++) if (Math.hypot(ring[i][0] - ring[0][0], ring[i][1] - ring[0][1]) > Math.hypot(ring[far][0] - ring[0][0], ring[far][1] - ring[0][1])) far = i;
  keep[0] = keep[far] = keep[ring.length - 1] = 1;
  const stack = [[0, far], [far, ring.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const [ax, ay] = ring[a], [bx, by] = ring[b];
    const dx = bx - ax, dy = by - ay, L = Math.hypot(dx, dy) || 1e-12;
    let best = -1, bi = -1;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs((ring[i][0] - ax) * dy - (ring[i][1] - ay) * dx) / L;
      if (d > best) (best = d), (bi = i);
    }
    if (best > tol) {
      keep[bi] = 1;
      stack.push([a, bi], [bi, b]);
    }
  }
  return ring.filter((_, i) => keep[i]);
}

const r5 = (v) => Math.round(v * 1e5) / 1e5;

for (const city of CITIES) {
  const pieces = new Map(); // division_id → { name, polys: MultiPolygon pieces }
  const { bbox } = city;
  for (let x = tx(bbox.west); x <= tx(bbox.east); x++) {
    for (let y = ty(bbox.north); y <= ty(bbox.south); y++) {
      const t = await pm.getZxy(Z, x, y);
      if (!t) continue;
      const layer = new VectorTile(new PbfReader(new Uint8Array(t.data))).layers.division_area;
      if (!layer) continue;
      for (let i = 0; i < layer.length; i++) {
        const f = layer.feature(i);
        const p = f.properties;
        if (p.subtype !== 'locality' || p.region !== city.region || p.class !== 'land') continue;
        const g = f.toGeoJSON(x, y, Z).geometry;
        const polys = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
        const id = String(p.division_id);
        const e = pieces.get(id) ?? { name: String(p['@name']), polys: [] };
        e.polys.push(...polys);
        pieces.set(id, e);
      }
      process.stderr.write(`\r${city.id} ${x},${y}: ${pieces.size} wards   `);
    }
  }
  process.stderr.write('\n');
  const wards = [];
  for (const [id, { name, polys }] of pieces) {
    const merged = polygonClipping.union(...polys.map((p) => [p]));
    const multi = merged
      .map((poly) => poly.map((ring) => simplify(ring).map(([lo, la]) => [r5(lo), r5(la)])).filter((r) => r.length >= 4))
      .filter((poly) => poly.length);
    if (!multi.length) continue;
    let west = 180, east = -180, south = 90, north = -90;
    for (const poly of multi) for (const [lo, la] of poly[0]) {
      west = Math.min(west, lo); east = Math.max(east, lo); south = Math.min(south, la); north = Math.max(north, la);
    }
    const kind = name.startsWith('Phường') ? 'phuong' : name.startsWith('Xã') ? 'xa' : 'khac';
    wards.push({ id, name, kind, bbox: { south, west, north, east }, polygon: multi });
  }
  wards.sort((a, b) => a.name.localeCompare(b.name, 'vi'));
  mkdirSync('public/wards', { recursive: true });
  const out = { city: city.id, name: city.name, source: `Overture Maps ${RELEASE} (OpenStreetMap, ODbL)`, wards };
  writeFileSync(`public/wards/${city.id}.json`, JSON.stringify(out));
  const n = wards.filter((w) => w.kind === 'phuong').length;
  console.log(`${city.id}: ${wards.length} đơn vị (${n} phường)`);
}
