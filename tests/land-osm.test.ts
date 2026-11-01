import { PbfWriter } from 'pbf';
import { describe, expect, it } from 'vitest';
import { MAX_PARCELS, parcelsFromTiles, tileBounds } from '../src/land/osmParcels';
import type { Parcel } from '../src/land/types';

// A minimal Mapbox Vector Tile encoder (spec v2) so the decoder path runs on known geometry.
type Geom = [number, number][][]; // rings or lines in tile pixels (extent 4096)
interface Feat { props: Record<string, string>; type: 2 | 3; geom: Geom }
interface Layer { name: string; features: Feat[] }

const zz = (n: number) => (n << 1) ^ (n >> 31);
function encodeGeom(type: 2 | 3, geom: Geom): number[] {
  const out: number[] = [];
  let cx = 0, cy = 0;
  for (const part of geom) {
    const [[x0, y0], ...rest] = part;
    out.push((1 & 7) | (1 << 3), zz(x0 - cx), zz(y0 - cy));
    cx = x0; cy = y0;
    out.push((2 & 7) | (rest.length << 3));
    for (const [x, y] of rest) {
      out.push(zz(x - cx), zz(y - cy));
      cx = x; cy = y;
    }
    if (type === 3) out.push((7 & 7) | (1 << 3));
  }
  return out;
}
function encodeTile(layers: Layer[]): Uint8Array {
  const pbf = new PbfWriter();
  for (const L of layers)
    pbf.writeMessage(3, (layer: Layer, p: PbfWriter) => {
      p.writeVarintField(15, 2);
      p.writeStringField(1, layer.name);
      const keys: string[] = [], values: string[] = [];
      const idx = (arr: string[], v: string) => (arr.includes(v) ? arr.indexOf(v) : arr.push(v) - 1);
      const feats = layer.features.map((f) => ({ ...f, tags: Object.entries(f.props).flatMap(([k, v]) => [idx(keys, k), idx(values, v)]) }));
      for (const f of feats)
        p.writeMessage(2, (ft: typeof f, q: PbfWriter) => {
          q.writePackedVarint(2, ft.tags);
          q.writeVarintField(3, ft.type);
          q.writePackedVarint(4, encodeGeom(ft.type, ft.geom));
        }, f);
      for (const k of keys) p.writeStringField(3, k);
      for (const v of values) p.writeMessage(4, (s: string, q: PbfWriter) => q.writeStringField(1, s), v);
      p.writeVarintField(5, 4096);
    }, L);
  return pbf.finish();
}

// z14 tile over District 1, TP.HCM; one pixel ≈ 0.59 m.
const z = 14, x = 13048, y = 7698;
const tb = tileBounds(x, y, z);
const sq = (x0: number, y0: number, s: number): [number, number][] => [[x0, y0], [x0 + s, y0], [x0 + s, y0 + s], [x0, y0 + s], [x0, y0]];

describe('OSM reference parcels (#37)', () => {
  const bytes = encodeTile([
    {
      name: 'landuse',
      features: [
        { props: { class: 'residential' }, type: 3, geom: [sq(1000, 1000, 100)] },
        // Crosses the right tile edge (and the buffer): must be clipped to the tile.
        { props: { class: 'commercial', name: 'Chợ' }, type: 3, geom: [sq(4000, 1500, 200)] },
        { props: { class: 'cemetery' }, type: 3, geom: [sq(2000, 2000, 1)] }, // ~5 m², dropped
      ],
    },
    { name: 'landcover', features: [{ props: { class: 'farmland', subclass: 'rice' }, type: 3, geom: [sq(1500, 1000, 50)] }] },
    { name: 'park', features: [{ props: { class: 'park' }, type: 3, geom: [sq(2500, 2500, 60)] }] },
    {
      name: 'transportation',
      features: [
        { props: { class: 'minor' }, type: 2, geom: [[[900, 1105], [1200, 1105]]] },
        { props: { class: 'rail' }, type: 2, geom: [[[900, 900], [1200, 900]]] },
      ],
    },
    { name: 'transportation_name', features: [{ props: { class: 'minor', name: 'Đường Đồng Khởi' }, type: 2, geom: [[[900, 1105], [1200, 1105]]] }] },
  ]);

  it('turns land-use polygons into guessed-code parcels with metrics and frontage', () => {
    const bbox = { ...tb };
    const out = parcelsFromTiles([{ x, y, z, bytes }], bbox);
    expect(out.urban).toBe(true);
    const byClass: Record<string, Parcel> = Object.fromEntries(out.parcels.map((p) => [p.osmClass, p]));
    expect(Object.keys(byClass).sort()).toEqual(['commercial', 'farmland/rice', 'park', 'residential']);
    expect(out.parcels.every((p) => p.source === 'osm' && p.landCodeGuessed)).toBe(true);
    expect(byClass.residential.landCode).toBe('ODT');
    expect(byClass['farmland/rice'].landCode).toBe('LUA');
    expect(byClass.park.landCode).toBe('DKV');
    expect(byClass.commercial.landCode).toBe('TMD');
    expect(byClass.commercial.name).toBe('Chợ');
    // Clipped at the tile's east edge: 96 px wide, not 200.
    expect(Math.max(...byClass.commercial.ring.map((p) => p[0]))).toBeLessThanOrEqual(tb.east + 1e-12);
    // Largest first.
    const areas = out.parcels.map((p) => p.metrics.area);
    expect(areas).toEqual([...areas].sort((a, b) => b - a));
    // Residential square ~100 px ≈ 59 m a side, its south edge 3 m from the named street.
    const r = byClass.residential.metrics;
    expect(r.area).toBeGreaterThan(3000);
    expect(r.area).toBeLessThan(4000);
    expect(r.frontage).not.toBeNull();
    expect(r.streetName).toBe('Đường Đồng Khởi');
    expect(r.streetDistance!).toBeLessThan(15);
    expect(out.streets.some((s) => s.name === 'Đường Đồng Khởi')).toBe(true);
    expect(out.streets).toHaveLength(2); // rail excluded
  });

  it('clips to the bbox and drops what lies outside', () => {
    const w = tb.east - tb.west, h = tb.north - tb.south;
    // West fifth of the tile (x < 819 px): no polygon reaches it.
    const bbox = { west: tb.west, east: tb.west + w * 0.2, north: tb.north, south: tb.south + h * 0.1 };
    const out = parcelsFromTiles([{ x, y, z, bytes }], bbox);
    expect(out.parcels).toHaveLength(0);
    expect(MAX_PARCELS).toBe(400);
  });

  it('uses ONT for residential land when no urban class is present', () => {
    const rural = encodeTile([{ name: 'landcover', features: [{ props: { class: 'farmland', subclass: 'farmland' }, type: 3, geom: [sq(100, 100, 100)] }] }]);
    const out = parcelsFromTiles([{ x, y, z, bytes: rural }], tb);
    expect(out.urban).toBe(false);
    expect(out.parcels[0].landCode).toBe('HNK');
  });
});
