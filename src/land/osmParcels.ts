import { VectorTile } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';
import { clipPolygon, clipPolyline } from '../data/clip';
import { fetchOfmTile } from '../data/openfreemap';
import { tileRange } from '../data/overture';
import type { BBox, LngLat } from '../data/types';
import { osmClassToLand } from './landTypes';
import { makeParcel, ringAreaM2 } from './parcels';
import type { Parcel, Street } from './types';

/**
 * Reference "parcels" from OpenFreeMap land-use polygons (#37). These are OSM landuse /
 * landcover / park areas, not cadastral thửa đất: the land code is a guess (landCodeGuessed)
 * and the UI must label them as tham khảo. Streets come from the same tiles for frontage.
 */

export const OSM_PARCEL_ZOOM = 14;
/** Slivers from clipping and tiny OSM patches are noise at lot scale. */
export const MIN_PARCEL_AREA = 20;
/** Cap so the 2D layer and metrics stay cheap on dense city tiles; largest polygons win. */
export const MAX_PARCELS = 400;
/** Streets this far outside the bbox can still be a frontage for a parcel on the edge. */
const STREET_MARGIN_M = 50;

const POLYGON_LAYERS = ['landuse', 'landcover', 'park'] as const;
/** Transportation classes that are not streets a lot can face. */
const NON_STREET = new Set(['rail', 'transit', 'ferry', 'aerialway', 'busway', 'bridge', 'pier']);
/** Land-use classes that only occur inside built-up areas, used to pick ODT over ONT. */
const URBAN_CLASSES = new Set(['residential', 'commercial', 'retail']);

export interface TileBytes {
  x: number;
  y: number;
  z: number;
  bytes: ArrayBuffer | Uint8Array;
}

export interface OsmParcels {
  parcels: Parcel[];
  streets: Street[];
  urban: boolean;
}

/** Fetches the z14 OpenFreeMap tiles covering the bbox and turns them into reference parcels. */
export async function loadOsmParcels(bbox: BBox, signal?: AbortSignal): Promise<OsmParcels> {
  const { x0, x1, y0, y1 } = tileRange(bbox, OSM_PARCEL_ZOOM);
  const jobs: Promise<TileBytes>[] = [];
  for (let x = x0; x <= x1; x++)
    for (let y = y0; y <= y1; y++)
      jobs.push(fetchOfmTile(OSM_PARCEL_ZOOM, x, y, signal).then((bytes) => ({ x, y, z: OSM_PARCEL_ZOOM, bytes })));
  return parcelsFromTiles(await Promise.all(jobs), bbox);
}

interface Piece {
  id: string;
  ring: LngLat[];
  cls: string;
  subclass?: string;
  name?: string;
  area: number;
}

/**
 * Pure part of loadOsmParcels, testable with synthetic tiles. Each feature is clipped to its own
 * tile bounds (dropping the tile buffer, so pieces of one feature from adjacent tiles do not
 * overlap) and to the bbox. Pieces split across tiles are kept as separate parcels; merging them
 * would need polygon union, which is a dev-only dependency here.
 */
