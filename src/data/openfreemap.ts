import { VectorTile } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';
import { cacheGet, cacheSet } from './cache';
import { tileRange } from './overture';
import type { BBox, LngLat, PointOfInterest } from './types';

/**
 * OpenFreeMap: free OpenStreetMap vector tiles (OpenMapTiles schema, weekly updates, CORS).
 * Used for the 2D basemap and for named points of interest. Its z14 building layer keeps only
 * a few large buildings, so footprints come from Overture instead (#17).
 */
export const OFM_TILEJSON = 'https://tiles.openfreemap.org/planet';
export const OFM_STYLE = 'https://tiles.openfreemap.org/styles/dark';
const DAY = 24 * 3600 * 1000;

/** XYZ tile URL template of the current planet build (cached a day; last known when offline). */
export async function ofmTileTemplate(signal?: AbortSignal): Promise<string> {
  const hit = await cacheGet<string>('ofm', 'template');
  if (hit) return hit;
  try {
    const tj = (await (await fetch(OFM_TILEJSON, { signal })).json()) as { tiles: string[] };
    void cacheSet('ofm', 'template', tj.tiles[0], DAY);
    return tj.tiles[0];
  } catch (e) {
    const stale = await cacheGet<string>('ofm', 'template-last', true);
    if (stale) return stale;
    throw e;
  }
}

/** One OpenFreeMap tile, cached by z/x/y (not by build) so pinned offline tiles survive updates. */
export async function fetchOfmTile(z: number, x: number, y: number, signal?: AbortSignal): Promise<ArrayBuffer> {
  const key = `${z}/${x}/${y}`;
  const hit = await cacheGet<ArrayBuffer>('ofm', key);
  if (hit) return hit;
  try {
    const tpl = await ofmTileTemplate(signal);
    void cacheSet('ofm', 'template-last', tpl, 365 * DAY);
    const res = await fetch(tpl.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y)), { signal });
    if (!res.ok) throw new Error(`OpenFreeMap HTTP ${res.status}`);
    const bytes = await res.arrayBuffer();
    void cacheSet('ofm', key, bytes, 7 * DAY, bytes.byteLength);
    return bytes;
  } catch (e) {
    const stale = await cacheGet<ArrayBuffer>('ofm', key, true);
    if (stale && !signal?.aborted) return stale;
    throw e;
  }
}

/** POI classes worth a label in a 3D city model. */
const POI_CLASSES = new Set(['place_of_worship', 'hospital', 'college', 'university', 'museum', 'stadium', 'attraction', 'castle', 'monument', 'market', 'town_hall', 'theatre']);

export async function loadOfmPois(bbox: BBox, signal?: AbortSignal): Promise<PointOfInterest[]> {
  const { x0, x1, y0, y1 } = tileRange(bbox, 14);
  const out: PointOfInterest[] = [];
  const seen = new Set<string>();
  for (let x = x0; x <= x1; x++)
    for (let y = y0; y <= y1; y++) {
      const bytes = await fetchOfmTile(14, x, y, signal);
      const L = new VectorTile(new PbfReader(new Uint8Array(bytes))).layers['poi'];
      for (let i = 0; i < (L?.length ?? 0); i++) {
        const f = L.feature(i);
        const p = f.properties as Record<string, unknown>;
        const name = (p['name:vi'] ?? p['name']) as string | undefined;
        if (!name || !POI_CLASSES.has(String(p['class'])) || seen.has(name)) continue;
        const g = f.toGeoJSON(x, y, 14).geometry;
        if (g.type !== 'Point') continue;
        const pos = g.coordinates as LngLat;
        if (pos[0] < bbox.west || pos[0] > bbox.east || pos[1] < bbox.south || pos[1] > bbox.north) continue;
        seen.add(name);
        out.push({ id: `ofm/poi/${x}/${y}/${i}`, pos, name, kind: String(p['class']) });
      }
    }
  return out;
}
