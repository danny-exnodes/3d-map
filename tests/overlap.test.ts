import { describe, expect, it } from 'vitest';
import { removeOverlaps } from '../src/data/overlap';
import { makeBuilding } from '../src/data/buildings';
import type { CityData } from '../src/data/types';

const bbox = { south: 10.73, west: 106.66, north: 10.74, east: 106.67 };
// A w × l m rectangle with its south-west corner at (lon, lat).
const box = (lon: number, lat: number, w: number, l: number): [number, number][] => {
  const dx = w / 109000, dy = l / 110574;
  return [[lon, lat], [lon + dx, lat], [lon + dx, lat + dy], [lon, lat + dy]];
};
const city = (polys: [number, number][][], source: 'osm' | 'gob' = 'osm'): CityData => ({
  bbox,
  source: 'test',
  buildings: polys.map((p, i) => makeBuilding({ id: `b${i}`, polygon: [p], kind: 'house', levels: 2, tags: {}, footprintSource: source })),
} as unknown as CityData);

describe('removeOverlaps', () => {
  it('resolves a ~2% overlap with the default threshold', () => {
    // 40 × 40 m houses; the second starts 0.8 m inside the first (2% of its area).
    const dx = 39.2 / 109000;
    const data = city([box(106.665, 10.735, 40, 40), box(106.665 + dx, 10.735, 40, 40)]);
    const r = removeOverlaps(data);
    expect(r.dropped + r.shrunk).toBe(1);
  });

  it('keeps touching neighbours unchanged', () => {
    const dx = 10 / 109000;
    const polys = [box(106.665, 10.735, 10, 10), box(106.665 + dx, 10.735, 10, 10)];
    const data = city(polys);
    const before = JSON.stringify(data.buildings.map((b) => b.polygon));
    const r = removeOverlaps(data);
    expect(r).toEqual({ dropped: 0, shrunk: 0 });
    expect(data.buildings).toHaveLength(2);
    expect(JSON.stringify(data.buildings.map((b) => b.polygon))).toBe(before);
  });
});