export function parcelsFromTiles(tiles: TileBytes[], bbox: BBox): OsmParcels {
  const pieces: Piece[] = [];
  const streets: Street[] = [];
  const named: Street[] = [];
  const m = marginDeg(bbox, STREET_MARGIN_M);
  const wide: BBox = { south: bbox.south - m.lat, north: bbox.north + m.lat, west: bbox.west - m.lon, east: bbox.east + m.lon };
  let urban = false;

  for (const t of tiles) {
    const bytes = t.bytes instanceof Uint8Array ? t.bytes : new Uint8Array(t.bytes);
    const vt = new VectorTile(new PbfReader(bytes));
    const tb = tileBounds(t.x, t.y, t.z);
    const clipBox = intersect(tb, bbox);
    const streetBox = intersect(tb, wide);

    for (const layer of POLYGON_LAYERS) {
      const L = vt.layers[layer];
      for (let i = 0; i < (L?.length ?? 0); i++) {
        const f = L.feature(i);
        if (f.type !== 3) continue;
        const p = f.properties;
        let cls = str(p['class']) ?? layer;
        let subclass = str(p['subclass']);
        // The park layer's class is the protection type (park, nature_reserve…); read it as a park.
        if (layer === 'park') {
          subclass = cls;
          cls = 'park';
        }
        if (layer === 'landuse' && URBAN_CLASSES.has(cls)) urban = true;
        if (!clipBox) continue;
        const g = f.toGeoJSON(t.x, t.y, t.z).geometry;
        const polys = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
        polys.forEach((poly, k) => {
          const rings = (poly as number[][][]).map((r) => openRing(r.map((c) => [c[0], c[1]] as LngLat)));
          const clipped = clipPolygon(rings, clipBox);
          if (!clipped) return;
          const ring = clipped[0];
          const area = ringAreaM2(ring);
          if (area < MIN_PARCEL_AREA) return;
          const name = str(p['name:vi']) ?? str(p['name']);
          pieces.push({ id: `osm/${layer}/${t.z}/${t.x}/${t.y}/${i}${k ? `-${k}` : ''}`, ring, cls, subclass, name, area });
        });
      }
    }

    if (!streetBox) continue;
    for (const [layer, out] of [['transportation_name', named], ['transportation', streets]] as const) {
      const L = vt.layers[layer];
      for (let i = 0; i < (L?.length ?? 0); i++) {
        const f = L.feature(i);
        if (f.type !== 2) continue;
        const p = f.properties;
        if (NON_STREET.has(String(p['class']))) continue;
        const name = str(p['name:vi']) ?? str(p['name']);
        const g = f.toGeoJSON(t.x, t.y, t.z).geometry;
        const lines = g.type === 'LineString' ? [g.coordinates] : g.type === 'MultiLineString' ? g.coordinates : [];
        for (const line of lines)
          for (const piece of clipPolyline((line as number[][]).map((c) => [c[0], c[1]] as LngLat), streetBox))
            out.push(name ? { name, line: piece } : { line: piece });
      }
    }
  }

  // Named lines first: on an exact tie the frontage search keeps the first hit, so the parcel
  // gets the street name from transportation_name rather than the unnamed duplicate.
  const allStreets = [...named, ...streets];
  const segments = toSegments(allStreets);
  pieces.sort((a, b) => b.area - a.area);
  const parcels = pieces.slice(0, MAX_PARCELS).map((pc) =>
    makeParcel(
      {
        id: pc.id,
        source: 'osm',
        ring: pc.ring,
        landCode: osmClassToLand(pc.cls, pc.subclass, urban),
        landCodeGuessed: true,
        osmClass: pc.subclass && pc.subclass !== pc.cls ? `${pc.cls}/${pc.subclass}` : pc.cls,
        name: pc.name,
      },
      nearbySegments(segments, pc.ring),
    ),
  );
  return { parcels, streets: allStreets, urban };
}

const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);

function openRing(r: LngLat[]): LngLat[] {
  const f = r[0], l = r[r.length - 1];
  return r.length > 1 && f[0] === l[0] && f[1] === l[1] ? r.slice(0, -1) : r;
}

/** Lon/lat bounds of an XYZ tile (no buffer). */
export function tileBounds(x: number, y: number, z: number): BBox {
  const n = 2 ** z;
  const lat = (yy: number) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * yy) / n))) * 180) / Math.PI;
  return { west: (x / n) * 360 - 180, east: ((x + 1) / n) * 360 - 180, north: lat(y), south: lat(y + 1) };
}

function intersect(a: BBox, b: BBox): BBox | null {
  const r = { west: Math.max(a.west, b.west), east: Math.min(a.east, b.east), south: Math.max(a.south, b.south), north: Math.min(a.north, b.north) };
  return r.west < r.east && r.south < r.north ? r : null;
}

function marginDeg(b: BBox, metres: number) {
  const lat0 = ((b.south + b.north) / 2) * (Math.PI / 180);
  return { lat: metres / 110_574, lon: metres / (111_320 * Math.cos(lat0)) };
}

interface Seg {
  street: Street;
  w: number;
  e: number;
  s: number;
  n: number;
}

/** Streets as single segments with their bounds, so each parcel only tests the ones nearby. */
function toSegments(streets: Street[]): Seg[] {
  const out: Seg[] = [];
  for (const st of streets)
    for (let i = 1; i < st.line.length; i++) {
      const a = st.line[i - 1], b = st.line[i];
      out.push({
        street: st.name ? { name: st.name, line: [a, b] } : { line: [a, b] },
        w: Math.min(a[0], b[0]),
        e: Math.max(a[0], b[0]),
        s: Math.min(a[1], b[1]),
        n: Math.max(a[1], b[1]),
      });
    }
  return out;
}

function nearbySegments(segs: Seg[], ring: LngLat[]): Street[] {
  let w = Infinity, e = -Infinity, s = Infinity, n = -Infinity;
  for (const [lon, lat] of ring) {
    w = Math.min(w, lon);
    e = Math.max(e, lon);
    s = Math.min(s, lat);
    n = Math.max(n, lat);
  }
  const m = marginDeg({ south: s, north: n, west: w, east: e }, 45);
  return segs.filter((g) => g.e >= w - m.lon && g.w <= e + m.lon && g.n >= s - m.lat && g.s <= n + m.lat).map((g) => g.street);
}
