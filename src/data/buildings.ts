import type { OvertureBuilding } from './overture';
import { hashString, pick, rng } from './rand';
import type { Archetype, Building, FacadeMaterial, LngLat, Polygon, RoofShape } from './types';

export const LEVEL_H = 3.3;

/** Pastel facade palette reminiscent of Hanoi tube houses. */
export const FACADE_COLORS = [
  '#f4b6c2', '#c9b6f0', '#f7e08a', '#b9e4c9', '#f5ecd7', '#a9d4f5', '#f7c59f',
  '#e8e8e8', '#fde2a7', '#d7c4f2', '#f2a7a7', '#c5e3a5', '#fff4d6', '#b6d0e2',
];
export const ROOF_COLORS = ['#d9533b', '#e0663f', '#c44536', '#4f9a6a', '#e07a3f', '#b8453a'];
export const FLAT_ROOF_COLORS = ['#d8d2c4', '#cfc8b8', '#bdb7ab', '#e4dccb', '#c9c2b5'];
/** Corrugated metal ("mái tôn") colours common on workshops and suburban houses. */
export const TON_COLORS = ['#3f7fbf', '#2f6aa3', '#c0473a', '#a83a32', '#4f8f6a', '#8a9099'];
const TOWER_COLORS = ['#7d9bbd', '#9fb6c9', '#e8d98a', '#c9d3dc', '#a9b8c6', '#d8d0c0'];

