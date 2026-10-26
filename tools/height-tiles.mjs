#!/usr/bin/env node
// Building-height tiles (Google Open Buildings 2.5D, CC BY 4.0) on the z14 web-mercator grid,
// covering every phường of TP.HCM and Hà Nội (#18). The app assembles them for any bbox, so
// the static site gets real heights and lot inference (#16) without a server.
//
//   node tools/height-tiles.mjs [--out public/heights/z14] [--cities hcm,hn] [--concurrency 6]
//                               [--budget-min 45] [--limit 10] [--only 13046-7700,…]
//
// Writes <out>/<x>-<y>.bin.gz (uint16le decimetres, 2 m cells, same layout as gob-heights) and
// <out>/index.json. Existing tiles are kept, so an interrupted run resumes (CI caches <out>).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { extractHeightGrid } from './lib/gob.mjs';

const args = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) args[argv[i].slice(2)] = argv[i + 1];
const OUT = args.out ?? 'public/heights/z14';
const CITIES = (args.cities ?? 'hcm,hn').split(',');
const CONCURRENCY = Number(args.concurrency ?? 6);
const DEADLINE = Date.now() + Number(args['budget-min'] ?? 1e6) * 60_000;
const LIMIT = Number(args.limit ?? Infinity);
const ONLY = args.only ? new Set(args.only.split(',')) : null;
const Z = 14;
const CELL = 2;
const N = 2 ** Z;

const tx = (lon) => Math.floor(((lon + 180) / 360) * N);
const ty = (lat) => {
  const r = (lat * Math.PI) / 180;
  return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * N);
};
const lonOf = (x) => (x / N) * 360 - 180;
const latOf = (y) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / N))) * 180) / Math.PI;
export const tileBBox = (x, y) => ({ west: lonOf(x), east: lonOf(x + 1), north: latOf(y), south: latOf(y + 1) });

function inRing(lon, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** z14 tiles touching any phường polygon (a vertex inside the tile, or a tile sample point inside the ward). */
function tilesForWards() {
  const set = new Set();
  for (const city of CITIES) {
    const { wards } = JSON.parse(readFileSync(`public/wards/${city}.json`, 'utf8'));
    for (const w of wards) {
      if (w.kind !== 'phuong') continue;
      for (const poly of w.polygon) for (const [lon, lat] of poly[0]) set.add(`${tx(lon)}-${ty(lat)}`);
      for (let x = tx(w.bbox.west); x <= tx(w.bbox.east); x++) {
        for (let y = ty(w.bbox.north); y <= ty(w.bbox.south); y++) {
          const b = tileBBox(x, y);
          const pts = [];
          for (const fx of [0.1, 0.5, 0.9]) for (const fy of [0.1, 0.5, 0.9]) pts.push([b.west + (b.east - b.west) * fx, b.south + (b.north - b.south) * fy]);
          if (w.polygon.some((poly) => pts.some(([lo, la]) => inRing(lo, la, poly[0])))) set.add(`${x}-${y}`);
        }
      }
    }
  }
  return [...set].sort();
}

mkdirSync(OUT, { recursive: true });
const indexPath = `${OUT}/index.json`;
const index = existsSync(indexPath)
  ? JSON.parse(readFileSync(indexPath, 'utf8'))
  : { z: Z, cell: CELL, encoding: 'uint16le-decimetres+gzip', source: 'Google Open Buildings 2.5D Temporal (2023), CC BY 4.0', tiles: {}, empty: [] };
const empty = new Set(index.empty);
const all = tilesForWards().filter((k) => !ONLY || ONLY.has(k));
const pending = all.filter((k) => !index.tiles[k] && !empty.has(k));
const todo = pending.slice(0, LIMIT);
console.log(`${all.length} tiles for ${CITIES.join('+')}, ${all.length - pending.length} done, ${todo.length} to go`);

let done = 0;
let next = 0;
const save = () => {
  index.empty = [...empty].sort();
  writeFileSync(indexPath, JSON.stringify(index));
};
async function worker() {
  while (next < todo.length && Date.now() < DEADLINE) {
    const key = todo[next++];
    const [x, y] = key.split('-').map(Number);
    try {
      // The bucket occasionally drops connections; retry before giving up on a tile.
      let r;
      for (let attempt = 0; ; attempt++) {
        try {
          r = await extractHeightGrid(tileBBox(x, y), CELL);
          break;
        } catch (e) {
          if (attempt >= 2) throw e;
          await new Promise((ok) => setTimeout(ok, 2000 * (attempt + 1)));
        }
      }
      if (!r || !r.grid.some((v) => v > 0)) empty.add(key);
      else {
        writeFileSync(`${OUT}/${key}.bin.gz`, gzipSync(Buffer.from(r.grid.buffer), { level: 9 }));
        index.tiles[key] = [r.meta.width, r.meta.depth];
      }
    } catch (e) {
      console.warn(`${key}: ${e.message}`);
    }
    if (++done % 10 === 0) {
      save();
      console.log(`${done}/${todo.length}`);
    }
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));
save();
const left = all.filter((k) => !index.tiles[k] && !empty.has(k)).length;
console.log(`${Object.keys(index.tiles).length} tiles with buildings, ${empty.size} empty, ${left} left`);
