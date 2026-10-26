import { LocalProjection, pointInRing } from '../geo/projection';
import { LEVEL_H, makeBuilding } from './buildings';
import type { HeightGrid } from './heights';
import { hashString, rng } from './rand';
import type { BBox, Building, CityData, LngLat, Road } from './types';

type XZ = [number, number];

/**
 * Fills the gaps between known footprints from the Google 2.5D raster (#16).
 *
 * In dense Vietnamese neighbourhoods OSM and the ML footprint datasets miss most row houses
 * (Én Nam: footprints covered 37 % of the area the raster marks as built). This turns the
 * uncovered built cells into buildings, and splits long blocks into 4–6 m tube-house lots whose
 * heights come from the raster, so a row reads as individual houses of varying height.
 */
export interface SynthResult {
  added: number;
  split: number;
  lots: number;
}

const MIN_H = 2.5;

interface Raster {
  w: number;
  d: number;
  cell: number;
  h: Float32Array; // metres, 0 = empty
  /** grid cell centre → local x/z of the grid projection */
  proj: LocalProjection;
}

function rasterOf(grid: HeightGrid): Raster {
  const { width: w, depth: d, cell } = grid.meta;
  const h = new Float32Array(w * d);
  for (let i = 0; i < h.length; i++) h[i] = grid.data[i] / 10;
  return { w, d, cell, h, proj: new LocalProjection(grid.meta.bbox) };
}

const cellOf = (r: Raster, x: number, z: number): [number, number] => [Math.floor((x + (r.w * r.cell) / 2) / r.cell), Math.floor((z + (r.d * r.cell) / 2) / r.cell)];
const centreOf = (r: Raster, i: number, j: number): XZ => [(i + 0.5) * r.cell - (r.w * r.cell) / 2, (j + 0.5) * r.cell - (r.d * r.cell) / 2];

/** Scanline-fills a ring (local metres) into a mask. */
function fillRing(r: Raster, ring: XZ[], mask: Uint8Array, value = 1) {
  let z0 = Infinity, z1 = -Infinity;
  for (const [, z] of ring) { z0 = Math.min(z0, z); z1 = Math.max(z1, z); }
  const [, j0] = cellOf(r, 0, z0);
  const [, j1] = cellOf(r, 0, z1);
  for (let j = Math.max(0, j0); j <= Math.min(r.d - 1, j1); j++) {
    const zc = centreOf(r, 0, j)[1];
    const xs: number[] = [];
    for (let a = 0, b = ring.length - 1; a < ring.length; b = a++) {
      const [xa, za] = ring[a], [xb, zb] = ring[b];
      if ((za > zc) !== (zb > zc)) xs.push(xa + ((zc - za) / (zb - za)) * (xb - xa));
    }
    xs.sort((p, q) => p - q);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const [i0] = cellOf(r, xs[k], zc);
      const [i1] = cellOf(r, xs[k + 1], zc);
      for (let i = Math.max(0, i0); i <= Math.min(r.w - 1, i1); i++) mask[j * r.w + i] = value;
    }
  }
}

/** Minimum-area rectangle of points (rotating calipers on the hull). */
function obb(points: XZ[]): { c: XZ; u: XZ; v: XZ; L: number; W: number; area: number } | null {
  const hull = convexHull(points);
  if (hull.length < 3) return null;
  let best: { c: XZ; u: XZ; v: XZ; L: number; W: number; area: number } | null = null;
  for (let k = 0; k < hull.length; k++) {
    const a = hull[k], b = hull[(k + 1) % hull.length];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len < 1e-6) continue;
    const ux = (b[0] - a[0]) / len, uz = (b[1] - a[1]) / len;
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    for (const [x, z] of hull) {
      const u = x * ux + z * uz, v = -x * uz + z * ux;
      u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v);
    }
    const area = (u1 - u0) * (v1 - v0);
    if (!best || area < best.area) {
      const cu = (u0 + u1) / 2, cv = (v0 + v1) / 2;
      const long = u1 - u0 >= v1 - v0;
      const U: XZ = long ? [ux, uz] : [-uz, ux];
      const Vv: XZ = long ? [-uz, ux] : [-ux, -uz];
      best = { c: [cu * ux - cv * uz, cu * uz + cv * ux], u: U, v: Vv, L: Math.max(u1 - u0, v1 - v0), W: Math.min(u1 - u0, v1 - v0), area };
    }
  }
  return best;
}

function convexHull(points: XZ[]): XZ[] {
  const p = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const cross = (o: XZ, a: XZ, b: XZ) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo: XZ[] = [], up: XZ[] = [];
  for (const q of p) { while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); }
  for (let i = p.length - 1; i >= 0; i--) { const q = p[i]; while (up.length >= 2 && cross(up[up.length - 2], up[up.length - 1], q) <= 0) up.pop(); up.push(q); }
  return lo.slice(0, -1).concat(up.slice(0, -1));
}