export function parseNumber(v: string | undefined): number | undefined {
  if (!v) return undefined;
  const m = /-?\d+(?:[.,]\d+)?/.exec(v);
  if (!m) return undefined;
  const n = parseFloat(m[0].replace(',', '.'));
  if (!isFinite(n)) return undefined;
  if (/ft|'/.test(v)) return n * 0.3048; // feet → metres
  return n;
}

export function normalizeColor(c?: string): string | undefined {
  if (!c) return undefined;
  const s = c.trim().toLowerCase();
  if (/^#[0-9a-f]{3}([0-9a-f]{3})?$/.test(s)) return s;
  const named: Record<string, string> = {
    white: '#f4f4f0', red: '#c44536', yellow: '#f7e08a', blue: '#7fb3e6', green: '#8fcf9a',
    grey: '#b9b9b9', gray: '#b9b9b9', brown: '#9b6b4a', orange: '#f2a65a', pink: '#f4b6c2',
    beige: '#efe3c8', black: '#444444', silver: '#c8ccd0', cream: '#fbf3dc', darkgray: '#7a7a7a',
    lightgray: '#d0d0d0', gold: '#e0b84a', maroon: '#7a2e2e', navy: '#2e3f6e', teal: '#3f8f8f',
  };
  return named[s];
}

/** Area (m²) and elongation (long/short side of the principal axes) of a lon/lat ring. */
export function footprintMetrics(ring: LngLat[]): { area: number; elongation: number } {
  const lat0 = ring.reduce((a, p) => a + p[1], 0) / ring.length;
  const lon0 = ring.reduce((a, p) => a + p[0], 0) / ring.length;
  const kx = 111_320 * Math.cos((lat0 * Math.PI) / 180);
  const pts = ring.map(([lon, lat]) => [(lon - lon0) * kx, (lat - lat0) * 110_574]);
  let area = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) area += pts[j][0] * pts[i][1] - pts[i][0] * pts[j][1];
  area = Math.abs(area / 2);
  // Principal axes from the vertex covariance; extents along them give the elongation.
  let sxx = 0, syy = 0, sxy = 0;
  for (const [x, y] of pts) { sxx += x * x; syy += y * y; sxy += x * y; }
  const theta = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  const c = Math.cos(theta), s = Math.sin(theta);
  let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
  for (const [x, y] of pts) {
    const u = x * c + y * s, v = -x * s + y * c;
    a0 = Math.min(a0, u); a1 = Math.max(a1, u); b0 = Math.min(b0, v); b1 = Math.max(b1, v);
  }
  const L = Math.max(a1 - a0, b1 - b0);
  const W = Math.max(0.1, Math.min(a1 - a0, b1 - b0));
  return { area, elongation: L / W };
}

/** Vietnamese building archetype from tags and footprint shape (drives heuristics and procedural detail, #5). */
export function archetypeOf(kind: string, tags: Record<string, string>, m: { area: number; elongation: number }, levels?: number): Archetype {
  const k = kind.toLowerCase();
  if (tags['amenity'] === 'place_of_worship' || ['temple', 'pagoda', 'shrine', 'church', 'cathedral', 'religious'].includes(k)) {
    return tags['religion'] === 'christian' || k === 'church' || k === 'cathedral' ? 'church' : 'temple';
  }
  if (['industrial', 'warehouse', 'factory', 'manufacture', 'hangar', 'shed', 'storage_tank'].includes(k)) return 'industrial';
  if (['office', 'commercial', 'hotel'].includes(k) && (levels ?? 0) >= 8) return 'office';
  // Large but low (≤ 3 storeys): markets, workshops, warehouses — typically metal roofs.
  if (k === 'yes' && m.area > 1200 && levels != null && levels <= 3.2) return 'industrial';
  if (['apartments', 'dormitory'].includes(k) || (levels ?? 0) >= 9 || m.area > 1500) return 'apartment';
  if (['detached', 'villa', 'bungalow'].includes(k) || (m.area > 120 && m.area < 400 && m.elongation < 1.6 && (levels ?? 3) <= 4)) return 'villa';
  if (m.area < 160 && m.elongation >= 1.8) return tags['shop'] || k === 'retail' ? 'shophouse' : 'tube';
  if (['retail', 'kiosk'].includes(k) || tags['shop']) return 'shophouse';
  if (['school', 'university', 'hospital', 'public', 'government', 'civic'].includes(k)) return 'civic';
  return m.area < 200 ? 'tube' : 'generic';
}

/** Storey count guess when no data source knows the height (seeded by id → stable). */
export function heuristicLevels(id: string, arch: Archetype, m: { area: number }): number {
  const r = rng(hashString(id));
  switch (arch) {
    case 'tube':
    case 'shophouse':
      return 3 + Math.floor(r() * 3); // 3–5: typical nhà ống
    case 'villa':
      return 2 + Math.floor(r() * 2);
    case 'apartment':
      return m.area > 3000 ? 15 + Math.floor(r() * 15) : 6 + Math.floor(r() * 12);
    case 'office':
      return 10 + Math.floor(r() * 15);
    case 'civic':
      return 3 + Math.floor(r() * 3);
    case 'industrial':
      return 1;
    case 'temple':
    case 'church':
      return 2;
    default:
      return m.area < 400 ? 2 + Math.floor(r() * 3) : 3 + Math.floor(r() * 5);
  }
}

export function roofShapeOf(tag?: string): RoofShape | undefined {
  switch (tag) {
    case 'flat':
      return 'flat';
    case 'gabled':
    case 'skillion':
    case 'saltbox':
      return 'gabled';
    case 'hipped':
    case 'half-hipped':
    case 'mansard':
    case 'gambrel':
      return 'hipped';
    case 'pyramidal':
    case 'cone':
      return 'pyramidal';
    case 'dome':
    case 'onion':
    case 'round':
      return 'dome';
    default:
      return undefined;
  }
}

export function facadeMaterialOf(tag?: string): FacadeMaterial | undefined {
  if (!tag) return undefined;
  if (/glass|mirror/.test(tag)) return 'glass';
  if (/brick/.test(tag)) return 'brick';
  if (/metal|steel|alumin/.test(tag)) return 'metal';
  if (/concrete|plaster|stone|cement/.test(tag)) return 'concrete';
  return undefined;
}

interface Input {
  id: string;
  polygon: Polygon;
  kind: string;
  tags: Record<string, string>;
  footprintSource: Building['footprintSource'];
  /** Known height (m) and its source, if any. */
  height?: number;
  heightSource?: Building['heightSource'];
  levels?: number;
  minHeight?: number;
  roofShapeTag?: string;
  roofHeight?: number;
  color?: string;
  roofColor?: string;
  material?: FacadeMaterial;
  isPart?: boolean;
}

/** Style choices that were set explicitly by tags, so restyling must keep them. */
interface Tagged {
  roof?: RoofShape;
  color?: string;
  roofColor?: string;
  material?: FacadeMaterial;
}

/** Default roof, colours and material for an archetype and height (deterministic per id). */
function styleFor(id: string, arch: Archetype, height: number, polygon: Polygon, t: Tagged) {
  const r = rng(hashString(id) ^ 0x9e3779b9);
  let roof = t.roof;
  if (!roof) {
    const quad = polygon.length === 1 && polygon[0].length <= 6;
    if (arch === 'temple') roof = 'pagoda';
    else if (arch === 'industrial') roof = quad ? 'gabled' : 'flat';
    else if (arch === 'villa' && quad) roof = r() < 0.6 ? 'hipped' : 'gabled';
    else if (height <= LEVEL_H * 3.2 && quad && r() < 0.5) roof = r() < 0.5 ? 'gabled' : 'hipped';
    else roof = 'flat';
  }
  const tall = height > 30;
  const color = t.color ?? (tall && arch !== 'apartment' ? pick(r, TOWER_COLORS) : pick(r, FACADE_COLORS));
  const roofColor =
    t.roofColor ??
    (arch === 'industrial' ? pick(r, TON_COLORS) : arch === 'temple' ? pick(r, ['#c4462f', '#b8562f', '#d9a441']) : roof === 'flat' ? pick(r, FLAT_ROOF_COLORS) : pick(r, ROOF_COLORS));
  const material = t.material ?? (tall && (arch === 'office' || r() < 0.3) ? 'glass' : undefined);
  return { roof, color, roofColor, material };
}

/** Normalises any footprint (OSM, Overture, part) into a Building with a height and a style. */
export function makeBuilding(i: Input): Building {
  const m = footprintMetrics(i.polygon[0]);
  const arch = archetypeOf(i.kind, i.tags, m, i.levels ?? (i.height ? i.height / LEVEL_H : undefined));
  let height = i.height;
  let heightSource = i.heightSource;
  if (!height && i.levels) {
    height = i.levels * LEVEL_H;
    heightSource ??= 'osm';
  }
  if (!height || height < 1.5) {
    height = heuristicLevels(i.id, arch, m) * LEVEL_H + (arch === 'industrial' ? 3 + (hashString(i.id) % 4) : 0);
    heightSource = 'heuristic';
  }
  const tagged: Tagged = { roof: roofShapeOf(i.roofShapeTag), color: i.color, roofColor: i.roofColor, material: i.material };
  const minHeight = i.minHeight ?? 0;
  return {
    id: i.id,
    polygon: i.polygon,
    height: Math.max(height, minHeight + 2),
    minHeight,
    kind: i.kind,
    roofHeight: i.roofHeight,
    ...styleFor(i.id, arch, height, i.polygon, tagged),
    archetype: arch,
    heightSource: heightSource ?? 'heuristic',
    footprintSource: i.footprintSource,
    levels: i.levels,
    name: i.tags['name'],
    address: [i.tags['addr:housenumber'], i.tags['addr:street'], i.tags['addr:district']].filter(Boolean).join(' ') || undefined,
    isPart: i.isPart,
    tagged,
    tags: i.tags,
  };
}

/** Re-derives archetype and default style after the height changed (e.g. from the Google 2.5D grid). */
export function restyle(b: Building) {
  const m = footprintMetrics(b.polygon[0]);
  const arch = archetypeOf(b.kind, b.tags ?? {}, m, b.levels ?? b.height / LEVEL_H);
  b.archetype = arch;
  Object.assign(b, styleFor(b.id, arch, b.height, b.polygon, b.tagged ?? {}));
}

/** Building from OSM tags (building=* or building:part=*). */
export function buildingFromOsm(id: string, polygon: Polygon, t: Record<string, string>, isPart = false): Building {
  const height = parseNumber(t['height']) ?? parseNumber(t['building:height']);
  const levels = parseNumber(t['building:levels']);
  const roofLevels = parseNumber(t['roof:levels']);
  const minLevel = parseNumber(t['building:min_level']);
  const minHeight = parseNumber(t['min_height']) ?? (minLevel ? minLevel * LEVEL_H : 0);
  return makeBuilding({
    id,
    polygon,
    kind: (isPart ? t['building'] ?? t['building:part'] : t['building']) || 'yes',
    tags: t,
    footprintSource: 'osm',
    height: height && height > 1 ? height : undefined,
    heightSource: height && height > 1 ? 'osm' : undefined,
    levels: levels && levels > 0 ? levels + (roofLevels ?? 0) * 0.5 : undefined,
    minHeight,
    roofShapeTag: t['roof:shape'],
    roofHeight: parseNumber(t['roof:height']),
    color: normalizeColor(t['building:colour']),
    roofColor: normalizeColor(t['roof:colour']),
    material: facadeMaterialOf(t['building:material']),
    isPart,
  });
}

export function buildingFromOverture(o: OvertureBuilding, isPart = false): Building {
  const known = o.height && o.height > 1;
  // Overture carries OSM buildings with their OSM height/levels: credit them to OSM (#17).
  const fromOsm = o.dataset === 'OpenStreetMap';
  return makeBuilding({
    id: `overture/${o.id}`,
    polygon: o.polygon,
    kind: o.cls ?? 'yes',
    tags: {},
    footprintSource: fromOsm ? 'osm' : 'overture',
    height: known ? o.height : undefined,
    heightSource: known || o.numFloors ? (fromOsm ? 'osm' : 'overture') : undefined,
    levels: o.numFloors && o.numFloors > 0 ? o.numFloors : undefined,
    minHeight: o.minHeight,
    roofShapeTag: o.roofShape,
    color: normalizeColor(o.facadeColor),
    roofColor: normalizeColor(o.roofColor),
    isPart,
  });
}
