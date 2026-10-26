import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { archetypeOf, buildingFromOsm, footprintMetrics, heuristicLevels } from '../src/data/buildings';
import { applyHeightGrid, computeStats, mergeOverture } from '../src/data/enrich';
import { HeightGrid, type HeightGridMeta } from '../src/data/heights';
import { dropOutlinesWithParts } from '../src/data/osm';
import { tileRange } from '../src/data/overture';
import type { CityData, LngLat } from '../src/data/types';
import { LocalProjection } from '../src/geo/projection';
import { toUtm } from '../src/geo/utm';

const bbox = { south: 21.0, west: 105.8, north: 21.002, east: 105.802 };
const proj = new LocalProjection(bbox);
/** Square footprint of `size` metres centred at local (x, z). */
const square = (x: number, z: number, size: number): LngLat[] => {
  const h = size / 2;
  return [[x - h, z - h], [x + h, z - h], [x + h, z + h], [x - h, z + h]].map(([a, b]) => proj.unproject(a, b));
};
const emptyCity = (): CityData => ({ bbox, buildings: [], roads: [], rails: [], areas: [], waterways: [], trees: [], pois: [], source: 'test' });

describe('UTM', () => {
  it('matches known coordinates (Hà Nội, zone 48N)', () => {
    const [e, n] = toUtm(105.8342, 21.0278);
    expect(e).toBeGreaterThan(586_600);
    expect(e).toBeLessThan(586_800);
    expect(n).toBeGreaterThan(2_325_400);
    expect(n).toBeLessThan(2_325_600);
  });
});

describe('HeightGrid', () => {
  // 2 m grid over the bbox: a 20 m tower block of 30 m in the middle, everything else empty.
  const { width: W, depth: D } = (() => {
    const kx = 111320 * Math.cos((21.001 * Math.PI) / 180);
    return { width: Math.ceil((0.002 * kx) / 2), depth: Math.ceil((0.002 * 110574) / 2) };
  })();
  const data = new Uint16Array(W * D);
  for (let j = 0; j < D; j++) for (let i = 0; i < W; i++) {
    const x = (i + 0.5) * 2 - W;
    const z = (j + 0.5) * 2 - D;
    if (Math.abs(x) < 10 && Math.abs(z) < 10) data[j * W + i] = 300;
  }
  const meta: HeightGridMeta = { bbox, cell: 2, width: W, depth: D, source: 'test' };
  const grid = new HeightGrid(meta, data);

  it('returns the median height inside a footprint', () => {
    expect(grid.sampleFootprint(square(0, 0, 16))).toBeCloseTo(30);
    expect(grid.sampleFootprint(square(60, 60, 16))).toBeNull();
  });

  it('only overrides non-OSM heights', () => {
    const osm = buildingFromOsm('way/1', [square(0, 0, 16)], { building: 'yes', height: '12' });
    const guess = buildingFromOsm('way/2', [square(0, 0, 16)], { building: 'yes' });
    expect(guess.heightSource).toBe('heuristic');
    applyHeightGrid([osm, guess], grid);
    expect(osm.height).toBe(12);
    expect(guess.height).toBeCloseTo(30);
    expect(guess.heightSource).toBe('gob');
  });
});

describe('bundled Ngã Tư Sở grid (regression, #3)', () => {
  it('has a plausible height distribution', () => {
    const meta = JSON.parse(readFileSync('public/heights/ngatuso.json', 'utf8'));
    const buf = readFileSync('public/heights/ngatuso.bin');
    const g = new Uint16Array(buf.buffer, buf.byteOffset, buf.byteLength / 2);
    expect(g.length).toBe(meta.width * meta.depth);
    const v = [...g].filter((x) => x > 0).sort((a, b) => a - b);
    expect(v.length / g.length).toBeGreaterThan(0.25);
    const median = v[Math.floor(v.length / 2)] / 10;
    expect(median).toBeGreaterThan(6);
    expect(median).toBeLessThan(20);
  });
});

