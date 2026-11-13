#!/usr/bin/env node
// Real bus routes from GTFS static feeds (#56), converted once into public/transit/<city>.json
// (src/data/transit.ts loads it; no GTFS parsing ships to the browser). Run against an already
// extracted feed directory (routes.txt, trips.txt, shapes.txt, stops.txt) — not a .zip, so this
// stays dependency-free.
//
//   node tools/transit.mjs hn ./gtfs-hanoi \
//     --source "TUMI Data Hub / World Bank" --date 2023-11 --license "CC-BY 4.0" --official
//
//   node tools/transit.mjs hcm ./gtfs-hcmc-enlighteneddata \
//     --source "EnlightenedData (cộng đồng)" --date 2024-01 --license "xem nguồn"
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Minimal GTFS CSV parser: handles quoted fields with commas, not multi-line quoted fields (GTFS never needs them). */
function parseCsv(text) {
  const lines = text.replace(/\r\n/g, '\n').replace(/^﻿/, '').split('\n').filter((l) => l.length);
  const splitRow = (line) => {
    const cells = [];
    let cur = '', inQ = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (inQ) {
        if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
        else if (c === '"') inQ = false;
        else cur += c;
      } else if (c === '"') inQ = true;
      else if (c === ',') { cells.push(cur); cur = ''; }
      else cur += c;
    }
    cells.push(cur);
    return cells.map((c) => c.trim());
  };
  const header = splitRow(lines[0]);
  return lines.slice(1).map((line) => {
    const cells = splitRow(line);
    const row = {};
    header.forEach((h, i) => (row[h] = cells[i] ?? ''));
    return row;
  });
}

function readCsv(dir, name) {
  return parseCsv(readFileSync(join(dir, name), 'utf8'));
}

const [city, dir, ...rest] = process.argv.slice(2);
if (!city || !dir) {
  console.error('Usage: node tools/transit.mjs <hn|hcm> <gtfs-dir> --source "..." --date "YYYY-MM" [--license "..."] [--official]');
  process.exit(1);
}
const opt = { source: 'GTFS', date: new Date().toISOString().slice(0, 7), license: 'xem nguồn', official: false };
for (let i = 0; i < rest.length; i++) {
  const a = rest[i];
  if (a === '--source') opt.source = rest[++i];
  else if (a === '--date') opt.date = rest[++i];
  else if (a === '--license') opt.license = rest[++i];
  else if (a === '--official') opt.official = true;
}

const routes = readCsv(dir, 'routes.txt');
const trips = readCsv(dir, 'trips.txt');
const shapesRaw = readCsv(dir, 'shapes.txt');
const stops = readCsv(dir, 'stops.txt');

const shapePts = new Map(); // shape_id -> [[seq, lon, lat], ...]
for (const r of shapesRaw) {
  const seq = Number(r.shape_pt_sequence) || 0;
  const list = shapePts.get(r.shape_id) ?? [];
  list.push([seq, Number(r.shape_pt_lon), Number(r.shape_pt_lat)]);
  shapePts.set(r.shape_id, list);
}
const shapeOf = (shapeId) =>
  (shapePts.get(shapeId) ?? [])
    .sort((a, b) => a[0] - b[0])
    .map(([, lon, lat]) => [Math.round(lon * 1e5) / 1e5, Math.round(lat * 1e5) / 1e5]);

// One shape per route: the first trip that has one (routes with several branches keep only the longest).
const shapeIdByRoute = new Map();
for (const t of trips) {
  if (!t.shape_id) continue;
  const cur = shapeIdByRoute.get(t.route_id);
  if (!cur || shapePts.get(t.shape_id)?.length > (shapePts.get(cur)?.length ?? 0)) shapeIdByRoute.set(t.route_id, t.shape_id);
}

const outRoutes = routes
  .map((r) => {
    const shapeId = shapeIdByRoute.get(r.route_id);
    const shape = shapeId ? shapeOf(shapeId) : [];
    if (shape.length < 2) return null;
    return {
      id: r.route_id,
      name: r.route_short_name || r.route_long_name || r.route_id,
      color: r.route_color ? `#${r.route_color}` : '#2f6fb3',
      shape,
    };
  })
  .filter(Boolean);

const outStops = stops
  .filter((s) => s.stop_lat && s.stop_lon)
  .map((s) => ({ id: s.stop_id, name: s.stop_name || s.stop_id, lon: Math.round(Number(s.stop_lon) * 1e5) / 1e5, lat: Math.round(Number(s.stop_lat) * 1e5) / 1e5 }));

const out = {
  meta: {
    city,
    source: opt.source,
    sourceDate: opt.date,
    official: opt.official,
    license: opt.license,
    generated: new Date().toISOString().slice(0, 10),
  },
  routes: outRoutes,
  stops: outStops,
};

mkdirSync('public/transit', { recursive: true });
writeFileSync(`public/transit/${city}.json`, JSON.stringify(out));
console.log(`${city}: ${outRoutes.length} tuyến, ${outStops.length} điểm dừng → public/transit/${city}.json`);
