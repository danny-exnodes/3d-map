import { cachePin } from './cache';
import { fetchOfmTile, OFM_STYLE, ofmTileTemplate } from './openfreemap';
import { fetchTileBytes, overtureUrl, tileRange } from './overture';
import type { BBox } from './types';

/**
 * Offline packages per ward (phường/xã) of TP.HCM and Hà Nội (#18).
 *
 * A package is everything the app needs to build any area inside the ward without network:
 * - Overture buildings + transportation (z14) and base (z13) tiles, OpenFreeMap z14 tiles (POIs):
 *   kept in the IndexedDB cache and pinned, so they never expire or get evicted;
 * - the 2D basemap (style, TileJSON, sprites, glyphs, vector tiles z5–14) and bundled height grids:
 *   stored in Cache Storage and served by the service worker (public/sw.js) when offline.
 */

export type CityId = 'hcm' | 'hn';
export const CITIES: { id: CityId; name: string }[] = [
  { id: 'hcm', name: 'TP. Hồ Chí Minh' },
  { id: 'hn', name: 'Hà Nội' },
];

export interface Ward {
  id: string;
  name: string;
  kind: 'phuong' | 'xa' | 'khac';
  bbox: BBox;
  /** MultiPolygon coordinates, [lon, lat]. */
  polygon: number[][][][];
}

export interface WardList {
  city: CityId;
  name: string;
  source: string;
  wards: Ward[];
}

export interface OfflinePackage {
  id: string;
  name: string;
  city: CityId;
  bbox: BBox;
  bytes: number;
  createdAt: string;
  /** IndexedDB entries pinned for this package. */
  keys: { ns: string; key: string }[];
}

const LIST_KEY = 'tinymap:offline';
const SHARED_CACHE = 'tinymap-pkg-shared';
const cacheName = (id: string) => `tinymap-pkg-${id}`;
/** Glyph ranges needed for Vietnamese labels (Latin, Latin Extended, combining marks, Latin Extended Additional). */
const GLYPH_RANGES = ['0-255', '256-511', '768-1023', '7680-7935'];
const BASEMAP_ZOOMS = [5, 6, 7, 8, 9, 10, 11, 12, 13, 14];

const wardCache = new Map<CityId, Promise<WardList>>();

export function loadWards(city: CityId, base: string): Promise<WardList> {
  let p = wardCache.get(city);
  if (!p) {
    p = fetch(new URL(`wards/${city}.json`, base)).then((r) => {
      if (!r.ok) throw new Error(`wards/${city}.json: HTTP ${r.status}`);
      return r.json() as Promise<WardList>;
    });
    p.catch(() => wardCache.delete(city));
    wardCache.set(city, p);
  }
  return p;
}

/** Lower-case, accents removed, đ → d: "Phường Chánh Hưng" → "phuong chanh hung". */
export function fold(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'd').toLowerCase().trim();
}

const PREFIX = /^(phuong|xa|dac khu)\s+/;

/** Accent-insensitive search; names whose core (without "Phường"/"Xã") starts with the query rank first. */
export function searchWards(wards: Ward[], query: string, limit = 30): Ward[] {
  const q = fold(query).replace(PREFIX, '');
  if (!q) return wards.slice(0, limit);
  const words = q.split(/\s+/);
  const scored: { w: Ward; s: number }[] = [];
  for (const w of wards) {
    const name = fold(w.name);
    const core = name.replace(PREFIX, '');
    if (!words.every((t) => name.includes(t))) continue;
    const s = core === q ? 0 : core.startsWith(q) ? 1 : core.split(' ').some((p) => p.startsWith(words[0])) ? 2 : 3;
    scored.push({ w, s });
  }
  return scored.sort((a, b) => a.s - b.s || a.w.name.localeCompare(b.w.name, 'vi')).slice(0, limit).map((x) => x.w);
}

export function wardAreaKm2(w: Ward): number {
  // Shoelace on an equirectangular projection around the ward.
  const lat0 = ((w.bbox.south + w.bbox.north) / 2) * (Math.PI / 180);
  const kx = 111.32 * Math.cos(lat0), ky = 110.574;
  let a = 0;
  for (const poly of w.polygon) {
    poly.forEach((ring, ri) => {
      let s = 0;
      for (let i = 0; i < ring.length - 1; i++) s += ring[i][0] * kx * ring[i + 1][1] * ky - ring[i + 1][0] * kx * ring[i][1] * ky;
      a += (ri === 0 ? 1 : -1) * Math.abs(s / 2);
    });
  }
  return a;
}