const rectCorners = (c: XZ, u: XZ, v: XZ, a0: number, a1: number, b0: number, b1: number): XZ[] => [
  [c[0] + u[0] * a0 + v[0] * b0, c[1] + u[1] * a0 + v[1] * b0],
  [c[0] + u[0] * a1 + v[0] * b0, c[1] + u[1] * a1 + v[1] * b0],
  [c[0] + u[0] * a1 + v[0] * b1, c[1] + u[1] * a1 + v[1] * b1],
  [c[0] + u[0] * a0 + v[0] * b1, c[1] + u[1] * a0 + v[1] * b1],
];

interface Lot {
  ring: XZ[];
  height: number;
}

/**
 * Tiles a rectangle into lots: rows ~15 m deep across the short side, lots 4–6.5 m wide along
 * the long side. A lot is kept when `accept` covers at least 45 % of it; its height is the median
 * raster height under it.
 */
function tileLots(r: Raster, box: NonNullable<ReturnType<typeof obb>>, seed: number, accept: (i: number, j: number) => boolean): Lot[] {
  const rand = rng(seed);
  const rows = box.W <= 25 ? 1 : Math.max(1, Math.round(box.W / 15));
  const depth = box.W / rows;
  const out: Lot[] = [];
  for (let row = 0; row < rows; row++) {
    const b0 = -box.W / 2 + row * depth, b1 = b0 + depth;
    let a = -box.L / 2;
    while (a < box.L / 2 - 1.5) {
      let wLot = 4 + rand() * 2.5;
      if (box.L / 2 - (a + wLot) < 3) wLot = box.L / 2 - a; // absorb a thin remainder
      const a1 = a + wLot;
      // Sample the lot every metre.
      let hit = 0, total = 0;
      const hs: number[] = [];
      for (let s = a + 0.5; s < a1; s += 1)
        for (let t = b0 + 0.5; t < b1; t += 1) {
          const x = box.c[0] + box.u[0] * s + box.v[0] * t, z = box.c[1] + box.u[1] * s + box.v[1] * t;
          const [i, j] = cellOf(r, x, z);
          total++;
          if (i < 0 || j < 0 || i >= r.w || j >= r.d || !accept(i, j)) continue;
          hit++;
          const h = r.h[j * r.w + i];
          if (h > 0) hs.push(h);
        }
      if (total && hit / total >= 0.45 && hs.length) {
        hs.sort((p, q) => p - q);
        const h = hs[Math.floor(hs.length / 2)];
        if (h >= MIN_H) out.push({ ring: rectCorners(box.c, box.u, box.v, a, a1, b0, b1), height: h });
      }
      a = a1;
    }
  }
  return out;
}

/** Distance from a point to the nearest road centreline, minus half the road width. */
function roadClearance(roads: { pts: XZ[]; half: number }[]) {
  const cell = 25;
  const grid = new Map<string, { a: XZ; b: XZ; half: number }[]>();
  for (const rd of roads)
    for (let k = 1; k < rd.pts.length; k++) {
      const a = rd.pts[k - 1], b = rd.pts[k];
      const i0 = Math.floor(Math.min(a[0], b[0]) / cell), i1 = Math.floor(Math.max(a[0], b[0]) / cell);
      const j0 = Math.floor(Math.min(a[1], b[1]) / cell), j1 = Math.floor(Math.max(a[1], b[1]) / cell);
      for (let i = i0; i <= i1; i++)
        for (let j = j0; j <= j1; j++) {
          const key = `${i},${j}`;
          let l = grid.get(key);
          if (!l) grid.set(key, (l = []));
          l.push({ a, b, half: rd.half });
        }
    }
  return (x: number, z: number) => {
    let best = Infinity;
    const ci = Math.floor(x / cell), cj = Math.floor(z / cell);
    for (let i = ci - 1; i <= ci + 1; i++)
      for (let j = cj - 1; j <= cj + 1; j++)
        for (const s of grid.get(`${i},${j}`) ?? []) {
          const dx = s.b[0] - s.a[0], dz = s.b[1] - s.a[1];
          const l2 = dx * dx + dz * dz || 1;
          const t = Math.max(0, Math.min(1, ((x - s.a[0]) * dx + (z - s.a[1]) * dz) / l2));
          best = Math.min(best, Math.hypot(x - (s.a[0] + t * dx), z - (s.a[1] + t * dz)) - s.half);
        }
    return best;
  };
}

function lotBuilding(id: string, ring: XZ[], h: number, proj: LocalProjection, footprintSource: Building['footprintSource']): Building {
  const polygon = [ring.map(([x, z]) => proj.unproject(x, z) as LngLat)];
  const b = makeBuilding({
    id,
    polygon,
    kind: 'house',
    tags: {},
    footprintSource,
    height: h,
    heightSource: 'gob',
    levels: Math.max(1, Math.round(h / LEVEL_H)),
  });
  b.lot = true;
  return b;
}

const inBox = (b: BBox, p: LngLat) => p[0] >= b.west && p[0] <= b.east && p[1] >= b.south && p[1] <= b.north;

