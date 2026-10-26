#!/usr/bin/env node
// Writes a building-height grid for a bbox as a static asset the app loads (public/heights/<id>.json + .bin).
//
//   npm run heights -- --id ngatuso --bbox 20.9992,105.8152,21.0068,105.8238 --name "Ngã Tư Sở" [--cell 2]
//
// Source: Google Open Buildings 2.5D Temporal. Its bucket has no CORS headers, so this runs in Node.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { extractHeightGrid } from './lib/gob.mjs';

const args = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) args[argv[i].slice(2)] = argv[i + 1];
if (!args.id || !args.bbox) {
  console.error('usage: --id <id> --bbox south,west,north,east [--name label] [--cell 2]');
  process.exit(1);
}
const [south, west, north, east] = args.bbox.split(',').map(Number);
const res = await extractHeightGrid({ south, west, north, east }, Number(args.cell || 2));
if (!res) {
  console.error('No Open Buildings 2.5D tile covers this bbox (the bundled index covers Việt Nam).');
  process.exit(2);
}
const dir = new URL('../public/heights/', import.meta.url);
mkdirSync(dir, { recursive: true });
const meta = { id: args.id, name: args.name || args.id, ...res.meta };
writeFileSync(new URL(`${args.id}.bin`, dir), Buffer.from(res.grid.buffer));
writeFileSync(new URL(`${args.id}.json`, dir), JSON.stringify(meta, null, 2) + '\n');
const manifestUrl = new URL('index.json', dir);
const manifest = existsSync(manifestUrl) ? JSON.parse(readFileSync(manifestUrl, 'utf8')) : [];
const entry = { id: meta.id, name: meta.name, bbox: meta.bbox };
writeFileSync(manifestUrl, JSON.stringify([...manifest.filter((m) => m.id !== meta.id), entry], null, 2) + '\n');
let filled = 0;
for (const v of res.grid) if (v) filled++;
console.log(`${args.id}: ${meta.width}×${meta.depth} @ ${meta.cell} m, ${((filled / res.grid.length) * 100).toFixed(1)}% cells with buildings`);
