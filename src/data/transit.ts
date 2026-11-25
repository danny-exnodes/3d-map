import type { BBox, LngLat } from './types';

/**
 * Real bus routes from GTFS (#56), as a static, pre-processed layer: the raw feeds are converted
 * once by `tools/transit.mjs` into `public/transit/{hn,hcm}.json`, the same pattern as
 * `public/market/` and `public/wards/` (src/data/offline.ts:loadWards). No GTFS parsing ships to
 * the browser.
 *
 * Hà Nội has an official feed (TUMI Data Hub / World Bank); TP.HCM has none, only a community
 * scrape (EnlightenedData) the project owner agreed to use with an "unofficial" label (#56).
 */

export type TransitCity = 'hn' | 'hcm';

export interface TransitRoute {
  id: string;
  /** Short name or number shown to riders ("09A", "Xe buýt nhanh BRT 01"). */
  name: string;
  /** CSS hex color from GTFS `routes.txt` (`route_color`), or a fallback. */
  color: string;
  /** Path of the route, lon/lat. */
  shape: LngLat[];
}

export interface TransitStop {
  id: string;
  name: string;
  lon: number;
  lat: number;
}

export interface TransitMeta {
  city: TransitCity;
  /** Where the feed came from, for the UI label (#56: always shown, never silently dropped). */
  source: string;
  /** Date the feed was fetched/published (not when this file was built), e.g. "2023-11". */
  sourceDate: string;
  /** False for TP.HCM's community feed: the UI must say "không chính thức". */
  official: boolean;
  license: string;
  /** When `tools/transit.mjs` wrote this file. */
  generated: string;
}

export interface TransitFile {
  meta: TransitMeta;
  routes: TransitRoute[];
  stops: TransitStop[];
}

const cache = new Map<TransitCity, Promise<TransitFile>>();

/** `public/transit/<city>.json`, cached in memory for the session (the file never changes at runtime). */
export function loadTransit(city: TransitCity, base: string): Promise<TransitFile> {
  let p = cache.get(city);
  if (!p) {
    p = fetch(new URL(`transit/${city}.json`, base)).then((r) => {
      if (!r.ok) throw new Error(`transit/${city}.json: HTTP ${r.status}`);
      return r.json() as Promise<TransitFile>;
    });
    p.catch(() => cache.delete(city));
    cache.set(city, p);
  }
  return p;
}

/** Everything north of 16° (Huế) is Hà Nội's network, like src/land/market.ts:regionFor. */
export function transitCityFor(lat: number): TransitCity {
  return lat > 16 ? 'hn' : 'hcm';
}

function inBbox(lon: number, lat: number, b: BBox): boolean {
  return lon >= b.west && lon <= b.east && lat >= b.south && lat <= b.north;
}

/** Routes with at least one point inside the built area; full shapes stay intact (clipped later, in 3D, to the model's extent). */
export function routesInBbox(file: TransitFile, b: BBox): TransitRoute[] {
  return file.routes.filter((r) => r.shape.some(([lon, lat]) => inBbox(lon, lat, b)));
}

export function stopsInBbox(file: TransitFile, b: BBox): TransitStop[] {
  return file.stops.filter((s) => inBbox(s.lon, s.lat, b));
}
