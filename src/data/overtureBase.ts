import { VectorTile, type VectorTileFeature } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';
import { fetchTileBytes, overtureUrl, tileRange } from './overture';
import type { AreaFeature, BBox, LngLat, Polygon, Rail, Road, RoadClass, Waterway } from './types';

/**
 * Streets, rail, water, parks and trees from Overture's transportation and base themes.
 * Used when Overpass is unavailable (rate limited, offline, blocked) so a model still has
 * its street network; Overture's road data is itself derived from OpenStreetMap.
 */
export interface OvertureContext {
  roads: Road[];
  rails: Rail[];
  areas: AreaFeature[];
  waterways: Waterway[];
  trees: LngLat[];
}

const ROAD_CLASS: Record<string, RoadClass | null> = {
  motorway: 'motorway', trunk: 'motorway', primary: 'primary', secondary: 'secondary', tertiary: 'tertiary',
  residential: 'residential', living_street: 'residential', unclassified: 'residential', unknown: 'residential',
  service: 'service', footway: 'path', pedestrian: 'path', steps: 'path', path: 'path', cycleway: 'path',
  track: null, bridleway: null,
};
const DEFAULT_LANES: Record<RoadClass, number> = { motorway: 4, primary: 4, secondary: 2, tertiary: 2, residential: 2, service: 1, path: 1 };
const LANE_W: Record<RoadClass, number> = { motorway: 3.5, primary: 3.4, secondary: 3.3, tertiary: 3.2, residential: 2.8, service: 2.8, path: 2 };
const WATERWAY_W: Record<string, number> = { river: 25, canal: 10, drain: 4, ditch: 3, stream: 4 };

type Ranged = { values?: string[]; value?: number; between?: [number, number] };

function parseList(v: unknown): Ranged[] {
  if (typeof v !== 'string') return [];
  try {
    const r = JSON.parse(v);
    return Array.isArray(r) ? r : [];
  } catch {
    return [];
  }
}

/** Share (0..1) of the segment covered by a range rule. */
const coverage = (r: Ranged) => (r.between ? r.between[1] - r.between[0] : 1);

function lines(f: VectorTileFeature, x: number, y: number, z: number): LngLat[][] {
  const g = f.toGeoJSON(x, y, z).geometry;
  if (g.type === 'LineString') return [g.coordinates as LngLat[]];
  if (g.type === 'MultiLineString') return g.coordinates as LngLat[][];
  return [];
}

function polygons(f: VectorTileFeature, x: number, y: number, z: number): Polygon[] {
  const g = f.toGeoJSON(x, y, z).geometry;
  const ring = (r: number[][]) => r.slice(0, -1).map((p) => [p[0], p[1]] as LngLat);
  if (g.type === 'Polygon') return [g.coordinates.map(ring)];
  if (g.type === 'MultiPolygon') return g.coordinates.map((p) => p.map(ring));
  return [];
}

export function roadFromSegment(props: Record<string, unknown>, line: LngLat[], id: string): Road | null {
  const cls = ROAD_CLASS[String(props['class'] ?? 'unknown')];
  if (!cls) return null;
  const sub = String(props['subclass'] ?? '');
  if (sub === 'sidewalk' || sub === 'crosswalk') return null; // drawn as part of the carriageway
  const flags = parseList(props['road_flags']);
  const levels = parseList(props['level_rules']);
  const bridge = flags.some((r) => r.values?.includes('is_bridge') && coverage(r) > 0.4);
  const level = Math.max(0, ...levels.filter((r) => coverage(r) > 0.3).map((r) => r.value ?? 0));
  const tunnel = levels.some((r) => (r.value ?? 0) < 0 && coverage(r) > 0.5);
  const widthRule = parseList(props['width_rules']).find((r) => !r.between && typeof r.value === 'number');
  const lanes = DEFAULT_LANES[cls];
  const width = widthRule?.value ?? lanes * LANE_W[cls] + (cls === 'path' ? 0 : 1);
  const oneway = parseList(props['access_restrictions']).some(
    (r) => (r as { access_type?: string }).access_type === 'denied' && JSON.stringify(r).includes('"backward"'),
  );
  return {
    id,
    line,
    cls,
    lanes,
    width: Math.min(Math.max(width, 1.5), 40),
    oneway: oneway || cls === 'motorway',
    layer: level,
    bridge: bridge || level > 0,
    tunnel,
    name: typeof props['@name'] === 'string' ? (props['@name'] as string) : undefined,
  };
}

const inBox = (b: BBox, p: LngLat, pad = 0.002) =>
  p[0] >= b.west - pad && p[0] <= b.east + pad && p[1] >= b.south - pad && p[1] <= b.north + pad;