describe('Overture merge', () => {
  it('adds only footprints that do not overlap OSM', () => {
    const city = emptyCity();
    city.buildings.push(buildingFromOsm('way/1', [square(0, 0, 10)], { building: 'yes' }));
    const ov = (id: string, ring: LngLat[]) => ({ id, polygon: [ring], dataset: 'Google Open Buildings' });
    const added = mergeOverture(city, { buildings: [ov('a', square(1, 1, 9)), ov('b', square(40, 40, 8)), ov('c', square(40.5, 40, 8))], parts: [] });
    expect(added).toBe(1);
    expect(city.buildings.map((b) => b.footprintSource)).toEqual(['osm', 'overture']);
    const st = computeStats(city);
    expect(st.footprints).toMatchObject({ osm: 1, overture: 1 });
    expect(st.attributions.join()).toContain('Overture');
  });
});

describe('archetypes & heuristics', () => {
  it('recognises tube houses and apartment blocks from the footprint', () => {
    const tube = [[0, 0], [4, 0], [4, 16], [0, 16]].map(([x, z]) => proj.unproject(x, z));
    const m = footprintMetrics(tube);
    expect(m.area).toBeCloseTo(64, 0);
    expect(m.elongation).toBeCloseTo(4, 0);
    expect(archetypeOf('yes', {}, m)).toBe('tube');
    expect(archetypeOf('yes', {}, { area: 2500, elongation: 1.5 })).toBe('apartment');
    expect(archetypeOf('yes', { amenity: 'place_of_worship', religion: 'buddhist' }, m)).toBe('temple');
    const lv = heuristicLevels('way/9', 'tube', m);
    expect(lv).toBeGreaterThanOrEqual(3);
    expect(lv).toBeLessThanOrEqual(5);
  });
});

describe('Simple 3D Buildings', () => {
  it('drops outlines that contain building parts', () => {
    const outline = buildingFromOsm('way/1', [square(0, 0, 30)], { building: 'yes' });
    const part = buildingFromOsm('way/2', [square(0, 0, 10)], { 'building:part': 'yes', height: '40' }, true);
    const other = buildingFromOsm('way/3', [square(80, 80, 10)], { building: 'yes' });
    expect(dropOutlinesWithParts([outline, part, other]).map((b) => b.id)).toEqual(['way/2', 'way/3']);
  });
});

describe('Overture tiles', () => {
  it('maps a point to the expected z14 tile and a 1 km box to at most 4 tiles', () => {
    const p = tileRange({ south: 21.0032, west: 105.8196, north: 21.0032, east: 105.8196 });
    expect(p).toEqual({ x0: 13007, x1: 13007, y0: 7213, y1: 7213 });
    const r = tileRange({ south: 21.0, west: 105.815, north: 21.009, east: 105.825 });
    expect((r.x1 - r.x0 + 1) * (r.y1 - r.y0 + 1)).toBeLessThanOrEqual(4);
  });
});

describe('restyle after a measured height', () => {
  it('turns a large low footprint into a workshop with a metal roof', async () => {
    const { restyle } = await import('../src/data/buildings');
    const big = buildingFromOsm('way/77', [square(0, 0, 45)], { building: 'yes' });
    expect(big.archetype).toBe('apartment'); // unknown height: large footprint ⇒ guessed as a block
    big.height = 7.5;
    big.heightSource = 'gob';
    restyle(big);
    expect(big.archetype).toBe('industrial');
    expect(['gabled', 'flat']).toContain(big.roof);
  });

  it('keeps tagged roof and colours', async () => {
    const { restyle } = await import('../src/data/buildings');
    const b = buildingFromOsm('way/78', [square(0, 0, 45)], { building: 'yes', 'roof:shape': 'dome', 'building:colour': 'white' });
    b.height = 7;
    restyle(b);
    expect(b.roof).toBe('dome');
    expect(b.color).toBe('#f4f4f0');
  });
});
