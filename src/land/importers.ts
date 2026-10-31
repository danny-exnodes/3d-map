import type { LngLat } from '../data/types';
import { landType } from './landTypes';
import { vn2000ToWgs84 } from './vn2000';

/**
 * Parsers for parcel outlines the user brings in (#37): the corner table of a sổ đỏ, and
 * GeoJSON / KML exported from a trích lục bản đồ địa chính. Pure string → data, no DOM, so they
 * run in Node tests (Node has no DOMParser, hence the regex KML reader).
 */

export interface Vn2000Corner {
  /** Point label as written in the table (e.g. "1", "A", "M3"), if any. */
  label?: string;
  x: number; // northing, m
  y: number; // easting, m
}

export interface Vn2000Table {
  ring: LngLat[];
  corners: Vn2000Corner[];
}

/** One polygon found in an imported file, with the cadastral attributes we recognise. */
export interface ImportedShape {
  ring: LngLat[];
  properties: Record<string, unknown>;
  soTo?: string;
  soThua?: string;
  /** A known TT 08/2024 code (legacy aliases resolved), e.g. 'ODT'. */
  landCode?: string;
  name?: string;
}

// VN-2000 TM-3° ranges over Việt Nam: northing ≈ 0.95–2.6 Mm, easting ≈ 0.15–0.85 Mm. Wider
// bounds keep the test loose while still telling X from Y and from STT / edge-length columns.
const isNorthing = (v: number) => v >= 800_000 && v <= 2_700_000;
const isEasting = (v: number) => v >= 100_000 && v <= 900_000;

/**
 * Parses a pasted corner table: rows like "1 1192345.12 602345.67", tab / comma / semicolon
 * separated, with Vietnamese decimal commas ("1192345,12") when unambiguous. Header and note
 * rows are skipped because they hold no plausible (X, Y) pair. A closing row that repeats the
 * first corner is dropped. Throws a Vietnamese message when fewer than 3 corners are found.
 */
export function parseVn2000Table(text: string, centralMeridian: number): Vn2000Table {
  const corners: Vn2000Corner[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const parts = line.split(/[\t;|]+|\s+/).filter(Boolean);
    let label: string | undefined;
    const nums: number[] = [];
    for (const p of parts) {
      const vals = parseNumberToken(p);
      if (vals) nums.push(...vals);
      else if (!nums.length && label === undefined) label = p;
    }
    const xy = pickXY(nums);
    if (!xy) continue;
    if (label === undefined && nums.length >= 3 && nums[0] !== xy[0]) label = String(nums[0]);
    corners.push({ label, x: xy[0], y: xy[1] });
  }
  while (corners.length > 1) {
    const f = corners[0], l = corners[corners.length - 1];
    if (Math.abs(f.x - l.x) < 1e-3 && Math.abs(f.y - l.y) < 1e-3) corners.pop();
    else break;
  }
  if (corners.length < 3) throw new Error('Cần ít nhất 3 điểm góc có tọa độ X, Y (VN-2000).');
  return { ring: corners.map((c) => vn2000ToWgs84(c.x, c.y, centralMeridian)), corners };
}

/** Finds the (northing, easting) pair in a row; tolerates a swapped Y X order. */
function pickXY(nums: number[]): [number, number] | null {
  for (let i = 0; i + 1 < nums.length; i++) if (isNorthing(nums[i]) && isEasting(nums[i + 1])) return [nums[i], nums[i + 1]];
  for (let i = 0; i + 1 < nums.length; i++) if (isEasting(nums[i]) && isNorthing(nums[i + 1])) return [nums[i + 1], nums[i]];
  return null;
}

/**
 * Reads one whitespace-free token as one or more numbers. Handles "1192345.12",
 * "1192345,12" (decimal comma), "1.192.345,12" / "1,192,345.12" (thousands separators) and
 * "1192345.12,602345.67" (comma-separated values). Returns null for non-numeric tokens.
 */
