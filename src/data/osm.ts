import { hashString, pick, rng } from './rand';
import { joinRings, openRing } from './rings';
import type {
  AreaFeature,
  BBox,
  Building,
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
out geom;`;
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

export async function fetchOverpass(
  bbox: BBox,
  signal?: AbortSignal,
  onAttempt?: (endpoint: string) => void,
): Promise<OverpassResponse> {
  const body = 'data=' + encodeURIComponent(buildOverpassQuery(bbox));
  let lastErr: unknown;
  for (const ep of OVERPASS_ENDPOINTS) {
    onAttempt?.(ep);
    try {
      const res = await fetch(ep, {
        method: 'POST',
        body,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        signal,
      });
      if (!res.ok) throw new Error(`${ep}: HTTP ${res.status}`);
      return (await res.json()) as OverpassResponse;
    } catch (e) {
      if (signal?.aborted) throw e;
      lastErr = e;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('Overpass request failed');
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

export function parseNumber(v: string | undefined): number | undefined {
  if (!v) return undefined;
  const m = /-?\d+(?:[.,]\d+)?/.exec(v);
  if (!m) return undefined;
  const n = parseFloat(m[0].replace(',', '.'));
  if (!isFinite(n)) return undefined;
  // Feet → meters.
  if (/ft|'/.test(v)) return n * 0.3048;
  return n;
}

const LEVEL_H = 3.3;

/** Pastel facade palette reminiscent of Hanoi tube houses. */
export const FACADE_COLORS = [
  '#f4b6c2', '#c9b6f0', '#f7e08a', '#b9e4c9', '#f5ecd7', '#a9d4f5', '#f7c59f',
  '#e8e8e8', '#fde2a7', '#d7c4f2', '#f2a7a7', '#c5e3a5', '#fff4d6', '#b6d0e2',
];
export const ROOF_COLORS = ['#d9533b', '#e0663f', '#c44536', '#4f9a6a', '#e07a3f', '#b8453a'];
const FLAT_ROOF_COLORS = ['#d8d2c4', '#cfc8b8', '#bdb7ab', '#e4dccb', '#c9c2b5'];

function estimateHeight(id: string, kind: string, tags: Record<string, string>): number {
  const h = parseNumber(tags['height']) ?? parseNumber(tags['building:height']);
  if (h && h > 1) return h;
  const levels = parseNumber(tags['building:levels']);
  if (levels && levels > 0) return levels * LEVEL_H;
  const r = rng(hashString(id));
  switch (kind) {
    case 'house':
    case 'detached':
    case 'terrace':
    case 'semidetached_house':
      return LEVEL_H * (2 + Math.floor(r() * 4));
    case 'apartments':
    case 'residential':
      return LEVEL_H * (4 + Math.floor(r() * 10));
    case 'commercial':
    case 'office':
    case 'retail':
    case 'hotel':
      return LEVEL_H * (3 + Math.floor(r() * 12));
    case 'school':
    case 'university':
    case 'hospital':
    case 'public':
    case 'government':
      return LEVEL_H * (3 + Math.floor(r() * 4));
    case 'industrial':
    case 'warehouse':
    case 'garage':
    case 'garages':
    case 'shed':
    case 'roof':
      return 4 + r() * 4;
    case 'temple':
    case 'church':
    case 'pagoda':
      return 6 + r() * 6;
    default:
      // Dense mid-rise fabric: mostly 2–6 storeys.
      return LEVEL_H * (2 + Math.floor(r() * r() * 7));
  }
}

function normalizeColor(c?: string): string | undefined {
  if (!c) return undefined;
  const s = c.trim().toLowerCase();
  if (/^#[0-9a-f]{3}([0-9a-f]{3})?$/.test(s)) return s;
  const named: Record<string, string> = {
    white: '#f4f4f0', red: '#c44536', yellow: '#f7e08a', blue: '#7fb3e6', green: '#8fcf9a',
    grey: '#b9b9b9', gray: '#b9b9b9', brown: '#9b6b4a', orange: '#f2a65a', pink: '#f4b6c2',
    beige: '#efe3c8', black: '#444444', silver: '#c8ccd0', cream: '#fbf3dc',
  };
  return named[s];
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

    if (t['building'] && t['building'] !== 'no') {
      const kind = t['building'];
      const height = estimateHeight(id, kind, t);
      const minLevel = parseNumber(t['building:min_level']);
      const minHeight = parseNumber(t['min_height']) ?? (minLevel ? minLevel * LEVEL_H : 0);
      const r = rng(hashString(id) ^ 0x9e3779b9);
      const shape = t['roof:shape'];
      for (const polygon of polygonsOf(el)) {
        const small = height <= LEVEL_H * 3.2;
        let roof: Building['roof'] = 'flat';
        if (shape === 'gabled' || shape === 'hipped') roof = shape;
        else if (!shape && small && polygon[0].length <= 5 && r() < 0.55) roof = r() < 0.5 ? 'gabled' : 'hipped';
        out.buildings.push({
          id,
          polygon,
          height: Math.max(height, minHeight + 2),
          minHeight,
          kind,
          roof,
          color: normalizeColor(t['building:colour']) ?? pick(r, FACADE_COLORS),
          roofColor: normalizeColor(t['roof:colour']) ?? (roof === 'flat' ? pick(r, FLAT_ROOF_COLORS) : pick(r, ROOF_COLORS)),
          name: t['name'],
        });
      }
      if (t['name'] && t['amenity']) {
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
  return out;
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
