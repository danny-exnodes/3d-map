import { cacheGet, cacheSet } from './cache';
import { fetchOverpassText, parseOverpass, slimOverpass, type OverpassResponse } from './osm';
import type { BBox, CityData } from './types';

/** Bump when the Overpass query or the slimmed format changes, to invalidate cached entries. */
export const OSM_QUERY_VERSION = 2;
const OSM_TTL = 7 * 24 * 3600 * 1000;

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
