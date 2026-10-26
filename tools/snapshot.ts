// Builds a self-contained data snapshot (CityData JSON) for a bbox, used by the offline preview
// build (VITE_PREVIEW=1), where the page cannot reach any external service.
//
//   npx tsx tools/snapshot.ts --id ennam --name "Én Nam – 101 Châu Thị Hoá" --bbox 10.73414,106.67271,10.74138,106.68003 [--heights ennam]
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { applyHeightGrid, computeStats } from '../src/data/enrich';
import { HeightGrid } from '../src/data/heights';
import { loadCity } from '../src/data/loader';
import { synthesizeFromGrid } from '../src/data/synth';

const args: Record<string, string> = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) args[argv[i].slice(2)] = argv[i + 1]?.startsWith('--') ? '' : argv[i + 1];
const [south, west, north, east] = args.bbox.split(',').map(Number);
const bbox = { south, west, north, east };

const data = await loadCity(bbox, {}, (p) => process.stderr.write(`\r${p.step}: ${Math.round(p.f * 100)}% ${p.detail}        `));
process.stderr.write('\n');
if (args.heights) {
  const meta = JSON.parse(readFileSync(`public/heights/${args.heights}.json`, 'utf8'));
  const buf = readFileSync(`public/heights/${args.heights}.bin`);
  const grid = new HeightGrid(meta, new Uint16Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)));
  applyHeightGrid(data.buildings, grid);
  if (!('raw' in args)) synthesizeFromGrid(data, grid);
}
data.stats = computeStats(data);
// Drop fields the renderer does not need to keep the file small.
for (const b of data.buildings) delete b.tags;
const round = (v: unknown): unknown =>
  Array.isArray(v) ? v.map(round) : typeof v === 'number' ? Math.round(v * 1e6) / 1e6 : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, round(x)])) : v;

if ('raw' in args) {
  // Test fixture: data before inference (#16), gzipped.
  const { gzipSync } = await import('node:zlib');
  mkdirSync('tests/fixtures', { recursive: true });
  writeFileSync(`tests/fixtures/${args.id}-raw.json.gz`, gzipSync(JSON.stringify(round(data))));
  console.log(`fixture tests/fixtures/${args.id}-raw.json.gz: ${data.buildings.length} buildings`);
  process.exit(0);
}
mkdirSync('public/snapshots', { recursive: true });
writeFileSync(`public/snapshots/${args.id}.json`, JSON.stringify(round(data)));
const manifestPath = 'public/snapshots/index.json';
const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : [];
const entry = { id: args.id, name: args.name ?? args.id, bbox, created: new Date().toISOString().slice(0, 10) };
writeFileSync(manifestPath, JSON.stringify([...manifest.filter((m: { id: string }) => m.id !== args.id), entry], null, 2) + '\n');
const st = data.stats;
console.log(`${args.id}: ${data.buildings.length} buildings, ${data.roads.length} roads, ${data.areas.length} areas, ${data.trees.length} trees; heights ${JSON.stringify(st.heights)}; source ${data.source}`);
