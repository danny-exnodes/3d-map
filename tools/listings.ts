// Daily snapshot of Chợ Tốt Nhà land ads for the market panel (#38). The gateway sends no CORS
// header for our origin, so CI fetches it server-side and ships JSON with the site.
//
//   npx tsx tools/listings.ts [--out public/market] [--max-pages 40] [--regions hcm,hn]
//
// Output: <out>/<region>.json = {generated, source, region, count, listings} and
// <out>/index.json = {generated, regions: {hcm: {count, file}, …}}.
// Politeness: at most 1 request per second, one retry after 5 s, then that region stops.
// Decoding is shared with the app (src/land/chotot.ts) and drops seller data, text and images.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { buildListingUrl, CHOTOT_REGIONS, type ChototRegion, decodeChotot } from '../src/land/chotot';
import type { Listing } from '../src/land/types';

const args: Record<string, string> = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) args[argv[i].slice(2)] = argv[i + 1]?.startsWith('--') ? '' : (argv[i + 1] ?? '');
const out = args.out || 'public/market';
const maxPages = Number(args['max-pages'] || 40);
const regions = (args.regions || Object.keys(CHOTOT_REGIONS).join(',')).split(',') as ChototRegion[];
const PAGE = 50;
const UA = 'TinyMap/0.0.7 (+https://github.com/danny-exnodes/3d-map; daily land price snapshot, 1 req/s)';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let last = 0;
async function politeFetch(url: string): Promise<{ ads?: unknown[] }> {
  for (let attempt = 0; ; attempt++) {
    const wait = last + 1000 - Date.now();
    if (wait > 0) await sleep(wait);
    last = Date.now();
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return (await res.json()) as { ads?: unknown[] };
    } catch (e) {
      if (attempt >= 1) throw e;
      console.warn(`  ${(e as Error).message}, retrying in 5 s`);
      await sleep(5000);
    }
  }
}

mkdirSync(out, { recursive: true });
const generated = new Date().toISOString();
type Index = { generated: string; regions: Record<string, { count: number; file: string }> };
// Start from the existing index so a region that fails entirely keeps its previous file
// (in CI that is the committed sample copied into dist/ by vite).
const prev: Index | null = existsSync(`${out}/index.json`) ? JSON.parse(readFileSync(`${out}/index.json`, 'utf8')) : null;
const index: Index = { generated, regions: { ...prev?.regions } };

for (const region of regions) {
  if (!(region in CHOTOT_REGIONS)) throw new Error(`unknown region ${region}`);
  const byId = new Map<string, Listing>();
  let raw = 0;
  for (let p = 0; p < maxPages; p++) {
    let ads: unknown[];
    try {
      ads = (await politeFetch(buildListingUrl({ region, limit: PAGE, offset: p * PAGE }))).ads ?? [];
    } catch (e) {
      console.warn(`${region}: page ${p} failed (${(e as Error).message}); keeping ${byId.size} listings`);
      break;
    }
    raw += ads.length;
    for (const ad of ads) {
      const l = decodeChotot(ad);
      if (l) byId.set(l.id, l); // pages shift while paging; de-duplicate
    }
    if (ads.length === 0) break;
  }
  const listings = [...byId.values()].sort((a, b) => b.time - a.time);
  if (!listings.length) {
    console.warn(`${region}: no listings; keeping the previous file`);
    continue;
  }
  const file = `${region}.json`;
  writeFileSync(`${out}/${file}`, JSON.stringify({ generated, source: 'Chợ Tốt Nhà (nhatot.com)', region, count: listings.length, listings }));
  index.regions[region] = { count: listings.length, file };
  console.log(`${region}: ${listings.length} listings from ${raw} ads → ${out}/${file}`);
}
writeFileSync(`${out}/index.json`, JSON.stringify(index));