function parseNumberToken(tok: string): number[] | null {
  const t = tok.replace(/^,+|,+$/g, '');
  if (!t) return null;
  const num = (s: string) => (/^[-+]?\d+(\.\d+)?$/.test(s) ? Number(s) : NaN);
  if (/^[-+]?\d+(\.\d+)?$/.test(t)) return [Number(t)];
  if (/^\d{1,3}(\.\d{3})+,\d+$/.test(t)) return [Number(t.replace(/\./g, '').replace(',', '.'))];
  if (/^\d{1,3}(,\d{3})+\.\d+$/.test(t)) return [Number(t.replace(/,/g, ''))];
  // Exactly one comma, no dot, short fraction: a decimal comma ("602345,67").
  if (/^[-+]?\d+,\d{1,4}$/.test(t)) return [Number(t.replace(',', '.'))];
  if (t.includes(',')) {
    const vals = t.split(',').map(num);
    if (vals.every((v) => isFinite(v))) return vals;
  }
  return null;
}

// ---- GeoJSON ----

type Pos = number[];

/**
 * Reads Polygon / MultiPolygon geometry from a GeoJSON Feature, FeatureCollection or bare
 * geometry. Only outer rings are kept (holes in a thửa are rare and irrelevant for frontage).
 * When coordinates are projected (VN-2000 [easting, northing], as many trích lục exports are),
 * `centralMeridian` is required to convert them; otherwise a Vietnamese error is thrown.
 */
export function parseGeoJson(text: string, centralMeridian?: number): ImportedShape[] {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    throw new Error('Tệp GeoJSON không hợp lệ.');
  }
  const out: ImportedShape[] = [];
  const visit = (obj: unknown, props: Record<string, unknown>) => {
    if (!obj || typeof obj !== 'object') return;
    const o = obj as { type?: string; features?: unknown[]; geometry?: unknown; geometries?: unknown[]; properties?: unknown; coordinates?: unknown };
    switch (o.type) {
      case 'FeatureCollection':
        for (const f of o.features ?? []) visit(f, {});
        break;
      case 'Feature':
        visit(o.geometry, (o.properties as Record<string, unknown>) ?? {});
        break;
      case 'GeometryCollection':
        for (const g of o.geometries ?? []) visit(g, props);
        break;
      case 'Polygon':
        addShape(out, (o.coordinates as Pos[][])?.[0], props, centralMeridian);
        break;
      case 'MultiPolygon':
        for (const poly of (o.coordinates as Pos[][][]) ?? []) addShape(out, poly?.[0], props, centralMeridian);
        break;
    }
  };
  visit(doc, {});
  return out;
}

function addShape(out: ImportedShape[], coords: Pos[] | undefined, props: Record<string, unknown>, cm?: number) {
  if (!coords || coords.length < 3) return;
  const ring = toLngLat(coords, cm);
  if (ring.length < 3) return;
  out.push({ ring, properties: props, ...cadastralFields(props) });
}

/** [lon, lat] as given, or VN-2000 [easting, northing] converted when values are clearly metres. */
function toLngLat(coords: Pos[], cm?: number): LngLat[] {
  const valid = coords.filter((c) => Array.isArray(c) && isFinite(c[0]) && isFinite(c[1]));
  const projected = valid.some((c) => Math.abs(c[0]) > 360 || Math.abs(c[1]) > 360);
  let ring: LngLat[];
  if (projected) {
    if (cm === undefined) throw new Error('Tọa độ trong tệp là VN-2000 (mét): hãy chọn tỉnh để biết kinh tuyến trục.');
    ring = valid.map((c) => (isNorthing(c[0]) && isEasting(c[1]) ? vn2000ToWgs84(c[0], c[1], cm) : vn2000ToWgs84(c[1], c[0], cm)));
  } else ring = valid.map((c) => [c[0], c[1]] as LngLat);
  const f = ring[0], l = ring[ring.length - 1];
  if (ring.length > 1 && f[0] === l[0] && f[1] === l[1]) ring.pop();
  return ring;
}

// Attribute names seen in cadastral exports (VBDLIS / MicroStation-derived shapefiles, ad-hoc
// GeoJSON). Compared after lower-casing and dropping '_' / spaces, so so_to ≡ SoTo ≡ SOTO.
const SO_TO_KEYS = ['soto', 'sotobando', 'shbando', 'tobando', 'sotobd', 'mapsheet'];
const SO_THUA_KEYS = ['sothua', 'shthua', 'sothuadat', 'thua', 'parcelno'];
const LAND_KEYS = ['loaidat', 'kyhieumucdich', 'mucdichsudung', 'mdsd', 'kyhieu', 'khmd', 'mucdich', 'landuse', 'landcode'];
const NAME_KEYS = ['name', 'ten', 'tenthua'];

