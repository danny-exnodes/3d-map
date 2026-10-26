import { VectorTile } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';
import { PMTiles } from 'pmtiles';
import { cacheGet, cacheSet } from './cache';
import type { BBox, LngLat, Polygon } from './types';

/** Overture Maps buildings as PMTiles (release listed in https://stac.overturemaps.org/catalog.json). */
export const OVERTURE_RELEASE = '2026-10-21.0';
export const overtureUrl = (theme: 'buildings' | 'transportation' | 'base') => `https://tiles.overturemaps.org/${OVERTURE_RELEASE}/${theme}.pmtiles`;
export const OVERTURE_BUILDINGS_URL = overtureUrl('buildings');
const ZOOM = 14;

const archives = new Map<string, PMTiles>();

/** One PMTiles tile (raw MVT bytes), via the IndexedDB cache (30 days). Empty buffer when absent. */
export async function fetchTileBytes(url: string, z: number, x: number, y: number, signal?: AbortSignal): Promise<ArrayBuffer> {
  const key = `${url}/${z}/${x}/${y}`;
  const hit = await cacheGet<ArrayBuffer>('overture', key);
  if (hit) return hit;
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  let pm = archives.get(url);
  if (!pm) archives.set(url, (pm = new PMTiles(url)));
  const t = await pm.getZxy(z, x, y, signal);
  const bytes = t?.data ?? new ArrayBuffer(0);
  void cacheSet('overture', key, bytes, 30 * 24 * 3600 * 1000, bytes.byteLength);
  return bytes;
}

export interface OvertureBuilding {
  id: string;
  polygon: Polygon;
  /** Dataset the footprint comes from: "OpenStreetMap", "Google Open Buildings", "Microsoft ML Buildings", … */
  dataset: string;
  height?: number;
  minHeight?: number;
  numFloors?: number;
  roofShape?: string;
  roofColor?: string;
  facadeColor?: string;
  cls?: string;
  /** Present on building_part features. */
  buildingId?: string;
}

export function tileRange(b: BBox, z = ZOOM): { x0: number; x1: number; y0: number; y1: number } {
  const n = 2 ** z;
  const tx = (lon: number) => Math.floor(((lon + 180) / 360) * n);
  const ty = (lat: number) => {
    const r = (lat * Math.PI) / 180;
    return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n);
  };
  return { x0: tx(b.west), x1: tx(b.east), y0: ty(b.north), y1: ty(b.south) };
}

const num = (v: unknown) => (typeof v === 'number' && isFinite(v) ? v : undefined);
const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);

function datasetOf(props: Record<string, unknown>): string {
  const g = str(props['@geometry_source']);
  if (g) return g;
  const m = /"dataset":"([^"]+)"/.exec(String(props['sources'] ?? ''));
  return m?.[1] ?? 'unknown';
}

function toPolygons(geom: GeoJSON.Geometry): Polygon[] {
  const rings = (r: number[][][]): Polygon => r.map((ring) => ring.slice(0, -1).map((p) => [p[0], p[1]] as LngLat));
  if (geom.type === 'Polygon') return [rings(geom.coordinates)];
  if (geom.type === 'MultiPolygon') return geom.coordinates.map(rings);
  return [];
}

const ringArea = (r: LngLat[]) => {
  let a = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += (r[j][0] - r[i][0]) * (r[j][1] + r[i][1]);
  return Math.abs(a / 2);
};

/** Decodes one MVT tile into buildings and building parts. */
export function decodeTile(bytes: Uint8Array, x: number, y: number, z: number): { buildings: OvertureBuilding[]; parts: OvertureBuilding[] } {
  const vt = new VectorTile(new PbfReader(bytes));
  const read = (layer: string): OvertureBuilding[] => {
    const L = vt.layers[layer];
    if (!L) return [];
    const out: OvertureBuilding[] = [];
    for (let i = 0; i < L.length; i++) {
      const f = L.feature(i);
      const p = f.properties as Record<string, unknown>;
      if (p['is_underground'] === true) continue;
      for (const polygon of toPolygons(f.toGeoJSON(x, y, z).geometry)) {
        if (polygon[0]?.length < 3) continue;
        out.push({
          id: String(p['id'] ?? `${layer}/${x}/${y}/${i}`),
          polygon,
          dataset: datasetOf(p),
          height: num(p['height']),
          minHeight: num(p['min_height']),
          numFloors: num(p['num_floors']),
          roofShape: str(p['roof_shape']),
          roofColor: str(p['roof_color']),
          facadeColor: str(p['facade_color']),
          cls: str(p['class']) ?? str(p['subtype']),
          buildingId: str(p['building_id']),
        });
      }
    }
    return out;
  };
  return { buildings: read('building'), parts: read('building_part') };
}

/**
 * Overture buildings intersecting the bbox, from the public PMTiles (CORS-enabled, range
 * requests). Tiles are cached in IndexedDB for 30 days. Features split across tile borders are
 * de-duplicated by id, keeping the largest piece.
 */
export async function loadOvertureBuildings(
  bbox: BBox,
  opts: { url?: string; signal?: AbortSignal; onTile?: (done: number, total: number) => void } = {},
): Promise<{ buildings: OvertureBuilding[]; parts: OvertureBuilding[] }> {
  const url = opts.url ?? OVERTURE_BUILDINGS_URL;
  const { x0, x1, y0, y1 } = tileRange(bbox);
  const total = (x1 - x0 + 1) * (y1 - y0 + 1);
  if (total > 9) throw new Error('Vùng quá lớn cho Overture');
  const byId = new Map<string, OvertureBuilding>();
  const parts = new Map<string, OvertureBuilding>();
  let done = 0;
  const inBox = (p: Polygon) => {
    const r = p[0];
    let cx = 0, cy = 0;
    for (const q of r) { cx += q[0]; cy += q[1]; }
    cx /= r.length; cy /= r.length;
    return cx >= bbox.west && cx <= bbox.east && cy >= bbox.south && cy <= bbox.north;
  };
  const keep = (map: Map<string, OvertureBuilding>, b: OvertureBuilding) => {
    const prev = map.get(b.id);
    if (!prev || ringArea(b.polygon[0]) > ringArea(prev.polygon[0])) map.set(b.id, b);
  };
  for (let x = x0; x <= x1; x++) {
    for (let y = y0; y <= y1; y++) {
      const bytes = await fetchTileBytes(url, ZOOM, x, y, opts.signal);
      if (bytes.byteLength) {
        const d = decodeTile(new Uint8Array(bytes), x, y, ZOOM);
        for (const b of d.buildings) if (inBox(b.polygon)) keep(byId, b);
        for (const b of d.parts) if (inBox(b.polygon)) keep(parts, b);
      }
      opts.onTile?.(++done, total);
    }
  }
  return { buildings: [...byId.values()], parts: [...parts.values()] };
}