interface TileJob {
  label: string;
  run: (signal?: AbortSignal) => Promise<number>;
}

const range = (b: BBox, z: number) => {
  const t = tileRange(b, z);
  const out: [number, number][] = [];
  for (let x = t.x0; x <= t.x1; x++) for (let y = t.y0; y <= t.y1; y++) out.push([x, y]);
  return out;
};

/** Number of downloads a package for this bbox needs (shown before downloading). */
export function packageSize(b: BBox): number {
  return range(b, 14).length * 3 + range(b, 13).length + BASEMAP_ZOOMS.reduce((n, z) => n + range(b, z).length, 0);
}

/** Downloads and pins everything for `ward`. Resolves with the stored package record. */
export async function downloadPackage(
  city: CityId,
  ward: Ward,
  opts: { heightsBase?: string; signal?: AbortSignal; onProgress?: (done: number, total: number) => void } = {},
): Promise<OfflinePackage> {
  const { signal } = opts;
  const b = ward.bbox;
  const keys: OfflinePackage['keys'] = [{ ns: 'ofm', key: 'template-last' }];
  const jobs: TileJob[] = [];
  let cacheBytes = 0;

  for (const [x, y] of range(b, 14)) {
    for (const theme of ['buildings', 'transportation'] as const) {
      const url = overtureUrl(theme);
      keys.push({ ns: 'overture', key: `${url}/14/${x}/${y}` });
      jobs.push({ label: theme, run: (s) => fetchTileBytes(url, 14, x, y, s).then((a) => a.byteLength) });
    }
    keys.push({ ns: 'ofm', key: `14/${x}/${y}` });
    jobs.push({ label: 'poi', run: (s) => fetchOfmTile(14, x, y, s).then((a) => a.byteLength) });
  }
  for (const [x, y] of range(b, 13)) {
    const url = overtureUrl('base');
    keys.push({ ns: 'overture', key: `${url}/13/${x}/${y}` });
    jobs.push({ label: 'base', run: (s) => fetchTileBytes(url, 13, x, y, s).then((a) => a.byteLength) });
  }

  const hasCaches = typeof caches !== 'undefined';
  const own = hasCaches ? await caches.open(cacheName(ward.id)) : null;
  const shared = hasCaches ? await caches.open(SHARED_CACHE) : null;
  /** Fetches a URL into a Cache Storage cache (skipped when already there). */
  const store = async (cache: Cache | null, url: string, s?: AbortSignal) => {
    if (!cache) return 0;
    const hit = await cache.match(url);
    if (hit) return 0;
    const res = await fetch(url, { signal: s });
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    const blob = await res.clone().blob();
    await cache.put(url, res);
    return blob.size;
  };

  // Basemap: style + TileJSON + sprites + glyphs (shared by all packages), vector tiles per ward.
  if (hasCaches) {
    const style = (await (await fetch(OFM_STYLE, { signal })).json()) as {
      glyphs?: string;
      sprite?: string;
      sources: Record<string, { url?: string }>;
      layers: { layout?: { 'text-font'?: string[] } }[];
    };
    await shared!.put(OFM_STYLE, new Response(JSON.stringify(style), { headers: { 'Content-Type': 'application/json' } }));
    for (const src of Object.values(style.sources)) if (src.url) jobs.push({ label: 'basemap', run: (s) => store(shared, src.url!, s) });
    if (typeof style.sprite === 'string') {
      for (const suffix of ['.json', '.png', '@2x.json', '@2x.png']) jobs.push({ label: 'basemap', run: (s) => store(shared, style.sprite + suffix, s) });
    }
    if (style.glyphs) {
      const stacks = new Set(style.layers.map((l) => l.layout?.['text-font']?.join(',')).filter((x): x is string => !!x));
      for (const stack of stacks) {
        for (const r of GLYPH_RANGES) {
          const url = style.glyphs.replace('{fontstack}', encodeURIComponent(stack)).replace('{range}', r);
          jobs.push({ label: 'basemap', run: (s) => store(shared, url, s) });
        }
      }
    }
    const tpl = await ofmTileTemplate(signal);
    for (const z of BASEMAP_ZOOMS) {
      for (const [x, y] of range(b, z)) {
        const url = tpl.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y));
        jobs.push({ label: 'basemap', run: (s) => store(own, url, s) });
      }
    }
    // Bundled height grids overlapping the ward (static build), plus their manifest.
    if (opts.heightsBase) {
      const indexUrl = new URL('index.json', opts.heightsBase).href;
      try {
        const list = (await (await fetch(indexUrl, { signal })).json()) as { id: string; bbox: BBox }[];
        jobs.push({ label: 'heights', run: (s) => store(shared, indexUrl, s) });
        for (const e of list) {
          if (e.bbox.west > b.east || e.bbox.east < b.west || e.bbox.south > b.north || e.bbox.north < b.south) continue;
          for (const ext of ['json', 'bin']) jobs.push({ label: 'heights', run: (s) => store(own, new URL(`${e.id}.${ext}`, opts.heightsBase).href, s) });
        }
      } catch (e) {
        if (signal?.aborted) throw e;
      }
      // z14 height tiles generated for the wards at deploy time (tools/height-tiles.mjs).
      const tilesIndex = new URL('z14/index.json', opts.heightsBase).href;
      try {
        const idx = (await (await fetch(tilesIndex, { signal })).json()) as { tiles: Record<string, unknown> };
        jobs.push({ label: 'heights', run: (s) => store(shared, tilesIndex, s) });
        for (const [x, y] of range(b, 14)) {
          if (idx.tiles[`${x}-${y}`]) jobs.push({ label: 'heights', run: (s) => store(own, new URL(`z14/${x}-${y}.bin.gz`, opts.heightsBase).href, s) });
        }
      } catch (e) {
        if (signal?.aborted) throw e;
      }
    }
  }

  // Four downloads at a time.
  let done = 0;
  let next = 0;
  opts.onProgress?.(0, jobs.length);
  const worker = async () => {
    while (next < jobs.length) {
      const j = jobs[next++];
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      const n = await j.run(signal);
      // IndexedDB sizes are counted when pinning; these are Cache Storage bytes.
      if (j.label === 'basemap' || j.label === 'heights') cacheBytes += n;
      opts.onProgress?.(++done, jobs.length);
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);

  await cacheAppShell();
  const idbBytes = await cachePin(keys, ward.id, true);
  try {
    await navigator.storage?.persist?.();
  } catch {
    /* best effort */
  }
  const pkg: OfflinePackage = { id: ward.id, name: ward.name, city, bbox: b, bytes: idbBytes + cacheBytes, createdAt: new Date().toISOString(), keys };
  savePackages([...listPackages().filter((p) => p.id !== pkg.id), pkg]);
  return pkg;
}

