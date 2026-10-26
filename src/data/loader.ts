import { cacheGet, cacheSet } from './cache';
import { applyHeightGrid, computeStats, mergeOverture } from './enrich';
import { loadHeightGrid } from './heights';
import { loadOvertureBuildings } from './overture';
import { loadOvertureContext } from './overtureBase';
import { fetchOverpassText, linkedAbort, parseOverpass, slimOverpass, type OverpassResponse } from './osm';
import type { BBox, CityData } from './types';

/** Bump when the Overpass query or the slimmed format changes, to invalidate cached entries. */
export const OSM_QUERY_VERSION = 2;
const OSM_TTL = 7 * 24 * 3600 * 1000;
/** Overall OSM budget; Overpass usually answers a ~1 km² query in 2–10 s when healthy. */
export const OSM_BUDGET_MS = 20_000;

export const bboxKey = (b: BBox, digits = 4) => [b.south, b.west, b.north, b.east].map((v) => v.toFixed(digits)).join(',');

export interface LoadProgress {
  step: 'osm' | 'merge';
  f: number;
  detail: string;
}

const mb = (n: number) => `${(n / 1048576).toLocaleString('vi-VN', { maximumFractionDigits: 1 })} MB`;

/** OSM for a bbox: IndexedDB cache first, then Overpass with real byte progress (#9). */
export async function loadOsm(bbox: BBox, signal: AbortSignal | undefined, onProgress: (p: LoadProgress) => void): Promise<CityData> {
  const key = `v${OSM_QUERY_VERSION}:${bboxKey(bbox)}`;
  const cached = await cacheGet<string>('osm', key);
  let slim: OverpassResponse;
  if (cached) {
    slim = JSON.parse(cached) as OverpassResponse;
    onProgress({ step: 'osm', f: 1, detail: `${slim.elements.length.toLocaleString('vi-VN')} đối tượng (bộ nhớ đệm)` });
  } else {
    const text = await fetchOverpassText(bbox, signal, (p) => {
      const host = new URL(p.endpoint).host;
      const detail = p.waitSeconds ? `${host}: chờ ${p.waitSeconds} s` : p.bytes ? `đã tải ${mb(p.bytes)}` : `${host}…`;
      // Unknown total size: approach 90% asymptotically as bytes arrive.
      onProgress({ step: 'osm', f: p.bytes ? 0.9 * (1 - Math.exp(-p.bytes / 4e6)) : 0.05, detail });
    });
    slim = slimOverpass(JSON.parse(text) as OverpassResponse);
    const json = JSON.stringify(slim);
    void cacheSet('osm', key, json, OSM_TTL, json.length * 2);
    onProgress({ step: 'osm', f: 1, detail: `${slim.elements.length.toLocaleString('vi-VN')} đối tượng · ${mb(text.length)}` });
  }
  onProgress({ step: 'merge', f: 0.2, detail: 'đọc dữ liệu' });
  return parseOverpass(bbox, slim);
}

export interface CityLoadOptions {
  signal?: AbortSignal;
  /** Absolute URL of public/heights/ (bundled height grids). */
  heightsBase?: string;
  /** Optional on-demand height-grid endpoint (dev server or a CORS proxy, #4). */
  heightsApi?: string;
  /** Set false to skip Overture footprints (e.g. offline tests). */
  overture?: boolean;
  /** Time allowed for OSM (all Overpass mirrors) before falling back to Overture. */
  osmTimeoutMs?: number;
}

/**
 * Full data pipeline (#3): OSM, Overture footprints and the Google 2.5D height grid are fetched
 * in parallel, then merged. Overture/heights failures degrade gracefully to OSM + heuristics.
 */
export async function loadCity(bbox: BBox, opts: CityLoadOptions, onProgress: (p: { step: 'osm' | 'overture' | 'heights' | 'merge'; f: number; detail: string }) => void): Promise<CityData> {
  const { signal } = opts;
  const overtureP: Promise<Awaited<ReturnType<typeof loadOvertureBuildings>> | null> =
    opts.overture === false
      ? Promise.resolve(null)
      : loadOvertureBuildings(bbox, { signal, onTile: (d, t) => onProgress({ step: 'overture', f: d / t, detail: `${d}/${t} ô dữ liệu` }) }).catch((e) => {
          if (signal?.aborted) throw e;
          onProgress({ step: 'overture', f: 1, detail: 'không tải được' });
          return null;
        });
  const gridP = loadHeightGrid(bbox, { staticBase: opts.heightsBase, api: opts.heightsApi, signal }).then((g) => {
    onProgress({ step: 'heights', f: 1, detail: g ? 'Google 2.5D' : 'không có — ước lượng' });
    return g;
  });
  // Overpass is a shared public service and often rate limited: fall back to Overture's
  // street network (itself derived from OSM) so the model still has roads and water.
  // Whatever the mirrors do, give OSM a bounded time before switching to Overture.
  const budget = opts.osmTimeoutMs ?? OSM_BUDGET_MS;
  const osmLimit = linkedAbort(signal, budget);
  // Tick once a second while waiting so a slow server never looks like a frozen app.
  const t0 = Date.now();
  let lastOsm: { f: number; detail: string } = { f: 0.05, detail: 'Overpass…' };
  const tick = setInterval(() => {
    const s = Math.round((Date.now() - t0) / 1000);
    onProgress({ step: 'osm', f: lastOsm.f, detail: `${lastOsm.detail} · ${s}/${Math.round(budget / 1000)} s` });
  }, 1000);
  const osmP = loadOsm(bbox, osmLimit.ctrl.signal, (p) => {
    if (p.step === 'osm') lastOsm = { f: p.f, detail: p.detail };
    onProgress(p);
  }).finally(() => clearInterval(tick)).catch(async (e) => {
    if (signal?.aborted || opts.overture === false) throw e;
    onProgress({ step: 'osm', f: 0.5, detail: osmLimit.ctrl.signal.aborted ? 'Overpass quá chậm — dùng Overture' : 'Overpass lỗi — dùng Overture' });
    const ctx = await loadOvertureContext(bbox, signal);
    onProgress({ step: 'osm', f: 1, detail: `Overture: ${ctx.roads.length.toLocaleString('vi-VN')} đoạn đường` });
    const fallback: CityData = { bbox, buildings: [], pois: [], source: 'Overture', ...ctx };
    return fallback;
  });
  const [data, overture, grid] = await Promise.all([osmP.finally(() => osmLimit.clear()), overtureP, gridP]);

  onProgress({ step: 'merge', f: 0.4, detail: 'ghép footprint' });
  if (overture) {
    const added = mergeOverture(data, overture);
    onProgress({ step: 'overture', f: 1, detail: `+${added.toLocaleString('vi-VN')} nhà` });
  }
  if (grid) {
    onProgress({ step: 'merge', f: 0.7, detail: 'gán chiều cao' });
    applyHeightGrid(data.buildings, grid);
  }
  data.stats = computeStats(data);
  if (overture && data.source !== 'Overture') data.source = 'OpenStreetMap + Overture';
  onProgress({ step: 'merge', f: 1, detail: `${data.buildings.length.toLocaleString('vi-VN')} nhà` });
  return data;
}