const normKey = (k: string) => k.toLowerCase().replace(/[\s_-]+/g, '');

function pick(props: Record<string, unknown>, keys: string[]): string | undefined {
  const norm = new Map(Object.entries(props).map(([k, v]) => [normKey(k), v]));
  for (const k of keys) {
    const v = norm.get(k);
    if (v !== undefined && v !== null && String(v).trim() !== '') return String(v).trim();
  }
  return undefined;
}

/** Pulls số tờ / số thửa / loại đất / name out of a property bag. */
export function cadastralFields(props: Record<string, unknown>): Pick<ImportedShape, 'soTo' | 'soThua' | 'landCode' | 'name'> {
  const out: Pick<ImportedShape, 'soTo' | 'soThua' | 'landCode' | 'name'> = {};
  const soTo = pick(props, SO_TO_KEYS);
  const soThua = pick(props, SO_THUA_KEYS);
  const land = pick(props, LAND_KEYS);
  const name = pick(props, NAME_KEYS);
  if (soTo) out.soTo = soTo;
  if (soThua) out.soThua = soThua;
  if (name) out.name = name;
  // A mixed-use thửa is written "ODT+CLN" or "ODT, CLN": the first known code is the main one.
  const code = land?.split(/[^A-Za-z]+/).map((c) => landType(c)?.code).find(Boolean);
  if (code) out.landCode = code;
  return out;
}

// ---- KML ----

/**
 * Reads the outer boundary of every <Polygon> in a KML document with regular expressions.
 * Placemark <name>, <Data name><value> and <SimpleData name> become properties, so a trích lục
 * exported from Google Earth or QGIS keeps its số tờ / số thửa.
 */
export function parseKml(text: string, centralMeridian?: number): ImportedShape[] {
  const out: ImportedShape[] = [];
  const placemarks = matchAll(text, 'Placemark');
  // Polygons outside any Placemark are rare, but read them too rather than drop the file.
  const blocks = placemarks.length ? placemarks : [text];
  for (const pm of blocks) {
    const props: Record<string, unknown> = {};
    const name = placemarks.length ? firstText(pm.replace(/<(\w+:)?Polygon[\s\S]*$/, ''), 'name') : undefined;
    if (name) props.name = name;
    for (const m of pm.matchAll(/<(?:\w+:)?Data\s+name="([^"]*)"[^>]*>[\s\S]*?<(?:\w+:)?value>([\s\S]*?)<\/(?:\w+:)?value>/g))
      props[m[1]] = decode(m[2].trim());
    for (const m of pm.matchAll(/<(?:\w+:)?SimpleData\s+name="([^"]*)"[^>]*>([\s\S]*?)<\/(?:\w+:)?SimpleData>/g)) props[m[1]] = decode(m[2].trim());
    for (const poly of matchAll(pm, 'Polygon')) {
      const outer = matchAll(poly, 'outerBoundaryIs')[0] ?? poly;
      const coordText = firstText(outer, 'coordinates');
      if (!coordText) continue;
      const coords = coordText
        .trim()
        .split(/\s+/)
        .map((t) => t.split(',').map(Number))
        .filter((c) => c.length >= 2 && isFinite(c[0]) && isFinite(c[1]));
      addShape(out, coords, props, centralMeridian);
    }
  }
  return out;
}

/** Inner XML of every <tag>…</tag> (any namespace prefix). Not nesting-aware, which KML never needs here. */
function matchAll(text: string, tag: string): string[] {
  const re = new RegExp(`<(?:\\w+:)?${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:\\w+:)?${tag}>`, 'g');
  return [...text.matchAll(re)].map((m) => m[1]);
}

function firstText(text: string, tag: string): string | undefined {
  const v = matchAll(text, tag)[0];
  return v === undefined ? undefined : decode(v.replace(/^\s*<!\[CDATA\[([\s\S]*)\]\]>\s*$/, '$1').trim());
}

function decode(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, '&');
}
