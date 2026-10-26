import { buildingFromOsm, parseNumber } from './buildings';
import { pointInRing } from '../geo/projection';
import { joinRings, openRing } from './rings';

export { FACADE_COLORS, ROOF_COLORS, normalizeColor, parseNumber } from './buildings';
import type {
  AreaFeature,
  BBox,
  CityData,
  LngLat,
  Polygon,
  PointOfInterest,
  RoadClass,
  Waterway,
} from './types';

/** Public Overpass mirrors, tried in order. */
export const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];

export function buildOverpassQuery(b: BBox): string {
  const bb = `${b.south},${b.west},${b.north},${b.east}`;
  return `[out:json][timeout:90];
(
  way["building"](${bb});
  way["building:part"](${bb});
  relation["building"]["type"="multipolygon"](${bb});
  way["highway"](${bb});
  way["railway"~"^(rail|subway|light_rail|tram|monorail|narrow_gauge)$"](${bb});
  way["natural"="water"](${bb});
  relation["natural"="water"](${bb});
  way["waterway"~"^(river|canal|stream|drain|riverbank)$"](${bb});
  way["landuse"~"^(grass|forest|recreation_ground|meadow|village_green|cemetery)$"](${bb});
  way["leisure"~"^(park|garden|pitch|playground)$"](${bb});
  relation["leisure"="park"](${bb});
  way["amenity"="parking"](${bb});
  node["natural"="tree"](${bb});
  node["amenity"~"^(place_of_worship|hospital|university|marketplace)$"]["name"](${bb});
  way["amenity"~"^(place_of_worship|hospital|university|marketplace)$"]["name"](${bb});
);
out geom qt;`;
}

interface OsmGeomPoint {
  lat: number;
  lon: number;
}
interface OsmMember {
  type: string;
  role: string;
  geometry?: OsmGeomPoint[];
}
interface OsmElement {
  type: 'node' | 'way' | 'relation';
  id: number;
  lat?: number;
  lon?: number;
  tags?: Record<string, string>;
  geometry?: OsmGeomPoint[];
  members?: OsmMember[];
}
export interface OverpassResponse {
  elements: OsmElement[];
}

export interface OverpassProgress {
  endpoint: string;
  bytes: number;
  /** Seconds until a query slot frees up, when the server is rate limiting us. */
  waitSeconds?: number;
}

/** Reads a fetch body while reporting received bytes (Overpass sends no Content-Length). */
export async function readTextWithProgress(res: Response, onBytes: (n: number) => void): Promise<string> {
  if (!res.body) return res.text();
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    text += decoder.decode(value, { stream: true });
    onBytes(n);
  }
  return text + decoder.decode();
}

/**
 * Parses Overpass `/api/status`: returns 0 when a slot is free, the wait in seconds when
 * rate limited, or null when the status cannot be read.
 */
export function parseOverpassStatus(text: string): number | null {
  const free = /(\d+) slots? available now/.exec(text);
  if (free && Number(free[1]) > 0) return 0;
  const waits = [...text.matchAll(/in (\d+) seconds/g)].map((m) => Number(m[1]));
  return waits.length ? Math.min(...waits) : null;
}

async function overpassWait(endpoint: string, signal?: AbortSignal): Promise<number | null> {
  try {
    const res = await fetch(endpoint.replace(/interpreter$/, 'status'), { signal });
    return res.ok ? parseOverpassStatus(await res.text()) : null;
  } catch {
    return null;
  }
}

/** Fetches raw Overpass JSON text, trying mirrors in order and respecting rate limits (#9). */
export async function fetchOverpassText(
  bbox: BBox,
  signal?: AbortSignal,
  onProgress?: (p: OverpassProgress) => void,
): Promise<string> {
  const body = 'data=' + encodeURIComponent(buildOverpassQuery(bbox));
  let lastErr: unknown;
  for (const endpoint of OVERPASS_ENDPOINTS) {
    try {
      const wait = await overpassWait(endpoint, signal);
      if (wait && wait > 0) {
        onProgress?.({ endpoint, bytes: 0, waitSeconds: wait });
        if (wait > 20) throw new Error(`${new URL(endpoint).host}: hết lượt, cần chờ ${wait} s`);
        await sleep(wait * 1000, signal);
      }
      onProgress?.({ endpoint, bytes: 0 });
      const res = await fetch(endpoint, {
        method: 'POST',
        body,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        signal,
      });
      if (!res.ok) throw new Error(`${new URL(endpoint).host}: HTTP ${res.status}`);
      return await readTextWithProgress(res, (bytes) => onProgress?.({ endpoint, bytes }));
    } catch (e) {
      if (signal?.aborted) throw e;
      lastErr = e;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('Overpass request failed');
}

function sleep(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      reject(new DOMException('Aborted', 'AbortError'));
    });
  });
}