export function listPackages(): OfflinePackage[] {
  try {
    return JSON.parse(localStorage.getItem(LIST_KEY) ?? '[]') as OfflinePackage[];
  } catch {
    return [];
  }
}

function savePackages(list: OfflinePackage[]) {
  try {
    localStorage.setItem(LIST_KEY, JSON.stringify(list));
  } catch {
    /* storage full or blocked */
  }
}

export async function deletePackage(id: string): Promise<void> {
  const pkg = listPackages().find((p) => p.id === id);
  if (pkg) await cachePin(pkg.keys, id, false);
  if (typeof caches !== 'undefined') await caches.delete(cacheName(id));
  const rest = listPackages().filter((p) => p.id !== id);
  savePackages(rest);
  if (!rest.length && typeof caches !== 'undefined') await caches.delete(SHARED_CACHE);
}

/** The downloaded package covering a point, if any. */
export function packageAt(lon: number, lat: number): OfflinePackage | undefined {
  return listPackages().find((p) => lon >= p.bbox.west && lon <= p.bbox.east && lat >= p.bbox.south && lat <= p.bbox.north);
}

/**
 * Stores the page and every same-origin file it loaded (scripts, styles, workers, wards) in the
 * service worker's shell cache. The first visit happens before the worker controls the page, so
 * without this an offline reload would find nothing.
 */
export async function cacheAppShell(): Promise<void> {
  if (typeof caches === 'undefined') return;
  const urls = new Set<string>([location.href.split('#')[0]]);
  for (const e of performance.getEntriesByType('resource')) {
    const u = new URL(e.name);
    if (u.origin === location.origin && !u.pathname.includes('/api/')) urls.add(u.href);
  }
  const cache = await caches.open('tinymap-shell-v1');
  await Promise.all(
    [...urls].map(async (u) => {
      try {
        const res = await fetch(u, { cache: 'no-cache' });
        if (res.ok) await cache.put(u, res);
      } catch {
        /* skip */
      }
    }),
  );
}

/** Registers the service worker that serves the app and the basemap when offline. */
export function registerServiceWorker(base: string) {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register(new URL('sw.js', base)).catch((e) => console.warn('Service worker', e));
}