export function synthesizeFromGrid(data: CityData, grid: HeightGrid): SynthResult {
  const r = rasterOf(grid);
  const res: SynthResult = { added: 0, split: 0, lots: 0 };
  const toXZ = (ring: LngLat[]) => ring.map((p) => r.proj.project(p));

  // 1. Split row blocks from the ML footprint datasets into lots (OSM outlines are kept as drawn).
  const keep: Building[] = [];
  for (const b of data.buildings) {
    const ring = toXZ(b.polygon[0]);
    const box = b.footprintSource === 'overture' && !b.isPart && b.polygon.length === 1 ? obb(ring) : null;
    const area = Math.abs(ring.reduce((a, p, i) => a + p[0] * ring[(i + 1) % ring.length][1] - ring[(i + 1) % ring.length][0] * p[1], 0) / 2);
    const splittable = box && area / box.area > 0.8 && box.W >= 6 && box.W <= 25 && box.L > 10 && b.height < 25 && b.archetype !== 'industrial';
    if (!splittable) {
      keep.push(b);
      continue;
    }
    const inside = (i: number, j: number) => pointInRing(...centreOf(r, i, j), ring);
    const lots = tileLots(r, box, hashString(b.id), inside);
    if (lots.length < 2) {
      keep.push(b);
      continue;
    }
    lots.forEach((l, k) => keep.push(lotBuilding(`${b.id}/lot${k}`, l.ring, l.height, r.proj, b.footprintSource)));
    res.split++;
    res.lots += lots.length;
  }
  data.buildings = keep;

  // 2. Built raster cells not covered by any footprint → new buildings.
  const covered = new Uint8Array(r.w * r.d);
  for (const b of data.buildings) fillRing(r, toXZ(b.polygon[0]), covered);
  // No margin around known footprints: row houses share walls, so the neighbour of a known
  // house is usually another house.
  const blocked = covered;
  // Alleys (hẻm) are 2–4 m wide in reality, much narrower than the default lane-based width, so
  // minor roads only keep a 2 m strip clear; arterials keep their full carriageway.
  const minor = new Set(['residential', 'service']);
  const clear = roadClearance(
    data.roads
      .filter((rd: Road) => rd.cls !== 'path')
      .map((rd) => ({ pts: rd.line.map((p) => r.proj.project(p)), half: minor.has(rd.cls) ? Math.min(rd.width / 2, 2) : rd.width / 2 + 0.5 })),
  );
  const candidate = new Uint8Array(r.w * r.d);
  for (let j = 0; j < r.d; j++)
    for (let i = 0; i < r.w; i++) {
      const k = j * r.w + i;
      if (blocked[k] || r.h[k] < MIN_H) continue;
      const c = centreOf(r, i, j);
      if (!inBox(data.bbox, r.proj.unproject(c[0], c[1]))) continue;
      if (clear(c[0], c[1]) < 0) continue;
      candidate[k] = 1;
    }

  const seen = new Uint8Array(r.w * r.d);
  let comp = 0;
  for (let start = 0; start < candidate.length; start++) {
    if (!candidate[start] || seen[start]) continue;
    // Flood fill one component (4-neighbourhood).
    const cells: number[] = [start];
    seen[start] = 1;
    for (let q = 0; q < cells.length; q++) {
      const k = cells[q], i = k % r.w, j = (k - i) / r.w;
      for (const n of [i > 0 ? k - 1 : -1, i < r.w - 1 ? k + 1 : -1, j > 0 ? k - r.w : -1, j < r.d - 1 ? k + r.w : -1])
        if (n >= 0 && candidate[n] && !seen[n]) {
          seen[n] = 1;
          cells.push(n);
        }
    }
    if (cells.length * r.cell * r.cell < 12) continue;
    const pts = cells.map((k) => centreOf(r, k % r.w, Math.floor(k / r.w)));
    // Cell corners give the true extent of the component.
    const corners: XZ[] = [];
    const hc = r.cell / 2;
    for (const [x, z] of pts) corners.push([x - hc, z - hc], [x + hc, z - hc], [x + hc, z + hc], [x - hc, z + hc]);
    const box = obb(corners);
    if (!box) continue;
    const id = `gob/${comp++}`;
    const set = new Set(cells);
    const accept = (i: number, j: number) => set.has(j * r.w + i);
    if (box.W < 6 || box.area < 120) {
      // Small blob: one house filling its rectangle.
      const fill = (cells.length * r.cell * r.cell) / box.area;
      if (fill < 0.35) continue;
      const hs = cells.map((k) => r.h[k]).sort((p, q) => p - q);
      data.buildings.push(lotBuilding(id, rectCorners(box.c, box.u, box.v, -box.L / 2, box.L / 2, -box.W / 2, box.W / 2), hs[Math.floor(hs.length / 2)], r.proj, 'gob'));
      res.added++;
      continue;
    }
    const lots = tileLots(r, box, hashString(id), accept);
    lots.forEach((l, k) => data.buildings.push(lotBuilding(`${id}/${k}`, l.ring, l.height, r.proj, 'gob')));
    res.added += lots.length;
  }
  return res;
}