/** Tags the parser reads; everything else is dropped before caching (~40–60% smaller). */
const KEPT_TAGS = new Set([
  'building', 'building:part', 'building:levels', 'building:min_level', 'building:height', 'height', 'min_height',
  'roof:shape', 'roof:height', 'roof:levels', 'roof:colour', 'roof:material', 'roof:direction', 'roof:orientation',
  'building:colour', 'building:material', 'name', 'amenity', 'religion', 'highway', 'lanes', 'width', 'oneway',
  'junction', 'layer', 'bridge', 'tunnel', 'area', 'railway', 'waterway', 'natural', 'landuse', 'leisure', 'shop',
  'addr:housenumber', 'addr:street', 'addr:district', 'addr:city',
]);

export function slimOverpass(data: OverpassResponse): OverpassResponse {
  return {
    elements: data.elements.map((el) => {
      const tags: Record<string, string> = {};
      for (const [k, v] of Object.entries(el.tags ?? {})) if (KEPT_TAGS.has(k)) tags[k] = v;
      return { ...el, tags };
    }),
  };
}

const toLL = (g: OsmGeomPoint[]): LngLat[] => g.map((p) => [p.lon, p.lat]);

function isClosed(g?: OsmGeomPoint[]): boolean {
  if (!g || g.length < 4) return false;
  const a = g[0];
  const b = g[g.length - 1];
  return a.lat === b.lat && a.lon === b.lon;
}

function polygonsOf(el: OsmElement): Polygon[] {
  if (el.type === 'way') {
    return isClosed(el.geometry) ? [[openRing(toLL(el.geometry!))]] : [];
  }
  if (el.type === 'relation' && el.members) {
    const outer = joinRings(
      el.members.filter((m) => m.type === 'way' && m.role !== 'inner' && m.geometry).map((m) => toLL(m.geometry!)),
    );
    const inner = joinRings(
      el.members.filter((m) => m.type === 'way' && m.role === 'inner' && m.geometry).map((m) => toLL(m.geometry!)),
    );
    // Holes are attached to the first outer ring; good enough for typical park / lake relations.
    return outer.map((o, i) => (i === 0 ? [o, ...inner] : [o]));
  }
  return [];
}

function roadClassOf(hw: string): RoadClass | null {
  switch (hw) {
    case 'motorway':
    case 'trunk':
    case 'motorway_link':
    case 'trunk_link':
      return 'motorway';
    case 'primary':
    case 'primary_link':
      return 'primary';
    case 'secondary':
    case 'secondary_link':
      return 'secondary';
    case 'tertiary':
    case 'tertiary_link':
      return 'tertiary';
    case 'residential':
    case 'unclassified':
    case 'living_street':
    case 'road':
      return 'residential';
    case 'service':
      return 'service';
    case 'footway':
    case 'pedestrian':
    case 'path':
    case 'cycleway':
    case 'steps':
      return 'path';
    default:
      return null;
  }
}

const DEFAULT_LANES: Record<RoadClass, number> = {
  motorway: 4, primary: 4, secondary: 2, tertiary: 2, residential: 2, service: 1, path: 1,
};
const LANE_W: Record<RoadClass, number> = {
  motorway: 3.5, primary: 3.4, secondary: 3.3, tertiary: 3.2, residential: 2.8, service: 2.8, path: 2,
};