export async function loadOvertureContext(bbox: BBox, signal?: AbortSignal): Promise<OvertureContext> {
  const out: OvertureContext = { roads: [], rails: [], areas: [], waterways: [], trees: [] };

  // Transportation (z14).
  const t = tileRange(bbox, 14);
  for (let x = t.x0; x <= t.x1; x++)
    for (let y = t.y0; y <= t.y1; y++) {
      const bytes = await fetchTileBytes(overtureUrl('transportation'), 14, x, y, signal);
      if (!bytes.byteLength) continue;
      const L = new VectorTile(new PbfReader(new Uint8Array(bytes))).layers['segment'];
      for (let i = 0; i < (L?.length ?? 0); i++) {
        const f = L.feature(i);
        const p = f.properties as Record<string, unknown>;
        lines(f, x, y, 14).forEach((line, k) => {
          if (line.length < 2 || !line.some((q) => inBox(bbox, q))) return;
          // Segments crossing tile borders arrive clipped once per tile; each piece is kept.
          const id = `overture/${p['id']}/${k}/${x}/${y}`;
          if (p['subtype'] === 'rail') {
            const flags = parseList(p['rail_flags']);
            const levels = parseList(p['level_rules']);
            const level = Math.max(0, ...levels.map((r) => r.value ?? 0));
            out.rails.push({
              id,
              line,
              kind: String(p['class'] ?? 'rail'),
              layer: level,
              bridge: flags.some((r) => r.values?.includes('is_bridge')) || level > 0,
              tunnel: levels.some((r) => (r.value ?? 0) < 0),
            });
          } else if (p['subtype'] === 'road') {
            const road = roadFromSegment(p, line, id);
            if (road && !road.tunnel) out.roads.push(road);
          }
        });
      }
    }

  // Base (z13): water, parks, trees.
  const b = tileRange(bbox, 13);
  for (let x = b.x0; x <= b.x1; x++)
    for (let y = b.y0; y <= b.y1; y++) {
      const bytes = await fetchTileBytes(overtureUrl('base'), 13, x, y, signal);
      if (!bytes.byteLength) continue;
      const vt = new VectorTile(new PbfReader(new Uint8Array(bytes)));
      const each = (layer: string, fn: (f: VectorTileFeature, p: Record<string, unknown>) => void) => {
        const L = vt.layers[layer];
        for (let i = 0; i < (L?.length ?? 0); i++) fn(L.feature(i), L.feature(i).properties as Record<string, unknown>);
      };
      each('water', (f, p) => {
        const sub = String(p['subtype'] ?? ''), cls = String(p['class'] ?? '');
        if (f.type === 2) {
          for (const line of lines(f, x, y, 13))
            if (line.some((q) => inBox(bbox, q))) out.waterways.push({ id: `overture/w/${p['id']}`, line, width: WATERWAY_W[cls] ?? WATERWAY_W[sub] ?? 4 });
        } else if (f.type === 3) {
          for (const polygon of polygons(f, x, y, 13))
            if (polygon[0].some((q) => inBox(bbox, q, 0.005))) out.areas.push({ id: `overture/w/${p['id']}`, polygon, kind: 'water' });
        }
      });
      each('land_use', (f, p) => {
        if (f.type !== 3) return;
        const sub = String(p['subtype'] ?? ''), cls = String(p['class'] ?? '');
        const kind: AreaFeature['kind'] | null =
          sub === 'park' || cls === 'recreation_ground' || cls === 'garden' ? 'park'
          : cls === 'grass' || cls === 'pitch' || cls === 'playground' || sub === 'cemetery' ? 'grass'
          : cls === 'parking' ? 'parking'
          : null;
        if (!kind) return;
        for (const polygon of polygons(f, x, y, 13))
          if (polygon[0].some((q) => inBox(bbox, q))) out.areas.push({ id: `overture/lu/${p['id']}`, polygon, kind });
      });
      each('land', (f, p) => {
        const sub = String(p['subtype'] ?? '');
        if (f.type === 1 && sub === 'tree') {
          const g = f.toGeoJSON(x, y, 13).geometry;
          if (g.type === 'Point' && inBox(bbox, g.coordinates as LngLat, 0)) out.trees.push(g.coordinates as LngLat);
        } else if (f.type === 3 && (sub === 'forest' || sub === 'grass')) {
          for (const polygon of polygons(f, x, y, 13))
            if (polygon[0].some((q) => inBox(bbox, q))) out.areas.push({ id: `overture/l/${p['id']}`, polygon, kind: sub === 'forest' ? 'forest' : 'grass' });
        }
      });
    }
  return out;
}