export function parseOverpass(bbox: BBox, data: OverpassResponse): CityData {
  const out: CityData = {
    bbox, buildings: [], roads: [], rails: [], areas: [], waterways: [], trees: [], pois: [],
    source: 'OpenStreetMap',
  };
  const poiSeen = new Set<string>();

  for (const el of data.elements) {
    const t = el.tags ?? {};
    const id = `${el.type}/${el.id}`;

    if (el.type === 'node') {
      if (el.lat == null || el.lon == null) continue;
      if (t['natural'] === 'tree') out.trees.push([el.lon, el.lat]);
      else if (t['name']) addPoi(out.pois, poiSeen, { id, pos: [el.lon, el.lat], name: t['name'], kind: t['amenity'] ?? '' });
      continue;
    }

    const isPart = !!t['building:part'] && t['building:part'] !== 'no';
    if ((t['building'] && t['building'] !== 'no') || isPart) {
      for (const polygon of polygonsOf(el)) out.buildings.push(buildingFromOsm(id, polygon, t, isPart));
      if (t['name'] && t['amenity'] && !isPart) {
        const p = polygonsOf(el)[0]?.[0];
        if (p) addPoi(out.pois, poiSeen, { id, pos: centroid(p), name: t['name'], kind: t['amenity'] });
      }
      continue;
    }

    if (t['highway'] && el.type === 'way' && el.geometry) {
      if (t['area'] === 'yes') continue;
      const cls = roadClassOf(t['highway']);
      if (!cls) continue;
      const lanes = Math.max(1, Math.round(parseNumber(t['lanes']) ?? DEFAULT_LANES[cls]));
      const width = parseNumber(t['width']) ?? lanes * LANE_W[cls] + (cls === 'path' ? 0 : 1);
      out.roads.push({
        id,
        line: toLL(el.geometry),
        cls,
        lanes,
        width: Math.min(Math.max(width, 1.5), 40),
        oneway: t['oneway'] === 'yes' || t['junction'] === 'roundabout' || cls === 'motorway',
        layer: parseNumber(t['layer']) ?? 0,
        bridge: !!t['bridge'] && t['bridge'] !== 'no',
        tunnel: !!t['tunnel'] && t['tunnel'] !== 'no',
        name: t['name'],
      });
      continue;
    }

    if (t['railway'] && el.type === 'way' && el.geometry) {
      out.rails.push({
        id,
        line: toLL(el.geometry),
        kind: t['railway'],
        layer: parseNumber(t['layer']) ?? 0,
        bridge: !!t['bridge'] && t['bridge'] !== 'no',
        tunnel: !!t['tunnel'] && t['tunnel'] !== 'no',
      });
      continue;
    }

    if (t['waterway'] && el.type === 'way' && el.geometry) {
      if (t['waterway'] === 'riverbank') {
        for (const polygon of polygonsOf(el)) out.areas.push({ id, polygon, kind: 'water' });
      } else if (!t['tunnel']) {
        const w = parseNumber(t['width']) ?? ({ river: 25, canal: 12, stream: 4, drain: 3 }[t['waterway']] ?? 4);
        out.waterways.push({ id, line: toLL(el.geometry), width: w } satisfies Waterway);
      }
      continue;
    }

    let kind: AreaFeature['kind'] | null = null;
    if (t['natural'] === 'water') kind = 'water';
    else if (t['leisure'] === 'park' || t['leisure'] === 'garden' || t['landuse'] === 'recreation_ground' || t['landuse'] === 'village_green') kind = 'park';
    else if (t['landuse'] === 'forest') kind = 'forest';
    else if (t['landuse'] === 'grass' || t['landuse'] === 'meadow' || t['landuse'] === 'cemetery' || t['leisure'] === 'pitch' || t['leisure'] === 'playground') kind = 'grass';
    else if (t['amenity'] === 'parking') kind = 'parking';
    if (kind) {
      for (const polygon of polygonsOf(el)) out.areas.push({ id, polygon, kind });
      if (t['name'] && t['amenity']) {
        const p = polygonsOf(el)[0]?.[0];
        if (p) addPoi(out.pois, poiSeen, { id, pos: centroid(p), name: t['name'], kind: t['amenity'] });
      }
    }
  }
  out.buildings = dropOutlinesWithParts(out.buildings);
  return out;
}

/**
 * Simple 3D Buildings: when a building outline contains building:part features, the parts
 * describe the volume and the outline itself must not be drawn.
 */
export function dropOutlinesWithParts<T extends { polygon: LngLat[][]; isPart?: boolean }>(list: T[]): T[] {
  const parts = list.filter((b) => b.isPart);
  if (!parts.length) return list;
  const centroids = parts.map((p) => centroid(p.polygon[0]));
  return list.filter((b) => {
    if (b.isPart) return true;
    const ring = b.polygon[0].map((p) => [p[0], p[1]] as [number, number]);
    return !centroids.some(([x, y]) => pointInRing(x, y, ring));
  });
}

function addPoi(list: PointOfInterest[], seen: Set<string>, p: PointOfInterest) {
  if (seen.has(p.name)) return;
  seen.add(p.name);
  list.push(p);
}

export function centroid(ring: LngLat[]): LngLat {
  let x = 0;
  let y = 0;
  for (const p of ring) {
    x += p[0];
    y += p[1];
  }
  return [x / ring.length, y / ring.length];
}
